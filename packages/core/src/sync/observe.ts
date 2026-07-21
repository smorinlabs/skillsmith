import type { CurrentApplicationContext } from '../application/types.ts';
import { type ArtifactDigest, hashCanonicalInput } from '../artifacts/hash.ts';
import { classifyExport } from '../export/classify.ts';
import {
  type LiveFleetEntryObservation,
  type LiveFleetFailure,
  type LiveFleetObservation,
  observeLiveFleet,
} from '../export/observe.ts';
import type { ExportObservation } from '../export/observe.ts';
import type { ExportRequest, ExportResult, PortableExportCandidate } from '../export/types.ts';
import { type Result, err, ok } from '../result.ts';
import type {
  ObserveSyncFleetRequest,
  ResolvedSyncEndpoint,
  ResolvedSyncEndpoints,
  SyncEndpointObservation,
  SyncFleetObservation,
  SyncMemberObservation,
  SyncObservationFailure,
  SyncPortableObservation,
} from './types.ts';

const failure = (
  code: string,
  message: string,
  exitClass: SyncObservationFailure['exitClass'],
): Result<never, SyncObservationFailure> => err(Object.freeze({ code, message, exitClass }));

const failureFromLive = (side: 'source' | 'destination', value: LiveFleetFailure) =>
  failure(
    `sync-${side}-${value.code.slice('live-fleet-'.length)}`,
    `sync ${side} inventory could not be observed`,
    value.exitClass,
  );

const exportProjection = (fleet: LiveFleetObservation): ExportObservation =>
  Object.freeze({
    project: fleet.project,
    sourceProjectRoot: fleet.sourceProjectRoot,
    homeDir: fleet.homeDir,
    request: Object.freeze({
      tools: fleet.request.tools,
      explicitTools: true,
      scope: fleet.request.scope,
      explicitScope: true,
      strict: true,
      force: false,
      dryRun: true,
    }) satisfies ExportRequest,
    pair: null,
    inventory: fleet.inventory,
    entries: fleet.entries,
    ledger: fleet.ledger,
    ledgerPath: fleet.ledgerPath,
    manifest: null,
    lock: null,
  });

const isPortable = (result: ExportResult): result is PortableExportCandidate & ExportResult =>
  result.action !== 'skipped' && result.action !== 'conflict';

const portableFacts = (
  fleet: LiveFleetObservation,
  requested: boolean,
): Result<readonly SyncPortableObservation[], SyncObservationFailure> => {
  if (!requested) {
    return ok(Object.freeze(fleet.entries.map(() => Object.freeze({ outcome: 'not-requested' }))));
  }
  const classified = classifyExport(exportProjection(fleet));
  if (!classified.ok) {
    return failure(
      'sync-source-portable-state',
      classified.error.message,
      classified.error.exitClass,
    );
  }
  if (classified.value.results.length !== fleet.entries.length) {
    return failure(
      'sync-source-portable-invariant',
      'sync source portable classification is incomplete',
      'failure',
    );
  }
  return ok(
    Object.freeze(
      classified.value.results.map(
        (result): SyncPortableObservation =>
          isPortable(result)
            ? Object.freeze({ outcome: 'portable', candidate: result })
            : Object.freeze({ outcome: 'nonportable', result }),
      ),
    ),
  );
};

export const syncMembershipHashOf = (
  endpoint: ResolvedSyncEndpoint,
  entries: readonly Pick<SyncMemberObservation, 'entry'>[],
): ArtifactDigest => {
  const digest = hashCanonicalInput(
    'resource',
    1,
    JSON.stringify([
      'skillsmith-sync-membership',
      1,
      endpoint.identity,
      entries.map(({ entry }) => [
        entry.tool,
        entry.name,
        entry.scope,
        entry.root,
        entry.path,
        entry.realpath,
        entry.mode,
        entry.placement,
        entry.enabled,
        entry.visibility.state,
        entry.visibility.winner,
        entry.visibility.members.map(({ scope, path }) => [scope, path]),
      ]),
    ]),
  );
  if (!digest.ok) throw new TypeError('sync inventory membership could not be hashed');
  return digest.value as ArtifactDigest;
};

const memberFor = (
  fact: LiveFleetEntryObservation,
  portable: SyncPortableObservation,
): SyncMemberObservation =>
  Object.freeze({
    entry: fact.entry,
    ledgerPair: fact.ledgerPair,
    liveContentHash: fact.liveContentHash,
    pendingJournal: fact.pendingJournal,
    pendingTransactionIds: fact.pendingTransactionIds,
    defaultLocation: fact.defaultLocation,
    portable,
  });

const projectSide = (
  endpoint: ResolvedSyncEndpoint,
  fleet: LiveFleetObservation,
  portable: readonly SyncPortableObservation[],
): Result<SyncEndpointObservation, SyncObservationFailure> => {
  const entries = Object.freeze(
    fleet.entries.map((entry, index) => {
      const proof = portable[index];
      if (proof === undefined) throw new TypeError('sync portable fact is missing');
      return memberFor(entry, proof);
    }),
  );
  const unreadable = entries.some(
    ({ entry, liveContentHash }) =>
      (entry.visibility.state === 'unique' || entry.visibility.state === 'winner') &&
      liveContentHash === null,
  );
  if (unreadable) {
    return failure(
      `sync-${endpoint.role}-content-unavailable`,
      `sync ${endpoint.role} live content could not be read exactly`,
      'state',
    );
  }
  return ok(
    Object.freeze({
      endpoint,
      inventory: fleet.inventory,
      entries,
      membershipHash: syncMembershipHashOf(endpoint, entries),
      ledger: fleet.ledger,
      ledgerPath: fleet.ledgerPath,
    }),
  );
};

const sameLedgerSnapshot = (
  source: LiveFleetObservation['ledger'],
  destination: LiveFleetObservation['ledger'],
): boolean =>
  source.state === destination.state &&
  (source.state === 'absent' ||
    (destination.state === 'present' && source.byteRevision === destination.byteRevision));

export const observeSyncFleet = async (
  context: CurrentApplicationContext,
  endpoints: ResolvedSyncEndpoints,
  request: ObserveSyncFleetRequest,
): Promise<Result<SyncFleetObservation, SyncObservationFailure>> => {
  const [source, destination] = await Promise.all([
    observeLiveFleet(context, endpoints.from.project, {
      tools: endpoints.tools,
      scope: endpoints.from.scope,
      liveContent: 'all-members',
      portableProof: request.portableProof,
    }),
    observeLiveFleet(context, endpoints.to.project, {
      tools: endpoints.tools,
      scope: endpoints.to.scope,
      liveContent: 'all-members',
      portableProof: 'none',
    }),
  ]);
  if (!source.ok) return failureFromLive('source', source.error);
  if (!destination.ok) return failureFromLive('destination', destination.error);
  if (!sameLedgerSnapshot(source.value.ledger, destination.value.ledger)) {
    return failure(
      'sync-ledger-snapshot-drift',
      'sync placement ledger changed during observation',
      'state',
    );
  }

  const sourcePortable = portableFacts(source.value, request.portableProof === 'exact');
  if (!sourcePortable.ok) return sourcePortable;
  const destinationPortable = portableFacts(destination.value, false);
  if (!destinationPortable.ok) return destinationPortable;
  const projectedSource = projectSide(endpoints.from, source.value, sourcePortable.value);
  if (!projectedSource.ok) return projectedSource;
  const projectedDestination = projectSide(
    endpoints.to,
    destination.value,
    destinationPortable.value,
  );
  if (!projectedDestination.ok) return projectedDestination;

  const sourcePaths = new Set(
    projectedSource.value.entries
      .filter(({ entry }) => entry.visibility.state !== 'shadowed')
      .map(({ entry }) => entry.realpath),
  );
  if (
    projectedDestination.value.entries.some(
      ({ entry }) => entry.visibility.state !== 'shadowed' && sourcePaths.has(entry.realpath),
    )
  ) {
    return failure(
      'sync-live-member-alias',
      'sync source and destination inventories share a live member',
      'usage',
    );
  }

  return ok(
    Object.freeze({
      endpoints,
      portableProof: request.portableProof,
      source: projectedSource.value,
      destination: projectedDestination.value,
    }),
  );
};
