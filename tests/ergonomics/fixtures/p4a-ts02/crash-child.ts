import { open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';

const MAX_BYTES = 1024 * 1024;
const ACK_TIMEOUT_MS = 30_000;

interface StartMessage {
  readonly kind: 'start';
  readonly root: string;
  readonly stopAfter: 'manifest' | 'lock';
  readonly manifestSource: string;
  readonly lockSource: string;
}

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
const iterator = lines[Symbol.asyncIterator]();

const nextLine = async (): Promise<string> => {
  const value = await iterator.next();
  if (value.done) throw new Error('p4a-ts02 crash child stdin closed');
  return value.value;
};

const start = JSON.parse(await nextLine()) as Partial<StartMessage>;
if (
  start.kind !== 'start' ||
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
  throw new Error('invalid p4a-ts02 crash child start message');
}

const durableWrite = async (path: string, source: string): Promise<void> => {
  const handle = await open(path, 'w', 0o600);
  try {
    await handle.writeFile(source, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
};

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
