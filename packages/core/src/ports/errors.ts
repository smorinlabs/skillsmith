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
export type PortCapability = 'file-read' | 'file-write' | 'lock' | 'process' | 'git' | 'http';

export interface PortError {
  readonly capability: PortCapability;
  readonly operation: string;
  readonly code: PortErrorCode;
  readonly message: string;
  readonly context: PortErrorContext;
}

export const portError = (error: PortError): PortError =>
  Object.freeze({
    capability: error.capability,
    operation: error.operation,
    code: error.code,
    message: error.message,
    context: Object.freeze({ ...error.context }),
  });

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;

export const isPortError = (value: unknown): value is PortError => {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'capability,code,context,message,operation') return false;
  return (
    typeof value.capability === 'string' &&
    ['file-read', 'file-write', 'lock', 'process', 'git', 'http'].includes(value.capability) &&
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
