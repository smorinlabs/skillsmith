import {
  artifactContractRegistry,
  planProjectConfigMigration,
  readJournalArtifact,
  readLedgerArtifact,
  readLockArtifact,
  readManifestArtifact,
  readSavedPlanArtifact,
} from '@skillsmith/core';
import type {
  AgentsReport,
  ArtifactAbsent,
  ArtifactReadEnvelope,
  ArtifactRepositoryError,
  CommandsReport,
  LedgerModel,
  ListReport,
  LogicalJournalV1,
  NormalizedManifestV1,
  PortableLockV1,
  ProjectConfigMigration,
  SavedPlanV1,
} from '@skillsmith/core';
import type {
  ArtifactCodec,
  ArtifactCodecDescriptor,
  ArtifactCodecError,
  ArtifactContractRegistry,
  ArtifactId,
  DecodedArtifact,
  WireCodec,
} from '@skillsmith/core/contracts';
import {
  fromJournalV1Dto,
  fromLedgerV1Dto,
  fromLockV1Dto,
  fromManifestV1Dto,
  fromSavedPlanV1Dto,
  journalV1Codec,
  ledgerV1Codec,
  lockV1Codec,
  manifestV1Codec,
  savedPlanV1Codec,
  statusV1Codec,
  toJournalV1Dto,
  toLedgerV1Dto,
  toLockV1Dto,
  toManifestV1Dto,
  toSavedPlanV1Dto,
  type toStatusV1Dto,
} from '@skillsmith/core/contracts/v1';
import type {
  JournalV1Dto,
  LedgerV1Dto,
  LockV1Dto,
  ManifestV1Dto,
  SavedPlanV1Dto,
  StatusV1Dto,
} from '@skillsmith/core/contracts/v1';
import {
  agentsV2Codec,
  commandsV2Codec,
  fromLedgerV2Dto,
  ledgerV2Codec,
  migrateLedgerV1DtoToV2Dto,
  toAgentsV2Dto,
  toCommandsV2Dto,
  toLedgerV2Dto,
} from '@skillsmith/core/contracts/v2';
import type {
  AgentsV2Dto,
  CommandsV2Dto,
  LedgerMigrationV1ToV2,
  LedgerV2Dto,
} from '@skillsmith/core/contracts/v2';
import { listV3Codec, toListV3Dto } from '@skillsmith/core/contracts/v3';
import type { ListV3Dto } from '@skillsmith/core/contracts/v3';

type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false;
type Not<T extends boolean> = T extends true ? false : true;
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
type ContractsRootRuntime = typeof import('@skillsmith/core/contracts');
type V1Runtime = typeof import('@skillsmith/core/contracts/v1');
type V2Runtime = typeof import('@skillsmith/core/contracts/v2');
type V3Runtime = typeof import('@skillsmith/core/contracts/v3');

type _ContractsRuntimeClosed = Assert<
  Equal<keyof ContractsRootRuntime, 'createWireContractRegistry'>
>;
type _V1RuntimeClosed = Assert<
  Equal<
    keyof V1Runtime,
    | 'agentsV1Codec'
    | 'capabilitySnapshotV1Codec'
    | 'commandsV1Codec'
    | 'configGetV1Codec'
    | 'configListV1Codec'
    | 'configSetV1Codec'
    | 'configUnsetV1Codec'
    | 'createVerifyV1Codec'
    | 'errorV1Codec'
    | 'healthV1Codec'
    | 'installV1Codec'
    | 'statusV1Codec'
    | 'toAgentsV1Dto'
    | 'toCapabilitySnapshotV1Dto'
    | 'toCommandsV1Dto'
    | 'toConfigGetV1Dto'
    | 'toConfigListV1Dto'
    | 'toConfigSetV1Dto'
    | 'toConfigUnsetV1Dto'
    | 'toErrorV1Dto'
    | 'toHealthV1Dto'
    | 'toInstallV1Dto'
    | 'toStatusV1Dto'
    | 'toUninstallV1Dto'
    | 'toVerifyV1Dto'
    | 'uninstallV1Codec'
    | 'verifyV1Codec'
    | 'manifestV1Codec'
    | 'toManifestV1Dto'
    | 'fromManifestV1Dto'
    | 'lockV1Codec'
    | 'toLockV1Dto'
    | 'fromLockV1Dto'
    | 'savedPlanV1Codec'
    | 'toSavedPlanV1Dto'
    | 'fromSavedPlanV1Dto'
    | 'ledgerV1Codec'
    | 'toLedgerV1Dto'
    | 'fromLedgerV1Dto'
    | 'journalV1Codec'
    | 'toJournalV1Dto'
    | 'fromJournalV1Dto'
  >
>;
type _V2RuntimeClosed = Assert<
  Equal<
    keyof V2Runtime,
    | 'agentsV2Codec'
    | 'commandsV2Codec'
    | 'flipV2Codec'
    | 'listV2Codec'
    | 'toFlipV2Dto'
    | 'toListV2Dto'
    | 'ledgerV2Codec'
    | 'toLedgerV2Dto'
    | 'fromLedgerV2Dto'
    | 'migrateLedgerV1DtoToV2Dto'
    | 'toAgentsV2Dto'
    | 'toCommandsV2Dto'
  >
>;
type _V3RuntimeClosed = Assert<Equal<keyof V3Runtime, 'listV3Codec' | 'toListV3Dto'>>;

type Descriptor = ArtifactCodecDescriptor<'manifest', 1>;
type _ArtifactIds = Assert<Equal<ArtifactId, 'manifest' | 'lock' | 'plan' | 'ledger' | 'journal'>>;
type _DescriptorKeys = Assert<
  Equal<
    keyof Descriptor,
    | 'id'
    | 'version'
    | 'syntax'
    | 'discriminator'
    | 'wireKind'
    | 'presentation'
    | 'terminalLf'
    | 'unknownFields'
    | 'migrations'
    | 'compatibility'
  >
>;
type _DescriptorIdentity = Assert<
  Equal<Pick<Descriptor, 'id' | 'version'>, { readonly id: 'manifest'; readonly version: 1 }>
>;
type _CodecKeys = Assert<
  Equal<keyof ArtifactCodec, 'descriptor' | 'validate' | 'fromDto' | 'toDto' | 'decode' | 'encode'>
>;
type _RegistryKeys = Assert<Equal<keyof ArtifactContractRegistry, 'codecs' | 'get' | 'latest'>>;
type _DecodedKeys = Assert<
  Equal<keyof DecodedArtifact, 'source' | 'model' | 'canonical' | 'migration'>
>;
type _CodecErrorKeys = Assert<
  Equal<
    keyof ArtifactCodecError,
    'code' | 'artifactId' | 'requestedVersion' | 'reason' | 'path' | 'exitCode' | 'message'
  >
>;
type _CodecErrorReasons = Assert<
  Equal<
    ArtifactCodecError['reason'],
    | 'malformed'
    | 'invalid-shape'
    | 'unsupported-version'
    | 'migration-failed'
    | 'noncanonical'
    | 'sensitive-content'
  >
>;

type _ManifestRoot = Assert<
  Equal<keyof ManifestV1Dto, 'version' | 'defaults' | 'registry' | 'skills'>
>;
type _PlanRoot = Assert<
  Equal<
    keyof SavedPlanV1Dto,
    | 'schemaVersion'
    | 'kind'
    | 'skillsmithVersion'
    | 'executorSchemaVersion'
    | 'hashSchemaVersion'
    | 'portability'
    | 'artifactPair'
    | 'manifestSemanticHash'
    | 'lockCanonicalHash'
    | 'options'
    | 'selection'
    | 'operations'
    | 'checks'
    | 'diagnostics'
    | 'resourcePreconditions'
    | 'selectionPreconditions'
    | 'capabilityPreconditions'
  >
>;
type _LedgerV1Root = Assert<
  Equal<keyof LedgerV1Dto, 'schemaVersion' | 'kind' | 'updatedAt' | 'skills' | 'projects'>
>;
type _LedgerV2Root = Assert<
  Equal<
    keyof LedgerV2Dto,
    | 'schemaVersion'
    | 'kind'
    | 'updatedAt'
    | 'skills'
    | 'projects'
    | 'projectRegistrations'
    | 'transactions'
    | 'history'
  >
>;
type _JournalRoot = Assert<
  Equal<
    keyof JournalV1Dto,
    | 'schemaVersion'
    | 'kind'
    | 'transactionId'
    | 'intent'
    | 'context'
    | 'disposition'
    | 'phase'
    | 'actual'
    | 'updatedAt'
    | 'completedAt'
  >
>;
type _StatusTopLevelKeys = Assert<
  Equal<
    keyof StatusV1Dto,
    | 'schemaVersion'
    | 'kind'
    | 'selection'
    | 'context'
    | 'artifacts'
    | 'ledger'
    | 'journals'
    | 'facts'
    | 'entries'
    | 'summary'
  >
>;
type _StatusExcludesRepositoryInternals = Assert<
  Not<HasKey<StatusV1Dto['entries'][number], 'error' | 'journal' | 'updatedAt'>>
>;
type _JournalIntentKeys = Assert<
  Equal<
    keyof JournalV1Dto['intent'],
    | 'operationId'
    | 'groupId'
    | 'pairId'
    | 'kind'
    | 'skill'
    | 'source'
    | 'tool'
    | 'scope'
    | 'before'
    | 'after'
    | 'mutates'
    | 'reversibility'
    | 'conflict'
  >
>;
type _JournalContextKeys = Assert<
  Equal<
    keyof JournalV1Dto['context'],
    'parentOperationId' | 'command' | 'workflow' | 'attempt' | 'startedAt'
  >
>;
type _JournalActualKeys = Assert<
  Equal<keyof JournalV1Dto['actual'], 'before' | 'after' | 'retained'>
>;
type JournalActualState = JournalV1Dto['actual']['before'][number];
type JournalRetainedState = JournalV1Dto['actual']['retained'][number];
type JournalLiveKeys =
  | 'resourceId'
  | 'role'
  | 'state'
  | 'repositoryRevision'
  | 'placementPath'
  | 'liveKind'
  | 'mode'
  | 'symlinkTarget'
  | 'contentHash';
type JournalManifestKeys =
  | 'resourceId'
  | 'role'
  | 'state'
  | 'repositoryRevision'
  | 'location'
  | 'shape'
  | 'version'
  | 'byteHash'
  | 'semanticHash';
type JournalLockKeys =
  | 'resourceId'
  | 'role'
  | 'state'
  | 'repositoryRevision'
  | 'location'
  | 'version'
  | 'canonicalHash';
type JournalLedgerKeys =
  | 'resourceId'
  | 'role'
  | 'state'
  | 'repositoryRevision'
  | 'schemaVersion'
  | 'semanticHash';
type _JournalAbsentLiveKeys = Assert<
  Equal<keyof Extract<JournalActualState, { role: 'live'; state: 'absent' }>, JournalLiveKeys>
>;
type _JournalPresentLiveKeys = Assert<
  Equal<keyof Extract<JournalActualState, { role: 'live'; state: 'present' }>, JournalLiveKeys>
>;
type _JournalAbsentManifestKeys = Assert<
  Equal<
    keyof Extract<JournalActualState, { role: 'manifest'; state: 'absent' }>,
    JournalManifestKeys
  >
>;
type _JournalLegacyManifestKeys = Assert<
  Equal<
    keyof Extract<JournalActualState, { role: 'manifest'; state: 'present'; shape: 'legacy' }>,
    JournalManifestKeys
  >
>;
type _JournalCanonicalManifestKeys = Assert<
  Equal<
    keyof Extract<JournalActualState, { role: 'manifest'; state: 'present'; shape: 'canonical' }>,
    JournalManifestKeys
  >
>;
type _JournalAbsentLockKeys = Assert<
  Equal<keyof Extract<JournalActualState, { role: 'lock'; state: 'absent' }>, JournalLockKeys>
>;
type _JournalPresentLockKeys = Assert<
  Equal<keyof Extract<JournalActualState, { role: 'lock'; state: 'present' }>, JournalLockKeys>
>;
type _JournalAbsentLedgerKeys = Assert<
  Equal<keyof Extract<JournalActualState, { role: 'ledger'; state: 'absent' }>, JournalLedgerKeys>
>;
type _JournalPresentLedgerKeys = Assert<
  Equal<keyof Extract<JournalActualState, { role: 'ledger'; state: 'present' }>, JournalLedgerKeys>
>;
type _JournalBackupRetainedKeys = Assert<
  Equal<
    keyof Extract<JournalRetainedState, { role: 'backup' }>,
    | 'resourceId'
    | 'role'
    | 'sourceRole'
    | 'path'
    | 'repositoryRevision'
    | 'contentHash'
    | 'retainUntil'
  >
>;
type _JournalStoreRetainedKeys = Assert<
  Equal<
    keyof Extract<JournalRetainedState, { role: 'store' }>,
    'resourceId' | 'role' | 'path' | 'repositoryRevision' | 'contentHash' | 'retainUntil'
  >
>;
type _JournalHasNoPhysicalCursor = Assert<Not<HasKey<JournalV1Dto, 'recoveryCursor'>>>;
type _JournalHasNoPrivateRecord = Assert<Not<HasKey<JournalV1Dto, 'recoveryRecord'>>>;
type _JournalContextHasNoCursor = Assert<Not<HasKey<JournalV1Dto['context'], 'recoveryCursor'>>>;
type _JournalContextHasNoStaging = Assert<Not<HasKey<JournalV1Dto['context'], 'stagingPath'>>>;
type _JournalContextHasNoBackup = Assert<Not<HasKey<JournalV1Dto['context'], 'backupPath'>>>;
type _JournalContextHasNoBarrier = Assert<
  Not<HasKey<JournalV1Dto['context'], 'barrierTranscript'>>
>;
type _JournalActualHasNoRecordRevision = Assert<
  Not<HasKey<JournalV1Dto['actual'], 'recordRevision'>>
>;
type _ReadEnvelopeHasNoRawBytes = Assert<Not<HasKey<ArtifactReadEnvelope<unknown>, 'rawBytes'>>>;
type _MigrationHasNoWriteAuthority = Assert<Not<HasKey<LedgerMigrationV1ToV2, 'write'>>>;

// @ts-expect-error schema implementations are internal
type _NoSchema = Descriptor['schema'];
// @ts-expect-error parser implementations are internal
type _NoParser = Descriptor['parser'];
// @ts-expect-error migration handlers are internal
type _NoMigrationHandler = Descriptor['migrate'];
// @ts-expect-error decoded results do not expose raw bytes
type _NoDecodedBytes = DecodedArtifact['bytes'];
// @ts-expect-error physical recovery cursors are excluded from logical journals
type _NoRecoveryCursor = JournalV1Dto['cursor'];
// @ts-expect-error private staging paths are excluded from logical journal context
type _NoNestedStagingPath = JournalV1Dto['context']['stagingPath'];
// @ts-expect-error private artifact record revisions are excluded from logical journal actual state
type _NoNestedRecordRevision = JournalV1Dto['actual']['recordRevision'];

const _registry: ArtifactContractRegistry = artifactContractRegistry;
const _manifestCodec: ArtifactCodec<'manifest', 1, ManifestV1Dto, NormalizedManifestV1> =
  manifestV1Codec;
const _lockCodec: ArtifactCodec<'lock', 1, LockV1Dto, PortableLockV1> = lockV1Codec;
const _planCodec: ArtifactCodec<'plan', 1, SavedPlanV1Dto, SavedPlanV1> = savedPlanV1Codec;
const _ledgerV1Codec: ArtifactCodec<'ledger', 1, LedgerV1Dto, LedgerModel> = ledgerV1Codec;
const _ledgerV2Codec: ArtifactCodec<'ledger', 2, LedgerV2Dto, LedgerModel> = ledgerV2Codec;
const _journalCodec: ArtifactCodec<'journal', 1, JournalV1Dto, LogicalJournalV1> = journalV1Codec;
const _statusCodec: WireCodec<'status', 1, StatusV1Dto> = statusV1Codec;
const _agentsV2Codec: WireCodec<'agents', 2, AgentsV2Dto> = agentsV2Codec;
const _commandsV2Codec: WireCodec<'commands', 2, CommandsV2Dto> = commandsV2Codec;
const _listV3Codec: WireCodec<'list', 3, ListV3Dto> = listV3Codec;

const _manifestMapper: (value: NormalizedManifestV1) => Result<ManifestV1Dto, ArtifactCodecError> =
  toManifestV1Dto;
const _manifestReverse: (value: ManifestV1Dto) => Result<NormalizedManifestV1, ArtifactCodecError> =
  fromManifestV1Dto;
const _lockMapper: (value: PortableLockV1) => Result<LockV1Dto, ArtifactCodecError> = toLockV1Dto;
const _lockReverse: (value: LockV1Dto) => Result<PortableLockV1, ArtifactCodecError> =
  fromLockV1Dto;
const _planMapper: (value: SavedPlanV1) => Result<SavedPlanV1Dto, ArtifactCodecError> =
  toSavedPlanV1Dto;
const _planReverse: (value: SavedPlanV1Dto) => Result<SavedPlanV1, ArtifactCodecError> =
  fromSavedPlanV1Dto;
const _ledgerV1Mapper: (value: LedgerModel) => Result<LedgerV1Dto, ArtifactCodecError> =
  toLedgerV1Dto;
const _ledgerV1Reverse: (value: LedgerV1Dto) => Result<LedgerModel, ArtifactCodecError> =
  fromLedgerV1Dto;
const _ledgerV2Mapper: (value: LedgerModel) => Result<LedgerV2Dto, ArtifactCodecError> =
  toLedgerV2Dto;
const _ledgerV2Reverse: (value: LedgerV2Dto) => Result<LedgerModel, ArtifactCodecError> =
  fromLedgerV2Dto;
const _journalMapper: (value: LogicalJournalV1) => Result<JournalV1Dto, ArtifactCodecError> =
  toJournalV1Dto;
const _journalReverse: (value: JournalV1Dto) => Result<LogicalJournalV1, ArtifactCodecError> =
  fromJournalV1Dto;
type _StatusMapperReturn = Assert<Equal<ReturnType<typeof toStatusV1Dto>, StatusV1Dto>>;
const _agentsV2Mapper: (value: AgentsReport) => AgentsV2Dto = toAgentsV2Dto;
const _commandsV2Mapper: (value: CommandsReport) => CommandsV2Dto = toCommandsV2Dto;
const _listV3Mapper: (value: ListReport) => ListV3Dto = toListV3Dto;
const _ledgerMigration: (value: LedgerV1Dto) => Result<LedgerV2Dto, ArtifactCodecError> =
  migrateLedgerV1DtoToV2Dto;

type ReadResult<T> = Promise<
  Result<ArtifactAbsent | ArtifactReadEnvelope<T>, ArtifactRepositoryError>
>;
declare const ports: Parameters<typeof readManifestArtifact>[0];
const _readManifest: ReadResult<NormalizedManifestV1> = readManifestArtifact(ports, 'skills.toml');
const _readLock: ReadResult<PortableLockV1> = readLockArtifact(ports, 'skills.lock');
const _readPlan: ReadResult<SavedPlanV1> = readSavedPlanArtifact(ports, 'plan.json');
const _readLedger: ReadResult<LedgerModel> = readLedgerArtifact(ports, 'placements.json');
const _readJournal: ReadResult<LogicalJournalV1> = readJournalArtifact(ports, 'journal.json');
const _migrationPlan: Result<ProjectConfigMigration, ArtifactRepositoryError> =
  planProjectConfigMigration('tool = "codex"\n');

void [
  _registry,
  _manifestCodec,
  _lockCodec,
  _planCodec,
  _ledgerV1Codec,
  _ledgerV2Codec,
  _journalCodec,
  _statusCodec,
  _agentsV2Codec,
  _commandsV2Codec,
  _listV3Codec,
  _manifestMapper,
  _manifestReverse,
  _lockMapper,
  _lockReverse,
  _planMapper,
  _planReverse,
  _ledgerV1Mapper,
  _ledgerV1Reverse,
  _ledgerV2Mapper,
  _ledgerV2Reverse,
  _journalMapper,
  _journalReverse,
  _agentsV2Mapper,
  _commandsV2Mapper,
  _listV3Mapper,
  _ledgerMigration,
  _readManifest,
  _readLock,
  _readPlan,
  _readLedger,
  _readJournal,
  _migrationPlan,
];
