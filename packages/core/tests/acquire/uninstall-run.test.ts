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
import { join } from 'node:path';
import { runInstall, runUninstall } from '../../src/acquire/run.ts';
import type { InstallDeps, InstallOptions, UninstallDeps } from '../../src/acquire/types.ts';
import type { SkillSmithError } from '../../src/errors.ts';
import { getPairAt, readLedger, writeLedger } from '../../src/place/ledger.ts';
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

const NOW = '2026-07-08T00:00:00Z';
const msg = (e: SkillSmithError): string => ('message' in e ? e.message : e.code);

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
  const r = await readLedger(f.env, ledgerPathOf(f.data));
  if (!r.ok) throw new Error(msg(r.error));
  return r.value;
};

const installUser = async (opts: Partial<InstallOptions> = {}) => {
  const r = await runInstall(
    f.env,
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
    pair.journal = journal;
    const w = await writeLedger(f.env, ledgerPathOf(f.data), ledger);
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
    pair.journal = journal;
    const w = await writeLedger(f.env, ledgerPathOf(f.data), ledger);
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
    pair.journal = {
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
    const persisted = await writeLedger(f.env, ledgerPathOf(f.data), ledger);
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
