import { isAbsolute, join, relative, resolve } from 'node:path';
import type { ResolvedArtifactPair } from '../../../../packages/core/src/artifacts/coordinator-types.ts';
import { ARTIFACT_LOCK_RETRY_DELAYS_MS } from '../../../../packages/core/src/artifacts/coordinator-types.ts';
import { withArtifactGroupLock } from '../../../../packages/core/src/artifacts/coordinator.ts';
import { createTestNodeArtifactCoordinatorPorts } from '../../../../packages/core/src/artifacts/node-coordinator.ts';
import { defaultRuntimePorts } from '../../../../packages/core/src/ports/default.ts';

const IPC_TIMEOUT_MS = 30_000;
const MAX_HOLD_MS = 30_000;
const OPERATION_ID = '0123456789abcdef';
const ROOT = process.cwd();
const COORDINATION_ROOT = join(ROOT, '.p2-ts04-coordination');

type PlainData =
  | null
  | boolean
  | number
  | string
  | readonly PlainData[]
  | { readonly [key: string]: PlainData };

interface LockChildRequest {
  readonly kind: 'hold' | 'contend';
  readonly policy: 'central' | 'compatibility' | 'legacy-compatibility' | 'group';
  /** `global` for the central lock; otherwise a cwd-relative compatibility target. */
  readonly target: string;
  readonly holdMs: number;
}

const isPlainRecord = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => 'value' in descriptor,
  );
};

const hasExactKeys = (value: Readonly<Record<string, unknown>>, expected: readonly string[]) =>
  Reflect.ownKeys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));

const safeCompatibilityToken = (token: string): boolean => {
  if (token.length === 0 || token.length > 240 || isAbsolute(token)) return false;
  if ([...token].some((character) => character.charCodeAt(0) <= 0x1f)) return false;
  const target = resolve(ROOT, token);
  const displacement = relative(ROOT, target);
  return (
    displacement !== '' &&
    displacement !== '..' &&
    !displacement.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    !isAbsolute(displacement) &&
    target !== COORDINATION_ROOT &&
    !target.startsWith(`${COORDINATION_ROOT}${process.platform === 'win32' ? '\\' : '/'}`)
  );
};

const isLockChildRequest = (value: unknown): value is LockChildRequest => {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['kind', 'policy', 'target', 'holdMs'])) {
    return false;
  }
  return (
    (value.kind === 'hold' || value.kind === 'contend') &&
    (value.policy === 'central' ||
      value.policy === 'compatibility' ||
      value.policy === 'legacy-compatibility' ||
      value.policy === 'group') &&
    typeof value.target === 'string' &&
    Number.isSafeInteger(value.holdMs) &&
    (value.holdMs as number) >= 0 &&
    (value.holdMs as number) <= MAX_HOLD_MS &&
    ((value.policy === 'central' && value.target === 'global') ||
      (value.policy !== 'central' && safeCompatibilityToken(value.target)))
  );
};

const sendMessage = (message: PlainData): Promise<void> =>
  new Promise((resolveSend, reject) => {
    if (process.send === undefined || !process.connected) {
      reject(new Error('fixture IPC is unavailable'));
      return;
    }
    process.send(message, (error) => {
      if (error === null) resolveSend();
      else reject(error);
    });
  });

const nextMessage = (timeoutMs: number): Promise<unknown> =>
  new Promise((resolveMessage, reject) => {
    const timeout = setTimeout(() => {
      process.removeListener('message', received);
      reject(new Error('fixture IPC timeout'));
    }, timeoutMs);
    const received = (message: unknown) => {
      clearTimeout(timeout);
      resolveMessage(message);
    };
    process.once('message', received);
  });

const abortController = new AbortController();
process.on('SIGINT', () => abortController.abort());

const delay = (milliseconds: number): Promise<void> => {
  if (milliseconds === 0) return Promise.resolve();
  return new Promise((resolveDelay, reject) => {
    const timeout = setTimeout(() => {
      abortController.signal.removeEventListener('abort', aborted);
      resolveDelay();
    }, milliseconds);
    const aborted = () => {
      clearTimeout(timeout);
      reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
    };
    abortController.signal.addEventListener('abort', aborted, { once: true });
  });
};

const errorData = (error: unknown): PlainData => {
  if (typeof error !== 'object' || error === null) return { message: 'unknown lock error' };
  const record = error as Readonly<Record<string, unknown>>;
  return {
    ...(typeof record.code === 'string' ? { code: record.code } : {}),
    ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
    ...(typeof record.exitCode === 'number' ? { exitCode: record.exitCode } : {}),
    message: error instanceof Error ? error.message : 'lock operation failed',
  };
};

const main = async (): Promise<void> => {
  const ports = await createTestNodeArtifactCoordinatorPorts(COORDINATION_ROOT);
  const requestMessage = nextMessage(IPC_TIMEOUT_MS);
  await sendMessage({
    kind: 'fixture-ready',
    protocol: 2,
    root: ROOT,
    coordinationRoot: COORDINATION_ROOT,
  });
  const request = await requestMessage;
  if (!isLockChildRequest(request)) throw new Error('invalid lock request');
  const targetPath =
    request.policy === 'central'
      ? join(COORDINATION_ROOT, 'global')
      : resolve(ROOT, request.target);
  await sendMessage({
    kind: 'ready',
    requestKind: request.kind,
    policy: request.policy,
    target: request.target,
    targetPath,
  });
  const deadline = setTimeout(
    () => abortController.abort(),
    request.holdMs + ARTIFACT_LOCK_RETRY_DELAYS_MS.reduce((sum, wait) => sum + wait, 0) + 10_000,
  );
  try {
    const operation = async (): Promise<void> => {
      await sendMessage({
        kind: 'acquired',
        requestKind: request.kind,
        policy: request.policy,
        target: request.target,
        targetPath,
      });
      await delay(request.holdMs);
    };
    if (request.policy === 'group') {
      const peerPath = `${targetPath}.peer`;
      const pair: ResolvedArtifactPair = Object.freeze({
        file: Object.freeze({
          token: null,
          path: targetPath,
          portability: 'machine-bound' as const,
          portableToken: null,
        }),
        lockfile: Object.freeze({
          token: null,
          path: peerPath,
          portability: 'machine-bound' as const,
          portableToken: null,
        }),
        lockfileSource: 'sibling' as const,
      });
      await withArtifactGroupLock(ports, pair, abortController.signal, async (lease) => {
        await lease.acquireCompatibilityTargets([targetPath, peerPath]);
        await operation();
      });
    } else if (request.policy === 'legacy-compatibility') {
      const legacy = await defaultRuntimePorts();
      await legacy.withFileLock(targetPath, operation);
    } else {
      await ports.withFileLock(
        targetPath,
        {
          policy: request.policy,
          centralOperationId: OPERATION_ID,
          signal: abortController.signal,
          retryDelaysMs: ARTIFACT_LOCK_RETRY_DELAYS_MS,
        },
        operation,
      );
    }
    await sendMessage({
      kind: 'result',
      requestKind: request.kind,
      policy: request.policy,
      target: request.target,
      ok: true,
    });
  } catch (error) {
    await sendMessage({
      kind: 'result',
      requestKind: request.kind,
      policy: request.policy,
      target: request.target,
      ok: false,
      error: errorData(error),
    });
  } finally {
    clearTimeout(deadline);
  }
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
