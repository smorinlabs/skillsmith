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
import { writeFileSync } from 'node:fs';
import { appendFile, lstat, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  defaultInstallDeps,
  runInstall,
  runInstallWithRegistry,
  runInstallWithRegistryObserved,
} from '../../src/acquire/run.ts';
import { parseSource } from '../../src/acquire/source.ts';
import type { CandidateSkill, InstallDeps, InstallOptions } from '../../src/acquire/types.ts';
import { createToolRegistry, toolRegistry } from '../../src/agents/registry.ts';
import type { InstallRecord } from '../../src/agents/types.ts';
import type { ArtifactCoordinatorPorts } from '../../src/artifacts/coordinator-types.ts';
import { lockV1Codec } from '../../src/artifacts/lock-codec.ts';
import { manifestV1Codec } from '../../src/artifacts/manifest-codec.ts';
import { createTestNodeArtifactCoordinatorPorts } from '../../src/artifacts/node-coordinator.ts';
import { hashSourceContentV1, projectSourceContent } from '../../src/artifacts/source-content.ts';
import type { ExecResult } from '../../src/env/types.ts';
import { type SkillSmithError, sourceUnresolvableError } from '../../src/errors.ts';
import {
  type ObservationBundle,
  type ObserverEvent,
  createObservationEmitter,
  createOperationContext,
} from '../../src/observation/index.ts';
import {
  getLedgerPairAt as getPairAt,
  ledgerModelForMutation,
  readLedgerState,
  withLedgerPairAt,
  withoutLedgerPairAt,
  writeLedger,
} from '../../src/place/ledger.ts';
import { ledgerPathOf } from '../../src/place/paths.ts';
import type { Journal } from '../../src/place/types.ts';
import type { RuntimePorts } from '../../src/ports/types.ts';
import { err, ok } from '../../src/result.ts';
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
    operationId: 'command:v1:record-only-install-repair',
    command: 'skillsmith install fixture --tool claude-code',
    workflow: 'install',
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
    throw new Error('record-only repair operation did not start');
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
  ok<InstallRecord[]>([
    { path: `/usr/local/bin/${tool}`, version: '1.0.0', installMethod: 'unknown' },
  ]);

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
let artifactCoordinator: ArtifactCoordinatorPorts;
const makeDeps = (over: Partial<InstallDeps> = {}): InstallDeps => {
  const start = installCounter++;
  let n = 0;
  return {
    verify: passVerify,
    detect: detectBoth,
    transport: fixture.transport,
    artifactCoordinator,
    now: () => NOW,
    newTxId: () => (0x10000000 + start * 1000 + n++).toString(16).slice(-8),
    ...over,
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
let fsLabel: string;
let userOpts: InstallOptions;
beforeEach(async () => {
  f = await buildFixtureFleet();
  artifactCoordinator = await createTestNodeArtifactCoordinatorPorts(
    join(f.base, 'artifact-coordination'),
  );
  fsSource = `${fixture.multiSource}//plugins/fh/skills/factor-scan`;
  const parsed = parseSource(fsSource);
  if (!parsed.ok) throw new Error(msg(parsed.error));
  fsLabel = parsed.value.canonicalInvocation;
  userOpts = { sources: [fsSource], cwd: f.base, configuration: f.configuration };
});
afterEach(async () => {
  await destroyFixtureFleet(f);
});

const claudeRoot = (): string => join(f.home, '.claude', 'skills');
const agentsRoot = (): string => join(f.home, '.agents', 'skills');
const legacyRoot = (): string => join(f.home, '.codex', 'skills');
const led = async () => {
  const r = await readLedgerState(f.env, ledgerPathOf(f.data));
  if (!r.ok) throw new Error(msg(r.error));
  if (r.value.state !== 'present') throw new Error('expected persisted ledger');
  return r.value.model;
};
const fetchDirs = async (): Promise<readonly string[]> => {
  const dir = join(f.data, '.fetch');
  if ((await f.env.pathKind(dir)) === 'absent') return [];
  return f.env.listDir(dir);
};

describe('runInstall — fresh install', () => {
  test('symlink placement into both tool roots, full origin, shared store, exec + symlink preserved', async () => {
    const r = await runInstall(f.env, userOpts, makeDeps());
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.summary.installed).toBe(2);

    const claudeLink = join(claudeRoot(), 'factor-scan');
    const agentsLink = join(agentsRoot(), 'factor-scan');
    expect(await f.env.pathKind(claudeLink)).toBe('symlink');
    expect(await f.env.pathKind(agentsLink)).toBe('symlink');

    const ledger = await led();
    const ccPair = getPairAt(ledger, null, 'factor-scan', 'claude-code');
    const cxPair = getPairAt(ledger, null, 'factor-scan', 'codex');
    expect(ccPair?.pinned?.placement).toBe('symlink');
    expect(cxPair?.pinned?.placement).toBe('symlink');
    expect(await readlink(claudeLink)).toBe(ccPair?.pinned?.storePath as string);

    // full origin: unclamped repo (multi-segment), literal source, resolved HEAD, HEAD => null ref
    const expectedRepo = parseSource(fsSource).ok
      ? (
          parseSource(fsSource) as {
            ok: true;
            value: { identity: { repository: string } };
          }
        ).value.identity.repository
      : '';
    expect(ccPair?.origin?.repo).toBe(expectedRepo);
    expect(ccPair?.origin?.repo.includes('/')).toBe(true);
    expect(ccPair?.origin?.source).toBe(
      'fixture.invalid/acme/multi//plugins/fh/skills/factor-scan',
    );
    expect(ccPair?.origin?.skillPath).toBe('plugins/fh/skills/factor-scan');
    expect(ccPair?.origin?.refRequested).toBeNull();
    expect(ccPair?.origin?.refResolved).toBe(fixture.multiHead);
    expect(ccPair?.pinned?.gitSha).toBe(fixture.multiHead);
    expect(ccPair?.pinned?.rev).toBe(fixture.multiHead.slice(0, 12));

    // store entry preserves exec bit + relative symlink
    const storePath = ccPair?.pinned?.storePath as string;
    const runStat = await lstat(join(storePath, 'bin', 'run.sh'));
    expect((runStat.mode & 0o100) !== 0).toBe(true);
    const linkStat = await lstat(join(storePath, 'link.md'));
    expect(linkStat.isSymbolicLink()).toBe(true);
    expect(await readlink(join(storePath, 'link.md'))).toBe('SKILL.md');

    // store shared: first tool fresh (reused false), second reuses
    const cc = r.value.results.find((x) => x.tool === 'claude-code');
    const cx = r.value.results.find((x) => x.tool === 'codex');
    expect(cc?.store?.reused).toBe(false);
    expect(cx?.store?.reused).toBe(true);
    expect(cx?.store?.path).toBe(cc?.store?.path);
    expect(await fetchDirs()).toEqual([]);
  });

  test('--direct → real dir placements, placement copy, content matches store entry', async () => {
    const r = await runInstall(f.env, { ...userOpts, direct: true }, makeDeps());
    if (!r.ok) throw new Error(msg(r.error));
    const claudeDir = join(claudeRoot(), 'factor-scan');
    expect(await f.env.pathKind(claudeDir)).toBe('dir');
    const ledger = await led();
    const pair = getPairAt(ledger, null, 'factor-scan', 'claude-code');
    expect(pair?.pinned?.placement).toBe('copy');
    const r1 = r.value.results.find((x) => x.tool === 'claude-code');
    expect(r1?.placement).toBe('copy');
    expect(await f.env.pathKind(join(claudeDir, 'SKILL.md'))).toBe('file');
  });

  test('a project-relative custom path owns the reported and actual placement', async () => {
    const file = join(f.project, 'custom-path.toml');
    const lockfile = join(f.project, 'custom-path.lock');
    const customPath = join(f.projectReal, 'custom', 'skills', 'factor-scan');
    const standardPath = join(f.projectReal, '.claude', 'skills', 'factor-scan');
    const result = await runInstall(
      f.env,
      {
        ...userOpts,
        cwd: f.project,
        scope: 'project',
        tools: ['claude-code'],
        path: './custom/skills',
        file,
        lockfile,
      },
      makeDeps(),
    );
    if (!result.ok) throw new Error(msg(result.error));

    expect(result.value.results).toMatchObject([
      { action: 'installed', placementPath: customPath },
    ]);
    expect(await f.env.pathKind(customPath)).toBe('symlink');
    expect(await f.env.pathKind(standardPath)).toBe('absent');
    expect(
      result.value.plan.operations.filter(({ pairId }) => pairId !== null).map(({ kind }) => kind),
    ).toEqual(['install']);
  });

  test('a standard-root collision refuses a selected custom path without changing either slot', async () => {
    const file = join(f.project, 'custom-collision.toml');
    const lockfile = join(f.project, 'custom-collision.lock');
    const customPath = join(f.projectReal, 'custom', 'skills', 'factor-scan');
    const standardPath = join(f.projectReal, '.claude', 'skills', 'factor-scan');
    const standardSkill = join(standardPath, 'SKILL.md');
    const original = '---\nname: factor-scan\n---\n\n# locally managed\n';
    await f.env.makeDir(standardPath);
    await f.env.writeTextFile(standardSkill, original);

    const result = await runInstall(
      f.env,
      {
        ...userOpts,
        cwd: f.project,
        scope: 'project',
        tools: ['claude-code'],
        path: './custom/skills',
        file,
        lockfile,
      },
      makeDeps(),
    );
    if (!result.ok) throw new Error(msg(result.error));

    expect(result.value.results).toMatchObject([
      { action: 'refused', placementPath: customPath, error: { code: 'flip-refused' } },
    ]);
    expect(result.value.results[0]?.reason).toContain(standardPath);
    expect(await f.env.readText(standardSkill)).toBe(original);
    expect(await f.env.pathKind(customPath)).toBe('absent');
  });
});

describe('runInstall — idempotence / update / repair', () => {
  test('idempotent re-run → both noop; --force same rev → updated', async () => {
    const r1 = await runInstall(f.env, userOpts, makeDeps());
    if (!r1.ok) throw new Error(msg(r1.error));
    expect(r1.value.summary.installed).toBe(2);

    const r2 = await runInstall(f.env, userOpts, makeDeps());
    if (!r2.ok) throw new Error(msg(r2.error));
    expect(r2.value.summary.noop).toBe(2);
    expect(r2.value.results[0]?.reason).toContain('already installed');

    const r3 = await runInstall(f.env, { ...userOpts, force: true }, makeDeps());
    if (!r3.ok) throw new Error(msg(r3.error));
    expect(r3.value.summary.updated).toBe(2);
  });

  test('an exact one-tool rerun is zero-op and a missing lock repairs without touching exact live state', async () => {
    const file = join(f.base, 'exact-state.toml');
    const lockfile = join(f.base, 'exact-state.lock');
    const livePath = join(claudeRoot(), 'factor-scan');
    const options = {
      ...userOpts,
      tools: ['claude-code'] as const,
      file,
      lockfile,
    };
    const installed = await runInstall(f.env, options, makeDeps());
    if (!installed.ok) throw new Error(msg(installed.error));
    expect(installed.value.results[0]?.action).toBe('installed');
    const manifestBytes = await f.env.readText(file);
    const lockBytes = await f.env.readText(lockfile);
    const liveTarget = await readlink(livePath);
    const ledger = await led();
    const pair = getPairAt(ledger, null, 'factor-scan', 'claude-code');
    const projected = await projectSourceContent(f.env, pair?.pinned?.storePath ?? '');
    if (!projected.ok) throw new Error(projected.error.message);
    const portable = hashSourceContentV1(projected.value);
    if (!portable.ok) throw new Error(portable.error.message);
    const savedLock = lockV1Codec.decode(new TextEncoder().encode(lockBytes));
    if (!savedLock.ok) throw new Error(savedLock.error.message);
    expect(savedLock.value.model.skills[0]?.contentHash).toBe(portable.value);
    expect(savedLock.value.model.skills[0]?.contentHash).not.toBe(pair?.pinned?.contentHash);

    const exact = await runInstall(f.env, options, makeDeps());
    if (!exact.ok) throw new Error(msg(exact.error));
    expect(exact.value.results[0]?.action).toBe('noop');
    expect(exact.value.plan.operations).toEqual([]);
    expect(exact.value.executionResults).toEqual([]);

    await f.env.makeDir(join(pair?.pinned?.storePath ?? '', 'legacy-invisible-empty'));
    await f.env.removeTree(lockfile);
    const repaired = await runInstall(f.env, options, makeDeps());
    if (!repaired.ok) throw new Error(msg(repaired.error));
    expect(repaired.value.results[0]?.action).toBe('noop');
    expect(repaired.value.plan.operations.map(({ kind }) => kind)).toEqual(['write-lock']);
    expect(repaired.value.executionResults).toMatchObject([{ outcome: 'succeeded' }]);
    expect(await f.env.readText(file)).toBe(manifestBytes);
    expect(await f.env.readText(lockfile)).toBe(lockBytes);
    expect(await readlink(livePath)).toBe(liveTarget);
  });

  test('a saving rerun never legitimizes a file-tampered elided store as exact Git content', async () => {
    const file = join(f.base, 'tampered-store.toml');
    const lockfile = join(f.base, 'tampered-store.lock');
    const options = { ...userOpts, tools: ['claude-code'] as const, file, lockfile };
    const installed = await runInstall(f.env, options, makeDeps());
    if (!installed.ok) throw new Error(msg(installed.error));
    const beforeLock = await f.env.readText(lockfile);
    const pair = getPairAt(await led(), null, 'factor-scan', 'claude-code');
    await f.env.writeTextFile(join(pair?.pinned?.storePath ?? '', 'SKILL.md'), '# tampered\n');

    let fetches = 0;
    let materializations = 0;
    const rerun = await runInstall(
      f.env,
      options,
      makeDeps({
        transport: {
          ...fixture.transport,
          fetchRepo: async (...args) => {
            fetches += 1;
            return fixture.transport.fetchRepo(...args);
          },
          materializeSkill: async (...args) => {
            materializations += 1;
            return fixture.transport.materializeSkill(...args);
          },
        },
      }),
    );
    if (!rerun.ok) throw new Error(msg(rerun.error));
    expect(rerun.value.results[0]).toMatchObject({ action: 'failed' });
    expect({ fetches, materializations }).toEqual({ fetches: 1, materializations: 1 });
    expect(await f.env.readText(lockfile)).toBe(beforeLock);
  });

  test('--ref v1.0.0 --force → updated at the tag rev (deliberate downgrade)', async () => {
    const r1 = await runInstall(f.env, userOpts, makeDeps());
    if (!r1.ok) throw new Error(msg(r1.error));
    const r2 = await runInstall(f.env, { ...userOpts, ref: 'v1.0.0', force: true }, makeDeps());
    if (!r2.ok) throw new Error(msg(r2.error));
    expect(r2.value.summary.updated).toBe(2);
    const ledger = await led();
    const pair = getPairAt(ledger, null, 'factor-scan', 'claude-code');
    expect(pair?.pinned?.rev).toBe(fixture.multiTagSha.slice(0, 12));
    expect(pair?.origin?.refRequested).toBe('v1.0.0');
    expect(pair?.origin?.refResolved).toBe(fixture.multiTagSha);
  });

  test('--direct re-install over an existing copy (dir→dir) is routed as a kind change → updated', async () => {
    const r1 = await runInstall(f.env, { ...userOpts, direct: true }, makeDeps());
    if (!r1.ok) throw new Error(msg(r1.error));
    expect(r1.value.summary.installed).toBe(2);
    const claudeDir = join(claudeRoot(), 'factor-scan');
    expect(await f.env.pathKind(claudeDir)).toBe('dir');

    // re-install --direct --force: live is a real dir, new build is a copy (dir) — the engine would
    // reject a same-kind dir→dir replace, so the run layer routes it via a store-symlink intermediate.
    const r2 = await runInstall(f.env, { ...userOpts, direct: true, force: true }, makeDeps());
    if (!r2.ok) throw new Error(msg(r2.error));
    expect(r2.value.summary.updated).toBe(2);
    // ends as a real dir copy, fully committed (no journal), no residue
    expect(await f.env.pathKind(claudeDir)).toBe('dir');
    expect(await f.env.pathKind(join(claudeDir, 'SKILL.md'))).toBe('file');
    const ledger = await led();
    const pair = getPairAt(ledger, null, 'factor-scan', 'claude-code');
    expect(pair?.pinned?.placement).toBe('copy');
    expect(pair?.journal).toBeNull();
    const residue = (await f.env.listDir(claudeRoot())).filter((n) => n.startsWith('.skillsmith-'));
    expect(residue).toEqual([]);
  });

  test('repaired: ledger pair deleted, placement intact → repaired with no placement mutation', async () => {
    const r1 = await runInstall(f.env, userOpts, makeDeps());
    if (!r1.ok) throw new Error(msg(r1.error));
    const claudeLink = join(claudeRoot(), 'factor-scan');
    const before = await lstat(claudeLink);
    const beforeTarget = await readlink(claudeLink);

    // delete the ledger pairs, leave placements intact on disk
    const ledger = await led();
    const withoutClaude = withoutLedgerPairAt(ledger, null, 'factor-scan', 'claude-code');
    if (!withoutClaude.ok) throw new Error(msg(withoutClaude.error));
    const withoutCodex = withoutLedgerPairAt(withoutClaude.value, null, 'factor-scan', 'codex');
    if (!withoutCodex.ok) throw new Error(msg(withoutCodex.error));
    const w = await writeLedger(f.env, ledgerPathOf(f.data), withoutCodex.value);
    if (!w.ok) throw new Error(msg(w.error));

    const r2 = await runInstall(f.env, userOpts, makeDeps());
    if (!r2.ok) throw new Error(msg(r2.error));
    expect(r2.value.summary.repaired).toBe(2);

    // placement untouched (same target), no staging/backup residue
    const after = await lstat(claudeLink);
    expect(await readlink(claudeLink)).toBe(beforeTarget);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    const residue = (await f.env.listDir(claudeRoot())).filter((n) => n.startsWith('.skillsmith-'));
    expect(residue).toEqual([]);
    // record rewritten
    const ledger2 = await led();
    expect(getPairAt(ledger2, null, 'factor-scan', 'claude-code')?.origin?.refResolved).toBe(
      fixture.multiHead,
    );
    const repairs = ledger2.history.filter((journal) => journal.intent.kind === 'repair');
    expect(repairs).toHaveLength(2);
    expect(repairs.map((journal) => journal.intent.tool).sort()).toEqual(['claude-code', 'codex']);
    expect(Object.keys(ledger2.transactions)).toEqual([]);
  });

  test('observed record-only repair emits one correlated committed transaction', async () => {
    const options = { ...userOpts, tools: ['claude-code'] as const };
    const installed = await runInstall(f.env, options, makeDeps());
    if (!installed.ok) throw new Error(msg(installed.error));
    expect(installed.value.summary.installed).toBe(1);

    const ledger = await led();
    const withoutClaude = withoutLedgerPairAt(ledger, null, 'factor-scan', 'claude-code');
    if (!withoutClaude.ok) throw new Error(msg(withoutClaude.error));
    const written = await writeLedger(f.env, ledgerPathOf(f.data), withoutClaude.value);
    if (!written.ok) throw new Error(msg(written.error));

    const observed = observationFixture();
    const repaired = await runInstallWithRegistryObserved(
      f.env,
      options,
      makeDeps(),
      toolRegistry,
      observed.observation,
    );
    if (!repaired.ok) throw new Error(msg(repaired.error));

    expect(repaired.value.summary).toMatchObject({ repaired: 1, failed: 0 });
    expect(repaired.value.results).toMatchObject([
      { tool: 'claude-code', action: 'repaired', placement: 'symlink' },
    ]);
    const durable = await led();
    expect(getPairAt(durable, null, 'factor-scan', 'claude-code')?.journal).toBeNull();
    const committed = durable.history.at(-1);
    expect(committed).toMatchObject({
      intent: { kind: 'repair', skill: 'factor-scan', tool: 'claude-code' },
      phase: 'committed',
    });
    if (committed === undefined) throw new Error('record-only repair history is missing');
    expectCorrelatedRecordOnlyTransaction(observed.events, committed.transactionId);
  });
});

describe('runInstall — preserved edited-copy backup notice (SC-I60-R3)', () => {
  const singleTool = ['claude-code'] as const;
  const liveCopyDir = (): string => join(claudeRoot(), 'factor-scan');
  const liveSkillFile = (): string => join(liveCopyDir(), 'SKILL.md');
  const rootEntries = (): Promise<readonly string[]> => f.env.listDir(claudeRoot());
  const addedEntries = (before: readonly string[], after: readonly string[]): string[] => {
    const seen = new Set(before);
    return after.filter((name) => !seen.has(name));
  };

  const seedDirectCopy = async (): Promise<{
    storeSkillFile: string;
    originalBytes: string;
  }> => {
    const seeded = await runInstall(
      f.env,
      { ...userOpts, tools: singleTool, direct: true },
      makeDeps(),
    );
    if (!seeded.ok) throw new Error(msg(seeded.error));
    expect(seeded.value.summary.installed).toBe(1);
    const installed = seeded.value.results.find((x) => x.tool === 'claude-code');
    expect(installed?.action).toBe('installed');
    expect(installed?.placement).toBe('copy');
    expect(installed?.origin?.refResolved).toBe(fixture.multiHead);
    expect(await f.env.pathKind(liveCopyDir())).toBe('dir');
    expect(await f.env.pathKind(liveSkillFile())).toBe('file');
    const ledger = await led();
    const pair = getPairAt(ledger, null, 'factor-scan', 'claude-code');
    expect(pair?.pinned?.placement).toBe('copy');
    expect(pair?.journal).toBeNull();
    if (pair?.pinned?.storePath === undefined) throw new Error('seeded pair has no store path');
    const storeSkillFile = join(pair.pinned.storePath, 'SKILL.md');
    const originalBytes = await readFile(storeSkillFile, 'utf8');
    expect(await readFile(liveSkillFile(), 'utf8')).toBe(originalBytes);
    return { storeSkillFile, originalBytes };
  };

  test('edited direct-copy → symlink force replacement keeps the backup dir and reports its path', async () => {
    const { storeSkillFile, originalBytes } = await seedDirectCopy();
    const before = await rootEntries();

    const editMarker = '\nSC-I60-R3 edited-copy marker (direct-to-symlink)\n';
    await appendFile(liveSkillFile(), editMarker);
    const editedBytes = await readFile(liveSkillFile(), 'utf8');
    expect(editedBytes).toBe(`${originalBytes}${editMarker}`);
    expect(editedBytes).not.toBe(originalBytes);
    expect(await readFile(storeSkillFile, 'utf8')).toBe(originalBytes);

    const replaced = await runInstall(
      f.env,
      { ...userOpts, tools: singleTool, force: true },
      makeDeps(),
    );
    if (!replaced.ok) throw new Error(msg(replaced.error));
    expect(replaced.value.summary.updated).toBe(1);
    const result = replaced.value.results.find((x) => x.tool === 'claude-code');
    expect(result?.action).toBe('updated');
    expect(result?.placement).toBe('symlink');
    expect(result?.store?.reused).toBe(true);
    expect(await f.env.pathKind(liveCopyDir())).toBe('symlink');
    const ledger = await led();
    const pair = getPairAt(ledger, null, 'factor-scan', 'claude-code');
    expect(pair?.pinned?.placement).toBe('symlink');
    expect(pair?.journal).toBeNull();
    expect(pair?.origin?.refResolved).toBe(fixture.multiHead);
    if (pair?.pinned?.storePath === undefined) throw new Error('replaced pair has no store path');
    expect(await readlink(liveCopyDir())).toBe(pair.pinned.storePath);
    expect(await readFile(liveSkillFile(), 'utf8')).toBe(originalBytes);

    const added = addedEntries(before, await rootEntries());
    expect(added).toHaveLength(1);
    const backupName = added[0];
    if (backupName === undefined) throw new Error('expected one retained backup entry');
    expect(backupName.startsWith('.skillsmith-backup-factor-scan-')).toBe(true);
    const backupPath = join(claudeRoot(), backupName);
    expect(await f.env.pathKind(backupPath)).toBe('dir');
    expect(await readFile(join(backupPath, 'SKILL.md'), 'utf8')).toBe(editedBytes);
    expect(await readFile(storeSkillFile, 'utf8')).toBe(originalBytes);

    expect(result?.reason).not.toBeNull();
    expect(result?.reason ?? '').toContain('kept backup');
    expect(result?.reason ?? '').toContain(backupPath);
  });

  test('edited direct-copy → copy force replacement keeps the first-stage backup and reports it', async () => {
    const { storeSkillFile, originalBytes } = await seedDirectCopy();
    const before = await rootEntries();

    const editMarker = '\nSC-I60-R3 edited-copy marker (direct-to-copy)\n';
    await appendFile(liveSkillFile(), editMarker);
    const editedBytes = await readFile(liveSkillFile(), 'utf8');
    expect(editedBytes).toBe(`${originalBytes}${editMarker}`);
    expect(editedBytes).not.toBe(originalBytes);
    expect(await readFile(storeSkillFile, 'utf8')).toBe(originalBytes);

    // dir→dir is routed as two kind changes; the first stage preserves the edited bytes while the
    // second (symlink cleanup) is clean — the first stage's notice must survive.
    const replaced = await runInstall(
      f.env,
      { ...userOpts, tools: singleTool, direct: true, force: true },
      makeDeps(),
    );
    if (!replaced.ok) throw new Error(msg(replaced.error));
    expect(replaced.value.summary.updated).toBe(1);
    const result = replaced.value.results.find((x) => x.tool === 'claude-code');
    expect(result?.action).toBe('updated');
    expect(result?.placement).toBe('copy');
    expect(result?.store?.reused).toBe(true);
    expect(await f.env.pathKind(liveCopyDir())).toBe('dir');
    expect(await readFile(liveSkillFile(), 'utf8')).toBe(originalBytes);
    const ledger = await led();
    const pair = getPairAt(ledger, null, 'factor-scan', 'claude-code');
    expect(pair?.pinned?.placement).toBe('copy');
    expect(pair?.journal).toBeNull();
    expect(pair?.origin?.refResolved).toBe(fixture.multiHead);

    const added = addedEntries(before, await rootEntries());
    expect(added).toHaveLength(1);
    const backupName = added[0];
    if (backupName === undefined) throw new Error('expected one retained backup entry');
    expect(backupName.startsWith('.skillsmith-backup-factor-scan-')).toBe(true);
    const backupPath = join(claudeRoot(), backupName);
    expect(await f.env.pathKind(backupPath)).toBe('dir');
    expect(await readFile(join(backupPath, 'SKILL.md'), 'utf8')).toBe(editedBytes);
    expect(await readFile(storeSkillFile, 'utf8')).toBe(originalBytes);

    expect(result?.reason).not.toBeNull();
    expect(result?.reason ?? '').toContain('kept backup');
    expect(result?.reason ?? '').toContain(backupPath);
  });

  test('untouched direct-copy → symlink force replacement reclaims residue and claims no backup', async () => {
    await seedDirectCopy();
    const before = await rootEntries();

    const replaced = await runInstall(
      f.env,
      { ...userOpts, tools: singleTool, force: true },
      makeDeps(),
    );
    if (!replaced.ok) throw new Error(msg(replaced.error));
    expect(replaced.value.summary.updated).toBe(1);
    const result = replaced.value.results.find((x) => x.tool === 'claude-code');
    expect(result?.action).toBe('updated');
    expect(result?.placement).toBe('symlink');
    expect(await f.env.pathKind(liveCopyDir())).toBe('symlink');
    expect(addedEntries(before, await rootEntries())).toEqual([]);
    expect(result?.reason ?? '').not.toContain('kept backup');
  });

  test('untouched direct-copy → copy force replacement reclaims residue and claims no backup', async () => {
    await seedDirectCopy();
    const before = await rootEntries();

    const replaced = await runInstall(
      f.env,
      { ...userOpts, tools: singleTool, direct: true, force: true },
      makeDeps(),
    );
    if (!replaced.ok) throw new Error(msg(replaced.error));
    expect(replaced.value.summary.updated).toBe(1);
    const result = replaced.value.results.find((x) => x.tool === 'claude-code');
    expect(result?.action).toBe('updated');
    expect(result?.placement).toBe('copy');
    expect(await f.env.pathKind(liveCopyDir())).toBe('dir');
    expect(addedEntries(before, await rootEntries())).toEqual([]);
    expect(result?.reason ?? '').not.toContain('kept backup');
  });
});

describe('runInstall — scope', () => {
  test('project scope inside a work tree; pair keyed by realpath; user tree untouched', async () => {
    const r = await runInstall(
      f.env,
      { sources: [fsSource], cwd: f.project, configuration: f.configuration },
      makeDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.requested.scope).toBe('project');
    expect(r.value.requested.explicitScope).toBe(false);

    expect(await f.env.pathKind(join(f.project, '.claude', 'skills', 'factor-scan'))).toBe(
      'symlink',
    );
    const ledger = await led();
    expect(getPairAt(ledger, f.projectReal, 'factor-scan', 'claude-code')?.mode).toBe('pinned');
    expect(getPairAt(ledger, null, 'factor-scan', 'claude-code')).toBeNull();
  });

  test('default scope is user outside a work tree', async () => {
    const r = await runInstall(f.env, userOpts, makeDeps());
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.requested.scope).toBe('user');
  });

  test('shadowing: user then project install of the same skill → refused; --force proceeds', async () => {
    const u = await runInstall(f.env, userOpts, makeDeps());
    if (!u.ok) throw new Error(msg(u.error));

    const p = await runInstall(
      f.env,
      { sources: [fsSource], cwd: f.project, configuration: f.configuration },
      makeDeps(),
    );
    if (!p.ok) throw new Error(msg(p.error));
    expect(p.value.results.every((x) => x.action === 'refused')).toBe(true);
    expect(p.value.results[0]?.reason).toContain('shadow');
    expect(p.value.results[0]?.error?.code).toBe('flip-refused');

    const pf = await runInstall(
      f.env,
      { sources: [fsSource], cwd: f.project, configuration: f.configuration, force: true },
      makeDeps(),
    );
    if (!pf.ok) throw new Error(msg(pf.error));
    expect(pf.value.results.every((x) => x.action === 'installed')).toBe(true);
    expect(pf.value.results[0]?.reason ?? '').toContain('shadow');
  });
});

describe('runInstall — codex legacy conflict (D15)', () => {
  test('legacy skill present → codex refused even under --force; claude-code proceeds', async () => {
    await f.env.makeDir(join(legacyRoot(), 'factor-scan'));
    await f.env.writeTextFile(
      join(legacyRoot(), 'factor-scan', 'SKILL.md'),
      '---\nname: factor-scan\n---\n',
    );
    const r = await runInstall(f.env, { ...userOpts, force: true }, makeDeps());
    if (!r.ok) throw new Error(msg(r.error));
    const cx = r.value.results.find((x) => x.tool === 'codex');
    const cc = r.value.results.find((x) => x.tool === 'claude-code');
    expect(cx?.action).toBe('refused');
    expect(cx?.error?.code).toBe('flip-refused');
    expect(cx?.reason).toContain('legacy');
    expect(cx?.reason).toContain('uninstall');
    expect(cc?.action).toBe('installed');
  });

  test('project install detects a user-scope legacy shadow and reports its adapter path', async () => {
    const legacyPath = join(legacyRoot(), 'factor-scan');
    await f.env.makeDir(legacyPath);
    await f.env.writeTextFile(join(legacyPath, 'SKILL.md'), '---\nname: factor-scan\n---\n');

    const r = await runInstall(
      f.env,
      {
        sources: [fsSource],
        tools: ['codex'],
        cwd: f.project,
        configuration: f.configuration,
      },
      makeDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));

    expect(r.value.results).toHaveLength(1);
    expect(r.value.results[0]?.action).toBe('refused');
    expect(r.value.results[0]?.error?.code).toBe('flip-refused');
    expect(r.value.results[0]?.reason).toContain(legacyPath);
  });
});

describe('runInstall — tool detection', () => {
  test('explicit --tool codex undetected → refused + tool-unavailable with install hint', async () => {
    const detect: InstallDeps['detect'] = async (_env, tool) =>
      tool === 'codex'
        ? ok<InstallRecord[]>([])
        : ok<InstallRecord[]>([{ path: '/x', version: '1', installMethod: 'unknown' }]);
    const r = await runInstall(f.env, { ...userOpts, tools: ['codex'] }, makeDeps({ detect }));
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results.every((x) => x.action === 'refused')).toBe(true);
    expect(r.value.results[0]?.error?.code).toBe('tool-unavailable');
    expect(r.value.results[0]?.reason).toContain('npm install -g @openai/codex');
  });

  test('auto mode installs only the one detected tool, silently', async () => {
    const detect: InstallDeps['detect'] = async (_env, tool) =>
      tool === 'claude-code'
        ? ok<InstallRecord[]>([{ path: '/x', version: '1', installMethod: 'unknown' }])
        : ok<InstallRecord[]>([]);
    const r = await runInstall(f.env, userOpts, makeDeps({ detect }));
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results.length).toBe(1);
    expect(r.value.results[0]?.tool).toBe('claude-code');
    expect(r.value.results[0]?.action).toBe('installed');
  });

  test('mixed explicit detection preserves complete intent and fail-fast skips later source groups', async () => {
    const file = join(f.base, 'mixed-detection-fail-fast.toml');
    const lockfile = join(f.base, 'mixed-detection-fail-fast.lock');
    const detect: InstallDeps['detect'] = async (_env, tool) =>
      tool === 'claude-code'
        ? ok<InstallRecord[]>([{ path: '/x', version: '1', installMethod: 'unknown' }])
        : ok<InstallRecord[]>([]);
    const result = await runInstall(
      f.env,
      {
        sources: [fsSource, fixture.singleSource],
        tools: ['claude-code', 'codex'],
        file,
        lockfile,
        cwd: f.base,
        configuration: f.configuration,
      },
      makeDeps({ detect }),
    );
    if (!result.ok) throw new Error(msg(result.error));

    expect(result.value.requested.tools).toEqual(['claude-code', 'codex']);
    expect(result.value.results.filter(({ requestIndex }) => requestIndex === 0)).toMatchObject([
      { tool: 'codex', action: 'refused', error: { code: 'tool-unavailable' } },
      { tool: 'claude-code', action: 'installed' },
    ]);
    expect(result.value.results.filter(({ requestIndex }) => requestIndex === 1)).toMatchObject([
      { tool: null, action: 'skipped', reason: 'fail-fast' },
    ]);
    const manifest = manifestV1Codec.decode(await f.env.readBytes(file));
    if (!manifest.ok) throw new Error(manifest.error.message);
    expect(manifest.value.model.skills).toMatchObject([
      { name: 'factor-scan', tools: ['claude-code', 'codex'] },
    ]);
  });

  test('mixed explicit detection with continue-on-error saves complete intent for every source group', async () => {
    const file = join(f.base, 'mixed-detection-continue.toml');
    const lockfile = join(f.base, 'mixed-detection-continue.lock');
    const detect: InstallDeps['detect'] = async (_env, tool) =>
      tool === 'claude-code'
        ? ok<InstallRecord[]>([{ path: '/x', version: '1', installMethod: 'unknown' }])
        : ok<InstallRecord[]>([]);
    const result = await runInstall(
      f.env,
      {
        sources: [fsSource, fixture.singleSource],
        tools: ['claude-code', 'codex'],
        file,
        lockfile,
        continueOnError: true,
        cwd: f.base,
        configuration: f.configuration,
      },
      makeDeps({ detect }),
    );
    if (!result.ok) throw new Error(msg(result.error));

    expect(result.value.requested.tools).toEqual(['claude-code', 'codex']);
    for (const requestIndex of [0, 1]) {
      expect(
        result.value.results.filter((result) => result.requestIndex === requestIndex),
      ).toMatchObject([
        { tool: 'codex', action: 'refused', error: { code: 'tool-unavailable' } },
        { tool: 'claude-code', action: 'installed' },
      ]);
    }
    const groups = [...new Set(result.value.plan.operations.map(({ groupId }) => groupId))];
    expect(groups).toHaveLength(2);
    const firstGroup = result.value.plan.operations.filter(({ groupId }) => groupId === groups[0]);
    const secondGroup = result.value.plan.operations.filter(({ groupId }) => groupId === groups[1]);
    const prefix = firstGroup.find(({ kind }) => kind === 'write-lock');
    if (prefix === undefined) throw new Error('missing first saving install lock terminal');
    expect(
      secondGroup.every(({ dependencyMetadata }) =>
        dependencyMetadata.operationIds.includes(prefix.operationId),
      ),
    ).toBeTrue();
    const manifest = manifestV1Codec.decode(await f.env.readBytes(file));
    if (!manifest.ok) throw new Error(manifest.error.message);
    expect(
      [...manifest.value.model.skills].sort((left, right) => left.name.localeCompare(right.name)),
    ).toMatchObject([
      { name: 'factor-scan', tools: ['claude-code', 'codex'] },
      { name: 'lint', tools: ['claude-code', 'codex'] },
    ]);
  });
});

describe('runInstall — injected lifecycle registry', () => {
  test('default detection dispatches through the injected registry inventory', async () => {
    let detectedEnv: Parameters<InstallDeps['detect']>[0] | undefined;
    let detectedSignal: AbortSignal | undefined;
    let detectionCalls = 0;
    const registry = createToolRegistry(
      toolRegistry.adapters.map((adapter) =>
        adapter.descriptor.id === 'codex'
          ? {
              ...adapter,
              inventory: {
                ...adapter.inventory,
                detect: async (env: Parameters<InstallDeps['detect']>[0], signal?: AbortSignal) => {
                  detectionCalls += 1;
                  detectedEnv = env;
                  detectedSignal = signal;
                  return ok<InstallRecord[]>([
                    {
                      path: '/fixture/bin/codex',
                      version: 'fixture',
                      installMethod: 'unknown',
                    },
                  ]);
                },
              },
            }
          : adapter,
      ),
    );
    const signal = new AbortController().signal;

    const result = await runInstallWithRegistry(
      f.env,
      { ...userOpts, tools: ['codex'], dryRun: true, signal },
      makeDeps({ detect: defaultInstallDeps.detect }),
      registry,
    );

    expect(result.ok).toBeTrue();
    if (!result.ok) throw result.error;
    expect(result.value.results[0]?.action).toBe('installed');
    expect(detectionCalls).toBe(1);
    expect(detectedEnv).toBe(f.env);
    expect(detectedSignal).toBe(signal);
  });

  test('fingerprints only the selected operation and verification capabilities', async () => {
    const withCapabilityVersion = (tool: string, capabilityVersion: number) =>
      createToolRegistry(
        toolRegistry.adapters.map((adapter) =>
          adapter.descriptor.id === tool
            ? {
                ...adapter,
                descriptor: { ...adapter.descriptor, capabilityVersion },
              }
            : adapter,
        ),
      );
    const options = {
      ...userOpts,
      tools: ['codex'],
      dryRun: true,
    } as const;
    const prepare = async (registry: ReturnType<typeof createToolRegistry>) => {
      const result = await runInstallWithRegistry(f.env, options, makeDeps(), registry);
      expect(result.ok).toBeTrue();
      if (!result.ok) throw result.error;
      return result.value.plan.operations[0]?.preconditionIds ?? [];
    };

    const baseline = await prepare(toolRegistry);
    const unrelated = await prepare(withCapabilityVersion('kilo-code', 99));
    const selected = await prepare(withCapabilityVersion('codex', 99));

    expect(unrelated).toEqual(baseline);
    expect(selected).not.toEqual(baseline);
  });
});

describe('runInstall — resolution ambiguity', () => {
  test('bare multi repo (3 skills) without pick → refused with 3 //path candidates', async () => {
    const r = await runInstall(
      f.env,
      { sources: [fixture.multiSource], cwd: f.base, configuration: f.configuration },
      makeDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results.length).toBe(1);
    const res = r.value.results[0];
    expect(res?.action).toBe('refused');
    expect(res?.error?.code).toBe('flip-refused');
    expect(res?.skill).toBeNull();
    expect(res?.candidates?.length).toBe(3);
    expect(res?.candidates?.every((c) => c.includes('//'))).toBe(true);
  });

  test('scripted pick resolves the ambiguity and installs the chosen skill', async () => {
    const pick = async (cands: readonly CandidateSkill[]): Promise<CandidateSkill | null> =>
      cands.find((c) => c.path === 'plugins/fh/skills/factor-scan') ?? null;
    const r = await runInstall(
      f.env,
      { sources: [fixture.multiSource], cwd: f.base, configuration: f.configuration },
      makeDeps({ pick }),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.summary.installed).toBe(2);
    expect(r.value.results[0]?.skill).toBe('factor-scan');
  });
});

describe('runInstall — batch semantics', () => {
  test('a parse failure refuses the whole invocation pre-I/O (resolution 3)', async () => {
    const r = await runInstall(
      f.env,
      { sources: ['onepart', fsSource], cwd: f.base, configuration: f.configuration },
      makeDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const bad = r.value.results.find((x) => x.source === '[REJECTED_SOURCE]');
    const good = r.value.results.find((x) => x.source === fsLabel);
    expect(bad?.action).toBe('refused');
    expect(good?.action).toBe('skipped');
    expect(good?.reason).toBe('fail-fast');
    // pre-I/O: nothing fetched, no ledger file
    expect(await f.env.pathKind(ledgerPathOf(f.data))).toBe('absent');
    expect(await fetchDirs()).toEqual([]);
  });

  test('an invalid source preserves the no-save current report context without artifact discovery', async () => {
    let runtimeReads = 0;
    const env: RuntimePorts = {
      ...f.env,
      pathKind: async (path) => {
        runtimeReads++;
        return f.env.pathKind(path);
      },
      readText: async (path) => {
        runtimeReads++;
        return f.env.readText(path);
      },
      readBytes: async (path) => {
        runtimeReads++;
        return f.env.readBytes(path);
      },
      readFileMetadata: async (path) => {
        runtimeReads++;
        return f.env.readFileMetadata(path);
      },
      realpath: async (path) => {
        runtimeReads++;
        return f.env.realpath(path);
      },
    };
    const result = await runInstall(
      env,
      {
        sources: ['onepart'],
        cwd: f.base,
        configuration: f.configuration,
        noSave: true,
      },
      makeDeps(),
    );
    if (!result.ok) throw new Error(msg(result.error));

    expect(result.value).toMatchObject({
      reportVersion: 2,
      saveMode: 'live-only',
      artifactPair: null,
      artifactSelection: { outcome: 'none', reason: 'no-save' },
      results: [{ action: 'refused', error: { code: 'flip-refused' } }],
      plan: { operations: [] },
      executionResults: [],
    });
    expect(runtimeReads).toBe(0);
    expect(await f.env.pathKind(ledgerPathOf(f.data))).toBe('absent');
    expect(await fetchDirs()).toEqual([]);
  });

  test('[valid, bad-fetch] → first installs, second failed exit-5 class', async () => {
    const bad = `${fixture.multiSource}//not/a/skill`;
    const badLabel = parseSource(bad);
    if (!badLabel.ok) throw new Error(msg(badLabel.error));
    const r = await runInstall(
      f.env,
      { sources: [fsSource, bad], cwd: f.base, configuration: f.configuration },
      makeDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results.some((x) => x.source === fsLabel && x.action === 'installed')).toBe(
      true,
    );
    const badRes = r.value.results.find((x) => x.source === badLabel.value.canonicalInvocation);
    expect(badRes?.action).toBe('failed');
    expect(badRes?.error?.code).toBe('source-unresolvable');
  });

  test('[bad-fetch, valid] without continueOnError → later source skipped/fail-fast', async () => {
    const bad = `${fixture.multiSource}//not/a/skill`;
    const badLabel = parseSource(bad);
    if (!badLabel.ok) throw new Error(msg(badLabel.error));
    const r = await runInstall(
      f.env,
      { sources: [bad, fsSource], cwd: f.base, configuration: f.configuration },
      makeDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(
      r.value.results.find((x) => x.source === badLabel.value.canonicalInvocation)?.action,
    ).toBe('failed');
    const good = r.value.results.filter((x) => x.source === fsLabel);
    expect(good.every((x) => x.action === 'skipped' && x.reason === 'fail-fast')).toBe(true);
  });

  test('continueOnError attempts every source', async () => {
    const bad = `${fixture.multiSource}//not/a/skill`;
    const badLabel = parseSource(bad);
    if (!badLabel.ok) throw new Error(msg(badLabel.error));
    const r = await runInstall(
      f.env,
      {
        sources: [bad, fsSource],
        cwd: f.base,
        configuration: f.configuration,
        continueOnError: true,
      },
      makeDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(
      r.value.results.find((x) => x.source === badLabel.value.canonicalInvocation)?.action,
    ).toBe('failed');
    expect(r.value.summary.installed).toBe(2);
  });

  test('G3B-02: a started source group attempts every tool pair before fail-fast skips later groups', async () => {
    const attemptedStagingRoots: string[] = [];
    const failingFirstPairEnv: RuntimePorts = {
      ...f.env,
      makeSymlink: async (target, linkPath) => {
        if (linkPath.includes('.skillsmith-staging-factor-scan-')) {
          const root = linkPath.startsWith(claudeRoot()) ? 'claude-code' : 'codex';
          attemptedStagingRoots.push(root);
          if (root === 'claude-code') throw new Error('synthetic first-pair staging failure');
        }
        await f.env.makeSymlink(target, linkPath);
      },
    };
    const first = await runInstall(
      failingFirstPairEnv,
      { ...userOpts, tools: ['claude-code', 'codex'] },
      makeDeps(),
    );
    if (!first.ok) throw new Error(msg(first.error));

    const operations = first.value.plan.operations;
    expect(new Set(operations.map(({ groupId }) => groupId))).toHaveLength(1);
    expect(attemptedStagingRoots).toEqual(['claude-code', 'codex']);
    expect(first.value.results.find(({ tool }) => tool === 'claude-code')?.action).toBe('failed');
    expect(first.value.results.find(({ tool }) => tool === 'codex')?.action).toBe('installed');
    const placementOperationIds = new Set(
      operations.filter(({ pairId }) => pairId !== null).map(({ operationId }) => operationId),
    );
    expect(
      first.value.executionResults
        .filter(({ operationId }) => placementOperationIds.has(operationId))
        .map(({ outcome }) => outcome),
    ).toEqual(['failed', 'succeeded']);

    const partialLedger = await led();
    expect(getPairAt(partialLedger, null, 'factor-scan', 'claude-code')?.journal?.phase).toBe(
      'prepared',
    );
    expect(getPairAt(partialLedger, null, 'factor-scan', 'codex')?.journal).toBeNull();

    const converged = await runInstall(
      f.env,
      { ...userOpts, tools: ['claude-code', 'codex'] },
      makeDeps(),
    );
    if (!converged.ok) throw new Error(msg(converged.error));
    const settledLedger = await led();
    expect(getPairAt(settledLedger, null, 'factor-scan', 'claude-code')?.journal).toBeNull();
    expect(getPairAt(settledLedger, null, 'factor-scan', 'codex')?.journal).toBeNull();
  });

  test('a mixed two-tool verification gate persists complete intent and executes only the passing live pair', async () => {
    const file = join(f.base, 'mixed-gate.toml');
    const lockfile = join(f.base, 'mixed-gate.lock');
    const verify: InstallDeps['verify'] = async (env, options) =>
      options.tools?.[0] === 'codex'
        ? err(sourceUnresolvableError('synthetic codex verification gate failure'))
        : passVerify(env, options);
    const result = await runInstall(
      f.env,
      {
        ...userOpts,
        tools: ['claude-code', 'codex'],
        file,
        lockfile,
      },
      makeDeps({ verify }),
    );
    if (!result.ok) throw new Error(msg(result.error));

    const manifest = manifestV1Codec.decode(await f.env.readBytes(file));
    if (!manifest.ok) throw new Error(manifest.error.message);
    expect(manifest.value.model.skills).toMatchObject([
      { name: 'factor-scan', tools: ['claude-code', 'codex'] },
    ]);
    expect(result.value.results).toMatchObject([
      { tool: 'claude-code', action: 'installed' },
      { tool: 'codex', action: 'failed' },
    ]);
    const liveOperations = result.value.plan.operations.filter(({ pairId }) => pairId !== null);
    expect(liveOperations).toHaveLength(1);
    expect(liveOperations[0]).toMatchObject({ kind: 'install' });
    expect(
      result.value.executionResults.filter(({ operationId }) =>
        liveOperations.some((operation) => operation.operationId === operationId),
      ),
    ).toMatchObject([{ outcome: 'succeeded' }]);
    expect(await f.env.pathKind(join(claudeRoot(), 'factor-scan'))).toBe('symlink');
    expect(await f.env.pathKind(join(agentsRoot(), 'factor-scan'))).toBe('absent');
  });

  test('an unsafe override ref never enters requested.ref and does not relabel a valid source', async () => {
    const canary = 'P17_SECRET_CANARY_123456789';
    const r = await runInstall(f.env, { ...userOpts, ref: `token=${canary}` }, makeDeps());
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.requested.ref).toBe('token=[REDACTED]');
    expect(r.value.requested.sources).toEqual([fsLabel]);
    expect(r.value.results[0]?.source).toBe(fsLabel);
    expect(r.value.results[0]?.action).toBe('refused');
    expect(JSON.stringify(r.value)).not.toContain(canary);
  });

  test('an encoded credential name never survives a rejected public source label', async () => {
    const canary = 'P17_SECRET_CANARY';
    for (const key of ['%74oken', '%2525252574oken']) {
      const source = `https://example.test/acme/repo/${key}=${canary}?x=1`;
      const result = await runInstall(f.env, { ...userOpts, sources: [source] }, makeDeps());
      if (!result.ok) throw new Error(msg(result.error));
      expect(JSON.stringify(result.value), key).not.toContain(canary);
      expect(result.value.requested.sources[0], key).toBe(
        'https://example.test/acme/repo/token=[REDACTED]',
      );
      expect(result.value.results[0]?.source, key).toBe(
        'https://example.test/acme/repo/token=[REDACTED]',
      );
    }
  });
});

describe('runInstall — post-transport safety boundary', () => {
  test('refuses token-shaped remote candidate metadata before materialization or persistence', async () => {
    const canary = 'ghp_P17_SECRET_CANARY_123456789';
    let materializeCalls = 0;
    const r = await runInstall(
      f.env,
      userOpts,
      makeDeps({
        transport: {
          ...fixture.transport,
          listSkills: async () =>
            ok({ candidates: [{ path: `skills/${canary}`, name: canary }], scanned: 1 }),
          materializeSkill: async (...args) => {
            materializeCalls++;
            return fixture.transport.materializeSkill(...args);
          },
        },
      }),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results[0]?.action).toBe('failed');
    expect(JSON.stringify(r.value)).not.toContain(canary);
    expect(materializeCalls).toBe(0);
    expect(await f.env.pathKind(ledgerPathOf(f.data))).toBe('absent');
  });

  test('redacts injected transport and verification errors at public result boundaries', async () => {
    const canary = 'ghp_P17_SECRET_CANARY_123456789';
    const transportFailure = await runInstall(
      f.env,
      userOpts,
      makeDeps({
        transport: {
          ...fixture.transport,
          fetchRepo: async () => err(sourceUnresolvableError(`cannot fetch: Bearer ${canary}`)),
        },
      }),
    );
    if (!transportFailure.ok) throw new Error(msg(transportFailure.error));
    expect(JSON.stringify(transportFailure.value)).not.toContain(canary);
    expect(transportFailure.value.results[0]?.reason).toContain('[REDACTED]');

    const verificationFailure = await runInstall(
      f.env,
      userOpts,
      makeDeps({
        verify: async () => err(sourceUnresolvableError(`password=${canary}`)),
      }),
    );
    if (!verificationFailure.ok) throw new Error(msg(verificationFailure.error));
    expect(JSON.stringify(verificationFailure.value)).not.toContain(canary);
    expect(verificationFailure.value.results[0]?.reason).toContain('[REDACTED]');
  });

  test('copies hostile verifier envelopes without reading accessors or proxy traps', async () => {
    const canary = 'ghp_P17_HOSTILE_VERIFY_123456789';
    let getterReads = 0;
    let proxyReads = 0;
    let promiseAssimilationReads = 0;
    const accessorEnvelope: Record<string, unknown> = {};
    Object.defineProperty(accessorEnvelope, 'ok', {
      enumerable: true,
      get: () => {
        getterReads++;
        return false;
      },
    });
    Object.defineProperty(accessorEnvelope, 'error', {
      enumerable: true,
      get: () => {
        getterReads++;
        return sourceUnresolvableError(`password=${canary}`);
      },
    });
    const proxyEnvelope = new Proxy(
      {
        ok: false as const,
        error: sourceUnresolvableError(`password=${canary}`),
      },
      {
        get: (target, key, receiver) => {
          if (key === 'then') {
            // Returning an object through an async dependency necessarily performs the ECMAScript
            // thenable check. Track it separately from application inspection of the envelope.
            promiseAssimilationReads++;
            return Reflect.get(target, key, receiver);
          }
          proxyReads++;
          return Reflect.get(target, key, receiver);
        },
        ownKeys: (target) => {
          proxyReads++;
          return Reflect.ownKeys(target);
        },
      },
    );

    for (const envelope of [accessorEnvelope, proxyEnvelope]) {
      const result = await runInstall(
        f.env,
        userOpts,
        makeDeps({ verify: async () => envelope as never }),
      );
      if (!result.ok) throw new Error(msg(result.error));
      expect(result.value.results[0]?.action).toBe('failed');
      expect(JSON.stringify(result.value)).not.toContain(canary);
      expect(result.value.results[0]?.reason).toContain('operation failed');
    }
    expect(getterReads).toBe(0);
    expect(proxyReads).toBe(0);
    expect(promiseAssimilationReads).toBeGreaterThan(0);
  });

  test('redacts hostile detector errors without reading accessors or proxy traps', async () => {
    const canary = 'ghp_P17_SECRET_CANARY_123456789';
    let getterReads = 0;
    let proxyReads = 0;
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, 'password', {
      enumerable: true,
      get: () => {
        getterReads++;
        return canary;
      },
    });
    const proxy = new Proxy(
      { password: canary },
      {
        get: (target, key, receiver) => {
          proxyReads++;
          return Reflect.get(target, key, receiver);
        },
        ownKeys: (target) => {
          proxyReads++;
          return Reflect.ownKeys(target);
        },
      },
    );
    const injected = {
      ok: false as const,
      error: {
        code: 'source-unresolvable' as const,
        message: `password=${canary}`,
        cause: { accessor, proxy },
      },
    };

    const failure = await runInstall(f.env, userOpts, makeDeps({ detect: async () => injected }));
    expect(failure.ok).toBeFalse();
    if (failure.ok) throw new Error('expected detector failure');
    expect(failure.error.code).toBe('source-unresolvable');
    expect(JSON.stringify(failure)).not.toContain(canary);
    expect(JSON.stringify(failure)).toContain('[REDACTED]');
    expect(injected.error.message).toContain(canary);
    expect(getterReads).toBe(0);
    expect(proxyReads).toBe(0);

    const hostileEnvelope = new Proxy(injected, {
      ownKeys: (target) => {
        proxyReads++;
        return Reflect.ownKeys(target);
      },
    });
    const closed = await runInstall(
      f.env,
      userOpts,
      makeDeps({ detect: async () => hostileEnvelope }),
    );
    expect(closed).toEqual(err({ code: 'generic', message: 'operation failed' }));
    expect(proxyReads).toBe(0);
  });

  test('catches a rejected detector without reading an accessor-backed error', async () => {
    const canary = 'ghp_P17_THROWN_DETECTOR_123456789';
    let getterReads = 0;
    const thrown: Record<string, unknown> = { code: 'permission-denied' };
    Object.defineProperty(thrown, 'message', {
      enumerable: true,
      get: () => {
        getterReads++;
        return `password=${canary}`;
      },
    });

    const result = await runInstall(
      f.env,
      userOpts,
      makeDeps({
        detect: async () => {
          throw thrown;
        },
      }),
    );
    expect(result.ok).toBeFalse();
    if (result.ok) throw new Error('expected rejected detector');
    expect(result.error.code).toBe('permission-denied');
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(getterReads).toBe(0);
    expect(Object.getOwnPropertyDescriptor(thrown, 'message')?.get).toBeFunction();
  });

  test('keeps valid locked success reports mutable with ordinary prototypes', async () => {
    const result = await runInstall(f.env, { ...userOpts, tools: ['claude-code'] }, makeDeps());
    if (!result.ok) throw new Error(msg(result.error));
    expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(result.value.results)).toBe(Array.prototype);
    expect(Object.isFrozen(result.value)).toBeFalse();
    expect(Object.isFrozen(result.value.results)).toBeFalse();
    const first = result.value.results[0];
    if (first === undefined) throw new Error('expected install result');
    const before = result.value.results.length;
    result.value.results.push(first);
    expect(result.value.results).toHaveLength(before + 1);
    result.value.results.pop();
  });

  test('redacts install ledger-read and outer-lock failures in dry and locked paths', async () => {
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

    const dryLedgerFailure = await runInstall(
      ledgerFailure,
      { ...userOpts, dryRun: true },
      makeDeps(),
    );
    const lockedLedgerFailure = await runInstall(ledgerFailure, userOpts, makeDeps());
    const outerLockFailure = await runInstall(lockFailure, userOpts, makeDeps());
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

  test('redacts a non-ledger committed-journal sweep failure', async () => {
    const canary = 'ghp_P17_SECRET_CANARY_123456789';
    const seeded = await runInstall(f.env, { ...userOpts, tools: ['claude-code'] }, makeDeps());
    if (!seeded.ok) throw new Error(msg(seeded.error));
    const ledger = await led();
    const pair = getPairAt(ledger, null, 'factor-scan', 'claude-code');
    if (!pair?.pinned) throw new Error('expected seeded pinned pair');
    const backupPath = join(claudeRoot(), '.skillsmith-backup-factor-scan-deadbeef');
    const journal: Journal = {
      op: 'install',
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

    const result = await runInstall(
      sweepFailure,
      { ...userOpts, tools: ['claude-code'] },
      makeDeps(),
    );
    expect(result.ok).toBeFalse();
    if (result.ok) throw new Error('expected sweep failure');
    expect(result.error.code).toBe('flip-failed');
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(JSON.stringify(result)).toContain('[REDACTED]');
  });

  test('fails closed on hostile transport envelopes, accessors, and scanned values', async () => {
    const canary = 'ghp_P17_SECRET_CANARY_123456789';
    let getterReads = 0;
    let proxyReads = 0;
    const fetchValue: Record<string, unknown> = {};
    Object.defineProperty(fetchValue, 'sha', {
      enumerable: true,
      get: () => {
        getterReads++;
        return canary;
      },
    });
    const hostileProxy = new Proxy(
      { ok: true, value: { sha: canary } },
      {
        ownKeys: () => {
          proxyReads++;
          return ['ok', 'value'];
        },
      },
    );
    const candidate: Record<string, unknown> = { name: 'review' };
    Object.defineProperty(candidate, 'path', {
      enumerable: true,
      get: () => {
        getterReads++;
        return `skills/${canary}`;
      },
    });

    const cases: readonly Partial<InstallDeps['transport']>[] = [
      {
        fetchRepo: async () =>
          ({ ok: true, value: fetchValue }) as Awaited<
            ReturnType<NonNullable<InstallDeps['transport']>['fetchRepo']>
          >,
      },
      {
        fetchRepo: async () =>
          hostileProxy as Awaited<ReturnType<NonNullable<InstallDeps['transport']>['fetchRepo']>>,
      },
      {
        fetchRepo: async () =>
          ({
            ok: true,
            value: { sha: fixture.multiHead, raw: `access_token=${canary}` },
          }) as Awaited<ReturnType<NonNullable<InstallDeps['transport']>['fetchRepo']>>,
      },
      {
        listSkills: async () =>
          ({ ok: true, value: { candidates: [candidate], scanned: 1 } }) as unknown as Awaited<
            ReturnType<NonNullable<InstallDeps['transport']>['listSkills']>
          >,
      },
      {
        listSkills: async () =>
          ({ ok: true, value: { candidates: [], scanned: canary } }) as unknown as Awaited<
            ReturnType<NonNullable<InstallDeps['transport']>['listSkills']>
          >,
      },
      {
        listSkills: async () => ok({ candidates: [], scanned: 1 }),
      },
      {
        materializeSkill: async () =>
          ({ ok: true, value: '[REDACTED]' }) as Awaited<
            ReturnType<NonNullable<InstallDeps['transport']>['materializeSkill']>
          >,
      },
    ];

    for (const transportCase of cases) {
      const result = await runInstall(
        f.env,
        userOpts,
        makeDeps({ transport: { ...fixture.transport, ...transportCase } }),
      );
      if (!result.ok) throw new Error(msg(result.error));
      expect(result.value.results[0]?.action).toBe('failed');
      expect(JSON.stringify(result.value)).not.toContain(canary);
    }
    expect(getterReads).toBe(0);
    expect(proxyReads).toBe(0);
  });

  test('resolves and verifies once before artifact refusal, without sweep or mutation', async () => {
    const file = join(f.base, 'invalid-skillsmith.toml');
    await f.env.writeTextFile(file, 'not valid toml = [');
    const events: string[] = [];
    const writes: string[] = [];
    let fetchCleanups = 0;
    const staging = join(f.data, 'store', '.staging');
    const fetchRoot = join(f.data, '.fetch');
    const ledgerPath = ledgerPathOf(f.data);
    const executionEnv: RuntimePorts = {
      ...f.env,
      pathKind: async (path) => {
        if (path === ledgerPath) events.push('ledger');
        if (path === staging) events.push('sweep-staging');
        if (path === fetchRoot) events.push('sweep-fetch');
        return f.env.pathKind(path);
      },
      readText: async (path) => {
        if (path === file) events.push('artifact');
        return f.env.readText(path);
      },
      writeTextFile: async (path, text) => {
        if (!path.includes('/.fetch/')) writes.push(path);
        return f.env.writeTextFile(path, text);
      },
      makeSymlink: async (target, path) => {
        writes.push(path);
        return f.env.makeSymlink(target, path);
      },
      copyTree: async (from, to) => {
        writes.push(to);
        return f.env.copyTree(from, to);
      },
      removeTree: async (path) => {
        if (path.startsWith(`${fetchRoot}/`)) fetchCleanups++;
        return f.env.removeTree(path);
      },
    };
    const baseMaterialize = fixture.transport.materializeSkill;
    const result = await runInstall(
      executionEnv,
      { ...userOpts, tools: ['claude-code'], file },
      makeDeps({
        transport: {
          ...fixture.transport,
          materializeSkill: async (...args) => {
            const materialized = await baseMaterialize(...args);
            events.push('materialize');
            return materialized;
          },
        },
        verify: async (...args) => {
          events.push('verify');
          return passVerify(...args);
        },
      }),
    );
    if (!result.ok) throw new Error(msg(result.error));
    expect(events).toEqual(['ledger', 'materialize', 'verify', 'artifact']);
    expect(result.value.results.map(({ action }) => action)).toEqual(['refused']);
    expect(result.value.results[0]?.error?.code).toBe('config-error');
    expect(result.value.plan.operations).toHaveLength(0);
    expect(writes).toEqual([]);
    expect(fetchCleanups).toBe(1);
    expect(await fetchDirs()).toEqual([]);
    expect(await f.env.pathKind(join(claudeRoot(), 'factor-scan'))).toBe('absent');
  });

  test('an abort after verification stops before sweep, recovery, snapshot, or mutation', async () => {
    const controller = new AbortController();
    const fetchRoot = join(f.data, '.fetch');
    let sweeps = 0;
    let fetchCleanups = 0;
    const executionEnv: RuntimePorts = {
      ...f.env,
      pathKind: async (path) => {
        if (path === fetchRoot || path === join(f.data, 'store', '.staging')) sweeps++;
        return f.env.pathKind(path);
      },
      removeTree: async (path) => {
        if (path.startsWith(`${fetchRoot}/`)) fetchCleanups++;
        return f.env.removeTree(path);
      },
    };
    const result = await runInstall(
      executionEnv,
      {
        ...userOpts,
        tools: ['claude-code'],
        noSave: true,
        signal: controller.signal,
      },
      makeDeps({
        verify: async (...args) => {
          const verified = await passVerify(...args);
          controller.abort();
          return verified;
        },
      }),
    );
    if (!result.ok) throw new Error(msg(result.error));
    expect(result.value.results).toMatchObject([{ action: 'skipped', reason: 'interrupted' }]);
    expect(result.value.plan.operations).toHaveLength(0);
    expect({ sweeps, fetchCleanups }).toEqual({ sweeps: 0, fetchCleanups: 1 });
    expect(await f.env.pathKind(ledgerPathOf(f.data))).toBe('absent');
    expect(await f.env.pathKind(join(claudeRoot(), 'factor-scan'))).toBe('absent');
    expect(await fetchDirs()).toEqual([]);
  });

  test('duplicate resolved names refuse before artifact discovery, sweep, or mutation', async () => {
    const file = join(f.base, 'must-not-be-read.toml');
    let artifactReads = 0;
    let materializations = 0;
    let sweeps = 0;
    let ledgerReads = 0;
    let fetchCleanups = 0;
    const writes: string[] = [];
    const executionEnv: RuntimePorts = {
      ...f.env,
      pathKind: async (path) => {
        if (path === ledgerPathOf(f.data)) ledgerReads++;
        if (path === file) artifactReads++;
        if (path === join(f.data, '.fetch') || path === join(f.data, 'store', '.staging')) sweeps++;
        return f.env.pathKind(path);
      },
      readText: async (path) => {
        if (path === file) artifactReads++;
        return f.env.readText(path);
      },
      writeTextFile: async (path, text) => {
        if (!path.includes('/.fetch/')) writes.push(path);
        return f.env.writeTextFile(path, text);
      },
      removeTree: async (path) => {
        if (path.startsWith(`${join(f.data, '.fetch')}/`)) fetchCleanups++;
        return f.env.removeTree(path);
      },
    };
    const baseMaterialize = fixture.transport.materializeSkill;
    const result = await runInstall(
      executionEnv,
      { ...userOpts, sources: [fsSource, fsSource], tools: ['claude-code'], file, force: true },
      makeDeps({
        transport: {
          ...fixture.transport,
          materializeSkill: async (...args) => {
            const materialized = await baseMaterialize(...args);
            if (materialized.ok) materializations++;
            return materialized;
          },
        },
      }),
    );
    if (!result.ok) throw new Error(msg(result.error));
    expect(result.value.requested.sources).toEqual([fsLabel, fsLabel]);
    expect(result.value.results.map(({ requestIndex, action }) => [requestIndex, action])).toEqual([
      [0, 'refused'],
      [1, 'refused'],
    ]);
    expect({ artifactReads, materializations, sweeps, ledgerReads, writes }).toEqual({
      artifactReads: 0,
      materializations: 2,
      sweeps: 0,
      ledgerReads: 1,
      writes: [],
    });
    expect(result.value.plan.operations).toHaveLength(0);
    expect(result.value.results.every(({ error }) => error?.code === 'flip-refused')).toBeTrue();
    expect(fetchCleanups).toBe(2);
    expect(await f.env.pathKind(ledgerPathOf(f.data))).toBe('absent');
    expect(await fetchDirs()).toEqual([]);
  });

  test('no-save duplicate occurrences preserve stable request identity', async () => {
    const result = await runInstall(
      f.env,
      { ...userOpts, sources: [fsSource, fsSource], noSave: true, dryRun: true },
      makeDeps(),
    );
    if (!result.ok) throw new Error(msg(result.error));
    expect(result.value.requested.sources).toEqual([fsLabel, fsLabel]);
    expect(result.value.results.map(({ requestIndex }) => requestIndex)).toEqual([0, 0, 1, 1]);
    expect(result.value.results.every(({ source }) => source === fsLabel)).toBeTrue();
    expect(result.value.plan.operations).toHaveLength(2);
  });

  test('threads an exact explicit non-sibling artifact pair into snapshot observation', async () => {
    const file = join(f.base, 'portable', 'team.toml');
    const lockfile = join(f.base, 'locks', 'team.state.lock');
    const sibling = join(f.base, 'portable', 'team.lock');
    await f.env.makeDir(join(f.base, 'portable'));
    await f.env.makeDir(join(f.base, 'locks'));
    const observations = { file: 0, lockfile: 0, sibling: 0 };
    const count = (path: string, snapshotOnly: boolean): void => {
      if (snapshotOnly && path === file) observations.file++;
      if (snapshotOnly && path === lockfile) observations.lockfile++;
      if (path === sibling) observations.sibling++;
    };
    const env: RuntimePorts = {
      ...f.env,
      pathKind: async (path) => {
        count(path, false);
        return f.env.pathKind(path);
      },
      realpath: async (path) => {
        count(path, false);
        return f.env.realpath(path);
      },
      readBytes: async (path) => {
        count(path, true);
        return f.env.readBytes(path);
      },
      readFileMetadata: async (path) => {
        count(path, true);
        return f.env.readFileMetadata(path);
      },
    };
    const result = await runInstall(
      env,
      { ...userOpts, tools: ['claude-code'], file, lockfile, dryRun: true },
      makeDeps(),
    );
    if (!result.ok) throw new Error(msg(result.error));
    expect(result.value.results[0]?.action).toBe('installed');
    expect(observations.file).toBeGreaterThan(0);
    expect(observations.lockfile).toBeGreaterThan(0);
    expect(observations.sibling).toBe(0);
  });

  test('no-save performs no portable artifact I/O for the whole install invocation', async () => {
    const file = join(f.base, 'portable', 'must-not-read.toml');
    const lockfile = join(f.base, 'locks', 'must-not-read.lock');
    const artifactPaths = new Set([
      file,
      lockfile,
      join(f.env.xdg.config, 'skillsmith', 'skillsmith.toml'),
      join(f.env.xdg.config, 'skillsmith', 'skillsmith.lock'),
      join(f.base, 'skillsmith.toml'),
      join(f.base, 'skillsmith.lock'),
      join(f.project, 'skillsmith.toml'),
      join(f.project, 'skillsmith.lock'),
    ]);
    let artifactReads = 0;
    const count = (path: string): void => {
      if (artifactPaths.has(path)) artifactReads++;
    };
    const env: RuntimePorts = {
      ...f.env,
      pathKind: async (path) => {
        count(path);
        return f.env.pathKind(path);
      },
      readText: async (path) => {
        count(path);
        return f.env.readText(path);
      },
      realpath: async (path) => {
        count(path);
        return f.env.realpath(path);
      },
      readBytes: async (path) => {
        count(path);
        return f.env.readBytes(path);
      },
      readFileMetadata: async (path) => {
        count(path);
        return f.env.readFileMetadata(path);
      },
    };
    const result = await runInstall(
      env,
      { ...userOpts, tools: ['claude-code'], file, lockfile, noSave: true, dryRun: true },
      makeDeps(),
    );
    if (!result.ok) throw new Error(msg(result.error));
    expect(result.value.results[0]?.action).toBe('installed');
    expect(artifactReads).toBe(0);
  });

  for (const driftOccurrence of [0, 1] as const) {
    test(`no-save duplicate occurrence ${driftOccurrence} binds its exact materialized path`, async () => {
      const materialized: string[] = [];
      let prepared = false;
      const targetWrites: string[] = [];
      const baseMaterialize = fixture.transport.materializeSkill;
      const executionEnv: RuntimePorts = {
        ...f.env,
        readBytes: async (path) => {
          const bytes = await f.env.readBytes(path);
          if (
            prepared &&
            materialized[driftOccurrence] !== undefined &&
            path === join(materialized[driftOccurrence], 'SKILL.md')
          ) {
            return new TextEncoder().encode(`${new TextDecoder().decode(bytes)}\ndrift\n`);
          }
          return bytes;
        },
        writeTextFile: async (path, text) => {
          if (prepared && !path.includes('/.fetch/')) targetWrites.push(`write:${path}`);
          return f.env.writeTextFile(path, text);
        },
        makeSymlink: async (target, path) => {
          if (prepared) targetWrites.push(`symlink:${path}`);
          return f.env.makeSymlink(target, path);
        },
        rename: async (from, to) => {
          if (prepared && !from.includes('/.fetch/')) targetWrites.push(`rename:${from}->${to}`);
          return f.env.rename(from, to);
        },
        copyTree: async (from, to) => {
          if (prepared) targetWrites.push(`copy:${from}->${to}`);
          return f.env.copyTree(from, to);
        },
      };
      const result = await runInstall(
        executionEnv,
        {
          ...userOpts,
          sources: [fsSource, fsSource],
          tools: ['claude-code'],
          noSave: true,
        },
        makeDeps({
          transport: {
            ...fixture.transport,
            materializeSkill: async (env, fetchDir, skillPath, signal) => {
              const resolved = await baseMaterialize(env, fetchDir, skillPath, signal);
              if (resolved.ok) materialized.push(resolved.value);
              return resolved;
            },
          },
          observePreparedPlan: () => {
            prepared = true;
          },
        }),
      );
      if (!result.ok) throw new Error(msg(result.error));
      expect(new Set(materialized).size).toBe(2);
      expect(result.value.results.map(({ action }) => action)).toEqual(['refused', 'refused']);
      expect(targetWrites).toEqual([]);
      expect(await f.env.pathKind(join(claudeRoot(), 'factor-scan'))).toBe('absent');
    });
  }
});

describe('runInstall — fetch elision', () => {
  test('re-install of a stored SHA succeeds offline (fetch forbidden)', async () => {
    const shaSource = `${fixture.multiSource}//plugins/fh/skills/factor-scan@${fixture.multiTagSha}`;
    // seed: install online at the tag SHA
    const seed = await runInstall(
      f.env,
      { sources: [shaSource], cwd: f.base, configuration: f.configuration },
      makeDeps(),
    );
    if (!seed.ok) throw new Error(msg(seed.error));

    // uninstall-shaped removal of the placement dirs (leave the ledger + store intact)
    await f.env.removeTree(join(claudeRoot(), 'factor-scan'));
    await f.env.removeTree(join(agentsRoot(), 'factor-scan'));

    // fetch-forbidding env: any git 'fetch' fails hard
    const noFetch: RuntimePorts = {
      ...f.env,
      exec: async (cmd, args, opts): Promise<ExecResult> => {
        if (args.includes('fetch')) {
          return { code: 128, stdout: '', stderr: 'fetch forbidden by test', timedOut: false };
        }
        return f.env.exec(cmd, args, opts);
      },
    };

    const r = await runInstall(
      noFetch,
      { sources: [shaSource], cwd: f.base, configuration: f.configuration },
      makeDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results.every((x) => x.action === 'installed' || x.action === 'updated')).toBe(
      true,
    );
    expect(await f.env.pathKind(join(claudeRoot(), 'factor-scan'))).not.toBe('absent');
    const cc = r.value.results.find((x) => x.tool === 'claude-code');
    expect(cc?.store?.reused).toBe(true);
  });
});

describe('runInstall — unresolved journal (Global Constraint #6)', () => {
  test('same-op install re-run RESUMES the interrupted install to completion (not refused)', async () => {
    const r1 = await runInstall(
      f.env,
      { sources: [fsSource], tools: ['claude-code'], cwd: f.base, configuration: f.configuration },
      makeDeps(),
    );
    if (!r1.ok) throw new Error(msg(r1.error));
    const live = join(claudeRoot(), 'factor-scan');
    expect(await f.env.pathKind(live)).toBe('symlink'); // materialized store symlink

    // Plant an uncommitted install journal at phase 'live' (crashed just before the terminal write):
    // the placement is already published; resume must only commit (null the journal).
    const ledger = await led();
    const pair = getPairAt(ledger, null, 'factor-scan', 'claude-code');
    if (!pair) throw new Error('expected a seeded pair');
    const journal: Journal = {
      op: 'install',
      txId: 'deadbeef',
      phase: 'live',
      startedAt: NOW,
      completedAt: null,
      before: { mode: 'absent' },
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

    const r2 = await runInstall(
      f.env,
      { sources: [fsSource], tools: ['claude-code'], cwd: f.base, configuration: f.configuration },
      makeDeps(),
    );
    if (!r2.ok) throw new Error(msg(r2.error));
    const res = r2.value.results.find((x) => x.tool === 'claude-code');
    expect(res?.action).toBe('installed'); // RESUMED to completion, NOT refused
    expect(res?.error).toBeUndefined();

    const after = await led();
    expect(getPairAt(after, null, 'factor-scan', 'claude-code')?.journal).toBeNull();
    expect(await f.env.pathKind(live)).toBe('symlink');
  });

  test('a DIFFERENT interrupted op (promote) → refused, naming the JOURNAL op, not install', async () => {
    const r1 = await runInstall(
      f.env,
      { sources: [fsSource], tools: ['claude-code'], cwd: f.base, configuration: f.configuration },
      makeDeps(),
    );
    if (!r1.ok) throw new Error(msg(r1.error));

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

    const r2 = await runInstall(
      f.env,
      { sources: [fsSource], tools: ['claude-code'], cwd: f.base, configuration: f.configuration },
      makeDeps(),
    );
    if (!r2.ok) throw new Error(msg(r2.error));
    const res = r2.value.results.find((x) => x.tool === 'claude-code');
    expect(res?.action).toBe('refused');
    expect(res?.error?.code).toBe('flip-refused'); // exit-2 contribution
    const reason = res?.reason ?? '';
    expect(reason).toContain('promote --rollback'); // names the JOURNAL's op
    expect(reason).not.toContain('install --rollback');
    expect(reason).not.toContain("re-run 'skillsmith install"); // does not claim install completes it
  });
});

describe('runInstall — dry run', () => {
  test('prepares the exact immutable binding plan before mutation and reuses preview IDs', async () => {
    let previewPlan: Parameters<NonNullable<InstallDeps['observePreparedPlan']>>[0] | undefined;
    const preview = await runInstall(
      f.env,
      { ...userOpts, dryRun: true },
      makeDeps({
        observePreparedPlan: (plan) => {
          previewPlan = plan;
        },
      }),
    );
    if (!preview.ok) throw new Error(msg(preview.error));
    expect(previewPlan).toBe(preview.value.plan);
    expect(Object.isFrozen(previewPlan)).toBeTrue();
    expect(preview.value.executionResults).toEqual([]);
    for (const operation of preview.value.plan.operations) {
      expect(operation.preconditionIds).toHaveLength(10);
      expect(new Set(operation.preconditionIds).size).toBe(10);
      expect(
        operation.preconditionIds.every((id) => /^precondition:v1:[0-9a-f]{64}$/.test(id)),
      ).toBeTrue();
    }

    let executionPlan: typeof previewPlan;
    const invokedOperationIds = new Set<string>();
    const observeLiveMutation = (path: string): void => {
      if (
        path !== join(claudeRoot(), 'factor-scan') &&
        path !== join(agentsRoot(), 'factor-scan')
      ) {
        return;
      }
      expect(
        executionPlan,
        'the plan must exist before the first live placement mutation',
      ).toBeDefined();
      const operation = executionPlan?.operations.find(
        (candidate) =>
          candidate.after.kind === 'placement' &&
          candidate.after.resource.location.kind === 'machine-bound' &&
          candidate.after.resource.location.path === path,
      );
      expect(operation, `missing exact prepared binding for ${path}`).toBeDefined();
      if (operation) invokedOperationIds.add(operation.operationId);
    };
    const executionEnv: RuntimePorts = {
      ...f.env,
      makeSymlink: async (target, linkPath) => {
        observeLiveMutation(linkPath);
        await f.env.makeSymlink(target, linkPath);
      },
      rename: async (from, to) => {
        observeLiveMutation(to);
        await f.env.rename(from, to);
      },
    };
    const executed = await runInstall(
      executionEnv,
      userOpts,
      makeDeps({
        observePreparedPlan: (plan) => {
          executionPlan = plan;
        },
      }),
    );
    if (!executed.ok) throw new Error(msg(executed.error));
    expect(executionPlan).toBe(executed.value.plan);
    expect(executed.value.plan).toEqual(preview.value.plan);
    expect(executed.value.plan.operations.map(({ operationId }) => operationId)).toEqual(
      preview.value.plan.operations.map(({ operationId }) => operationId),
    );
    expect([...invokedOperationIds].sort()).toEqual(
      executed.value.plan.operations
        .filter(({ pairId }) => pairId !== null)
        .map(({ operationId }) => operationId)
        .sort(),
    );
    expect(executed.value.executionResults.map(({ operationId }) => operationId)).toEqual(
      executed.value.plan.operations.map(({ operationId }) => operationId),
    );
  });

  test('G3B-02: changed materialized source after preview refuses with zero target writes', async () => {
    const livePath = join(claudeRoot(), 'factor-scan');
    const ledgerPath = ledgerPathOf(f.data);
    const targetWrites: string[] = [];
    let prepared = false;
    const executionEnv: RuntimePorts = {
      ...f.env,
      readBytes: async (path) => {
        const bytes = await f.env.readBytes(path);
        if (prepared && path.includes(`${join(f.data, '.fetch')}/`) && path.endsWith('SKILL.md')) {
          return new TextEncoder().encode(`${new TextDecoder().decode(bytes)}\nsource drift\n`);
        }
        return bytes;
      },
      writeTextFile: async (path, text) => {
        if (prepared && path.startsWith(f.data) && !path.includes('/.fetch/')) {
          targetWrites.push(`write:${path}`);
        }
        await f.env.writeTextFile(path, text);
      },
      makeSymlink: async (target, linkPath) => {
        if (prepared) targetWrites.push(`symlink:${linkPath}`);
        await f.env.makeSymlink(target, linkPath);
      },
      rename: async (from, to) => {
        if (prepared && (to === livePath || to === ledgerPath)) {
          targetWrites.push(`rename:${from}->${to}`);
        }
        await f.env.rename(from, to);
      },
      copyTree: async (from, to) => {
        if (prepared && to === livePath) targetWrites.push(`copy:${from}->${to}`);
        await f.env.copyTree(from, to);
      },
    };
    const result = await runInstall(
      executionEnv,
      { ...userOpts, tools: ['claude-code'] },
      makeDeps({
        observePreparedPlan: () => {
          prepared = true;
        },
      }),
    );
    if (!result.ok) throw new Error(msg(result.error));

    expect(result.value.results[0]?.action).toBe('refused');
    expect(result.value.executionResults[0]?.outcome).toBe('failed');
    expect(targetWrites).toEqual([]);
    expect(await f.env.pathKind(livePath)).toBe('absent');
    expect(await f.env.pathKind(ledgerPath)).toBe('absent');
  });

  test('G3B-02: changed selected store after preview refuses without rewriting live or ledger', async () => {
    const seeded = await runInstall(f.env, { ...userOpts, tools: ['claude-code'] }, makeDeps());
    if (!seeded.ok) throw new Error(msg(seeded.error));
    const pair = getPairAt(await led(), null, 'factor-scan', 'claude-code');
    if (!pair?.pinned) throw new Error('expected seeded pinned pair');
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
    };
    const result = await runInstall(
      executionEnv,
      { ...userOpts, tools: ['claude-code'], force: true },
      makeDeps({
        observePreparedPlan: () => {
          writeFileSync(join(pair.pinned?.storePath as string, 'SKILL.md'), '# changed store\n');
          prepared = true;
        },
      }),
    );
    if (!result.ok) throw new Error(msg(result.error));

    expect(result.value.results[0]?.action).toBe('refused');
    expect(targetWrites).toEqual([]);
    expect(await readlink(livePath)).toBe(pair.pinned.storePath);
    expect(await f.env.readText(ledgerPath)).toBe(ledgerBefore);
  });

  test('G3B-04: final under-lock ledger revision refuses after an unrelated concurrent write', async () => {
    const ledgerPath = ledgerPathOf(f.data);
    let lockCount = 0;
    const concurrentPair = {
      placementPath: join(agentsRoot(), 'concurrent-skill'),
      mode: 'dev' as const,
      dev: {
        sourcePath: '/concurrent/source',
        resolvedPath: '/concurrent/source',
        repoRoot: '/concurrent',
        sourceRelPath: 'source',
        remote: null,
        recordedAt: NOW,
      },
    };
    const executionEnv: RuntimePorts = {
      ...f.env,
      withFileLock: (path, operation, options) =>
        f.env.withFileLock(
          path,
          async () => {
            lockCount += 1;
            if (lockCount === 2) {
              const concurrent = await readLedgerState(f.env, ledgerPath);
              if (!concurrent.ok) throw new Error(msg(concurrent.error));
              const next = withLedgerPairAt(
                ledgerModelForMutation(concurrent.value, NOW),
                null,
                'concurrent-skill',
                'codex',
                concurrentPair,
              );
              if (!next.ok) throw new Error(msg(next.error));
              const persisted = await writeLedger(f.env, ledgerPath, next.value);
              if (!persisted.ok) throw new Error(msg(persisted.error));
            }
            return operation();
          },
          options,
        ),
    };

    const result = await runInstall(
      executionEnv,
      { ...userOpts, tools: ['claude-code'] },
      makeDeps(),
    );
    if (!result.ok) throw new Error(msg(result.error));

    expect(lockCount).toBe(2);
    expect(result.value.results[0]?.action).toBe('refused');
    const finalLedger = await led();
    expect(getPairAt(finalLedger, null, 'concurrent-skill', 'codex')).toEqual(concurrentPair);
    expect(getPairAt(finalLedger, null, 'factor-scan', 'claude-code')).toBeNull();

    const retried = await runInstall(
      executionEnv,
      { ...userOpts, tools: ['claude-code'] },
      makeDeps(),
    );
    if (!retried.ok) throw new Error(msg(retried.error));
    expect(retried.value.results[0]?.action).toBe('installed');
    expect(retried.value.plan).not.toEqual(result.value.plan);
    const retriedLedger = await led();
    expect(getPairAt(retriedLedger, null, 'concurrent-skill', 'codex')).toEqual(concurrentPair);
    expect(getPairAt(retriedLedger, null, 'factor-scan', 'claude-code')).not.toBeNull();
  });

  test('G3B-02: started swap and recovery cancellation stay cancelled and recoverable', async () => {
    const ledgerPath = ledgerPathOf(f.data);
    const livePath = join(claudeRoot(), 'factor-scan');
    const runCancelledAt = async (phase: 'prepared' | 'staged') => {
      const controller = new AbortController();
      const executionEnv: RuntimePorts = {
        ...f.env,
        rename: async (from, to) => {
          await f.env.rename(from, to);
          if (to !== ledgerPath || controller.signal.aborted) return;
          const current = await readLedgerState(f.env, ledgerPath);
          if (!current.ok) throw new Error(msg(current.error));
          if (current.value.state !== 'present') return;
          const journal = getPairAt(
            current.value.model,
            null,
            'factor-scan',
            'claude-code',
          )?.journal;
          if (journal?.phase === phase) controller.abort();
        },
      };
      return runInstall(
        executionEnv,
        {
          ...userOpts,
          tools: ['claude-code'],
          signal: controller.signal,
        },
        makeDeps(),
      );
    };

    const started = await runCancelledAt('prepared');
    if (!started.ok) throw new Error(msg(started.error));
    expect(started.value.results[0]).toMatchObject({
      action: 'skipped',
      reason: 'interrupted',
      error: { code: 'cancelled' },
    });
    const startedPlacement = started.value.plan.operations.find(
      ({ kind, pairId }) => kind === 'install' && pairId !== null,
    );
    const startedExecution = started.value.executionResults.find(
      ({ operationId }) => operationId === startedPlacement?.operationId,
    );
    expect(startedExecution).toMatchObject({ outcome: 'cancelled' });
    expect(startedExecution?.actualAfter).toEqual(startedExecution?.actualBefore);
    expect(await f.env.pathKind(livePath)).toBe('absent');
    expect(getPairAt(await led(), null, 'factor-scan', 'claude-code')?.journal?.phase).toBe(
      'prepared',
    );

    const recovery = await runCancelledAt('staged');
    if (!recovery.ok) throw new Error(msg(recovery.error));
    expect(recovery.value.results[0]).toMatchObject({
      action: 'skipped',
      reason: 'interrupted',
      error: { code: 'cancelled' },
    });
    const recoveryPlacement = recovery.value.plan.operations.find(
      ({ kind, pairId }) => kind === 'install' && pairId !== null,
    );
    const recoveryExecution = recovery.value.executionResults.find(
      ({ operationId }) => operationId === recoveryPlacement?.operationId,
    );
    expect(recoveryExecution).toMatchObject({ outcome: 'cancelled' });
    expect(recoveryExecution?.actualAfter).toEqual(recoveryExecution?.actualBefore);
    expect(await f.env.pathKind(livePath)).toBe('absent');
    expect(getPairAt(await led(), null, 'factor-scan', 'claude-code')?.journal?.phase).toBe(
      'staged',
    );

    const completed = await runInstall(f.env, { ...userOpts, tools: ['claude-code'] }, makeDeps());
    if (!completed.ok) throw new Error(msg(completed.error));
    expect(completed.value.results[0]?.action).toBe('installed');
    expect(completed.value.executionResults[0]?.outcome).toBe('succeeded');
    expect(completed.value.executionResults[0]?.actualAfter).toEqual(
      completed.value.plan.operations[0]?.after,
    );
    expect(await f.env.pathKind(livePath)).toBe('symlink');
    expect(getPairAt(await led(), null, 'factor-scan', 'claude-code')?.journal).toBeNull();
  });

  test('no lock, no ledger write, fetch cleaned, actions predicted', async () => {
    const r = await runInstall(f.env, { ...userOpts, dryRun: true }, makeDeps());
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.dryRun).toBe(true);
    expect(r.value.results.every((x) => x.action === 'installed')).toBe(true);
    expect(r.value.plan).toMatchObject({
      domain: 'skillsmith.operation-plan',
      schemaVersion: 1,
      command: 'install',
    });
    expect(Object.isFrozen(r.value.plan)).toBe(true);
    expect(r.value.plan.operations.filter(({ pairId }) => pairId !== null)).toHaveLength(
      r.value.results.length,
    );
    const artifactKinds = r.value.plan.operations
      .filter(({ pairId }) => pairId === null)
      .map(({ kind }) => kind);
    const pairKinds = r.value.plan.operations
      .filter(({ pairId }) => pairId !== null)
      .map(({ kind }) => kind);
    expect(artifactKinds.length).toBeGreaterThan(0);
    expect(artifactKinds.at(-1)).toBe('write-lock');
    expect(pairKinds).toEqual(['install', 'install']);
    expect(r.value.executionResults).toEqual([]);
    // no placements, no ledger file, fetch cleaned
    expect(await f.env.pathKind(join(claudeRoot(), 'factor-scan'))).toBe('absent');
    expect(await f.env.pathKind(ledgerPathOf(f.data))).toBe('absent');
    expect(await fetchDirs()).toEqual([]);
  });

  test('supported v1 dry-run visibly prefixes migrate-ledger and preserves exact bytes', async () => {
    const ledgerPath = ledgerPathOf(f.data);
    const source = JSON.stringify({
      schemaVersion: 1,
      kind: 'skillsmith.placements',
      updatedAt: NOW,
      skills: {},
    });
    await f.env.writeTextFile(ledgerPath, source);
    let preparedKinds: readonly string[] = [];

    const result = await runInstall(
      f.env,
      { ...userOpts, tools: ['claude-code'], dryRun: true },
      makeDeps({
        observePreparedPlan: (plan) => {
          preparedKinds = plan.operations.map((operation) => operation.kind);
        },
      }),
    );
    if (!result.ok) throw new Error(msg(result.error));

    expect(preparedKinds[0]).toBe('migrate-ledger');
    expect(result.value.plan.operations[0]?.kind).toBe('migrate-ledger');
    const postMigration = result.value.plan.operations.slice(1);
    expect(postMigration.some(({ pairId }) => pairId === null)).toBe(true);
    expect(
      postMigration.filter(({ kind }) => kind === 'install').every(({ pairId }) => pairId !== null),
    ).toBe(true);
    expect(await f.env.readText(ledgerPath)).toBe(source);
  });

  test('supported v1 execution migrates before installing and commits both histories', async () => {
    const ledgerPath = ledgerPathOf(f.data);
    await f.env.writeTextFile(
      ledgerPath,
      JSON.stringify({
        schemaVersion: 1,
        kind: 'skillsmith.placements',
        updatedAt: NOW,
        skills: {},
      }),
    );
    const calls = { resolveRef: 0, fetchRepo: 0, listSkills: 0, materializeSkill: 0, verify: 0 };
    const transport: NonNullable<InstallDeps['transport']> = {
      resolveRef: async (...args) => {
        calls.resolveRef++;
        return fixture.transport.resolveRef(...args);
      },
      fetchRepo: async (...args) => {
        calls.fetchRepo++;
        return fixture.transport.fetchRepo(...args);
      },
      listSkills: async (...args) => {
        calls.listSkills++;
        return fixture.transport.listSkills(...args);
      },
      materializeSkill: async (...args) => {
        calls.materializeSkill++;
        return fixture.transport.materializeSkill(...args);
      },
    };

    const result = await runInstall(
      f.env,
      userOpts,
      makeDeps({
        transport,
        verify: async (...args) => {
          calls.verify++;
          return passVerify(...args);
        },
      }),
    );
    if (!result.ok) throw new Error(msg(result.error));
    expect(result.value.plan.operations[0]?.kind).toBe('migrate-ledger');
    expect(result.value.summary.installed).toBe(2);
    expect(calls).toEqual({
      resolveRef: 0,
      fetchRepo: 1,
      listSkills: 1,
      materializeSkill: 1,
      verify: 2,
    });

    const state = await readLedgerState(f.env, ledgerPath);
    if (!state.ok || state.value.state !== 'present') {
      throw new Error('expected migrated installed ledger');
    }
    expect(state.value.sourceVersion).toBe(2);
    expect(state.value.model.history.map((journal) => journal.intent.kind)).toEqual([
      'migrate-ledger',
      'install',
      'install',
    ]);
    expect(Object.keys(state.value.model.transactions)).toEqual([]);
  });

  test('supported v1 migration cancellation is a cancelled execution result, not an exception', async () => {
    const ledgerPath = ledgerPathOf(f.data);
    await f.env.writeTextFile(
      ledgerPath,
      JSON.stringify({
        schemaVersion: 1,
        kind: 'skillsmith.placements',
        updatedAt: NOW,
        skills: {},
      }),
    );
    const controller = new AbortController();
    const executionEnv = {
      ...f.env,
      afterLedgerBarrier: async (barrier: Readonly<{ kind: string }>) => {
        if (barrier.kind === 'recovery-pointer-prepared-write') controller.abort();
      },
    } as RuntimePorts;

    const result = await runInstall(
      executionEnv,
      { ...userOpts, tools: ['claude-code'], signal: controller.signal },
      makeDeps(),
    );
    if (!result.ok) throw new Error(msg(result.error));

    expect(result.value.executionResults[0]).toMatchObject({
      outcome: 'cancelled',
      actualAfter: result.value.plan.operations[0]?.before,
      error: null,
    });
    expect(
      result.value.executionResults.slice(1).every(({ outcome }) => outcome === 'cancelled'),
    ).toBe(true);
    expect(result.value.results.every(({ error }) => error?.code === 'cancelled')).toBe(true);
  });

  test('supported v1 migration uses the default explicit caller ports with caller identity', async () => {
    const ledgerPath = ledgerPathOf(f.data);
    await f.env.writeTextFile(
      ledgerPath,
      JSON.stringify({
        schemaVersion: 1,
        kind: 'skillsmith.placements',
        updatedAt: NOW,
        skills: {},
      }),
    );
    let metadataReads = 0;
    const executionEnv = {
      ...f.env,
      ledgerOperationIdentity: {
        operationId: 'operation:explicit-ledger-ports',
        transactionId: 'transaction:explicit-ledger-ports',
        sourceRevision: null,
        startedAt: NOW,
        attempt: 1,
      },
      readFileMetadata: async (path: string) => {
        metadataReads += 1;
        return f.env.readFileMetadata(path);
      },
    } as RuntimePorts;

    const result = await runInstall(
      executionEnv,
      { ...userOpts, tools: ['claude-code'] },
      makeDeps(),
    );
    if (!result.ok) throw new Error(msg(result.error));

    expect(result.value.executionResults[0]?.outcome).toBe('succeeded');
    expect(metadataReads).toBeGreaterThan(0);
  });

  test('supported v1 migration honors an explicit dedicated ledger-writer port composition', async () => {
    const ledgerPath = ledgerPathOf(f.data);
    await f.env.writeTextFile(
      ledgerPath,
      JSON.stringify({
        schemaVersion: 1,
        kind: 'skillsmith.placements',
        updatedAt: NOW,
        skills: {},
      }),
    );
    let callerMetadataReads = 0;
    let writerMetadataReads = 0;
    const executionEnv: RuntimePorts & { readonly ledgerWriterPorts: RuntimePorts } = {
      ...f.env,
      readFileMetadata: async (path) => {
        callerMetadataReads += 1;
        return f.env.readFileMetadata(path);
      },
      ledgerWriterPorts: {
        ...f.env,
        readFileMetadata: async (path) => {
          writerMetadataReads += 1;
          return f.env.readFileMetadata(path);
        },
      },
    };

    const result = await runInstall(
      executionEnv,
      { ...userOpts, tools: ['claude-code'] },
      makeDeps(),
    );
    if (!result.ok) throw new Error(msg(result.error));

    expect(result.value.executionResults[0]?.outcome).toBe('succeeded');
    expect(writerMetadataReads).toBeGreaterThan(0);
    expect(callerMetadataReads).toBe(0);
  });
});
