import { errorMessage, permissionDeniedError, safeErrorCode } from './errors.ts';

export type InventoryMode = 'dev' | 'pinned' | 'unmanaged';

export interface InventoryCancelledError {
  readonly code: 'cancelled';
  readonly message: 'inventory read cancelled';
}

export const INVENTORY_CANCELLED: InventoryCancelledError = Object.freeze({
  code: 'cancelled',
  message: 'inventory read cancelled',
});

export const throwIfInventoryCancelled = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw INVENTORY_CANCELLED;
};

/** Internal scanner metadata. It is deliberately non-enumerable and never enters wire DTOs. */
export const INVENTORY_ROOT_ORDINAL: unique symbol = Symbol('skillsmith.inventory-root-ordinal');

export type InventoryRootOrdinalCarrier = Readonly<{
  [INVENTORY_ROOT_ORDINAL]?: number;
}>;

export const inventoryRootOrdinalOf = (value: object): number =>
  (value as InventoryRootOrdinalCarrier)[INVENTORY_ROOT_ORDINAL] ?? 0;

export const tagInventoryRootOrdinal = <T extends object>(value: T, rootOrdinal: number): T => {
  if (!Number.isSafeInteger(rootOrdinal) || rootOrdinal < 0) {
    throw new TypeError('inventory root ordinal must be a non-negative safe integer');
  }
  Object.defineProperty(value, INVENTORY_ROOT_ORDINAL, {
    value: rootOrdinal,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return value;
};

/** Preserve ordinary read failures while giving OS permission failures their semantic exit class. */
export const rethrowInventoryReadFailure = (failure: unknown, path: string): never => {
  const code = safeErrorCode(failure);
  if (code === 'EACCES' || code === 'EPERM' || code === 'permission') {
    throw permissionDeniedError(errorMessage(failure), path);
  }
  throw failure;
};
