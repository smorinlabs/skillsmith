import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderUninstallHuman } from '../../../packages/cli/src/output/install-human.ts';
import { renderUninstallJson } from '../../../packages/cli/src/output/install-json.ts';
import { selectExitCode } from '../../../packages/cli/src/util/exit-codes.ts';
import {
  type AcquisitionSnapshotAuthorityV1,
  createAcquisitionRepositoryLifecycleControllerV1,
  resolveAcquisitionProjectContextV1,
} from '../../../packages/core/src/acquire/execute.ts';
import { runInstall, runUninstall } from '../../../packages/core/src/acquire/run.ts';
import type {
  InstallDeps,
  PlannedInstallReport,
  PlannedUninstallReport,
  UninstallDeps,
} from '../../../packages/core/src/acquire/types.ts';
import type { ArtifactDigest } from '../../../packages/core/src/artifacts/hash.ts';
import type { LogicalJournalV1Dto } from '../../../packages/core/src/artifacts/journal-types.ts';
import { toLedgerV2Dto } from '../../../packages/core/src/artifacts/ledger-codec.ts';
import { createTestNodeArtifactCoordinatorPorts } from '../../../packages/core/src/artifacts/node-coordinator.ts';
import { flipFailedError } from '../../../packages/core/src/errors.ts';
import { scheduleOperationPlan } from '../../../packages/core/src/execution/scheduler.ts';
import {
  emptyLedgerModel,
  getPairAt,
  readLedgerState,
  withLedgerPairAt,
  writeLedger,
} from '../../../packages/core/src/place/ledger.ts';
import { ledgerPathOf } from '../../../packages/core/src/place/paths.ts';
import { runPromote } from '../../../packages/core/src/place/run.ts';
import { contentHashOf } from '../../../packages/core/src/place/store.ts';
import type { FlipDeps, FlipTool } from '../../../packages/core/src/place/types.ts';
import {
  createOperationExecutionResult,
  createOperationGroupId,
  createOperationId,
  createOperationPairId,
} from '../../../packages/core/src/planning/create.ts';
import { orderExecutableOperationsTopologically } from '../../../packages/core/src/planning/order.ts';
import type { OperationExecutionResult } from '../../../packages/core/src/planning/types.ts';
import { err, ok } from '../../../packages/core/src/result.ts';
import { stageLogicalRepositoryEditV1 } from '../../../packages/core/src/state/repositories.ts';
import {
  type ExpectedRevisionV1,
  createExpectedRevisionV1,
} from '../../../packages/core/src/state/types.ts';
import { readStatus } from '../../../packages/core/src/status/read.ts';
import { VERIFIED_AGAINST, type VerifyReport } from '../../../packages/core/src/verify/types.ts';
import {
  type RemoteFixture,
  buildRemoteFixture,
  destroyRemoteFixture,
} from '../../../packages/core/tests/fixtures/acquire/remote.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../../../packages/core/tests/fixtures/place/fleet.ts';
import {
  COLLISION_CASES,
  CRASH_POINTS,
  FEATURE_FAMILIES,
  FIXTURE_CANARY,
  LOCK_HANDOFF_CASES,
  REQUIRED_COMPATIBILITY_SELECTORS,
  collisionPlan,
  lockSourceFor,
  manifestSource,
  rollingCollisionPlan,
} from '../fixtures/p4a-ts02/cases.ts';

setDefaultTimeout(30_000);

const CRASH_CHILD = join(import.meta.dir, '../fixtures/p4a-ts02/crash-child.ts');
const fleets: FixtureFleet[] = [];
let remote: RemoteFixture;

beforeAll(async () => {
  remote = await buildRemoteFixture();
});

afterAll(async () => {
  await destroyRemoteFixture(remote);
});

afterEach(async () => {
  await Promise.all(fleets.splice(0).map((fleet) => destroyFixtureFleet(fleet)));
});

const fleet = async (): Promise<FixtureFleet> => {
  const value = await buildFixtureFleet();
  fleets.push(value);
  return value;
};

const reportOf = (value: unknown): PlannedUninstallReport => value as PlannedUninstallReport;
const installReportOf = (value: unknown): PlannedInstallReport => value as PlannedInstallReport;

const depsFor = async (selected: FixtureFleet, label: string): Promise<UninstallDeps> => {
  const coordinator = await createTestNodeArtifactCoordinatorPorts(
    join(selected.base, `coordination-${label}`),
  );
  let index = 0;
  return {
    artifactCoordinator: coordinator,
    now: () => '2026-07-18T00:00:00.000Z',
    newTxId: () => (0x7000000000000000n + BigInt(index++)).toString(16),
  };
};

const verificationReport = (tool: FlipTool): VerifyReport => ({
  schemaVersion: 1,
  target: { path: '/fixture/skill', kind: 'skill' },
  requested: {
    tools: [tool],
    modes: ['static'],
    strict: false,
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
});

const installDepsFor = async (
  selected: FixtureFleet,
  label: string,
  verify: InstallDeps['verify'] = async (_env, options) =>
    ok(verificationReport((options.tools?.[0] ?? 'claude-code') as FlipTool)),
): Promise<InstallDeps> => {
  const coordinator = await createTestNodeArtifactCoordinatorPorts(
    join(selected.base, `install-coordination-${label}`),
  );
  let index = 0;
  return {
    verify,
    detect: async (_env, tool) =>
      ok([{ path: `/fixture/bin/${tool}`, version: '1.0.0', installMethod: 'unknown' }]),
    transport: remote.transport,
    artifactCoordinator: coordinator,
    now: () => '2026-07-18T00:00:00.000Z',
    newTxId: () => (0x7100000000000000n + BigInt(index++)).toString(16),
  };
};

const factorSource = (): string => `${remote.multiSource}//plugins/fh/skills/factor-scan`;

const flipDepsFor = (failedTool: FlipTool | null): FlipDeps => {
  let index = 0;
  return {
    verify: async (_env, options) => {
      const tool = (options.tools?.[0] ?? 'claude-code') as FlipTool;
      return tool === failedTool
        ? err(flipFailedError(`synthetic ${tool} promote verification failure`))
        : ok(verificationReport(tool));
    },
    now: () => '2026-07-18T00:00:00.000Z',
    newTxId: () => (0x7200000000000000n + BigInt(index++)).toString(16),
  };
};

const readPair = async (root: string) =>
  Promise.all([
    readFile(join(root, 'skillsmith.toml'), 'utf8'),
    readFile(join(root, 'skillsmith.lock'), 'utf8'),
  ]);

const placementPathFor = (selected: FixtureFleet, tool: FlipTool, skill: string): string =>
  join(
    selected.home,
    tool === 'claude-code' ? '.claude' : tool === 'codex' ? '.agents' : '.opencode',
    'skills',
    skill,
  );

const seedManagedPairs = async (
  selected: FixtureFleet,
  skill: string,
  tools: readonly FlipTool[],
): Promise<`sha256:${string}`> => {
  const storePath = join(selected.data, 'store', 'p4a-ts02', skill);
  await mkdir(join(selected.data, 'store', 'p4a-ts02'), { recursive: true });
  await selected.env.copyTree(selected.alphaSrc, storePath);
  const hashed = await contentHashOf(selected.env, storePath);
  if (!hashed.ok || !hashed.value.startsWith('sha256:')) {
    throw new Error('failed to hash the TS02 managed-pair store fixture');
  }
  let model = emptyLedgerModel('2026-07-18T00:00:00.000Z');
  for (const tool of tools) {
    const placementPath = placementPathFor(selected, tool, skill);
    await selected.env.makeSymlink(storePath, placementPath);
    const next = withLedgerPairAt(model, null, skill, tool, {
      placementPath,
      mode: 'pinned',
      dev: null,
      pinned: {
        storePath,
        rev: selected.headSha.slice(0, 12),
        gitSha: selected.headSha,
        dirty: false,
        contentHash: hashed.value,
        snapshotAt: '2026-07-18T00:00:00.000Z',
        verify: 'passed',
        placement: 'symlink',
      },
      origin: {
        source: `fixture.invalid/acme/skills//skills/${skill}`,
        host: 'fixture.invalid',
        repo: 'acme/skills',
        skillPath: `skills/${skill}`,
        refRequested: null,
        refResolved: selected.headSha,
        pin: false,
        installedAt: '2026-07-18T00:00:00.000Z',
      },
      journal: null,
    });
    if (!next.ok) throw new Error('failed to seed the TS02 managed pair');
    model = next.value;
  }
  const persisted = await writeLedger(selected.env, ledgerPathOf(selected.data), model);
  if (!persisted.ok) throw new Error('failed to persist the TS02 managed pair');
  return hashed.value as `sha256:${string}`;
};

const commitManagedRemoval = async (
  selected: FixtureFleet,
  skill: string,
  tools: readonly FlipTool[],
): Promise<PlannedUninstallReport> => {
  const result = await runUninstall(
    selected.env,
    {
      targets: [skill],
      tools,
      scope: 'user',
      noSave: true,
      cwd: selected.base,
      configuration: selected.configuration,
    },
    await depsFor(selected, `seed-removal-${skill}-${tools.join('-')}`),
  );
  if (!result.ok)
    throw new Error('message' in result.error ? result.error.message : result.error.code);
  return reportOf(result.value);
};

const readLedgerModel = async (selected: FixtureFleet) => {
  const state = await readLedgerState(selected.env, ledgerPathOf(selected.data));
  if (!state.ok || state.value.state !== 'present') {
    throw new Error('missing TS02 ledger authority');
  }
  return state.value.model;
};

const persistLedgerModel = async (
  selected: FixtureFleet,
  model: Awaited<ReturnType<typeof readLedgerModel>>,
): Promise<void> => {
  const validated = toLedgerV2Dto(model);
  if (!validated.ok) {
    throw new Error(`invalid TS02 ledger rewrite: ${JSON.stringify(validated.error)}`);
  }
  const persisted = await writeLedger(selected.env, ledgerPathOf(selected.data), model);
  if (!persisted.ok) throw new Error('failed to rewrite the TS02 ledger authority');
};

const declarationWithTools = (tools: readonly FlipTool[]): string => {
  const source = manifestSource(['portable-alpha', 'retained-gamma']);
  return source.replace(
    'tools = ["claude-code"]\nscope = "user"\nplacement = "symlink"',
    `tools = [${tools.map((tool) => `"${tool}"`).join(', ')}]\nscope = "user"\nplacement = "symlink"`,
  );
};

const projectDeclarationWithTools = (tools: readonly FlipTool[]): string =>
  declarationWithTools(tools).replaceAll('scope = "user"', 'scope = "project"');

const prepareReducedHandoff = async (selected: FixtureFleet, root: string) => {
  const contentHash = await seedManagedPairs(selected, 'portable-alpha', ['claude-code', 'codex']);
  await commitManagedRemoval(selected, 'portable-alpha', ['claude-code']);
  await mkdir(root, { recursive: true });
  const beforeManifest = declarationWithTools(['claude-code', 'codex']);
  const afterManifest = beforeManifest.replace(
    'tools = ["claude-code", "codex"]',
    'tools = ["codex"]',
  );
  const beforeLock = lockSourceFor(beforeManifest, selected.headSha, contentHash);
  const afterLock = lockSourceFor(afterManifest, selected.headSha, contentHash);
  await Promise.all([
    writeFile(join(root, 'skillsmith.toml'), afterManifest),
    writeFile(join(root, 'skillsmith.lock'), beforeLock),
  ]);
  return { beforeManifest, afterManifest, beforeLock, afterLock };
};

const countingExternalEnv = (selected: FixtureFleet) => {
  const calls: string[] = [];
  const env = {
    ...selected.env,
    git: {
      findRepositoryRoot: async (
        ...args: Parameters<typeof selected.env.git.findRepositoryRoot>
      ) => {
        calls.push('git.findRepositoryRoot');
        return selected.env.git.findRepositoryRoot(...args);
      },
      inspectWorktree: async (...args: Parameters<typeof selected.env.git.inspectWorktree>) => {
        calls.push('git.inspectWorktree');
        return selected.env.git.inspectWorktree(...args);
      },
      resolveRemoteRef: async (...args: Parameters<typeof selected.env.git.resolveRemoteRef>) => {
        calls.push('git.resolveRemoteRef');
        return selected.env.git.resolveRemoteRef(...args);
      },
      initializeFetch: async (...args: Parameters<typeof selected.env.git.initializeFetch>) => {
        calls.push('git.initializeFetch');
        return selected.env.git.initializeFetch(...args);
      },
      fetchRef: async (...args: Parameters<typeof selected.env.git.fetchRef>) => {
        calls.push('git.fetchRef');
        return selected.env.git.fetchRef(...args);
      },
      listTree: async (...args: Parameters<typeof selected.env.git.listTree>) => {
        calls.push('git.listTree');
        return selected.env.git.listTree(...args);
      },
      readBlob: async (...args: Parameters<typeof selected.env.git.readBlob>) => {
        calls.push('git.readBlob');
        return selected.env.git.readBlob(...args);
      },
      materializeTree: async (...args: Parameters<typeof selected.env.git.materializeTree>) => {
        calls.push('git.materializeTree');
        return selected.env.git.materializeTree(...args);
      },
    },
    http: {
      request: async (...args: Parameters<typeof selected.env.http.request>) => {
        calls.push('http.request');
        return selected.env.http.request(...args);
      },
    },
  };
  return { calls, env };
};

const freshStatus = async (
  selected: FixtureFleet,
  root: string,
  target: string,
  tools: readonly FlipTool[],
) => {
  const projectContext = await resolveAcquisitionProjectContextV1({
    env: selected.env,
    cwd: root,
    ...(selected.configuration.explicitConfigPath === undefined
      ? {}
      : { explicitConfigPath: selected.configuration.explicitConfigPath }),
  });
  const projectPlacement =
    projectContext.projectRoot === null || projectContext.projectIdentity === null
      ? ({ state: 'unselected' } as const)
      : ({
          state: 'selected',
          source: 'shared-project',
          canonicalCwd: await selected.env.realpath(projectContext.effectiveCwd),
          root: projectContext.projectRoot,
          identity: projectContext.projectIdentity,
        } as const);
  const status = await readStatus(selected.env, {
    projectContext,
    projectPlacement,
    configuration: selected.configuration,
    targets: [target],
    tools,
    toolSelectionSource: 'explicit',
    scopes: ['user'],
    scopeSelectionSource: 'explicit',
    selectionSource: 'explicit-targets',
    artifactSelection: {
      state: 'selected',
      source: 'explicit',
      manifestPath: join(root, 'skillsmith.toml'),
      lockPath: join(root, 'skillsmith.lock'),
      lockSource: 'explicit',
    },
  });
  if (!status.ok) throw new Error(status.error.message);
  return status.value;
};

const prepareFinalHandoff = async (
  selected: FixtureFleet,
  tools: readonly FlipTool[] = ['claude-code'],
) => {
  const contentHash = await seedManagedPairs(selected, 'portable-alpha', tools);
  await commitManagedRemoval(selected, 'portable-alpha', tools);
  const root = join(selected.base, `final-handoff-${tools.join('-')}`);
  await mkdir(root, { recursive: true });
  const beforeManifest = declarationWithTools(tools);
  const beforeLock = lockSourceFor(beforeManifest, selected.headSha, contentHash);
  const afterManifest = manifestSource(['retained-gamma']);
  const afterLock = lockSourceFor(afterManifest, selected.headSha, contentHash);
  await Promise.all([
    writeFile(join(root, 'skillsmith.toml'), afterManifest),
    writeFile(join(root, 'skillsmith.lock'), beforeLock),
  ]);
  return { root, beforeManifest, beforeLock, afterManifest, afterLock };
};

const supersedingInstallJournal = (removal: LogicalJournalV1Dto): LogicalJournalV1Dto => {
  const placement = removal.intent.before;
  if (placement.kind !== 'placement' || placement.source?.kind !== 'portable') {
    throw new Error('supersession fixture requires a portable removal before-image');
  }
  const source = placement.source;
  const resource = placement.resource;
  const groupId = createOperationGroupId({
    domain: 'skillsmith.operation-group-identity',
    schemaVersion: 1,
    command: 'install',
    skill: removal.intent.skill,
    source,
    scope: removal.intent.scope,
    target: null,
  });
  const pairId = createOperationPairId({
    domain: 'skillsmith.operation-pair-identity',
    schemaVersion: 1,
    groupId,
    tool: removal.intent.tool,
    resource,
  });
  const operationId = createOperationId({
    domain: 'skillsmith.operation-identity',
    schemaVersion: 1,
    groupId,
    pairId,
    kind: 'install',
    skill: removal.intent.skill,
    source,
    tool: removal.intent.tool,
    scope: removal.intent.scope,
  });
  const liveBefore = removal.actual.after.find(({ role }) => role === 'live');
  const liveAfter = removal.actual.before.find(({ role }) => role === 'live');
  const ledgerBefore = removal.actual.after.find(({ role }) => role === 'ledger');
  const ledgerAfter = removal.actual.before.find(({ role }) => role === 'ledger');
  if (
    liveBefore === undefined ||
    liveAfter === undefined ||
    ledgerBefore === undefined ||
    ledgerAfter === undefined
  ) {
    throw new Error('supersession fixture requires exact live and ledger actuals');
  }
  return {
    ...removal,
    transactionId: 'transaction:p4a-ts02-superseding-install',
    intent: {
      operationId,
      groupId,
      pairId,
      kind: 'install',
      skill: removal.intent.skill,
      source,
      tool: removal.intent.tool,
      scope: removal.intent.scope,
      before: { kind: 'absent', resource },
      after: { ...placement, classification: 'pinned' },
      mutates: { live: true, manifest: false, lock: false, ledger: true },
      reversibility: { kind: 'none', retentionResourceIds: [] },
      conflict: null,
    },
    context: {
      ...removal.context,
      parentOperationId: operationId,
      command: 'skillsmith-place',
      workflow: 'placement-swap',
    },
    disposition: 'forward',
    phase: 'committed',
    actual: {
      before: [ledgerBefore, liveBefore],
      after: [ledgerAfter, liveAfter],
      retained: [],
    },
    completedAt: removal.completedAt ?? removal.updatedAt,
  };
};

const relocatedRemovalJournal = (
  removal: LogicalJournalV1Dto,
  placementPath: string,
  phase: 'live' | 'committed',
): LogicalJournalV1Dto => {
  if (
    removal.intent.kind !== 'remove' ||
    removal.intent.before.kind !== 'placement' ||
    removal.intent.after.kind !== 'absent' ||
    removal.intent.tool === null
  ) {
    throw new Error('relocated removal fixture requires a selected removal intent');
  }
  const resource = {
    ...removal.intent.before.resource,
    location: { kind: 'machine-bound' as const, path: placementPath },
  };
  const pairId = createOperationPairId({
    domain: 'skillsmith.operation-pair-identity',
    schemaVersion: 1,
    groupId: removal.intent.groupId,
    tool: removal.intent.tool,
    resource,
  });
  const operationKind = phase === 'committed' ? ('remove' as const) : ('repair' as const);
  const operationSource =
    phase === 'committed' ? removal.intent.source : removal.intent.before.source;
  if (phase === 'live' && operationSource === null) {
    throw new Error('relocated repair fixture requires a selected placement source');
  }
  const operationId = createOperationId({
    domain: 'skillsmith.operation-identity',
    schemaVersion: 1,
    groupId: removal.intent.groupId,
    pairId,
    kind: operationKind,
    skill: removal.intent.skill,
    source: operationSource,
    tool: removal.intent.tool,
    scope: removal.intent.scope,
  });
  const relocateActuals = (actuals: LogicalJournalV1Dto['actual']['before']) =>
    actuals.map((actual) =>
      actual.role === 'live' ? { ...actual, placementPath } : actual,
    ) as LogicalJournalV1Dto['actual']['before'];
  const transactionId = `transaction:p4a-ts02-relocated-${phase}`;
  return {
    ...structuredClone(removal),
    transactionId,
    intent: {
      ...removal.intent,
      operationId,
      pairId,
      kind: operationKind,
      source: operationSource,
      before: { ...removal.intent.before, resource },
      after:
        phase === 'committed'
          ? { ...removal.intent.after, resource }
          : { ...removal.intent.before, resource },
    },
    context: { ...removal.context, parentOperationId: operationId },
    phase,
    actual: {
      before: relocateActuals(removal.actual.before),
      after:
        phase === 'committed'
          ? relocateActuals(removal.actual.after)
          : relocateActuals(removal.actual.before),
      retained: removal.actual.retained,
    },
    completedAt: phase === 'committed' ? removal.completedAt : null,
  };
};

const runDeclaredUninstall = async (
  selected: FixtureFleet,
  root: string,
  targets: readonly string[],
  options: Readonly<{
    dryRun?: boolean;
    continueOnError?: boolean;
    tools?: readonly FlipTool[];
  }> = {},
) => {
  const result = await runUninstall(
    selected.env,
    {
      targets,
      tools: ['claude-code'],
      scope: 'user',
      file: join(root, 'skillsmith.toml'),
      lockfile: join(root, 'skillsmith.lock'),
      cwd: selected.base,
      configuration: selected.configuration,
      ...options,
    },
    await depsFor(selected, `${targets.join('-')}-${options.dryRun ? 'preview' : 'run'}`),
  );
  if (!result.ok)
    throw new Error('message' in result.error ? result.error.message : result.error.code);
  return reportOf(result.value);
};

const bindingFor = (
  operation: ReturnType<typeof collisionPlan>['plan']['operations'][number],
  calls: string[],
  failedOperationId: string,
) => ({
  operationId: operation.operationId,
  groupId: operation.groupId,
  pairId: operation.pairId,
  actualBefore: operation.before,
  unstartedForce: null,
  execute: async (): Promise<OperationExecutionResult> => {
    calls.push(operation.operationId);
    const failed = operation.operationId === failedOperationId;
    return createOperationExecutionResult({
      operationId: operation.operationId,
      outcome: failed ? 'failed' : 'succeeded',
      actualBefore: operation.before,
      actualAfter: failed ? operation.before : operation.after,
      force: null,
      error: failed
        ? { code: 'fixture-failed', message: 'Injected TS02 failure.', remediation: 'Retry.' }
        : null,
    });
  },
});

const lifecycleRevision = (resourceId: string, marker: string): ExpectedRevisionV1 => {
  const revision = createExpectedRevisionV1({
    schemaVersion: 1,
    domain: 'ledger',
    resourceId,
    state: 'absent',
    targetIdentity: `/fixture/${marker}/placements.json`,
    targetKind: 'absent',
    parentIdentity: `/fixture/${marker}`,
    parentKind: 'directory',
    parentMetadataIdentity: `metadata:v1:${marker.repeat(64).slice(0, 64)}`,
  });
  if (!revision.ok) throw new Error('invalid TS02 lifecycle revision fixture');
  return revision.value;
};

const readReached = async (
  stream: ReadableStream<Uint8Array>,
): Promise<Readonly<{ kind: string; barrier: string }>> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let source = '';
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error('p4a-ts02 crash child barrier timed out')), 15_000);
  });
  const next = async (): Promise<Readonly<{ kind: string; barrier: string }>> => {
    while (!source.includes('\n')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('p4a-ts02 crash child exited before its barrier');
      source += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(source.slice(0, source.indexOf('\n'))) as {
      kind: string;
      barrier: string;
    };
  };
  return Promise.race([next(), timeout]);
};

const seedCrashBoundary = async (
  root: string,
  stopAfter: 'manifest' | 'lock',
  manifest: string,
  lock: string,
): Promise<void> => {
  const child = Bun.spawn([process.execPath, CRASH_CHILD], {
    cwd: root,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  child.stdin.write(
    `${JSON.stringify({
      kind: 'start',
      root,
      stopAfter,
      manifestSource: manifest,
      lockSource: lock,
    })}\n`,
  );
  const reached = await readReached(child.stdout);
  expect(reached).toEqual({ kind: 'reached', barrier: `after-${stopAfter}` });
  child.kill('SIGKILL');
  await child.exited;
};

const crashAfterCommittedLivePair = async (
  selected: FixtureFleet,
  target: string,
  tools: readonly FlipTool[],
) => {
  const coordinationRoot = join(selected.base, 'after-live-pair-coordination');
  const child = Bun.spawn([process.execPath, CRASH_CHILD], {
    cwd: selected.base,
    env: {
      ...process.env,
      HOME: selected.home,
      XDG_CONFIG_HOME: selected.env.xdg.config,
      XDG_DATA_HOME: selected.env.xdg.data,
      XDG_CACHE_HOME: selected.env.xdg.cache,
      SKILLSMITH_HOME: selected.data,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  child.stdin.write(
    `${JSON.stringify({
      kind: 'start-live',
      cwd: selected.base,
      dataDir: selected.data,
      target,
      tools,
      coordinationRoot,
    })}\n`,
  );
  const reached = await readReached(child.stdout);
  expect(reached).toEqual({ kind: 'reached', barrier: 'after-live-pair' });
  child.kill('SIGKILL');
  await child.exited;
  return createTestNodeArtifactCoordinatorPorts(coordinationRoot);
};

describe('EWP-P4A-TS02', () => {
  test('the bounded fixture owns all twelve feature families and exact compatibility replays', () => {
    expect(FIXTURE_CANARY).toBe('p4a-ts02-fixture-v1');
    expect(FEATURE_FAMILIES).toHaveLength(12);
    expect(new Set(FEATURE_FAMILIES).size).toBe(12);
    expect(REQUIRED_COMPATIBILITY_SELECTORS).toEqual([
      'EWP-CMD-INSTALL-TS08',
      'EWP-CMD-UNINSTALL-TS04',
      'EWP-CMD-UNINSTALL-TS07',
      'EWP-P3B-TS03',
      'EWP-P3B-TS05',
      'EWP-CMD-PROMOTE-TS04',
      'EWP-CMD-PROMOTE-TS06',
    ]);
    expect(COLLISION_CASES).toHaveLength(4);
    expect(LOCK_HANDOFF_CASES).toHaveLength(15);
    expect(CRASH_POINTS).toEqual(['after-manifest', 'after-lock', 'after-live-pair']);
  });

  test('preflight failures leave artifact, ledger, live, journal, and store targets untouched', async () => {
    const selected = await fleet();
    const root = join(selected.base, 'preflight-zero-write');
    await mkdir(root, { recursive: true });
    const manifestPath = join(root, 'skillsmith.toml');
    const lockPath = join(root, 'skillsmith.lock');
    const writes: string[] = [];
    const guardedEnv = {
      ...selected.env,
      writeTextFile: async (path: string, source: string) => {
        writes.push(`write:${path}`);
        await selected.env.writeTextFile(path, source);
      },
      copyTree: async (source: string, destination: string) => {
        writes.push(`copy:${destination}`);
        await selected.env.copyTree(source, destination);
      },
      makeSymlink: async (target: string, path: string) => {
        writes.push(`symlink:${path}`);
        await selected.env.makeSymlink(target, path);
      },
      rename: async (source: string, destination: string) => {
        writes.push(`rename:${destination}`);
        await selected.env.rename(source, destination);
      },
      removeTree: async (path: string) => {
        writes.push(`remove:${path}`);
        await selected.env.removeTree(path);
      },
    };
    const invalid = await runInstall(
      guardedEnv,
      {
        sources: [''],
        tools: ['claude-code', 'codex'],
        scope: 'user',
        file: manifestPath,
        lockfile: lockPath,
        cwd: selected.base,
        configuration: selected.configuration,
      },
      await installDepsFor(selected, 'invalid-source'),
    );
    expect(invalid.ok).toBeTrue();
    if (invalid.ok) {
      expect(invalid.value.plan.operations).toEqual([]);
      expect(invalid.value.results.every(({ action }) => action === 'refused')).toBeTrue();
    }
    expect(writes).toEqual([]);
    expect(await selected.env.pathKind(manifestPath)).toBe('absent');
    expect(await selected.env.pathKind(lockPath)).toBe('absent');
    expect(await selected.env.pathKind(ledgerPathOf(selected.data))).toBe('absent');
    expect(await selected.env.pathKind(join(selected.data, 'store'))).toBe('absent');
    expect(
      await selected.env.pathKind(join(selected.home, '.claude', 'skills', 'factor-scan')),
    ).toBe('absent');
    expect(
      await selected.env.pathKind(join(selected.home, '.agents', 'skills', 'factor-scan')),
    ).toBe('absent');

    const dual = await fleet();
    const userRoot = join(dual.env.xdg.config, 'skillsmith');
    await mkdir(userRoot, { recursive: true });
    const ownerManifest = manifestSource(['factor-scan']);
    const ownerLock = lockSourceFor(ownerManifest, dual.headSha);
    await Promise.all([
      writeFile(join(userRoot, 'skillsmith.toml'), ownerManifest),
      writeFile(join(userRoot, 'skillsmith.lock'), ownerLock),
      writeFile(join(dual.project, 'skillsmith.toml'), ownerManifest),
      writeFile(join(dual.project, 'skillsmith.lock'), ownerLock),
    ]);
    const transportCalls: string[] = [];
    const dualDeps = await installDepsFor(dual, 'dual-owner');
    const transport = dualDeps.transport;
    if (transport === undefined) throw new Error('missing dual-owner transport');
    const refused = await runInstall(
      dual.env,
      {
        sources: [factorSource()],
        tools: ['claude-code'],
        cwd: dual.project,
        configuration: dual.configuration,
      },
      {
        ...dualDeps,
        transport: {
          resolveRef: async (...args) => {
            transportCalls.push('resolveRef');
            return transport.resolveRef(...args);
          },
          fetchRepo: async (...args) => {
            transportCalls.push('fetchRepo');
            return transport.fetchRepo(...args);
          },
          listSkills: async (...args) => {
            transportCalls.push('listSkills');
            return transport.listSkills(...args);
          },
          materializeSkill: async (...args) => {
            transportCalls.push('materializeSkill');
            return transport.materializeSkill(...args);
          },
        },
      },
    );
    expect(refused.ok).toBeTrue();
    if (refused.ok) {
      expect(refused.value.plan.operations).toEqual([]);
      expect(refused.value.artifactSelection.outcome).toBe('refused');
    }
    expect(transportCalls).toEqual(['resolveRef', 'fetchRepo', 'listSkills', 'materializeSkill']);
    expect(await readPair(userRoot)).toEqual([ownerManifest, ownerLock]);
    expect(await readPair(dual.project)).toEqual([ownerManifest, ownerLock]);
    expect(await dual.env.pathKind(ledgerPathOf(dual.data))).toBe('absent');

    const cliEntrypoint = join(import.meta.dir, '../../../packages/cli/src/index.ts');
    for (const args of [
      ['uninstall', '--scope', 'invalid', 'portable-alpha'],
      ['uninstall', '--scope', 'user', '--all-scopes', 'portable-alpha'],
    ] as const) {
      const child = Bun.spawn([process.execPath, cliEntrypoint, ...args], {
        cwd: selected.base,
        env: {
          ...process.env,
          HOME: selected.home,
          XDG_CONFIG_HOME: selected.env.xdg.config,
          XDG_DATA_HOME: selected.env.xdg.data,
          XDG_CACHE_HOME: selected.env.xdg.cache,
          SKILLSMITH_HOME: selected.data,
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(await child.exited, args.join(' ')).not.toBe(0);
      expect(await selected.env.pathKind(manifestPath), args.join(' ')).toBe('absent');
      expect(await selected.env.pathKind(lockPath), args.join(' ')).toBe('absent');
      expect(await selected.env.pathKind(ledgerPathOf(selected.data)), args.join(' ')).toBe(
        'absent',
      );
      expect(await selected.env.pathKind(join(selected.data, 'store')), args.join(' ')).toBe(
        'absent',
      );
    }
  });

  test('plans two sources by two tools deterministically under permutation and reuses preview IDs', async () => {
    const selected = await fleet();
    const root = join(selected.base, 'deterministic-install');
    await mkdir(root, { recursive: true });
    const manifestPath = join(root, 'skillsmith.toml');
    const lockPath = join(root, 'skillsmith.lock');
    const sources = [factorSource(), remote.singleSource] as const;
    const tools = ['codex', 'claude-code'] as const;
    const options = {
      sources,
      tools,
      scope: 'user' as const,
      file: manifestPath,
      lockfile: lockPath,
      cwd: selected.base,
      configuration: selected.configuration,
      dryRun: true,
    };
    const preview = await runInstall(
      selected.env,
      options,
      await installDepsFor(selected, 'deterministic-preview'),
    );
    const permuted = await runInstall(
      selected.env,
      { ...options, sources: [...sources].reverse(), tools: [...tools].reverse() },
      await installDepsFor(selected, 'deterministic-permuted'),
    );
    if (!preview.ok || !permuted.ok) throw new Error('deterministic install preview failed');
    expect(preview.value.plan.operations.map(({ operationId }) => operationId)).toEqual(
      permuted.value.plan.operations.map(({ operationId }) => operationId),
    );
    expect(preview.value.plan.operations.map(({ groupId }) => groupId)).toEqual(
      permuted.value.plan.operations.map(({ groupId }) => groupId),
    );
    expect(preview.value.plan.operations.map(({ pairId }) => pairId)).toEqual(
      permuted.value.plan.operations.map(({ pairId }) => pairId),
    );
    expect(Object.isFrozen(preview.value.plan)).toBeTrue();
    expect(
      preview.value.plan.operations.every(
        (operation) => Object.isFrozen(operation) && Object.isFrozen(operation.dependencyMetadata),
      ),
    ).toBeTrue();
    expect(sources).toEqual([factorSource(), remote.singleSource]);
    expect(tools).toEqual(['codex', 'claude-code']);

    const executed = await runInstall(
      selected.env,
      { ...options, dryRun: false },
      await installDepsFor(selected, 'deterministic-execution'),
    );
    if (!executed.ok) throw new Error('deterministic install execution failed');
    expect(executed.value.plan).toEqual(preview.value.plan);
    expect(executed.value.executionResults.map(({ operationId }) => operationId)).toEqual(
      preview.value.plan.operations.map(({ operationId }) => operationId),
    );
    expect(executed.value.results.filter(({ action }) => action === 'installed')).toHaveLength(4);
  });

  test('keeps no-save source groups independent under fail-fast and continuation', async () => {
    for (const continueOnError of [false, true]) {
      const selected = await fleet();
      const baseOptions = {
        sources: [factorSource(), remote.singleSource] as const,
        tools: ['claude-code'] as const,
        scope: 'user' as const,
        noSave: true,
        cwd: selected.base,
        configuration: selected.configuration,
      };
      const preview = await runInstall(
        selected.env,
        { ...baseOptions, dryRun: true },
        await installDepsFor(selected, `no-save-preview-${continueOnError}`),
      );
      if (!preview.ok) throw new Error('failed to preview no-save source groups');
      const orderedSkills = preview.value.plan.operations
        .filter(({ pairId, skill }) => pairId !== null && skill !== null)
        .map(({ skill }) => skill as string);
      const firstSkill = orderedSkills[0];
      const laterSkill = orderedSkills[1];
      if (firstSkill === undefined || laterSkill === undefined) {
        throw new Error('missing no-save source groups');
      }
      const firstPath = placementPathFor(selected, 'claude-code', firstSkill);
      const failureEnv = {
        ...selected.env,
        rename: async (source: string, destination: string) => {
          if (destination === firstPath) {
            throw new Error('synthetic first no-save group live failure');
          }
          await selected.env.rename(source, destination);
        },
      };
      const result = await runInstall(
        failureEnv,
        { ...baseOptions, ...(continueOnError ? { continueOnError: true } : {}) },
        await installDepsFor(selected, `no-save-run-${continueOnError}`),
      );
      if (!result.ok) throw new Error('no-save group failure escaped the report boundary');
      expect(result.value.results.find(({ skill }) => skill === firstSkill)?.action).toBe('failed');
      expect(result.value.results.find(({ skill }) => skill === laterSkill)?.action).toBe(
        continueOnError ? 'installed' : 'skipped',
      );
      expect(result.value.artifactSelection).toEqual({ outcome: 'none', reason: 'no-save' });
      expect(result.value.plan.operations.every(({ pairId }) => pairId !== null)).toBeTrue();
    }
  });

  test('preserves complete two-tool install intent in both partial-failure directions and converges', async () => {
    for (const failedTool of ['claude-code', 'codex'] as const) {
      const selected = await fleet();
      const root = join(selected.base, `partial-install-${failedTool}`);
      await mkdir(root, { recursive: true });
      const manifestPath = join(root, 'skillsmith.toml');
      const lockPath = join(root, 'skillsmith.lock');
      const verify: InstallDeps['verify'] = async (_env, options) => {
        const tool = (options.tools?.[0] ?? 'claude-code') as FlipTool;
        return tool === failedTool
          ? err(flipFailedError(`synthetic ${tool} verification failure`))
          : ok(verificationReport(tool));
      };
      const partial = await runInstall(
        selected.env,
        {
          sources: [factorSource()],
          tools: ['claude-code', 'codex'],
          scope: 'user',
          file: manifestPath,
          lockfile: lockPath,
          cwd: selected.base,
          configuration: selected.configuration,
        },
        await installDepsFor(selected, `partial-${failedTool}`, verify),
      );
      if (!partial.ok) throw new Error(`partial ${failedTool} install failed at the run boundary`);
      const report = installReportOf(partial.value);
      expect(report.results.find(({ tool }) => tool === failedTool)?.action, failedTool).toBe(
        'failed',
      );
      const succeededTool = failedTool === 'claude-code' ? 'codex' : 'claude-code';
      expect(report.results.find(({ tool }) => tool === succeededTool)?.action, failedTool).toBe(
        'installed',
      );
      expect(report.results.find(({ tool }) => tool === failedTool)?.drift.status, failedTool).toBe(
        'desired-without-live',
      );
      expect(
        report.results.find(({ tool }) => tool === succeededTool)?.drift.status,
        failedTool,
      ).toBe('in-sync');
      const manifest = await readFile(manifestPath, 'utf8');
      expect(manifest, failedTool).toContain('tools = ["claude-code", "codex"]');
      expect(
        await selected.env.pathKind(placementPathFor(selected, failedTool, 'factor-scan')),
      ).toBe('absent');
      expect(
        await selected.env.pathKind(placementPathFor(selected, succeededTool, 'factor-scan')),
      ).toBe('symlink');
      const status = await freshStatus(selected, root, 'factor-scan', ['claude-code', 'codex']);
      const entry = status.entries.find(({ name }) => name === 'factor-scan');
      expect(entry?.desired.state, failedTool).toBe('present');
      expect(entry?.locked.state, failedTool).toBe('present');
      expect(entry?.convergence, failedTool).toBe('drift');
      expect(
        entry?.placements.find(({ identity }) => identity.tool === failedTool)?.classification,
        failedTool,
      ).toBe('absent');
      expect(
        entry?.placements.find(({ identity }) => identity.tool === succeededTool)?.classification,
        failedTool,
      ).toBe('store-linked');
      if (status.artifacts.state !== 'selected')
        throw new Error('missing selected status artifacts');
      expect(status.artifacts.manifest).toMatchObject({
        state: 'present',
        byteRevision: expect.stringMatching(/^sha256:/u),
        semanticRevision: expect.stringMatching(/^sha256:/u),
      });
      expect(status.artifacts.lock).toMatchObject({
        state: 'present',
        byteRevision: expect.stringMatching(/^sha256:/u),
        semanticRevision: expect.stringMatching(/^sha256:/u),
      });
      const stableArtifacts = await readPair(root);

      const converged = await runInstall(
        selected.env,
        {
          sources: [factorSource()],
          tools: ['claude-code', 'codex'],
          scope: 'user',
          file: manifestPath,
          lockfile: lockPath,
          cwd: selected.base,
          configuration: selected.configuration,
        },
        await installDepsFor(selected, `partial-rerun-${failedTool}`),
      );
      if (!converged.ok) throw new Error(`partial ${failedTool} rerun failed`);
      expect(
        converged.value.results.find(({ tool }) => tool === failedTool)?.action,
        failedTool,
      ).toBe('installed');
      expect(await readPair(root), failedTool).toEqual(stableArtifacts);
      expect(
        await selected.env.pathKind(placementPathFor(selected, failedTool, 'factor-scan')),
      ).toBe('symlink');
    }
  });

  test('retains exact portable bytes in both partial-uninstall directions, then converges', async () => {
    for (const failedTool of ['claude-code', 'codex'] as const) {
      const selected = await fleet();
      const root = join(selected.base, `partial-uninstall-${failedTool}`);
      await mkdir(root, { recursive: true });
      const manifestPath = join(root, 'skillsmith.toml');
      const lockPath = join(root, 'skillsmith.lock');
      const installed = await runInstall(
        selected.env,
        {
          sources: [factorSource()],
          tools: ['claude-code', 'codex'],
          scope: 'user',
          file: manifestPath,
          lockfile: lockPath,
          cwd: selected.base,
          configuration: selected.configuration,
        },
        await installDepsFor(selected, `uninstall-seed-${failedTool}`),
      );
      if (!installed.ok) throw new Error(`failed to seed ${failedTool} uninstall`);
      const before = await readPair(root);
      const failedPath = placementPathFor(selected, failedTool, 'factor-scan');
      const failureEnv = {
        ...selected.env,
        rename: async (source: string, destination: string) => {
          if (source === failedPath) throw new Error(`synthetic ${failedTool} live collision`);
          await selected.env.rename(source, destination);
        },
      };
      const partial = await runUninstall(
        failureEnv,
        {
          targets: ['factor-scan'],
          tools: ['claude-code', 'codex'],
          scope: 'user',
          file: manifestPath,
          lockfile: lockPath,
          continueOnError: true,
          cwd: selected.base,
          configuration: selected.configuration,
        },
        await depsFor(selected, `partial-uninstall-${failedTool}`),
      );
      if (!partial.ok) throw new Error(`partial ${failedTool} uninstall failed at run boundary`);
      expect(
        partial.value.results.find(({ tool }) => tool === failedTool)?.action,
        failedTool,
      ).toBe('failed');
      const succeededTool = failedTool === 'claude-code' ? 'codex' : 'claude-code';
      expect(
        partial.value.results.find(({ tool }) => tool === succeededTool)?.action,
        failedTool,
      ).toBe('removed');
      expect(
        partial.value.results.find(({ tool }) => tool === succeededTool)?.drift.status,
        failedTool,
      ).toBe('desired-without-live');
      expect(await readPair(root), failedTool).toEqual(before);
      expect(await selected.env.pathKind(failedPath), failedTool).toBe('symlink');
      expect(
        await selected.env.pathKind(placementPathFor(selected, succeededTool, 'factor-scan')),
        failedTool,
      ).toBe('absent');
      const status = await freshStatus(selected, root, 'factor-scan', ['claude-code', 'codex']);
      const entry = status.entries.find(({ name }) => name === 'factor-scan');
      expect(entry?.desired.state, failedTool).toBe('present');
      expect(entry?.locked.state, failedTool).toBe('present');
      expect(entry?.convergence, failedTool).toBe('drift');
      expect(
        entry?.placements.find(({ identity }) => identity.tool === failedTool)?.classification,
        failedTool,
      ).toBe('store-linked');
      expect(
        entry?.placements.find(({ identity }) => identity.tool === succeededTool)?.classification,
        failedTool,
      ).toBe('absent');

      const converged = await runUninstall(
        selected.env,
        {
          targets: ['factor-scan'],
          tools: ['claude-code', 'codex'],
          scope: 'user',
          file: manifestPath,
          lockfile: lockPath,
          cwd: selected.base,
          configuration: selected.configuration,
        },
        await depsFor(selected, `partial-uninstall-rerun-${failedTool}`),
      );
      if (!converged.ok) throw new Error(`partial ${failedTool} uninstall rerun failed`);
      expect(converged.value.plan.operations.some(({ kind }) => kind === 'write-lock')).toBeTrue();
      expect(await selected.env.pathKind(failedPath), failedTool).toBe('absent');
      const [manifest, lock] = await readPair(root);
      expect(manifest, failedTool).not.toContain('name = "factor-scan"');
      expect(lock, failedTool).not.toContain('name = "factor-scan"');
    }
  });

  test('admits only the exact artifact-prefix barrier and preserves fail-fast/continue truth', async () => {
    for (const item of COLLISION_CASES) {
      const fixture = collisionPlan(item.policy);
      expect(
        orderExecutableOperationsTopologically(fixture.plan.operations).map(
          ({ operationId }) => operationId,
        ),
        item.id,
      ).toEqual(fixture.plan.operations.map(({ operationId }) => operationId));

      const calls: string[] = [];
      const failedOperationId =
        item.failure === 'prefix-lock' ? fixture.alphaLockId : fixture.alphaLiveId;
      const results = await scheduleOperationPlan(
        fixture.plan,
        fixture.plan.operations.map((operation) => bindingFor(operation, calls, failedOperationId)),
      );
      const byId = new Map(results.map((result) => [result.operationId, result.outcome]));
      for (const result of results) {
        if (result.outcome !== 'succeeded') {
          expect(result.actualAfter, `${item.id}:${result.outcome}`).toEqual(result.actualBefore);
        }
      }
      expect(byId.get(fixture.betaLiveId), item.id).toBe(item.expectedLater);
      expect(calls.includes(fixture.betaLiveId), item.id).toBe(item.expectedLater === 'succeeded');
      if (item.failure === 'prefix-lock') {
        expect(byId.get(fixture.alphaLiveId), item.id).toBe('skipped-after-failure');
      }
    }
  });

  test('binds an unchanged middle install only to the latest earlier prefix under both policies', async () => {
    for (const policy of ['fail-fast', 'continue-on-error'] as const) {
      const fixture = rollingCollisionPlan(policy);
      expect(
        orderExecutableOperationsTopologically(fixture.plan.operations).map(
          ({ operationId }) => operationId,
        ),
        policy,
      ).toEqual(fixture.plan.operations.map(({ operationId }) => operationId));
      const middle = fixture.plan.operations.find(
        ({ operationId }) => operationId === fixture.middleLiveId,
      );
      if (middle === undefined) throw new Error('missing unchanged middle install fixture');
      expect(middle.dependencyMetadata.operationIds, policy).toEqual([fixture.firstLockId]);
      expect(middle.dependencyMetadata.operationIds, policy).not.toContain(fixture.laterLockId);

      const calls: string[] = [];
      const results = await scheduleOperationPlan(
        fixture.plan,
        fixture.plan.operations.map((operation) =>
          bindingFor(operation, calls, fixture.laterLockId),
        ),
      );
      const byId = new Map(results.map((result) => [result.operationId, result.outcome]));
      expect(byId.get(fixture.middleLiveId), policy).toBe('succeeded');
      expect(byId.get(fixture.laterLockId), policy).toBe('failed');
      expect(byId.get(fixture.laterLiveId), policy).toBe('skipped-after-failure');
      expect(calls.includes(fixture.middleLiveId), policy).toBeTrue();
    }
  });

  test('plans two declared-only removals as cumulative exact images with one full-group barrier', async () => {
    const selected = await fleet();
    const root = join(selected.base, 'multi-declaration');
    await mkdir(root, { recursive: true });
    const beforeManifest = manifestSource(['portable-beta', 'portable-alpha', 'retained-gamma']);
    const beforeLock = lockSourceFor(beforeManifest, selected.headSha);
    await Promise.all([
      writeFile(join(root, 'skillsmith.toml'), beforeManifest),
      writeFile(join(root, 'skillsmith.lock'), beforeLock),
    ]);

    const preview = await runDeclaredUninstall(
      selected,
      root,
      ['portable-beta', 'portable-alpha'],
      { dryRun: true, continueOnError: true },
    );
    expect(preview.plan.operations.map(({ kind }) => kind)).toEqual([
      'write-manifest',
      'write-lock',
      'write-manifest',
      'write-lock',
    ]);
    expect(await readPair(root)).toEqual([beforeManifest, beforeLock]);

    const execution = await runDeclaredUninstall(
      selected,
      root,
      ['portable-beta', 'portable-alpha'],
      { continueOnError: true },
    );
    expect(execution.plan).toEqual(preview.plan);
    const groups = [...new Set(execution.plan.operations.map(({ groupId }) => groupId))];
    expect(groups).toHaveLength(2);
    const firstGroup = execution.plan.operations.filter(({ groupId }) => groupId === groups[0]);
    const secondGroup = execution.plan.operations.filter(({ groupId }) => groupId === groups[1]);
    const prefix = firstGroup.find(({ kind }) => kind === 'write-lock');
    if (prefix === undefined) throw new Error('missing first declaration lock terminal');
    expect(
      secondGroup.every(({ dependencyMetadata }) =>
        dependencyMetadata.operationIds.includes(prefix.operationId),
      ),
    ).toBeTrue();

    const [afterManifest, afterLock] = await readPair(root);
    expect(afterManifest).toContain('# retained top-level comment');
    expect(afterManifest).toContain('name = "retained-gamma"');
    expect(afterManifest).not.toContain('name = "portable-alpha"');
    expect(afterManifest).not.toContain('name = "portable-beta"');
    expect(afterLock).toBe(lockSourceFor(afterManifest, selected.headSha));

    const rerun = await runDeclaredUninstall(selected, root, ['portable-alpha', 'portable-beta']);
    expect(rerun.plan.operations).toEqual([]);
    expect(await readPair(root)).toEqual([afterManifest, afterLock]);
  });

  test('keeps a later saving uninstall group unstarted after a real first-group live collision', async () => {
    const selected = await fleet();
    const root = join(selected.base, 'real-uninstall-collision');
    await mkdir(root, { recursive: true });
    const manifestPath = join(root, 'skillsmith.toml');
    const lockPath = join(root, 'skillsmith.lock');
    const installed = await runInstall(
      selected.env,
      {
        sources: [factorSource(), remote.singleSource],
        tools: ['claude-code'],
        scope: 'user',
        file: manifestPath,
        lockfile: lockPath,
        cwd: selected.base,
        configuration: selected.configuration,
      },
      await installDepsFor(selected, 'real-uninstall-collision-seed'),
    );
    if (!installed.ok) throw new Error('failed to seed the real uninstall collision');
    const before = await readPair(root);
    const options = {
      targets: ['factor-scan', 'lint'] as const,
      tools: ['claude-code'] as const,
      scope: 'user' as const,
      file: manifestPath,
      lockfile: lockPath,
      continueOnError: true,
      cwd: selected.base,
      configuration: selected.configuration,
    };
    const preview = await runUninstall(
      selected.env,
      { ...options, dryRun: true },
      await depsFor(selected, 'real-uninstall-collision-preview'),
    );
    if (!preview.ok) throw new Error('failed to preview the real uninstall collision');
    const removals = preview.value.plan.operations.filter(({ kind }) => kind === 'remove');
    const first = removals[0];
    const later = removals[1];
    if (first?.skill == null || later?.skill == null) {
      throw new Error('missing ordered real uninstall collision groups');
    }
    const firstPath = placementPathFor(selected, 'claude-code', first.skill);
    const laterPath = placementPathFor(selected, 'claude-code', later.skill);
    const renameCalls: string[] = [];
    const failureEnv = {
      ...selected.env,
      rename: async (source: string, destination: string) => {
        renameCalls.push(source);
        if (source === firstPath) throw new Error('synthetic first-group live collision');
        await selected.env.rename(source, destination);
      },
    };
    const failed = await runUninstall(
      failureEnv,
      options,
      await depsFor(selected, 'real-uninstall-collision-run'),
    );
    if (!failed.ok) throw new Error('real uninstall collision escaped the report boundary');
    expect(failed.value.plan).toEqual(preview.value.plan);
    expect(failed.value.results.find(({ skill }) => skill === first.skill)?.action).toBe('failed');
    expect(failed.value.results.find(({ skill }) => skill === later.skill)?.action).toBe('skipped');
    expect(renameCalls).not.toContain(laterPath);
    expect(await selected.env.pathKind(firstPath)).toBe('symlink');
    expect(await selected.env.pathKind(laterPath)).toBe('symlink');
    expect(await readPair(root)).toEqual(before);
  });

  test('repairs only a history-authorized final stale lock and refuses drift', async () => {
    const selected = await fleet();
    const root = join(selected.base, 'manifest-terminal-handoff');
    await mkdir(root, { recursive: true });
    const contentHash = await seedManagedPairs(selected, 'portable-alpha', ['claude-code']);
    const removal = await commitManagedRemoval(selected, 'portable-alpha', ['claude-code']);
    expect(removal.results).toEqual(
      expect.arrayContaining([expect.objectContaining({ tool: 'claude-code', action: 'removed' })]),
    );
    const beforeManifest = manifestSource(['portable-alpha', 'retained-gamma']);
    const beforeLock = lockSourceFor(beforeManifest, selected.headSha, contentHash);
    const afterManifest = manifestSource(['retained-gamma']);
    const afterLock = lockSourceFor(afterManifest, selected.headSha, contentHash);
    await Promise.all([
      writeFile(join(root, 'skillsmith.toml'), beforeManifest),
      writeFile(join(root, 'skillsmith.lock'), beforeLock),
    ]);

    await seedCrashBoundary(root, 'manifest', afterManifest, afterLock);
    expect(await readPair(root)).toEqual([afterManifest, beforeLock]);
    const duplicateTargets = ['portable-alpha', 'portable-alpha'] as const;
    const preview = await runDeclaredUninstall(selected, root, duplicateTargets, { dryRun: true });
    expect(preview.plan.operations.map(({ kind }) => kind)).toEqual(['write-lock']);
    expect(await readPair(root)).toEqual([afterManifest, beforeLock]);
    const repaired = await runDeclaredUninstall(selected, root, duplicateTargets);
    expect(repaired.plan).toEqual(preview.plan);
    expect(repaired.plan.operations.map(({ kind }) => kind)).toEqual(['write-lock']);
    expect(repaired.results).toHaveLength(2);
    expect(repaired.results.every(({ action }) => action === 'noop')).toBeTrue();
    expect(await readPair(root)).toEqual([afterManifest, afterLock]);

    const second = await runDeclaredUninstall(selected, root, ['portable-alpha']);
    expect(second.plan.operations).toEqual([]);
    expect(await readPair(root)).toEqual([afterManifest, afterLock]);

    const unrelatedRoot = join(selected.base, 'unrelated-lock-drift');
    await mkdir(unrelatedRoot, { recursive: true });
    const unrelatedLock = beforeLock.replace(
      /manifest_hash = "sha256:[0-9a-f]+"/u,
      `manifest_hash = "sha256:${'f'.repeat(64)}"`,
    );
    await Promise.all([
      writeFile(join(unrelatedRoot, 'skillsmith.toml'), afterManifest),
      writeFile(join(unrelatedRoot, 'skillsmith.lock'), unrelatedLock),
    ]);
    const refused = await runDeclaredUninstall(selected, unrelatedRoot, ['portable-alpha']);
    expect(refused.plan.operations).toEqual([]);
    expect(refused.results.every(({ action }) => action === 'refused')).toBeTrue();
    expect(await readPair(unrelatedRoot)).toEqual([afterManifest, unrelatedLock]);

    for (const [label, driftedLock] of [
      [
        'requested-ref-drift',
        beforeLock.replace(
          'source = "fixture.invalid/acme/skills//skills/portable-alpha"\n',
          'source = "fixture.invalid/acme/skills//skills/portable-alpha"\nrequested_ref = "unexpected-ref"\n',
        ),
      ],
      [
        'resolved-sha-drift',
        beforeLock.replace(/resolved_sha = "[0-9a-f]+"/u, `resolved_sha = "${'d'.repeat(40)}"`),
      ],
      [
        'content-hash-drift',
        beforeLock.replace(
          /content_hash = "sha256:[0-9a-f]+"/u,
          `content_hash = "sha256:${'b'.repeat(64)}"`,
        ),
      ],
    ] as const) {
      const driftRoot = join(selected.base, label);
      await mkdir(driftRoot, { recursive: true });
      await Promise.all([
        writeFile(join(driftRoot, 'skillsmith.toml'), afterManifest),
        writeFile(join(driftRoot, 'skillsmith.lock'), driftedLock),
      ]);
      const drifted = await runDeclaredUninstall(selected, driftRoot, ['portable-alpha']);
      expect(drifted.plan.operations, label).toEqual([]);
      expect(
        drifted.results.every(({ action }) => action === 'refused'),
        label,
      ).toBeTrue();
      expect(await readPair(driftRoot), label).toEqual([afterManifest, driftedLock]);
    }

    const historyFree = await fleet();
    const historyFreeRoot = join(historyFree.base, 'history-free-final-handoff');
    await mkdir(historyFreeRoot, { recursive: true });
    const historyFreeBefore = lockSourceFor(beforeManifest, historyFree.headSha, contentHash);
    await Promise.all([
      writeFile(join(historyFreeRoot, 'skillsmith.toml'), afterManifest),
      writeFile(join(historyFreeRoot, 'skillsmith.lock'), historyFreeBefore),
    ]);
    const historyFreeResult = await runDeclaredUninstall(historyFree, historyFreeRoot, [
      'portable-alpha',
    ]);
    expect(historyFreeResult.plan.operations).toEqual([]);
    expect(historyFreeResult.results.every(({ action }) => action === 'refused')).toBeTrue();
    expect(await readPair(historyFreeRoot)).toEqual([afterManifest, historyFreeBefore]);
  });

  test('finds the same exact handoff through the bounded automatic sibling owner', async () => {
    const selected = await fleet();
    const root = join(selected.env.xdg.config, 'skillsmith');
    await mkdir(root, { recursive: true });
    const contentHash = await seedManagedPairs(selected, 'portable-alpha', ['claude-code']);
    await commitManagedRemoval(selected, 'portable-alpha', ['claude-code']);
    const beforeManifest = manifestSource(['portable-alpha', 'retained-gamma']);
    const beforeLock = lockSourceFor(beforeManifest, selected.headSha, contentHash);
    const afterManifest = manifestSource(['retained-gamma']);
    const afterLock = lockSourceFor(afterManifest, selected.headSha, contentHash);
    await Promise.all([
      writeFile(join(root, 'skillsmith.toml'), beforeManifest),
      writeFile(join(root, 'skillsmith.lock'), beforeLock),
    ]);
    await seedCrashBoundary(root, 'manifest', afterManifest, afterLock);

    const result = await runUninstall(
      selected.env,
      {
        targets: ['portable-alpha'],
        tools: ['claude-code'],
        scope: 'user',
        cwd: selected.base,
        configuration: selected.configuration,
      },
      await depsFor(selected, 'automatic-sibling-handoff'),
    );
    if (!result.ok)
      throw new Error('message' in result.error ? result.error.message : result.error.code);
    const repaired = reportOf(result.value);
    expect(repaired.artifactSelection).toEqual({
      outcome: 'selected',
      selectedBy: 'user-owner',
    });
    expect(repaired.plan.operations.map(({ kind }) => kind)).toEqual(['write-lock']);
    expect(await readPair(root)).toEqual([afterManifest, afterLock]);
  });

  test('repairs an exact selected-tool reduction without removing the retained lock entry', async () => {
    const selected = await fleet();
    const root = join(selected.base, 'reduced-declaration-handoff');
    await mkdir(root, { recursive: true });
    const contentHash = await seedManagedPairs(selected, 'portable-alpha', [
      'claude-code',
      'codex',
    ]);
    await commitManagedRemoval(selected, 'portable-alpha', ['claude-code']);
    const alphaSingle = [
      'name = "portable-alpha"',
      'source = "fixture.invalid/acme/skills//skills/portable-alpha"',
      'tools = ["claude-code"]',
    ].join('\n');
    const beforeManifest = manifestSource(['portable-alpha', 'retained-gamma']).replace(
      alphaSingle,
      alphaSingle.replace('tools = ["claude-code"]', 'tools = ["claude-code", "codex"]'),
    );
    const afterManifest = beforeManifest.replace(
      'tools = ["claude-code", "codex"]',
      'tools = ["codex"]',
    );
    const beforeLock = lockSourceFor(beforeManifest, selected.headSha, contentHash);
    const afterLock = lockSourceFor(afterManifest, selected.headSha, contentHash);
    await Promise.all([
      writeFile(join(root, 'skillsmith.toml'), beforeManifest),
      writeFile(join(root, 'skillsmith.lock'), beforeLock),
    ]);
    await seedCrashBoundary(root, 'manifest', afterManifest, afterLock);

    const repaired = await runDeclaredUninstall(selected, root, ['portable-alpha']);
    expect(repaired.plan.operations.map(({ kind }) => kind)).toEqual(['write-lock']);
    expect(await readPair(root)).toEqual([afterManifest, afterLock]);
    expect(afterLock).toContain('name = "portable-alpha"');
  });

  test('refuses reduced recovery when retained ledger path, representation, or source drifts', async () => {
    for (const drift of ['placement-path', 'placement-representation', 'origin-source'] as const) {
      const selected = await fleet();
      const root = join(selected.base, `reduced-${drift}-drift`);
      const handoff = await prepareReducedHandoff(selected, root);
      const model = await readLedgerModel(selected);
      const pair = getPairAt(model, null, 'portable-alpha', 'codex');
      if (pair === null || pair.pinned == null || pair.origin === undefined) {
        throw new Error('missing retained Codex authority fixture');
      }
      const driftedPair =
        drift === 'placement-path'
          ? { ...pair, placementPath: join(selected.base, 'unrelated-custom-placement') }
          : drift === 'placement-representation'
            ? { ...pair, pinned: { ...pair.pinned, placement: 'copy' as const } }
            : {
                ...pair,
                origin: {
                  ...pair.origin,
                  source: 'fixture.invalid/acme/other//skills/portable-alpha',
                },
              };
      const drifted = withLedgerPairAt(model, null, 'portable-alpha', 'codex', driftedPair);
      if (!drifted.ok) throw new Error('failed to drift retained Codex authority fixture');
      await persistLedgerModel(selected, drifted.value);

      const refused = await runDeclaredUninstall(selected, root, ['portable-alpha']);
      expect(refused.plan.operations, drift).toEqual([]);
      expect(
        refused.results.every(({ action }) => action === 'refused'),
        drift,
      ).toBeTrue();
      expect(await readPair(root), drift).toEqual([handoff.afterManifest, handoff.beforeLock]);
    }
  });

  test('automatically selects an exact reduced sibling handoff with zero Git or network calls', async () => {
    const selected = await fleet();
    const root = join(selected.env.xdg.config, 'skillsmith');
    await mkdir(root, { recursive: true });
    const contentHash = await seedManagedPairs(selected, 'portable-alpha', [
      'claude-code',
      'codex',
    ]);
    await commitManagedRemoval(selected, 'portable-alpha', ['claude-code']);
    const beforeManifest = declarationWithTools(['claude-code', 'codex']);
    const afterManifest = beforeManifest.replace(
      'tools = ["claude-code", "codex"]',
      'tools = ["codex"]',
    );
    const beforeLock = lockSourceFor(beforeManifest, selected.headSha, contentHash);
    const afterLock = lockSourceFor(afterManifest, selected.headSha, contentHash);
    await Promise.all([
      writeFile(join(root, 'skillsmith.toml'), afterManifest),
      writeFile(join(root, 'skillsmith.lock'), beforeLock),
    ]);

    const externalCalls: string[] = [];
    const recoveryEnv = {
      ...selected.env,
      git: {
        findRepositoryRoot: async (
          ...args: Parameters<typeof selected.env.git.findRepositoryRoot>
        ) => {
          externalCalls.push('git.findRepositoryRoot');
          return selected.env.git.findRepositoryRoot(...args);
        },
        inspectWorktree: async (...args: Parameters<typeof selected.env.git.inspectWorktree>) => {
          externalCalls.push('git.inspectWorktree');
          return selected.env.git.inspectWorktree(...args);
        },
        resolveRemoteRef: async (...args: Parameters<typeof selected.env.git.resolveRemoteRef>) => {
          externalCalls.push('git.resolveRemoteRef');
          return selected.env.git.resolveRemoteRef(...args);
        },
        initializeFetch: async (...args: Parameters<typeof selected.env.git.initializeFetch>) => {
          externalCalls.push('git.initializeFetch');
          return selected.env.git.initializeFetch(...args);
        },
        fetchRef: async (...args: Parameters<typeof selected.env.git.fetchRef>) => {
          externalCalls.push('git.fetchRef');
          return selected.env.git.fetchRef(...args);
        },
        listTree: async (...args: Parameters<typeof selected.env.git.listTree>) => {
          externalCalls.push('git.listTree');
          return selected.env.git.listTree(...args);
        },
        readBlob: async (...args: Parameters<typeof selected.env.git.readBlob>) => {
          externalCalls.push('git.readBlob');
          return selected.env.git.readBlob(...args);
        },
        materializeTree: async (...args: Parameters<typeof selected.env.git.materializeTree>) => {
          externalCalls.push('git.materializeTree');
          return selected.env.git.materializeTree(...args);
        },
      },
      http: {
        request: async (...args: Parameters<typeof selected.env.http.request>) => {
          externalCalls.push('http.request');
          return selected.env.http.request(...args);
        },
      },
    };
    const result = await runUninstall(
      recoveryEnv,
      {
        targets: ['portable-alpha'],
        tools: ['claude-code'],
        scope: 'user',
        cwd: selected.base,
        configuration: selected.configuration,
      },
      await depsFor(selected, 'automatic-reduced-handoff'),
    );
    if (!result.ok)
      throw new Error('message' in result.error ? result.error.message : result.error.code);
    const repaired = reportOf(result.value);
    expect(repaired.artifactSelection).toEqual({ outcome: 'selected', selectedBy: 'user-owner' });
    expect(repaired.plan.operations.map(({ kind }) => kind)).toEqual(['write-lock']);
    expect(await readPair(root)).toEqual([afterManifest, afterLock]);
    expect(externalCalls).toEqual([]);
  });

  test('keeps explicit and automatic project reduced/final recovery free of Git and network', async () => {
    for (const selection of ['explicit', 'automatic'] as const) {
      for (const mode of ['reduced', 'final'] as const) {
        const selected = await fleet();
        const root =
          selection === 'automatic'
            ? selected.project
            : join(selected.base, `project-${selection}-${mode}`);
        await mkdir(root, { recursive: true });
        const beforeManifest = projectDeclarationWithTools(
          mode === 'reduced' ? ['claude-code', 'codex'] : ['claude-code'],
        );
        const afterManifest =
          mode === 'reduced'
            ? beforeManifest.replace('tools = ["claude-code", "codex"]', 'tools = ["codex"]')
            : manifestSource(['retained-gamma']).replaceAll('scope = "user"', 'scope = "project"');
        const staleLock = lockSourceFor(beforeManifest, selected.headSha);
        await Promise.all([
          writeFile(join(root, 'skillsmith.toml'), afterManifest),
          writeFile(join(root, 'skillsmith.lock'), staleLock),
        ]);
        const before = await readPair(root);
        const counted = countingExternalEnv(selected);
        const result = await runUninstall(
          counted.env,
          {
            targets: ['portable-alpha'],
            tools: ['claude-code'],
            scope: 'project',
            cwd: root,
            configuration: selected.configuration,
            ...(selection === 'explicit'
              ? {
                  file: join(root, 'skillsmith.toml'),
                  lockfile: join(root, 'skillsmith.lock'),
                }
              : {}),
          },
          await depsFor(selected, `project-${selection}-${mode}`),
        );
        if (!result.ok) {
          throw new Error('message' in result.error ? result.error.message : result.error.code);
        }
        const refused = reportOf(result.value);
        expect(refused.plan.operations, `${selection}-${mode}`).toEqual([]);
        expect(await readPair(root), `${selection}-${mode}`).toEqual(before);
        expect(counted.calls, `${selection}-${mode}`).toEqual([]);
      }
    }
  });

  test('refuses split automatic sibling owners before snapshot planning or writes', async () => {
    const selected = await fleet();
    const userRoot = join(selected.env.xdg.config, 'skillsmith');
    const projectRoot = selected.project;
    await mkdir(userRoot, { recursive: true });
    const beforeManifest = manifestSource(['portable-alpha', 'retained-gamma']);
    const afterManifest = manifestSource(['retained-gamma']);
    const staleLock = lockSourceFor(beforeManifest, selected.headSha);
    await Promise.all([
      writeFile(join(userRoot, 'skillsmith.toml'), afterManifest),
      writeFile(join(userRoot, 'skillsmith.lock'), staleLock),
      writeFile(join(projectRoot, 'skillsmith.toml'), afterManifest),
      writeFile(join(projectRoot, 'skillsmith.lock'), staleLock),
    ]);
    const result = await runUninstall(
      selected.env,
      {
        targets: ['portable-alpha'],
        tools: ['claude-code'],
        cwd: projectRoot,
        configuration: selected.configuration,
      },
      await depsFor(selected, 'split-sibling-owners'),
    );
    if (!result.ok)
      throw new Error('message' in result.error ? result.error.message : result.error.code);
    const refused = reportOf(result.value);
    expect(refused.artifactSelection.outcome).toBe('refused');
    expect(refused.plan.operations).toEqual([]);
    expect(refused.results.every(({ action }) => action === 'refused')).toBeTrue();
    expect(await readPair(userRoot)).toEqual([afterManifest, staleLock]);
    expect(await readPair(projectRoot)).toEqual([afterManifest, staleLock]);
  });

  test('refuses rollback, intent/actual mismatch, and selected-pair disagreement authority', async () => {
    const rollbackFleet = await fleet();
    const rollbackHandoff = await prepareFinalHandoff(rollbackFleet);
    const rollbackModel = await readLedgerModel(rollbackFleet);
    const committed = rollbackModel.history.at(-1);
    if (committed === undefined) throw new Error('missing committed removal fixture');
    await persistLedgerModel(rollbackFleet, {
      ...rollbackModel,
      history: [
        ...rollbackModel.history.slice(0, -1),
        {
          ...committed,
          disposition: 'rollback',
          actual: { ...committed.actual, after: committed.actual.before, retained: [] },
        },
      ],
    });
    const rollback = await runDeclaredUninstall(rollbackFleet, rollbackHandoff.root, [
      'portable-alpha',
    ]);
    expect(rollback.plan.operations).toEqual([]);
    expect(rollback.results.every(({ action }) => action === 'refused')).toBeTrue();
    expect(await readPair(rollbackHandoff.root)).toEqual([
      rollbackHandoff.afterManifest,
      rollbackHandoff.beforeLock,
    ]);

    const mismatchFleet = await fleet();
    const mismatchHandoff = await prepareFinalHandoff(mismatchFleet);
    const mismatchModel = await readLedgerModel(mismatchFleet);
    const mismatch = structuredClone(mismatchModel.history.at(-1));
    if (mismatch === undefined) throw new Error('missing mismatched removal fixture');
    const mismatchedBefore = mismatch.actual.before.find(
      (actual) => actual.role === 'live' && actual.state === 'present',
    );
    if (mismatchedBefore?.role !== 'live' || mismatchedBefore.state !== 'present') {
      throw new Error('missing live before-image fixture');
    }
    const wrongHash = `sha256:${'b'.repeat(64)}` as ArtifactDigest;
    mismatchedBefore.contentHash = wrongHash;
    mismatchedBefore.repositoryRevision = { kind: 'resource', digest: wrongHash };
    await persistLedgerModel(mismatchFleet, {
      ...mismatchModel,
      history: [...mismatchModel.history.slice(0, -1), mismatch],
    });
    const mismatched = await runDeclaredUninstall(mismatchFleet, mismatchHandoff.root, [
      'portable-alpha',
    ]);
    expect(mismatched.plan.operations).toEqual([]);
    expect(mismatched.results.every(({ action }) => action === 'refused')).toBeTrue();
    expect(await readPair(mismatchHandoff.root)).toEqual([
      mismatchHandoff.afterManifest,
      mismatchHandoff.beforeLock,
    ]);

    const disagreementFleet = await fleet();
    const disagreementHandoff = await prepareFinalHandoff(disagreementFleet, [
      'claude-code',
      'codex',
    ]);
    const disagreementModel = await readLedgerModel(disagreementFleet);
    const codexIndex = disagreementModel.history.findIndex(
      ({ intent }) => intent.skill === 'portable-alpha' && intent.tool === 'codex',
    );
    const codex = structuredClone(disagreementModel.history[codexIndex]);
    if (codex === undefined) throw new Error('missing Codex removal fixture');
    const codexBefore = codex.actual.before.find(
      (actual) => actual.role === 'live' && actual.state === 'present',
    );
    if (codexBefore?.role !== 'live' || codexBefore.state !== 'present') {
      throw new Error('missing Codex before-image fixture');
    }
    codexBefore.contentHash = wrongHash;
    codexBefore.repositoryRevision = { kind: 'resource', digest: wrongHash };
    const disagreementHistory = [...disagreementModel.history];
    disagreementHistory[codexIndex] = codex;
    await persistLedgerModel(disagreementFleet, {
      ...disagreementModel,
      history: disagreementHistory,
    });
    const disagreement = await runDeclaredUninstall(
      disagreementFleet,
      disagreementHandoff.root,
      ['portable-alpha'],
      { tools: ['claude-code', 'codex'] },
    );
    expect(disagreement.plan.operations).toEqual([]);
    expect(disagreement.results.every(({ action }) => action === 'refused')).toBeTrue();
    expect(await readPair(disagreementHandoff.root)).toEqual([
      disagreementHandoff.afterManifest,
      disagreementHandoff.beforeLock,
    ]);
  });

  test('uses append order and refuses a later pair-affecting install supersession', async () => {
    const selected = await fleet();
    const handoff = await prepareFinalHandoff(selected);
    const model = await readLedgerModel(selected);
    const removal = model.history.at(-1);
    if (removal === undefined) throw new Error('missing removal authority fixture');
    await persistLedgerModel(selected, {
      ...model,
      history: [...model.history, supersedingInstallJournal(removal)],
    });

    const refused = await runDeclaredUninstall(selected, handoff.root, ['portable-alpha']);
    expect(refused.plan.operations).toEqual([]);
    expect(refused.results.every(({ action }) => action === 'refused')).toBeTrue();
    expect(await readPair(handoff.root)).toEqual([handoff.afterManifest, handoff.beforeLock]);
  });

  test('refuses a newer committed or nonterminal logical pair at a different path', async () => {
    for (const phase of ['committed', 'live'] as const) {
      const selected = await fleet();
      const handoff = await prepareFinalHandoff(selected);
      const model = await readLedgerModel(selected);
      const removal = model.history.at(-1);
      if (removal === undefined) throw new Error('missing default-path removal authority fixture');
      const relocated = relocatedRemovalJournal(
        removal,
        join(selected.base, `later-${phase}-custom-placement`, 'portable-alpha'),
        phase,
      );
      await persistLedgerModel(
        selected,
        phase === 'committed'
          ? { ...model, history: [...model.history, relocated] }
          : {
              ...model,
              transactions: { ...model.transactions, [relocated.transactionId]: relocated },
            },
      );

      const refused = await runDeclaredUninstall(selected, handoff.root, ['portable-alpha']);
      expect(refused.plan.operations, phase).toEqual([]);
      expect(
        refused.results.every(({ action }) => action === 'refused'),
        phase,
      ).toBeTrue();
      expect(await readPair(handoff.root), phase).toEqual([
        handoff.afterManifest,
        handoff.beforeLock,
      ]);
    }
  });

  test('refuses a nonterminal selected-pair transaction without completing its stale lock', async () => {
    const selected = await fleet();
    const contentHash = await seedManagedPairs(selected, 'portable-alpha', ['claude-code']);
    const controller = new AbortController();
    let reachedLive = false;
    const crashEnv = {
      ...selected.env,
      afterLedgerBarrier: async (barrier: Readonly<{ kind: string }>) => {
        if (barrier.kind !== 'writer-live-replace' || controller.signal.aborted) return;
        const state = await readLedgerState(selected.env, ledgerPathOf(selected.data));
        if (
          state.ok &&
          state.value.state === 'present' &&
          Object.values(state.value.model.transactions).some(
            ({ phase, intent }) =>
              phase === 'live' && intent.kind === 'remove' && intent.skill === 'portable-alpha',
          )
        ) {
          reachedLive = true;
          controller.abort();
        }
      },
    };
    const interrupted = await runUninstall(
      crashEnv,
      {
        targets: ['portable-alpha'],
        tools: ['claude-code'],
        scope: 'user',
        noSave: true,
        cwd: selected.base,
        configuration: selected.configuration,
        signal: controller.signal,
      },
      await depsFor(selected, 'pending-final-removal'),
    );
    if (!interrupted.ok) {
      throw new Error(
        'message' in interrupted.error ? interrupted.error.message : interrupted.error.code,
      );
    }
    expect(reachedLive).toBeTrue();
    const pendingModel = await readLedgerModel(selected);
    expect(Object.values(pendingModel.transactions)).toEqual([
      expect.objectContaining({
        phase: 'live',
        disposition: 'forward',
        intent: expect.objectContaining({ kind: 'remove', skill: 'portable-alpha' }),
      }),
    ]);

    const root = join(selected.base, 'pending-final-handoff');
    await mkdir(root, { recursive: true });
    const beforeManifest = manifestSource(['portable-alpha', 'retained-gamma']);
    const beforeLock = lockSourceFor(beforeManifest, selected.headSha, contentHash);
    const afterManifest = manifestSource(['retained-gamma']);
    await Promise.all([
      writeFile(join(root, 'skillsmith.toml'), afterManifest),
      writeFile(join(root, 'skillsmith.lock'), beforeLock),
    ]);
    const refused = await runDeclaredUninstall(selected, root, ['portable-alpha']);
    expect(refused.plan.operations.map(({ kind }) => kind)).toEqual(['remove']);
    expect(refused.plan.operations.some(({ kind }) => kind === 'write-lock')).toBeFalse();
    expect(await readPair(root)).toEqual([afterManifest, beforeLock]);

    const converged = await runDeclaredUninstall(selected, root, ['portable-alpha']);
    expect(converged.plan.operations.map(({ kind }) => kind)).toEqual(['write-lock']);
    expect(await readPair(root)).toEqual([
      afterManifest,
      lockSourceFor(afterManifest, selected.headSha, contentHash),
    ]);
  });

  test('preserves current promote sibling truth in both failure directions without artifacts', async () => {
    for (const continueOnError of [false, true]) {
      const selected = await fleet();
      const baseOptions = {
        targets: ['alpha', 'beta'] as const,
        noVerify: true,
        cwd: selected.base,
        projectRoot: null,
        configuration: selected.configuration,
      };
      const preview = await runPromote(
        selected.env,
        { ...baseOptions, dryRun: true },
        flipDepsFor(null),
      );
      if (!preview.ok) throw new Error('failed to preview promote ordering');
      const ordered = preview.value.plan.operations.filter(
        (operation): operation is typeof operation & { skill: string; tool: FlipTool } =>
          operation.skill !== null && operation.tool !== null,
      );
      const first = ordered[0];
      const later = ordered[1];
      if (first === undefined || later === undefined) throw new Error('missing promote groups');
      const failureEnv = {
        ...selected.env,
        rename: async (source: string, destination: string) => {
          if (destination.includes(`.skillsmith-backup-${first.skill}-`)) {
            throw new Error(`synthetic ${first.tool} promote collision`);
          }
          await selected.env.rename(source, destination);
        },
      };
      const result = await runPromote(
        failureEnv,
        {
          ...baseOptions,
          ...(continueOnError ? { continueOnError: true } : {}),
        },
        flipDepsFor(null),
      );
      if (!result.ok) throw new Error('promote first-group failure escaped the report boundary');
      expect(result.value.results.find(({ tool }) => tool === first.tool)?.action).toBe('failed');
      expect(result.value.results.find(({ tool }) => tool === later.tool)?.action).toBe(
        continueOnError ? 'flipped' : 'skipped',
      );
      expect(await selected.env.pathKind(join(selected.base, 'skillsmith.toml'))).toBe('absent');
      expect(await selected.env.pathKind(join(selected.base, 'skillsmith.lock'))).toBe('absent');
    }

    const inverseFleet = await fleet();
    const inverseOptions = {
      targets: ['alpha', 'beta'] as const,
      noVerify: true,
      cwd: inverseFleet.base,
      projectRoot: null,
      configuration: inverseFleet.configuration,
    };
    const inversePreview = await runPromote(
      inverseFleet.env,
      { ...inverseOptions, dryRun: true },
      flipDepsFor(null),
    );
    if (!inversePreview.ok) throw new Error('failed to preview inverse promote ordering');
    const inverseOrdered = inversePreview.value.plan.operations.filter(
      (operation): operation is typeof operation & { skill: string; tool: FlipTool } =>
        operation.skill !== null && operation.tool !== null,
    );
    const inverseFirst = inverseOrdered[0];
    const inverseLater = inverseOrdered[1];
    if (inverseFirst === undefined || inverseLater === undefined) {
      throw new Error('missing inverse promote groups');
    }
    const inverseFailureEnv = {
      ...inverseFleet.env,
      rename: async (source: string, destination: string) => {
        if (destination.includes(`.skillsmith-backup-${inverseLater.skill}-`)) {
          throw new Error(`synthetic ${inverseLater.tool} promote collision`);
        }
        await inverseFleet.env.rename(source, destination);
      },
    };
    const inverse = await runPromote(
      inverseFailureEnv,
      {
        ...inverseOptions,
        continueOnError: true,
      },
      flipDepsFor(null),
    );
    if (!inverse.ok) throw new Error('inverse promote failure escaped the report boundary');
    expect(inverse.value.results.find(({ skill }) => skill === inverseFirst.skill)?.action).toBe(
      'flipped',
    );
    expect(inverse.value.results.find(({ skill }) => skill === inverseLater.skill)?.action).toBe(
      'failed',
    );
    expect(await inverseFleet.env.pathKind(join(inverseFleet.base, 'skillsmith.toml'))).toBe(
      'absent',
    );
    expect(await inverseFleet.env.pathKind(join(inverseFleet.base, 'skillsmith.lock'))).toBe(
      'absent',
    );
  });

  test('retains post-terminal work, cancels every unstarted operation, and selects exit 130', async () => {
    const fixture = collisionPlan('continue-on-error');
    const controller = new AbortController();
    const calls: string[] = [];
    const results = await scheduleOperationPlan(
      fixture.plan,
      fixture.plan.operations.map((operation) => ({
        operationId: operation.operationId,
        groupId: operation.groupId,
        pairId: operation.pairId,
        actualBefore: operation.before,
        unstartedForce: null,
        execute: async () => {
          calls.push(operation.operationId);
          const result = createOperationExecutionResult({
            operationId: operation.operationId,
            outcome: 'succeeded',
            actualBefore: operation.before,
            actualAfter: operation.after,
            force: null,
            error: null,
          });
          if (operation.operationId === fixture.alphaLiveId) controller.abort();
          return result;
        },
      })),
      { signal: controller.signal },
    );
    const byId = new Map(results.map((result) => [result.operationId, result]));
    expect(byId.get(fixture.alphaLiveId)?.outcome).toBe('succeeded');
    expect(byId.get(fixture.betaLiveId)).toMatchObject({
      outcome: 'cancelled',
      actualAfter: fixture.plan.operations.find(
        ({ operationId }) => operationId === fixture.betaLiveId,
      )?.before,
    });
    expect(calls).not.toContain(fixture.betaLiveId);
    expect(selectExitCode([1, 7, 130])).toBe(130);
  });

  test('advances only committed durability revisions and retains failed lifecycle revisions', async () => {
    const fixture = collisionPlan('continue-on-error');
    const first = fixture.plan.operations[0];
    const second = fixture.plan.operations[1];
    if (first === undefined || second === undefined)
      throw new Error('missing lifecycle operations');
    const resourceId = 'ledger:p4a-ts02-receipts';
    const initial = lifecycleRevision(resourceId, 'a');
    const committed = lifecycleRevision(resourceId, 'b');
    let current = initial;
    const stagedExpected: ExpectedRevisionV1[] = [];
    const repository = {
      observe: async () => err({ code: 'unused' }),
      observeRevision: async () => ok(current),
      stage: async (request: Parameters<typeof stageLogicalRepositoryEditV1>[0]) => {
        stagedExpected.push(request.expectedRevision);
        return stageLogicalRepositoryEditV1({ ...request, observedRevision: current });
      },
    };
    const controller = createAcquisitionRepositoryLifecycleControllerV1({
      authority: {
        ledgerResourceId: resourceId,
        repositories: { ledger: repository, live: repository, store: repository },
      } as unknown as AcquisitionSnapshotAuthorityV1,
      snapshotId: `snapshot:v1:${'e'.repeat(64)}`,
      expectedRevisions: [initial],
    });
    const execute = async (
      operation: typeof first,
      outcome: 'succeeded' | 'failed',
      nextRevision?: ExpectedRevisionV1,
    ) => {
      const binding = controller.bind(
        operation,
        {
          operationId: operation.operationId,
          groupId: operation.groupId,
          pairId: operation.pairId,
          unstartedForce: null,
          observeActualBefore: async () => operation.before,
          execute: async () => {
            if (nextRevision !== undefined) current = nextRevision;
            return createOperationExecutionResult({
              operationId: operation.operationId,
              outcome,
              actualBefore: operation.before,
              actualAfter: outcome === 'succeeded' ? operation.after : operation.before,
              force: null,
              error:
                outcome === 'succeeded'
                  ? null
                  : { code: 'fixture-failed', message: 'fixture failed', remediation: 'retry' },
            });
          },
        },
        [resourceId],
      );
      return binding.execute({
        operationId: operation.operationId,
        groupId: operation.groupId,
        pairId: operation.pairId,
        actualBefore: operation.before,
        unstartedForce: null,
        execute: async () => {
          throw new Error('validated lifecycle binding must not be re-entered');
        },
      });
    };

    expect((await execute(first, 'succeeded', committed)).outcome).toBe('succeeded');
    expect((await execute(second, 'failed')).outcome).toBe('failed');
    expect(stagedExpected).toEqual([initial, committed]);
    expect(current).toEqual(committed);
  });

  test('SIGKILL after one durable live-pair commit leaves exact committed truth and converges', async () => {
    const selected = await fleet();
    const tools = ['claude-code', 'codex'] as const;
    await seedManagedPairs(selected, 'portable-alpha', tools);
    const coordinator = await crashAfterCommittedLivePair(selected, 'portable-alpha', tools);

    const interrupted = await readLedgerModel(selected);
    expect(interrupted.history).toHaveLength(1);
    expect(Object.keys(interrupted.transactions)).toEqual([]);
    const committed = interrupted.history[0];
    expect(committed).toMatchObject({
      disposition: 'forward',
      phase: 'committed',
      intent: { kind: 'remove', skill: 'portable-alpha' },
    });
    const removedTool = committed?.intent.tool;
    if (removedTool !== 'claude-code' && removedTool !== 'codex') {
      throw new Error('live-pair crash fixture did not commit one selected tool');
    }
    const retainedTool = removedTool === 'claude-code' ? 'codex' : 'claude-code';
    expect(getPairAt(interrupted, null, 'portable-alpha', removedTool)).toBeNull();
    expect(getPairAt(interrupted, null, 'portable-alpha', retainedTool)).not.toBeNull();
    expect(
      await selected.env.pathKind(placementPathFor(selected, removedTool, 'portable-alpha')),
    ).toBe('absent');
    expect(
      await selected.env.pathKind(placementPathFor(selected, retainedTool, 'portable-alpha')),
    ).toBe('symlink');
    expect(await coordinator.recovery.discover()).toEqual([]);

    const staleLeasePath = `${ledgerPathOf(selected.data)}.lock`;
    expect(await selected.env.pathKind(staleLeasePath)).toBe('dir');
    const expired = new Date(0);
    await utimes(staleLeasePath, expired, expired);

    const converged = await runUninstall(
      selected.env,
      {
        targets: ['portable-alpha'],
        tools,
        scope: 'user',
        noSave: true,
        cwd: selected.base,
        configuration: selected.configuration,
      },
      await depsFor(selected, 'after-live-pair-converge'),
    );
    if (!converged.ok) {
      throw new Error(
        `live-pair crash convergence failed: ${
          'message' in converged.error ? converged.error.message : converged.error.code
        }`,
      );
    }
    expect(converged.value.results.find(({ tool }) => tool === retainedTool)?.action).toBe(
      'removed',
    );
    expect(
      getPairAt(await readLedgerModel(selected), null, 'portable-alpha', retainedTool),
    ).toBeNull();
    expect(await selected.env.pathKind(staleLeasePath)).toBe('absent');

    const noop = await runUninstall(
      selected.env,
      {
        targets: ['portable-alpha'],
        tools,
        scope: 'user',
        noSave: true,
        cwd: selected.base,
        configuration: selected.configuration,
      },
      await depsFor(selected, 'after-live-pair-noop'),
    );
    if (!noop.ok) throw new Error('live-pair crash no-op failed');
    expect(noop.value.plan.operations).toEqual([]);
    expect(noop.value.results.every(({ action }) => action === 'noop')).toBeTrue();
  });

  test('renders the same current report in human/JSON form and publishes no atomicity promise', async () => {
    const selected = await fleet();
    const root = join(selected.base, 'reporting-parity');
    await mkdir(root, { recursive: true });
    const manifest = manifestSource(['portable-alpha', 'retained-gamma']);
    const lock = lockSourceFor(manifest, selected.headSha);
    await Promise.all([
      writeFile(join(root, 'skillsmith.toml'), manifest),
      writeFile(join(root, 'skillsmith.lock'), lock),
    ]);
    const report = await runDeclaredUninstall(selected, root, ['portable-alpha']);
    const operations = new Map(
      report.plan.operations.map((operation) => [operation.operationId, operation]),
    );
    for (const result of report.executionResults) {
      expect(result.outcome).toBe('succeeded');
      expect(result.actualAfter).toEqual(operations.get(result.operationId)?.after);
    }
    const human = renderUninstallHuman(report, 0);
    const json = renderUninstallJson(report);
    const wire = JSON.parse(json) as {
      results: readonly { skill: string; action: string }[];
      artifactEffects: readonly { groupId: string; outcome: string }[];
    };
    expect(wire.results.map(({ skill, action }) => [skill, action])).toEqual(
      report.results.map(({ skill, action }) => [skill, action]),
    );
    expect(wire.artifactEffects.map(({ groupId, outcome }) => [groupId, outcome])).toEqual(
      report.artifactEffects.map(({ groupId, outcome }) => [groupId, outcome]),
    );
    for (const result of report.results) expect(human).toContain(result.skill);
    expect(human).toContain('Exit code: 0');
    expect(`${human}\n${json}`.toLowerCase()).not.toContain('atomic');

    const cliEntrypoint = join(import.meta.dir, '../../../packages/cli/src/index.ts');
    const child = Bun.spawn([process.execPath, cliEntrypoint, 'uninstall', '--help'], {
      cwd: selected.base,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await child.exited).toBe(0);
    const help = await new Response(child.stdout).text();
    expect(help).toContain('skillsmith uninstall');
    expect(help).not.toContain('--atomic');
  });

  test('a lock-terminal crash is already converged and pre-start cancellation is zero-write', async () => {
    const selected = await fleet();
    const root = join(selected.base, 'lock-terminal-handoff');
    await mkdir(root, { recursive: true });
    const beforeManifest = manifestSource(['portable-alpha', 'retained-gamma']);
    const beforeLock = lockSourceFor(beforeManifest, selected.headSha);
    const afterManifest = manifestSource(['retained-gamma']);
    const afterLock = lockSourceFor(afterManifest, selected.headSha);
    await Promise.all([
      writeFile(join(root, 'skillsmith.toml'), beforeManifest),
      writeFile(join(root, 'skillsmith.lock'), beforeLock),
    ]);
    await seedCrashBoundary(root, 'lock', afterManifest, afterLock);
    expect(
      (await runDeclaredUninstall(selected, root, ['portable-alpha'])).plan.operations,
    ).toEqual([]);
    expect(await readPair(root)).toEqual([afterManifest, afterLock]);

    const cancellationRoot = join(selected.base, 'cancelled-before-start');
    await mkdir(cancellationRoot, { recursive: true });
    await Promise.all([
      writeFile(join(cancellationRoot, 'skillsmith.toml'), beforeManifest),
      writeFile(join(cancellationRoot, 'skillsmith.lock'), beforeLock),
    ]);
    const controller = new AbortController();
    controller.abort();
    const cancelled = await runUninstall(
      selected.env,
      {
        targets: ['portable-alpha'],
        tools: ['claude-code'],
        file: join(cancellationRoot, 'skillsmith.toml'),
        lockfile: join(cancellationRoot, 'skillsmith.lock'),
        cwd: selected.base,
        configuration: selected.configuration,
        signal: controller.signal,
      },
      await depsFor(selected, 'cancelled-before-start'),
    );
    expect(cancelled.ok).toBeFalse();
    expect(await readPair(cancellationRoot)).toEqual([beforeManifest, beforeLock]);
  });
});
