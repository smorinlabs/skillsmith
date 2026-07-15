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
