import { fromLedgerV1Dto } from '../../../src/artifacts/registry.ts';
import type { LedgerModel } from '../../../src/artifacts/ledger-types.ts';
import type { LedgerFile } from '../../../src/place/types.ts';

/** Convert a synthetic schema-v1 fixture into the complete canonical model required by writers. */
export const canonicalFixtureLedger = (ledger: LedgerFile): LedgerModel => {
  const canonical = fromLedgerV1Dto(ledger);
  if (!canonical.ok) {
    throw new Error(`legacy fixture ledger is invalid: ${canonical.error.reason}`);
  }
  return canonical.value;
};
