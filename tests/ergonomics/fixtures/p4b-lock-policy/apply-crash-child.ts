import { createInterface } from 'node:readline';

const MAX_MESSAGE_BYTES = 64 * 1024;

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
const iterator = lines[Symbol.asyncIterator]();
const first = await iterator.next();
if (first.done || Buffer.byteLength(first.value) > MAX_MESSAGE_BYTES) {
  throw new Error('invalid G4B-03 crash-child message');
}

const message = JSON.parse(first.value) as unknown;
if (
  typeof message !== 'object' ||
  message === null ||
  !('kind' in message) ||
  message.kind !== 'probe'
) {
  throw new Error('invalid G4B-03 crash-child protocol');
}

process.stdout.write(`${JSON.stringify({ kind: 'ready', protocolVersion: 1 })}\n`);
