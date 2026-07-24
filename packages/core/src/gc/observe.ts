import type { LedgerReadState } from '../artifacts/ledger-types.ts';
import { readLedgerState } from '../place/ledger.ts';
import type { FileMetadataReadPort, FileReadPort } from '../ports/types.ts';
import { type GcInventoryPorts, inventoryGcStore } from './inventory.ts';
import { observeGcRecovery } from './recovery.ts';
import { observeGcTombstones } from './repository.ts';
import type { GcInventory, GcRecoveryObservation } from './types.ts';

export interface GcObservation {
  readonly ledger: LedgerReadState;
  readonly inventory: GcInventory;
  readonly recovery: GcRecoveryObservation;
  readonly tombstones: Readonly<{ readonly state: 'safe'; readonly root: string }>;
}

type ObservationPorts = GcInventoryPorts &
  FileMetadataReadPort &
  Pick<FileReadPort, 'fileExists' | 'pathKind' | 'readBytes' | 'readText'> &
  Parameters<typeof observeGcRecovery>[0];

export const observeGcState = async (
  ports: ObservationPorts,
  input: Readonly<{
    readonly dataDir: string;
    readonly ledgerPath: string;
    readonly storeRoot: string;
  }>,
): Promise<GcObservation | Readonly<{ readonly error: string }>> => {
  const recovery = await observeGcRecovery(ports, input.dataDir);
  if (recovery.state === 'refused') return Object.freeze({ error: recovery.reason });
  const tombstones = await observeGcTombstones(ports, input.storeRoot);
  if (tombstones.state === 'refused') return Object.freeze({ error: tombstones.reason });
  const ledger = await readLedgerState(ports, input.ledgerPath);
  if (!ledger.ok) {
    const message = 'message' in ledger.error ? ledger.error.message : ledger.error.code;
    return Object.freeze({ error: message });
  }
  const inventory = await inventoryGcStore(ports, input.storeRoot);
  return Object.freeze({ ledger: ledger.value, inventory, recovery, tombstones });
};
