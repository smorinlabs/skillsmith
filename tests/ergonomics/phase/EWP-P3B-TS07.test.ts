import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as acquireExecution from '../../../packages/core/src/acquire/execute.ts';
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
  beginAttempt: AnyFunction,
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
    const advanced = moduleRecord(
      beginAttempt(pending.state.ledger, {
        transactionId: fixture.transactionId,
        command: 'skillsmith promote --resume alpha',
        workflow: 'promote-resume',
        updatedAt: '2026-07-16T00:00:01.000Z',
      }),
    );
    if (advanced.ok !== true) throw new Error('recovery parity attempt reducer failed');
    const input: PlacementExecutionInput = {
      env: fixture.env,
      ledgerPath: ledgerPathOf(fixture.data),
      ledger: advanced.value as LedgerModel,
      journalNow: () => '2026-07-16T00:00:02.000Z',
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
    return durableSwapSnapshot(fixture, recovered);
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

    test('EWP-P3B-TS07 red: one private execution observation authority owns deferred events', async () => {
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

    test('EWP-P3B-TS07 red: plan.created uses the canonical private plan identity', async () => {
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

    test('EWP-P3B-TS07 red: observed scheduling derives context only for started bindings', async () => {
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

    test('EWP-P3B-TS07 red: observed scheduling emits exact completion outcomes and codes', async () => {
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

    test('EWP-P3B-TS07 red: swap emits one correlated durable stage sequence', async () => {
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
        const result = moduleRecord(await acquireObserved(input, plan, null, observation.bundle));
        expect(result.ok).toBeTrue();
        expect(
          observation.events
            .filter((event) => event.kind === 'transaction.stage.completed')
            .map(({ stage }) => stage),
        ).toEqual(['prepared', 'staged', 'backed-up', 'live', 'committed']);
        expect(observation.events.at(-1)).toMatchObject({
          kind: 'transaction.committed',
          parentOperationId: operation.operationId,
        });
      } finally {
        await destroyPromoteSwapFixture(acquired);
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

    test('EWP-P3B-TS07 red: recovery begins one atomic logical and physical attempt', async () => {
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
          ledger: model,
          journalNow: () => '2026-07-16T00:00:02.000Z',
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
        const advanced = moduleRecord(
          beginAttempt(pending.state.ledger, {
            transactionId: rollbackFixture.transactionId,
            command: 'skillsmith promote --rollback alpha',
            workflow: 'promote-rollback',
            updatedAt: '2026-07-16T00:00:03.000Z',
          }),
        );
        expect(advanced.ok).toBeTrue();
        if (advanced.ok !== true) return;
        const observation = operationObservationFixture(rollbackFixture.operation);
        const recovered = moduleRecord(
          await recoverObserved(
            {
              env: rollbackFixture.env,
              ledgerPath: ledgerPathOf(rollbackFixture.data),
              ledger: advanced.value as LedgerModel,
              journalNow: () => '2026-07-16T00:00:04.000Z',
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

    test('EWP-P3B-TS07 red: durable cursor and doctor execution have narrow observed seams', async () => {
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

    test('EWP-P3B-TS07 red: a registered fixture tool observes detection and verification', async () => {
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

    test('EWP-P3B-TS07 red: observed execution returns identical semantics for hostile observers', async () => {
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
        const recoveryBaseline = await durableRecoverySnapshot(
          lane,
          beginAttempt,
          recoverObserved,
          null,
        );
        for (const observer of observers) {
          expect(
            await durableRecoverySnapshot(lane, beginAttempt, recoverObserved, observer),
          ).toEqual(recoveryBaseline);
        }
      } finally {
        await rm(base, { recursive: true, force: true });
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

    test('EWP-P3B-TS07 red: the exact TS11 ownership transition remains private', () => {
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
