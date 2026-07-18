export const PORT_ERROR_CODES = [
  'not-found',
  'permission',
  'unavailable',
  'timeout',
  'cancelled',
  'conflict',
  'invalid',
  'io',
] as const;

export type PortErrorCode = (typeof PORT_ERROR_CODES)[number];
export type PortErrorContextValue = string | number | boolean | null;
export type PortErrorContext = Readonly<Record<string, PortErrorContextValue>>;
export type PortCapability =
  | 'file-read'
  | 'file-write'
  | 'lock'
  | 'path-access'
  | 'process'
  | 'git'
  | 'http';

export interface PortError {
  readonly capability: PortCapability;
  readonly operation: string;
  readonly code: PortErrorCode;
  readonly message: string;
  readonly context: PortErrorContext;
}

export interface PortErrorDescriptor {
  readonly capability: PortCapability;
  readonly operation: string;
  readonly context?: PortErrorContext;
  readonly code?: PortErrorCode;
  readonly message?: string;
}

export const portError = (error: PortError): PortError =>
  Object.freeze({
    capability: error.capability,
    operation: error.operation,
    code: error.code,
    message: error.message,
    context: Object.freeze({ ...error.context }),
  });

const safeMessage = (value: unknown): string => {
  const raw = value instanceof Error ? value.message : typeof value === 'string' ? value : '';
  const singleLine = raw.replace(/[\r\n]+/g, ' ').trim();
  return singleLine.length > 0 ? singleLine.slice(0, 500) : 'adapter operation failed';
};

const codeFrom = (value: unknown): PortErrorCode => {
  if (isPortError(value)) return value.code;
  if (!isRecord(value)) return 'io';
  const code = typeof value.code === 'string' ? value.code : '';
  const name = typeof value.name === 'string' ? value.name : '';
  if (code === 'ENOENT') return 'not-found';
  if (code === 'EACCES' || code === 'EPERM') return 'permission';
  if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'ELOCKED') return 'conflict';
  if (code === 'ETIMEDOUT' || code === 'TIMEOUT' || name === 'TimeoutError') return 'timeout';
  if (code === 'ABORT_ERR' || code === 'AbortError' || name === 'AbortError') return 'cancelled';
  if (code === 'EINVAL') return 'invalid';
  return 'io';
};

export const toPortError = (value: unknown, descriptor: PortErrorDescriptor): PortError =>
  portError({
    capability: descriptor.capability,
    operation: descriptor.operation,
    code: descriptor.code ?? codeFrom(value),
    message: descriptor.message ?? safeMessage(value),
    context: descriptor.context ?? {},
  });

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;

export const isPortError = (value: unknown): value is PortError => {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'capability,code,context,message,operation') return false;
  return (
    typeof value.capability === 'string' &&
    ['file-read', 'file-write', 'lock', 'path-access', 'process', 'git', 'http'].includes(
      value.capability,
    ) &&
    typeof value.operation === 'string' &&
    typeof value.message === 'string' &&
    typeof value.code === 'string' &&
    (PORT_ERROR_CODES as readonly string[]).includes(value.code) &&
    isRecord(value.context) &&
    Object.values(value.context).every(
      (entry) =>
        entry === null ||
        typeof entry === 'string' ||
        typeof entry === 'number' ||
        typeof entry === 'boolean',
    )
  );
};
