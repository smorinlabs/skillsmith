import type { CurrentApplicationContext } from '../application/types.ts';
import type { LedgerReadState } from '../artifacts/ledger-types.ts';
import { type PreparedLedgerMigration, prepareLedgerMigration } from '../place/ledger-migration.ts';
import type { PreparedExportArtifacts } from './merge.ts';
import type { ExportObservation } from './observe.ts';

export { prepareExportArtifacts } from './merge.ts';
export { previewExportEffects } from './run.ts';

const ledgerStateOf = (observation: ExportObservation): LedgerReadState => {
  const ledger = observation.ledger;
  if (ledger.state === 'absent') {
    return Object.freeze({
      state: 'absent',
      sourceVersion: null,
      bytes: null,
      byteRevision: null,
      semanticRevision: null,
      model: null,
    });
  }
  if (
    (ledger.sourceVersion !== 1 && ledger.sourceVersion !== 2) ||
    ledger.semanticRevision === null
  ) {
    throw new TypeError('observed export ledger is not a supported placement ledger');
  }
  return Object.freeze({
    state: 'present',
    sourceVersion: ledger.sourceVersion,
    bytes: new TextEncoder().encode(ledger.source),
    byteRevision: ledger.byteRevision,
    semanticRevision: ledger.semanticRevision,
    model: ledger.model,
  });
};

export const prepareExportLedgerMigration = (
  context: CurrentApplicationContext,
  observation: ExportObservation,
  artifacts: PreparedExportArtifacts,
): PreparedLedgerMigration | null => {
  if (!artifacts.manifestChanged && !artifacts.lockChanged) return null;
  return prepareLedgerMigration(
    context.ports,
    'export',
    'bounded-default',
    observation.ledgerPath,
    ledgerStateOf(observation),
  );
};
