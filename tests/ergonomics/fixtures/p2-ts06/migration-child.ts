import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

type PlainData =
  | null
  | boolean
  | number
  | string
  | readonly PlainData[]
  | { readonly [key: string]: PlainData };

const ROOT = process.cwd();
const MANIFEST_PATH = join(ROOT, 'manifest.toml');
const COORDINATION_ROOT = join(ROOT, '.p2-ts06-coordination');
const TIMEOUT_MS = 30_000;
const SELF_CHECK = Object.freeze({
  kind: 'p2-ts06-migration-child-self-check',
  protocolVersion: 1,
  accepts: Object.freeze(['start']),
  emits: Object.freeze([
    'fixture-ready',
    'migration-armed',
    'signal-ack',
    'result',
    'fixture-error',
  ]),
  signal: 'SIGINT',
  timeoutMs: TIMEOUT_MS,
});

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: Readonly<Record<string, unknown>> };
type ExecutionResult = Result<{
  readonly outcome: string;
  readonly revision:
    | { readonly state: 'absent' }
    | { readonly state: 'file'; readonly digest: string; readonly mode: number };
}>;

const loadProductionModule = async (
  relativePath: string,
  label: string,
): Promise<Readonly<Record<string, unknown>>> => {
  const path = join(import.meta.dir, relativePath);
  if (!existsSync(path)) throw new Error(`module-not-present: ${label}`);
  try {
    return (await import(pathToFileURL(path).href)) as Readonly<Record<string, unknown>>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown load failure';
    throw new Error(`module-load-failed: ${label}: ${detail}`);
  }
};

const production = async (): Promise<{
  readonly executeProjectConfigMigration: (
    ports: unknown,
    path: string,
    operation: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ) => Promise<ExecutionResult>;
  readonly createTestNodeArtifactCoordinatorPorts: (
    root: string,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly planProjectConfigMigration: (
    source: string,
  ) => Result<Readonly<Record<string, unknown>>>;
}> => {
  const [executor, nodeCoordinator, core] = await Promise.all([
    loadProductionModule(
      '../../../../packages/core/src/artifacts/migration-executor.ts',
      'migration executor',
    ),
    loadProductionModule(
      '../../../../packages/core/src/artifacts/node-coordinator.ts',
      'node coordinator',
    ),
    loadProductionModule('../../../../packages/core/src/index.ts', 'core root'),
  ]);
  if (
    typeof executor.executeProjectConfigMigration !== 'function' ||
    typeof nodeCoordinator.createTestNodeArtifactCoordinatorPorts !== 'function' ||
    typeof core.planProjectConfigMigration !== 'function'
  ) {
    throw new Error('module-load-failed: migration child production surface is incomplete');
  }
  return {
    executeProjectConfigMigration: executor.executeProjectConfigMigration as never,
    createTestNodeArtifactCoordinatorPorts:
      nodeCoordinator.createTestNodeArtifactCoordinatorPorts as never,
    planProjectConfigMigration: core.planProjectConfigMigration as never,
  };
};

const send = (message: PlainData): Promise<void> =>
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

const isStart = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return (
    Reflect.ownKeys(value).length === 1 &&
    descriptors.kind !== undefined &&
    'value' in descriptors.kind &&
    descriptors.kind.value === 'start'
  );
};

const nextMessage = (): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture IPC timeout')), TIMEOUT_MS);
    process.once('message', (message: unknown) => {
      clearTimeout(timer);
      resolve(message);
    });
  });

const copyResult = (result: ExecutionResult): PlainData =>
  result.ok
    ? {
        ok: true,
        value: {
          outcome: result.value.outcome,
          revision: {
            state: result.value.revision.state,
            ...(result.value.revision.state === 'file'
              ? { digest: result.value.revision.digest, mode: result.value.revision.mode }
              : {}),
          },
        },
      }
    : {
        ok: false,
        error: {
          code: result.error.code,
          reason: result.error.reason,
          exitCode: result.error.exitCode,
          message: result.error.message,
        },
      };

const main = async (): Promise<void> => {
  const {
    executeProjectConfigMigration,
    createTestNodeArtifactCoordinatorPorts,
    planProjectConfigMigration,
  } = await production();
  await send({ kind: 'fixture-ready' });
  const start = await nextMessage();
  if (!isStart(start)) throw new Error('invalid fixture start message');

  const source = await readFile(MANIFEST_PATH, 'utf8');
  const planned = planProjectConfigMigration(source);
  if (!planned.ok) throw new Error('fixture source did not produce a migration operation');

  const abortController = new AbortController();
  let releaseBarrier: (() => void) | null = null;
  let armed = false;
  process.on('SIGINT', () => {
    abortController.abort();
    releaseBarrier?.();
    void send({ kind: 'signal-ack', signal: 'SIGINT', aborted: true }).catch(() => undefined);
  });

  const base = await createTestNodeArtifactCoordinatorPorts(COORDINATION_ROOT);
  const ports = Object.freeze({
    ...base,
    afterBarrier: async (barrier: Readonly<Record<string, unknown>>) => {
      if (!armed && barrier.kind === 'lock-acquired' && barrier.targetClass === 'central') {
        armed = true;
        await send({
          kind: 'migration-armed',
          barrier: { kind: barrier.kind, targetClass: barrier.targetClass },
        });
        await new Promise<void>((resolve) => {
          releaseBarrier = resolve;
          if (abortController.signal.aborted) resolve();
        });
      }
    },
  });

  const result = await executeProjectConfigMigration(
    ports,
    MANIFEST_PATH,
    planned.value,
    abortController.signal,
  );
  await send({ kind: 'result', result: copyResult(result) });
};

if (process.argv.includes('--self-check')) {
  process.stdout.write(`${JSON.stringify(SELF_CHECK)}\n`);
} else {
  void main()
    .catch(async (error: unknown) => {
      await send({
        kind: 'fixture-error',
        reason: error instanceof Error ? error.message : 'unknown fixture error',
      }).catch(() => undefined);
      process.exitCode = 2;
    })
    .finally(() => process.disconnect?.());
}
