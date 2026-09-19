import { open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { runUninstall } from '../../../../packages/core/src/acquire/run.ts';
import { createTestNodeArtifactCoordinatorPorts } from '../../../../packages/core/src/artifacts/node-coordinator.ts';
import { resolveRuntimeConfiguration } from '../../../../packages/core/src/config/runtime.ts';
import { readLedgerState } from '../../../../packages/core/src/place/ledger.ts';
import { ledgerPathOf } from '../../../../packages/core/src/place/paths.ts';
import type { FlipTool } from '../../../../packages/core/src/place/types.ts';
import { defaultRuntimePorts } from '../../../../packages/core/src/ports/default.ts';

const MAX_BYTES = 1024 * 1024;
const ACK_TIMEOUT_MS = 30_000;

interface ArtifactStartMessage {
  readonly kind: 'start';
  readonly root: string;
  readonly stopAfter: 'manifest' | 'lock';
  readonly manifestSource: string;
  readonly lockSource: string;
}

interface LiveStartMessage {
  readonly kind: 'start-live';
  readonly cwd: string;
  readonly dataDir: string;
  readonly target: string;
  readonly tools: readonly FlipTool[];
  readonly coordinationRoot: string;
}

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
const iterator = lines[Symbol.asyncIterator]();

const nextLine = async (): Promise<string> => {
  const value = await iterator.next();
  if (value.done) throw new Error('p4a-ts02 crash child stdin closed');
  return value.value;
};

const start = JSON.parse(await nextLine()) as
  | Partial<ArtifactStartMessage>
  | Partial<LiveStartMessage>;

const durableWrite = async (path: string, source: string): Promise<void> => {
  const handle = await open(path, 'w', 0o600);
  try {
    await handle.writeFile(source, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
};

if (start.kind === 'start') {
  if (
    typeof start.root !== 'string' ||
    !isAbsolute(start.root) ||
    (start.stopAfter !== 'manifest' && start.stopAfter !== 'lock') ||
    typeof start.manifestSource !== 'string' ||
    typeof start.lockSource !== 'string' ||
    Buffer.byteLength(start.manifestSource) > MAX_BYTES ||
    Buffer.byteLength(start.lockSource) > MAX_BYTES ||
    start.manifestSource.includes('\0') ||
    start.lockSource.includes('\0')
  ) {
    throw new Error('invalid p4a-ts02 artifact crash child start message');
  }
  await durableWrite(join(start.root, 'skillsmith.toml'), start.manifestSource);
  if (start.stopAfter === 'lock') {
    await durableWrite(join(start.root, 'skillsmith.lock'), start.lockSource);
  }
  process.stdout.write(
    `${JSON.stringify({ kind: 'reached', barrier: `after-${start.stopAfter}` })}\n`,
  );

  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(
      () => reject(new Error('p4a-ts02 crash child acknowledgement timed out')),
      ACK_TIMEOUT_MS,
    );
  });
  const acknowledgement = JSON.parse(await Promise.race([nextLine(), timeout])) as unknown;
  if (
    typeof acknowledgement !== 'object' ||
    acknowledgement === null ||
    !('kind' in acknowledgement) ||
    acknowledgement.kind !== 'ack'
  ) {
    throw new Error('invalid p4a-ts02 crash child acknowledgement');
  }
  process.stdout.write(`${JSON.stringify({ kind: 'completed' })}\n`);
} else if (start.kind === 'start-live') {
  if (
    typeof start.cwd !== 'string' ||
    !isAbsolute(start.cwd) ||
    typeof start.dataDir !== 'string' ||
    !isAbsolute(start.dataDir) ||
    typeof start.target !== 'string' ||
    start.target.length === 0 ||
    !Array.isArray(start.tools) ||
    start.tools.length < 2 ||
    start.tools.some((tool) => tool !== 'claude-code' && tool !== 'codex' && tool !== 'opencode') ||
    typeof start.coordinationRoot !== 'string' ||
    !isAbsolute(start.coordinationRoot)
  ) {
    throw new Error('invalid p4a-ts02 live crash child start message');
  }
  const runtime = await defaultRuntimePorts();
  let reached = false;
  const env = {
    ...runtime,
    afterLedgerBarrier: async (barrier: Readonly<{ kind: string }>) => {
      if (reached || barrier.kind !== 'writer-live-parent-fsync') return;
      const state = await readLedgerState(runtime, ledgerPathOf(start.dataDir as string));
      if (
        !state.ok ||
        state.value.state !== 'present' ||
        !state.value.model.history.some(
          ({ disposition, phase, intent }) =>
            disposition === 'forward' &&
            phase === 'committed' &&
            intent.kind === 'remove' &&
            intent.skill === start.target,
        )
      ) {
        return;
      }
      reached = true;
      process.stdout.write(`${JSON.stringify({ kind: 'reached', barrier: 'after-live-pair' })}\n`);
      await new Promise<never>(() => undefined);
    },
  };
  const coordinator = await createTestNodeArtifactCoordinatorPorts(start.coordinationRoot);
  let index = 0;
  const result = await runUninstall(
    env,
    {
      targets: [start.target],
      tools: start.tools as readonly FlipTool[],
      scope: 'user',
      noSave: true,
      cwd: start.cwd,
      configuration: resolveRuntimeConfiguration({ SKILLSMITH_HOME: start.dataDir }),
    },
    {
      artifactCoordinator: coordinator,
      now: () => '2026-07-18T00:00:00.000Z',
      newTxId: () => (0x7300000000000000n + BigInt(index++)).toString(16),
    },
  );
  if (!result.ok) throw result.error;
  throw new Error('p4a-ts02 live crash child completed before its durable barrier');
} else {
  throw new Error('invalid p4a-ts02 crash child start message');
}
