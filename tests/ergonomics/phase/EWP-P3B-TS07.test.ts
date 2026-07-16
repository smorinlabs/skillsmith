import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCliRuntimeAdapter } from '../../../packages/cli/src/runtime/adapter.ts';
import * as acquireExecution from '../../../packages/core/src/acquire/execute.ts';
import { createLifecycleApplicationServices } from '../../../packages/core/src/application/lifecycle-services.ts';
import { runDoctorApplication } from '../../../packages/core/src/application/read-services.ts';
import type {
  CurrentApplicationContext,
  InteractionPort,
} from '../../../packages/core/src/application/types.ts';
import {
  fromLedgerV1Dto,
  ledgerByteRevision,
  ledgerSemanticRevision,
  ledgerV2Codec,
} from '../../../packages/core/src/artifacts/ledger-codec.ts';
import type { LedgerModel } from '../../../packages/core/src/artifacts/ledger-types.ts';
import * as ledgerWriter from '../../../packages/core/src/artifacts/ledger-writer.ts';
import { resolveRuntimeConfiguration } from '../../../packages/core/src/config/runtime.ts';
import type { EffectiveConfig } from '../../../packages/core/src/config/types.ts';
import * as doctorRepair from '../../../packages/core/src/doctor/repair.ts';
import type { ScanEnv } from '../../../packages/core/src/env/types.ts';
import { cancelledError, flipFailedError, ledgerError } from '../../../packages/core/src/errors.ts';
import * as scheduler from '../../../packages/core/src/execution/scheduler.ts';
import * as publicCore from '../../../packages/core/src/index.ts';
import {
  OBSERVATION_EVENT_KINDS,
  type ObservationBundle,
  type ObserverEvent,
  createObservationEmitter,
  createOperationContext,
} from '../../../packages/core/src/observation/index.ts';
import type { PlacementExecutionInput } from '../../../packages/core/src/place/execute.ts';
import * as ledgerMigration from '../../../packages/core/src/place/ledger-migration.ts';
import { emptyLedger, setPair, writeLedger } from '../../../packages/core/src/place/ledger.ts';
import * as logicalTransactions from '../../../packages/core/src/place/logical-transactions.ts';
import { ledgerPathOf, storeRootOf } from '../../../packages/core/src/place/paths.ts';
import * as placementRecovery from '../../../packages/core/src/place/recovery.ts';
import { contentHashOf } from '../../../packages/core/src/place/store.ts';
import * as swap from '../../../packages/core/src/place/swap.ts';
import type {
  DevRecord,
  OriginRecord,
  PairRecord,
  PinnedRecord,
  SwapPlan,
  SwapRequest,
} from '../../../packages/core/src/place/types.ts';
import {
  type CurrentMutatorOperationPlan,
  type ExecutableOperation,
  type OperationDigest,
  type OperationExecutionOutcome,
  type OperationExecutionResult,
  type OperationImage,
  type OperationSource,
  type PlanningToolContext,
  canonicalPlanningString,
  createOperationExecutionResult,
  createOperationGroupId,
  createOperationId,
  createOperationPairId,
  createOperationPlan,
} from '../../../packages/core/src/planning/index.ts';
import { defaultRuntimePorts } from '../../../packages/core/src/ports/default.ts';
import type { RuntimePorts } from '../../../packages/core/src/ports/types.ts';
import { runVerify } from '../../../packages/core/src/verify/run.ts';
import { runtimePorts } from '../../../packages/core/tests/fixtures/runtime-ports.ts';

type UnknownRecord = Record<string, unknown>;
type AnyFunction = (...args: unknown[]) => unknown;

const ROOT = resolve(import.meta.dir, '../../..');
const FIXTURES = join(ROOT, 'tests', 'ergonomics', 'fixtures');
const V1_GOLDEN = join(FIXTURES, 'p2-ts08', 'ledger-v1.golden.json');
const absolute = (path: string): string => join(ROOT, path);
const present = (path: string): boolean => existsSync(absolute(path));
const source = (path: string): string =>
  present(path) ? readFileSync(absolute(path), 'utf8') : '';
const moduleRecord = (value: unknown): UnknownRecord => value as UnknownRecord;
const asFunction = (value: unknown): AnyFunction | null =>
  typeof value === 'function' ? (value as AnyFunction) : null;
const optionalModule = async (path: string, query: string): Promise<UnknownRecord | null> =>
  present(path)
    ? ((await import(`${pathToFileURL(absolute(path)).href}?${query}`)) as UnknownRecord)
    : null;

const CONTENT_HASH = `sha256:${'a'.repeat(64)}` as OperationDigest;
const SOURCE: OperationSource = Object.freeze({
  kind: 'portable',
  identity: Object.freeze({
    host: 'example.test',
    repository: 'fixture/repo',
    path: 'skills/alpha',
  }),
  requestedRef: null,
  resolvedSha: 'b'.repeat(40),
  sourcePath: 'skills/alpha',
  contentHash: CONTENT_HASH,
});

const operationFor = <ToolId extends string = 'codex'>(
  skill: string,
  tool: ToolId = 'codex' as ToolId,
): ExecutableOperation<ToolId> => {
  const planningContext: PlanningToolContext<ToolId> = {
    registry: {
      get: (id) => (id === tool ? { descriptor: { id: tool } } : undefined),
    },
    toolOrder: [tool],
  };
  const groupId = createOperationGroupId({
    domain: 'skillsmith.operation-group-identity',
    schemaVersion: 1,
    command: 'install',
    skill,
    source: SOURCE,
    scope: 'user',
    target: null,
  });
  const resource = Object.freeze({
    kind: 'live' as const,
    skill,
    tool,
    scope: 'user' as const,
    projectRoot: null,
    location: Object.freeze({
      kind: 'portable' as const,
      token: `skills/user/codex/${skill}`,
    }),
  });
  const pairId = createOperationPairId(
    {
      domain: 'skillsmith.operation-pair-identity',
      schemaVersion: 1,
      groupId,
      tool,
      resource,
    },
    planningContext,
  );
  const operationId = createOperationId(
    {
      domain: 'skillsmith.operation-identity',
      schemaVersion: 1,
      groupId,
      pairId,
      kind: 'install',
      skill,
      source: SOURCE,
      tool,
      scope: 'user',
    },
    planningContext,
  );
  const before: OperationImage = Object.freeze({ kind: 'absent', resource });
  const after: OperationImage = Object.freeze({
    kind: 'placement',
    resource,
    classification: 'pinned',
    representation: 'copy',
    linkTarget: null,
    dangling: false,
    source: SOURCE,
    contentHash: CONTENT_HASH,
  });
  return Object.freeze({
    operationId,
    groupId,
    pairId,
    kind: 'install',
    dependencyMetadata: Object.freeze({
      domain: 'skillsmith.operation-dependency',
      schemaVersion: 1,
      operationIds: Object.freeze([]),
    }),
    skill,
    source: SOURCE,
    tool,
    scope: 'user',
    before,
    after,
    reason: Object.freeze({ code: 'install-selected', message: 'fixture install selected' }),
    selectionSource: 'explicit-targets',
    preconditionIds: Object.freeze(['precondition:v1:fixture']),
    requiredCheckIds: Object.freeze([]),
    reversibility: Object.freeze({ kind: 'none', retentionResourceIds: Object.freeze([]) }),
    mutates: Object.freeze({ live: true, manifest: false, lock: false, ledger: true }),
    conflict: null,
  });
};

const planFor = (
  operations: readonly ExecutableOperation[],
  batchPolicy: CurrentMutatorOperationPlan['batchPolicy'] = 'fail-fast',
): CurrentMutatorOperationPlan =>
  createOperationPlan({
    domain: 'skillsmith.operation-plan',
    schemaVersion: 1,
    command: 'install',
    selection: {
      source: 'explicit-targets',
      skills: operations
        .map(({ skill }) => skill)
        .filter((skill): skill is string => skill !== null),
      tools: ['codex'],
      scopes: ['user'],
    },
    batchPolicy,
    operations,
    checks: [],
    diagnostics: [],
  });

const resultFor = (
  operation: ExecutableOperation,
  outcome: OperationExecutionOutcome,
): OperationExecutionResult =>
  createOperationExecutionResult({
    operationId: operation.operationId,
    outcome,
    actualBefore: operation.before,
    actualAfter: outcome === 'succeeded' ? operation.after : operation.before,
    force: null,
    error:
      outcome === 'failed'
        ? {
            code: 'fixture-failed',
            message: 'fixture failed',
            remediation: 'retry the fixture',
          }
        : null,
  });

const bindingFor = (
  operation: ExecutableOperation,
  execute: () => Promise<OperationExecutionResult>,
): UnknownRecord => ({
  operationId: operation.operationId,
  groupId: operation.groupId,
  pairId: operation.pairId,
  actualBefore: operation.before,
  unstartedForce: null,
  execute,
});

const observationFixture = (
  observer: (event: ObserverEvent) => void | PromiseLike<void> = () => {},
): Readonly<{
  bundle: ObservationBundle;
  events: ObserverEvent[];
}> => {
  const clock = Object.freeze({
    wallNowIso: () => '1970-01-01T00:00:00.000Z',
    monotonicMilliseconds: () => 10,
  });
  const context = createOperationContext({
    command: 'skillsmith install fixture/repo',
    workflow: 'install',
    clock,
    id: { nextId: () => 'command:v1:fixture' },
    operationId: 'command:v1:fixture',
  });
  const events: ObserverEvent[] = [];
  const emitter = createObservationEmitter({
    observer: {
      observe: (event) => {
        events.push(event);
        return observer(event);
      },
    },
    toolIds: ['codex'],
  });
  return Object.freeze({
    bundle: Object.freeze({ context, emitter }),
    events,
  });
};

const doctorScanEnv = (): ScanEnv => ({
  homeDir: '/doctor-fixture',
  path: [],
  platform: 'linux',
  xdg: {
    config: '/doctor-fixture/.config',
    data: '/doctor-fixture/.local/share',
    cache: '/doctor-fixture/.cache',
  },
  fileExists: async () => false,
  realpath: async (path) => path,
  listDir: async () => [],
  readText: async () => '',
  runVersion: async () => 'unknown',
  exec: async () => ({ code: 1, stdout: '', stderr: '', timedOut: false }),
  pathKind: async () => 'absent',
  isExecutable: async () => false,
  readBytes: async () => new Uint8Array(),
  readLink: async () => '',
  makeSymlink: async () => {},
  rename: async () => {},
  copyTree: async () => {},
  removeTree: async () => {},
  makeDir: async () => {},
  writeTextFile: async () => {},
  fsyncFile: async () => {},
  fsyncDir: async () => {},
  withFileLock: (_path, operation) => operation(),
  modifiedAt: async () => null,
});

const doctorApplicationContext = (observation: ObservationBundle): CurrentApplicationContext => {
  const config: EffectiveConfig = {
    value: {},
    sources: {},
    layers: {
      defaults: {},
      system: {},
      user: {},
      project: {},
      'explicit-file': {},
      env: {},
      cli: {},
    },
    paths: {},
  };
  const interaction: InteractionPort = {
    mode: 'noninteractive',
    choose: async () => ({ status: 'refused', reason: 'unused by doctor preview fixture' }),
    confirm: async () => ({ status: 'refused', reason: 'unused by doctor preview fixture' }),
  };
  return {
    observation,
    ports: runtimePorts(doctorScanEnv()),
    artifactCoordinator: {} as CurrentApplicationContext['artifactCoordinator'],
    configuration: resolveRuntimeConfiguration({}),
    interaction,
    invocationCwd: '/doctor-fixture',
    globalOptions: {},
    projectContext: {
      invocationCwd: '/doctor-fixture',
      effectiveCwd: '/doctor-fixture',
      projectRoot: '/doctor-fixture',
      projectIdentity: '/doctor-fixture',
      projectKind: 'git',
      discoveredConfigPath: null,
      explicitConfigPath: null,
    },
    effectiveConfig: config,
  };
};

const doctorObservationFixture = (): Readonly<{
  bundle: ObservationBundle;
  events: ObserverEvent[];
}> => {
  const events: ObserverEvent[] = [];
  const context = createOperationContext({
    command: 'skillsmith doctor --fix --dry-run --offline --tool codex --scope user',
    workflow: 'doctor',
    clock: {
      wallNowIso: () => NOW,
      monotonicMilliseconds: () => 0,
    },
    id: { nextId: () => 'command:v1:doctor-fixture' },
    operationId: 'command:v1:doctor-fixture',
  });
  return Object.freeze({
    bundle: Object.freeze({
      context,
      emitter: createObservationEmitter({
        observer: { observe: (event) => events.push(event) },
        toolIds: ['claude-code', 'codex', 'kilo-code', 'opencode'],
      }),
    }),
    events,
  });
};

const operationObservationFixture = (
  operation: ExecutableOperation<string>,
  observer: (event: ObserverEvent) => void | PromiseLike<void> = () => {},
  toolIds: readonly string[] = ['claude-code'],
): Readonly<{ bundle: ObservationBundle; events: ObserverEvent[] }> => {
  let monotonicMilliseconds = 20;
  const clock = Object.freeze({
    wallNowIso: () => '2026-07-16T00:00:00.000Z',
    monotonicMilliseconds: () => monotonicMilliseconds++,
  });
  const context = createOperationContext({
    command: 'skillsmith promote alpha --tool claude-code',
    workflow: 'promote',
    clock,
    id: { nextId: () => operation.operationId },
    operationId: operation.operationId,
    parentOperationId: 'command:v1:promote-fixture',
    groupId: operation.groupId,
    pairId: operation.pairId,
  });
  const events: ObserverEvent[] = [];
  return Object.freeze({
    bundle: Object.freeze({
      context,
      emitter: createObservationEmitter({
        observer: {
          observe: (event) => {
            events.push(event);
            return observer(event);
          },
        },
        toolIds,
      }),
    }),
    events,
  });
};

const NOW = '2026-07-16T00:00:00.000Z';
const canonicalLedger = (ledger: Parameters<typeof fromLedgerV1Dto>[0]): LedgerModel => {
  const converted = fromLedgerV1Dto(ledger);
  if (!converted.ok) throw new Error(`invalid swap fixture ledger: ${converted.error.reason}`);
  return converted.value;
};
const devRecord = (sourcePath: string): DevRecord => ({
  sourcePath,
  resolvedPath: sourcePath,
  repoRoot: null,
  sourceRelPath: null,
  remote: null,
  recordedAt: NOW,
});
const pinnedRecord = (storePath: string, rev: string, contentHash: string): PinnedRecord => ({
  storePath,
  rev,
  gitSha: null,
  dirty: false,
  contentHash,
  snapshotAt: NOW,
  verify: 'passed',
});

interface PromoteSwapFixture {
  readonly root: string;
  readonly env: RuntimePorts;
  readonly data: string;
  readonly placementPath: string;
  readonly sourcePath: string;
  readonly storePath: string;
  readonly operation: ExecutableOperation;
  readonly plan: SwapPlan;
  readonly request: SwapRequest;
  readonly phases: string[];
  readonly transactionId: string;
}

const buildPromoteSwapFixture = async (
  onPersist?: (model: LedgerModel) => void,
  reuseRoot?: string,
): Promise<PromoteSwapFixture> => {
  const root = reuseRoot ?? (await mkdtemp(join(tmpdir(), 'skillsmith-p3b-ts07-')));
  try {
    if (reuseRoot !== undefined) {
      await rm(root, { recursive: true, force: true });
      await mkdir(root, { recursive: true });
    }
    const runtime = await defaultRuntimePorts();
    const data = join(root, 'data');
    const sourcePath = join(root, 'source', 'alpha');
    const storePath = join(storeRootOf(data), 'fixture', 'alpha');
    const skillsRoot = join(root, 'home', '.claude', 'skills');
    const placementPath = join(skillsRoot, 'alpha');
    const env: RuntimePorts = {
      ...runtime,
      homeDir: join(root, 'home'),
      xdg: {
        config: join(root, 'home', '.config'),
        data: join(root, 'home', '.local', 'share'),
        cache: join(root, 'home', '.cache'),
      },
      wallNowIso: () => NOW,
      epochMilliseconds: () => 0,
      monotonicMilliseconds: () => 0,
      nextId: (purpose) => `fixture-${purpose}`,
    };
    await Promise.all([
      mkdir(data, { recursive: true }),
      mkdir(sourcePath, { recursive: true }),
      mkdir(storePath, { recursive: true }),
      mkdir(skillsRoot, { recursive: true }),
    ]);
    const skillBytes = '# alpha\n\nDeterministic G3B-06 fixture.\n';
    await Promise.all([
      writeFile(join(sourcePath, 'SKILL.md'), skillBytes),
      writeFile(join(storePath, 'SKILL.md'), skillBytes),
    ]);
    await symlink(sourcePath, placementPath, 'dir');
    const hashed = await contentHashOf(env, storePath);
    if (!hashed.ok) throw new Error(`swap fixture hash failed: ${hashed.error.message}`);
    const contentHash = hashed.value;
    const pinned = pinnedRecord(storePath, 'fixture-rev', contentHash);
    const legacy = emptyLedger(NOW);
    setPair(legacy, 'alpha', 'claude-code', {
      placementPath,
      mode: 'dev',
      dev: devRecord(sourcePath),
      pinned: null,
      journal: null,
    });
    const ledger = canonicalLedger(legacy);
    const sourceIdentity: OperationSource = Object.freeze({
      ...SOURCE,
      contentHash: contentHash as OperationDigest,
    });
    const groupId = createOperationGroupId({
      domain: 'skillsmith.operation-group-identity',
      schemaVersion: 1,
      command: 'promote',
      skill: 'alpha',
      source: sourceIdentity,
      scope: 'user',
      target: null,
    });
    const resource = Object.freeze({
      kind: 'live' as const,
      skill: 'alpha',
      tool: 'claude-code' as const,
      scope: 'user' as const,
      projectRoot: null,
      location: Object.freeze({ kind: 'machine-bound' as const, path: placementPath }),
    });
    const pairId = createOperationPairId({
      domain: 'skillsmith.operation-pair-identity',
      schemaVersion: 1,
      groupId,
      tool: 'claude-code',
      resource,
    });
    const operationId = createOperationId({
      domain: 'skillsmith.operation-identity',
      schemaVersion: 1,
      groupId,
      pairId,
      kind: 'promote',
      skill: 'alpha',
      source: sourceIdentity,
      tool: 'claude-code',
      scope: 'user',
    });
    const operation: ExecutableOperation = Object.freeze({
      operationId,
      groupId,
      pairId,
      kind: 'promote',
      dependencyMetadata: Object.freeze({
        domain: 'skillsmith.operation-dependency',
        schemaVersion: 1,
        operationIds: Object.freeze([]),
      }),
      skill: 'alpha',
      source: sourceIdentity,
      tool: 'claude-code',
      scope: 'user',
      before: Object.freeze({
        kind: 'placement',
        resource,
        classification: 'dev',
        representation: 'symlink',
        linkTarget: Object.freeze({ kind: 'machine-bound', path: sourcePath }),
        dangling: false,
        source: null,
        contentHash: null,
      }),
      after: Object.freeze({
        kind: 'placement',
        resource,
        classification: 'pinned',
        representation: 'copy',
        linkTarget: null,
        dangling: false,
        source: sourceIdentity,
        contentHash: contentHash as OperationDigest,
      }),
      reason: Object.freeze({ code: 'promote-selected', message: 'fixture promote selected' }),
      selectionSource: 'explicit-targets',
      preconditionIds: Object.freeze(['precondition:v1:fixture']),
      requiredCheckIds: Object.freeze([]),
      reversibility: Object.freeze({ kind: 'none', retentionResourceIds: Object.freeze([]) }),
      mutates: Object.freeze({ live: true, manifest: false, lock: false, ledger: true }),
      conflict: null,
    });
    const plan: SwapPlan = {
      op: 'promote',
      skill: 'alpha',
      tool: 'claude-code',
      skillsRoot,
      placementPath,
      promote: {
        storePath,
        contentHash,
        pinned,
        devRecord: devRecord(sourcePath),
      },
    };
    const phases: string[] = [];
    const transactionId = 'aabbccdd';
    let durableLedger = ledger;
    const request: SwapRequest = {
      context: { env, logicalOperation: operation },
      state: { ledger },
      effects: {
        persistLedger: async (candidate) => {
          const written = await writeLedger(env, ledgerPathOf(data), candidate);
          if (!written.ok) return { ok: false, error: written.error, ledger: durableLedger };
          durableLedger = candidate;
          const journal =
            candidate.transactions[transactionId] ??
            candidate.history.find((entry) => entry.transactionId === transactionId);
          if (journal !== undefined && phases.at(-1) !== journal.phase) phases.push(journal.phase);
          onPersist?.(candidate);
          return { ok: true, ledger: candidate };
        },
        journalNow: () => NOW,
        newTransactionId: () => transactionId,
      },
    };
    return Object.freeze({
      root,
      env,
      data,
      placementPath,
      sourcePath,
      storePath,
      operation,
      plan,
      request,
      phases,
      transactionId,
    });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
};

const destroyPromoteSwapFixture = (fixture: PromoteSwapFixture): Promise<void> =>
  rm(fixture.root, { recursive: true, force: true });

const durableSwapSnapshot = async (
  fixture: PromoteSwapFixture,
  result: unknown,
): Promise<UnknownRecord> => {
  const liveHash = await contentHashOf(fixture.env, fixture.placementPath);
  const storeHash = await contentHashOf(fixture.env, fixture.storePath);
  if (!liveHash.ok || !storeHash.ok) throw new Error('cannot hash durable swap parity fixture');
  return {
    result,
    ledgerBytes: [...(await fixture.env.readBytes(ledgerPathOf(fixture.data)))],
    final: {
      liveKind: await fixture.env.pathKind(fixture.placementPath),
      liveHash: liveHash.value,
      liveSkillBytes: [...(await fixture.env.readBytes(join(fixture.placementPath, 'SKILL.md')))],
      storeKind: await fixture.env.pathKind(fixture.storePath),
      storeHash: storeHash.value,
      storeSkillBytes: [...(await fixture.env.readBytes(join(fixture.storePath, 'SKILL.md')))],
      residue: (await fixture.env.listDir(fixture.plan.skillsRoot))
        .filter((entry) => entry.startsWith('.skillsmith-'))
        .sort(),
    },
  };
};

const durableRecoverySnapshot = async (
  lane: string,
  recoverObserved: AnyFunction,
  observer: ((event: ObserverEvent) => void | PromiseLike<void>) | null,
): Promise<UnknownRecord> => {
  const controller = new AbortController();
  let fixture: PromoteSwapFixture | null = null;
  fixture = await buildPromoteSwapFixture((model) => {
    if (model.transactions[fixture?.transactionId ?? '']?.phase === 'prepared') {
      controller.abort();
    }
  }, lane);
  try {
    const pending = await swap.runSwap(
      {
        ...fixture.request,
        context: {
          ...fixture.request.context,
          pauseAt: 'prepared',
          signal: controller.signal,
        },
      },
      fixture.plan,
    );
    if (pending.ok) throw new Error('recovery parity fixture did not retain a prepared journal');
    const input: PlacementExecutionInput = {
      env: fixture.env,
      ledgerPath: ledgerPathOf(fixture.data),
      ledger: pending.state.ledger,
      journalNow: () => '2026-07-16T00:00:01.000Z',
      newTransactionId: () => 'unused',
    };
    const recovered =
      observer === null
        ? await placementRecovery.recoverPlacement(input, 'resume', {
            skill: 'alpha',
            tool: 'claude-code',
          })
        : ((await recoverObserved(
            input,
            'resume',
            { skill: 'alpha', tool: 'claude-code' },
            operationObservationFixture(fixture.operation, observer).bundle,
          )) as Awaited<ReturnType<typeof placementRecovery.recoverPlacement>>);
    if (!recovered.ok) throw new Error('recovery parity fixture failed to resume');
    const committed = recovered.state.ledger.history.find(
      ({ transactionId }) => transactionId === fixture?.transactionId,
    );
    expect(committed?.context).toMatchObject({
      parentOperationId: fixture.operation.operationId,
      attempt: 2,
      startedAt: NOW,
    });
    return await durableSwapSnapshot(fixture, recovered);
  } finally {
    await destroyPromoteSwapFixture(fixture);
  }
};

const prepareLedgerMigrationFixture = async (
  path: string,
): Promise<
  Readonly<{
    state: Readonly<{
      state: 'present';
      sourceVersion: 1;
      bytes: Uint8Array;
      byteRevision: ReturnType<typeof ledgerByteRevision>;
      semanticRevision: ReturnType<typeof ledgerByteRevision>;
      model: LedgerModel;
    }>;
    operation: ExecutableOperation;
  }>
> => {
  const bytes = new Uint8Array(await readFile(V1_GOLDEN));
  await writeFile(path, bytes);
  const decoded = ledgerV2Codec.decode(bytes);
  if (!decoded.ok) throw new Error('invalid V1 ledger migration fixture');
  const semantic = ledgerSemanticRevision(decoded.value.model);
  if (!semantic.ok) throw new Error('invalid V1 ledger semantic revision fixture');
  const state = Object.freeze({
    state: 'present' as const,
    sourceVersion: 1 as const,
    bytes,
    byteRevision: ledgerByteRevision(bytes),
    semanticRevision: semantic.value,
    model: decoded.value.model,
  });
  return Object.freeze({
    state,
    operation: ledgerMigration.ledgerMigrationOperation('install', 'explicit-targets', path, state),
  });
};

const requireFutureFunction = (
  module: UnknownRecord | null,
  name: string,
  message: string,
): AnyFunction | null => {
  expect(module, message).not.toBeNull();
  if (module === null) return null;
  const fn = asFunction(module[name]);
  expect(fn, message).not.toBeNull();
  return fn;
};

describe('EWP-P3B-TS07 — causal lifecycle execution and recovery', () => {
  describe('family 1 — registry and static ownership', () => {
    test('EWP-P3B-TS07 characterization: the closed observation registry remains exact', () => {
      expect(OBSERVATION_EVENT_KINDS).toEqual([
        'command.started',
        'command.completed',
        'plan.created',
        'operation.started',
        'operation.completed',
        'tool.detection.started',
        'tool.detection.completed',
        'tool.verification.started',
        'tool.verification.completed',
        'transaction.stage.started',
        'transaction.stage.completed',
        'transaction.committed',
        'transaction.rolled-back',
        'recovery.started',
        'recovery.completed',
      ]);
      expect(Object.isFrozen(OBSERVATION_EVENT_KINDS)).toBeTrue();
    });

    test('EWP-P3B-TS07 contract: one private execution observation authority owns deferred events', async () => {
      const authority = await optionalModule(
        'packages/core/src/execution/observation.ts',
        'ewp-p3b-ts07-family-1',
      );
      expect(authority, 'missing private G3B-06 execution observation authority').not.toBeNull();
      if (authority === null) return;
      expect(
        asFunction(authority.emitOperationPlanCreated),
        'missing G3B-06 private plan observation seam',
      ).not.toBeNull();
      expect(moduleRecord(publicCore).emitOperationPlanCreated).toBeUndefined();
    });
  });

  describe('family 2 — deterministic plan identity and purity', () => {
    test('EWP-P3B-TS07 characterization: canonical plans have observation-independent bytes', () => {
      const plan = planFor([operationFor('alpha')]);
      const before = canonicalPlanningString(plan);
      const digest = createHash('sha256').update(before).digest('hex');
      expect(digest).toHaveLength(64);
      expect(canonicalPlanningString(structuredClone(plan))).toBe(before);
      expect(canonicalPlanningString(plan)).toBe(before);
    });

    test('EWP-P3B-TS07 contract: plan.created uses the canonical private plan identity', async () => {
      const authority = await optionalModule(
        'packages/core/src/execution/observation.ts',
        'ewp-p3b-ts07-family-2',
      );
      const emitPlan = requireFutureFunction(
        authority,
        'emitOperationPlanCreated',
        'missing G3B-06 plan.created emission',
      );
      if (emitPlan === null) return;
      const plan = planFor([operationFor('alpha')]);
      const fixture = observationFixture();
      const bytes = canonicalPlanningString(plan);
      const expected = `plan:v1:${createHash('sha256').update(bytes).digest('hex')}`;
      emitPlan(fixture.bundle, plan);
      expect(fixture.events).toMatchObject([
        {
          kind: 'plan.created',
          operationId: 'command:v1:fixture',
          parentOperationId: null,
          planId: expected,
          operationCount: 1,
        },
      ]);
      expect(canonicalPlanningString(plan)).toBe(bytes);
    });

    test('EWP-P3B-TS07 contract: acquisition and application emit only completed plans', async () => {
      const operation = operationFor('acquisition-plan');
      const plan = planFor([operation]);
      const explicit = observationFixture();
      const acquired = await acquireExecution.runAcquisitionWithObservation(
        async (state) => {
          acquireExecution.emitAcquisitionPlanCreated(explicit.bundle, plan, state);
          return { ok: true as const, value: { plan } };
        },
        () => ledgerError('fixture acquisition failed'),
        explicit.bundle,
      );
      expect(acquired.ok).toBeTrue();
      expect(explicit.events).toHaveLength(1);
      expect(explicit.events[0]).toMatchObject({
        kind: 'plan.created',
        planId: `plan:v1:${createHash('sha256')
          .update(canonicalPlanningString(plan))
          .digest('hex')}`,
        operationCount: 1,
      });

      const emptyPlan = planFor([]);
      const preview = observationFixture();
      let installCalls = 0;
      const services = createLifecycleApplicationServices({
        install: (async (
          _env: unknown,
          _options: unknown,
          _dependencies: unknown,
          observation?: ObservationBundle,
        ) => {
          installCalls += 1;
          return acquireExecution.runAcquisitionWithObservation(
            async () => ({
              ok: true as const,
              value: {
                dryRun: true,
                requested: {
                  sources: ['fixture/repo'],
                  tools: ['codex'],
                  explicitTools: true,
                  scope: 'user',
                  explicitScope: true,
                  ref: null,
                  pin: false,
                  direct: false,
                  force: false,
                  verify: 'static',
                  deep: false,
                },
                results: [],
                summary: {
                  installed: 0,
                  updated: 0,
                  repaired: 0,
                  noop: 0,
                  skipped: 0,
                  refused: 0,
                  failed: 0,
                },
                plan: emptyPlan,
                executionResults: [],
              },
            }),
            () => ledgerError('fixture application acquisition failed'),
            observation,
          );
        }) as never,
      });
      const previewOutcome = await services.install(
        {
          arguments: [['fixture/repo']],
          options: { tool: ['codex'], dryRun: true, verify: true },
        },
        doctorApplicationContext(preview.bundle),
      );
      expect(previewOutcome.exitClass).toBe('success');
      expect(previewOutcome.mutation).toMatchObject({ kind: 'preview', planned: 0 });
      expect(installCalls).toBe(1);
      expect(preview.events).toHaveLength(1);
      expect(preview.events[0]).toMatchObject({
        kind: 'plan.created',
        operationCount: 0,
      });

      const refused = observationFixture();
      const refusalOutcome = await services.install(
        {
          arguments: [['fixture/repo']],
          options: { tool: ['codex'], dryRun: true, yes: true },
        },
        doctorApplicationContext(refused.bundle),
      );
      expect(refusalOutcome).toMatchObject({ exitClass: 'usage', mutation: { kind: 'none' } });
      expect(installCalls).toBe(1);
      expect(refused.events).toEqual([]);

      const failed = observationFixture();
      const acquisitionFailure = await acquireExecution.runAcquisitionWithObservation(
        async () => ({ ok: false as const, error: ledgerError('fixture planned failure') }),
        () => ledgerError('fixture sanitized failure'),
        failed.bundle,
      );
      expect(acquisitionFailure).toEqual({
        ok: false,
        error: ledgerError('fixture sanitized failure'),
      });
      expect(failed.events).toEqual([]);

      const thrown = observationFixture();
      const acquisitionThrow = await acquireExecution.runAcquisitionWithObservation(
        async () => {
          throw new Error('fixture planning threw');
        },
        () => ledgerError('fixture sanitized throw'),
        thrown.bundle,
      );
      expect(acquisitionThrow).toEqual({
        ok: false,
        error: ledgerError('fixture sanitized throw'),
      });
      expect(thrown.events).toEqual([]);
    });
  });

  describe('family 3 — command to actually-started operation identity', () => {
    test('EWP-P3B-TS07 characterization: current scheduler synthesizes unstarted cancellation', async () => {
      const operation = operationFor('alpha');
      const plan = planFor([operation]);
      const calls: string[] = [];
      const controller = new AbortController();
      controller.abort();
      const results = await scheduler.scheduleOperationPlan(
        plan,
        [
          bindingFor(operation, async () => {
            calls.push(operation.operationId);
            return resultFor(operation, 'succeeded');
          }),
        ] as never,
        { signal: controller.signal },
      );
      expect(calls).toEqual([]);
      expect(results.map(({ outcome }) => outcome)).toEqual(['cancelled']);
    });

    test('EWP-P3B-TS07 contract: observed scheduling derives context only for started bindings', async () => {
      const observed = asFunction(moduleRecord(scheduler).scheduleOperationPlanObserved);
      expect(observed, 'missing G3B-06 observed scheduler').not.toBeNull();
      if (observed === null) return;
      const first = operationFor('alpha');
      const second = operationFor('beta');
      const plan = planFor([first, second]);
      const fixture = observationFixture();
      const results = (await observed(
        plan,
        [
          bindingFor(first, async () => resultFor(first, 'failed')),
          bindingFor(second, async () => resultFor(second, 'succeeded')),
        ],
        {},
        fixture.bundle,
      )) as readonly OperationExecutionResult[];
      expect(results.map(({ outcome }) => outcome)).toEqual(['failed', 'skipped-after-failure']);
      expect(fixture.events.map(({ kind }) => kind)).toEqual([
        'operation.started',
        'operation.completed',
      ]);
      expect(fixture.events).toMatchObject([
        {
          operationId: first.operationId,
          parentOperationId: 'command:v1:fixture',
          groupId: first.groupId,
          pairId: first.pairId,
        },
        {
          operationId: first.operationId,
          parentOperationId: 'command:v1:fixture',
          groupId: first.groupId,
          pairId: first.pairId,
        },
      ]);
    });
  });

  describe('family 4 — exact operation outcome mapping', () => {
    test('EWP-P3B-TS07 characterization: execution results retain all five semantic outcomes', () => {
      const operation = operationFor('alpha');
      expect(
        ['succeeded', 'failed', 'cancelled', 'rolled-back', 'skipped-after-failure'].map(
          (outcome) => resultFor(operation, outcome as OperationExecutionOutcome).outcome,
        ),
      ).toEqual(['succeeded', 'failed', 'cancelled', 'rolled-back', 'skipped-after-failure']);
    });

    test('EWP-P3B-TS07 contract: observed scheduling emits exact completion outcomes and codes', async () => {
      const observed = asFunction(moduleRecord(scheduler).scheduleOperationPlanObserved);
      expect(observed, 'missing G3B-06 observed scheduler outcome mapping').not.toBeNull();
      if (observed === null) return;
      const expectations = [
        ['succeeded', 'success', null],
        ['failed', 'failure', 'fixture-failed'],
        ['cancelled', 'cancelled', 'cancelled'],
        ['rolled-back', 'success', null],
      ] as const;
      for (const [outcome, eventOutcome, errorCode] of expectations) {
        const operation = operationFor(`fixture-${outcome}`);
        const fixture = observationFixture();
        await observed(
          planFor([operation]),
          [bindingFor(operation, async () => resultFor(operation, outcome))],
          {},
          fixture.bundle,
        );
        const completed = fixture.events.find((event) => event.kind === 'operation.completed');
        expect(completed).toMatchObject({
          kind: 'operation.completed',
          operationKind: 'install',
          outcome: eventOutcome,
          errorCode,
          standaloneCount: null,
          bundledCount: null,
          resultCount: null,
        });
      }
      const operation = operationFor('fixture-throw');
      const fixture = observationFixture();
      const thrown = Object.freeze({ message: 'fixture throw' });
      await expect(
        observed(
          planFor([operation]),
          [
            bindingFor(operation, async () => {
              throw thrown;
            }),
          ],
          {},
          fixture.bundle,
        ),
      ).rejects.toBe(thrown);
      expect(fixture.events.at(-1)).toMatchObject({
        kind: 'operation.completed',
        outcome: 'failure',
        errorCode: 'execution-threw',
      });
      const cancelledOperation = operationFor('fixture-thrown-cancellation');
      const cancelledFixture = observationFixture();
      const cancelled = Object.freeze({ code: 'cancelled', message: 'fixture cancelled' });
      await expect(
        observed(
          planFor([cancelledOperation]),
          [
            bindingFor(cancelledOperation, async () => {
              throw cancelled;
            }),
          ],
          {},
          cancelledFixture.bundle,
        ),
      ).rejects.toBe(cancelled);
      expect(cancelledFixture.events.at(-1)).toMatchObject({
        kind: 'operation.completed',
        outcome: 'cancelled',
        errorCode: 'cancelled',
      });
    });

    test('EWP-P3B-TS07 contract: continue ordering and thrown cancellation forms stay exact', async () => {
      const first = operationFor('continue-failure');
      const second = operationFor('continue-success');
      const fixture = observationFixture();
      const continued = await scheduler.scheduleOperationPlanObserved(
        planFor([first, second], 'continue-on-error'),
        [
          bindingFor(first, async () => resultFor(first, 'failed')),
          bindingFor(second, async () => resultFor(second, 'succeeded')),
        ] as never,
        {},
        fixture.bundle,
      );
      expect(continued.map(({ outcome }) => outcome)).toEqual(['failed', 'succeeded']);
      expect(fixture.events.map(({ kind, operationId }) => [kind, operationId])).toEqual([
        ['operation.started', first.operationId],
        ['operation.completed', first.operationId],
        ['operation.started', second.operationId],
        ['operation.completed', second.operationId],
      ]);
      for (const event of fixture.events) {
        expect(event).toMatchObject({
          parentOperationId: 'command:v1:fixture',
          occurredAt: '1970-01-01T00:00:00.000Z',
          monotonicMilliseconds: 10,
        });
        if (event.kind === 'operation.completed') expect(event.durationMilliseconds).toBe(0);
      }

      for (const [skill, thrown] of [
        ['abort-code', Object.freeze({ code: 'ABORT_ERR', message: 'abort code fixture' })],
        ['abort-name', Object.freeze({ name: 'AbortError', message: 'abort name fixture' })],
      ] as const) {
        const operation = operationFor(skill);
        const observation = observationFixture();
        await expect(
          scheduler.scheduleOperationPlanObserved(
            planFor([operation]),
            [
              bindingFor(operation, async () => {
                throw thrown;
              }),
            ] as never,
            {},
            observation.bundle,
          ),
        ).rejects.toBe(thrown);
        expect(observation.events).toHaveLength(2);
        expect(observation.events.at(-1)).toMatchObject({
          kind: 'operation.completed',
          outcome: 'cancelled',
          errorCode: 'cancelled',
          durationMilliseconds: 0,
        });
      }

      const controller = new AbortController();
      const signalOperation = operationFor('abort-signal');
      const signalObservation = observationFixture();
      const signalThrown = Object.freeze({ message: 'signal abort fixture' });
      await expect(
        scheduler.scheduleOperationPlanObserved(
          planFor([signalOperation]),
          [
            bindingFor(signalOperation, async () => {
              controller.abort();
              throw signalThrown;
            }),
          ] as never,
          { signal: controller.signal },
          signalObservation.bundle,
        ),
      ).rejects.toBe(signalThrown);
      expect(signalObservation.events).toHaveLength(2);
      expect(signalObservation.events.at(-1)).toMatchObject({
        kind: 'operation.completed',
        outcome: 'cancelled',
        errorCode: 'cancelled',
        occurredAt: '1970-01-01T00:00:00.000Z',
        monotonicMilliseconds: 10,
        durationMilliseconds: 0,
      });
    });
  });

  describe('family 5 — durable placement transaction ownership', () => {
    test('EWP-P3B-TS07 characterization: swap remains the physical transaction authority', () => {
      expect(asFunction(moduleRecord(swap).runSwap)).not.toBeNull();
      expect(asFunction(moduleRecord(swap).resumeSwap)).not.toBeNull();
      expect(asFunction(moduleRecord(swap).rollbackSwap)).not.toBeNull();
      const text = source('packages/core/src/place/swap.ts');
      for (const phase of ['prepared', 'staged', 'backed-up', 'live', 'committed']) {
        expect(text).toContain(`'${phase}'`);
      }
    });

    test('EWP-P3B-TS07 contract: failed durable markers close once and stop later phases', async () => {
      for (const [label, error, outcome, errorCode] of [
        [
          'failure',
          ledgerError('fixture staged marker persistence failed'),
          'failure',
          'ledger-error',
        ],
        [
          'cancellation',
          cancelledError('fixture staged marker persistence cancelled'),
          'cancelled',
          'cancelled',
        ],
      ] as const) {
        const fixture = await buildPromoteSwapFixture();
        try {
          const observation = operationObservationFixture(fixture.operation);
          const persistLedger = fixture.request.effects.persistLedger;
          let durableLedger = fixture.request.state.ledger;
          const request: SwapRequest = {
            ...fixture.request,
            effects: {
              ...fixture.request.effects,
              persistLedger: async (candidate) => {
                const journal =
                  candidate.transactions[fixture.transactionId] ??
                  candidate.history.find(
                    ({ transactionId }) => transactionId === fixture.transactionId,
                  );
                if (journal?.phase === 'staged') {
                  return { ok: false, error, ledger: durableLedger };
                }
                const persisted = await persistLedger(candidate);
                durableLedger = persisted.ledger;
                return persisted;
              },
            },
          };
          const result = await swap.runSwapObserved(request, fixture.plan, observation.bundle);
          expect(result.ok, `${label} marker result`).toBeFalse();
          if (result.ok) continue;
          expect(result.error.code).toBe(errorCode);
          expect(fixture.phases).toEqual(['prepared']);
          expect(
            observation.events
              .filter(({ kind }) => kind === 'transaction.stage.started')
              .map(({ stage }) => stage),
          ).toEqual(['prepared', 'staged']);
          expect(
            observation.events
              .filter(({ kind }) => kind === 'transaction.stage.completed')
              .map(({ stage, outcome: stageOutcome, errorCode: stageCode }) => ({
                stage,
                outcome: stageOutcome,
                errorCode: stageCode,
              })),
          ).toEqual([
            { stage: 'prepared', outcome: 'success', errorCode: null },
            { stage: 'staged', outcome, errorCode },
          ]);
          expect(
            observation.events.some(
              ({ kind }) => kind === 'transaction.committed' || kind === 'transaction.rolled-back',
            ),
          ).toBeFalse();
        } finally {
          await destroyPromoteSwapFixture(fixture);
        }
      }
    });

    test('EWP-P3B-TS07 contract: pre-aborted canonical cleanup is cancelled before persistence or mutation', async () => {
      const fixture = await buildPromoteSwapFixture();
      try {
        const contentHash = await contentHashOf(fixture.env, fixture.storePath);
        if (!contentHash.ok) throw new Error('cannot hash pre-aborted cleanup fixture store');
        const digest = contentHash.value as OperationDigest;
        const baseOperation = operationFor('alpha');
        if (baseOperation.after.kind !== 'placement') {
          throw new Error('pre-aborted cleanup fixture operation is not a placement');
        }
        const resource = Object.freeze({
          ...baseOperation.before.resource,
          location: Object.freeze({
            kind: 'machine-bound' as const,
            path: fixture.placementPath,
          }),
        });
        const operation: ExecutableOperation = Object.freeze({
          ...baseOperation,
          before: Object.freeze({ kind: 'absent' as const, resource }),
          after: Object.freeze({
            ...baseOperation.after,
            resource,
            contentHash: digest,
          }),
        });
        const pair: PairRecord = {
          placementPath: fixture.placementPath,
          mode: 'pinned',
          dev: null,
          pinned: {
            ...pinnedRecord(fixture.storePath, 'fixture-rev', digest),
            placement: 'copy',
          },
          origin: {
            source: 'fixture/repo',
            host: 'example.test',
            repo: 'fixture/repo',
            skillPath: 'skills/alpha',
            refRequested: null,
            refResolved: 'b'.repeat(40),
            pin: false,
            installedAt: NOW,
          },
          journal: null,
        };
        const transactionId = 'c'.repeat(16);
        const seeded = await swap.commitRecordOnlyLogicalTransaction(
          {
            context: { env: fixture.env, logicalOperation: operation },
            state: { ledger: canonicalLedger(emptyLedger(NOW)) },
            effects: {
              persistLedger: async (candidate) => ({ ok: true, ledger: candidate }),
              journalNow: () => NOW,
              newTransactionId: () => transactionId,
            },
          },
          operation,
          pair,
          null,
        );
        if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
        const committed = seeded.state.ledger.history.find(
          (journal) => journal.transactionId === transactionId,
        );
        const terminalPair = seeded.state.ledger.skills.alpha?.tools.codex;
        expect(committed).toBeDefined();
        expect(terminalPair).toBeDefined();
        if (committed === undefined || terminalPair === undefined) return;
        const backupPath = join(
          fixture.plan.skillsRoot,
          `.skillsmith-backup-alpha-${transactionId}`,
        );
        const crashLedger: LedgerModel = {
          ...seeded.state.ledger,
          skills: {
            ...seeded.state.ledger.skills,
            alpha: {
              tools: {
                ...seeded.state.ledger.skills.alpha?.tools,
                codex: {
                  ...terminalPair,
                  journal: {
                    op: 'install',
                    txId: transactionId,
                    phase: 'committed',
                    startedAt: committed.context.startedAt,
                    completedAt: committed.completedAt,
                    before: { mode: 'absent' },
                    stagingPath: join(
                      fixture.plan.skillsRoot,
                      `.skillsmith-staging-alpha-${transactionId}`,
                    ),
                    backupPath,
                  },
                },
              },
            },
          },
        };
        expect(ledgerV2Codec.encode(crashLedger).ok).toBeFalse();
        await fixture.env.copyTree(fixture.storePath, backupPath);
        const controller = new AbortController();
        controller.abort();
        let persistCalls = 0;
        const request = (): SwapRequest => ({
          context: { env: fixture.env, signal: controller.signal },
          state: { ledger: crashLedger },
          effects: {
            persistLedger: async (candidate) => {
              persistCalls += 1;
              return { ok: true, ledger: candidate };
            },
            journalNow: () => NOW,
            newTransactionId: () => 'unused-cleanup-transaction',
          },
        });

        const baseline = await swap.sweepCommittedAcquireJournals(request());
        const observation = observationFixture();
        const observed = await swap.sweepCommittedAcquireJournalsObserved(
          request(),
          observation.bundle,
        );

        expect(baseline.ok).toBeFalse();
        expect(observed.ok).toBeFalse();
        if (baseline.ok || observed.ok) return;
        expect(observed.error).toEqual(baseline.error);
        expect(observed.error.code).toBe('cancelled');
        expect(observed.state).toEqual(baseline.state);
        expect(observed.state.ledger).toEqual(crashLedger);
        expect(persistCalls).toBe(0);
        expect(await fixture.env.pathKind(backupPath)).toBe('dir');
        expect(observation.events).toMatchObject([
          {
            kind: 'recovery.started',
            operationId: transactionId,
            recoveryKind: 'cleanup',
          },
          {
            kind: 'recovery.completed',
            operationId: transactionId,
            recoveryKind: 'cleanup',
            outcome: 'cancelled',
            errorCode: 'cancelled',
          },
        ]);
        expect(observation.events).toHaveLength(2);
      } finally {
        await destroyPromoteSwapFixture(fixture);
      }
    });

    test('EWP-P3B-TS07 contract: swap emits one correlated durable stage sequence', async () => {
      const observed = asFunction(moduleRecord(swap).runSwapObserved);
      expect(observed, 'missing G3B-06 observed swap authority').not.toBeNull();
      if (observed === null) return;
      const fixture = await buildPromoteSwapFixture();
      try {
        const observation = operationObservationFixture(fixture.operation);
        const result = (await observed(
          fixture.request,
          fixture.plan,
          observation.bundle,
        )) as Awaited<ReturnType<typeof swap.runSwap>>;
        expect(result.ok).toBeTrue();
        expect(fixture.phases).toEqual(['prepared', 'staged', 'backed-up', 'live', 'committed']);
        expect(observation.events.map(({ kind }) => kind)).toEqual([
          'transaction.stage.started',
          'transaction.stage.completed',
          'transaction.stage.started',
          'transaction.stage.completed',
          'transaction.stage.started',
          'transaction.stage.completed',
          'transaction.stage.started',
          'transaction.stage.completed',
          'transaction.stage.started',
          'transaction.stage.completed',
          'transaction.committed',
        ]);
        expect(
          observation.events
            .filter((event) => event.kind === 'transaction.stage.started')
            .map(({ stage }) => stage),
        ).toEqual(['prepared', 'staged', 'backed-up', 'live', 'committed']);
        for (const event of observation.events) {
          expect(event).toMatchObject({
            operationId: fixture.transactionId,
            parentOperationId: fixture.operation.operationId,
            groupId: fixture.operation.groupId,
            pairId: fixture.operation.pairId,
            attempt: 1,
          });
        }
        const committed = result.state.ledger.history.find(
          ({ transactionId }) => transactionId === fixture.transactionId,
        );
        expect(committed?.context).toMatchObject({
          parentOperationId: fixture.operation.operationId,
          attempt: 1,
          startedAt: NOW,
        });
      } finally {
        await destroyPromoteSwapFixture(fixture);
      }
      for (const pauseAt of ['backed-up', 'live'] as const) {
        const controller = new AbortController();
        let interrupted: PromoteSwapFixture | null = null;
        interrupted = await buildPromoteSwapFixture((model) => {
          if (model.transactions[interrupted?.transactionId ?? '']?.phase === pauseAt) {
            controller.abort();
          }
        });
        try {
          const observation = operationObservationFixture(interrupted.operation);
          const result = (await observed(
            {
              ...interrupted.request,
              context: {
                ...interrupted.request.context,
                pauseAt,
                signal: controller.signal,
              },
            },
            interrupted.plan,
            observation.bundle,
          )) as Awaited<ReturnType<typeof swap.runSwap>>;
          expect(result.ok).toBeFalse();
          expect(interrupted.phases.at(-1)).toBe(pauseAt);
          const expectedStages = ['prepared', 'staged', 'backed-up', 'live'].slice(
            0,
            pauseAt === 'backed-up' ? 3 : 4,
          );
          expect(
            observation.events
              .filter((event) => event.kind === 'transaction.stage.completed')
              .map(({ stage }) => stage),
          ).toEqual(expectedStages);
          expect(
            observation.events.some(({ kind }) => kind === 'transaction.committed'),
          ).toBeFalse();
        } finally {
          await destroyPromoteSwapFixture(interrupted);
        }
      }
      const acquireObserved = asFunction(
        moduleRecord(acquireExecution).executeAcquireReplacementObserved,
      );
      expect(
        acquireObserved,
        'missing G3B-06 observed acquisition-to-swap execution wrapper',
      ).not.toBeNull();
      if (acquireObserved === null) return;
      const acquired = await buildPromoteSwapFixture();
      try {
        await acquired.env.removeTree(acquired.placementPath);
        const contentHash = await contentHashOf(acquired.env, acquired.storePath);
        if (!contentHash.ok) throw new Error('cannot hash acquisition fixture store');
        const sourceIdentity: OperationSource = Object.freeze({
          ...SOURCE,
          contentHash: contentHash.value as OperationDigest,
        });
        const groupId = createOperationGroupId({
          domain: 'skillsmith.operation-group-identity',
          schemaVersion: 1,
          command: 'install',
          skill: 'alpha',
          source: sourceIdentity,
          scope: 'user',
          target: null,
        });
        const resource = Object.freeze({
          kind: 'live' as const,
          skill: 'alpha',
          tool: 'claude-code' as const,
          scope: 'user' as const,
          projectRoot: null,
          location: Object.freeze({
            kind: 'machine-bound' as const,
            path: acquired.placementPath,
          }),
        });
        const pairId = createOperationPairId({
          domain: 'skillsmith.operation-pair-identity',
          schemaVersion: 1,
          groupId,
          tool: 'claude-code',
          resource,
        });
        const operationId = createOperationId({
          domain: 'skillsmith.operation-identity',
          schemaVersion: 1,
          groupId,
          pairId,
          kind: 'install',
          skill: 'alpha',
          source: sourceIdentity,
          tool: 'claude-code',
          scope: 'user',
        });
        const before: OperationImage = Object.freeze({ kind: 'absent', resource });
        const after: OperationImage = Object.freeze({
          kind: 'placement',
          resource,
          classification: 'pinned',
          representation: 'copy',
          linkTarget: null,
          dangling: false,
          source: sourceIdentity,
          contentHash: contentHash.value as OperationDigest,
        });
        const operation: ExecutableOperation = Object.freeze({
          operationId,
          groupId,
          pairId,
          kind: 'install',
          dependencyMetadata: Object.freeze({
            domain: 'skillsmith.operation-dependency',
            schemaVersion: 1,
            operationIds: Object.freeze([]),
          }),
          skill: 'alpha',
          source: sourceIdentity,
          tool: 'claude-code',
          scope: 'user',
          before,
          after,
          reason: Object.freeze({ code: 'install-selected', message: 'fixture install selected' }),
          selectionSource: 'explicit-targets',
          preconditionIds: Object.freeze([]),
          requiredCheckIds: Object.freeze([]),
          reversibility: Object.freeze({ kind: 'none', retentionResourceIds: Object.freeze([]) }),
          mutates: Object.freeze({ live: true, manifest: false, lock: false, ledger: true }),
          conflict: null,
        });
        const origin: OriginRecord = {
          source: 'fixture/repo',
          host: 'example.test',
          repo: 'fixture/repo',
          skillPath: 'skills/alpha',
          refRequested: null,
          refResolved: 'b'.repeat(40),
          pin: false,
          installedAt: NOW,
        };
        const plan: SwapPlan = {
          op: 'install',
          skill: 'alpha',
          tool: 'claude-code',
          skillsRoot: acquired.plan.skillsRoot,
          placementPath: acquired.placementPath,
          install: {
            build: 'copy',
            storePath: acquired.storePath,
            contentHash: contentHash.value,
            pinned: {
              ...pinnedRecord(acquired.storePath, 'fixture-rev', contentHash.value),
              placement: 'copy',
            },
            origin,
            adoptedDev: null,
          },
        };
        const ledger = canonicalLedger(emptyLedger(NOW));
        const input: PlacementExecutionInput = {
          env: acquired.env,
          ledgerPath: ledgerPathOf(acquired.data),
          ledger,
          journalNow: () => NOW,
          newTransactionId: () => acquired.transactionId,
          logicalOperation: operation,
        };
        const observation = operationObservationFixture(operation);
        const result = (await acquireObserved(input, plan, null, observation.bundle)) as Awaited<
          ReturnType<typeof acquireExecution.executeAcquireReplacement>
        >;
        expect(result.ok).toBeTrue();
        if (!result.ok) return;
        expect(
          observation.events
            .filter((event) => event.kind === 'transaction.stage.completed')
            .map(({ stage }) => stage),
        ).toEqual(['prepared', 'staged', 'backed-up', 'live', 'committed']);
        expect(observation.events.at(-1)).toMatchObject({
          kind: 'transaction.committed',
          parentOperationId: operation.operationId,
        });
        const stagingPath = join(
          acquired.plan.skillsRoot,
          `.skillsmith-staging-alpha-${acquired.transactionId}`,
        );
        const backupPath = join(
          acquired.plan.skillsRoot,
          `.skillsmith-backup-alpha-${acquired.transactionId}`,
        );
        const pair = result.state.ledger.skills.alpha?.tools['claude-code'];
        const committed = result.state.ledger.history.find(
          ({ transactionId }) => transactionId === acquired.transactionId,
        );
        expect(pair).toBeDefined();
        expect(committed).toBeDefined();
        if (pair === undefined || committed === undefined) return;
        const legacyTransactionId = `${acquired.transactionId}:legacy`;
        const cleanupLedger: LedgerModel = {
          ...result.state.ledger,
          skills: {
            ...result.state.ledger.skills,
            alpha: {
              tools: {
                codex: {
                  ...pair,
                  placementPath: join(acquired.plan.skillsRoot, 'legacy-cleanup'),
                  journal: {
                    op: 'install',
                    txId: legacyTransactionId,
                    phase: 'committed',
                    startedAt: committed.context.startedAt,
                    completedAt: committed.completedAt,
                    before: { mode: 'absent' },
                    stagingPath: join(acquired.plan.skillsRoot, '.legacy-staging'),
                    backupPath: join(acquired.plan.skillsRoot, '.legacy-backup'),
                  },
                },
                'claude-code': {
                  ...pair,
                  journal: {
                    op: 'install',
                    txId: acquired.transactionId,
                    phase: 'committed',
                    startedAt: committed.context.startedAt,
                    completedAt: committed.completedAt,
                    before: { mode: 'absent' },
                    stagingPath,
                    backupPath,
                  },
                },
              },
            },
          },
        };
        // This is the exact in-memory crash window: the canonical install history is untouched,
        // while its terminal compatibility shadow has not yet been cleared. Settled v2 encoding
        // intentionally rejects that combination, so recovery must canonicalize before persisting.
        expect(ledgerV2Codec.encode(cleanupLedger).ok).toBeFalse();
        const { logicalOperation: _completedOperation, ...cleanupInput } = input;
        const parityLedgerPath = join(acquired.data, 'cleanup-parity.json');
        const parityWritten = await writeLedger(
          acquired.env,
          parityLedgerPath,
          result.state.ledger,
        );
        if (!parityWritten.ok) throw new Error(JSON.stringify(parityWritten.error));
        const cleanupBaseline = await placementRecovery.recoverCommittedAcquirePlacements({
          ...cleanupInput,
          ledgerPath: parityLedgerPath,
          ledger: cleanupLedger,
        });
        if (!cleanupBaseline.ok) throw new Error(JSON.stringify(cleanupBaseline.error));
        const cleanupObservation = observationFixture();
        const cleaned = await placementRecovery.recoverCommittedAcquirePlacementsObserved(
          { ...cleanupInput, ledger: cleanupLedger },
          cleanupObservation.bundle,
        );
        if (!cleaned.ok) throw new Error(JSON.stringify(cleaned.error));
        expect(cleaned.ok).toBeTrue();
        expect(cleaned.value).toEqual(cleanupBaseline.value);
        expect(cleaned.state.ledger).toEqual(cleanupBaseline.state.ledger);
        expect(cleaned.state.ledger.skills.alpha?.tools['claude-code']?.journal).toBeNull();
        expect(cleaned.state.ledger.skills.alpha?.tools.codex?.journal).toBeNull();
        expect(
          cleaned.state.ledger.history.find(
            ({ transactionId }) => transactionId === acquired.transactionId,
          ),
        ).toEqual(committed);
        expect(await acquired.env.pathKind(acquired.placementPath)).toBe('dir');
        expect(cleanupObservation.events.map(({ kind }) => kind)).toEqual([
          'recovery.started',
          'recovery.completed',
        ]);
        expect(cleanupObservation.events).toMatchObject([
          {
            kind: 'recovery.started',
            operationId: acquired.transactionId,
            parentOperationId: committed.intent.operationId,
            groupId: committed.intent.groupId,
            pairId: committed.intent.pairId,
            attempt: committed.context.attempt,
            recoveryKind: 'cleanup',
          },
          {
            kind: 'recovery.completed',
            operationId: acquired.transactionId,
            parentOperationId: committed.intent.operationId,
            groupId: committed.intent.groupId,
            pairId: committed.intent.pairId,
            attempt: committed.context.attempt,
            recoveryKind: 'cleanup',
            outcome: 'success',
          },
        ]);
      } finally {
        await destroyPromoteSwapFixture(acquired);
      }
    });

    test('EWP-P3B-TS07 contract: canonical acquisition cleanup is atomic across update and remove targets', async () => {
      const fixture = await buildPromoteSwapFixture();
      try {
        const contentHash = await contentHashOf(fixture.env, fixture.storePath);
        if (!contentHash.ok) throw new Error('cannot hash canonical cleanup fixture store');
        const digest = contentHash.value as OperationDigest;
        const previousDigest = `sha256:${'c'.repeat(64)}` as OperationDigest;
        const sourceIdentity: OperationSource = Object.freeze({ ...SOURCE, contentHash: digest });
        const previousSourceIdentity: OperationSource = Object.freeze({
          ...SOURCE,
          resolvedSha: 'c'.repeat(40),
          contentHash: previousDigest,
        });
        const origin: OriginRecord = {
          source: 'fixture/repo',
          host: 'example.test',
          repo: 'fixture/repo',
          skillPath: 'skills/alpha',
          refRequested: null,
          refResolved: 'b'.repeat(40),
          pin: false,
          installedAt: NOW,
        };
        const pairFor = (placementPath: string): PairRecord => ({
          placementPath,
          mode: 'pinned',
          dev: null,
          pinned: {
            ...pinnedRecord(fixture.storePath, 'fixture-rev', digest),
            placement: 'copy',
          },
          origin,
          journal: null,
        });
        const operationForCleanup = (
          kind: 'update' | 'remove',
          skill: string,
          tool: 'claude-code' | 'codex',
          placementPath: string,
        ): ExecutableOperation => {
          const resource = Object.freeze({
            kind: 'live' as const,
            skill,
            tool,
            scope: 'user' as const,
            projectRoot: null,
            location: Object.freeze({ kind: 'machine-bound' as const, path: placementPath }),
          });
          const groupId = createOperationGroupId({
            domain: 'skillsmith.operation-group-identity',
            schemaVersion: 1,
            command: kind === 'remove' ? 'uninstall' : 'install',
            skill,
            source: kind === 'remove' ? null : sourceIdentity,
            scope: 'user',
            target: null,
          });
          const pairId = createOperationPairId({
            domain: 'skillsmith.operation-pair-identity',
            schemaVersion: 1,
            groupId,
            tool,
            resource,
          });
          const beforeSource = kind === 'update' ? previousSourceIdentity : sourceIdentity;
          const beforeDigest = kind === 'update' ? previousDigest : digest;
          const before: OperationImage = Object.freeze({
            kind: 'placement',
            resource,
            classification: 'pinned',
            representation: 'copy',
            linkTarget: null,
            dangling: false,
            source: beforeSource,
            contentHash: beforeDigest,
          });
          const after: OperationImage =
            kind === 'remove'
              ? Object.freeze({ kind: 'absent' as const, resource })
              : Object.freeze({ ...before, source: sourceIdentity, contentHash: digest });
          const operationId = createOperationId({
            domain: 'skillsmith.operation-identity',
            schemaVersion: 1,
            groupId,
            pairId,
            kind,
            skill,
            source: kind === 'remove' ? null : sourceIdentity,
            tool,
            scope: 'user',
          });
          return Object.freeze({
            operationId,
            groupId,
            pairId,
            kind,
            dependencyMetadata: Object.freeze({
              domain: 'skillsmith.operation-dependency',
              schemaVersion: 1,
              operationIds: Object.freeze([]),
            }),
            skill,
            source: kind === 'remove' ? null : sourceIdentity,
            tool,
            scope: 'user',
            before,
            after,
            reason: Object.freeze({
              code: `${kind}-selected`,
              message: `fixture ${kind} selected`,
            }),
            selectionSource: 'explicit-targets',
            preconditionIds: Object.freeze([]),
            requiredCheckIds: Object.freeze([]),
            reversibility: Object.freeze({ kind: 'none', retentionResourceIds: Object.freeze([]) }),
            mutates: Object.freeze({ live: true, manifest: false, lock: false, ledger: true }),
            conflict: null,
          });
        };

        const skillsRoot = fixture.plan.skillsRoot;
        const updatePair = pairFor(join(skillsRoot, 'alpha'));
        const removePair = pairFor(join(skillsRoot, 'beta'));
        const updateOperation = operationForCleanup(
          'update',
          'alpha',
          'claude-code',
          updatePair.placementPath,
        );
        const removeOperation = operationForCleanup(
          'remove',
          'beta',
          'codex',
          removePair.placementPath,
        );
        const seedCommitted = async (
          ledger: LedgerModel,
          operation: ExecutableOperation,
          pair: PairRecord,
          transactionId: string,
        ): Promise<LedgerModel> => {
          const request: SwapRequest = {
            context: { env: fixture.env, logicalOperation: operation },
            state: { ledger },
            effects: {
              persistLedger: async (candidate) => ({ ok: true, ledger: candidate }),
              journalNow: () => NOW,
              newTransactionId: () => transactionId,
            },
          };
          const committed = await swap.commitRecordOnlyLogicalTransaction(
            request,
            operation,
            pair,
            null,
          );
          if (!committed.ok) throw new Error(JSON.stringify(committed.error));
          return committed.state.ledger;
        };

        const updateTransactionId = 'a'.repeat(16);
        const removeTransactionId = 'b'.repeat(16);
        let canonical = canonicalLedger(emptyLedger(NOW));
        canonical = await seedCommitted(
          canonical,
          updateOperation,
          updatePair,
          updateTransactionId,
        );
        canonical = await seedCommitted(
          canonical,
          removeOperation,
          removePair,
          removeTransactionId,
        );
        const updateHistory = canonical.history.find(
          ({ transactionId }) => transactionId === updateTransactionId,
        );
        const removeHistory = canonical.history.find(
          ({ transactionId }) => transactionId === removeTransactionId,
        );
        const terminalUpdatePair = canonical.skills.alpha?.tools['claude-code'];
        expect(updateHistory).toBeDefined();
        expect(removeHistory).toBeDefined();
        expect(terminalUpdatePair).toBeDefined();
        expect(canonical.skills.beta).toBeUndefined();
        if (
          updateHistory === undefined ||
          removeHistory === undefined ||
          terminalUpdatePair === undefined
        ) {
          return;
        }
        expect(updateHistory.intent.before).not.toEqual(updateHistory.intent.after);
        const updateBackup = join(skillsRoot, `.skillsmith-backup-alpha-${updateTransactionId}`);
        const removeBackup = join(skillsRoot, `.skillsmith-backup-beta-${removeTransactionId}`);
        const updateShadow = {
          op: 'install' as const,
          txId: updateTransactionId,
          phase: 'committed' as const,
          startedAt: updateHistory.context.startedAt,
          completedAt: updateHistory.completedAt,
          before: {
            mode: 'pinned' as const,
            storePath: join(fixture.root, 'store', 'previous-alpha'),
            contentHash: previousDigest,
            liveKind: 'dir' as const,
          },
          stagingPath: join(skillsRoot, `.skillsmith-staging-alpha-${updateTransactionId}`),
          backupPath: updateBackup,
        };
        const removeShadow = {
          op: 'uninstall' as const,
          txId: removeTransactionId,
          phase: 'committed' as const,
          startedAt: removeHistory.context.startedAt,
          completedAt: removeHistory.completedAt,
          before: {
            mode: 'pinned' as const,
            storePath: fixture.storePath,
            contentHash: digest,
            liveKind: 'dir' as const,
          },
          stagingPath: join(skillsRoot, `.skillsmith-staging-beta-${removeTransactionId}`),
          backupPath: removeBackup,
        };
        const crashLedger: LedgerModel = {
          ...canonical,
          skills: {
            ...canonical.skills,
            alpha: {
              tools: {
                ...canonical.skills.alpha?.tools,
                'claude-code': { ...terminalUpdatePair, journal: updateShadow },
              },
            },
            beta: { tools: { codex: { ...removePair, journal: removeShadow } } },
          },
        };
        expect(ledgerV2Codec.encode(crashLedger).ok).toBeFalse();

        const restoreBackups = async (): Promise<void> => {
          await Promise.all([
            fixture.env.copyTree(fixture.storePath, updateBackup),
            fixture.env.copyTree(fixture.storePath, removeBackup),
          ]);
        };
        const requestFor = (writes: LedgerModel[], failPersistence = false): SwapRequest => ({
          context: { env: fixture.env },
          state: { ledger: crashLedger },
          effects: {
            persistLedger: async (candidate) => {
              expect(ledgerV2Codec.encode(candidate).ok).toBeTrue();
              writes.push(candidate);
              return failPersistence
                ? {
                    ok: false,
                    error: flipFailedError('fixture terminal cleanup persistence failed'),
                    ledger: crashLedger,
                  }
                : { ok: true, ledger: candidate };
            },
            journalNow: () => NOW,
            newTransactionId: () => 'unused-cleanup-transaction',
          },
        });

        await restoreBackups();
        const failedWrites: LedgerModel[] = [];
        const failed = await swap.sweepCommittedAcquireJournals(requestFor(failedWrites, true));
        expect(failed.ok).toBeFalse();
        expect(failedWrites).toHaveLength(1);
        expect(failed.state.ledger).toEqual(crashLedger);
        expect(await fixture.env.pathKind(updateBackup)).toBe('absent');
        expect(await fixture.env.pathKind(removeBackup)).toBe('absent');

        const baselineWrites: LedgerModel[] = [];
        const baseline = await swap.sweepCommittedAcquireJournals(requestFor(baselineWrites));
        if (!baseline.ok) throw new Error(JSON.stringify(baseline.error));
        expect(baselineWrites).toHaveLength(1);
        expect(await fixture.env.pathKind(updateBackup)).toBe('absent');
        expect(await fixture.env.pathKind(removeBackup)).toBe('absent');

        await restoreBackups();
        const observedWrites: LedgerModel[] = [];
        const observation = observationFixture();
        const observed = await swap.sweepCommittedAcquireJournalsObserved(
          requestFor(observedWrites),
          observation.bundle,
        );
        if (!observed.ok) throw new Error(JSON.stringify(observed.error));

        expect(observedWrites).toHaveLength(1);
        expect(observed.value).toEqual(baseline.value);
        expect(observed.state.ledger).toEqual(baseline.state.ledger);
        expect(observed.state.ledger.skills.alpha?.tools['claude-code']?.journal).toBeNull();
        expect(observed.state.ledger.skills.beta).toBeUndefined();
        expect(observed.state.ledger.history).toEqual(canonical.history);
        expect(ledgerV2Codec.encode(observed.state.ledger).ok).toBeTrue();
        expect(await fixture.env.pathKind(updateBackup)).toBe('absent');
        expect(await fixture.env.pathKind(removeBackup)).toBe('absent');
        expect(observation.events.map(({ kind }) => kind).sort()).toEqual([
          'recovery.completed',
          'recovery.completed',
          'recovery.started',
          'recovery.started',
        ]);
        expect(
          observation.events
            .filter(({ kind }) => kind === 'recovery.completed')
            .map(({ operationId, outcome }) => ({ operationId, outcome })),
        ).toEqual([
          { operationId: updateTransactionId, outcome: 'success' },
          { operationId: removeTransactionId, outcome: 'success' },
        ]);

        await restoreBackups();
        const gatewayPath = join(fixture.data, 'canonical-multi-cleanup.json');
        const gatewayBase = await writeLedger(fixture.env, gatewayPath, canonical);
        if (!gatewayBase.ok) throw new Error(JSON.stringify(gatewayBase.error));
        const gatewayResult = await placementRecovery.recoverCommittedAcquirePlacements({
          env: fixture.env,
          ledgerPath: gatewayPath,
          ledger: crashLedger,
          journalNow: () => NOW,
          newTransactionId: () => 'unused-cleanup-transaction',
        });
        if (!gatewayResult.ok) throw new Error(JSON.stringify(gatewayResult.error));
        const gatewaySemantic = ledgerSemanticRevision(gatewayResult.state.ledger);
        const baselineSemantic = ledgerSemanticRevision(baseline.state.ledger);
        expect(gatewaySemantic.ok).toBeTrue();
        expect(baselineSemantic.ok).toBeTrue();
        if (gatewaySemantic.ok && baselineSemantic.ok) {
          expect(gatewaySemantic.value).toBe(baselineSemantic.value);
        }
        expect(await fixture.env.pathKind(updateBackup)).toBe('absent');
        expect(await fixture.env.pathKind(removeBackup)).toBe('absent');
      } finally {
        await destroyPromoteSwapFixture(fixture);
      }
    });
  });

  describe('family 6 — recovery attempt correlation', () => {
    test('EWP-P3B-TS07 characterization: pending abort preserves start time and increments attempt', () => {
      const text = source('packages/core/src/place/logical-transactions.ts');
      expect(text).toContain('parentOperationId: pending.intent.operationId');
      expect(text).toContain('attempt: pending.context.attempt + 1');
      expect(text).toContain('startedAt: pending.context.startedAt');
      expect(
        asFunction(moduleRecord(logicalTransactions).abortPendingLogicalTransaction),
      ).not.toBeNull();
    });

    test('EWP-P3B-TS07 contract: rollback resume increments N to N+1 with exact terminal timing', async () => {
      const controller = new AbortController();
      let fixture: PromoteSwapFixture | null = null;
      fixture = await buildPromoteSwapFixture((model) => {
        if (model.transactions[fixture?.transactionId ?? '']?.phase === 'live') {
          controller.abort();
        }
      });
      try {
        const pending = await swap.runSwap(
          {
            ...fixture.request,
            context: {
              ...fixture.request.context,
              pauseAt: 'live',
              signal: controller.signal,
            },
          },
          fixture.plan,
        );
        expect(pending.ok).toBeFalse();
        expect(fixture.phases.at(-1)).toBe('live');
        const backupPath = join(
          fixture.plan.skillsRoot,
          `.skillsmith-backup-alpha-${fixture.transactionId}`,
        );
        expect(await fixture.env.pathKind(fixture.placementPath)).toBe('absent');
        expect(await fixture.env.pathKind(backupPath)).toBe('symlink');

        let injected = false;
        const failingEnv: RuntimePorts = {
          ...fixture.env,
          rename: async (sourcePath, destinationPath) => {
            if (
              !injected &&
              sourcePath === backupPath &&
              destinationPath === fixture?.placementPath
            ) {
              injected = true;
              throw Object.assign(new Error('fixture rollback restore failed'), { code: 'EIO' });
            }
            return fixture?.env.rename(sourcePath, destinationPath);
          },
        };
        const target = { skill: 'alpha' as const, tool: 'claude-code' as const };
        const failedObservation = operationObservationFixture(fixture.operation);
        const failed = await placementRecovery.recoverPlacementObserved(
          {
            env: failingEnv,
            ledgerPath: ledgerPathOf(fixture.data),
            ledger: pending.state.ledger,
            journalNow: () => '2026-07-16T00:00:01.000Z',
            newTransactionId: () => 'unused',
          },
          'rollback',
          target,
          failedObservation.bundle,
        );
        expect(failed.ok).toBeFalse();
        expect(injected).toBeTrue();
        const failedRecoveryEvents = failedObservation.events.filter(
          ({ kind }) => kind === 'recovery.started' || kind === 'recovery.completed',
        );
        expect(failedRecoveryEvents).toMatchObject([
          {
            kind: 'recovery.started',
            operationId: fixture.transactionId,
            parentOperationId: fixture.operation.operationId,
            groupId: fixture.operation.groupId,
            pairId: fixture.operation.pairId,
            attempt: 2,
            recoveryKind: 'rollback',
          },
          {
            kind: 'recovery.completed',
            operationId: fixture.transactionId,
            parentOperationId: fixture.operation.operationId,
            groupId: fixture.operation.groupId,
            pairId: fixture.operation.pairId,
            attempt: 2,
            recoveryKind: 'rollback',
            outcome: 'failure',
            errorCode: 'flip-failed',
          },
        ]);
        expect(failedRecoveryEvents).toHaveLength(2);
        const interruptedRollback = failed.state.ledger.transactions[fixture.transactionId];
        expect(interruptedRollback).toMatchObject({
          disposition: 'rollback',
          phase: 'prepared',
          context: {
            parentOperationId: fixture.operation.operationId,
            command: 'skillsmith-rollback',
            workflow: 'placement-swap',
            attempt: 2,
            startedAt: NOW,
          },
        });

        const retryObservation = operationObservationFixture(fixture.operation);
        const retried = await placementRecovery.recoverPlacementObserved(
          {
            env: fixture.env,
            ledgerPath: ledgerPathOf(fixture.data),
            ledger: failed.state.ledger,
            journalNow: () => '2026-07-16T00:00:02.000Z',
            newTransactionId: () => 'unused',
          },
          'rollback',
          target,
          retryObservation.bundle,
        );
        expect(retried.ok).toBeTrue();
        const history = retried.state.ledger.history.find(
          ({ transactionId }) => transactionId === fixture?.transactionId,
        );
        expect(history?.context).toMatchObject({
          parentOperationId: fixture.operation.operationId,
          command: 'skillsmith-rollback',
          workflow: 'placement-swap',
          attempt: 3,
          startedAt: NOW,
        });
        expect(retryObservation.events.map(({ kind }) => kind)).toEqual([
          'recovery.started',
          'transaction.stage.started',
          'transaction.stage.completed',
          'transaction.rolled-back',
          'recovery.completed',
        ]);
        expect(retryObservation.events).toMatchObject([
          { kind: 'recovery.started', attempt: 3, monotonicMilliseconds: 22 },
          { kind: 'transaction.stage.started', stage: 'committed', monotonicMilliseconds: 24 },
          {
            kind: 'transaction.stage.completed',
            stage: 'committed',
            outcome: 'success',
            monotonicMilliseconds: 25,
            durationMilliseconds: 1,
          },
          {
            kind: 'transaction.rolled-back',
            reasonCode: 'rollback-requested',
            monotonicMilliseconds: 27,
            durationMilliseconds: 3,
          },
          {
            kind: 'recovery.completed',
            outcome: 'success',
            errorCode: null,
            monotonicMilliseconds: 28,
            durationMilliseconds: 6,
          },
        ]);
        for (const event of retryObservation.events) {
          expect(event).toMatchObject({
            operationId: fixture.transactionId,
            parentOperationId: fixture.operation.operationId,
            groupId: fixture.operation.groupId,
            pairId: fixture.operation.pairId,
            attempt: 3,
            occurredAt: NOW,
          });
        }
        expect(await fixture.env.pathKind(fixture.placementPath)).toBe('symlink');
        expect(await fixture.env.readLink(fixture.placementPath)).toBe(fixture.sourcePath);
      } finally {
        await destroyPromoteSwapFixture(fixture);
      }
    });

    test('EWP-P3B-TS07 contract: recovery begins one atomic logical and physical attempt', async () => {
      const beginAttempt = asFunction(
        moduleRecord(logicalTransactions).beginTransactionRecoveryAttempt,
      );
      expect(beginAttempt, 'missing G3B-06 atomic recovery-attempt reducer').not.toBeNull();
      if (beginAttempt === null) return;
      const recoverObserved = asFunction(moduleRecord(placementRecovery).recoverPlacementObserved);
      expect(recoverObserved, 'missing G3B-06 observed placement recovery wrapper').not.toBeNull();
      if (recoverObserved === null) return;
      const controller = new AbortController();
      let fixture: PromoteSwapFixture | null = null;
      fixture = await buildPromoteSwapFixture((model) => {
        if (model.transactions[fixture?.transactionId ?? '']?.phase === 'prepared') {
          controller.abort();
        }
      });
      try {
        const pendingResult = await swap.runSwap(
          {
            ...fixture.request,
            context: {
              ...fixture.request.context,
              pauseAt: 'prepared',
              signal: controller.signal,
            },
          },
          fixture.plan,
        );
        expect(pendingResult.ok).toBeFalse();
        const before = pendingResult.state.ledger.transactions[fixture.transactionId];
        expect(before).toMatchObject({
          transactionId: fixture.transactionId,
          phase: 'prepared',
          context: { attempt: 1, startedAt: NOW },
        });
        if (before === undefined) return;
        const advanced = moduleRecord(
          beginAttempt(pendingResult.state.ledger, {
            transactionId: fixture.transactionId,
            command: 'skillsmith promote --resume alpha',
            workflow: 'promote-resume',
            updatedAt: '2026-07-16T00:00:01.000Z',
          }),
        );
        expect(advanced.ok).toBeTrue();
        if (advanced.ok !== true) return;
        const model = advanced.value as LedgerModel;
        const after = model.transactions[fixture.transactionId];
        expect(after?.context).toEqual({
          parentOperationId: fixture.operation.operationId,
          command: 'skillsmith promote --resume alpha',
          workflow: 'promote-resume',
          attempt: 2,
          startedAt: NOW,
        });
        expect(before.context.attempt).toBe(1);
        const shadow = model.skills.alpha?.tools['claude-code']?.journal;
        expect(shadow).toMatchObject({
          txId: fixture.transactionId,
          phase: 'prepared',
          startedAt: NOW,
        });
        const recoveryObservation = operationObservationFixture(fixture.operation);
        const recoveryInput: PlacementExecutionInput = {
          env: fixture.env,
          ledgerPath: ledgerPathOf(fixture.data),
          ledger: pendingResult.state.ledger,
          journalNow: () => '2026-07-16T00:00:01.000Z',
          newTransactionId: () => 'unused',
        };
        const recovered = await recoverObserved(
          recoveryInput,
          'resume',
          { skill: 'alpha', tool: 'claude-code' },
          recoveryObservation.bundle,
        );
        expect(moduleRecord(recovered).ok).toBeTrue();
        expect(recoveryObservation.events.map(({ kind }) => kind)).toEqual([
          'recovery.started',
          'transaction.stage.started',
          'transaction.stage.completed',
          'transaction.stage.started',
          'transaction.stage.completed',
          'transaction.stage.started',
          'transaction.stage.completed',
          'transaction.stage.started',
          'transaction.stage.completed',
          'transaction.committed',
          'recovery.completed',
        ]);
        expect(recoveryObservation.events[0]).toMatchObject({
          kind: 'recovery.started',
          recoveryKind: 'resume',
        });
        expect(recoveryObservation.events.at(-1)).toMatchObject({
          kind: 'recovery.completed',
          recoveryKind: 'resume',
          outcome: 'success',
          errorCode: null,
        });
        for (const event of recoveryObservation.events) {
          expect(event).toMatchObject({
            operationId: fixture.transactionId,
            parentOperationId: fixture.operation.operationId,
            groupId: fixture.operation.groupId,
            pairId: fixture.operation.pairId,
            attempt: 2,
          });
        }
      } finally {
        await destroyPromoteSwapFixture(fixture);
      }

      const rollbackController = new AbortController();
      let rollbackFixture: PromoteSwapFixture | null = null;
      rollbackFixture = await buildPromoteSwapFixture((model) => {
        if (model.transactions[rollbackFixture?.transactionId ?? '']?.phase === 'backed-up') {
          rollbackController.abort();
        }
      });
      try {
        const pending = await swap.runSwap(
          {
            ...rollbackFixture.request,
            context: {
              ...rollbackFixture.request.context,
              pauseAt: 'backed-up',
              signal: rollbackController.signal,
            },
          },
          rollbackFixture.plan,
        );
        expect(pending.ok).toBeFalse();
        const observation = operationObservationFixture(rollbackFixture.operation);
        const recovered = moduleRecord(
          await recoverObserved(
            {
              env: rollbackFixture.env,
              ledgerPath: ledgerPathOf(rollbackFixture.data),
              ledger: pending.state.ledger,
              journalNow: () => '2026-07-16T00:00:03.000Z',
              newTransactionId: () => 'unused',
            },
            'rollback',
            { skill: 'alpha', tool: 'claude-code' },
            observation.bundle,
          ),
        );
        expect(recovered.ok).toBeTrue();
        expect(observation.events[0]).toMatchObject({
          kind: 'recovery.started',
          recoveryKind: 'rollback',
        });
        expect(
          observation.events.some(({ kind }) => kind === 'transaction.rolled-back'),
        ).toBeTrue();
        expect(observation.events.at(-1)).toMatchObject({
          kind: 'recovery.completed',
          recoveryKind: 'rollback',
          outcome: 'success',
          errorCode: null,
        });
        expect(
          recovered.state.ledger.history.find(
            ({ transactionId }) => transactionId === rollbackFixture?.transactionId,
          )?.context,
        ).toMatchObject({
          parentOperationId: rollbackFixture.operation.operationId,
          command: 'skillsmith-rollback',
          workflow: 'placement-swap',
          attempt: 2,
          startedAt: NOW,
        });
        expect(await rollbackFixture.env.pathKind(rollbackFixture.placementPath)).toBe('symlink');
        expect(await rollbackFixture.env.readLink(rollbackFixture.placementPath)).toBe(
          rollbackFixture.sourcePath,
        );
      } finally {
        await destroyPromoteSwapFixture(rollbackFixture);
      }

      const cleanupObserved = asFunction(
        moduleRecord(placementRecovery).recoverCommittedAcquirePlacementsObserved,
      );
      expect(cleanupObserved, 'missing G3B-06 observed committed cleanup wrapper').not.toBeNull();
      if (cleanupObserved === null) return;
      const cleanupRoot = await mkdtemp(join(tmpdir(), 'skillsmith-p3b-ts07-cleanup-'));
      try {
        const runtime = await defaultRuntimePorts();
        const cleanupObservation = observationFixture();
        const cleaned = moduleRecord(
          await cleanupObserved(
            {
              env: runtime,
              ledgerPath: ledgerPathOf(join(cleanupRoot, 'data')),
              ledger: canonicalLedger(emptyLedger(NOW)),
              journalNow: () => NOW,
              newTransactionId: () => 'unused',
            },
            cleanupObservation.bundle,
          ),
        );
        expect(cleaned.ok).toBeTrue();
        expect(cleaned.value).toEqual([]);
        expect(cleanupObservation.events).toEqual([]);
      } finally {
        await rm(cleanupRoot, { recursive: true, force: true });
      }
    });

    test('EWP-P3B-TS07 contract: exhausted recovery attempts preserve observer parity', async () => {
      const controller = new AbortController();
      let fixture: PromoteSwapFixture | null = null;
      fixture = await buildPromoteSwapFixture((model) => {
        if (model.transactions[fixture?.transactionId ?? '']?.phase === 'prepared') {
          controller.abort();
        }
      });
      try {
        const pending = await swap.runSwap(
          {
            ...fixture.request,
            context: {
              ...fixture.request.context,
              pauseAt: 'prepared',
              signal: controller.signal,
            },
          },
          fixture.plan,
        );
        expect(pending.ok).toBeFalse();
        const pendingJournal = pending.state.ledger.transactions[fixture.transactionId];
        expect(pendingJournal).toBeDefined();
        if (pendingJournal === undefined) return;
        const exhaustedLedger: LedgerModel = {
          ...pending.state.ledger,
          transactions: {
            ...pending.state.ledger.transactions,
            [fixture.transactionId]: {
              ...pendingJournal,
              context: { ...pendingJournal.context, attempt: Number.MAX_SAFE_INTEGER },
            },
          },
        };
        const input: PlacementExecutionInput = {
          env: fixture.env,
          ledgerPath: ledgerPathOf(fixture.data),
          ledger: exhaustedLedger,
          journalNow: () => '2026-07-16T00:00:01.000Z',
          newTransactionId: () => 'unused',
        };
        const target = { skill: 'alpha' as const, tool: 'claude-code' as const };
        const unobserved = await placementRecovery.recoverPlacement(input, 'resume', target);
        const observation = operationObservationFixture(fixture.operation);
        const observed = await placementRecovery.recoverPlacementObserved(
          input,
          'resume',
          target,
          observation.bundle,
        );
        expect(observed).toEqual(unobserved);
        expect(observed.ok).toBeFalse();
        if (!observed.ok) {
          expect(observed.error.message).toContain('cannot begin placement recovery');
        }
        expect(observation.events).toEqual([]);
      } finally {
        await destroyPromoteSwapFixture(fixture);
      }
    });

    test('EWP-P3B-TS07 contract: attempt persistence failure, cancellation, and throws close recovery spans', async () => {
      const pendingFixture = async (): Promise<
        Readonly<{
          fixture: PromoteSwapFixture;
          pending: Awaited<ReturnType<typeof swap.runSwap>>;
        }>
      > => {
        const controller = new AbortController();
        let fixture: PromoteSwapFixture | null = null;
        fixture = await buildPromoteSwapFixture((model) => {
          if (model.transactions[fixture?.transactionId ?? '']?.phase === 'prepared') {
            controller.abort();
          }
        });
        const pending = await swap.runSwap(
          {
            ...fixture.request,
            context: {
              ...fixture.request.context,
              pauseAt: 'prepared',
              signal: controller.signal,
            },
          },
          fixture.plan,
        );
        if (pending.ok) {
          await destroyPromoteSwapFixture(fixture);
          throw new Error('attempt-persistence fixture did not retain a prepared journal');
        }
        return Object.freeze({ fixture, pending });
      };
      const recoveryInput = (
        fixture: PromoteSwapFixture,
        pending: Awaited<ReturnType<typeof swap.runSwap>>,
        env: RuntimePorts,
        signal?: AbortSignal,
      ): PlacementExecutionInput => ({
        env,
        ledgerPath: ledgerPathOf(fixture.data),
        ledger: pending.state.ledger,
        journalNow: () => '2026-07-16T00:00:05.000Z',
        newTransactionId: () => 'unused',
        ...(signal === undefined ? {} : { signal }),
      });
      const target = { skill: 'alpha' as const, tool: 'claude-code' as const };

      const failedAttempt = await pendingFixture();
      try {
        const failureObservation = operationObservationFixture(failedAttempt.fixture.operation);
        const failureEnv: RuntimePorts & {
          readonly afterLedgerBarrier: (barrier: Readonly<{ kind: string }>) => Promise<void>;
        } = {
          ...failedAttempt.fixture.env,
          afterLedgerBarrier: async (barrier) => {
            if (barrier.kind !== 'writer-stage-write') return;
            throw Object.assign(new Error('injected recovery attempt persistence failure'), {
              code: 'EIO',
            });
          },
        };
        const failed = await placementRecovery.recoverPlacementObserved(
          recoveryInput(failedAttempt.fixture, failedAttempt.pending, failureEnv),
          'resume',
          target,
          failureObservation.bundle,
        );
        expect(failed.ok).toBeFalse();
        if (failed.ok) throw new Error('attempt persistence failure was ignored');
        expect(failureObservation.events).toMatchObject([
          {
            kind: 'recovery.started',
            attempt: 2,
            recoveryKind: 'resume',
          },
          {
            kind: 'recovery.completed',
            attempt: 2,
            recoveryKind: 'resume',
            outcome: 'failure',
            errorCode: failed.error.code,
          },
        ]);
        expect(failureObservation.events).toHaveLength(2);

        const retryObservation = operationObservationFixture(failedAttempt.fixture.operation);
        const retried = await placementRecovery.recoverPlacementObserved(
          recoveryInput(failedAttempt.fixture, failed, failedAttempt.fixture.env),
          'resume',
          target,
          retryObservation.bundle,
        );
        expect(retried.ok).toBeTrue();
        expect(retryObservation.events[0]).toMatchObject({
          kind: 'recovery.started',
          attempt: 2,
        });
      } finally {
        await destroyPromoteSwapFixture(failedAttempt.fixture);
      }

      const cancelledAttempt = await pendingFixture();
      try {
        const controller = new AbortController();
        const cancellationObservation = operationObservationFixture(
          cancelledAttempt.fixture.operation,
        );
        const cancellationEnv: RuntimePorts & {
          readonly afterLedgerBarrier: (barrier: Readonly<{ kind: string }>) => Promise<void>;
        } = {
          ...cancelledAttempt.fixture.env,
          afterLedgerBarrier: async (barrier) => {
            if (barrier.kind === 'writer-stage-write') controller.abort();
          },
        };
        const cancelled = await placementRecovery.recoverPlacementObserved(
          recoveryInput(
            cancelledAttempt.fixture,
            cancelledAttempt.pending,
            cancellationEnv,
            controller.signal,
          ),
          'resume',
          target,
          cancellationObservation.bundle,
        );
        expect(cancelled.ok).toBeFalse();
        if (cancelled.ok) throw new Error('attempt persistence cancellation was ignored');
        expect(cancelled.error.code).toBe('cancelled');
        expect(cancellationObservation.events).toMatchObject([
          {
            kind: 'recovery.started',
            attempt: 2,
            recoveryKind: 'resume',
          },
          {
            kind: 'recovery.completed',
            attempt: 2,
            recoveryKind: 'resume',
            outcome: 'cancelled',
            errorCode: 'cancelled',
          },
        ]);
        expect(cancellationObservation.events).toHaveLength(2);
      } finally {
        await destroyPromoteSwapFixture(cancelledAttempt.fixture);
      }

      const thrownCancellationAttempt = await pendingFixture();
      try {
        const thrownCancellationObservation = operationObservationFixture(
          thrownCancellationAttempt.fixture.operation,
        );
        let thrownCancellation: unknown = null;
        try {
          await placementRecovery.recoverPlacementObserved(
            {
              ...recoveryInput(
                thrownCancellationAttempt.fixture,
                thrownCancellationAttempt.pending,
                thrownCancellationAttempt.fixture.env,
              ),
              journalNow: () => {
                throw Object.assign(new Error('injected thrown recovery cancellation'), {
                  name: 'AbortError',
                });
              },
            },
            'resume',
            target,
            thrownCancellationObservation.bundle,
          );
        } catch (error) {
          thrownCancellation = error;
        }
        expect(thrownCancellation).not.toBeNull();
        expect(thrownCancellationObservation.events).toMatchObject([
          {
            kind: 'recovery.started',
            attempt: 2,
            recoveryKind: 'resume',
          },
          {
            kind: 'recovery.completed',
            attempt: 2,
            recoveryKind: 'resume',
            outcome: 'cancelled',
            errorCode: 'cancelled',
          },
        ]);
        expect(thrownCancellationObservation.events).toHaveLength(2);
      } finally {
        await destroyPromoteSwapFixture(thrownCancellationAttempt.fixture);
      }

      const thrownAttempt = await pendingFixture();
      try {
        const thrownObservation = operationObservationFixture(thrownAttempt.fixture.operation);
        const throwingPorts = new Proxy(thrownAttempt.fixture.env, {
          get(targetPorts, property, receiver) {
            if (property === 'readFileMetadata') {
              throw Object.assign(new Error('injected unexpected recovery persistence throw'), {
                code: 'EIO',
              });
            }
            return Reflect.get(targetPorts, property, receiver);
          },
        });
        const throwingEnv = {
          ...thrownAttempt.fixture.env,
          ledgerWriterPorts: throwingPorts,
        } as RuntimePorts & { readonly ledgerWriterPorts: RuntimePorts };
        let thrown: unknown = null;
        try {
          await placementRecovery.recoverPlacementObserved(
            recoveryInput(thrownAttempt.fixture, thrownAttempt.pending, throwingEnv),
            'resume',
            target,
            thrownObservation.bundle,
          );
        } catch (error) {
          thrown = error;
        }
        expect(thrown).not.toBeNull();
        expect(thrownObservation.events).toMatchObject([
          {
            kind: 'recovery.started',
            attempt: 2,
            recoveryKind: 'resume',
          },
          {
            kind: 'recovery.completed',
            attempt: 2,
            recoveryKind: 'resume',
            outcome: 'failure',
            errorCode: 'EIO',
          },
        ]);
        expect(thrownObservation.events).toHaveLength(2);
      } finally {
        await destroyPromoteSwapFixture(thrownAttempt.fixture);
      }
    });
  });

  describe('family 7 — ledger migration and doctor repair', () => {
    test('EWP-P3B-TS07 characterization: existing migration cursors and doctor plans are deterministic', () => {
      const writer = source('packages/core/src/artifacts/ledger-writer.ts');
      for (const cursor of [
        'prepared',
        'staged',
        'backed-up',
        'replaced',
        'handed-off',
        'committed',
        'cleanup',
      ]) {
        expect(writer).toContain(`'${cursor}'`);
      }
      expect(asFunction(moduleRecord(doctorRepair).createDoctorRepairPlan)).not.toBeNull();
      expect(asFunction(moduleRecord(ledgerMigration).ledgerMigrationJournals)).not.toBeNull();
    });

    test('EWP-P3B-TS07 contract: migration recovery attempts are durable before pointer cleanup', async () => {
      const retryRoot = await mkdtemp(join(tmpdir(), 'skillsmith-p3b-ts07-ledger-retries-'));
      try {
        const path = join(retryRoot, 'placements.json');
        const { state, operation } = await prepareLedgerMigrationFixture(path);
        const journals = ledgerMigration.ledgerMigrationJournals(operation, NOW);
        const interrupted = await ledgerWriter.createTestNodeLedgerWriter(path, {
          afterBarrier: async ({ kind }) => {
            if (kind === 'migration-backup-copy') {
              throw Object.assign(new Error('fixture first migration interruption'), {
                code: 'cancelled',
              });
            }
          },
        });
        await expect(
          interrupted.migrateV1ToV2({
            expectedSourceByteRevision: state.byteRevision,
            expectedSourceSemanticRevision: state.semanticRevision,
            journals,
          }),
        ).rejects.toMatchObject({ code: 'cancelled' });
        expect((await interrupted.readMigrationRecoveryJournal()).value?.context.attempt).toBe(1);

        const second = await ledgerWriter.createTestNodeLedgerWriter(path, {
          afterBarrier: async ({ kind }) => {
            if (kind === 'migration-handoff-fsync') {
              throw Object.assign(new Error('fixture second migration interruption'), {
                code: 'cancelled',
              });
            }
          },
        });
        await expect(second.recoverMigration()).rejects.toMatchObject({ code: 'cancelled' });
        expect((await second.readMigrationRecoveryJournal()).value?.context.attempt).toBe(2);

        const runtime = await defaultRuntimePorts();
        const env: RuntimePorts = {
          ...runtime,
          wallNowIso: () => NOW,
          epochMilliseconds: () => 0,
          monotonicMilliseconds: () => 0,
        };
        const observation = operationObservationFixture(operation);
        let migratedModel: LedgerModel | null = null;
        const binding = ledgerMigration.ledgerMigrationExecutionBindingObserved(
          {
            env,
            ledgerPath: path,
            operation,
            expectedState: state,
            startedAt: NOW,
            onMigrated: (model) => {
              migratedModel = model;
            },
          },
          observation.bundle,
        );
        const recovered = await binding.execute({
          operationId: operation.operationId,
          groupId: operation.groupId,
          pairId: null,
          actualBefore: operation.before,
          unstartedForce: null,
          execute: async () => {
            throw new Error('validated binding callback must not run');
          },
        });
        expect(recovered.outcome).toBe('succeeded');
        expect(
          (migratedModel as LedgerModel | null)?.history.find(
            ({ transactionId }) => transactionId === journals.committed.transactionId,
          )?.context,
        ).toMatchObject({ attempt: 3, startedAt: NOW });
        expect(observation.events.at(0)).toMatchObject({
          kind: 'recovery.started',
          operationId: journals.committed.transactionId,
          parentOperationId: operation.operationId,
          attempt: 3,
          recoveryKind: 'resume',
        });
        expect(observation.events.at(-1)).toMatchObject({
          kind: 'recovery.completed',
          operationId: journals.committed.transactionId,
          parentOperationId: operation.operationId,
          attempt: 3,
          recoveryKind: 'resume',
          outcome: 'success',
          errorCode: null,
        });
        for (const event of observation.events) expect(event.attempt).toBe(3);
        const final = await ledgerWriter.createTestNodeLedgerWriter(path, {});
        expect(await final.readMigrationRecoveryJournal()).toEqual({ ok: true, value: null });
      } finally {
        await rm(retryRoot, { recursive: true, force: true });
      }

      const cleanupRoot = await mkdtemp(
        join(tmpdir(), 'skillsmith-p3b-ts07-ledger-pointer-cleanup-'),
      );
      try {
        const path = join(cleanupRoot, 'placements.json');
        const { state, operation } = await prepareLedgerMigrationFixture(path);
        const journals = ledgerMigration.ledgerMigrationJournals(operation, NOW);
        const interrupted = await ledgerWriter.createTestNodeLedgerWriter(path, {
          afterBarrier: async ({ kind }) => {
            if (kind === 'migration-backup-copy') {
              throw Object.assign(new Error('fixture pre-recovery interruption'), {
                code: 'cancelled',
              });
            }
          },
        });
        await expect(
          interrupted.migrateV1ToV2({
            expectedSourceByteRevision: state.byteRevision,
            expectedSourceSemanticRevision: state.semanticRevision,
            journals,
          }),
        ).rejects.toMatchObject({ code: 'cancelled' });

        const cleanupCrash = await ledgerWriter.createTestNodeLedgerWriter(path, {
          afterBarrier: async ({ kind }) => {
            if (kind === 'migration-pointer-cleanup') {
              throw Object.assign(new Error('fixture pointer-cleanup interruption'), {
                code: 'cancelled',
              });
            }
          },
        });
        await expect(cleanupCrash.recoverMigration()).rejects.toMatchObject({ code: 'cancelled' });
        expect(existsSync(cleanupCrash.recoveryPointerPath)).toBeFalse();

        const afterCrash = await ledgerWriter.createTestNodeLedgerWriter(path, {});
        const durable = await afterCrash.read();
        expect(durable.ok).toBeTrue();
        if (!durable.ok || durable.value.state !== 'present') return;
        expect(
          durable.value.model.history.find(
            ({ transactionId }) => transactionId === journals.committed.transactionId,
          )?.context,
        ).toMatchObject({ attempt: 2, startedAt: NOW });
        expect(await afterCrash.recoverMigration()).toEqual({ ok: true, value: null });
      } finally {
        await rm(cleanupRoot, { recursive: true, force: true });
      }
    });

    test('EWP-P3B-TS07 contract: malformed migration attempts preserve observer parity', async () => {
      const root = await mkdtemp(join(tmpdir(), 'skillsmith-p3b-ts07-ledger-attempt-parity-'));
      try {
        const path = join(root, 'placements.json');
        const { state, operation } = await prepareLedgerMigrationFixture(path);
        const journals = ledgerMigration.ledgerMigrationJournals(operation, NOW);
        const interrupted = await ledgerWriter.createTestNodeLedgerWriter(path, {
          afterBarrier: async ({ kind }) => {
            if (kind === 'migration-backup-copy') {
              throw Object.assign(new Error('fixture migration interruption'), {
                code: 'cancelled',
              });
            }
          },
        });
        await expect(
          interrupted.migrateV1ToV2({
            expectedSourceByteRevision: state.byteRevision,
            expectedSourceSemanticRevision: state.semanticRevision,
            journals,
          }),
        ).rejects.toMatchObject({ code: 'cancelled' });
        const pointer = JSON.parse(
          await readFile(interrupted.recoveryPointerPath, 'utf8'),
        ) as UnknownRecord;
        const pointerJournals = moduleRecord(pointer.journals);
        const prepared = moduleRecord(pointerJournals.prepared);
        const preparedContext = moduleRecord(prepared.context);
        preparedContext.attempt = 0;
        await writeFile(interrupted.recoveryPointerPath, `${JSON.stringify(pointer)}\n`);

        const runtime = await defaultRuntimePorts();
        const env: RuntimePorts = {
          ...runtime,
          wallNowIso: () => NOW,
          epochMilliseconds: () => 0,
          monotonicMilliseconds: () => 0,
        };
        const input = {
          env,
          ledgerPath: path,
          operation,
          expectedState: state,
          startedAt: NOW,
          onMigrated: () => {
            throw new Error('malformed migration must not report a migrated model');
          },
        };
        const validated = {
          operationId: operation.operationId,
          groupId: operation.groupId,
          pairId: null,
          actualBefore: operation.before,
          unstartedForce: null,
          execute: async () => {
            throw new Error('validated binding callback must not run');
          },
        };
        const unobserved = await ledgerMigration
          .ledgerMigrationExecutionBinding(input)
          .execute(validated);
        const observation = operationObservationFixture(operation);
        const observed = await ledgerMigration
          .ledgerMigrationExecutionBindingObserved(input, observation.bundle)
          .execute(validated);
        expect(observed).toEqual(unobserved);
        expect(observed).toMatchObject({
          outcome: 'failed',
          error: { code: 'ledger-invalid-state' },
        });
        expect(observation.events).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test('EWP-P3B-TS07 contract: durable cursor and doctor execution have narrow observed seams', async () => {
      const writerSource = source('packages/core/src/artifacts/ledger-writer.ts');
      const cursorNotification =
        /readonly\s+([A-Za-z][A-Za-z0-9]*)\?:\s*\(\s*cursor:\s*LedgerMigrationCursor\s*\)\s*=>\s*void/u.exec(
          writerSource,
        );
      expect(
        cursorNotification,
        'missing G3B-06 synchronous durable ledger cursor notification',
      ).not.toBeNull();
      if (cursorNotification === null) return;
      expect(writerSource).not.toContain("from '../observation");
      const root = await mkdtemp(join(tmpdir(), 'skillsmith-p3b-ts07-ledger-'));
      try {
        const path = join(root, 'placements.json');
        const { state, operation } = await prepareLedgerMigrationFixture(path);
        const journals = ledgerMigration.ledgerMigrationJournals(operation, NOW);
        let id = 0;
        const nextId = (purpose: 'stage' | 'cas' | 'owner'): string =>
          purpose === 'owner' ? 'c'.repeat(64) : (++id).toString(16).padStart(16, '0');
        const callbackName = cursorNotification[1] as string;
        const initial: string[] = [];
        const interruptedOptions: UnknownRecord = {
          nextId,
          [callbackName]: (cursor: string) => {
            initial.push(cursor);
            throw new Error('contained cursor observer failure');
          },
          afterBarrier: async ({ kind }: { readonly kind: string }) => {
            if (kind === 'migration-backup-copy') {
              throw Object.assign(new Error('fixture interruption'), { code: 'cancelled' });
            }
          },
        };
        const interrupted = await ledgerWriter.createTestNodeLedgerWriter(
          path,
          interruptedOptions as never,
        );
        await expect(
          interrupted.migrateV1ToV2({
            expectedSourceByteRevision: state.byteRevision,
            expectedSourceSemanticRevision: state.semanticRevision,
            journals,
          }),
        ).rejects.toMatchObject({ code: 'cancelled' });
        expect(initial).toEqual(['prepared', 'staged']);
        expect(existsSync(interrupted.recoveryPointerPath)).toBeTrue();

        const resumed: string[] = [];
        const recoveryOptions: UnknownRecord = {
          nextId,
          [callbackName]: (cursor: string) => {
            resumed.push(cursor);
            throw new Error('contained cursor observer failure');
          },
        };
        const recovery = await ledgerWriter.createTestNodeLedgerWriter(
          path,
          recoveryOptions as never,
        );
        const receipt = await recovery.recoverMigration();
        expect(receipt.ok).toBeTrue();
        if (!receipt.ok) return;
        expect(receipt.value?.resumed).toBeTrue();
        expect(resumed).toEqual(['backed-up', 'replaced', 'handed-off', 'committed', 'cleanup']);
        expect([...initial, ...resumed]).toEqual([
          'prepared',
          'staged',
          'backed-up',
          'replaced',
          'handed-off',
          'committed',
          'cleanup',
        ]);
        const beforeSecondRecovery = [...resumed];
        expect(await recovery.recoverMigration()).toEqual({ ok: true, value: null });
        expect(resumed).toEqual(beforeSecondRecovery);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
      const observedBindingFactory = asFunction(
        moduleRecord(ledgerMigration).ledgerMigrationExecutionBindingObserved,
      );
      expect(
        observedBindingFactory,
        'missing G3B-06 observed ledger-migration execution binding',
      ).not.toBeNull();
      if (observedBindingFactory === null) return;
      const mappingRoot = await mkdtemp(join(tmpdir(), 'skillsmith-p3b-ts07-ledger-events-'));
      try {
        const path = join(mappingRoot, 'placements.json');
        const { state, operation } = await prepareLedgerMigrationFixture(path);
        const runtime = await defaultRuntimePorts();
        const env: RuntimePorts = {
          ...runtime,
          wallNowIso: () => NOW,
          epochMilliseconds: () => 0,
          monotonicMilliseconds: () => 0,
        };
        const observation = operationObservationFixture(operation);
        let migratedModel: LedgerModel | null = null;
        const binding = moduleRecord(
          observedBindingFactory(
            {
              env,
              ledgerPath: path,
              operation,
              expectedState: state,
              startedAt: NOW,
              onMigrated: (model: LedgerModel) => {
                migratedModel = model;
              },
            },
            observation.bundle,
          ),
        );
        const observeActualBefore = asFunction(binding.observeActualBefore);
        const execute = asFunction(binding.execute);
        expect(observeActualBefore).not.toBeNull();
        expect(execute).not.toBeNull();
        if (observeActualBefore === null || execute === null) return;
        const actualBefore = await observeActualBefore();
        const result = moduleRecord(
          await execute({
            operationId: operation.operationId,
            groupId: operation.groupId,
            pairId: null,
            actualBefore,
            unstartedForce: null,
            execute: async () => {
              throw new Error('validated binding callback must not run');
            },
          }),
        );
        expect(result.outcome).toBe('succeeded');
        expect(migratedModel).not.toBeNull();
        expect(
          observation.events
            .filter((event) => event.kind === 'transaction.stage.completed')
            .map(({ stage }) => stage),
        ).toEqual(['prepared', 'staged', 'backed-up', 'live', 'committed']);
        expect(observation.events.map(({ kind }) => kind)).toEqual([
          'transaction.stage.started',
          'transaction.stage.completed',
          'transaction.stage.started',
          'transaction.stage.completed',
          'transaction.stage.started',
          'transaction.stage.completed',
          'transaction.stage.started',
          'transaction.stage.completed',
          'transaction.stage.started',
          'transaction.stage.completed',
          'transaction.committed',
        ]);
        for (const event of observation.events) {
          expect(event).toMatchObject({
            operationId: `transaction:${operation.operationId}`,
            parentOperationId: operation.operationId,
            groupId: operation.groupId,
            pairId: null,
            attempt: 1,
          });
        }
      } finally {
        await rm(mappingRoot, { recursive: true, force: true });
      }
      const resumedRoot = await mkdtemp(
        join(tmpdir(), 'skillsmith-p3b-ts07-ledger-resumed-events-'),
      );
      try {
        const path = join(resumedRoot, 'placements.json');
        const { state, operation } = await prepareLedgerMigrationFixture(path);
        const journals = ledgerMigration.ledgerMigrationJournals(operation, NOW);
        const interrupted = await ledgerWriter.createTestNodeLedgerWriter(path, {
          afterBarrier: async ({ kind }) => {
            if (kind === 'migration-backup-copy') {
              throw Object.assign(new Error('fixture interruption'), { code: 'cancelled' });
            }
          },
        });
        await expect(
          interrupted.migrateV1ToV2({
            expectedSourceByteRevision: state.byteRevision,
            expectedSourceSemanticRevision: state.semanticRevision,
            journals,
          }),
        ).rejects.toMatchObject({ code: 'cancelled' });
        expect(existsSync(interrupted.recoveryPointerPath)).toBeTrue();

        const runtime = await defaultRuntimePorts();
        const env: RuntimePorts = {
          ...runtime,
          wallNowIso: () => NOW,
          epochMilliseconds: () => 0,
          monotonicMilliseconds: () => 0,
        };
        const observation = operationObservationFixture(operation);
        let migratedModel: LedgerModel | null = null;
        const binding = moduleRecord(
          observedBindingFactory(
            {
              env,
              ledgerPath: path,
              operation,
              expectedState: state,
              startedAt: NOW,
              onMigrated: (model: LedgerModel) => {
                migratedModel = model;
              },
            },
            observation.bundle,
          ),
        );
        const observeActualBefore = asFunction(binding.observeActualBefore);
        const execute = asFunction(binding.execute);
        expect(observeActualBefore).not.toBeNull();
        expect(execute).not.toBeNull();
        if (observeActualBefore === null || execute === null) return;
        const actualBefore = await observeActualBefore();
        const result = moduleRecord(
          await execute({
            operationId: operation.operationId,
            groupId: operation.groupId,
            pairId: null,
            actualBefore,
            unstartedForce: null,
            execute: async () => {
              throw new Error('validated binding callback must not run');
            },
          }),
        );
        expect(result.outcome).toBe('succeeded');
        const committed = (migratedModel as LedgerModel | null)?.history.find(
          ({ transactionId }) => transactionId === journals.committed.transactionId,
        );
        expect(committed?.context).toMatchObject({
          parentOperationId: operation.operationId,
          attempt: 2,
          startedAt: NOW,
        });
        expect(observation.events.map(({ kind }) => kind)).toEqual([
          'recovery.started',
          'transaction.stage.started',
          'transaction.stage.completed',
          'transaction.stage.started',
          'transaction.stage.completed',
          'transaction.stage.started',
          'transaction.stage.completed',
          'transaction.committed',
          'recovery.completed',
        ]);
        expect(
          observation.events
            .filter((event) => event.kind === 'transaction.stage.completed')
            .map(({ stage }) => stage),
        ).toEqual(['backed-up', 'live', 'committed']);
        for (const event of observation.events) {
          expect(event).toMatchObject({
            operationId: journals.committed.transactionId,
            parentOperationId: operation.operationId,
            groupId: operation.groupId,
            pairId: null,
            attempt: 2,
          });
        }
        expect(observation.events[0]).toMatchObject({
          kind: 'recovery.started',
          recoveryKind: 'resume',
        });
        expect(observation.events.at(-1)).toMatchObject({
          kind: 'recovery.completed',
          recoveryKind: 'resume',
          outcome: 'success',
          errorCode: null,
        });
      } finally {
        await rm(resumedRoot, { recursive: true, force: true });
      }
      const committedCleanupRoot = await mkdtemp(
        join(tmpdir(), 'skillsmith-p3b-ts07-ledger-committed-cleanup-events-'),
      );
      try {
        const path = join(committedCleanupRoot, 'placements.json');
        const { state, operation } = await prepareLedgerMigrationFixture(path);
        const journals = ledgerMigration.ledgerMigrationJournals(operation, NOW, {
          operationId: operation.operationId,
          transactionId: `transaction:${operation.operationId}`,
          startedAt: NOW,
          attempt: Number.MAX_SAFE_INTEGER,
        });
        const interrupted = await ledgerWriter.createTestNodeLedgerWriter(path, {
          afterBarrier: async ({ kind }) => {
            if (kind === 'migration-commit-fsync') {
              throw Object.assign(new Error('fixture post-commit interruption'), {
                code: 'cancelled',
              });
            }
          },
        });
        await expect(
          interrupted.migrateV1ToV2({
            expectedSourceByteRevision: state.byteRevision,
            expectedSourceSemanticRevision: state.semanticRevision,
            journals,
          }),
        ).rejects.toMatchObject({ code: 'cancelled' });
        expect(existsSync(interrupted.recoveryPointerPath)).toBeTrue();

        const runtime = await defaultRuntimePorts();
        const env: RuntimePorts = {
          ...runtime,
          wallNowIso: () => NOW,
          epochMilliseconds: () => 0,
          monotonicMilliseconds: () => 0,
        };
        const observation = operationObservationFixture(operation);
        let migratedModel: LedgerModel | null = null;
        const binding = moduleRecord(
          observedBindingFactory(
            {
              env,
              ledgerPath: path,
              operation,
              expectedState: state,
              startedAt: NOW,
              onMigrated: (model: LedgerModel) => {
                migratedModel = model;
              },
            },
            observation.bundle,
          ),
        );
        const execute = asFunction(binding.execute);
        expect(execute).not.toBeNull();
        if (execute === null) return;
        const result = moduleRecord(
          await execute({
            operationId: operation.operationId,
            groupId: operation.groupId,
            pairId: null,
            actualBefore: operation.before,
            unstartedForce: null,
            execute: async () => {
              throw new Error('validated binding callback must not run');
            },
          }),
        );
        expect(result.outcome).toBe('succeeded');
        const committed = (migratedModel as LedgerModel | null)?.history.find(
          ({ transactionId }) => transactionId === journals.committed.transactionId,
        );
        expect(committed?.context).toMatchObject({
          parentOperationId: operation.operationId,
          attempt: Number.MAX_SAFE_INTEGER,
          startedAt: NOW,
        });
        expect(observation.events).toMatchObject([
          {
            kind: 'recovery.started',
            operationId: journals.committed.transactionId,
            parentOperationId: operation.operationId,
            attempt: Number.MAX_SAFE_INTEGER,
            recoveryKind: 'cleanup',
          },
          {
            kind: 'recovery.completed',
            operationId: journals.committed.transactionId,
            parentOperationId: operation.operationId,
            attempt: Number.MAX_SAFE_INTEGER,
            recoveryKind: 'cleanup',
            outcome: 'success',
            errorCode: null,
          },
        ]);
        expect(observation.events).toHaveLength(2);
      } finally {
        await rm(committedCleanupRoot, { recursive: true, force: true });
      }
      expect(
        asFunction(moduleRecord(doctorRepair).executeDoctorRepairsObserved),
        'missing G3B-06 private observed doctor executor',
      ).not.toBeNull();
      expect(moduleRecord(publicCore).executeDoctorRepairsObserved).toBeUndefined();
      const pure = doctorRepair.createDoctorRepairPlan([]);
      const pureBytes = canonicalPlanningString(pure.plan);
      expect(doctorRepair.createDoctorRepairPlan.length).toBe(1);
      expect(canonicalPlanningString(doctorRepair.createDoctorRepairPlan([]).plan)).toBe(pureBytes);
      const observation = doctorObservationFixture();
      const outcome = await runDoctorApplication(
        {
          arguments: [],
          options: {
            fix: true,
            dryRun: true,
            offline: true,
            tool: ['codex'],
            scope: 'user',
          },
        },
        doctorApplicationContext(observation.bundle),
      );
      expect(outcome.report.result?.repair).toMatchObject({
        mode: 'preview',
        operations: [],
        results: [],
      });
      const planEvents = observation.events.filter(({ kind }) => kind === 'plan.created');
      expect(planEvents).toHaveLength(1);
      expect(planEvents[0]).toMatchObject({
        kind: 'plan.created',
        operationId: 'command:v1:doctor-fixture',
        parentOperationId: null,
        workflow: 'doctor',
        planId: `plan:v1:${createHash('sha256').update(pureBytes).digest('hex')}`,
        operationCount: 0,
      });
      expect(canonicalPlanningString(doctorRepair.createDoctorRepairPlan([]).plan)).toBe(pureBytes);

      const lockPath = '/doctor-fixture/skills-lock.json';
      const lockLocation = Object.freeze({ kind: 'machine-bound' as const, path: lockPath });
      const artifactRevision = ledgerByteRevision(new Uint8Array([1]));
      const identified = doctorRepair.identifyDoctorFindings([
        {
          checkId: 'fixture-lock-repair',
          severity: 'info',
          title: 'fixture lock repair',
          message: 'fixture lock repair is available',
          repair: {
            kind: 'write-lock',
            artifact: 'lock',
            path: lockPath,
            before: {
              state: 'absent',
              schemaVersion: null,
              byteRevision: null,
              semanticRevision: null,
            },
            after: {
              state: 'present',
              schemaVersion: 1,
              byteRevision: artifactRevision,
              semanticRevision: artifactRevision,
            },
            targetSource: '{}',
            beforeImage: {
              kind: 'absent',
              resource: { kind: 'lock', location: lockLocation },
            },
            afterImage: {
              kind: 'lock',
              location: lockLocation,
              version: 1,
              canonicalHash: CONTENT_HASH,
              value: {
                version: 1,
                hashSchemaVersion: 1,
                manifestHash: CONTENT_HASH,
                skills: [],
              },
            },
          },
        },
      ]);
      const repairPlan = doctorRepair.createDoctorRepairPlan(identified);
      expect(repairPlan.plan.operations).toHaveLength(1);
      const repairOperation = repairPlan.plan.operations[0];
      if (repairOperation === undefined) return;
      const repairObservation = doctorObservationFixture();
      const repairContext = doctorApplicationContext(repairObservation.bundle);
      const repairResults = await doctorRepair.executeDoctorRepairsObserved(
        {
          plan: repairPlan.plan,
          authorizations: repairPlan.authorizations,
          ports: repairContext.ports,
          artifactCoordinator: repairContext.artifactCoordinator,
        },
        repairObservation.bundle,
      );
      expect(repairResults).toMatchObject([
        {
          operationId: repairOperation.operationId,
          outcome: 'failed',
          error: { code: 'invalid-state' },
        },
      ]);
      expect(repairObservation.events).toHaveLength(2);
      expect(repairObservation.events).toMatchObject([
        {
          kind: 'operation.started',
          operationId: repairOperation.operationId,
          parentOperationId: 'command:v1:doctor-fixture',
          groupId: repairOperation.groupId,
          pairId: null,
          attempt: 1,
          operationKind: 'write-lock',
          occurredAt: NOW,
          monotonicMilliseconds: 0,
        },
        {
          kind: 'operation.completed',
          operationId: repairOperation.operationId,
          parentOperationId: 'command:v1:doctor-fixture',
          groupId: repairOperation.groupId,
          pairId: null,
          attempt: 1,
          outcome: 'failure',
          errorCode: 'invalid-state',
          occurredAt: NOW,
          monotonicMilliseconds: 0,
          durationMilliseconds: 0,
        },
      ]);
      expect(source('packages/core/src/place/ledger-migration.ts')).not.toMatch(
        /['"]transaction\.(?:stage\.(?:started|completed)|committed|rolled-back)['"]/u,
      );
      expect(moduleRecord(ledgerWriter).createTestNodeLedgerWriter).toBeFunction();
    });
  });

  describe('family 8 — registry-bound acquisition observation', () => {
    test('EWP-P3B-TS07 characterization: acquisition detection remains generic', () => {
      expect(asFunction(moduleRecord(acquireExecution).detectAcquireTool)).not.toBeNull();
      const text = source('packages/core/src/acquire/execute.ts');
      expect(text).not.toMatch(
        /(?:===|!==|case\s+|\.includes\()\s*['"](?:claude-code|codex|kilo-code|opencode)['"]/u,
      );
    });

    test('EWP-P3B-TS07 contract: a registered fixture tool observes detection and verification', async () => {
      const detectObserved = asFunction(moduleRecord(acquireExecution).detectAcquireToolObserved);
      expect(
        detectObserved,
        'missing G3B-06 observed acquisition detection wrapper',
      ).not.toBeNull();
      if (detectObserved === null) return;
      const tool = 'fixture-observed';
      const operation = operationFor('acquisition-detection', tool);
      const observation = operationObservationFixture(operation, () => {}, [tool]);
      let registryDetectionCalls = 0;
      let fallbackDetectionCalls = 0;
      const registryDetect = async () => {
        registryDetectionCalls += 1;
        return { ok: true as const, value: [] };
      };
      const fallbackDetect = async () => {
        fallbackDetectionCalls += 1;
        throw new Error('fixture detection fallback must not run');
      };
      const verify = async (_env: unknown, options: UnknownRecord) => ({
        ok: true as const,
        value: {
          tool,
          available: true,
          toolVersion: '9.9.9',
          versionDrift: false,
          skipReason: null,
          verdict: 'pass',
          modes: (options.modes as readonly string[]).map((mode) => ({
            mode,
            status: 'ran',
            skipReason: null,
            coverage: { manifest: true, skills: true },
            verdict: 'pass',
            command: `${tool} fixture`,
            findings: [],
          })),
        },
      });
      const adapter = {
        descriptor: { id: tool },
        inventory: { detect: registryDetect },
        verification: {
          verifiedAgainst: 'fixture-observed@9.9.9',
          targetManifests: ['fixture-observed.json'],
          verify,
        },
      };
      const registry = {
        adapters: [adapter],
        ids: [tool],
        get: (id: string) => (id === tool ? adapter : undefined),
        toolsFor: () => [tool],
      };
      const result = await detectObserved(
        {},
        tool,
        undefined,
        { detect: fallbackDetect },
        fallbackDetect,
        registry,
        observation.bundle,
      );
      expect(result).toEqual({ ok: true, value: [] });
      expect(registryDetectionCalls).toBe(1);
      expect(fallbackDetectionCalls).toBe(0);
      const root = await mkdtemp(join(tmpdir(), 'skillsmith-p3b-ts07-verify-'));
      try {
        const skill = join(root, 'skill');
        await mkdir(skill, { recursive: true });
        await writeFile(join(skill, 'SKILL.md'), '# fixture observed\n');
        const runtime = await defaultRuntimePorts();
        const ports: RuntimePorts = {
          ...runtime,
          xdg: { ...runtime.xdg, cache: join(root, 'cache') },
          nextId: () => 'fixture-verify-wrapper',
        };
        const verified = await (runVerify as AnyFunction)(
          ports,
          {
            path: skill,
            tools: [tool],
            deep: true,
            observation: observation.bundle,
          },
          registry,
        );
        expect(moduleRecord(verified).ok).toBeTrue();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
      expect(observation.events.map(({ kind }) => kind)).toEqual([
        'tool.detection.started',
        'tool.detection.completed',
        'tool.verification.started',
        'tool.verification.completed',
      ]);
      expect(observation.events).toMatchObject([
        {
          kind: 'tool.detection.started',
          operationId: operation.operationId,
          parentOperationId: 'command:v1:promote-fixture',
          toolId: tool,
        },
        {
          kind: 'tool.detection.completed',
          operationId: operation.operationId,
          parentOperationId: 'command:v1:promote-fixture',
          toolId: tool,
          outcome: 'success',
          errorCode: null,
          resultCount: 0,
        },
        {
          kind: 'tool.verification.started',
          toolId: tool,
          modes: ['static', 'deep'],
        },
        {
          kind: 'tool.verification.completed',
          toolId: tool,
          modes: ['static', 'deep'],
          verdict: 'pass',
          errorCode: null,
        },
      ]);
      expect(source('packages/core/src/acquire/execute.ts')).not.toMatch(
        /['"]tool\.(?:detection|verification)\.(?:started|completed)['"]/u,
      );
    });
  });

  describe('family 9 — observer fault isolation', () => {
    test('EWP-P3B-TS07 characterization: emitter throws, rejections, and hangs are non-authoritative', () => {
      for (const observer of [
        () => {
          throw new Error('observer throw');
        },
        () => Promise.reject(new Error('observer rejection')),
        () => new Promise<void>(() => {}),
      ]) {
        const fixture = observationFixture(observer);
        const span = fixture.bundle.emitter.begin(fixture.bundle.context, {
          kind: 'command.started',
        });
        expect(() =>
          fixture.bundle.emitter.complete(span, {
            outcome: 'success',
            exitClass: 'success',
            errorCode: null,
          }),
        ).not.toThrow();
      }
    });

    test('EWP-P3B-TS07 contract: observed execution returns identical semantics for hostile observers', async () => {
      const observed = asFunction(moduleRecord(scheduler).scheduleOperationPlanObserved);
      expect(observed, 'missing G3B-06 observer-isolated observed execution path').not.toBeNull();
      if (observed === null) return;
      const observedSwap = asFunction(moduleRecord(swap).runSwapObserved);
      expect(observedSwap, 'missing G3B-06 observer-isolated durable swap path').not.toBeNull();
      if (observedSwap === null) return;
      const beginAttempt = asFunction(
        moduleRecord(logicalTransactions).beginTransactionRecoveryAttempt,
      );
      expect(beginAttempt, 'missing G3B-06 observer-isolated recovery attempt path').not.toBeNull();
      if (beginAttempt === null) return;
      const recoverObserved = asFunction(moduleRecord(placementRecovery).recoverPlacementObserved);
      expect(recoverObserved, 'missing G3B-06 observer-isolated recovery wrapper').not.toBeNull();
      if (recoverObserved === null) return;
      const operation = operationFor('observer-isolation');
      const plan = planFor([operation]);
      const executions = [];
      const observers = [
        () => {},
        () => {
          throw new Error('observer throw');
        },
        () => Promise.reject(new Error('observer rejection')),
        () => new Promise<void>(() => {}),
      ] as const;
      for (const observer of observers) {
        const fixture = observationFixture(observer);
        executions.push(
          canonicalPlanningString(
            await observed(
              plan,
              [bindingFor(operation, async () => resultFor(operation, 'succeeded'))],
              {},
              fixture.bundle,
            ),
          ),
        );
      }
      expect(new Set(executions).size).toBe(1);

      const base = await mkdtemp(join(tmpdir(), 'skillsmith-p3b-ts07-isolation-'));
      const lane = join(base, 'lane');
      try {
        const baselineFixture = await buildPromoteSwapFixture(undefined, lane);
        const baselineResult = await swap.runSwap(baselineFixture.request, baselineFixture.plan);
        const baseline = await durableSwapSnapshot(baselineFixture, baselineResult);
        await destroyPromoteSwapFixture(baselineFixture);
        expect(baseline.final).toMatchObject({
          liveKind: 'dir',
          storeKind: 'dir',
          residue: [],
        });
        for (const observer of observers) {
          const fixture = await buildPromoteSwapFixture(undefined, lane);
          try {
            const observation = operationObservationFixture(fixture.operation, observer);
            const result = await observedSwap(fixture.request, fixture.plan, observation.bundle);
            expect(await durableSwapSnapshot(fixture, result)).toEqual(baseline);
          } finally {
            await destroyPromoteSwapFixture(fixture);
          }
        }
        const recoveryBaseline = await durableRecoverySnapshot(lane, recoverObserved, null);
        for (const observer of observers) {
          expect(await durableRecoverySnapshot(lane, recoverObserved, observer)).toEqual(
            recoveryBaseline,
          );
        }
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    });

    test('EWP-P3B-TS07 contract: hostile observers preserve runtime bytes and exits', async () => {
      const run = async (
        observer: (event: ObserverEvent) => void | PromiseLike<void>,
        format: 'human' | 'json',
        executionOutcome: 'succeeded' | 'failed',
      ) => {
        const operation = operationFor(`runtime-${executionOutcome}`);
        const plan = planFor([operation]);
        const observation = observationFixture(observer);
        const writes = { stdout: [] as string[], stderr: [] as string[], exits: [] as number[] };
        const runtime = createCliRuntimeAdapter({
          applications: {
            fixture: async (_request, context) => {
              const bundle = (context as { readonly observation: ObservationBundle }).observation;
              const results = await scheduler.scheduleOperationPlanObserved(
                plan,
                [
                  bindingFor(operation, async () => resultFor(operation, executionOutcome)),
                ] as never,
                {},
                bundle,
              );
              const failed = results[0]?.outcome === 'failed';
              return {
                report: { results },
                diagnostics: failed
                  ? [{ code: 'fixture-failed', severity: 'error' as const, message: 'failed' }]
                  : [],
                exitClass: failed ? ('failure' as const) : ('success' as const),
                mutation: {
                  kind: 'none' as const,
                  planned: 1,
                  changed: 0,
                  unchanged: failed ? 0 : 1,
                  failed: failed ? 1 : 0,
                },
                deprecations: [],
              };
            },
          },
          renderers: {
            fixture: {
              human: (outcome) =>
                outcome.exitClass === 'success'
                  ? { stdout: 'fixture succeeded\n' }
                  : { stderr: 'error: fixture failed\n' },
              json: (outcome) => ({
                stdout: `${JSON.stringify({ exitClass: outcome.exitClass })}\n`,
              }),
            },
          },
          io: {
            stdout: { write: (value) => writes.stdout.push(value) },
            stderr: { write: (value) => writes.stderr.push(value) },
            exit: (code) => writes.exits.push(code),
          },
        });
        const execution = await runtime.execute({
          application: 'fixture',
          reportKind: 'fixture',
          request: {},
          context: { observation: observation.bundle },
          observation: observation.bundle,
          format,
        });
        return {
          execution,
          stdout: writes.stdout.join(''),
          stderr: writes.stderr.join(''),
          exits: writes.exits,
        };
      };

      const hostileObservers = [
        () => {
          throw new Error('runtime observer throw');
        },
        () => Promise.reject(new Error('runtime observer rejection')),
        () => new Promise<void>(() => {}),
      ] as const;
      for (const executionOutcome of ['succeeded', 'failed'] as const) {
        for (const format of ['human', 'json'] as const) {
          const baseline = await run(() => {}, format, executionOutcome);
          expect(baseline.execution.exitCode).toBe(executionOutcome === 'succeeded' ? 0 : 1);
          expect(baseline.exits).toEqual([executionOutcome === 'succeeded' ? 0 : 1]);
          if (format === 'human') {
            expect([baseline.stdout, baseline.stderr]).toEqual(
              executionOutcome === 'succeeded'
                ? ['fixture succeeded\n', '']
                : ['', 'error: fixture failed\n'],
            );
          } else {
            expect(baseline.stderr).toBe('');
            expect(baseline.stdout).toBe(
              `${JSON.stringify({
                exitClass: executionOutcome === 'succeeded' ? 'success' : 'failure',
              })}\n`,
            );
          }
          for (const observer of hostileObservers) {
            expect(await run(observer, format, executionOutcome)).toEqual(baseline);
          }
        }
      }
    });
  });

  describe('family 10 — compatibility and bounded growth', () => {
    test('EWP-P3B-TS07 characterization: public shapes and runner ceilings remain bounded', () => {
      expect(source('packages/core/src/acquire/types.ts')).not.toContain('ObservationBundle');
      expect(source('packages/core/src/place/types.ts')).not.toContain('ObservationBundle');
      const doctorTypes = source('packages/core/src/doctor/types.ts');
      expect(doctorTypes.match(/\bObservationBundle\b/gu)?.length).toBe(2);
      expect(doctorTypes).toContain(
        "import type { ObservationBundle } from '../observation/index.ts';",
      );
      expect(doctorTypes).toContain('observation?: ObservationBundle;');
      expect(
        doctorTypes.match(/export interface DoctorRepairExecutionRequest \{[\s\S]*?\n\}/u)?.[0] ??
          '',
      ).not.toContain('ObservationBundle');
      expect(source('packages/core/src/acquire/run.ts').split('\n').length - 1).toBeLessThanOrEqual(
        3_955,
      );
      expect(source('packages/core/src/place/run.ts').split('\n').length - 1).toBeLessThanOrEqual(
        2_917,
      );
    });

    test('EWP-P3B-TS07 contract: the exact TS11 ownership transition remains private', () => {
      expect(
        present('packages/core/src/execution/observation.ts'),
        'G3B-06 observation ownership transition is incomplete',
      ).toBeTrue();
      const ts11 = source('tests/ergonomics/phase/EWP-P1-TS11.test.ts');
      expect(ts11).toContain('stateAdjacentObservationImportAllowlist');
      expect(ts11).toContain('deferredEventLiteralAuthorities');
      expect(Object.keys(publicCore).filter((name) => name.endsWith('Observed'))).toEqual([]);
    });
  });
});
