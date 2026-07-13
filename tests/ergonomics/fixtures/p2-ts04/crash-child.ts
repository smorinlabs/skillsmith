interface CrashBarrierMessage {
  readonly kind: 'arm';
  readonly barrier: Readonly<Record<string, unknown>>;
}

const isPlainDataRecord = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => 'value' in descriptor,
  );
};

const isCrashBarrierMessage = (value: unknown): value is CrashBarrierMessage =>
  isPlainDataRecord(value) && value.kind === 'arm' && isPlainDataRecord(value.barrier);

process.on('message', (message: unknown) => {
  if (!isCrashBarrierMessage(message)) {
    process.send?.({ kind: 'fixture-error', reason: 'invalid-barrier-message' });
    process.exitCode = 2;
    return;
  }
  const canonical = JSON.stringify(message.barrier);
  const copied = JSON.parse(canonical) as Readonly<Record<string, unknown>>;
  process.send?.({ kind: 'reached', barrier: copied });
});

process.send?.({ kind: 'fixture-ready', protocol: 1 });
