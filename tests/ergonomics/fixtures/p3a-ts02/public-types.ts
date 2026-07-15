import type {
  FileMetadataReadPort,
  InventoryReadPorts,
  StatusEntry,
  StatusFact,
  StatusJournalState,
  StatusPlacement,
  StatusReadError,
  StatusReadPorts,
  StatusReadRequest,
  StatusReport,
  StatusRetentionRequirement,
} from '@skillsmith/core';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type Expect<T extends true> = T;

type _FocusedReadBoundary = Expect<
  Equal<StatusReadPorts, InventoryReadPorts & FileMetadataReadPort>
>;
type _ClosedStatusCode = Expect<Equal<StatusReadError['code'], 'status-read'>>;
type _RequestIsReadonly = Expect<Equal<StatusReadRequest, Readonly<StatusReadRequest>>>;

declare const report: StatusReport;
declare const entry: StatusEntry;
declare const placement: StatusPlacement;
declare const fact: StatusFact;
declare const journal: StatusJournalState;
declare const retention: StatusRetentionRequirement;

void [report, entry, placement, fact, journal, retention];
