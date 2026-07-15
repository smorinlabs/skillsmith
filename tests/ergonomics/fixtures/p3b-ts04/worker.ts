import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveRuntimeConfiguration } from '../../../../packages/core/src/config/runtime.ts';
import { defaultRuntimePorts } from '../../../../packages/core/src/index.ts';
import {
  readLedgerState,
  setPairAt,
  withLedgerLock,
  writeLedger,
} from '../../../../packages/core/src/place/ledger.ts';
import { runPromote } from '../../../../packages/core/src/place/run.ts';
import type { FlipTool } from '../../../../packages/core/src/place/types.ts';
import type { RuntimePorts } from '../../../../packages/core/src/ports/types.ts';

type PlainData =
  | null
  | boolean
  | number
  | string
  | readonly PlainData[]
  | { readonly [key: string]: PlainData };

const PROTOCOL_VERSION = 1;
const TIMEOUT_MS = 30_000;
const MAX_MESSAGE_BYTES = 4_096;
const MAX_REASON_LENGTH = 512;
const MAX_BARRIERS = 64;
const ACCEPTS = Object.freeze(['start', 'release']);
const EMITS = Object.freeze(['fixture-ready', 'barrier', 'result', 'fixture-error']);
const ROLES = Object.freeze([
  'first-writer',
  'second-writer',
  'migration-writer',
  'recovery-writer',
  'lock-holder',
  'lock-contender',
]);
const MODES = Object.freeze(['write-model', 'migrate-v1', 'lock-contention']);
const OUTCOMES = Object.freeze(['committed', 'interrupted', 'missing-behavior', 'refused']);
const JOURNAL_PHASES = Object.freeze(['prepared', 'staged', 'backed-up', 'live', 'committed']);
const BARRIERS = Object.freeze([
  'attempting-lock',
  'lock-acquired',
  'make-dir',
  'write-text-file',
  'copy-file',
  'fsync-file',
  'rename',
  'fsync-dir',
  'remove-file',
  'remove-tree',
  'recovery-pointer-prepared-write',
  'recovery-pointer-prepared-fsync',
  'migration-stage-write',
  'migration-stage-fsync',
  'migration-backup-copy',
  'migration-backup-fsync',
  'migration-backed-up-replace',
  'migration-backed-up-fsync',
  'migration-live-replace',
  'migration-live-parent-fsync',
  'migration-handoff-write',
  'migration-handoff-fsync',
  'migration-commit-write',
  'migration-commit-fsync',
  'migration-backup-cleanup',
  'migration-stage-cleanup',
  'migration-directory-cleanup',
  'migration-pointer-cleanup',
  'writer-stage-write',
  'writer-stage-fsync',
  'writer-live-replace',
  'writer-live-parent-fsync',
]);
const SELF_CHECK = Object.freeze({
  kind: 'p3b-ts04-worker-self-check',
  protocolVersion: PROTOCOL_VERSION,
  timeoutMs: TIMEOUT_MS,
  maxMessageBytes: MAX_MESSAGE_BYTES,
  maxBarriers: MAX_BARRIERS,
  accepts: ACCEPTS,
  emits: EMITS,
  roles: ROLES,
  modes: MODES,
  outcomes: OUTCOMES,
  journalPhases: JOURNAL_PHASES,
  barriers: BARRIERS,
});

type Role =
  | 'first-writer'
  | 'second-writer'
  | 'migration-writer'
  | 'recovery-writer'
  | 'lock-holder'
  | 'lock-contender';
type Mode = 'write-model' | 'migrate-v1' | 'lock-contention';
type Barrier = (typeof BARRIERS)[number];
type JournalPhase = (typeof JOURNAL_PHASES)[number];

interface StartMessage {
  readonly kind: 'start';
  readonly protocolVersion: 1;
  readonly caseId: string;
  readonly operationId: string;
  readonly transactionId: string;
  readonly workerId: string;
  readonly barrierId: null;
  readonly role: Role;
  readonly mode: Mode;
  readonly root: string;
  readonly marker: string;
  readonly guard: string;
  readonly target: string;
  readonly skill: string;
  readonly tool: string;
  readonly homeDir: string | null;
  readonly dataDir: string | null;
  readonly cwd: string | null;
  readonly injection: null | Readonly<{ barrier: Barrier; occurrence: number }>;
  readonly holdAtLock: boolean;
  readonly expectedJournalPhase: JournalPhase | null;
  readonly sourceRevision: string | null;
}

class InjectedInterruption extends Error {
  readonly code = 'cancelled';

  constructor(readonly barrier: Barrier) {
    super(`deterministic local interruption after ${barrier}`);
    this.name = 'InjectedInterruption';
  }
}

let currentStart: StartMessage | null = null;

const exactRecord = (
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | null => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  return JSON.stringify(Object.keys(record).sort()) === JSON.stringify([...keys].sort())
    ? record
    : null;
};

const boundedString = (value: unknown, maximum = 256): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;

const nullableBoundedPath = (value: unknown): value is string | null =>
  value === null || boundedString(value, 4_096);

const nextMessage = (): Promise<unknown> =>
  new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture IPC timeout')), TIMEOUT_MS);
    process.once('message', (message: unknown) => {
      clearTimeout(timer);
      resolveMessage(message);
    });
  });

const parseStart = (value: unknown): StartMessage => {
  const record = exactRecord(value, [
    'kind',
    'protocolVersion',
    'caseId',
    'operationId',
    'transactionId',
    'workerId',
    'barrierId',
    'role',
    'mode',
    'root',
    'marker',
    'guard',
    'target',
    'skill',
    'tool',
    'homeDir',
    'dataDir',
    'cwd',
    'injection',
    'holdAtLock',
    'expectedJournalPhase',
    'sourceRevision',
  ]);
  const injection =
    record === null || record.injection === null
      ? record?.injection
      : exactRecord(record.injection, ['barrier', 'occurrence']);
  if (
    record?.kind !== 'start' ||
    record.protocolVersion !== PROTOCOL_VERSION ||
    record.barrierId !== null ||
    !boundedString(record.caseId) ||
    !boundedString(record.operationId) ||
    !boundedString(record.transactionId) ||
    !boundedString(record.workerId) ||
    !ROLES.includes(String(record.role)) ||
    !MODES.includes(String(record.mode)) ||
    !boundedString(record.root, 4_096) ||
    !boundedString(record.marker) ||
    !boundedString(record.guard) ||
    record.target !== 'placements.json' ||
    !boundedString(record.skill) ||
    !boundedString(record.tool) ||
    !nullableBoundedPath(record.homeDir) ||
    !nullableBoundedPath(record.dataDir) ||
    !nullableBoundedPath(record.cwd) ||
    typeof record.holdAtLock !== 'boolean' ||
    (record.expectedJournalPhase !== null &&
      !JOURNAL_PHASES.includes(String(record.expectedJournalPhase))) ||
    (record.sourceRevision !== null &&
      (typeof record.sourceRevision !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/u.test(record.sourceRevision))) ||
    (record.mode === 'migrate-v1' &&
      (record.homeDir === null || record.dataDir === null || record.cwd === null)) ||
    (record.holdAtLock && record.role !== 'lock-holder') ||
    (record.injection !== null &&
      (injection === null ||
        !BARRIERS.includes(String(injection.barrier)) ||
        !Number.isSafeInteger(injection.occurrence) ||
        Number(injection.occurrence) < 1 ||
        Number(injection.occurrence) > MAX_BARRIERS))
  ) {
    throw new Error('invalid exact-key fixture start message');
  }
  return record as unknown as StartMessage;
};

const send = (message: PlainData): Promise<void> => {
  if (new TextEncoder().encode(JSON.stringify(message)).byteLength > MAX_MESSAGE_BYTES) {
    return Promise.reject(new Error('fixture IPC message exceeds bounded size'));
  }
  return new Promise((resolveSend, reject) => {
    if (process.send === undefined || !process.connected) {
      reject(new Error('fixture IPC is unavailable'));
      return;
    }
    process.send(message, (error) => (error === null ? resolveSend() : reject(error)));
  });
};

const correlated = (
  start: StartMessage,
  kind: 'fixture-ready' | 'barrier' | 'result' | 'fixture-error',
  barrierId: string | null,
): Record<string, PlainData> => ({
  kind,
  protocolVersion: PROTOCOL_VERSION,
  caseId: start.caseId,
  operationId: start.operationId,
  transactionId: start.transactionId,
  workerId: start.workerId,
  barrierId,
  role: start.role,
});

const guardRoot = (start: StartMessage): void => {
  const inherited = realpathSync(resolve(start.root));
  if (inherited !== realpathSync(process.cwd())) {
    throw new Error('worker root is not the inherited working directory');
  }
  const markerPath = join(inherited, start.marker);
  const metadata = lstatSync(markerPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('worker marker is not a parent-owned regular file');
  }
  if (readFileSync(markerPath, 'utf8') !== `${start.guard}\n`) {
    throw new Error('worker marker guard does not match inherited guard');
  }
};

const requireRelease = (start: StartMessage, barrierId: string, value: unknown): void => {
  const record = exactRecord(value, [
    'kind',
    'protocolVersion',
    'caseId',
    'operationId',
    'transactionId',
    'workerId',
    'barrierId',
    'role',
  ]);
  if (
    record?.kind !== 'release' ||
    record.protocolVersion !== PROTOCOL_VERSION ||
    record.caseId !== start.caseId ||
    record.operationId !== start.operationId ||
    record.transactionId !== start.transactionId ||
    record.workerId !== start.workerId ||
    record.barrierId !== barrierId ||
    record.role !== start.role
  ) {
    throw new Error('invalid exact-key fixture release message');
  }
};

const readFinal = (
  target: string,
  start: StartMessage,
): Readonly<{
  schemaVersion: number | null;
  pendingCount: number;
  historyCount: number;
  requestedMutationPresent: boolean;
  journalPhase: JournalPhase | null;
  historyTransactionIds: readonly string[];
  historyAttempts: readonly number[];
  historyStartedAts: readonly string[];
  sourceRevisionPreserved: boolean;
}> => {
  try {
    const value = JSON.parse(readFileSync(target, 'utf8')) as Readonly<Record<string, unknown>>;
    const skills =
      value.skills !== null && typeof value.skills === 'object'
        ? (value.skills as Readonly<Record<string, unknown>>)
        : {};
    const skill = skills[start.skill] as Readonly<Record<string, unknown>> | undefined;
    const tools =
      skill?.tools !== null && typeof skill?.tools === 'object'
        ? (skill.tools as Readonly<Record<string, unknown>>)
        : {};
    const transactions =
      value.transactions !== null && typeof value.transactions === 'object'
        ? (value.transactions as Readonly<Record<string, unknown>>)
        : {};
    const history = Array.isArray(value.history)
      ? (value.history as readonly Readonly<Record<string, unknown>>[])
      : [];
    const matchingHistory = history.filter((item) => item.transactionId === start.transactionId);
    const pending = transactions[start.transactionId] as
      | Readonly<Record<string, unknown>>
      | undefined;
    const committed = matchingHistory.at(-1);
    const journalPhaseValue = pending?.phase ?? committed?.phase ?? null;
    const sourceRevisionPreserved = matchingHistory.some((item) => {
      if (start.sourceRevision === null) return true;
      const actual = item.actual as Readonly<Record<string, unknown>> | undefined;
      const before = Array.isArray(actual?.before)
        ? (actual.before as readonly Readonly<Record<string, unknown>>[])
        : [];
      return before.some((resource) => {
        const revision = resource.repositoryRevision as
          | Readonly<Record<string, unknown>>
          | undefined;
        return (
          resource.role === 'ledger' &&
          (resource.semanticHash === start.sourceRevision ||
            revision?.digest === start.sourceRevision)
        );
      });
    });
    return {
      schemaVersion: typeof value.schemaVersion === 'number' ? value.schemaVersion : null,
      pendingCount: Object.keys(transactions).length,
      historyCount: history.length,
      requestedMutationPresent: Object.hasOwn(tools, start.tool),
      journalPhase: JOURNAL_PHASES.includes(String(journalPhaseValue))
        ? (journalPhaseValue as JournalPhase)
        : null,
      historyTransactionIds: matchingHistory.map((item) => String(item.transactionId)),
      historyAttempts: matchingHistory.map((item) => {
        const context = item.context as Readonly<Record<string, unknown>> | undefined;
        return typeof context?.attempt === 'number' ? context.attempt : -1;
      }),
      historyStartedAts: matchingHistory.map((item) => {
        const context = item.context as Readonly<Record<string, unknown>> | undefined;
        return typeof context?.startedAt === 'string' ? context.startedAt : '';
      }),
      sourceRevisionPreserved,
    };
  } catch {
    return {
      schemaVersion: null,
      pendingCount: 0,
      historyCount: 0,
      requestedMutationPresent: false,
      journalPhase: null,
      historyTransactionIds: [],
      historyAttempts: [],
      historyStartedAts: [],
      sourceRevisionPreserved: false,
    };
  }
};

const main = async (): Promise<void> => {
  const start = parseStart(await nextMessage());
  currentStart = start;
  guardRoot(start);
  const observed: Barrier[] = [];
  const occurrences = new Map<Barrier, number>();
  let barrierSequence = 0;
  const reportBarrier = async (barrier: Barrier): Promise<string> => {
    if (observed.length >= MAX_BARRIERS) throw new Error('fixture barrier bound exceeded');
    observed.push(barrier);
    const occurrence = (occurrences.get(barrier) ?? 0) + 1;
    occurrences.set(barrier, occurrence);
    barrierSequence += 1;
    const barrierId = `${start.workerId}:${barrierSequence}`;
    await send({
      ...correlated(start, 'barrier', barrierId),
      barrier,
      occurrence,
    });
    if (start.injection?.barrier === barrier && start.injection.occurrence === occurrence) {
      throw new InjectedInterruption(barrier);
    }
    return barrierId;
  };
  await send(correlated(start, 'fixture-ready', null));

  const base = await defaultRuntimePorts();
  const primitivePorts: RuntimePorts = {
    ...base,
    ...(start.homeDir === null ? {} : { homeDir: start.homeDir }),
    makeDir: async (path) => {
      await reportBarrier('make-dir');
      return base.makeDir(path);
    },
    writeTextFile: async (path, source) => {
      await reportBarrier('write-text-file');
      return base.writeTextFile(path, source);
    },
    copyTree: async (from, to) => {
      await reportBarrier('copy-file');
      return base.copyTree(from, to);
    },
    fsyncFile: async (path) => {
      await reportBarrier('fsync-file');
      return base.fsyncFile(path);
    },
    rename: async (from, to) => {
      await reportBarrier('rename');
      return base.rename(from, to);
    },
    fsyncDir: async (path) => {
      await reportBarrier('fsync-dir');
      return base.fsyncDir(path);
    },
    removeTree: async (path) => {
      await reportBarrier('remove-tree');
      return base.removeTree(path);
    },
  };
  const ports = {
    ...primitivePorts,
    ledgerOperationIdentity: {
      operationId: start.operationId,
      transactionId: start.transactionId,
      sourceRevision: start.sourceRevision,
      startedAt: '2026-07-15T00:00:00.000Z',
      attempt: start.role === 'recovery-writer' ? 2 : 1,
    },
    afterLedgerBarrier: async (value: unknown) => {
      const record = exactRecord(value, ['kind']);
      if (record === null || !BARRIERS.includes(String(record.kind))) {
        throw new Error('ledger writer emitted an unknown barrier');
      }
      await reportBarrier(record.kind as Barrier);
    },
  } as RuntimePorts;
  const target =
    start.mode === 'migrate-v1' && start.dataDir !== null
      ? join(start.dataDir, start.target)
      : join(start.root, start.target);
  let outcome: 'committed' | 'interrupted' | 'missing-behavior' | 'refused' = 'missing-behavior';
  try {
    if (start.mode === 'write-model' || start.mode === 'lock-contention') {
      await reportBarrier('attempting-lock');
      const locked = await withLedgerLock(ports, target, async () => {
        const lockBarrierId = await reportBarrier('lock-acquired');
        if (start.holdAtLock) requireRelease(start, lockBarrierId, await nextMessage());
        const read = await readLedgerState(ports, target);
        if (!read.ok || read.value.state !== 'present') return;
        const next = setPairAt(read.value.model, null, start.skill, start.tool, {
          placementPath: join(start.root, 'live', start.skill),
          mode: 'dev',
          dev: {
            sourcePath: `fixture/${start.skill}`,
            resolvedPath: join(start.root, 'source', start.skill),
            repoRoot: null,
            sourceRelPath: null,
            remote: null,
            recordedAt: '2026-07-15T00:00:00.000Z',
          },
          pinned: null,
          journal: null,
        });
        if (!next.ok) return;
        const written = await writeLedger(ports, target, next.value);
        if (written.ok) outcome = 'committed';
      });
      if (!locked.ok) outcome = locked.error.code === 'cancelled' ? 'interrupted' : 'refused';
    } else if (start.homeDir !== null && start.dataDir !== null && start.cwd !== null) {
      const result = await runPromote(
        ports,
        {
          targets: [start.skill],
          tools: [start.tool as FlipTool],
          cwd: start.cwd,
          configuration: resolveRuntimeConfiguration({ SKILLSMITH_HOME: start.dataDir }),
          noVerify: true,
        },
        {
          now: () => '2026-07-15T00:00:00.000Z',
          newTxId: () => start.transactionId,
          verify: async () => {
            throw new Error('P3B-TS04 no-verify worker invoked verification');
          },
        },
      );
      outcome = result.ok
        ? 'committed'
        : result.error.code === 'cancelled'
          ? 'interrupted'
          : 'refused';
    }
  } catch (error) {
    if (error instanceof InjectedInterruption) outcome = 'interrupted';
    else throw error;
  }
  const final = readFinal(target, start);
  if (
    outcome === 'committed' &&
    (final.schemaVersion !== 2 ||
      ((start.mode === 'write-model' || start.mode === 'lock-contention') &&
        !final.requestedMutationPresent))
  ) {
    outcome = 'missing-behavior';
  }
  await send({
    ...correlated(start, 'result', null),
    outcome,
    observedBarriers: observed,
    finalSchemaVersion: final.schemaVersion,
    pendingCount: final.pendingCount,
    historyCount: final.historyCount,
    requestedMutationPresent: final.requestedMutationPresent,
    journalPhase: final.journalPhase,
    historyTransactionIds: final.historyTransactionIds,
    historyAttempts: final.historyAttempts,
    historyStartedAts: final.historyStartedAts,
    sourceRevisionPreserved: final.sourceRevisionPreserved,
  });
};

if (process.argv.includes('--self-check')) {
  process.stdout.write(`${JSON.stringify(SELF_CHECK)}\n`);
} else {
  void main()
    .catch(async (error: unknown) => {
      const reason = (error instanceof Error ? error.message : 'unknown fixture error').slice(
        0,
        MAX_REASON_LENGTH,
      );
      if (currentStart === null) process.stderr.write(`${reason}\n`);
      else {
        await send({
          ...correlated(currentStart, 'fixture-error', null),
          reason,
        }).catch(() => undefined);
      }
    })
    .finally(() => process.disconnect?.());
}
