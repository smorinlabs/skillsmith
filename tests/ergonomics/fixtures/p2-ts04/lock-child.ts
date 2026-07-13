interface LockChildRequest {
  readonly kind: 'hold' | 'contend';
  readonly policy: 'central' | 'compatibility';
  readonly target: string;
  readonly holdMs: number;
}

const isLockChildRequest = (value: unknown): value is LockChildRequest => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.values(descriptors).some((descriptor) => !('value' in descriptor))
  ) {
    return false;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return (
    (record.kind === 'hold' || record.kind === 'contend') &&
    (record.policy === 'central' || record.policy === 'compatibility') &&
    typeof record.target === 'string' &&
    Number.isSafeInteger(record.holdMs) &&
    (record.holdMs as number) >= 0
  );
};

process.on('message', (message: unknown) => {
  if (!isLockChildRequest(message)) {
    process.send?.({ kind: 'fixture-error', reason: 'invalid-lock-message' });
    process.exitCode = 2;
    return;
  }
  process.send?.({
    kind: 'lock-request',
    policy: message.policy,
    target: message.target,
    holdMs: message.holdMs,
  });
});

process.send?.({ kind: 'fixture-ready', protocol: 1 });
