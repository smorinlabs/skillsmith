import {
  type artifactContractRegistry,
  planProjectConfigMigration,
  readJournalArtifact,
  readLedgerArtifact,
  readLockArtifact,
  readManifestArtifact,
  readSavedPlanArtifact,
} from '@skillsmith/core';
import type * as publicCore from '@skillsmith/core';
import type {
  ArtifactAbsent,
  ArtifactReadEnvelope,
  ArtifactReadResult,
  LedgerModel,
  LogicalJournalV1,
  ProjectConfigMigration,
  SavedPlanV1,
} from '@skillsmith/core';
// @ts-expect-error persisted DTOs are available only from versioned contract subpaths.
import type { LedgerV1Dto as ForbiddenRootLedgerV1Dto } from '@skillsmith/core';
import type {
  ArtifactCodec,
  ArtifactCodecDescriptor,
  ArtifactCodecError,
  ArtifactContractRegistry,
} from '@skillsmith/core/contracts';
import {
  fromJournalV1Dto,
  fromLedgerV1Dto,
  journalV1Codec,
  ledgerV1Codec,
  lockV1Codec,
  manifestV1Codec,
  savedPlanV1Codec,
  toJournalV1Dto,
  toLedgerV1Dto,
} from '@skillsmith/core/contracts/v1';
import type {
  JournalV1Dto,
  LedgerV1Dto,
  LockV1Dto,
  ManifestV1Dto,
  SavedPlanV1Dto,
} from '@skillsmith/core/contracts/v1';
import {
  fromLedgerV2Dto,
  ledgerV2Codec,
  migrateLedgerV1DtoToV2Dto,
  toLedgerV2Dto,
} from '@skillsmith/core/contracts/v2';
import type { LedgerMigrationV1ToV2, LedgerV2Dto } from '@skillsmith/core/contracts/v2';

type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type IsAny<T> = 0 extends 1 & T ? true : false;
type NotAny<T> = IsAny<T> extends true ? false : true;

type _Registry = Assert<Equal<typeof artifactContractRegistry, ArtifactContractRegistry>>;
type _DescriptorPresentation = Assert<
  Equal<
    ArtifactCodecDescriptor['presentation'],
    Readonly<{
      decode: 'human' | 'canonical';
      encode: 'canonical' | 'compatibility';
    }>
  >
>;
type _CodecErrorCode = Assert<Equal<ArtifactCodecError['code'], 'artifact-codec'>>;
type _CodecErrorExit = Assert<Equal<ArtifactCodecError['exitCode'], 3>>;
type _AbsentKeys = Assert<Equal<keyof ArtifactAbsent, 'state' | 'artifact' | 'migration'>>;
type _EnvelopeOwnedSource = Assert<Equal<ArtifactReadEnvelope<unknown>['source'], string>>;
type _ReadResult = Assert<
  Equal<ArtifactReadResult<LedgerModel>, ArtifactAbsent | ArtifactReadEnvelope<LedgerModel>>
>;

type _ProjectMigrationKeys = Assert<
  Equal<
    keyof ProjectConfigMigration,
    | 'kind'
    | 'from'
    | 'toVersion'
    | 'expectedByteRevision'
    | 'expectedSemanticRevision'
    | 'resultByteRevision'
    | 'resultSemanticRevision'
    | 'resultSource'
    | 'createsLockfile'
  >
>;
type _ProjectNoPath = Assert<
  Equal<'path' extends keyof ProjectConfigMigration ? true : false, false>
>;
type _ProjectNoCallerMode = Assert<
  Equal<'callerMode' extends keyof ProjectConfigMigration ? true : false, false>
>;
type _ProjectNoLock = Assert<Equal<ProjectConfigMigration['createsLockfile'], false>>;

type _LedgerMigrationKeys = Assert<
  Equal<
    keyof LedgerMigrationV1ToV2,
    | 'kind'
    | 'fromSchemaVersion'
    | 'toSchemaVersion'
    | 'sourceByteRevision'
    | 'sourceSemanticRevision'
    | 'targetSemanticRevision'
    | 'targetByteRevision'
    | 'targetCanonicalSource'
    | 'preservedLegacyJournals'
  >
>;
type _LedgerNoAuthority = Assert<
  Equal<'write' extends keyof LedgerMigrationV1ToV2 ? true : false, false>
>;
type _LedgerV1Version = Assert<Equal<LedgerV1Dto['schemaVersion'], 1>>;
type _LedgerV2Version = Assert<Equal<LedgerV2Dto['schemaVersion'], 2>>;
type _JournalVersion = Assert<Equal<JournalV1Dto['schemaVersion'], 1>>;
type _JournalKind = Assert<Equal<JournalV1Dto['kind'], 'skillsmith.transaction-journal'>>;
type _NoPrivateCursor = Assert<Equal<'cursor' extends keyof JournalV1Dto ? true : false, false>>;
type _NoPrivateObjects = Assert<Equal<'objects' extends keyof JournalV1Dto ? true : false, false>>;
type _NoExecuteAtRoot = Assert<
  Equal<'executeProjectConfigMigration' extends keyof typeof publicCore ? true : false, false>
>;
type _NoPersistedDtoAtRoot = Assert<
  Equal<'LedgerV1Dto' extends keyof typeof publicCore ? true : false, false>
>;
type _ForbiddenRootDtoIsUnavailable = Assert<IsAny<ForbiddenRootLedgerV1Dto>>;
type _ModelsNotAny = Assert<
  NotAny<
    | ManifestV1Dto
    | LockV1Dto
    | SavedPlanV1Dto
    | LedgerV1Dto
    | LedgerV2Dto
    | JournalV1Dto
    | LedgerModel
    | SavedPlanV1
    | LogicalJournalV1
  >
>;

const _manifestCodec: ArtifactCodec<
  'manifest',
  1,
  ManifestV1Dto,
  Parameters<typeof manifestV1Codec.toDto>[0]
> = manifestV1Codec;
const _lockCodec: ArtifactCodec<'lock', 1, LockV1Dto, Parameters<typeof lockV1Codec.toDto>[0]> =
  lockV1Codec;
const _planCodec: ArtifactCodec<'plan', 1, SavedPlanV1Dto, SavedPlanV1> = savedPlanV1Codec;
const _ledger1Codec: ArtifactCodec<'ledger', 1, LedgerV1Dto, LedgerModel> = ledgerV1Codec;
const _ledger2Codec: ArtifactCodec<'ledger', 2, LedgerV2Dto, LedgerModel> = ledgerV2Codec;
const _journalCodec: ArtifactCodec<'journal', 1, JournalV1Dto, LogicalJournalV1> = journalV1Codec;

const _planner: typeof planProjectConfigMigration = planProjectConfigMigration;
const _reads = [
  readManifestArtifact,
  readLockArtifact,
  readSavedPlanArtifact,
  readLedgerArtifact,
  readJournalArtifact,
] as const;
const _mappers = [
  toLedgerV1Dto,
  fromLedgerV1Dto,
  toLedgerV2Dto,
  fromLedgerV2Dto,
  migrateLedgerV1DtoToV2Dto,
  toJournalV1Dto,
  fromJournalV1Dto,
] as const;

void [
  _manifestCodec,
  _lockCodec,
  _planCodec,
  _ledger1Codec,
  _ledger2Codec,
  _journalCodec,
  _planner,
  _reads,
  _mappers,
];
