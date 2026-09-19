import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashCanonicalInput } from '../../../../packages/core/src/artifacts/hash.ts';
import {
  type ArtifactCoordinatorPorts,
  type ArtifactMutationError,
  type ArtifactPairBarrier,
  type ArtifactPairMutationRequest,
  type ArtifactPairMutationResult,
  type ManifestEditRequest,
  type PortableLockV1,
  type ResolvedArtifactPair,
  commitArtifactPair,
  recoverArtifactPair,
} from '../../../../packages/core/src/artifacts/index.ts';
import { createTestNodeArtifactCoordinatorPorts } from '../../../../packages/core/src/artifacts/node-coordinator.ts';
import type { Result } from '../../../../packages/core/src/result.ts';

const IPC_TIMEOUT_MS = 30_000;
const ARMED_TIMEOUT_MS = 60_000;
const ID_16 = /^[0-9a-f]{16}$/u;
const ROOT = process.cwd();
const COORDINATION_ROOT = join(ROOT, '.p2-ts04-coordination');
const MANIFEST_PATH = join(ROOT, 'manifest.toml');
const LOCK_PATH = join(ROOT, 'manifest.lock');
const encoder = new TextEncoder();

type PlainData =
  | null
  | boolean
  | number
  | string
  | readonly PlainData[]
  | { readonly [key: string]: PlainData };

interface CommitActions {
  readonly manifest:
    | { readonly kind: 'keep' }
    | { readonly kind: 'replace'; readonly source: string }
    | { readonly kind: 'edit'; readonly request: PlainData };
  readonly lock:
    | { readonly kind: 'keep' }
    | { readonly kind: 'remove' }
    | { readonly kind: 'replace'; readonly lock: PlainData };
}

interface CommitStartMessage extends CommitActions {
  readonly kind: 'start';
  readonly operation: 'commit';
  readonly recoveryHandoff?: 'resume' | 'rollback';
}

interface RecoverStartMessage {
  readonly kind: 'start';
  readonly operation: 'recover';
  readonly direction: 'resume' | 'rollback';
}

interface RecoverThenCommitStartMessage extends CommitActions {
  readonly kind: 'start';
  readonly operation: 'recover-then-commit';
  readonly direction: 'resume' | 'rollback';
}

interface PartialFailureStartMessage extends CommitActions {
  readonly kind: 'start';
  readonly operation: 'commit-partial-failure';
  readonly failExclusiveWriteAfterBytes: number;
}

type StartMessage =
  | CommitStartMessage
  | RecoverStartMessage
  | RecoverThenCommitStartMessage
  | PartialFailureStartMessage;

interface BarrierCommand {
  readonly kind: 'arm' | 'continue' | 'signal-arm';
  readonly barrier: Readonly<Record<string, unknown>>;
}

interface PhysicalStepInput {
  readonly area: 'transaction' | 'stage' | 'move' | 'recovery';
  readonly step: string;
}

const pair: ResolvedArtifactPair = Object.freeze({
  file: Object.freeze({
    token: './manifest.toml',
    path: MANIFEST_PATH,
    portability: 'portable' as const,
    portableToken: './manifest.toml',
  }),
  lockfile: Object.freeze({
    token: './manifest.lock',
    path: LOCK_PATH,
    portability: 'portable' as const,
    portableToken: './manifest.lock',
  }),
  lockfileSource: 'explicit' as const,
});

const hasExactKeys = (value: Readonly<Record<string, unknown>>, expected: readonly string[]) =>
  Reflect.ownKeys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));

const isPlainRecord = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => 'value' in descriptor,
  );
};

const isPlainData = (
  value: unknown,
  depth = 0,
  seen: Set<object> = new Set(),
): value is PlainData => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }
  if (typeof value !== 'object' || depth >= 20 || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Object.values(descriptors).some(
        (descriptor) => !('value' in descriptor) || descriptor.enumerable === false,
      )
    ) {
      // The non-enumerable length data property is the only permitted exception.
      const invalid = Object.entries(descriptors).some(
        ([key, descriptor]) =>
          key !== 'length' && (!('value' in descriptor) || !descriptor.enumerable),
      );
      if (invalid) return false;
    }
    return value.every((item) => isPlainData(item, depth + 1, seen));
  }
  if (!isPlainRecord(value)) return false;
  return Reflect.ownKeys(value).every(
    (key) => typeof key === 'string' && isPlainData(value[key], depth + 1, seen),
  );
};

const isManifestAction = (value: unknown): value is CommitActions['manifest'] => {
  if (!isPlainRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'keep') return hasExactKeys(value, ['kind']);
  if (value.kind === 'replace') {
    return hasExactKeys(value, ['kind', 'source']) && typeof value.source === 'string';
  }
  return (
    value.kind === 'edit' && hasExactKeys(value, ['kind', 'request']) && isPlainData(value.request)
  );
};

const isLockAction = (value: unknown): value is CommitActions['lock'] => {
  if (!isPlainRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'keep' || value.kind === 'remove') return hasExactKeys(value, ['kind']);
  return (
    value.kind === 'replace' && hasExactKeys(value, ['kind', 'lock']) && isPlainData(value.lock)
  );
};

const isStartMessage = (value: unknown): value is StartMessage => {
  if (!isPlainRecord(value) || value.kind !== 'start') return false;
  if (value.operation === 'recover') {
    return (
      hasExactKeys(value, ['kind', 'operation', 'direction']) &&
      (value.direction === 'resume' || value.direction === 'rollback')
    );
  }
  if (value.operation === 'recover-then-commit') {
    return (
      hasExactKeys(value, ['kind', 'operation', 'direction', 'manifest', 'lock']) &&
      (value.direction === 'resume' || value.direction === 'rollback') &&
      isManifestAction(value.manifest) &&
      isLockAction(value.lock)
    );
  }
  if (value.operation === 'commit-partial-failure') {
    return (
      hasExactKeys(value, [
        'kind',
        'operation',
        'manifest',
        'lock',
        'failExclusiveWriteAfterBytes',
      ]) &&
      isManifestAction(value.manifest) &&
      isLockAction(value.lock) &&
      Number.isSafeInteger(value.failExclusiveWriteAfterBytes) &&
      (value.failExclusiveWriteAfterBytes as number) >= 0 &&
      (value.failExclusiveWriteAfterBytes as number) <= 1024 * 1024
    );
  }
  if (value.operation !== 'commit') return false;
  const baseKeys = ['kind', 'operation', 'manifest', 'lock'];
  const hasHandoff = Object.hasOwn(value, 'recoveryHandoff');
  return (
    hasExactKeys(value, hasHandoff ? [...baseKeys, 'recoveryHandoff'] : baseKeys) &&
    (!hasHandoff || value.recoveryHandoff === 'resume' || value.recoveryHandoff === 'rollback') &&
    isManifestAction(value.manifest) &&
    isLockAction(value.lock)
  );
};

const CURSORS = new Set([
  'prepared',
  'staging',
  'final-guard',
  'lock-backup',
  'lock-install',
  'manifest-backup',
  'manifest-install',
  'pair-verify',
  'rollback-manifest-remove',
  'rollback-manifest-restore',
  'rollback-lock-remove',
  'rollback-lock-restore',
  'rollback-verify',
  'committed',
  'cleanup',
]);
const OPERATIONS = new Set([
  'create-directory-exclusive',
  'create-transaction-directory',
  'create-file-exclusive',
  'set-file-mode',
  'fsync-file',
  'move-into-owned-transaction',
  'link-file-no-replace',
  'replace-recovery-record',
  'remove-file',
  'remove-directory',
  'fsync-directory',
]);
const OBJECTS = new Set([
  'parent',
  'transaction',
  'stage',
  'backup',
  'discard',
  'live',
  'pair',
  'recovery-temp',
  'recovery-record',
]);
const PHYSICAL_STEPS = Object.freeze({
  transaction: new Set([
    'directory-created',
    'owner-opened',
    'owner-written',
    'owner-fsynced',
    'directory-fsynced',
    'parent-fsynced',
  ]),
  stage: new Set(['file-opened', 'bytes-written', 'file-closed', 'partial-removed']),
  move: new Set(['atomic-renamed']),
  recovery: new Set([
    'record-opened',
    'record-written',
    'record-fsynced',
    'temp-opened',
    'temp-written',
    'temp-fsynced',
    'temp-renamed',
    'file-unlinked',
    'directory-fsynced',
  ]),
});

const baseBarrierIsComplete = (barrier: Readonly<Record<string, unknown>>): boolean =>
  typeof barrier.operationId === 'string' &&
  ID_16.test(barrier.operationId) &&
  Number.isSafeInteger(barrier.occurrence) &&
  (barrier.occurrence as number) >= 0 &&
  (barrier.recordRevision === null || typeof barrier.recordRevision === 'string');

const isCompleteBarrier = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (!isPlainRecord(value) || !baseBarrierIsComplete(value)) return false;
  const roleValid = value.role === undefined || value.role === 'manifest' || value.role === 'lock';
  const objectValid = typeof value.object === 'string' && OBJECTS.has(value.object);
  switch (value.kind) {
    case 'lock-acquired':
      return (
        hasExactKeys(value, [
          'kind',
          'targetClass',
          'operationId',
          'occurrence',
          'recordRevision',
        ]) &&
        (value.targetClass === 'central' || value.targetClass === 'compatibility')
      );
    case 'recovery-discovered':
    case 'record-removed':
      return hasExactKeys(value, ['kind', 'operationId', 'occurrence', 'recordRevision']);
    case 'record-durable':
      return (
        hasExactKeys(value, ['kind', 'cursor', 'operationId', 'occurrence', 'recordRevision']) &&
        typeof value.cursor === 'string' &&
        CURSORS.has(value.cursor)
      );
    case 'mutation-returned': {
      const keys = [
        'kind',
        'cursor',
        'operation',
        ...(value.role === undefined ? [] : ['role']),
        ...(value.object === undefined ? [] : ['object']),
        'operationId',
        'occurrence',
        'recordRevision',
      ];
      return (
        hasExactKeys(value, keys) &&
        (value.cursor === 'provisioning' ||
          (typeof value.cursor === 'string' && CURSORS.has(value.cursor))) &&
        typeof value.operation === 'string' &&
        OPERATIONS.has(value.operation) &&
        roleValid &&
        (value.object === undefined || objectValid)
      );
    }
    case 'object-verified': {
      const keys = [
        'kind',
        'cursor',
        ...(value.role === undefined ? [] : ['role']),
        'object',
        'operationId',
        'occurrence',
        'recordRevision',
      ];
      return (
        hasExactKeys(value, keys) &&
        typeof value.cursor === 'string' &&
        CURSORS.has(value.cursor) &&
        roleValid &&
        objectValid
      );
    }
    default:
      return false;
  }
};

const isPhysicalStepInput = (value: unknown): value is PhysicalStepInput =>
  isPlainRecord(value) &&
  hasExactKeys(value, ['area', 'step']) &&
  (value.area === 'transaction' ||
    value.area === 'stage' ||
    value.area === 'move' ||
    value.area === 'recovery') &&
  typeof value.step === 'string' &&
  PHYSICAL_STEPS[value.area].has(value.step);

const isPhysicalPoint = (value: unknown): value is Readonly<Record<string, unknown>> =>
  isPlainRecord(value) &&
  hasExactKeys(value, ['kind', 'area', 'step', 'occurrence']) &&
  value.kind === 'physical-step' &&
  isPhysicalStepInput({ area: value.area, step: value.step }) &&
  Number.isSafeInteger(value.occurrence) &&
  (value.occurrence as number) >= 0;

const isCrashPoint = (value: unknown): value is Readonly<Record<string, unknown>> =>
  (isPlainRecord(value) && hasExactKeys(value, ['kind']) && value.kind === 'before-acquisition') ||
  isCompleteBarrier(value) ||
  isPhysicalPoint(value);

const isBarrierCommand = (value: unknown): value is BarrierCommand =>
  isPlainRecord(value) &&
  hasExactKeys(value, ['kind', 'barrier']) &&
  (value.kind === 'arm' || value.kind === 'continue' || value.kind === 'signal-arm') &&
  isCrashPoint(value.barrier);

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

const copyPlain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const sendMessage = (message: PlainData): Promise<void> =>
  new Promise((resolve, reject) => {
    if (process.send === undefined || !process.connected) {
      reject(new Error('fixture IPC is unavailable'));
      return;
    }
    process.send(message, (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });

const inbox: unknown[] = [];
let pending:
  | {
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: Error) => void;
      readonly timer: ReturnType<typeof setTimeout>;
      readonly signal?: AbortSignal;
      readonly abort?: () => void;
    }
  | undefined;

process.on('message', (message: unknown) => {
  if (pending === undefined) {
    inbox.push(message);
    return;
  }
  const current = pending;
  pending = undefined;
  clearTimeout(current.timer);
  if (current.signal !== undefined && current.abort !== undefined) {
    current.signal.removeEventListener('abort', current.abort);
  }
  current.resolve(message);
});

const nextMessage = (timeoutMs: number, signal?: AbortSignal): Promise<unknown> => {
  if (pending !== undefined) return Promise.reject(new Error('concurrent fixture IPC read'));
  if (inbox.length > 0) return Promise.resolve(inbox.shift());
  if (signal?.aborted)
    return Promise.reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending = undefined;
      signal?.removeEventListener('abort', abort);
      reject(new Error('fixture IPC timeout'));
    }, timeoutMs);
    const abort = () => {
      pending = undefined;
      clearTimeout(timer);
      reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
    };
    signal?.addEventListener('abort', abort, { once: true });
    pending = { resolve, reject, timer, ...(signal === undefined ? {} : { signal, abort }) };
  });
};

const abortController = new AbortController();
let signalArmPoint: Readonly<Record<string, unknown>> | null = null;
let signalAckSend: Promise<void> | null = null;
process.on('SIGINT', () => {
  abortController.abort();
  if (signalArmPoint === null) return;
  signalAckSend = sendMessage({
    kind: 'signal-ack',
    signal: 'SIGINT',
    barrier: copyPlain(signalArmPoint),
    aborted: abortController.signal.aborted,
  });
  void signalAckSend.catch(() => undefined);
});

const awaitArmedCrash = async (): Promise<void> => {
  if (abortController.signal.aborted) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      abortController.signal.removeEventListener('abort', aborted);
      reject(new Error('armed barrier was not terminated'));
    }, ARMED_TIMEOUT_MS);
    const aborted = () => {
      clearTimeout(timeout);
      resolve();
    };
    abortController.signal.addEventListener('abort', aborted, { once: true });
  });
};

const awaitCrashPoint = async (
  candidateKind: 'barrier-candidate' | 'physical-candidate',
  point: Readonly<Record<string, unknown>>,
): Promise<void> => {
  if (!isCrashPoint(point)) throw new Error('coordinator emitted an incomplete crash point');
  if (abortController.signal.aborted) return;
  const copied = copyPlain(point);
  await sendMessage({ kind: candidateKind, barrier: copied } as PlainData);
  let message: unknown;
  try {
    message = await nextMessage(IPC_TIMEOUT_MS, abortController.signal);
  } catch (error) {
    if (abortController.signal.aborted) return;
    throw error;
  }
  if (!isBarrierCommand(message) || canonicalJson(message.barrier) !== canonicalJson(copied)) {
    throw new Error('invalid or mismatched barrier command');
  }
  // Re-copy the parent's exact echo before acting on it; the selector also guards this bounded IPC
  // step so a future fixture cannot accidentally retain a mutable or accessor-backed payload.
  const echoedBarrier = JSON.parse(JSON.stringify(message.barrier)) as Readonly<
    Record<string, unknown>
  >;
  if (canonicalJson(echoedBarrier) !== canonicalJson(copied)) {
    throw new Error('barrier echo changed during plain-data copy');
  }
  if (message.kind === 'arm') {
    await sendMessage({ kind: 'reached', barrier: copied } as PlainData);
    await awaitArmedCrash();
  } else if (message.kind === 'signal-arm') {
    if (signalArmPoint !== null) throw new Error('duplicate signal arm');
    signalArmPoint = copied;
    await sendMessage({ kind: 'signal-armed', barrier: copied } as PlainData);
    await awaitArmedCrash();
  }
};

let barrierOperationId: string | null = null;
const seenOperationIds = new Set<string>();
const allocatedIds = new Map<string, string>();
let currentRecordRevision: string | null = null;
let discoveredRecordRevision: string | null = null;
const REVISION = /^sha256:[0-9a-f]{64}$/u;

const barrierHook = async (barrier: ArtifactPairBarrier): Promise<void> => {
  if (!isCompleteBarrier(barrier)) throw new Error('coordinator emitted an incomplete barrier');
  if (barrierOperationId === null) {
    if (seenOperationIds.has(barrier.operationId)) {
      throw new Error('coordinator reused an operationId across public invocations');
    }
    if (allocatedIds.get(barrier.operationId) !== 'artifact-operation') {
      throw new Error('barrier operationId was not allocated for the invocation');
    }
    seenOperationIds.add(barrier.operationId);
    barrierOperationId = barrier.operationId;
  } else if (barrier.operationId !== barrierOperationId) {
    throw new Error('coordinator changed operationId within one public invocation');
  }
  if (barrier.recordRevision !== null && !REVISION.test(barrier.recordRevision)) {
    throw new Error('coordinator emitted a malformed recovery revision');
  }
  if (barrier.recordRevision !== null && currentRecordRevision === null) {
    if (barrier.recordRevision !== discoveredRecordRevision) {
      throw new Error('coordinator emitted an arbitrary recovery revision');
    }
    currentRecordRevision = barrier.recordRevision;
  }
  if (barrier.recordRevision !== currentRecordRevision) {
    throw new Error('coordinator emitted a stale recovery revision');
  }
  await awaitCrashPoint('barrier-candidate', barrier);
};

const physicalOccurrences = new Map<string, number>();
const physicalHook = async (step: PhysicalStepInput): Promise<void> => {
  if (!isPhysicalStepInput(step)) throw new Error('adapter emitted an invalid physical step');
  const key = `${step.area}:${step.step}`;
  const occurrence = physicalOccurrences.get(key) ?? 0;
  physicalOccurrences.set(key, occurrence + 1);
  await awaitCrashPoint(
    'physical-candidate',
    Object.freeze({ kind: 'physical-step', ...step, occurrence }),
  );
};

const makeRequest = (message: CommitActions): ArtifactPairMutationRequest => ({
  pair,
  manifest:
    message.manifest.kind === 'replace'
      ? { kind: 'replace', bytes: encoder.encode(message.manifest.source) }
      : message.manifest.kind === 'edit'
        ? { kind: 'edit', request: message.manifest.request as ManifestEditRequest }
        : { kind: 'keep' },
  lock:
    message.lock.kind === 'replace'
      ? { kind: 'replace', lock: message.lock.lock as unknown as PortableLockV1 }
      : message.lock.kind === 'remove'
        ? { kind: 'remove' }
        : { kind: 'keep' },
  signal: abortController.signal,
});

const resultPlainData = (
  result:
    | Result<ArtifactPairMutationResult, ArtifactMutationError>
    | Result<'clean' | 'rolled-back' | 'finalized', ArtifactMutationError>,
): PlainData => copyPlain(result) as PlainData;

const assertRawRecoveryRevision = async (key: string, revision: string): Promise<void> => {
  const raw = new Uint8Array(await readFile(join(COORDINATION_ROOT, 'recovery', `${key}.json`)));
  const hashed = hashCanonicalInput('resource', 1, raw);
  if (!hashed.ok || hashed.value !== revision) {
    throw new Error('recovery envelope revision did not match durable raw bytes');
  }
};

const main = async (): Promise<void> => {
  await sendMessage({
    kind: 'fixture-ready',
    protocol: 2,
    root: ROOT,
    coordinationRoot: COORDINATION_ROOT,
    manifestPath: MANIFEST_PATH,
    lockPath: LOCK_PATH,
  });
  const start = await nextMessage(IPC_TIMEOUT_MS);
  if (!isStartMessage(start)) throw new Error('invalid start message');
  await awaitCrashPoint('barrier-candidate', Object.freeze({ kind: 'before-acquisition' }));
  const basePorts = await createTestNodeArtifactCoordinatorPorts(COORDINATION_ROOT, {
    afterPhysicalStep: physicalHook,
    ...(start.operation === 'commit-partial-failure'
      ? { failExclusiveWriteAfterBytes: start.failExclusiveWriteAfterBytes }
      : {}),
  });
  const recovery = Object.freeze({
    discover: async () => {
      const records = await basePorts.recovery.discover();
      for (const envelope of records) {
        await assertRawRecoveryRevision(envelope.record.key, envelope.revision);
      }
      discoveredRecordRevision = records.length === 1 ? (records[0]?.revision ?? null) : null;
      return records;
    },
    create: async (record: Parameters<ArtifactCoordinatorPorts['recovery']['create']>[0]) => {
      const envelope = await basePorts.recovery.create(record);
      await assertRawRecoveryRevision(record.key, envelope.revision);
      currentRecordRevision = envelope.revision;
      return envelope;
    },
    replace: async (
      record: Parameters<ArtifactCoordinatorPorts['recovery']['replace']>[0],
      revision: string,
    ) => {
      if (currentRecordRevision === null && revision !== discoveredRecordRevision) {
        throw new Error('coordinator replaced an undiscovered recovery revision');
      }
      if (currentRecordRevision !== null && revision !== currentRecordRevision) {
        throw new Error('coordinator replaced a stale recovery revision');
      }
      const envelope = await basePorts.recovery.replace(record, revision);
      await assertRawRecoveryRevision(record.key, envelope.revision);
      currentRecordRevision = envelope.revision;
      return envelope;
    },
    remove: async (key: string, revision: string) => {
      if (currentRecordRevision !== null && revision !== currentRecordRevision) {
        throw new Error('coordinator removed a stale recovery revision');
      }
      await basePorts.recovery.remove(key, revision);
      try {
        await readFile(join(COORDINATION_ROOT, 'recovery', `${key}.json`));
        throw new Error('recovery record remained after successful removal');
      } catch (error) {
        if (
          error === null ||
          typeof error !== 'object' ||
          !('code' in error) ||
          error.code !== 'ENOENT'
        ) {
          throw error;
        }
      }
      currentRecordRevision = null;
      discoveredRecordRevision = null;
    },
  });
  const ports = Object.freeze({
    ...basePorts,
    recovery,
    afterBarrier: barrierHook,
    nextId: (purpose: Parameters<ArtifactCoordinatorPorts['nextId']>[0]) => {
      const id = basePorts.nextId(purpose);
      if (allocatedIds.has(id)) throw new Error('fixture adapter allocated a duplicate id');
      allocatedIds.set(id, purpose);
      return id;
    },
  });
  let result:
    | Awaited<ReturnType<typeof commitArtifactPair>>
    | Awaited<ReturnType<typeof recoverArtifactPair>>;
  if (start.operation === 'recover') {
    result = await recoverArtifactPair(ports, pair, start.direction);
  } else if (start.operation === 'recover-then-commit') {
    const recovered = await recoverArtifactPair(ports, pair, start.direction);
    if (!recovered.ok) result = recovered;
    else {
      barrierOperationId = null;
      currentRecordRevision = null;
      discoveredRecordRevision = null;
      result = await commitArtifactPair(ports, makeRequest(start));
    }
  } else {
    result = await commitArtifactPair(ports, makeRequest(start));
    if (
      start.operation === 'commit' &&
      start.recoveryHandoff !== undefined &&
      !result.ok &&
      result.error.reason === 'cancelled'
    ) {
      const cancelled = result;
      barrierOperationId = null;
      currentRecordRevision = null;
      discoveredRecordRevision = null;
      const recovered = await recoverArtifactPair(ports, pair, start.recoveryHandoff);
      result = recovered.ok ? cancelled : recovered;
    }
  }
  if (signalAckSend !== null) await signalAckSend;
  await sendMessage({
    kind: 'result',
    operation: start.operation,
    result: resultPlainData(result),
  });
};

void main()
  .catch(async (error: unknown) => {
    const reason = error instanceof Error ? error.message : 'unknown fixture error';
    await sendMessage({ kind: 'fixture-error', reason }).catch(() => undefined);
    process.exitCode = 2;
  })
  .finally(() => {
    process.disconnect?.();
  });
