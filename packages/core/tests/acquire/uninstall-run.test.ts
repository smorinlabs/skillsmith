import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  runInstall,
  runUninstall,
  runUninstallWithRegistry,
  runUninstallWithRegistryObserved,
} from '../../src/acquire/run.ts';
import type { InstallDeps, InstallOptions, UninstallDeps } from '../../src/acquire/types.ts';
import { createToolRegistry, toolRegistry } from '../../src/agents/registry.ts';
import type { SkillSmithError } from '../../src/errors.ts';
import {
  type ObservationBundle,
  type ObserverEvent,
  createObservationEmitter,
  createOperationContext,
} from '../../src/observation/index.ts';
import {
  getLedgerPairAt as getPairAt,
  legacyLedgerView,
  readLedgerState,
  withLedgerPairAt,
  writeLedger,
} from '../../src/place/ledger.ts';
import { ledgerPathOf } from '../../src/place/paths.ts';
import { LEGACY_ROOT_NOTICE } from '../../src/place/plan.ts';
import { runDev } from '../../src/place/run.ts';
import type { FlipDeps, Journal } from '../../src/place/types.ts';
import type { RuntimePorts } from '../../src/ports/types.ts';
import { ok } from '../../src/result.ts';
import { VERIFIED_AGAINST, type VerifyReport } from '../../src/verify/types.ts';
import {
  type RemoteFixture,
  buildRemoteFixture,
  destroyRemoteFixture,
} from '../fixtures/acquire/remote.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../fixtures/place/fleet.ts';

setDefaultTimeout(60_000);

const NOW = '2026-07-08T00:00:00.000Z';
const msg = (e: SkillSmithError): string => ('message' in e ? e.message : e.code);

const observationFixture = (): Readonly<{
  observation: ObservationBundle;
  events: ObserverEvent[];
}> => {
  const events: ObserverEvent[] = [];
  let monotonicMilliseconds = 0;
  const context = createOperationContext({
    operationId: 'command:v1:record-only-stale-uninstall',
    command: 'skillsmith uninstall factor-scan --tool claude-code',
    workflow: 'uninstall',
    clock: {
      wallNowIso: () => NOW,
      monotonicMilliseconds: () => monotonicMilliseconds++,
    },
    id: { nextId: () => 'unused-operation-id' },
  });
  return Object.freeze({
    observation: Object.freeze({
      context,
      emitter: createObservationEmitter({
        observer: {
          observe: (event) => {
            events.push(event);
          },
        },
        toolIds: ['claude-code', 'codex'],
      }),
    }),
    events,
  });
};

const expectCorrelatedRecordOnlyTransaction = (
  events: readonly ObserverEvent[],
  transactionId: string,
): void => {
  const started = events.find((event) => event.kind === 'operation.started');
  if (started?.kind !== 'operation.started') {
    throw new Error('record-only stale uninstall operation did not start');
  }
  const transactionEvents = events.filter((event) => event.kind.startsWith('transaction.'));
  expect(transactionEvents).toMatchObject([
    { kind: 'transaction.stage.started', stage: 'committed' },
    {
      kind: 'transaction.stage.completed',
      stage: 'committed',
      outcome: 'success',
      errorCode: null,
    },
    { kind: 'transaction.committed' },
  ]);
  expect(transactionId).not.toBe(started.operationId);
  for (const event of transactionEvents) {
    expect(event).toMatchObject({
      operationId: transactionId,
      parentOperationId: started.operationId,
      groupId: started.groupId,
      pairId: started.pairId,
      attempt: 1,
    });
  }
};

const detectBoth: InstallDeps['detect'] = async (_env, tool) =>
  ok([{ path: `/usr/local/bin/${tool}`, version: '1.0.0', installMethod: 'unknown' as const }]);

const passVerify: InstallDeps['verify'] = async (_env, opts) => {
  const tools = opts.tools ?? [];
  const tool = tools[0] ?? 'claude-code';
  const report: VerifyReport = {
    schemaVersion: 1,
    target: { path: opts.path, kind: 'skill' },
    requested: {
      tools: [...tools],
      modes: opts.deep ? ['static', 'deep'] : ['static'],
      strict: opts.strict ?? false,
      explicitTools: true,
    },
    verifiedAgainst: VERIFIED_AGAINST,
    summary: {
      verdict: 'pass',
      verified: [tool],
      failed: [],
      skipped: [],
      counts: { error: 0, warning: 0, info: 0 },
    },
    tools: [
      {
        tool,
        available: true,
        toolVersion: '1.0.0',
        versionDrift: false,
        skipReason: null,
        verdict: 'pass',
        modes: [],
      },
    ],
  };
  return ok(report);
};

let installCounter = 0;
const installDeps = (): InstallDeps => {
  const start = installCounter++;
  let n = 0;
  return {
    verify: passVerify,
    detect: detectBoth,
    transport: fixture.transport,
    now: () => NOW,
    newTxId: () => (0x10000000 + start * 1000 + n++).toString(16).slice(-8),
  };
};

let uninstallCounter = 0;
const uninstallDeps = (): UninstallDeps => {
  const start = uninstallCounter++;
  let n = 0;
  return {
    now: () => NOW,
    newTxId: () => (0x40000000 + start * 1000 + n++).toString(16).slice(-8),
  };
};

let flipCounter = 0;
const flipDeps = (): FlipDeps => {
  const start = flipCounter++;
  let n = 0;
  return {
    now: () => NOW,
    newTxId: () => (0x50000000 + start * 1000 + n++).toString(16).slice(-8),
    verify: async () => {
      throw new Error('verify should not run under --no-verify');
    },
  };
};

let fixture: RemoteFixture;
beforeAll(async () => {
  fixture = await buildRemoteFixture();
});
afterAll(async () => {
  await destroyRemoteFixture(fixture);
});

let f: FixtureFleet;
let fsSource: string;
beforeEach(async () => {
  f = await buildFixtureFleet();
  fsSource = `${fixture.multiSource}//plugins/fh/skills/factor-scan`;
});
afterEach(async () => {
  await destroyFixtureFleet(f);
});

const claudeRoot = (): string => join(f.home, '.claude', 'skills');
const legacyRoot = (): string => join(f.home, '.codex', 'skills');
const projClaudeRoot = (): string => join(f.project, '.claude', 'skills');
const led = async () => {
  const r = await readLedgerState(f.env, ledgerPathOf(f.data));
  if (!r.ok) throw new Error(msg(r.error));
  if (r.value.state !== 'present') throw new Error('expected persisted ledger');
  return r.value.model;
};

const installUser = async (opts: Partial<InstallOptions> = {}, env: RuntimePorts = f.env) => {
  const r = await runInstall(
    env,
    {
      sources: [fsSource],
      tools: ['claude-code'],
      cwd: f.base,
      configuration: f.configuration,
      ...opts,
    },
    installDeps(),
  );
  if (!r.ok) throw new Error(msg(r.error));
  return r.value;
};
const portableManifest = (names: readonly string[]): string =>
  `${[
    'version = 1',
    '[defaults]',
    'scope = "project"',
    'tools = ["claude-code"]',
    ...names.flatMap((name) => [
      '[[skills]]',
      `name = "${name}"`,
      `source = "github.com/acme/skills//${name}"`,
    ]),
  ].join('\n')}\n`;

describe('runUninstall — managed store-symlink removal', () => {
  test('placement gone, pair deleted, store entry retained, before.placement is symlink', async () => {
    const ins = await installUser();
    const storePath = ins.results[0]?.store?.path as string;
    expect(await f.env.pathKind(storePath)).not.toBe('absent');

    const r = await runUninstall(
      f.env,
      {
        targets: ['factor-scan'],
        tools: ['claude-code'],
        cwd: f.base,
        configuration: f.configuration,
      },
      uninstallDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.summary.removed).toBe(1);
    const res = r.value.results[0];
    expect(res?.action).toBe('removed');
    expect(res?.before?.placement).toBe('symlink');
    expect(res?.storeRetained).toBe(storePath);
    expect(res?.backupKept).toBeNull();

    expect(await f.env.pathKind(join(claudeRoot(), 'factor-scan'))).toBe('absent');
    expect(await f.env.pathKind(storePath)).not.toBe('absent'); // store immortal
    const ledger = await led();
    expect(getPairAt(ledger, null, 'factor-scan', 'claude-code')).toBeNull();
  });
});

describe('runUninstall — managed --direct copy removal', () => {
  test('unedited copy: backup reclaimed on hash match, no warning', async () => {
    await installUser({ direct: true });
    const r = await runUninstall(
      f.env,
      {
        targets: ['factor-scan'],
        tools: ['claude-code'],
        cwd: f.base,
        configuration: f.configuration,
      },
      uninstallDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const res = r.value.results[0];
    expect(res?.action).toBe('removed');
    expect(res?.before?.placement).toBe('copy');
    expect(res?.backupKept).toBeNull();
    expect(await f.env.pathKind(join(claudeRoot(), 'factor-scan'))).toBe('absent');
  });

  test('edited copy: backup kept + warning, still removed', async () => {
    await installUser({ direct: true });
    await f.env.writeTextFile(
      join(claudeRoot(), 'factor-scan', 'SKILL.md'),
      '---\nname: factor-scan\n---\ntampered\n',
    );
    const r = await runUninstall(
      f.env,
      {
        targets: ['factor-scan'],
        tools: ['claude-code'],
        cwd: f.base,
        configuration: f.configuration,
      },
      uninstallDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const res = r.value.results[0];
    expect(res?.action).toBe('removed');
    expect(res?.backupKept).not.toBeNull();
    expect(res?.reason ?? '').toContain('hash mismatch');
    expect(await f.env.pathKind(join(claudeRoot(), 'factor-scan'))).toBe('absent');
    expect(await f.env.pathKind(res?.backupKept as string)).not.toBe('absent');
  });
});

describe('runUninstall — U2 ambiguity', () => {
  const installBoth = async () => {
    await installUser();
    const p = await runInstall(
      f.env,
      {
        sources: [fsSource],
        tools: ['claude-code'],
        cwd: f.project,
        configuration: f.configuration,
        force: true,
      },
      installDeps(),
    );
    if (!p.ok) throw new Error(msg(p.error));
  };

  test('found in user AND project scope, no --scope/--all-scopes → refused listing both', async () => {
    await installBoth();
    const r = await runUninstall(
      f.env,
      {
        targets: ['factor-scan'],
        tools: ['claude-code'],
        cwd: f.project,
        configuration: f.configuration,
      },
      uninstallDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results.length).toBe(1);
    const res = r.value.results[0];
    expect(res?.action).toBe('refused');
    expect(res?.error?.code).toBe('flip-refused');
    expect(res?.reason).toContain('user');
    expect(res?.reason).toContain('project');
    expect(res?.reason).toContain('--scope');
    expect(res?.reason).toContain('--all-scopes');
  });

  test('--scope user removes only the user one', async () => {
    await installBoth();
    const r = await runUninstall(
      f.env,
      {
        targets: ['factor-scan'],
        tools: ['claude-code'],
        scope: 'user',
        cwd: f.project,
        configuration: f.configuration,
      },
      uninstallDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results.length).toBe(1);
    expect(r.value.results[0]?.action).toBe('removed');
    expect(r.value.results[0]?.scope).toBe('user');
    expect(await f.env.pathKind(join(claudeRoot(), 'factor-scan'))).toBe('absent');
    expect(await f.env.pathKind(join(projClaudeRoot(), 'factor-scan'))).not.toBe('absent');
  });

  test('--all-scopes removes both', async () => {
    await installBoth();
    const r = await runUninstall(
      f.env,
      {
        targets: ['factor-scan'],
        tools: ['claude-code'],
        allScopes: true,
        cwd: f.project,
        configuration: f.configuration,
      },
      uninstallDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results.length).toBe(2);
    expect(r.value.results.every((x) => x.action === 'removed')).toBe(true);
    expect(await f.env.pathKind(join(claudeRoot(), 'factor-scan'))).toBe('absent');
    expect(await f.env.pathKind(join(projClaudeRoot(), 'factor-scan'))).toBe('absent');
  });
});

describe('runUninstall — U3 dev mode', () => {
  const flipToDev = async () => {
    await installUser();
    const d = await runDev(
      f.env,
      {
        targets: ['factor-scan'],
        tools: ['claude-code'],
        source: f.gammaSrc,
        noVerify: true,
        cwd: f.base,
        configuration: f.configuration,
      },
      flipDeps(),
    );
    if (!d.ok) throw new Error(msg(d.error));
    expect(d.value.summary.flipped).toBe(1);
  };

  test('refused without --force, with promote/dev-rollback/--force guidance', async () => {
    await flipToDev();
    const r = await runUninstall(
      f.env,
      {
        targets: ['factor-scan'],
        tools: ['claude-code'],
        cwd: f.base,
        configuration: f.configuration,
      },
      uninstallDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const res = r.value.results[0];
    expect(res?.action).toBe('refused');
    expect(res?.error?.code).toBe('flip-refused');
    expect(res?.reason).toContain('dev mode');
    expect(res?.reason).toContain('skillsmith promote');
    expect(res?.reason).toContain('dev --rollback');
    expect(res?.reason).toContain('--force');
    // untouched
    expect(await f.env.pathKind(join(claudeRoot(), 'factor-scan'))).not.toBe('absent');
  });

  test('--force removes the symlink; checkout untouched; target printed', async () => {
    await flipToDev();
    const r = await runUninstall(
      f.env,
      {
        targets: ['factor-scan'],
        tools: ['claude-code'],
        force: true,
        cwd: f.base,
        configuration: f.configuration,
      },
      uninstallDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const res = r.value.results[0];
    expect(res?.action).toBe('removed');
    expect(res?.before?.mode).toBe('dev');
    expect(res?.before?.symlinkTarget).toBe(f.gammaSrc);
    expect(await f.env.pathKind(join(claudeRoot(), 'factor-scan'))).toBe('absent');
    expect(await f.env.pathKind(join(f.gammaSrc, 'SKILL.md'))).toBe('file'); // checkout untouched
  });
});

describe('runUninstall — unmanaged', () => {
  test('hand-copied dir refused without --force', async () => {
    const r = await runUninstall(
      f.env,
      { targets: ['copied'], tools: ['claude-code'], cwd: f.base, configuration: f.configuration },
      uninstallDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const res = r.value.results[0];
    expect(res?.action).toBe('refused');
    expect(res?.error?.code).toBe('flip-refused');
    expect(res?.reason).toContain('no skillsmith record');
    expect(res?.reason).toContain('--force');
    expect(await f.env.pathKind(join(claudeRoot(), 'copied'))).not.toBe('absent');
  });

  test('--force removes it; backup KEPT (no store entry to match) + warning', async () => {
    const r = await runUninstall(
      f.env,
      {
        targets: ['copied'],
        tools: ['claude-code'],
        force: true,
        cwd: f.base,
        configuration: f.configuration,
      },
      uninstallDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const res = r.value.results[0];
    expect(res?.action).toBe('removed');
    expect(res?.backupKept).not.toBeNull();
    expect(res?.reason ?? '').toContain('hash mismatch');
    expect(res?.storeRetained).toBeNull();
    expect(await f.env.pathKind(join(claudeRoot(), 'copied'))).toBe('absent');
    expect(await f.env.pathKind(res?.backupKept as string)).not.toBe('absent');
  });
});

describe('runUninstall — absent / stale', () => {
  test('absent everywhere → noop, exit-0 class, notice', async () => {
    const r = await runUninstall(
      f.env,
      { targets: ['totally-unknown-skill'], cwd: f.base, configuration: f.configuration },
      uninstallDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.summary.noop).toBe(1);
    const res = r.value.results[0];
    expect(res?.action).toBe('noop');
    expect(res?.tool).toBeNull();
    expect(res?.scope).toBeNull();
    expect(res?.error).toBeUndefined();
    expect(res?.reason).toContain('not installed anywhere');
  });

  test('stale pair (ledger exists, placement gone) → removed, "placement was already gone"', async () => {
    await installUser();
    await f.env.removeTree(join(claudeRoot(), 'factor-scan'));

    const r = await runUninstall(
      f.env,
      {
        targets: ['factor-scan'],
        tools: ['claude-code'],
        cwd: f.base,
        configuration: f.configuration,
      },
      uninstallDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const res = r.value.results[0];
    expect(res?.action).toBe('removed');
    expect(res?.reason).toBe('placement was already gone');
    const ledger = await led();
    expect(getPairAt(ledger, null, 'factor-scan', 'claude-code')).toBeNull();
    expect(ledger.history.at(-1)).toMatchObject({
      intent: { kind: 'remove', skill: 'factor-scan', tool: 'claude-code' },
      phase: 'committed',
    });
    expect(Object.keys(ledger.transactions)).toEqual([]);
  });

  test('observed stale removal emits one correlated record-only transaction', async () => {
    await installUser();
    await f.env.removeTree(join(claudeRoot(), 'factor-scan'));
    const observed = observationFixture();

    const removed = await runUninstallWithRegistryObserved(
      f.env,
      {
        targets: ['factor-scan'],
        tools: ['claude-code'],
        cwd: f.base,
        configuration: f.configuration,
      },
      uninstallDeps(),
      toolRegistry,
      observed.observation,
    );
    if (!removed.ok) throw new Error(msg(removed.error));

    expect(removed.value.summary).toMatchObject({ removed: 1, failed: 0 });
    expect(removed.value.results).toMatchObject([
      {
        tool: 'claude-code',
        action: 'removed',
        reason: 'placement was already gone',
      },
    ]);
    const durable = await led();
    expect(getPairAt(durable, null, 'factor-scan', 'claude-code')).toBeNull();
    const committed = durable.history.at(-1);
    expect(committed).toMatchObject({
      intent: { kind: 'remove', skill: 'factor-scan', tool: 'claude-code' },
      phase: 'committed',
    });
    if (committed === undefined) throw new Error('record-only removal history is missing');
    expectCorrelatedRecordOnlyTransaction(observed.events, committed.transactionId);
  });
});

describe('runUninstall — legacy root', () => {
  test('unmanaged legacy dev symlink refused without --force', async () => {
    const r = await runUninstall(
      f.env,
      { targets: ['legacy-only'], tools: ['codex'], cwd: f.base, configuration: f.configuration },
      uninstallDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results[0]?.action).toBe('refused');
  });

  test('--force removes from the legacy root; legacy notice in reason', async () => {
    const r = await runUninstall(
      f.env,
      {
        targets: ['legacy-only'],
        tools: ['codex'],
        force: true,
        cwd: f.base,
        configuration: f.configuration,
      },
      uninstallDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const res = r.value.results[0];
    expect(res?.action).toBe('removed');
    expect(res?.reason).toBe(LEGACY_ROOT_NOTICE);
    expect(await f.env.pathKind(join(legacyRoot(), 'legacy-only'))).toBe('absent');
    // checkout (alphaSrc, the dev symlink's target) untouched
    expect(await f.env.pathKind(join(f.alphaSrc, 'SKILL.md'))).toBe('file');
  });
});

describe('runUninstall — artifact destination preflight', () => {
  test('normalizes and deduplicates names once while preserving raw target order', async () => {
    const configRoot = join(f.home, '.config');
    const userManifest = join(configRoot, 'skillsmith', 'skillsmith.toml');
    const projectManifest = join(f.project, 'skillsmith.toml');
    await f.env.makeDir(join(configRoot, 'skillsmith'));
    await f.env.writeTextFile(userManifest, portableManifest(['z-last', 'a-first']));
    await f.env.writeTextFile(projectManifest, portableManifest(['z-last', 'a-first']));
    const targets = ['z-last', join(claudeRoot(), 'a-first'), 'a-first', 'z-last'];
    const observed = { artifacts: 0, ledger: 0, sweep: 0, live: 0, writes: 0 };
    const env: RuntimePorts = {
      ...f.env,
      xdg: {
        config: configRoot,
        data: join(f.home, '.local', 'share'),
        cache: join(f.home, '.cache'),
      },
      pathKind: async (path) => {
        if (path === ledgerPathOf(f.data)) observed.ledger++;
        if (path === join(f.data, '.fetch') || path === join(f.data, 'store', '.staging')) {
          observed.sweep++;
        }
        if (path.startsWith(`${claudeRoot()}/`)) observed.live++;
        return f.env.pathKind(path);
      },
      readText: async (path) => {
        if (path === userManifest || path === projectManifest) observed.artifacts++;
        return f.env.readText(path);
      },
      writeTextFile: async (...args) => {
        observed.writes++;
        return f.env.writeTextFile(...args);
      },
      removeTree: async (...args) => {
        observed.writes++;
        return f.env.removeTree(...args);
      },
    };
    const result = await runUninstall(
      env,
      { targets, cwd: f.project, configuration: f.configuration },
      uninstallDeps(),
    );
    if (!result.ok) throw new Error(msg(result.error));
    expect(result.value.requested.targets).toEqual(targets);
    expect(result.value.results.map(({ skill }) => skill)).toEqual([
      'z-last',
      'a-first',
      'a-first',
      'z-last',
    ]);
    expect(result.value.results[0]?.reason).toContain("declaration 'z-last'");
    expect(result.value.results.every(({ error }) => error?.code === 'flip-refused')).toBeTrue();
    expect(result.value.plan.operations).toHaveLength(0);
    expect(observed).toEqual({ artifacts: 2, ledger: 0, sweep: 0, live: 0, writes: 0 });
  });

  test('invalid artifact state refuses before ledger, sweep, or live access', async () => {
    const file = join(f.project, 'invalid-skillsmith.toml');
    await f.env.writeTextFile(file, 'not valid toml = [');
    const observed = { artifacts: 0, ledger: 0, sweep: 0, live: 0, writes: 0 };
    const env: RuntimePorts = {
      ...f.env,
      pathKind: async (path) => {
        if (path === ledgerPathOf(f.data)) observed.ledger++;
        if (path === join(f.data, '.fetch') || path === join(f.data, 'store', '.staging')) {
          observed.sweep++;
        }
        if (path.startsWith(`${claudeRoot()}/`)) observed.live++;
        return f.env.pathKind(path);
      },
      readText: async (path) => {
        if (path === file) observed.artifacts++;
        return f.env.readText(path);
      },
      writeTextFile: async (...args) => {
        observed.writes++;
        return f.env.writeTextFile(...args);
      },
      removeTree: async (...args) => {
        observed.writes++;
        return f.env.removeTree(...args);
      },
    };
    const result = await runUninstall(
      env,
      { targets: ['ghost'], file, cwd: f.project, configuration: f.configuration },
      uninstallDeps(),
    );
    if (!result.ok) throw new Error(msg(result.error));
    expect(result.value.requested.targets).toEqual(['ghost']);
    expect(result.value.results[0]).toMatchObject({ skill: 'ghost', action: 'refused' });
    expect(result.value.results[0]?.error?.code).toBe('config-error');
    expect(result.value.plan.operations).toHaveLength(0);
    expect(observed).toEqual({ artifacts: 1, ledger: 0, sweep: 0, live: 0, writes: 0 });
  });

  test('empty derived target names refuse before artifact or ledger access in both save modes', async () => {
    const observed = { artifact: 0, ledger: 0, sweep: 0, live: 0 };
    const env: RuntimePorts = {
      ...f.env,
      pathKind: async (path) => {
        if (path === ledgerPathOf(f.data)) observed.ledger++;
        if (path === join(f.data, '.fetch') || path === join(f.data, 'store', '.staging')) {
          observed.sweep++;
        }
        if (path.startsWith(`${claudeRoot()}/`)) observed.live++;
        return f.env.pathKind(path);
      },
      readText: async (path) => {
        observed.artifact++;
        return f.env.readText(path);
      },
    };
    for (const noSave of [undefined, true] as const) {
      const result = await runUninstall(
        env,
        {
          targets: [''],
          cwd: f.project,
          configuration: f.configuration,
          ...(noSave === undefined ? {} : { noSave }),
        },
        uninstallDeps(),
      );
      if (!result.ok) throw new Error(msg(result.error));
      expect(result.value.requested.targets).toEqual(['']);
      expect(result.value.results[0]).toMatchObject({ action: 'refused' });
      expect(result.value.results[0]?.error?.code).toBe('flip-refused');
      expect(result.value.plan.operations).toHaveLength(0);
    }
    expect(observed).toEqual({ artifact: 0, ledger: 0, sweep: 0, live: 0 });
  });

  test('no-save performs no portable artifact I/O for the whole invocation', async () => {
    const configRoot = join(f.home, '.config');
    const userManifest = join(configRoot, 'skillsmith', 'skillsmith.toml');
    const artifactPaths = new Set([
      userManifest,
      join(configRoot, 'skillsmith', 'skillsmith.lock'),
      join(f.base, 'skillsmith.toml'),
      join(f.base, 'skillsmith.lock'),
      join(f.project, 'skillsmith.toml'),
      join(f.project, 'skillsmith.lock'),
    ]);
    const hermeticEnv: RuntimePorts = {
      ...f.env,
      xdg: {
        config: configRoot,
        data: join(f.home, '.local', 'share'),
        cache: join(f.home, '.cache'),
      },
    };
    await installUser({ noSave: true }, hermeticEnv);
    let artifactReads = 0;
    const env: RuntimePorts = {
      ...hermeticEnv,
      pathKind: async (path) => {
        if (artifactPaths.has(path)) artifactReads++;
        return hermeticEnv.pathKind(path);
      },
      readText: async (path) => {
        if (artifactPaths.has(path)) artifactReads++;
        return hermeticEnv.readText(path);
      },
      readBytes: async (path) => {
        if (artifactPaths.has(path)) artifactReads++;
        return hermeticEnv.readBytes(path);
      },
      readFileMetadata: async (path) => {
        if (artifactPaths.has(path)) artifactReads++;
        return hermeticEnv.readFileMetadata(path);
      },
      realpath: async (path) => {
        if (artifactPaths.has(path)) artifactReads++;
        return hermeticEnv.realpath(path);
      },
    };
    const result = await runUninstall(
      env,
      {
        targets: ['factor-scan'],
        tools: ['claude-code'],
        noSave: true,
        cwd: f.base,
        configuration: f.configuration,
      },
      uninstallDeps(),
    );
    if (!result.ok) throw new Error(msg(result.error));
    expect(result.value.results[0]?.action).toBe('removed');
    expect(artifactReads).toBe(0);
  });
});

describe('runUninstall — path target', () => {
  test('a placement path resolves tool + scope and removes', async () => {
    await installUser();
    const path = join(claudeRoot(), 'factor-scan');
    const r = await runUninstall(
      f.env,
      { targets: [path], cwd: f.base, configuration: f.configuration },
      uninstallDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const res = r.value.results[0];
    expect(res?.action).toBe('removed');
    expect(res?.tool).toBe('claude-code');
    expect(res?.scope).toBe('user');
    expect(await f.env.pathKind(path)).toBe('absent');
  });

  test('joins every adapter notice for an alternate-root path target', async () => {
    const registry = createToolRegistry(
      toolRegistry.adapters.map((adapter) => {
        if (adapter.descriptor.id !== 'codex' || adapter.placement === undefined) return adapter;
        const placement = adapter.placement;
        return {
          ...adapter,
          placement: {
            ...placement,
            resolveScoped: async (...args: Parameters<typeof placement.resolveScoped>) => {
              const resolution = await placement.resolveScoped(...args);
              return { ...resolution, notices: ['NOTICE-ONE', 'NOTICE-TWO'] };
            },
          },
        };
      }),
    );
    const path = join(legacyRoot(), 'legacy-only');
    const r = await runUninstallWithRegistry(
      f.env,
      {
        targets: [path],
        tools: ['codex'],
        force: true,
        dryRun: true,
        cwd: f.base,
        configuration: f.configuration,
      },
      uninstallDeps(),
      registry,
    );
    if (!r.ok) throw new Error(msg(r.error));

    expect(r.value.results[0]?.action).toBe('removed');
    expect(r.value.results[0]?.reason).toBe('NOTICE-ONE; NOTICE-TWO');
  });

  test('a path outside every known root → refused', async () => {
    const path = join(f.base, 'nowhere', 'ghost');
    const r = await runUninstall(
      f.env,
      { targets: [path], cwd: f.base, configuration: f.configuration },
      uninstallDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const res = r.value.results[0];
    expect(res?.action).toBe('refused');
    expect(res?.error?.code).toBe('flip-refused');
    expect(res?.reason).toContain('outside every known skills root');
  });
});

describe('runUninstall — relevant capability scope', () => {
  test('a custom placement fingerprints uninstall/custom rather than its ledger scope', async () => {
    const dest = join(f.base, 'custom-skills');
    await f.env.makeDir(dest);
    const created = await runDev(
      f.env,
      {
        targets: ['beta'],
        tools: ['claude-code'],
        source: f.betaSrc,
        dest,
        cwd: f.home,
        configuration: f.configuration,
        noVerify: true,
      },
      flipDeps(),
    );
    if (!created.ok) throw new Error(msg(created.error));
    expect(created.value.results[0]?.action).toBe('created');

    const withUninstallScopes = (scopes: readonly ('user' | 'project' | 'custom')[]) =>
      createToolRegistry(
        toolRegistry.adapters.map((adapter) =>
          adapter.descriptor.id === 'claude-code'
            ? {
                ...adapter,
                descriptor: {
                  ...adapter.descriptor,
                  operations: {
                    ...adapter.descriptor.operations,
                    uninstall: {
                      ...adapter.descriptor.operations.uninstall,
                      scopes,
                    },
                  },
                },
              }
            : adapter,
        ),
      );
    const prepare = async (registry: ReturnType<typeof createToolRegistry>) => {
      const result = await runUninstallWithRegistry(
        f.env,
        {
          targets: ['beta'],
          tools: ['claude-code'],
          cwd: f.home,
          configuration: f.configuration,
          dryRun: true,
        },
        uninstallDeps(),
        registry,
      );
      if (!result.ok) throw new Error(msg(result.error));
      expect(result.value.results[0]?.placementPath).toBe(join(dest, 'beta'));
      return result.value.plan.operations[0]?.preconditionIds ?? [];
    };

    const baseline = await prepare(toolRegistry);
    const withoutUser = await prepare(withUninstallScopes(['project', 'custom']));
    const withoutCustom = await prepare(withUninstallScopes(['user', 'project']));

    expect(withoutUser).toEqual(baseline);
    expect(withoutCustom).not.toEqual(baseline);
  });
});

describe('runUninstall — uncommitted journal (Global Constraint #6)', () => {
  test('a DIFFERENT interrupted op (promote) → refused, naming the JOURNAL op, not uninstall', async () => {
    await installUser();
    const ledger = await led();
    const pair = getPairAt(ledger, null, 'factor-scan', 'claude-code');
    if (!pair) throw new Error('expected a seeded pair');
    const journal: Journal = {
      op: 'promote',
      txId: 'deadbeef',
      phase: 'staged',
      startedAt: NOW,
      completedAt: null,
      before: { mode: 'dev', symlinkTarget: '/src/factor-scan', liveKind: 'symlink' },
      stagingPath: join(claudeRoot(), '.skillsmith-staging-factor-scan-deadbeef'),
      backupPath: join(claudeRoot(), '.skillsmith-backup-factor-scan-deadbeef'),
    };
    const next = withLedgerPairAt(ledger, null, 'factor-scan', 'claude-code', {
      ...pair,
      journal,
    });
    if (!next.ok) throw new Error(msg(next.error));
    const w = await writeLedger(f.env, ledgerPathOf(f.data), next.value);
    if (!w.ok) throw new Error(msg(w.error));

    const r = await runUninstall(
      f.env,
      {
        targets: ['factor-scan'],
        tools: ['claude-code'],
        cwd: f.base,
        configuration: f.configuration,
      },
      uninstallDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const res = r.value.results[0];
    expect(res?.action).toBe('refused');
    expect(res?.error?.code).toBe('flip-refused');
    const reason = res?.reason ?? '';
    expect(reason).toContain('promote --rollback');
    expect(reason).toContain('skillsmith promote factor-scan');
    expect(reason).not.toContain('uninstall --rollback');
  });

  test('same-op uninstall re-run RESUMES the interrupted uninstall (not refused)', async () => {
    await installUser();
    const live = join(claudeRoot(), 'factor-scan');
    expect(await f.env.pathKind(live)).toBe('symlink');

    const ledger = await led();
    const pair = getPairAt(ledger, null, 'factor-scan', 'claude-code');
    if (!pair?.pinned) throw new Error('expected a seeded pinned pair');
    const journal: Journal = {
      op: 'uninstall',
      txId: 'deadbeef',
      phase: 'prepared',
      startedAt: NOW,
      completedAt: null,
      before: {
        mode: 'pinned',
        storePath: pair.pinned.storePath,
        contentHash: pair.pinned.contentHash,
        liveKind: 'symlink',
      },
      stagingPath: join(claudeRoot(), '.skillsmith-staging-factor-scan-deadbeef'),
      backupPath: join(claudeRoot(), '.skillsmith-backup-factor-scan-deadbeef'),
    };
    const next = withLedgerPairAt(ledger, null, 'factor-scan', 'claude-code', {
      ...pair,
      journal,
    });
    if (!next.ok) throw new Error(msg(next.error));
    const w = await writeLedger(f.env, ledgerPathOf(f.data), next.value);
    if (!w.ok) throw new Error(msg(w.error));

    const r = await runUninstall(
      f.env,
      {
        targets: ['factor-scan'],
        tools: ['claude-code'],
        cwd: f.base,
        configuration: f.configuration,
      },
      uninstallDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const res = r.value.results[0];
    expect(res?.action).toBe('removed');
    expect(res?.error).toBeUndefined();
    expect(await f.env.pathKind(live)).toBe('absent');
    const after = await led();
    expect(getPairAt(after, null, 'factor-scan', 'claude-code')).toBeNull();
  });
});

describe('runUninstall — dry run', () => {
  test('prepares the exact immutable match plan before removal and reuses preview IDs', async () => {
    await installUser();
    const options = {
      targets: ['factor-scan'],
      tools: ['claude-code'] as const,
      cwd: f.base,
      configuration: f.configuration,
    };
    let previewPlan: Parameters<NonNullable<UninstallDeps['observePreparedPlan']>>[0] | undefined;
    const preview = await runUninstall(
      f.env,
      { ...options, dryRun: true },
      {
        ...uninstallDeps(),
        observePreparedPlan: (plan) => {
          previewPlan = plan;
        },
      },
    );
    if (!preview.ok) throw new Error(msg(preview.error));
    expect(previewPlan).toBe(preview.value.plan);
    expect(Object.isFrozen(previewPlan)).toBeTrue();
    expect(preview.value.executionResults).toEqual([]);
    for (const operation of preview.value.plan.operations) {
      expect(operation.preconditionIds).toHaveLength(5);
      expect(new Set(operation.preconditionIds).size).toBe(5);
      expect(
        operation.preconditionIds.every((id) => /^precondition:v1:[0-9a-f]{64}$/.test(id)),
      ).toBeTrue();
    }

    let executionPlan: typeof previewPlan;
    const invokedOperationIds = new Set<string>();
    const livePath = join(claudeRoot(), 'factor-scan');
    const observeLiveMutation = (path: string): void => {
      if (path !== livePath) return;
      expect(executionPlan, 'the plan must exist before the first live removal').toBeDefined();
      const operation = executionPlan?.operations.find(
        (candidate) =>
          candidate.before.kind === 'placement' &&
          candidate.before.resource.location.kind === 'machine-bound' &&
          candidate.before.resource.location.path === path,
      );
      expect(operation, `missing exact prepared match binding for ${path}`).toBeDefined();
      if (operation) invokedOperationIds.add(operation.operationId);
    };
    const executionEnv: RuntimePorts = {
      ...f.env,
      rename: async (from, to) => {
        observeLiveMutation(from);
        await f.env.rename(from, to);
      },
      removeTree: async (path) => {
        observeLiveMutation(path);
        await f.env.removeTree(path);
      },
    };
    const executed = await runUninstall(executionEnv, options, {
      ...uninstallDeps(),
      observePreparedPlan: (plan) => {
        executionPlan = plan;
      },
    });
    if (!executed.ok) throw new Error(msg(executed.error));
    expect(executionPlan).toBe(executed.value.plan);
    expect(executed.value.plan).toEqual(preview.value.plan);
    expect(executed.value.plan.operations.map(({ operationId }) => operationId)).toEqual(
      preview.value.plan.operations.map(({ operationId }) => operationId),
    );
    expect([...invokedOperationIds].sort()).toEqual(
      executed.value.plan.operations.map(({ operationId }) => operationId).sort(),
    );
    expect(executed.value.executionResults.map(({ operationId }) => operationId)).toEqual(
      executed.value.plan.operations.map(({ operationId }) => operationId),
    );
  });

  test('G3B-02: changed live facts after preview refuse without writes or replanning', async () => {
    await installUser();
    const livePath = join(claudeRoot(), 'factor-scan');
    const sentinelPath = join(livePath, 'FOREIGN.txt');
    const targetWrites: string[] = [];
    let prepared = false;
    let observedPlans = 0;
    const executionEnv: RuntimePorts = {
      ...f.env,
      writeTextFile: async (path, text) => {
        if (prepared) targetWrites.push(`write:${path}`);
        await f.env.writeTextFile(path, text);
      },
      makeSymlink: async (target, linkPath) => {
        if (prepared) targetWrites.push(`symlink:${linkPath}`);
        await f.env.makeSymlink(target, linkPath);
      },
      rename: async (from, to) => {
        if (prepared) targetWrites.push(`rename:${from}->${to}`);
        await f.env.rename(from, to);
      },
      copyTree: async (from, to) => {
        if (prepared) targetWrites.push(`copy:${from}->${to}`);
        await f.env.copyTree(from, to);
      },
      removeTree: async (path) => {
        if (prepared) targetWrites.push(`remove:${path}`);
        await f.env.removeTree(path);
      },
    };
    const r = await runUninstall(
      executionEnv,
      {
        targets: ['factor-scan'],
        tools: ['claude-code'],
        cwd: f.base,
        configuration: f.configuration,
      },
      {
        ...uninstallDeps(),
        observePreparedPlan: () => {
          observedPlans++;
          rmSync(livePath, { recursive: true, force: true });
          mkdirSync(livePath, { recursive: true });
          writeFileSync(sentinelPath, 'foreign placement\n');
          prepared = true;
        },
      },
    );
    if (!r.ok) throw new Error(msg(r.error));

    expect(observedPlans).toBe(1);
    expect(r.value.results).toHaveLength(1);
    expect(r.value.results[0]?.action).toBe('refused');
    expect(r.value.executionResults[0]?.outcome).toBe('failed');
    expect(targetWrites).toEqual([]);
    expect(await f.env.pathKind(livePath)).toBe('dir');
    expect(await f.env.readText(sentinelPath)).toBe('foreign placement\n');
    expect(getPairAt(await led(), null, 'factor-scan', 'claude-code')).not.toBeNull();
  });

  test('G3B-02: changed copied bytes after preview refuse without runner writes', async () => {
    await installUser({ direct: true });
    const livePath = join(claudeRoot(), 'factor-scan');
    const ledgerPath = ledgerPathOf(f.data);
    const ledgerBefore = await f.env.readText(ledgerPath);
    const targetWrites: string[] = [];
    let prepared = false;
    const executionEnv: RuntimePorts = {
      ...f.env,
      writeTextFile: async (path, text) => {
        if (prepared) targetWrites.push(`write:${path}`);
        await f.env.writeTextFile(path, text);
      },
      makeSymlink: async (target, linkPath) => {
        if (prepared) targetWrites.push(`symlink:${linkPath}`);
        await f.env.makeSymlink(target, linkPath);
      },
      rename: async (from, to) => {
        if (prepared) targetWrites.push(`rename:${from}->${to}`);
        await f.env.rename(from, to);
      },
      copyTree: async (from, to) => {
        if (prepared) targetWrites.push(`copy:${from}->${to}`);
        await f.env.copyTree(from, to);
      },
      removeTree: async (path) => {
        if (prepared && !path.includes('/.fetch/')) targetWrites.push(`remove:${path}`);
        await f.env.removeTree(path);
      },
    };
    const result = await runUninstall(
      executionEnv,
      {
        targets: ['factor-scan'],
        tools: ['claude-code'],
        cwd: f.base,
        configuration: f.configuration,
      },
      {
        ...uninstallDeps(),
        observePreparedPlan: () => {
          writeFileSync(join(livePath, 'SKILL.md'), '# changed live copy\n');
          prepared = true;
        },
      },
    );
    if (!result.ok) throw new Error(msg(result.error));

    expect(result.value.results[0]?.action).toBe('refused');
    expect(result.value.executionResults[0]?.outcome).toBe('failed');
    expect(targetWrites).toEqual([]);
    expect(await f.env.pathKind(livePath)).toBe('dir');
    expect(await f.env.readText(ledgerPath)).toBe(ledgerBefore);
  });

  test('writes nothing; ledger byte-identical afterward', async () => {
    await installUser();
    const before = await f.env.readText(ledgerPathOf(f.data));

    const r = await runUninstall(
      f.env,
      {
        targets: ['factor-scan'],
        tools: ['claude-code'],
        dryRun: true,
        cwd: f.base,
        configuration: f.configuration,
      },
      uninstallDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.dryRun).toBe(true);
    expect(r.value.results[0]?.action).toBe('removed');
    expect(r.value.plan).toMatchObject({
      domain: 'skillsmith.operation-plan',
      schemaVersion: 1,
      command: 'uninstall',
    });
    expect(Object.isFrozen(r.value.plan)).toBe(true);
    expect(r.value.plan.operations).toHaveLength(1);
    expect(r.value.executionResults).toEqual([]);

    const after = await f.env.readText(ledgerPathOf(f.data));
    expect(after).toBe(before);
    expect(await f.env.pathKind(join(claudeRoot(), 'factor-scan'))).toBe('symlink');
  });

  test('supported v1 dry-run visibly prefixes migrate-ledger before uninstall', async () => {
    await installUser();
    const ledgerPath = ledgerPathOf(f.data);
    const current = await readLedgerState(f.env, ledgerPath);
    if (!current.ok || current.value.state !== 'present') {
      throw new Error('expected installed canonical ledger');
    }
    const source = JSON.stringify(legacyLedgerView(current.value.model));
    await f.env.writeTextFile(ledgerPath, source);
    let preparedKinds: readonly string[] = [];

    const result = await runUninstall(
      f.env,
      {
        targets: ['factor-scan'],
        tools: ['claude-code'],
        dryRun: true,
        cwd: f.base,
        configuration: f.configuration,
      },
      {
        ...uninstallDeps(),
        observePreparedPlan: (plan) => {
          preparedKinds = plan.operations.map((operation) => operation.kind);
        },
      },
    );
    if (!result.ok) throw new Error(msg(result.error));

    expect(preparedKinds[0]).toBe('migrate-ledger');
    expect(result.value.plan.operations.map((operation) => operation.kind)).toEqual([
      'migrate-ledger',
      'remove',
    ]);
    expect(await f.env.readText(ledgerPath)).toBe(source);
  });

  test('supported v1 execution migrates before removal and commits exact histories', async () => {
    await installUser();
    const ledgerPath = ledgerPathOf(f.data);
    const current = await readLedgerState(f.env, ledgerPath);
    if (!current.ok || current.value.state !== 'present') {
      throw new Error('expected installed canonical ledger');
    }
    await f.env.writeTextFile(ledgerPath, JSON.stringify(legacyLedgerView(current.value.model)));

    const result = await runUninstall(
      f.env,
      {
        targets: ['factor-scan'],
        tools: ['claude-code'],
        cwd: f.base,
        configuration: f.configuration,
      },
      uninstallDeps(),
    );
    if (!result.ok) throw new Error(msg(result.error));
    expect(result.value.plan.operations.map((operation) => operation.kind)).toEqual([
      'migrate-ledger',
      'remove',
    ]);

    const state = await readLedgerState(f.env, ledgerPath);
    if (!state.ok || state.value.state !== 'present') {
      throw new Error('expected migrated uninstall ledger');
    }
    expect(state.value.sourceVersion).toBe(2);
    expect(state.value.model.history.map((journal) => journal.intent.kind)).toEqual([
      'migrate-ledger',
      'remove',
    ]);
    expect(Object.keys(state.value.model.transactions)).toEqual([]);
  });
});

describe('runUninstall — public error boundary', () => {
  test('redacts ledger-read and outer-lock failures in dry and locked paths', async () => {
    const canary = 'ghp_P17_SECRET_CANARY_123456789';
    const ledgerPath = ledgerPathOf(f.data);
    const ledgerFailure: RuntimePorts = {
      ...f.env,
      pathKind: async (path) => (path === ledgerPath ? 'file' : f.env.pathKind(path)),
      readBytes: async (path) => {
        if (path === ledgerPath) throw new Error(`password=${canary}`);
        return f.env.readBytes(path);
      },
    };
    const lockFailure: RuntimePorts = {
      ...f.env,
      withFileLock: async () => {
        throw new Error(`authorization=Bearer ${canary}`);
      },
    };
    const options = {
      targets: ['not-installed'],
      tools: ['claude-code'] as const,
      cwd: f.base,
      configuration: f.configuration,
    };

    const dryLedgerFailure = await runUninstall(
      ledgerFailure,
      { ...options, dryRun: true },
      uninstallDeps(),
    );
    const lockedLedgerFailure = await runUninstall(ledgerFailure, options, uninstallDeps());
    const outerLockFailure = await runUninstall(lockFailure, options, uninstallDeps());
    const cases = [dryLedgerFailure, lockedLedgerFailure, outerLockFailure];
    for (const result of cases) {
      expect(result.ok).toBeFalse();
      expect(JSON.stringify(result)).not.toContain(canary);
      expect(JSON.stringify(result)).toContain('[REDACTED]');
    }
    if (dryLedgerFailure.ok || lockedLedgerFailure.ok || outerLockFailure.ok) {
      throw new Error('expected failures');
    }
    expect(dryLedgerFailure.error.code).toBe('ledger-error');
    expect(lockedLedgerFailure.error.code).toBe('ledger-error');
    expect(outerLockFailure.error.code).toBe('flip-failed');
  });

  test('returns redacted Results for hostile proxy throwables without invoking traps', async () => {
    const canary = 'ghp_P17_PROXY_THROWABLE_123456789';
    let trapReads = 0;
    const hostile = new Proxy(
      { code: 'EIO', message: `password=${canary}` },
      {
        get: () => {
          trapReads++;
          throw new Error('get trap fired');
        },
        has: () => {
          trapReads++;
          throw new Error('has trap fired');
        },
        ownKeys: () => {
          trapReads++;
          throw new Error('ownKeys trap fired');
        },
      },
    );
    const ledgerPath = ledgerPathOf(f.data);
    const ledgerFailure: RuntimePorts = {
      ...f.env,
      pathKind: async (path) => (path === ledgerPath ? 'file' : f.env.pathKind(path)),
      readBytes: async (path) => {
        if (path === ledgerPath) throw hostile;
        return f.env.readBytes(path);
      },
    };
    const lockFailure: RuntimePorts = {
      ...f.env,
      withFileLock: async () => {
        throw hostile;
      },
    };
    const options = {
      targets: ['not-installed'],
      tools: ['claude-code'] as const,
      cwd: f.base,
      configuration: f.configuration,
    };

    const results = [
      await runUninstall(ledgerFailure, { ...options, dryRun: true }, uninstallDeps()),
      await runUninstall(lockFailure, options, uninstallDeps()),
    ];
    for (const result of results) {
      expect(result.ok).toBeFalse();
      expect(JSON.stringify(result)).not.toContain(canary);
      expect(JSON.stringify(result)).toContain('[PROXY]');
    }
    expect(trapReads).toBe(0);
  });

  test('redacts a non-ledger committed-journal sweep failure', async () => {
    const canary = 'ghp_P17_SECRET_CANARY_123456789';
    await installUser();
    const ledger = await led();
    const pair = getPairAt(ledger, null, 'factor-scan', 'claude-code');
    if (!pair?.pinned) throw new Error('expected seeded pinned pair');
    const backupPath = join(claudeRoot(), '.skillsmith-backup-factor-scan-deadbeef');
    const journal: Journal = {
      op: 'uninstall',
      txId: 'deadbeef',
      phase: 'committed',
      startedAt: NOW,
      completedAt: NOW,
      before: {
        mode: 'pinned',
        storePath: pair.pinned.storePath,
        contentHash: pair.pinned.contentHash,
        liveKind: 'symlink',
      },
      stagingPath: join(claudeRoot(), '.skillsmith-staging-factor-scan-deadbeef'),
      backupPath,
    };
    const next = withLedgerPairAt(ledger, null, 'factor-scan', 'claude-code', {
      ...pair,
      journal,
    });
    if (!next.ok) throw new Error(msg(next.error));
    const persisted = await writeLedger(f.env, ledgerPathOf(f.data), next.value);
    if (!persisted.ok) throw new Error(msg(persisted.error));
    const sweepFailure: RuntimePorts = {
      ...f.env,
      pathKind: async (path) => {
        if (path === backupPath) throw new Error(`password=${canary}`);
        return f.env.pathKind(path);
      },
    };

    const result = await runUninstall(
      sweepFailure,
      {
        targets: ['factor-scan'],
        tools: ['claude-code'],
        cwd: f.base,
        configuration: f.configuration,
      },
      uninstallDeps(),
    );
    expect(result.ok).toBeFalse();
    if (result.ok) throw new Error('expected sweep failure');
    expect(result.error.code).toBe('flip-failed');
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(JSON.stringify(result)).toContain('[REDACTED]');
  });
});
