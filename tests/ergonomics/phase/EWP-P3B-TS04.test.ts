import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  artifactContractRegistry,
  readLedgerArtifact,
} from '../../../packages/core/src/artifacts/index.ts';
import type { LogicalJournalV1Dto } from '../../../packages/core/src/artifacts/journal-types.ts';
import {
  ledgerByteRevision,
  ledgerSemanticRevision,
} from '../../../packages/core/src/artifacts/ledger-codec.ts';
import type {
  LedgerModel,
  LedgerPairV1Dto,
} from '../../../packages/core/src/artifacts/ledger-types.ts';
import { ledgerRecoveryKey } from '../../../packages/core/src/artifacts/ledger-writer.ts';
import * as publicCore from '../../../packages/core/src/index.ts';
import * as ledgerFacade from '../../../packages/core/src/place/ledger.ts';
import { ledgerPathOf } from '../../../packages/core/src/place/paths.ts';
import { preparePromote, runPromote } from '../../../packages/core/src/place/run.ts';
import type { FlipDeps, FlipOptions } from '../../../packages/core/src/place/types.ts';
import { defaultRuntimePorts } from '../../../packages/core/src/ports/default.ts';
import {
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../../../packages/core/tests/fixtures/place/fleet.ts';

type UnknownRecord = Record<string, unknown>;
type AnyFunction = (...args: unknown[]) => unknown;

interface FixtureCases {
  readonly schemaVersion: 1;
  readonly fixtureCanary: string;
  readonly timeoutMs: number;
  readonly terminationGraceMs: number;
  readonly limits: Readonly<{
    maxMessageBytes: number;
    maxOutputBytes: number;
    maxReasonLength: number;
    maxWorkers: number;
    maxCrashCases: number;
    maxRecoveryCases: number;
    maxProtocolMessages: number;
  }>;
  readonly protocol: Readonly<{
    accepts: readonly string[];
    emits: readonly string[];
    roles: readonly string[];
    modes: readonly string[];
    outcomes: readonly string[];
    journalPhases: readonly string[];
    barriers: readonly string[];
  }>;
  readonly ledgerShapeCases: readonly Readonly<{
    id: string;
    source: string | null;
    expected: 'absent' | 'invalid' | 'upgrade';
  }>[];
  readonly migrationCase: Readonly<{
    id: string;
    source: string;
    sourceSchemaVersion: 1;
    targetSchemaVersion: 2;
    operationKind: 'migrate-ledger';
  }>;
  readonly registrationCases: readonly Readonly<{
    id: string;
    scope: 'user' | 'project';
    tool: string;
    pinned: boolean;
    pathChange: boolean;
    expectedProjectConsumers: number;
  }>[];
  readonly logicalPhases: readonly LogicalJournalV1Dto['phase'][];
  readonly logicalRefusalCases: readonly string[];
  readonly history: Readonly<{
    ordinaryCapacity: number;
    seedCount: number;
    protectedOverCapacityCount: number;
    protectedRetainUntil: string;
    cleanupVictimsPerPass: number;
  }>;
  readonly crashCases: readonly Readonly<{
    id: string;
    mode: 'write-model' | 'migrate-v1';
    barrier: string;
  }>[];
  readonly recoveryCursorCases: readonly Readonly<{
    id: string;
    cursor: string;
    live: string;
    stage: string;
    backup: string;
    permittedResidue: readonly ('transaction-directory' | 'stage' | 'backup')[];
    expected: string;
  }>[];
  readonly recoveryRefusalCases: readonly Readonly<{ id: string; kind: string }>[];
  readonly shadowCases: readonly string[];
  readonly abortCases: readonly string[];
  readonly anchorCases: readonly string[];
  readonly cleanupCases: readonly string[];
  readonly concurrencyCase: Readonly<{
    id: string;
    target: string;
    marker: string;
    guard: string;
    workers: readonly Readonly<{
      workerId: string;
      role: 'first-writer' | 'second-writer';
      operationId: string;
      transactionId: string;
      skill: string;
      tool: string;
    }>[];
  }>;
}

interface WorkerSpec {
  readonly caseId: string;
  readonly operationId: string;
  readonly transactionId: string;
  readonly workerId: string;
  readonly role:
    | 'first-writer'
    | 'second-writer'
    | 'migration-writer'
    | 'recovery-writer'
    | 'lock-holder'
    | 'lock-contender';
  readonly mode: 'write-model' | 'migrate-v1' | 'lock-contention';
  readonly root: string;
  readonly marker: string;
  readonly guard: string;
  readonly target: string;
  readonly skill: string;
  readonly tool: string;
  readonly homeDir: string | null;
  readonly dataDir: string | null;
  readonly cwd: string | null;
  readonly injection: null | Readonly<{ barrier: string; occurrence: number }>;
  readonly holdAtLock?: boolean;
  readonly expectedJournalPhase?: LogicalJournalV1Dto['phase'] | null;
  readonly sourceRevision?: string | null;
}

const FIXTURES = join(import.meta.dir, '../fixtures/p3b-ts04');
const WORKER = join(FIXTURES, 'worker.ts');
const fixture = (): FixtureCases =>
  JSON.parse(readFileSync(join(FIXTURES, 'cases.json'), 'utf8')) as FixtureCases;
const roots: string[] = [];
const core = publicCore as unknown as UnknownRecord;
const ledger = ledgerFacade as unknown as UnknownRecord;
const digestA = `sha256:${'a'.repeat(64)}`;
const digestB = `sha256:${'b'.repeat(64)}`;
const digestC = `sha256:${'c'.repeat(64)}`;
const digestD = `sha256:${'d'.repeat(64)}`;
const dependencies: FlipDeps = {
  now: () => '2026-07-15T00:00:00.000Z',
  newTxId: () => 'p3b-ts04-transaction',
  verify: async () => {
    throw new Error('P3B-TS04 no-verify fixture invoked verification');
  },
};

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const exactRecord = (
  value: unknown,
  keys: readonly string[],
  label: string,
): Readonly<UnknownRecord> => {
  expect(value !== null && typeof value === 'object' && !Array.isArray(value), label).toBeTrue();
  const record = value as Readonly<UnknownRecord>;
  expect(Object.keys(record).sort(), `${label} exact keys`).toEqual([...keys].sort());
  return record;
};

const until = async <T>(promise: Promise<T>, deadline: number, label: string): Promise<T> => {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`${label} exceeded its absolute deadline`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded its absolute deadline`)),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const readCapped = async (
  stream: ReadableStream<Uint8Array>,
  shared: { bytes: number },
  maximum: number,
  label: string,
): Promise<string> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      shared.bytes += next.value.byteLength;
      if (shared.bytes > maximum) throw new Error(`${label} exceeded capped child output`);
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
};

const terminateChild = async (
  child: ReturnType<typeof Bun.spawn>,
  hardDeadline: number,
  graceMs: number,
  label: string,
): Promise<void> => {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    const graceDeadline = Math.min(hardDeadline, Date.now() + graceMs);
    const terminated = await Promise.race([
      child.exited.then(() => true),
      until(
        new Promise<false>((resolveWait) => setTimeout(() => resolveWait(false), graceMs)),
        graceDeadline,
        `${label} termination grace`,
      ).catch(() => false),
    ]);
    if (!terminated && child.exitCode === null) child.kill('SIGKILL');
  }
  await until(child.exited, hardDeadline, `${label} final exit`);
};

const runSelfCheck = async (): Promise<Readonly<UnknownRecord>> => {
  const cases = fixture();
  const started = Date.now();
  const hardDeadline = started + cases.timeoutMs;
  const operationDeadline = hardDeadline - cases.terminationGraceMs - 250;
  const child = Bun.spawn([process.execPath, WORKER, '--self-check'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = { bytes: 0 };
  const stdout = readCapped(child.stdout, output, cases.limits.maxOutputBytes, 'self-check stdout');
  const stderr = readCapped(child.stderr, output, cases.limits.maxOutputBytes, 'self-check stderr');
  try {
    const exitCode = await until(child.exited, operationDeadline, 'worker self-check');
    const [out, err] = await until(
      Promise.all([stdout, stderr]),
      operationDeadline,
      'worker self-check output',
    );
    expect(exitCode).toBe(0);
    expect(err).toBe('');
    expect(output.bytes).toBeLessThanOrEqual(cases.limits.maxOutputBytes);
    return exactRecord(
      JSON.parse(out),
      [
        'kind',
        'protocolVersion',
        'timeoutMs',
        'maxMessageBytes',
        'maxBarriers',
        'accepts',
        'emits',
        'roles',
        'modes',
        'outcomes',
        'journalPhases',
        'barriers',
      ],
      'worker self-check',
    );
  } finally {
    await terminateChild(child, hardDeadline, cases.terminationGraceMs, 'worker self-check');
  }
};

const runWorker = async (
  spec: WorkerSpec,
  control?: Readonly<{
    onBarrier?: (record: Readonly<UnknownRecord>, release: () => void) => void;
  }>,
): Promise<
  Readonly<{ result: Readonly<UnknownRecord>; messages: readonly Readonly<UnknownRecord>[] }>
> => {
  const cases = fixture();
  const started = Date.now();
  const hardDeadline = started + cases.timeoutMs;
  const operationDeadline = hardDeadline - cases.terminationGraceMs - 250;
  const messages: Readonly<UnknownRecord>[] = [];
  const barrierCounts = new Map<string, number>();
  const barrierIds = new Set<string>();
  let settle: ((message: Readonly<UnknownRecord>) => void) | undefined;
  let rejectResult: ((error: Error) => void) | undefined;
  const resultPromise = new Promise<Readonly<UnknownRecord>>((resolveResult, reject) => {
    settle = resolveResult;
    rejectResult = reject;
  });
  const child = Bun.spawn([process.execPath, WORKER], {
    cwd: spec.root,
    stdout: 'pipe',
    stderr: 'pipe',
    ipc(message) {
      try {
        const record = message as Readonly<UnknownRecord>;
        messages.push(record);
        expect(messages.length).toBeLessThanOrEqual(cases.limits.maxProtocolMessages);
        const common = [
          'kind',
          'protocolVersion',
          'caseId',
          'operationId',
          'transactionId',
          'workerId',
          'barrierId',
          'role',
        ];
        expect(record.protocolVersion).toBe(1);
        expect(record.caseId).toBe(spec.caseId);
        expect(record.operationId).toBe(spec.operationId);
        expect(record.transactionId).toBe(spec.transactionId);
        expect(record.workerId).toBe(spec.workerId);
        expect(record.role).toBe(spec.role);
        if (record.kind === 'fixture-ready') exactRecord(record, common, 'fixture-ready');
        else if (record.kind === 'barrier') {
          exactRecord(record, [...common, 'barrier', 'occurrence'], 'barrier');
          expect(cases.protocol.barriers).toContain(record.barrier);
          expect(Number.isSafeInteger(record.occurrence)).toBeTrue();
          expect(String(record.barrierId)).toMatch(
            new RegExp(
              `^${spec.workerId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}:[1-9][0-9]*$`,
              'u',
            ),
          );
          expect(barrierIds.has(String(record.barrierId))).toBeFalse();
          barrierIds.add(String(record.barrierId));
          const expectedOccurrence = (barrierCounts.get(String(record.barrier)) ?? 0) + 1;
          expect(record.occurrence).toBe(expectedOccurrence);
          barrierCounts.set(String(record.barrier), expectedOccurrence);
          control?.onBarrier?.(record, () => {
            child.send({
              kind: 'release',
              protocolVersion: 1,
              caseId: spec.caseId,
              operationId: spec.operationId,
              transactionId: spec.transactionId,
              workerId: spec.workerId,
              barrierId: record.barrierId,
              role: spec.role,
            });
          });
        } else if (record.kind === 'result') {
          exactRecord(
            record,
            [
              ...common,
              'outcome',
              'observedBarriers',
              'finalSchemaVersion',
              'pendingCount',
              'historyCount',
              'requestedMutationPresent',
              'journalPhase',
              'historyTransactionIds',
              'historyAttempts',
              'historyStartedAts',
              'sourceRevisionPreserved',
            ],
            'result',
          );
          expect(cases.protocol.outcomes).toContain(record.outcome);
          expect(
            record.journalPhase === null ||
              cases.protocol.journalPhases.includes(String(record.journalPhase)),
          ).toBeTrue();
          for (const key of ['pendingCount', 'historyCount']) {
            expect(Number.isSafeInteger(record[key])).toBeTrue();
            expect(Number(record[key])).toBeGreaterThanOrEqual(0);
          }
          expect(Array.isArray(record.observedBarriers)).toBeTrue();
          expect(Array.isArray(record.historyTransactionIds)).toBeTrue();
          expect(Array.isArray(record.historyAttempts)).toBeTrue();
          expect(Array.isArray(record.historyStartedAts)).toBeTrue();
          expect(typeof record.requestedMutationPresent).toBe('boolean');
          expect(typeof record.sourceRevisionPreserved).toBe('boolean');
          expect(record.historyTransactionIds).toHaveLength(
            (record.historyAttempts as readonly unknown[]).length,
          );
          expect(record.historyTransactionIds).toHaveLength(
            (record.historyStartedAts as readonly unknown[]).length,
          );
          settle?.(record);
        } else if (record.kind === 'fixture-error') {
          exactRecord(record, [...common, 'reason'], 'fixture-error');
          rejectResult?.(new Error(String(record.reason)));
        } else rejectResult?.(new Error(`unexpected worker message ${String(record.kind)}`));
      } catch (error) {
        rejectResult?.(error instanceof Error ? error : new Error('worker IPC assertion failed'));
      }
    },
  });
  const output = { bytes: 0 };
  const stdout = readCapped(
    child.stdout,
    output,
    cases.limits.maxOutputBytes,
    `${spec.workerId} stdout`,
  );
  const stderr = readCapped(
    child.stderr,
    output,
    cases.limits.maxOutputBytes,
    `${spec.workerId} stderr`,
  );
  try {
    child.send({
      kind: 'start',
      protocolVersion: 1,
      caseId: spec.caseId,
      operationId: spec.operationId,
      transactionId: spec.transactionId,
      workerId: spec.workerId,
      barrierId: null,
      role: spec.role,
      mode: spec.mode,
      root: spec.root,
      marker: spec.marker,
      guard: spec.guard,
      target: spec.target,
      skill: spec.skill,
      tool: spec.tool,
      homeDir: spec.homeDir,
      dataDir: spec.dataDir,
      cwd: spec.cwd,
      injection: spec.injection,
      holdAtLock: spec.holdAtLock ?? false,
      expectedJournalPhase: spec.expectedJournalPhase ?? null,
      sourceRevision: spec.sourceRevision ?? null,
    });
    const result = await until(resultPromise, operationDeadline, `${spec.workerId} result`);
    const exitCode = await until(child.exited, operationDeadline, `${spec.workerId} exit`);
    const [out, err] = await until(
      Promise.all([stdout, stderr]),
      operationDeadline,
      `${spec.workerId} output`,
    );
    expect(exitCode).toBe(0);
    expect(out).toBe('');
    expect(err.length).toBeLessThanOrEqual(cases.limits.maxReasonLength + 1);
    expect(output.bytes).toBeLessThanOrEqual(cases.limits.maxOutputBytes);
    expect(messages.some((item) => item.kind === 'fixture-ready')).toBeTrue();
    return { result, messages };
  } finally {
    await terminateChild(child, hardDeadline, cases.terminationGraceMs, spec.workerId);
  }
};

const optionsFor = (fleet: Awaited<ReturnType<typeof buildFixtureFleet>>): FlipOptions => ({
  targets: ['alpha'],
  cwd: fleet.home,
  configuration: fleet.configuration,
  noVerify: true,
});

const requiredFunction = (owner: Readonly<UnknownRecord>, name: string): AnyFunction => {
  const candidate = owner[name];
  expect(typeof candidate, `missing G3B-03 ${name} behavior`).toBe('function');
  return candidate as AnyFunction;
};

const unwrap = async (value: unknown, label: string): Promise<unknown> => {
  const resolved = await Promise.resolve(value);
  if (resolved !== null && typeof resolved === 'object' && 'ok' in resolved) {
    const result = resolved as Readonly<{ ok: boolean; value?: unknown; error?: unknown }>;
    expect(result.ok, `${label}: ${JSON.stringify(result.error)}`).toBeTrue();
    return result.value;
  }
  return resolved;
};

const unwrapModel = async (value: unknown, label: string): Promise<LedgerModel> => {
  const model = await unwrap(value, label);
  expect(
    model !== null && typeof model === 'object' && !Array.isArray(model),
    `${label} must return a ledger model`,
  ).toBeTrue();
  return model as LedgerModel;
};

const expectRefusal = async (operation: () => unknown, label: string): Promise<void> => {
  let refused = false;
  try {
    const value = await Promise.resolve(operation());
    refused =
      value !== null &&
      typeof value === 'object' &&
      'ok' in value &&
      (value as Readonly<{ ok: boolean }>).ok === false;
  } catch {
    refused = true;
  }
  expect(refused, `${label} must refuse without mutation`).toBeTrue();
};

const ledgerActual = (after: boolean) => ({
  resourceId: 'ledger:placements',
  role: 'ledger' as const,
  state: 'present' as const,
  repositoryRevision: { kind: 'artifact-bytes' as const, digest: after ? digestB : digestA },
  schemaVersion: 2 as const,
  semanticHash: after ? digestB : digestA,
});

const liveActual = (skill: string, state: 'absent' | 'present', placementPath: string) =>
  state === 'absent'
    ? {
        resourceId: `live:${skill}`,
        role: 'live' as const,
        state,
        repositoryRevision: null,
        placementPath,
        liveKind: null,
        mode: null,
        symlinkTarget: null,
        contentHash: null,
      }
    : {
        resourceId: `live:${skill}`,
        role: 'live' as const,
        state,
        repositoryRevision: { kind: 'resource' as const, digest: digestB },
        placementPath,
        liveKind: 'directory' as const,
        mode: 'pinned' as const,
        symlinkTarget: null,
        contentHash: digestB,
      };

const journal = (
  index: number,
  phase: LogicalJournalV1Dto['phase'],
  options: Readonly<{
    skill?: string;
    transactionId?: string;
    beforePath?: string;
    afterPath?: string;
    retained?: 'none' | 'disposable' | 'protected';
  }> = {},
): LogicalJournalV1Dto => {
  const skill = options.skill ?? 'alpha';
  const beforePath = options.beforePath ?? `/fixture/live/${skill}`;
  const afterPath = options.afterPath ?? beforePath;
  const completed = phase === 'committed';
  const startedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString();
  const retained = options.retained ?? 'none';
  const retainedId = `backup:${skill}:${index}`;
  return {
    schemaVersion: 1,
    kind: 'skillsmith.transaction-journal',
    transactionId: options.transactionId ?? `transaction-${String(index).padStart(4, '0')}`,
    intent: {
      operationId: `operation-${String(index).padStart(4, '0')}`,
      groupId: `group-${skill}`,
      pairId: `pair-${skill}`,
      kind: 'install',
      skill,
      source: {
        kind: 'portable',
        identity: {
          host: 'example.test',
          repository: 'fixture/skills',
          path: `skills/${skill}`,
        },
        requestedRef: null,
        resolvedSha: 'c'.repeat(40),
        sourcePath: `skills/${skill}`,
        contentHash: digestA,
      },
      tool: 'codex',
      scope: 'user',
      before: {
        kind: 'absent',
        resource: {
          kind: 'live',
          skill,
          tool: 'codex',
          scope: 'user',
          projectRoot: null,
          location: { kind: 'machine-bound', path: beforePath },
        },
      },
      after: {
        kind: 'placement',
        resource: {
          kind: 'live',
          skill,
          tool: 'codex',
          scope: 'user',
          projectRoot: null,
          location: { kind: 'machine-bound', path: afterPath },
        },
        classification: 'pinned',
        representation: 'copy',
        linkTarget: null,
        dangling: false,
        source: null,
        contentHash: digestB,
      },
      mutates: { live: true, manifest: false, lock: false, ledger: true },
      reversibility:
        retained === 'none'
          ? { kind: 'none', retentionResourceIds: [] }
          : { kind: 'conditional', retentionResourceIds: [retainedId] },
      conflict: null,
    },
    context: {
      parentOperationId: null,
      command: 'promote',
      workflow: 'P3B-TS04',
      attempt: 1,
      startedAt,
    },
    disposition: 'forward',
    phase,
    actual: {
      before: [liveActual(skill, 'absent', beforePath), ledgerActual(false)],
      after:
        phase === 'live' || completed
          ? [liveActual(skill, 'present', afterPath), ledgerActual(true)]
          : [],
      retained:
        retained === 'none'
          ? []
          : [
              {
                resourceId: retainedId,
                role: 'backup',
                sourceRole: 'live',
                path: `/fixture/backups/${skill}-${index}`,
                repositoryRevision: { kind: 'resource', digest: digestA },
                contentHash: digestA,
                retainUntil:
                  retained === 'protected' ? fixture().history.protectedRetainUntil : null,
              },
            ],
    },
    updatedAt: startedAt,
    completedAt: completed ? startedAt : null,
  };
};

const removeJournal = (index: number, phase: LogicalJournalV1Dto['phase']): LogicalJournalV1Dto => {
  const base = journal(index, phase);
  const resource = base.intent.after.kind === 'placement' ? base.intent.after.resource : null;
  if (resource === null) throw new Error('P3B-TS04 remove fixture resource invariant');
  return {
    ...base,
    intent: {
      ...base.intent,
      kind: 'remove',
      source: null,
      before: base.intent.after,
      after: { kind: 'absent', resource },
    },
    actual: {
      ...base.actual,
      before: [liveActual('alpha', 'present', '/fixture/live/alpha'), ledgerActual(false)],
      after:
        phase === 'live' || phase === 'committed'
          ? [liveActual('alpha', 'absent', '/fixture/live/alpha'), ledgerActual(true)]
          : [],
    },
  };
};

const artifactJournal = (
  index: number,
  role: 'manifest' | 'lock' | 'ledger',
): LogicalJournalV1Dto => {
  const base = journal(index, 'committed');
  const location = { kind: 'portable' as const, token: `artifacts/${role}.json` };
  if (role === 'ledger') {
    return {
      ...base,
      intent: {
        operationId: base.intent.operationId,
        groupId: `group-${role}`,
        pairId: null,
        kind: 'migrate-ledger',
        skill: null,
        source: null,
        tool: null,
        scope: null,
        before: {
          kind: 'ledger',
          projectRoot: null,
          schemaVersion: 1,
          byteHash: digestA,
          semanticHash: digestA,
        },
        after: {
          kind: 'ledger',
          projectRoot: null,
          schemaVersion: 2,
          byteHash: digestB,
          semanticHash: digestB,
        },
        mutates: { live: false, manifest: false, lock: false, ledger: true },
        reversibility: { kind: 'none', retentionResourceIds: [] },
        conflict: null,
      },
      actual: { before: [ledgerActual(false)], after: [ledgerActual(true)], retained: [] },
    };
  }
  if (role === 'lock') {
    return {
      ...base,
      intent: {
        operationId: base.intent.operationId,
        groupId: `group-${role}`,
        pairId: null,
        kind: 'write-lock',
        skill: null,
        source: null,
        tool: null,
        scope: null,
        before: { kind: 'absent', resource: { kind: 'lock', location } },
        after: {
          kind: 'lock',
          location,
          version: 1,
          canonicalHash: digestB,
          value: { version: 1, hashSchemaVersion: 1, manifestHash: digestA, skills: [] },
        },
        mutates: { live: false, manifest: false, lock: true, ledger: false },
        reversibility: { kind: 'none', retentionResourceIds: [] },
        conflict: null,
      },
      actual: {
        before: [
          {
            resourceId: 'lock:artifact',
            role: 'lock',
            state: 'absent',
            repositoryRevision: null,
            location,
            version: null,
            canonicalHash: null,
          },
        ],
        after: [
          {
            resourceId: 'lock:artifact',
            role: 'lock',
            state: 'present',
            repositoryRevision: { kind: 'artifact-bytes', digest: digestB },
            location,
            version: 1,
            canonicalHash: digestB,
          },
        ],
        retained: [],
      },
    };
  }
  return {
    ...base,
    intent: {
      operationId: base.intent.operationId,
      groupId: `group-${role}`,
      pairId: null,
      kind: 'write-manifest',
      skill: null,
      source: null,
      tool: null,
      scope: null,
      before: { kind: 'absent', resource: { kind: 'manifest-bytes', location } },
      after: {
        kind: 'manifest',
        location,
        shape: 'canonical',
        version: 1,
        byteHash: digestB,
        semanticHash: digestB,
        value: { version: 1, defaults: null, registry: null, skills: [] },
      },
      mutates: { live: false, manifest: true, lock: false, ledger: false },
      reversibility: { kind: 'none', retentionResourceIds: [] },
      conflict: null,
    },
    actual: {
      before: [
        {
          resourceId: 'manifest:artifact',
          role: 'manifest',
          state: 'absent',
          repositoryRevision: null,
          location,
          shape: null,
          version: null,
          byteHash: null,
          semanticHash: null,
        },
      ],
      after: [
        {
          resourceId: 'manifest:artifact',
          role: 'manifest',
          state: 'present',
          repositoryRevision: { kind: 'artifact-bytes', digest: digestB },
          location,
          shape: 'canonical',
          version: 1,
          byteHash: digestB,
          semanticHash: digestB,
        },
      ],
      retained: [],
    },
  };
};

const emptyModel = (): LedgerModel => ({
  updatedAt: '2026-07-15T00:00:00.000Z',
  skills: {},
  projects: {},
  projectRegistrations: {},
  transactions: {},
  history: [],
});

const canonicalLedgerSource = (model: LedgerModel = emptyModel()): string => {
  const codec = artifactContractRegistry.get('ledger', 2);
  if (codec === undefined) throw new Error('ledger-v2 codec is not registered');
  const encoded = codec.encode(model);
  if (!encoded.ok) throw new Error(`ledger-v2 fixture encode failed: ${encoded.error.reason}`);
  return new TextDecoder().decode(encoded.value);
};

const selectedHistory = async (
  select: AnyFunction,
  model: LedgerModel,
): Promise<{
  readonly raw: unknown;
  readonly history: readonly LogicalJournalV1Dto[];
}> => {
  const raw = await unwrap(select(model), 'select bounded history');
  const history = Array.isArray(raw)
    ? raw
    : ((raw as Readonly<{ history?: unknown; retained?: unknown }>).history ??
      (raw as Readonly<{ retained?: unknown }>).retained);
  expect(Array.isArray(history), 'bounded history result').toBeTrue();
  return { raw, history: history as readonly LogicalJournalV1Dto[] };
};

const pairRecord = (path: string, pinned: boolean): LedgerPairV1Dto => ({
  placementPath: path,
  mode: 'dev',
  dev: {
    sourcePath: './skills/alpha',
    resolvedPath: '/fixture/source/alpha',
    repoRoot: '/fixture/project',
    sourceRelPath: 'skills/alpha',
    remote: null,
    recordedAt: '2026-07-15T00:00:00.000Z',
  },
  pinned: pinned
    ? {
        storePath: '/fixture/store/alpha',
        rev: 'fixture-revision',
        gitSha: null,
        dirty: false,
        contentHash: digestA,
        snapshotAt: '2026-07-15T00:00:00.000Z',
        verify: 'passed',
      }
    : null,
  journal: null,
});

const physicalShadow = (
  logical: LogicalJournalV1Dto,
  overrides: Readonly<Record<string, unknown>> = {},
): NonNullable<LedgerPairV1Dto['journal']> => {
  const operation =
    logical.disposition === 'rollback'
      ? 'rollback'
      : logical.intent.kind === 'remove'
        ? 'uninstall'
        : logical.intent.kind === 'link-dev'
          ? 'dev'
          : logical.intent.kind === 'promote'
            ? 'promote'
            : 'install';
  return {
    op: operation,
    txId: logical.transactionId,
    phase: logical.phase,
    startedAt: logical.context.startedAt,
    completedAt: logical.completedAt,
    before: { mode: 'absent' },
    stagingPath: `/fixture/stage/${logical.transactionId}`,
    backupPath: `/fixture/backup/${logical.transactionId}`,
    ...overrides,
  };
};

const modelWithShadow = (
  logical: LogicalJournalV1Dto,
  overrides: Readonly<Record<string, unknown>> = {},
): LedgerModel => ({
  ...emptyModel(),
  skills: {
    alpha: {
      tools: {
        codex: {
          placementPath: '/fixture/live/alpha',
          mode: 'pinned',
          dev: null,
          pinned: {
            storePath: '/fixture/store/alpha',
            rev: 'fixture-revision',
            gitSha: null,
            dirty: false,
            contentHash: digestB,
            snapshotAt: '2026-07-15T00:00:00.000Z',
            verify: 'passed',
          },
          journal: physicalShadow(logical, overrides),
        },
      },
    },
  },
  transactions: logical.phase === 'committed' ? {} : { [logical.transactionId]: logical },
  history: logical.phase === 'committed' ? [logical] : [],
});

const ledgerDto = (model: LedgerModel): UnknownRecord => ({
  schemaVersion: 2,
  kind: 'skillsmith.placements',
  ...model,
});

describe('EWP-P3B-TS04 — canonical ledger-v2 transactions, history, and local recovery', () => {
  test('fixture inventory and worker protocol are closed, exact, bounded, and self-checking', async () => {
    const cases = fixture();
    expect(cases.schemaVersion).toBe(1);
    expect(cases.fixtureCanary).toBe('p3b-ts04-local-ledger-reliability');
    expect(cases.timeoutMs).toBeGreaterThan(cases.terminationGraceMs);
    expect(cases.timeoutMs).toBeLessThanOrEqual(30_000);
    expect(cases.registrationCases.map((item) => item.id)).toHaveLength(5);
    expect(cases.logicalRefusalCases).toEqual([
      'phase-skip',
      'duplicate-pending-id',
      'pending-history-id-collision',
      'transaction-key-mismatch',
      'cross-pair-id-reuse',
      'forward-after-abort',
      'abort-unrelated-pair',
    ]);
    expect(cases.logicalPhases).toEqual(['prepared', 'staged', 'backed-up', 'live', 'committed']);
    expect(cases.history).toMatchObject({ ordinaryCapacity: 256, cleanupVictimsPerPass: 1 });
    expect(cases.crashCases).toHaveLength(cases.limits.maxCrashCases);
    expect(cases.recoveryCursorCases.length + cases.recoveryRefusalCases.length).toBe(
      cases.limits.maxRecoveryCases,
    );
    expect(new Set(cases.crashCases.map((item) => item.id)).size).toBe(cases.crashCases.length);
    expect(new Set(cases.crashCases.map((item) => item.barrier)).size).toBe(
      cases.crashCases.length,
    );
    for (const item of cases.crashCases) {
      exactRecord(item, ['id', 'mode', 'barrier'], `crash case ${item.id}`);
      expect(cases.protocol.modes).toContain(item.mode);
      expect(cases.protocol.barriers).toContain(item.barrier);
    }
    for (const item of cases.registrationCases) {
      exactRecord(
        item,
        ['id', 'scope', 'tool', 'pinned', 'pathChange', 'expectedProjectConsumers'],
        `registration case ${item.id}`,
      );
    }
    for (const item of cases.recoveryCursorCases) {
      exactRecord(
        item,
        ['id', 'cursor', 'live', 'stage', 'backup', 'permittedResidue', 'expected'],
        `recovery cursor ${item.id}`,
      );
    }
    for (const item of cases.recoveryRefusalCases) {
      exactRecord(item, ['id', 'kind'], `recovery refusal ${item.id}`);
    }
    expect(cases.shadowCases).toHaveLength(13);
    expect(cases.abortCases).toHaveLength(10);
    expect(cases.anchorCases).toHaveLength(9);
    expect(cases.cleanupCases).toHaveLength(13);
    expect(cases.protocol.journalPhases).toEqual(cases.logicalPhases);
    expect(new Set(cases.protocol.barriers).size).toBe(cases.protocol.barriers.length);

    const journalCodec = artifactContractRegistry.get('journal', 1);
    expect(journalCodec).toBeDefined();
    for (const candidate of [
      journal(1, 'prepared'),
      journal(2, 'staged'),
      journal(3, 'backed-up'),
      journal(4, 'live'),
      journal(5, 'committed'),
      journal(6, 'committed', {
        beforePath: '/fixture/live/before',
        afterPath: '/fixture/live/after',
        retained: 'protected',
      }),
      journal(7, 'committed', { retained: 'disposable' }),
      removeJournal(8, 'committed'),
      artifactJournal(9, 'manifest'),
      artifactJournal(10, 'lock'),
      artifactJournal(11, 'ledger'),
    ]) {
      const validated = journalCodec?.validate(candidate);
      expect(
        validated?.ok,
        `${candidate.phase}: ${JSON.stringify(validated?.ok === false ? validated.error : null)}`,
      ).toBeTrue();
    }

    expect(await runSelfCheck()).toEqual({
      kind: 'p3b-ts04-worker-self-check',
      protocolVersion: 1,
      timeoutMs: cases.timeoutMs,
      maxMessageBytes: cases.limits.maxMessageBytes,
      maxBarriers: 64,
      accepts: cases.protocol.accepts,
      emits: cases.protocol.emits,
      roles: cases.protocol.roles,
      modes: cases.protocol.modes,
      outcomes: cases.protocol.outcomes,
      journalPhases: cases.protocol.journalPhases,
      barriers: cases.protocol.barriers,
    });
  });

  test('distinguishes absence from invalid existing ledgers and preserves every inspected byte', async () => {
    const env = await defaultRuntimePorts();
    const root = await mkdtemp(join(tmpdir(), 'p3b-ts04-shapes-'));
    roots.push(root);
    for (const candidate of fixture().ledgerShapeCases) {
      const path = join(root, `${candidate.id}.json`);
      if (candidate.source !== null) await writeFile(path, candidate.source);
      const before = candidate.source === null ? null : await readFile(path);
      const result = await readLedgerArtifact(env, path);
      if (candidate.expected === 'absent') {
        expect(result.ok, candidate.id).toBeTrue();
        if (result.ok) {
          expect(result.value).toEqual({ state: 'absent', artifact: 'ledger', migration: null });
        }
      } else {
        expect(result.ok, candidate.id).toBeFalse();
        if (!result.ok && candidate.expected === 'upgrade') {
          expect(result.error.reason).toBe('unsupported-version');
        }
      }
      if (before !== null) expect(await readFile(path), `${candidate.id} bytes`).toEqual(before);
    }
  });

  test('keeps v1 read/dry-run bytes exact and plans visible migration before pair work', async () => {
    const fleet = await buildFixtureFleet();
    try {
      const path = ledgerPathOf(fleet.data);
      await writeFile(path, fixture().migrationCase.source);
      const before = await readFile(path);
      expect((await readLedgerArtifact(fleet.env, path)).ok).toBeTrue();
      const preview = await runPromote(
        fleet.env,
        { ...optionsFor(fleet), dryRun: true },
        dependencies,
      );
      expect(preview.ok).toBeTrue();
      expect(await readFile(path)).toEqual(before);
      if (preview.ok) {
        const kinds = preview.value.plan.operations.map((operation) => operation.kind);
        expect(kinds[0]).toBe('migrate-ledger');
        expect(kinds).toContain('promote');
      }
    } finally {
      await destroyFixtureFleet(fleet);
    }
  });

  test('migrates nonempty v1 bytes to the exact canonical v2 legacy projection', async () => {
    const fleet = await buildFixtureFleet();
    try {
      const path = ledgerPathOf(fleet.data);
      await writeFile(path, fixture().migrationCase.source);
      const before = await readLedgerArtifact(fleet.env, path);
      expect(before.ok).toBeTrue();
      if (!before.ok || before.value.state !== 'present') return;
      expect(before.value.sourceVersion).toBe(1);
      const migrated = await runPromote(fleet.env, optionsFor(fleet), dependencies);
      expect(migrated.ok).toBeTrue();
      const after = await readLedgerArtifact(fleet.env, path);
      expect(after.ok).toBeTrue();
      if (!after.ok || after.value.state !== 'present') return;
      expect(after.value.sourceVersion).toBe(2);
      expect(after.value.canonical).toBeTrue();
      expect(after.value.model.skills.legacy).toEqual(before.value.model.skills.legacy);
      expect(after.value.model.projects).toEqual(before.value.model.projects);
      expect(after.value.model.projectRegistrations).toEqual(
        before.value.model.projectRegistrations,
      );
      const legacy = after.value.model.skills.legacy?.tools.codex;
      expect(legacy?.pinned).toMatchObject({
        storePath: '/fixture/store/legacy',
        contentHash: digestA,
      });
      expect(legacy?.journal).toMatchObject({
        txId: 'legacy-unmatched-tx',
        phase: 'committed',
      });
    } finally {
      await destroyFixtureFleet(fleet);
    }
  });

  test('derives registrations across scope, retained pinned facts, path change, and unknown tool', async () => {
    const setPairAt = requiredFunction(ledger, 'setPairAt');
    for (const candidate of fixture().registrationCases) {
      const before = emptyModel();
      const beforeSnapshot = structuredClone(before);
      const projectRoot = candidate.scope === 'project' ? '/fixture/project' : null;
      const firstPath = `/fixture/${candidate.scope}/old/alpha`;
      const first = await unwrapModel(
        setPairAt(
          before,
          projectRoot,
          'alpha',
          candidate.tool,
          pairRecord(firstPath, candidate.pinned),
        ),
        candidate.id,
      );
      expect(before).toEqual(beforeSnapshot);
      const model = candidate.pathChange
        ? await unwrapModel(
            setPairAt(
              first,
              projectRoot,
              'alpha',
              candidate.tool,
              pairRecord(`/fixture/${candidate.scope}/new/alpha`, candidate.pinned),
            ),
            `${candidate.id} path change`,
          )
        : first;
      const registrations = model.projectRegistrations['/fixture/project'];
      const consumers = registrations?.consumers ?? [];
      expect(consumers).toHaveLength(candidate.expectedProjectConsumers);
      if (candidate.scope === 'project') {
        expect(consumers[0]).toMatchObject({
          skill: 'alpha',
          tool: candidate.tool,
          placementPath: candidate.pathChange
            ? '/fixture/project/new/alpha'
            : '/fixture/project/old/alpha',
          store: candidate.pinned ? { path: '/fixture/store/alpha', contentHash: digestA } : null,
        });
      }
    }
  });

  test('sorts multiple consumers/projects and removes stale, extra, and deleted pairs', async () => {
    const setPairAt = requiredFunction(ledger, 'setPairAt');
    const deletePairAt = requiredFunction(ledger, 'deletePairAt');
    let model: LedgerModel = {
      ...emptyModel(),
      projectRegistrations: {
        '/stale/project': {
          consumers: [
            {
              skill: 'stale',
              tool: 'codex',
              placementPath: '/stale/path',
              store: null,
            },
          ],
        },
      },
    };
    for (const [root, skill, tool] of [
      ['/fixture/project-b', 'zeta', 'codex'],
      ['/fixture/project-b', 'alpha', 'fixture-tool'],
      ['/fixture/project-a', 'beta', 'codex'],
      ['/fixture/project-a', 'alpha', 'claude-code'],
    ] as const) {
      model = await unwrapModel(
        setPairAt(model, root, skill, tool, pairRecord(`${root}/.skills/${skill}-${tool}`, true)),
        `add ${root}:${skill}:${tool}`,
      );
    }
    expect(Object.keys(model.projectRegistrations)).toEqual([
      '/fixture/project-a',
      '/fixture/project-b',
    ]);
    expect(
      model.projectRegistrations['/fixture/project-a']?.consumers.map(
        ({ skill, tool }) => `${skill}:${tool}`,
      ),
    ).toEqual(['alpha:claude-code', 'beta:codex']);
    expect(
      model.projectRegistrations['/fixture/project-b']?.consumers.map(
        ({ skill, tool }) => `${skill}:${tool}`,
      ),
    ).toEqual(['alpha:fixture-tool', 'zeta:codex']);

    model = await unwrapModel(
      deletePairAt(model, '/fixture/project-b', 'alpha', 'fixture-tool'),
      'remove one project consumer',
    );
    expect(
      model.projectRegistrations['/fixture/project-b']?.consumers.map(({ skill }) => skill),
    ).toEqual(['zeta']);
    model = await unwrapModel(
      deletePairAt(model, '/fixture/project-b', 'zeta', 'codex'),
      'remove final project consumer',
    );
    expect(model.projects['/fixture/project-b']).toBeUndefined();
    expect(model.projectRegistrations['/fixture/project-b']).toBeUndefined();
  });

  test('first mutation creates v2 and commits one exact logical/physical-shadow transaction', async () => {
    const fleet = await buildFixtureFleet();
    try {
      const result = await runPromote(fleet.env, optionsFor(fleet), dependencies);
      expect(result.ok).toBeTrue();
      const value = JSON.parse(await readFile(ledgerPathOf(fleet.data), 'utf8')) as UnknownRecord;
      expect(value.schemaVersion).toBe(2);
      expect(value.transactions).toEqual({});
      const history = value.history as UnknownRecord[];
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        kind: 'skillsmith.transaction-journal',
        phase: 'committed',
        disposition: 'forward',
        completedAt: expect.any(String),
        context: { attempt: 1 },
      });
      const skills = value.skills as UnknownRecord;
      const pair = ((skills.alpha as UnknownRecord).tools as UnknownRecord)[
        'claude-code'
      ] as UnknownRecord;
      expect(pair.journal ?? null).toBeNull();
    } finally {
      await destroyFixtureFleet(fleet);
    }
  });

  test('requires exact physical/logical shadow equality and rejects every mismatch dimension', () => {
    const codec = artifactContractRegistry.get('ledger', 2);
    expect(codec).toBeDefined();
    for (const [index, phase] of fixture().logicalPhases.slice(0, -1).entries()) {
      const logical = journal(100 + index, phase);
      expect(codec?.validate(ledgerDto(modelWithShadow(logical))).ok, phase).toBeTrue();
    }
    const committed = journal(120, 'committed');
    const committedWithShadow = modelWithShadow(committed);
    const committedPair = committedWithShadow.skills.alpha?.tools.codex;
    expect(committedPair).toBeDefined();
    const terminalInstall: LedgerModel = {
      ...committedWithShadow,
      skills: {
        alpha: {
          tools: {
            codex: { ...(committedPair as LedgerPairV1Dto), journal: null },
          },
        },
      },
    };
    expect(
      codec?.validate(ledgerDto(terminalInstall)).ok,
      'committed install deletes its physical shadow',
    ).toBeTrue();
    expect(
      codec?.validate(ledgerDto({ ...emptyModel(), history: [removeJournal(121, 'committed')] }))
        .ok,
      'committed remove deletes the physical pair and shadow atomically',
    ).toBeTrue();

    const live = journal(122, 'live');
    const liveWithShadow = modelWithShadow(live);
    const livePair = liveWithShadow.skills.alpha?.tools.codex;
    expect(livePair).toBeDefined();
    const missingRequiredShadow: LedgerModel = {
      ...liveWithShadow,
      skills: {
        alpha: {
          tools: {
            codex: { ...(livePair as LedgerPairV1Dto), journal: null },
          },
        },
      },
    };
    expect(
      codec?.validate(ledgerDto(missingRequiredShadow)).ok,
      'nonterminal logical journal requires its exact physical shadow',
    ).toBeFalse();

    const mismatches: readonly LedgerModel[] = [
      modelWithShadow(live, { txId: 'other-transaction' }),
      modelWithShadow(journal(123, 'live', { skill: 'other-pair' })),
      modelWithShadow(live, { startedAt: '2026-07-15T01:00:00.000Z' }),
      modelWithShadow(live, { completedAt: '2026-07-15T01:00:00.000Z' }),
      modelWithShadow(live, { phase: 'staged', completedAt: null }),
      modelWithShadow(live, { op: 'dev' }),
    ];
    const mismatchLabels = [
      'transaction-mismatch',
      'pair-mismatch',
      'started-at-mismatch',
      'completed-at-mismatch',
      'phase-mismatch',
      'operation-family-mismatch',
    ] as const;
    expect(mismatches).toHaveLength(6);
    for (const [index, candidate] of mismatches.entries()) {
      expect(codec?.validate(ledgerDto(candidate)).ok, mismatchLabels[index]).toBeFalse();
    }
  });

  test('attaches legacy shadows, collapses committed status, and applies family cleanup rules', async () => {
    const advance = requiredFunction(core, 'advanceLogicalTransaction');
    const commit = requiredFunction(core, 'commitLogicalTransaction');
    const collapse = requiredFunction(core, 'collapseLogicalTransactionShadows');
    const prepared = journal(130, 'prepared');
    const legacyOnly = { ...modelWithShadow(prepared), transactions: {} };
    let attached = await unwrapModel(advance(legacyOnly, prepared), 'attach legacy shadow');
    expect(attached.transactions[prepared.transactionId]?.transactionId).toBe(
      prepared.transactionId,
    );
    for (const phase of ['staged', 'backed-up', 'live'] as const) {
      attached = await unwrapModel(advance(attached, journal(130, phase)), `shadow ${phase}`);
      const pair = attached.skills.alpha?.tools.codex;
      expect(pair?.journal).toMatchObject({
        txId: prepared.transactionId,
        phase,
        startedAt: prepared.context.startedAt,
      });
    }
    const installed = await unwrapModel(
      commit(attached, journal(130, 'committed')),
      'install shadow terminal cleanup',
    );
    expect(installed.skills.alpha?.tools.codex?.journal ?? null).toBeNull();
    const collapsed = await unwrap(
      collapse(modelWithShadow(journal(131, 'committed'))),
      'collapse committed logical and physical shadow',
    );
    expect(collapsed).toMatchObject({
      transactionIds: ['transaction-0131'],
      duplicateCount: 0,
    });
    const removeLive = removeJournal(132, 'live');
    const removed = await unwrapModel(
      commit(modelWithShadow(removeLive, { op: 'uninstall' }), removeJournal(132, 'committed')),
      'remove shadow terminal cleanup',
    );
    expect(removed.skills.alpha?.tools.codex).toBeUndefined();
  });

  test('enforces every logical phase, identity refusal, pending precedence, abort, and pair isolation', async () => {
    const advance = requiredFunction(core, 'advanceLogicalTransaction');
    const commit = requiredFunction(core, 'commitLogicalTransaction');
    const abort = requiredFunction(core, 'abortPendingLogicalTransaction');
    let model = emptyModel();
    for (const phase of fixture().logicalPhases.slice(0, -1)) {
      model = await unwrapModel(advance(model, journal(1, phase)), `advance ${phase}`);
      expect(model.transactions['transaction-0001']?.phase).toBe(phase);
      expect(Object.keys(model.transactions)).toEqual(['transaction-0001']);
      if (phase === 'staged') {
        model = await unwrapModel(
          advance(model, journal(1, phase)),
          'same-operation staged convergence',
        );
        expect(Object.keys(model.transactions)).toEqual(['transaction-0001']);
      }
    }
    model = await unwrapModel(commit(model, journal(1, 'committed')), 'commit');
    expect(model.transactions).toEqual({});
    expect(model.history.map((item) => item.transactionId)).toEqual(['transaction-0001']);
    model = await unwrapModel(commit(model, journal(1, 'committed')), 'idempotent commit');
    expect(model.history.map((item) => item.transactionId)).toEqual(['transaction-0001']);

    const prepared = journal(2, 'prepared');
    const preparedModel = await unwrapModel(advance(model, prepared), 'prepare refusal seed');
    await expectRefusal(
      () => advance(preparedModel, journal(2, 'live')),
      'non-adjacent phase skip',
    );
    await expectRefusal(
      () =>
        advance(preparedModel, {
          ...prepared,
          intent: { ...prepared.intent, operationId: 'operation-collision' },
        }),
      'duplicate pending ID with different operation',
    );
    await expectRefusal(
      () => advance({ ...preparedModel, history: [journal(2, 'committed')] }, prepared),
      'pending/history collision',
    );
    await expectRefusal(
      () =>
        advance(
          {
            ...model,
            transactions: { wrongKey: prepared },
          },
          prepared,
        ),
      'transaction key mismatch',
    );
    await expectRefusal(
      () =>
        advance(
          {
            ...model,
            transactions: {
              [prepared.transactionId]: journal(2, 'prepared', { skill: 'other' }),
            },
          },
          prepared,
        ),
      'cross-pair ID reuse',
    );

    const alpha = journal(3, 'prepared', { skill: 'alpha' });
    const beta = journal(4, 'prepared', { skill: 'beta' });
    let isolated = await unwrapModel(advance(model, alpha), 'prepare alpha');
    isolated = await unwrapModel(advance(isolated, beta), 'prepare beta');
    const precedence = await unwrapModel(
      abort(isolated, {
        transactionId: alpha.transactionId,
        pairId: alpha.intent.pairId,
        command: 'internal-abort',
        workflow: 'P3B-TS04',
        updatedAt: '2026-07-15T00:00:01.000Z',
      }),
      'pending transaction precedes committed history',
    );
    expect(precedence.transactions[alpha.transactionId]?.disposition).toBe('rollback');
    expect(precedence.history.map((item) => item.transactionId)).toEqual(['transaction-0001']);
    const aborted = await unwrapModel(
      abort(isolated, {
        transactionId: beta.transactionId,
        pairId: beta.intent.pairId,
        command: 'internal-abort',
        workflow: 'P3B-TS04',
        updatedAt: '2026-07-15T00:00:01.000Z',
      }),
      'abort beta in place',
    );
    expect(aborted.transactions[alpha.transactionId]).toEqual(alpha);
    expect(aborted.transactions[beta.transactionId]).toMatchObject({
      transactionId: beta.transactionId,
      disposition: 'rollback',
      phase: 'prepared',
      context: { parentOperationId: beta.intent.operationId, attempt: 2 },
    });
    await expectRefusal(
      () => advance(aborted, journal(4, 'staged', { skill: 'beta' })),
      'forward work after abort',
    );
    await expectRefusal(
      () =>
        abort(isolated, {
          transactionId: beta.transactionId,
          pairId: 'pair-unrelated',
          command: 'internal-abort',
          workflow: 'P3B-TS04',
          updatedAt: '2026-07-15T00:00:01.000Z',
        }),
      'unrelated pair abort',
    );
    expect(model.history[0]?.transactionId).toBe('transaction-0001');
  });

  test('validates retained resources before durable abort and resumes rollback only', async () => {
    const advance = requiredFunction(core, 'advanceLogicalTransaction');
    const abort = requiredFunction(core, 'abortPendingLogicalTransaction');
    const commit = requiredFunction(core, 'commitLogicalTransaction');
    const pending = journal(200, 'prepared', { retained: 'protected' });
    const model = await unwrapModel(advance(emptyModel(), pending), 'prepare retained abort');
    const retained = pending.actual.retained[0];
    expect(retained).toBeDefined();
    const verified = {
      transactionId: pending.transactionId,
      pairId: pending.intent.pairId,
      command: 'internal-abort',
      workflow: 'P3B-TS04',
      updatedAt: '2026-07-15T00:00:01.000Z',
      retainedResources: [
        {
          resourceId: retained?.resourceId,
          path: retained?.path,
          repositoryRevision: retained?.repositoryRevision,
          contentHash: retained?.contentHash,
          state: 'present',
          owned: true,
          kind: 'dir',
          beforeIdentity: 'retained:stable',
          afterIdentity: 'retained:stable',
        },
      ],
    };
    const rollback = await unwrapModel(abort(model, verified), 'durable retained abort');
    const rollbackJournal = rollback.transactions[pending.transactionId];
    expect(rollbackJournal).toMatchObject({
      transactionId: pending.transactionId,
      disposition: 'rollback',
      phase: 'prepared',
      actual: { retained: pending.actual.retained },
      context: {
        attempt: 2,
        parentOperationId: pending.intent.operationId,
        startedAt: pending.context.startedAt,
      },
    });
    expect(rollbackJournal?.context.startedAt).toBe(pending.context.startedAt);
    const rollbackShadow = rollback.skills.alpha?.tools.codex?.journal;
    expect(rollbackShadow).toMatchObject({ op: 'rollback' });
    expect(rollbackShadow).toEqual(physicalShadow(rollbackJournal as LogicalJournalV1Dto));

    for (const [label, mutation] of [
      ['missing', { state: 'absent' }],
      ['stale revision', { repositoryRevision: { kind: 'resource', digest: digestB } }],
      ['unowned', { owned: false }],
      ['hash mismatch', { contentHash: digestB }],
      ['wrong kind', { kind: 'file' }],
      ['missing identity', { beforeIdentity: null }],
      ['replaced identity', { afterIdentity: 'retained:replacement' }],
    ] as const) {
      await expectRefusal(
        () =>
          abort(model, {
            ...verified,
            retainedResources: [{ ...verified.retainedResources[0], ...mutation }],
          }),
        `${label} retained resource`,
      );
      expect(model.transactions[pending.transactionId]).toEqual(pending);
    }

    const cancelled = new AbortController();
    cancelled.abort();
    await expectRefusal(
      () => abort(model, { ...verified, signal: cancelled.signal }),
      'cancel before abort boundary',
    );
    const afterBoundary = (await Promise.resolve(
      abort(model, { ...verified, cancelAt: 'after-durable-boundary' }),
    )) as Readonly<{
      ok: boolean;
      error?: Readonly<{ code?: string; durableModel?: LedgerModel }>;
    }>;
    expect(afterBoundary.ok).toBeFalse();
    expect(afterBoundary.error?.code).toMatch(/cancel/u);
    expect(afterBoundary.error?.durableModel?.transactions[pending.transactionId]).toMatchObject({
      disposition: 'rollback',
      phase: 'prepared',
    });
    await expectRefusal(
      () => advance(rollback, journal(200, 'staged', { retained: 'protected' })),
      'forward resume after durable abort',
    );
    const rollbackPending = rollback.transactions[pending.transactionId];
    expect(rollbackPending).toBeDefined();
    const completed: LogicalJournalV1Dto = {
      ...(rollbackPending as LogicalJournalV1Dto),
      phase: 'committed',
      actual: {
        ...(rollbackPending as LogicalJournalV1Dto).actual,
        after: (rollbackPending as LogicalJournalV1Dto).actual.before,
      },
      updatedAt: '2026-07-15T00:00:02.000Z',
      completedAt: '2026-07-15T00:00:02.000Z',
    };
    const rollbackBeforeTerminal = structuredClone(rollback);
    const resumed = await unwrapModel(commit(rollback, completed), 'resume rollback commit');
    expect(rollback).toEqual(rollbackBeforeTerminal);
    expect(resumed.transactions).toEqual({});
    expect(
      resumed.history.filter((item) => item.transactionId === pending.transactionId),
    ).toHaveLength(1);
    expect(resumed.history.at(-1)).toMatchObject({
      disposition: 'rollback',
      phase: 'committed',
      context: { startedAt: pending.context.startedAt, attempt: 2 },
    });
    expect(resumed.skills.alpha?.tools.codex).toBeUndefined();
  });

  test('selects 256 complete journals with protection, breadth fairness, and multi-anchor dedup', async () => {
    const select = requiredFunction(core, 'selectBoundedHistory');
    const cases = fixture();
    const depth = Array.from({ length: cases.history.seedCount }, (_, index) =>
      journal(index, 'committed'),
    );
    const suffix = await selectedHistory(select, { ...emptyModel(), history: depth });
    expect(suffix.history).toHaveLength(cases.history.ordinaryCapacity);
    expect(suffix.history[0]?.transactionId).toBe('transaction-0004');
    expect(suffix.history.at(-1)?.transactionId).toBe('transaction-0259');

    const allProtected = Array.from(
      { length: cases.history.protectedOverCapacityCount },
      (_, index) => journal(index, 'committed', { skill: `pair-${index}` }),
    );
    expect(
      (await selectedHistory(select, { ...emptyModel(), history: allProtected })).history,
    ).toHaveLength(cases.history.protectedOverCapacityCount);

    const quietOld = journal(0, 'committed', { skill: 'quiet-beta' });
    const quietNew = journal(1, 'committed', { skill: 'quiet-beta' });
    const busy = Array.from({ length: 260 }, (_, index) =>
      journal(index + 2, 'committed', { skill: 'busy-alpha' }),
    );
    const fair = await selectedHistory(select, {
      ...emptyModel(),
      history: [quietOld, quietNew, ...busy],
    });
    expect(fair.history.map((item) => item.transactionId)).toContain(quietOld.transactionId);
    expect(fair.history.map((item) => item.transactionId)).toContain(quietNew.transactionId);
    expect(fair.history).toHaveLength(256);

    const protectedOld = journal(0, 'committed', {
      skill: 'retained-alpha',
      retained: 'protected',
    });
    const protectedSelection = await selectedHistory(select, {
      ...emptyModel(),
      history: [protectedOld, ...depth.slice(1)],
    });
    expect(protectedSelection.history.map((item) => item.transactionId)).toContain(
      protectedOld.transactionId,
    );

    const moving = journal(500, 'committed', {
      skill: 'moving',
      beforePath: '/fixture/live/old-moving',
      afterPath: '/fixture/live/new-moving',
    });
    const multi = await selectedHistory(select, {
      ...emptyModel(),
      history: [...depth, moving],
    });
    expect(
      multi.history.filter((item) => item.transactionId === moving.transactionId),
    ).toHaveLength(1);
    const positions = multi.history.map((item) => Number(item.transactionId.split('-').at(-1)));
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  test('honors pending/absent/artifact anchors, UTF-16 depth order, and timestamp independence', async () => {
    const select = requiredFunction(core, 'selectBoundedHistory');
    const base = Array.from({ length: 254 }, (_, index) =>
      journal(index + 20, 'committed', { skill: 'busy' }),
    );
    const quietOld = journal(1, 'committed', { skill: 'quiet' });
    const quietNew = journal(2, 'committed', { skill: 'quiet' });
    const pending = journal(3, 'prepared', { skill: 'quiet' });
    const absentAfter = removeJournal(4, 'committed');
    const manifest = artifactJournal(5, 'manifest');
    const lock = artifactJournal(6, 'lock');
    const ledgerAnchor = artifactJournal(7, 'ledger');
    const anchored = await selectedHistory(select, {
      ...emptyModel(),
      transactions: { [pending.transactionId]: pending },
      history: [quietOld, quietNew, absentAfter, manifest, lock, ledgerAnchor, ...base],
    });
    const anchoredIds = anchored.history.map((item) => item.transactionId);
    for (const candidate of [quietNew, absentAfter, manifest, lock, ledgerAnchor]) {
      expect(anchoredIds, candidate.transactionId).toContain(candidate.transactionId);
    }

    const oldArtifactSeed = artifactJournal(9, 'manifest');
    if (oldArtifactSeed.intent.after.kind !== 'manifest') {
      throw new Error('P3B-TS04 pending artifact anchor invariant');
    }
    const oldArtifact: LogicalJournalV1Dto = {
      ...oldArtifactSeed,
      intent: {
        ...oldArtifactSeed.intent,
        after: {
          ...oldArtifactSeed.intent.after,
          byteHash: digestC,
          semanticHash: digestC,
        },
      },
      actual: {
        ...oldArtifactSeed.actual,
        after: oldArtifactSeed.actual.after.map((resource) =>
          resource.role === 'manifest'
            ? {
                ...resource,
                repositoryRevision: { kind: 'artifact-bytes', digest: digestC },
                byteHash: digestC,
                semanticHash: digestC,
              }
            : resource,
        ),
      },
    };
    const newerArtifacts = Array.from({ length: 260 }, (_, index) =>
      artifactJournal(index + 1_000, 'manifest'),
    );
    const pendingArtifactSeed = artifactJournal(11, 'manifest');
    const pendingArtifact: LogicalJournalV1Dto = {
      ...pendingArtifactSeed,
      intent: { ...pendingArtifactSeed.intent, before: oldArtifact.intent.after },
      phase: 'prepared',
      actual: { before: oldArtifact.actual.after, after: [], retained: [] },
      completedAt: null,
    };
    const evictionDepth = Array.from({ length: 260 }, (_, index) =>
      journal(index + 600, 'committed', { skill: 'artifact-anchor-competition' }),
    );
    const withoutPending = await selectedHistory(select, {
      ...emptyModel(),
      history: [oldArtifact, ...newerArtifacts, ...evictionDepth],
    });
    expect(withoutPending.history.map((item) => item.transactionId)).not.toContain(
      oldArtifact.transactionId,
    );
    const withPending = await selectedHistory(select, {
      ...emptyModel(),
      transactions: { [pendingArtifact.transactionId]: pendingArtifact },
      history: [oldArtifact, ...newerArtifacts, ...evictionDepth],
    });
    expect(withPending.history.map((item) => item.transactionId)).toContain(
      oldArtifact.transactionId,
    );

    const anchorless: LogicalJournalV1Dto = {
      ...artifactJournal(8, 'ledger'),
      intent: {
        ...artifactJournal(8, 'ledger').intent,
        mutates: { live: false, manifest: false, lock: false, ledger: false },
      },
      actual: { before: [], after: [], retained: [] },
    };
    await expectRefusal(
      () => select({ ...emptyModel(), history: [anchorless] }),
      'anchorless committed journal',
    );

    const utf16Cases = [
      journal(300, 'committed', { skill: '\u{10000}' }),
      journal(301, 'committed', { skill: '\uE000' }),
      journal(302, 'committed', { skill: '\u{10000}' }),
      journal(303, 'committed', { skill: '\uE000' }),
    ];
    const depth = await unwrap(
      select(
        { ...emptyModel(), history: [...base, ...utf16Cases] },
        { includeSelectionTrace: true },
      ),
      'UTF-16 depth fairness trace',
    );
    expect(depth).toMatchObject({
      depthOrder: [0, 1],
      anchorOrder: expect.arrayContaining(['\u{10000}', '\uE000']),
    });
    const trace = depth as Readonly<{
      anchorOrder: readonly string[];
      history: LogicalJournalV1Dto[];
    }>;
    expect(trace.anchorOrder.indexOf('\u{10000}')).toBeLessThan(
      trace.anchorOrder.indexOf('\uE000'),
    );

    const reversedTimes = [...base, ...utf16Cases].map((item, index, all) => ({
      ...item,
      context: {
        ...item.context,
        startedAt: all.at(-(index + 1))?.context.startedAt ?? item.context.startedAt,
      },
      updatedAt: all.at(-(index + 1))?.updatedAt ?? item.updatedAt,
      completedAt: all.at(-(index + 1))?.completedAt ?? item.completedAt,
    }));
    const normal = await selectedHistory(select, {
      ...emptyModel(),
      history: [...base, ...utf16Cases],
    });
    const reversed = await selectedHistory(select, {
      ...emptyModel(),
      history: reversedTimes,
    });
    expect(reversed.history.map((item) => item.transactionId)).toEqual(
      normal.history.map((item) => item.transactionId),
    );

    const oldPath = journal(400, 'committed', { skill: 'moving', afterPath: '/old' });
    const newPath = journal(401, 'committed', { skill: 'moving', afterPath: '/new' });
    const moving = journal(402, 'committed', {
      skill: 'moving',
      beforePath: '/old',
      afterPath: '/new',
    });
    const competition = await selectedHistory(select, {
      ...emptyModel(),
      history: [...base, oldPath, newPath, moving],
    });
    expect(
      competition.history.filter((item) => item.transactionId === moving.transactionId),
    ).toHaveLength(1);
    expect(competition.history.map((item) => item.transactionId)).toContain(oldPath.transactionId);
    expect(competition.history.map((item) => item.transactionId)).toContain(newPath.transactionId);
  });

  test('exposes one cleanup victim/tombstone at a time and never reveals an older unsafe victim', async () => {
    const select = requiredFunction(core, 'selectBoundedHistory');
    const victim = journal(0, 'committed', { retained: 'disposable' });
    const history = [
      victim,
      ...Array.from({ length: 256 }, (_, index) => journal(index + 1, 'committed')),
    ];
    const pending = await unwrap(select({ ...emptyModel(), history }), 'select cleanup victim');
    expect(pending).toMatchObject({
      history: expect.any(Array),
      cleanupVictim: {
        transactionId: victim.transactionId,
        status: 'pending',
      },
    });
    const pendingRecord = pending as Readonly<{
      history: readonly LogicalJournalV1Dto[];
      cleanupVictim: Readonly<{ transactionId: string; status: string }> | null;
    }>;
    expect(pendingRecord.history).toHaveLength(257);
    expect(pendingRecord.cleanupVictim).not.toBeNull();

    const unsafe = await unwrap(
      select(
        { ...emptyModel(), history },
        {
          cleanup: {
            transactionId: victim.transactionId,
            outcome: 'unsafe',
          },
        },
      ),
      'retain unsafe cleanup tombstone',
    );
    expect(unsafe).toMatchObject({
      history: expect.any(Array),
      cleanupVictim: { transactionId: victim.transactionId, status: 'unsafe' },
    });
    expect((unsafe as { history: unknown[] }).history).toHaveLength(257);

    const cleaned = await unwrap(
      select(
        { ...emptyModel(), history },
        {
          cleanup: {
            transactionId: victim.transactionId,
            outcome: 'deleted',
          },
        },
      ),
      'complete one cleanup victim',
    );
    expect((cleaned as { history: unknown[] }).history).toHaveLength(256);
    expect((cleaned as { cleanupVictim: unknown }).cleanupVictim).toBeNull();
  });

  test('preflights and durably deletes one owned backup while preserving stores and blockers', async () => {
    const cleanup = requiredFunction(core, 'cleanupHistoryVictim');
    const advance = requiredFunction(core, 'advanceLogicalTransaction');
    const select = requiredFunction(core, 'selectBoundedHistory');
    const root = await mkdtemp(join(tmpdir(), 'p3b-ts04-cleanup-'));
    roots.push(root);
    const transactionId = 'transaction-cleanup';
    const transactionDir = join(root, `.skillsmith-artifact-${transactionId}`);
    const backupPath = join(transactionDir, 'live.backup');
    const storePath = join(root, 'store', 'preserved');
    await mkdir(transactionDir, { recursive: true });
    await chmod(transactionDir, 0o700);
    await mkdir(storePath, { recursive: true });
    const bytes = Buffer.from('owned backup bytes\n');
    await writeFile(backupPath, bytes);
    await writeFile(join(storePath, 'SKILL.md'), '# preserved\n');
    const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const victimSeed = journal(500, 'committed', {
      transactionId,
      retained: 'disposable',
    });
    const victim: LogicalJournalV1Dto = {
      ...victimSeed,
      intent: {
        ...victimSeed.intent,
        reversibility: {
          kind: 'conditional',
          retentionResourceIds: ['backup:cleanup', 'store:cleanup'],
        },
      },
      actual: {
        ...victimSeed.actual,
        retained: [
          {
            resourceId: 'backup:cleanup',
            role: 'backup',
            sourceRole: 'live',
            path: backupPath,
            repositoryRevision: { kind: 'resource', digest: hash },
            contentHash: hash,
            retainUntil: null,
          },
          {
            resourceId: 'store:cleanup',
            role: 'store',
            path: storePath,
            repositoryRevision: { kind: 'resource', digest: hash },
            contentHash: hash,
            retainUntil: null,
          },
        ],
      },
    };
    const history = [
      victim,
      ...Array.from({ length: 256 }, (_, index) => journal(index + 501, 'committed')),
    ];
    const cleanupSeed = { ...emptyModel(), history };
    const tombstoneModel = await unwrapModel(select(cleanupSeed), 'select live cleanup tombstone');
    expect(tombstoneModel.history).toHaveLength(257);
    expect((tombstoneModel as unknown as UnknownRecord).cleanupVictim).toMatchObject({
      transactionId,
      status: 'pending',
    });
    const ledgerRevision = digestC;
    const basePorts = await defaultRuntimePorts();
    const calls: string[] = [];
    const filesystemPortNames = new Set([
      'fileExists',
      'pathKind',
      'realpath',
      'listDir',
      'readText',
      'readBytes',
      'readLink',
      'isExecutable',
      'modifiedAt',
      'readFileMetadata',
      'assertWritableDirectory',
      'makeDir',
      'writeTextFile',
      'makeSymlink',
      'rename',
      'copyTree',
      'removeTree',
      'fsyncFile',
      'fsyncDir',
      'setFileMode',
      'withFileLock',
    ]);
    const ports = new Proxy(basePorts, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof property !== 'string' || !filesystemPortNames.has(property)) return value;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          calls.push(`${property}:${String(args[0] ?? '')}`);
          return Reflect.apply(value, target, args);
        };
      },
    });

    const backup = victim.actual.retained.find((resource) => resource.role === 'backup');
    if (backup === undefined) throw new Error('cleanup victim backup missing');
    const withBackup = (model: LedgerModel, replacement: typeof backup): LedgerModel => ({
      ...model,
      history: model.history.map((candidate) =>
        candidate.transactionId === transactionId
          ? {
              ...candidate,
              actual: {
                ...candidate.actual,
                retained: candidate.actual.retained.map((resource) =>
                  resource.role === 'backup' ? replacement : resource,
                ),
              },
            }
          : candidate,
      ),
    });
    const pendingReferenceSeed = journal(900, 'prepared', { skill: 'pending-reference' });
    const pendingReference: LogicalJournalV1Dto = {
      ...pendingReferenceSeed,
      intent: {
        ...pendingReferenceSeed.intent,
        reversibility: { kind: 'conditional', retentionResourceIds: [backup.resourceId] },
      },
      actual: { ...pendingReferenceSeed.actual, retained: [backup] },
    };
    const keptReferenceModel: LedgerModel = {
      ...tombstoneModel,
      history: tombstoneModel.history.map((candidate, index) =>
        index === tombstoneModel.history.length - 1
          ? { ...candidate, actual: { ...candidate.actual, retained: [backup] } }
          : candidate,
      ),
    };
    const legacyReferencePair: LedgerPairV1Dto = {
      placementPath: '/fixture/live/legacy-reference',
      mode: 'pinned',
      dev: null,
      pinned: null,
      journal: {
        op: 'install',
        txId: 'legacy-reference',
        phase: 'committed',
        startedAt: '2026-07-15T00:00:00.000Z',
        completedAt: '2026-07-15T00:00:01.000Z',
        before: { mode: 'absent' },
        stagingPath: '/fixture/staging/legacy-reference',
        backupPath,
      },
    };
    const liveReferencePair: LedgerPairV1Dto = {
      placementPath: backupPath,
      mode: 'pinned',
      dev: null,
      pinned: null,
      journal: null,
    };
    const refusalModels = [
      [
        'path-escape',
        withBackup(tombstoneModel, { ...backup, path: join(root, '..', 'foreign.backup') }),
      ],
      [
        'filename-mismatch',
        withBackup(tombstoneModel, { ...backup, path: join(transactionDir, 'foreign.backup') }),
      ],
      [
        'revision-mismatch',
        withBackup(tombstoneModel, {
          ...backup,
          repositoryRevision: { kind: 'resource', digest: digestB },
          contentHash: digestB,
        }),
      ],
      ['hash-mismatch', withBackup(tombstoneModel, { ...backup, contentHash: digestB })],
      [
        'pending-reference-blocker',
        {
          ...tombstoneModel,
          transactions: { [pendingReference.transactionId]: pendingReference },
        },
      ],
      ['kept-history-reference-blocker', keptReferenceModel],
      [
        'legacy-reference-blocker',
        {
          ...tombstoneModel,
          skills: { legacy: { tools: { codex: legacyReferencePair } } },
        },
      ],
      [
        'live-reference-blocker',
        {
          ...tombstoneModel,
          skills: { live: { tools: { codex: liveReferencePair } } },
        },
      ],
    ] as const satisfies readonly (readonly [string, LedgerModel])[];

    for (const [kind, refusalModel] of refusalModels) {
      calls.length = 0;
      const before = JSON.stringify(refusalModel);
      await expectRefusal(
        () =>
          cleanup(ports, refusalModel, {
            transactionId,
            ledgerRevision,
            expectedLedgerRevision: ledgerRevision,
          }),
        kind,
      );
      expect(calls, `${kind} must not delete`).not.toContain(`removeTree:${backupPath}`);
      expect(JSON.stringify(refusalModel), `${kind} model bytes`).toBe(before);
    }

    await chmod(transactionDir, 0o755);
    calls.length = 0;
    await expectRefusal(
      () =>
        cleanup(ports, tombstoneModel, {
          transactionId,
          ledgerRevision,
          expectedLedgerRevision: ledgerRevision,
        }),
      'owner-mode-mismatch',
    );
    expect(calls).not.toContain(`removeTree:${backupPath}`);
    await chmod(transactionDir, 0o700);

    const sharedPath = join(root, 'shared-backup');
    await link(backupPath, sharedPath);
    calls.length = 0;
    await expectRefusal(
      () =>
        cleanup(ports, tombstoneModel, {
          transactionId,
          ledgerRevision,
          expectedLedgerRevision: ledgerRevision,
        }),
      'shared-backup',
    );
    expect(calls).not.toContain(`removeTree:${backupPath}`);
    await rm(sharedPath);

    await rm(backupPath);
    const recomputed = await unwrapModel(
      select(tombstoneModel, { ledgerRevision }),
      'recompute same missing-backup victim at unchanged ledger revision',
    );
    expect(recomputed.history.map((item) => item.transactionId)).toContain(transactionId);
    expect((recomputed as unknown as UnknownRecord).cleanupVictim).toMatchObject({
      transactionId,
      status: 'pending',
    });
    calls.length = 0;
    const missing = await unwrapModel(
      cleanup(ports, recomputed, {
        transactionId,
        ledgerRevision,
        expectedLedgerRevision: ledgerRevision,
      }),
      'accept already-missing backup only from the unchanged live tombstone',
    );
    expect(missing.history).toHaveLength(256);

    await writeFile(backupPath, bytes);
    calls.length = 0;
    const tombstoneBeforeCleanup = structuredClone(tombstoneModel);
    const cleaned = await unwrapModel(
      cleanup(ports, tombstoneModel, {
        transactionId,
        ledgerRevision,
        expectedLedgerRevision: ledgerRevision,
      }),
      'durable one-victim cleanup',
    );
    expect(tombstoneModel).toEqual(tombstoneBeforeCleanup);
    expect(existsSync(backupPath)).toBeFalse();
    expect(existsSync(join(storePath, 'SKILL.md'))).toBeTrue();
    expect(calls).toContain(`removeTree:${backupPath}`);
    expect(calls).toContain(`fsyncDir:${transactionDir}`);
    expect(cleaned.history).toHaveLength(256);

    await expectRefusal(
      () => advance(tombstoneModel, journal(900, 'prepared', { skill: 'new-work' })),
      'new mutation while cleanup tombstone is unresolved',
    );
  });

  test('two local processes serialize real v2 writes with one absolute child deadline each', async () => {
    const cases = fixture();
    const scenario = cases.concurrencyCase;
    const root = await mkdtemp(join(tmpdir(), 'p3b-ts04-workers-'));
    roots.push(root);
    await writeFile(join(root, scenario.marker), `${scenario.guard}\n`);
    await writeFile(join(root, scenario.target), canonicalLedgerSource());
    const results = await Promise.all(
      scenario.workers.map((item) =>
        runWorker({
          ...item,
          caseId: scenario.id,
          mode: 'write-model',
          root,
          marker: scenario.marker,
          guard: scenario.guard,
          target: scenario.target,
          homeDir: null,
          dataDir: null,
          cwd: null,
          injection: null,
        }),
      ),
    );
    expect(results.map(({ result }) => result.outcome)).toEqual(['committed', 'committed']);
    const value = JSON.parse(await readFile(join(root, scenario.target), 'utf8')) as UnknownRecord;
    expect(value.schemaVersion).toBe(2);
    for (const item of scenario.workers)
      expect(value.skills as UnknownRecord).toHaveProperty(item.skill);
  });

  test('proves deterministic real-lock contention before releasing the exact holder barrier', async () => {
    const cases = fixture();
    const scenario = cases.concurrencyCase;
    const root = await mkdtemp(join(tmpdir(), 'p3b-ts04-contention-'));
    roots.push(root);
    await writeFile(join(root, scenario.marker), `${scenario.guard}\n`);
    await writeFile(join(root, scenario.target), canonicalLedgerSource());
    const base = {
      mode: 'lock-contention' as const,
      root,
      marker: scenario.marker,
      guard: scenario.guard,
      target: scenario.target,
      homeDir: null,
      dataDir: null,
      cwd: null,
      injection: null,
    };
    let releaseHolder: (() => void) | undefined;
    let holderLockedResolve: (() => void) | undefined;
    const holderLocked = new Promise<void>((resolveLocked) => {
      holderLockedResolve = resolveLocked;
    });
    const holderPromise = runWorker(
      {
        ...base,
        caseId: 'deterministic-contention',
        operationId: 'operation-holder',
        transactionId: 'transaction-holder',
        workerId: 'worker-holder',
        role: 'lock-holder',
        skill: 'holder-skill',
        tool: 'fixture-holder',
        holdAtLock: true,
      },
      {
        onBarrier(record, release) {
          if (record.barrier === 'lock-acquired') {
            releaseHolder = release;
            holderLockedResolve?.();
          }
        },
      },
    );
    const localDeadline = Date.now() + 10_000;
    await until(holderLocked, localDeadline, 'holder lock barrier');

    let contenderAcquired = false;
    let contenderAttemptResolve: (() => void) | undefined;
    const contenderAttempt = new Promise<void>((resolveAttempt) => {
      contenderAttemptResolve = resolveAttempt;
    });
    const contenderPromise = runWorker(
      {
        ...base,
        caseId: 'deterministic-contention',
        operationId: 'operation-contender',
        transactionId: 'transaction-contender',
        workerId: 'worker-contender',
        role: 'lock-contender',
        skill: 'contender-skill',
        tool: 'fixture-contender',
      },
      {
        onBarrier(record) {
          if (record.barrier === 'attempting-lock') contenderAttemptResolve?.();
          if (record.barrier === 'lock-acquired') contenderAcquired = true;
        },
      },
    );
    await until(contenderAttempt, localDeadline, 'contender attempt barrier');
    expect(contenderAcquired).toBeFalse();
    expect(releaseHolder).toBeDefined();
    releaseHolder?.();
    const [holder, contender] = await until(
      Promise.all([holderPromise, contenderPromise]),
      localDeadline,
      'contention completion',
    );
    expect(holder.result.outcome).toBe('committed');
    expect(contender.result.outcome).toBe('committed');
    expect(contender.messages.some((item) => item.barrier === 'lock-acquired')).toBeTrue();
  });

  test('selects the exact migration recovery cursor and byte authority or refuses without mutation', async () => {
    const cases = fixture();
    const oldBytes = cases.migrationCase.source;
    const ledgerV1Codec = artifactContractRegistry.get('ledger', 1);
    const ledgerV2Codec = artifactContractRegistry.get('ledger', 2);
    const journalCodec = artifactContractRegistry.get('journal', 1);
    expect(ledgerV1Codec).toBeDefined();
    expect(ledgerV2Codec).toBeDefined();
    expect(journalCodec).toBeDefined();
    const oldByteView = new TextEncoder().encode(oldBytes);
    const decodedSource = ledgerV1Codec?.decode(oldByteView);
    expect(decodedSource?.ok).toBeTrue();
    if (decodedSource?.ok !== true) return;
    const migratedBase = decodedSource.value.model as LedgerModel;
    const sourceSemanticRevision = ledgerSemanticRevision(migratedBase);
    expect(sourceSemanticRevision.ok).toBeTrue();
    if (!sourceSemanticRevision.ok) return;
    const sourceByteRevision = ledgerByteRevision(oldByteView);
    const targetEncoded = ledgerV2Codec?.encode(migratedBase);
    expect(targetEncoded?.ok).toBeTrue();
    const targetSemanticRevision = ledgerSemanticRevision(migratedBase);
    expect(targetSemanticRevision.ok).toBeTrue();
    if (targetEncoded?.ok !== true || !targetSemanticRevision.ok) return;
    const targetByteRevision = ledgerByteRevision(targetEncoded.value);

    const migrationStartedAt = '2026-07-15T00:00:00.000Z';
    const migrationSeedBase = artifactJournal(980, 'ledger');
    const migrationSeed: LogicalJournalV1Dto = {
      ...migrationSeedBase,
      transactionId: 'transaction-recovery-matrix',
      intent: {
        ...migrationSeedBase.intent,
        operationId: 'operation-recovery-matrix',
        groupId: 'group-ledger-migration-recovery',
        pairId: null,
        before: {
          kind: 'ledger',
          projectRoot: null,
          schemaVersion: 1,
          byteHash: sourceByteRevision,
          semanticHash: sourceSemanticRevision.value,
        },
        after: {
          kind: 'ledger',
          projectRoot: null,
          schemaVersion: 2,
          byteHash: targetByteRevision,
          semanticHash: targetSemanticRevision.value,
        },
      },
      context: {
        ...migrationSeedBase.context,
        parentOperationId: null,
        attempt: 1,
        startedAt: migrationStartedAt,
      },
      actual: {
        before: [
          {
            resourceId: 'ledger:placements',
            role: 'ledger',
            state: 'present',
            repositoryRevision: { kind: 'artifact-bytes', digest: sourceByteRevision },
            schemaVersion: 1,
            semanticHash: sourceSemanticRevision.value,
          },
        ],
        after: [
          {
            resourceId: 'ledger:placements',
            role: 'ledger',
            state: 'present',
            repositoryRevision: { kind: 'artifact-bytes', digest: targetByteRevision },
            schemaVersion: 2,
            semanticHash: targetSemanticRevision.value,
          },
        ],
        retained: [],
      },
      updatedAt: migrationStartedAt,
      completedAt: migrationStartedAt,
    };
    expect(migrationSeed.intent.kind).toBe('migrate-ledger');
    expect(migrationSeed.intent.pairId).toBeNull();
    expect(migrationSeed.intent).toMatchObject({
      before: {
        kind: 'ledger',
        schemaVersion: 1,
        byteHash: sourceByteRevision,
        semanticHash: sourceSemanticRevision.value,
      },
      after: {
        kind: 'ledger',
        schemaVersion: 2,
        byteHash: targetByteRevision,
        semanticHash: targetSemanticRevision.value,
      },
    });
    expect(migrationSeed.actual).toEqual({
      before: [
        {
          resourceId: 'ledger:placements',
          role: 'ledger',
          state: 'present',
          repositoryRevision: { kind: 'artifact-bytes', digest: sourceByteRevision },
          schemaVersion: 1,
          semanticHash: sourceSemanticRevision.value,
        },
      ],
      after: [
        {
          resourceId: 'ledger:placements',
          role: 'ledger',
          state: 'present',
          repositoryRevision: { kind: 'artifact-bytes', digest: targetByteRevision },
          schemaVersion: 2,
          semanticHash: targetSemanticRevision.value,
        },
      ],
      retained: [],
    });
    expect(journalCodec?.validate(migrationSeed).ok).toBeTrue();
    const migrationJournalFor = (
      phase: 'staged' | 'backed-up' | 'live' | 'committed',
    ): LogicalJournalV1Dto => ({
      ...migrationSeed,
      phase,
      actual: {
        ...migrationSeed.actual,
        after: phase === 'live' || phase === 'committed' ? migrationSeed.actual.after : [],
      },
      completedAt: phase === 'committed' ? migrationStartedAt : null,
    });
    const recoveryPhaseStates = [
      ['staged-v2', 'staged'],
      ['backed-up-v2', 'backed-up'],
      ['live-v2', 'live'],
      ['committed-v2', 'committed'],
    ] as const;
    type RecoveryImage = Readonly<{
      bytes: string;
      byteRevision: string;
      semanticRevision: string;
      phase: string | null;
    }>;
    const recoveryImages: Record<string, RecoveryImage> = {
      'v1-source': {
        bytes: oldBytes,
        byteRevision: sourceByteRevision,
        semanticRevision: sourceSemanticRevision.value,
        phase: null,
      },
    };
    const migrationJournals: LogicalJournalV1Dto[] = [];
    for (const [state, phase] of recoveryPhaseStates) {
      const logical = migrationJournalFor(phase);
      migrationJournals.push(logical);
      expect(journalCodec?.validate(logical).ok, `${state} journal codec`).toBeTrue();
      expect(logical).toMatchObject({
        transactionId: 'transaction-recovery-matrix',
        intent: {
          operationId: 'operation-recovery-matrix',
          kind: 'migrate-ledger',
          pairId: null,
        },
        context: { startedAt: migrationStartedAt },
        phase,
      });
      expect(logical.intent.before).toEqual(migrationSeed.intent.before);
      expect(logical.intent.after).toEqual(migrationSeed.intent.after);
      expect(logical.actual.before).toEqual(migrationSeed.actual.before);
      expect(logical.actual.after).toEqual(
        phase === 'live' || phase === 'committed' ? migrationSeed.actual.after : [],
      );
      const model: LedgerModel = {
        ...migratedBase,
        transactions: phase === 'committed' ? {} : { [logical.transactionId]: logical },
        history: phase === 'committed' ? [logical] : [],
      };
      expect(ledgerV2Codec?.validate(ledgerDto(model)).ok, `${state} ledger cross-validation`).toBe(
        true,
      );
      const encoded = ledgerV2Codec?.encode(model);
      expect(encoded?.ok, `${state} canonical encode`).toBeTrue();
      const semanticRevision = ledgerSemanticRevision(model);
      expect(semanticRevision.ok, `${state} semantic revision`).toBeTrue();
      if (encoded?.ok !== true || !semanticRevision.ok) return;
      recoveryImages[state] = {
        bytes: new TextDecoder().decode(encoded.value),
        byteRevision: ledgerByteRevision(encoded.value),
        semanticRevision: semanticRevision.value,
        phase,
      };
    }
    expect(new Set(migrationJournals.map(({ transactionId }) => transactionId))).toEqual(
      new Set(['transaction-recovery-matrix']),
    );
    expect(new Set(migrationJournals.map(({ intent }) => intent.operationId))).toEqual(
      new Set(['operation-recovery-matrix']),
    );
    expect(new Set(migrationJournals.map(({ context }) => context.startedAt))).toEqual(
      new Set([migrationStartedAt]),
    );
    expect(new Set(Object.values(recoveryImages).map(({ bytes }) => bytes)).size).toBe(5);
    expect(
      new Set(Object.values(recoveryImages).map(({ byteRevision }) => byteRevision)).size,
    ).toBe(5);
    expect(
      new Set(Object.values(recoveryImages).map(({ semanticRevision }) => semanticRevision)).size,
    ).toBe(5);
    const imageFor = (state: string): RecoveryImage | null => {
      if (state === 'absent') return null;
      const image = recoveryImages[state];
      if (image === undefined) throw new Error(`unknown recovery image ${state}`);
      return image;
    };
    const observedFile = (state: string, role: 'live' | 'stage' | 'backup'): UnknownRecord => {
      const image = imageFor(state);
      return {
        state,
        kind: image === null ? null : 'regular',
        linkCount: image === null ? 0 : 1,
        basename:
          image === null
            ? null
            : role === 'live'
              ? 'placements.json'
              : role === 'stage'
                ? 'ledger.stage'
                : 'ledger.v1.backup',
        identity: image === null ? null : `identity:${role}:${state}`,
        byteRevision: image?.byteRevision ?? null,
        semanticRevision: image?.semanticRevision ?? null,
        phase: image?.phase ?? null,
        bytes: image?.bytes ?? null,
      };
    };
    const inputFor = (
      candidate: FixtureCases['recoveryCursorCases'][number],
      mutate: (() => void)[],
    ): UnknownRecord => {
      const transactionDirectoryBasename = `v1-${createHash('sha256')
        .update('transaction-recovery-matrix')
        .digest('hex')}`;
      const directoryPresent = candidate.permittedResidue.includes('transaction-directory');
      const live = observedFile(candidate.live, 'live');
      const stage = observedFile(candidate.stage, 'stage');
      const backup = observedFile(candidate.backup, 'backup');
      const expectedImages = Object.fromEntries(
        Object.entries(recoveryImages)
          .filter(([state]) => state !== 'v1-source')
          .map(([state, image]) => [
            state,
            {
              byteRevision: image.byteRevision,
              semanticRevision: image.semanticRevision,
              bytes: image.bytes,
            },
          ]),
      );
      return {
        operationId: 'operation-recovery-matrix',
        transactionId: 'transaction-recovery-matrix',
        ownerToken: 'owner-recovery-matrix',
        targetPath: '/fixture/placements.json',
        sourceRevision: recoveryImages['v1-source']?.semanticRevision,
        pointer: {
          state: 'present',
          kind: 'regular',
          linkCount: 1,
          byteRevision: digestC,
          ownerToken: 'owner-recovery-matrix',
          targetPath: '/fixture/placements.json',
          cursor: candidate.cursor,
          sourceByteRevision: recoveryImages['v1-source']?.byteRevision,
          sourceSemanticRevision: recoveryImages['v1-source']?.semanticRevision,
          targetByteRevision,
          targetSemanticRevision: targetSemanticRevision.value,
          journalSeed: migrationSeed,
          expectedImages,
          transactionDirectoryBasename,
          transactionDirectoryIdentity: directoryPresent ? 'identity:transaction-directory' : null,
          stageBasename: 'ledger.stage',
          stageFileIdentity: stage.identity,
          backupBasename: 'ledger.v1.backup',
          backupFileIdentity: backup.identity,
          liveByteRevision: live.byteRevision,
          liveSemanticRevision: live.semanticRevision,
        },
        actualPointerRevision: digestC,
        privateDirectory: {
          state: directoryPresent ? 'present' : 'absent',
          kind: directoryPresent ? 'directory' : null,
          basename: transactionDirectoryBasename,
          identity: directoryPresent ? 'identity:transaction-directory' : null,
          ownerToken: directoryPresent ? 'owner-recovery-matrix' : null,
          mode: directoryPresent ? 0o700 : null,
        },
        live,
        stage,
        backup,
        residue: candidate.permittedResidue.map((role) => ({
          role,
          basename:
            role === 'transaction-directory'
              ? transactionDirectoryBasename
              : role === 'stage'
                ? stage.basename
                : backup.basename,
          identity:
            role === 'transaction-directory'
              ? 'identity:transaction-directory'
              : role === 'stage'
                ? stage.identity
                : backup.identity,
        })),
        mutations: {
          write: () => mutate.push(() => undefined),
          rename: () => mutate.push(() => undefined),
          remove: () => mutate.push(() => undefined),
          fsync: () => mutate.push(() => undefined),
        },
      };
    };

    for (const candidate of cases.recoveryCursorCases) {
      const input = inputFor(candidate, []);
      const pointer = input.pointer as UnknownRecord;
      expect(pointer).toMatchObject({
        sourceByteRevision,
        sourceSemanticRevision: sourceSemanticRevision.value,
        targetByteRevision,
        targetSemanticRevision: targetSemanticRevision.value,
        journalSeed: migrationSeed,
      });
      expect(pointer.journalSeed).toEqual(migrationSeed);
      const expectedImages = pointer.expectedImages as UnknownRecord;
      for (const [state, image] of Object.entries(recoveryImages)) {
        if (state === 'v1-source') continue;
        expect(expectedImages[state], `${candidate.id}:${state} expected image`).toEqual({
          byteRevision: image.byteRevision,
          semanticRevision: image.semanticRevision,
          bytes: image.bytes,
        });
      }
    }
    const recover = requiredFunction(core, 'recoverLedgerMigrationState');
    for (const candidate of cases.recoveryCursorCases) {
      const mutations: (() => void)[] = [];
      const input = inputFor(candidate, mutations);
      expect(
        (input.residue as readonly UnknownRecord[]).map(({ role }) => role),
        `${candidate.id} cursor-permitted residue subset`,
      ).toEqual(candidate.permittedResidue);
      const recovered = await unwrap(
        recover(input, { decideOnly: true }),
        `recovery cursor ${candidate.id}`,
      );
      const authority = candidate.live === 'v1-source' ? 'old-v1' : 'new-v2';
      const authoritativeImage = imageFor(candidate.live);
      expect(authoritativeImage).not.toBeNull();
      expect(recovered, candidate.id).toEqual({
        action: candidate.expected,
        authority,
        authoritativeByteRevision: authoritativeImage?.byteRevision,
        authoritativeSemanticRevision: authoritativeImage?.semanticRevision,
        authoritativeBytes: authoritativeImage?.bytes,
      });
      expect(mutations, `${candidate.id} decide-only mutation`).toEqual([]);
    }

    const refusalBase = cases.recoveryCursorCases.find((item) => item.id === 'R06');
    expect(refusalBase).toBeDefined();
    if (refusalBase === undefined) return;
    for (const candidate of cases.recoveryRefusalCases) {
      const mutations: (() => void)[] = [];
      const input = inputFor(refusalBase, mutations);
      const pointer = input.pointer as UnknownRecord;
      const live = input.live as UnknownRecord;
      const stage = input.stage as UnknownRecord;
      const backup = input.backup as UnknownRecord;
      const privateDirectory = input.privateDirectory as UnknownRecord;
      switch (candidate.kind) {
        case 'malformed-pointer':
          input.pointer = { state: 'present', raw: '{' };
          break;
        case 'unrelated-pointer':
          pointer.targetPath = '/fixture/unrelated.json';
          break;
        case 'owner-mismatch':
          pointer.ownerToken = 'foreign-owner';
          break;
        case 'pointer-symlink':
          pointer.kind = 'symlink';
          break;
        case 'shared-pointer':
          pointer.linkCount = 2;
          break;
        case 'stale-source-revision':
          input.sourceRevision = digestD;
          break;
        case 'pointer-revision-mismatch':
          input.actualPointerRevision = digestD;
          break;
        case 'stage-revision-mismatch':
          stage.byteRevision = digestD;
          break;
        case 'backup-revision-mismatch':
          backup.byteRevision = digestD;
          break;
        case 'live-revision-mismatch':
          live.byteRevision = digestD;
          break;
        case 'stage-semantic-revision-mismatch': {
          const byteRevision = stage.byteRevision;
          stage.semanticRevision = digestD;
          expect(stage.byteRevision).toBe(byteRevision);
          break;
        }
        case 'backup-semantic-revision-mismatch': {
          const byteRevision = backup.byteRevision;
          backup.semanticRevision = digestD;
          expect(backup.byteRevision).toBe(byteRevision);
          break;
        }
        case 'live-semantic-revision-mismatch': {
          const byteRevision = live.byteRevision;
          live.semanticRevision = digestD;
          expect(live.byteRevision).toBe(byteRevision);
          break;
        }
        case 'stage-symlink':
          stage.kind = 'symlink';
          break;
        case 'backup-shared':
          backup.linkCount = 2;
          break;
        case 'unrecognized-residue':
          input.residue = [
            ...(input.residue as readonly unknown[]),
            {
              role: 'unrecognized',
              basename: '.skillsmith-unowned-residue',
              identity: 'identity:unowned-residue',
            },
          ];
          break;
        case 'swapped-phase-image': {
          const swapped = observedFile('staged-v2', 'stage');
          swapped.identity = stage.identity;
          input.stage = swapped;
          break;
        }
        case 'transaction-directory-basename-mismatch':
          pointer.transactionDirectoryBasename = '../foreign-transaction-directory';
          break;
        case 'transaction-directory-identity-mismatch':
          privateDirectory.identity = 'identity:foreign-transaction-directory';
          break;
        case 'private-directory-owner-mismatch':
          privateDirectory.ownerToken = 'foreign-owner';
          break;
        case 'private-directory-mode-mismatch':
          privateDirectory.mode = 0o755;
          break;
        case 'stage-basename-mismatch':
          pointer.stageBasename = '../foreign.stage';
          break;
        case 'backup-basename-mismatch':
          pointer.backupBasename = '../foreign.backup';
          break;
        case 'stage-file-identity-mismatch':
          stage.identity = 'identity:foreign-stage';
          break;
        case 'backup-file-identity-mismatch':
          backup.identity = 'identity:foreign-backup';
          break;
        default:
          throw new Error(`unhandled recovery refusal ${candidate.kind}`);
      }
      const before = JSON.stringify({
        pointer: input.pointer,
        privateDirectory: input.privateDirectory,
        live: input.live,
        stage: input.stage,
        backup: input.backup,
        residue: input.residue,
      });
      await expectRefusal(
        () => recover(input),
        `recovery refusal ${candidate.id}:${candidate.kind}`,
      );
      expect(mutations, `${candidate.id} mutation calls`).toEqual([]);
      expect(
        JSON.stringify({
          pointer: input.pointer,
          privateDirectory: input.privateDirectory,
          live: input.live,
          stage: input.stage,
          backup: input.backup,
          residue: input.residue,
        }),
        `${candidate.id} observations remain byte-identical`,
      ).toBe(before);
    }
  });

  test('recovers every closed pointer/stage/fsync/backup/replace/commit/cleanup interruption', async () => {
    const cases = fixture();
    let migrationSourceRevision = '';
    const cleanFleet = await buildFixtureFleet();
    try {
      await writeFile(
        join(cleanFleet.base, cases.concurrencyCase.marker),
        `${cases.concurrencyCase.guard}\n`,
      );
      await writeFile(ledgerPathOf(cleanFleet.data), cases.migrationCase.source);
      const source = await readLedgerArtifact(cleanFleet.env, ledgerPathOf(cleanFleet.data));
      expect(source.ok).toBeTrue();
      if (!source.ok || source.value.state !== 'present') return;
      migrationSourceRevision = source.value.semanticRevision;
      const clean = await runWorker({
        caseId: 'clean-migration',
        operationId: 'operation-clean',
        transactionId: 'transaction-clean',
        workerId: 'worker-clean',
        role: 'migration-writer',
        mode: 'migrate-v1',
        root: cleanFleet.base,
        marker: cases.concurrencyCase.marker,
        guard: cases.concurrencyCase.guard,
        target: cases.concurrencyCase.target,
        skill: 'alpha',
        tool: 'claude-code',
        homeDir: cleanFleet.home,
        dataDir: cleanFleet.data,
        cwd: cleanFleet.home,
        injection: null,
        expectedJournalPhase: 'committed',
        sourceRevision: migrationSourceRevision,
      });
      expect(clean.result).toMatchObject({
        outcome: 'committed',
        finalSchemaVersion: 2,
        pendingCount: 0,
        requestedMutationPresent: true,
        journalPhase: 'committed',
        sourceRevisionPreserved: true,
      });
      const observed = clean.result.observedBarriers as string[];
      for (const crash of cases.crashCases.filter((item) => item.mode === 'migrate-v1')) {
        expect(observed, `clean run omitted ${crash.id}:${crash.barrier}`).toContain(crash.barrier);
      }
    } finally {
      await destroyFixtureFleet(cleanFleet);
    }

    for (const crash of cases.crashCases) {
      if (crash.mode === 'migrate-v1') {
        const fleet = await buildFixtureFleet();
        try {
          await writeFile(
            join(fleet.base, cases.concurrencyCase.marker),
            `${cases.concurrencyCase.guard}\n`,
          );
          await writeFile(ledgerPathOf(fleet.data), cases.migrationCase.source);
          const interrupted = await runWorker({
            caseId: crash.id,
            operationId: `operation-${crash.id}`,
            transactionId: `transaction-${crash.id}`,
            workerId: `worker-${crash.id}`,
            role: 'migration-writer',
            mode: crash.mode,
            root: fleet.base,
            marker: cases.concurrencyCase.marker,
            guard: cases.concurrencyCase.guard,
            target: cases.concurrencyCase.target,
            skill: 'alpha',
            tool: 'claude-code',
            homeDir: fleet.home,
            dataDir: fleet.data,
            cwd: fleet.home,
            injection: { barrier: crash.barrier, occurrence: 1 },
            expectedJournalPhase: null,
            sourceRevision: migrationSourceRevision,
          });
          expect(interrupted.result.outcome, crash.id).toBe('interrupted');
          expect(interrupted.result.observedBarriers as string[]).toContain(crash.barrier);
          const postCommit = [
            'migration-commit-write',
            'migration-commit-fsync',
            'migration-backup-cleanup',
            'migration-stage-cleanup',
            'migration-directory-cleanup',
            'migration-pointer-cleanup',
          ].includes(crash.barrier);
          if (postCommit) {
            expect(interrupted.result).toMatchObject({
              pendingCount: 0,
              journalPhase: 'committed',
              historyTransactionIds: [`transaction-${crash.id}`],
              historyAttempts: [1],
            });
          } else {
            expect(interrupted.result.historyTransactionIds).toEqual([]);
          }
          const committedHistoryBeforeRecovery = postCommit
            ? (
                (JSON.parse(await readFile(ledgerPathOf(fleet.data), 'utf8')) as UnknownRecord)
                  .history as UnknownRecord[]
              ).find((item) => item.transactionId === `transaction-${crash.id}`)
            : null;
          const recovery = await runWorker({
            caseId: `${crash.id}-recovery`,
            operationId: `operation-${crash.id}`,
            transactionId: `transaction-${crash.id}`,
            workerId: `recovery-${crash.id}`,
            role: 'recovery-writer',
            mode: crash.mode,
            root: fleet.base,
            marker: cases.concurrencyCase.marker,
            guard: cases.concurrencyCase.guard,
            target: cases.concurrencyCase.target,
            skill: 'alpha',
            tool: 'claude-code',
            homeDir: fleet.home,
            dataDir: fleet.data,
            cwd: fleet.home,
            injection: null,
            expectedJournalPhase: 'committed',
            sourceRevision: migrationSourceRevision,
          });
          expect(recovery.result).toMatchObject({
            outcome: 'committed',
            finalSchemaVersion: 2,
            pendingCount: 0,
            requestedMutationPresent: true,
            journalPhase: 'committed',
            historyTransactionIds: [`transaction-${crash.id}`],
            historyAttempts: [postCommit ? 1 : 2],
            historyStartedAts: ['2026-07-15T00:00:00.000Z'],
            sourceRevisionPreserved: true,
          });
          const recoveryRoot = join(fleet.data, 'recovery', 'ledger');
          const pointerPath = join(
            recoveryRoot,
            `${ledgerRecoveryKey(ledgerPathOf(fleet.data))}.json`,
          );
          expect(existsSync(pointerPath), `${crash.id} recovery pointer residue`).toBeFalse();
          expect(
            await readdir(join(recoveryRoot, 'transactions')),
            `${crash.id} recovery transaction residue`,
          ).toEqual([]);
          if (committedHistoryBeforeRecovery !== null) {
            const recoveredValue = JSON.parse(
              await readFile(ledgerPathOf(fleet.data), 'utf8'),
            ) as UnknownRecord;
            const recoveredHistory = (recoveredValue.history as UnknownRecord[]).find(
              (item) => item.transactionId === `transaction-${crash.id}`,
            );
            expect(
              JSON.stringify(recoveredHistory),
              `${crash.id} cleanup recovery must not rewrite exact committed history`,
            ).toBe(JSON.stringify(committedHistoryBeforeRecovery));
          }
          const value = JSON.parse(
            await readFile(ledgerPathOf(fleet.data), 'utf8'),
          ) as UnknownRecord;
          const ids = (value.history as UnknownRecord[]).map((item) => item.transactionId);
          expect(new Set(ids).size).toBe(ids.length);
        } finally {
          await destroyFixtureFleet(fleet);
        }
      } else {
        const root = await mkdtemp(join(tmpdir(), `p3b-ts04-${crash.id}-`));
        roots.push(root);
        await writeFile(
          join(root, cases.concurrencyCase.marker),
          `${cases.concurrencyCase.guard}\n`,
        );
        await writeFile(join(root, cases.concurrencyCase.target), canonicalLedgerSource());
        const base: Omit<WorkerSpec, 'role' | 'workerId' | 'injection'> = {
          caseId: crash.id,
          operationId: `operation-${crash.id}`,
          transactionId: `transaction-${crash.id}`,
          mode: crash.mode,
          root,
          marker: cases.concurrencyCase.marker,
          guard: cases.concurrencyCase.guard,
          target: cases.concurrencyCase.target,
          skill: `skill-${crash.id}`,
          tool: 'fixture-tool',
          homeDir: null,
          dataDir: null,
          cwd: null,
        };
        const interrupted = await runWorker({
          ...base,
          workerId: `worker-${crash.id}`,
          role: 'migration-writer',
          injection: { barrier: crash.barrier, occurrence: 1 },
        });
        expect(interrupted.result.outcome, crash.id).toBe('interrupted');
        const recovery = await runWorker({
          ...base,
          caseId: `${crash.id}-recovery`,
          workerId: `recovery-${crash.id}`,
          role: 'recovery-writer',
          injection: null,
        });
        expect(recovery.result).toMatchObject({ outcome: 'committed', finalSchemaVersion: 2 });
        expect(recovery.result.requestedMutationPresent).toBeTrue();
      }
    }
  }, 180_000);

  test('saved v1 migration stales on exact source revision change without touching changed bytes', async () => {
    const fleet = await buildFixtureFleet();
    try {
      const path = ledgerPathOf(fleet.data);
      await writeFile(path, fixture().migrationCase.source);
      const prepared = await preparePromote(fleet.env, optionsFor(fleet), dependencies);
      expect(prepared.ok).toBeTrue();
      if (!prepared.ok) return;
      await writeFile(path, fixture().migrationCase.source.replace('00:00:00', '00:00:01'));
      const changed = await readFile(path);
      expect((await prepared.value.execute()).ok).toBeFalse();
      expect(await readFile(path)).toEqual(changed);
    } finally {
      await destroyFixtureFleet(fleet);
    }
  });
});
