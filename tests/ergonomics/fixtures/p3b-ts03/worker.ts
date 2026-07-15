import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultRuntimePorts } from '../../../../packages/core/src/index.ts';

type PlainData =
  | null
  | boolean
  | number
  | string
  | readonly PlainData[]
  | { readonly [key: string]: PlainData };

const TIMEOUT_MS = 30_000;
const MAX_MESSAGE_BYTES = 2_048;
const MAX_REASON_LENGTH = 512;
const TARGET = join(process.cwd(), 'placements.json');
const SELF_CHECK = Object.freeze({
  kind: 'p3b-ts03-worker-self-check',
  protocolVersion: 1,
  target: 'placements.json',
  timeoutMs: TIMEOUT_MS,
  accepts: Object.freeze(['start', 'release', 'cancel']),
  emits: Object.freeze([
    'fixture-ready',
    'attempting',
    'acquired',
    'callback-complete',
    'cancel-ack',
    'cancelled',
    'completed',
    'fixture-error',
  ]),
});

const send = (message: PlainData): Promise<void> => {
  if (new TextEncoder().encode(JSON.stringify(message)).byteLength > MAX_MESSAGE_BYTES) {
    return Promise.reject(new Error('fixture IPC message exceeds the bounded size'));
  }
  return new Promise((resolve, reject) => {
    if (process.send === undefined || !process.connected) {
      reject(new Error('fixture IPC is unavailable'));
      return;
    }
    process.send(message, (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
};

const exactMessage = (
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const ownKeys = Object.keys(record).sort();
  return JSON.stringify(ownKeys) === JSON.stringify([...keys].sort()) ? record : null;
};

const nextMessage = (): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture IPC timeout')), TIMEOUT_MS);
    process.once('message', (message: unknown) => {
      clearTimeout(timer);
      resolve(message);
    });
  });

const startRole = (value: unknown): 'holder' | 'contender' | 'cancellable-contender' => {
  const record = exactMessage(value, ['kind', 'role']);
  if (
    record?.kind !== 'start' ||
    (record.role !== 'holder' &&
      record.role !== 'contender' &&
      record.role !== 'cancellable-contender')
  ) {
    throw new Error('invalid fixture start message');
  }
  return record.role;
};

const requireRelease = (value: unknown): void => {
  const record = exactMessage(value, ['kind', 'role']);
  if (record?.kind !== 'release' || record.role !== 'holder') {
    throw new Error('invalid fixture release message');
  }
};

const isCancel = (value: unknown): boolean => {
  const record = exactMessage(value, ['kind', 'role']);
  return record?.kind === 'cancel' && record.role === 'cancellable-contender';
};

const guardWorkingDirectory = (): void => {
  const marker = readFileSync(TARGET, 'utf8');
  if (marker !== '{"fixture":"p3b-ts03"}\n') {
    throw new Error('fixture target is not the parent-created marker');
  }
};

const main = async (): Promise<void> => {
  guardWorkingDirectory();
  await send({ kind: 'fixture-ready' });
  const role = startRole(await nextMessage());
  const ports = await defaultRuntimePorts();
  const controller = new AbortController();
  if (role === 'cancellable-contender') {
    process.on('message', (message: unknown) => {
      if (!isCancel(message)) return;
      controller.abort();
      void send({ kind: 'cancel-ack', role }).catch(() => undefined);
    });
  }
  await send({ kind: 'attempting', role });
  const withSignal = ports.withFileLock as unknown as <T>(
    path: string,
    operation: () => Promise<T>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<T>;
  try {
    await withSignal(
      TARGET,
      async () => {
        await send({ kind: 'acquired', role });
        if (role === 'holder') requireRelease(await nextMessage());
        await send({ kind: 'callback-complete', role });
      },
      Object.freeze({ signal: controller.signal }),
    );
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    if (role === 'cancellable-contender' && code === 'cancelled') {
      await send({ kind: 'cancelled', role, code });
      await send({ kind: 'completed', role });
      return;
    }
    throw error;
  }
  await send({ kind: 'completed', role });
};

if (process.argv.includes('--self-check')) {
  process.stdout.write(`${JSON.stringify(SELF_CHECK)}\n`);
} else {
  void main()
    .catch(async (error: unknown) => {
      await send({
        kind: 'fixture-error',
        reason: (error instanceof Error ? error.message : 'unknown fixture error').slice(
          0,
          MAX_REASON_LENGTH,
        ),
      }).catch(() => undefined);
      process.exitCode = 2;
    })
    .finally(() => process.disconnect?.());
}
