import {
  type WireCodec,
  type WireCodecDescriptor,
  type WireCodecError,
  type WireContractMapping,
  type WireContractRegistry,
  createWireContractRegistry,
} from '@skillsmith/core/contracts';
import {
  type AgentsV1Dto,
  type ApplyReportV1Dto,
  type CapabilitySnapshotV1Dto,
  type CommandsV1Dto,
  type ConfigGetV1Dto,
  type ConfigListV1Dto,
  type ConfigSetV1Dto,
  type ConfigUnsetV1Dto,
  type ErrorV1Dto,
  type GcReportV1Dto,
  type HealthV1Dto,
  type InitV1Dto,
  type InstallV1Dto,
  type PlanV1Dto,
  type StatusV1Dto,
  type SyncReportV1Dto,
  type UndoReportV1Dto,
  type UninstallV1Dto,
  type UpdateReportV1Dto,
  type VerifyV1Dto,
  agentsV1Codec,
  applyV1Codec,
  capabilitySnapshotV1Codec,
  commandsV1Codec,
  configGetV1Codec,
  configListV1Codec,
  configSetV1Codec,
  configUnsetV1Codec,
  createVerifyV1Codec,
  errorV1Codec,
  type gcV1Codec,
  healthV1Codec,
  initV1Codec,
  installV1Codec,
  type planV1Codec,
  statusV1Codec,
  type syncV1Codec,
  toAgentsV1Dto,
  toCapabilitySnapshotV1Dto,
  toCommandsV1Dto,
  toConfigGetV1Dto,
  toConfigListV1Dto,
  toConfigSetV1Dto,
  toConfigUnsetV1Dto,
  toErrorV1Dto,
  toHealthV1Dto,
  toInitV1Dto,
  toInstallV1Dto,
  toStatusV1Dto,
  toUndoV1Dto,
  toUninstallV1Dto,
  toVerifyV1Dto,
  undoV1Codec,
  uninstallV1Codec,
  type updateV1Codec,
  verifyV1Codec,
} from '@skillsmith/core/contracts/v1';
import {
  type AgentsV2Dto,
  type CommandsV2Dto,
  type FlipV2Dto,
  type HealthV2Dto,
  type InstallV2Dto,
  type ListV2Dto,
  type UninstallV2Dto,
  agentsV2Codec,
  commandsV2Codec,
  flipV2Codec,
  healthV2Codec,
  installV2Codec,
  listV2Codec,
  toAgentsV2Dto,
  toCommandsV2Dto,
  toFlipV2Dto,
  toHealthV2Dto,
  toInstallV2Dto,
  toListV2Dto,
  toUninstallV2Dto,
  uninstallV2Codec,
} from '@skillsmith/core/contracts/v2';
import {
  type FlipV3Dto,
  type ListV3Dto,
  flipV3Codec,
  listV3Codec,
  toFlipV3Dto,
  toListV3Dto,
} from '@skillsmith/core/contracts/v3';

// @ts-expect-error contracts root owns shared types only, never versioned DTOs or codecs
import type { AgentsV1Dto as ForbiddenV1FromRoot } from '@skillsmith/core/contracts';
// @ts-expect-error contracts root owns shared types only, never versioned DTOs or codecs
import type { FlipV2Dto as ForbiddenV2FromRoot } from '@skillsmith/core/contracts';
// @ts-expect-error v1 entry point must expose no v2 DTOs
import type { FlipV2Dto as ForbiddenFlipDtoFromV1 } from '@skillsmith/core/contracts/v1';
// @ts-expect-error v1 entry point must expose no v2 DTOs
import type { ListV2Dto as ForbiddenListDtoFromV1 } from '@skillsmith/core/contracts/v1';
// @ts-expect-error v1 entry point must expose no v2 DTOs
import type { InstallV2Dto as ForbiddenInstallV2DtoFromV1 } from '@skillsmith/core/contracts/v1';
// @ts-expect-error v1 entry point must expose no v2 DTOs
import type { UninstallV2Dto as ForbiddenUninstallV2DtoFromV1 } from '@skillsmith/core/contracts/v1';
// @ts-expect-error v2 entry point must expose no v1 DTOs
import type { AgentsV1Dto as ForbiddenAgentsDtoFromV2 } from '@skillsmith/core/contracts/v2';
// @ts-expect-error v2 entry point must expose no v1 DTOs
import type { CapabilitySnapshotV1Dto as ForbiddenCapabilityDtoFromV2 } from '@skillsmith/core/contracts/v2';
// @ts-expect-error v2 entry point must expose no v1 DTOs
import type { CommandsV1Dto as ForbiddenCommandsDtoFromV2 } from '@skillsmith/core/contracts/v2';
// @ts-expect-error v2 entry point must expose no v1 DTOs
import type { ConfigGetV1Dto as ForbiddenConfigGetDtoFromV2 } from '@skillsmith/core/contracts/v2';
// @ts-expect-error v2 entry point must expose no v1 DTOs
import type { ConfigListV1Dto as ForbiddenConfigListDtoFromV2 } from '@skillsmith/core/contracts/v2';
// @ts-expect-error v2 entry point must expose no v1 DTOs
import type { ConfigSetV1Dto as ForbiddenConfigSetDtoFromV2 } from '@skillsmith/core/contracts/v2';
// @ts-expect-error v2 entry point must expose no v1 DTOs
import type { ConfigUnsetV1Dto as ForbiddenConfigUnsetDtoFromV2 } from '@skillsmith/core/contracts/v2';
// @ts-expect-error v2 entry point must expose no v1 DTOs
import type { ErrorV1Dto as ForbiddenErrorDtoFromV2 } from '@skillsmith/core/contracts/v2';
// @ts-expect-error v2 entry point must expose no v1 DTOs
import type { HealthV1Dto as ForbiddenHealthDtoFromV2 } from '@skillsmith/core/contracts/v2';
// @ts-expect-error v2 entry point must expose no v1 DTOs
import type { InstallV1Dto as ForbiddenInstallDtoFromV2 } from '@skillsmith/core/contracts/v2';
// @ts-expect-error v2 entry point must expose no v1 DTOs
import type { UninstallV1Dto as ForbiddenUninstallDtoFromV2 } from '@skillsmith/core/contracts/v2';
// @ts-expect-error v2 entry point must expose no v1 DTOs
import type { UndoReportV1Dto as ForbiddenUndoDtoFromV2 } from '@skillsmith/core/contracts/v2';
// @ts-expect-error v2 entry point must expose no v1 DTOs
import type { VerifyV1Dto as ForbiddenVerifyDtoFromV2 } from '@skillsmith/core/contracts/v2';
// @ts-expect-error v2 entry point must expose no v1 DTOs
import type { StatusV1Dto as ForbiddenStatusDtoFromV2 } from '@skillsmith/core/contracts/v2';
// @ts-expect-error v2 entry point must expose no v1 DTOs
import type { InitV1Dto as ForbiddenInitDtoFromV2 } from '@skillsmith/core/contracts/v2';
// @ts-expect-error v2 entry point must expose no v3 DTOs
import type { ListV3Dto as ForbiddenListDtoFromV2 } from '@skillsmith/core/contracts/v2';
// @ts-expect-error v3 entry point must expose no v2 DTOs
import type { AgentsV2Dto as ForbiddenAgentsDtoFromV3 } from '@skillsmith/core/contracts/v3';

type Assert<T extends true> = T;
type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false;
type Not<T extends boolean> = T extends true ? false : true;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type ExpectedWireResult<T> = { ok: true; value: T } | { ok: false; error: WireCodecError };
type ContractsRootRuntime = typeof import('@skillsmith/core/contracts');
type V1Runtime = typeof import('@skillsmith/core/contracts/v1');
type V2Runtime = typeof import('@skillsmith/core/contracts/v2');
type V3Runtime = typeof import('@skillsmith/core/contracts/v3');

type _ContractsRootRuntimeClosure = Assert<
  Equal<keyof ContractsRootRuntime, 'createWireContractRegistry'>
>;
type _V1RuntimeClosure = Assert<
  Equal<
    keyof V1Runtime,
    | 'agentsV1Codec'
    | 'applyV1Codec'
    | 'toAgentsV1Dto'
    | 'healthV1Codec'
    | 'gcV1Codec'
    | 'toHealthV1Dto'
    | 'commandsV1Codec'
    | 'toCommandsV1Dto'
    | 'configGetV1Codec'
    | 'toConfigGetV1Dto'
    | 'configListV1Codec'
    | 'toConfigListV1Dto'
    | 'configSetV1Codec'
    | 'toConfigSetV1Dto'
    | 'configUnsetV1Codec'
    | 'toConfigUnsetV1Dto'
    | 'installV1Codec'
    | 'toInstallV1Dto'
    | 'planV1Codec'
    | 'initV1Codec'
    | 'toInitV1Dto'
    | 'statusV1Codec'
    | 'syncV1Codec'
    | 'updateV1Codec'
    | 'toStatusV1Dto'
    | 'uninstallV1Codec'
    | 'toUninstallV1Dto'
    | 'undoV1Codec'
    | 'toUndoV1Dto'
    | 'verifyV1Codec'
    | 'createVerifyV1Codec'
    | 'toVerifyV1Dto'
    | 'errorV1Codec'
    | 'toErrorV1Dto'
    | 'exportV1Codec'
    | 'toExportV1Dto'
    | 'capabilitySnapshotV1Codec'
    | 'toCapabilitySnapshotV1Dto'
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

type _PlanCodecDto = Assert<
  Equal<ReturnType<typeof planV1Codec.validate>, ExpectedWireResult<PlanV1Dto>>
>;
type _ApplyCodecDto = Assert<
  Equal<ReturnType<typeof applyV1Codec.validate>, ExpectedWireResult<ApplyReportV1Dto>>
>;
type _SyncCodecDto = Assert<
  Equal<ReturnType<typeof syncV1Codec.validate>, ExpectedWireResult<SyncReportV1Dto>>
>;
type _UpdateCodecDto = Assert<
  Equal<ReturnType<typeof updateV1Codec.validate>, ExpectedWireResult<UpdateReportV1Dto>>
>;
type _UndoCodecDto = Assert<
  Equal<ReturnType<typeof undoV1Codec.validate>, ExpectedWireResult<UndoReportV1Dto>>
>;
type _GcCodecDto = Assert<
  Equal<ReturnType<typeof gcV1Codec.validate>, ExpectedWireResult<GcReportV1Dto>>
>;
type _V2RuntimeClosure = Assert<
  Equal<
    keyof V2Runtime,
    | 'agentsV2Codec'
    | 'toAgentsV2Dto'
    | 'commandsV2Codec'
    | 'toCommandsV2Dto'
    | 'flipV2Codec'
    | 'toFlipV2Dto'
    | 'healthV2Codec'
    | 'toHealthV2Dto'
    | 'installV2Codec'
    | 'toInstallV2Dto'
    | 'listV2Codec'
    | 'toListV2Dto'
    | 'uninstallV2Codec'
    | 'toUninstallV2Dto'
    | 'ledgerV2Codec'
    | 'toLedgerV2Dto'
    | 'fromLedgerV2Dto'
    | 'migrateLedgerV1DtoToV2Dto'
  >
>;
type _V3RuntimeClosure = Assert<
  Equal<keyof V3Runtime, 'flipV3Codec' | 'toFlipV3Dto' | 'listV3Codec' | 'toListV3Dto'>
>;

interface FixtureDto {
  readonly value: string;
}

type FixtureDescriptor = WireCodecDescriptor<'fixture', 1>;
type FixtureCodec = WireCodec<'fixture', 1, FixtureDto>;
type CapabilityToolDto = CapabilitySnapshotV1Dto['tools'][number];
type CapabilityOperationDto =
  CapabilityToolDto['operations'][keyof CapabilityToolDto['operations']];

type _DescriptorKeys = Assert<
  Equal<
    keyof FixtureDescriptor,
    | 'id'
    | 'version'
    | 'wireKind'
    | 'embeddedVersion'
    | 'unknownFields'
    | 'formatting'
    | 'migrations'
    | 'compatibility'
  >
>;
type _DescriptorIdentity = Assert<
  Equal<Pick<FixtureDescriptor, 'id' | 'version'>, { readonly id: 'fixture'; readonly version: 1 }>
>;
type _DescriptorWirePolicy = Assert<
  Equal<
    Pick<FixtureDescriptor, 'wireKind' | 'embeddedVersion' | 'unknownFields' | 'compatibility'>,
    {
      readonly wireKind: string | null;
      readonly embeddedVersion: 'schemaVersion' | null;
      readonly unknownFields: 'reject-recursive';
      readonly compatibility: 'conservative';
    }
  >
>;
type _DescriptorFormatting = Assert<
  Equal<FixtureDescriptor['formatting'], { readonly indent: 0 | 2; readonly terminalLf: boolean }>
>;
type _DescriptorMigrations = Assert<Equal<FixtureDescriptor['migrations'], readonly number[]>>;

type _CodecKeys = Assert<
  Equal<keyof FixtureCodec, 'descriptor' | 'validate' | 'decode' | 'encode'>
>;
type _CodecDescriptor = Assert<Equal<FixtureCodec['descriptor'], FixtureDescriptor>>;
type _ValidateSignature = Assert<
  Equal<FixtureCodec['validate'], (input: unknown) => ExpectedWireResult<FixtureDto>>
>;
type _DecodeSignature = Assert<
  Equal<FixtureCodec['decode'], (text: string) => ExpectedWireResult<FixtureDto>>
>;
type _EncodeSignature = Assert<
  Equal<FixtureCodec['encode'], (dto: FixtureDto) => ExpectedWireResult<string>>
>;

type _CodecErrorKeys = Assert<
  Equal<keyof WireCodecError, 'code' | 'contractId' | 'requestedVersion' | 'path' | 'message'>
>;
type _CodecErrorCode = Assert<
  Equal<
    WireCodecError['code'],
    'malformed-json' | 'invalid-shape' | 'unsupported-version' | 'migration-failed'
  >
>;
type _CodecErrorFields = Assert<
  Equal<
    Omit<WireCodecError, 'code'>,
    {
      readonly contractId: string;
      readonly requestedVersion: number;
      readonly path: readonly (string | number)[];
      readonly message: string;
    }
  >
>;

type _MappingKeys = Assert<
  Equal<keyof WireContractMapping, 'commandPath' | 'contractId' | 'version'>
>;
type _RegistryKeys = Assert<
  Equal<keyof WireContractRegistry, 'codecs' | 'commandMappings' | 'get' | 'latest' | 'forCommand'>
>;

type _AgentsExcludeDomainMap = Assert<Not<HasKey<AgentsV1Dto, 'detections'>>>;
type _InstallExcludesCoreError = Assert<Not<HasKey<InstallV1Dto['results'][number], 'error'>>>;
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
type _UninstallExcludesCoreError = Assert<Not<HasKey<UninstallV1Dto['results'][number], 'error'>>>;
type _FlipExcludesCoreError = Assert<Not<HasKey<FlipV2Dto['results'][number], 'error'>>>;
type _CapabilityTopLevelKeys = Assert<
  Equal<keyof CapabilitySnapshotV1Dto, 'schemaVersion' | 'kind' | 'tools'>
>;
type _CapabilityToolKeys = Assert<
  Equal<keyof CapabilityToolDto, 'id' | 'order' | 'capabilityVersion' | 'operations'>
>;
type _CapabilityOperationKeys = Assert<
  Equal<keyof CapabilityOperationDto, 'supported' | 'scopes' | 'remediation'>
>;
type _CapabilityExcludesInventory = Assert<Not<HasKey<CapabilityToolDto, 'inventory'>>>;
type _CapabilityExcludesVerification = Assert<Not<HasKey<CapabilityToolDto, 'verification'>>>;
type _CapabilityExcludesPlacement = Assert<Not<HasKey<CapabilityToolDto, 'placement'>>>;
type _CapabilityExcludesAdaptation = Assert<Not<HasKey<CapabilityToolDto, 'adaptation'>>>;
type _CapabilityExcludesFunctions = Assert<
  Equal<Extract<CapabilityToolDto[keyof CapabilityToolDto], (...args: never[]) => unknown>, never>
>;
type _CapabilityExcludesPorts = Assert<
  Equal<Extract<keyof CapabilitySnapshotV1Dto | keyof CapabilityToolDto, 'ports' | 'env'>, never>
>;
type _CapabilityExcludesRegistryMethods = Assert<
  Equal<
    Extract<
      keyof CapabilitySnapshotV1Dto | keyof CapabilityToolDto,
      'get' | 'latest' | 'forCommand' | 'toolsFor' | 'capability'
    >,
    never
  >
>;
type _ErrorHasOnlyPublicFields = Assert<
  Equal<keyof ErrorV1Dto, 'schemaVersion' | 'kind' | 'code' | 'message' | 'exitCode'>
>;

const agentsCodec: WireCodec<'agents', 1, AgentsV1Dto> = agentsV1Codec;
const applyCodec: WireCodec<'apply-report', 1, ApplyReportV1Dto> = applyV1Codec;
const healthCodec: WireCodec<'health', 1, HealthV1Dto> = healthV1Codec;
const commandsCodec: WireCodec<'commands', 1, CommandsV1Dto> = commandsV1Codec;
const configGetCodec: WireCodec<'config-get', 1, ConfigGetV1Dto> = configGetV1Codec;
const configListCodec: WireCodec<'config-list', 1, ConfigListV1Dto> = configListV1Codec;
const configSetCodec: WireCodec<'config-set', 1, ConfigSetV1Dto> = configSetV1Codec;
const configUnsetCodec: WireCodec<'config-unset', 1, ConfigUnsetV1Dto> = configUnsetV1Codec;
const installCodec: WireCodec<'install', 1, InstallV1Dto> = installV1Codec;
const initCodec: WireCodec<'init', 1, InitV1Dto> = initV1Codec;
const statusCodec: WireCodec<'status', 1, StatusV1Dto> = statusV1Codec;
const uninstallCodec: WireCodec<'uninstall', 1, UninstallV1Dto> = uninstallV1Codec;
const undoCodec: WireCodec<'undo', 1, UndoReportV1Dto> = undoV1Codec;
const verifyCodec: WireCodec<'verify', 1, VerifyV1Dto> = verifyV1Codec;
const errorCodec: WireCodec<'error', 1, ErrorV1Dto> = errorV1Codec;
const capabilityCodec: WireCodec<'capability-snapshot', 1, CapabilitySnapshotV1Dto> =
  capabilitySnapshotV1Codec;
const flipCodec: WireCodec<'flip', 2, FlipV2Dto> = flipV2Codec;
const healthV2Binding: WireCodec<'health', 2, HealthV2Dto> = healthV2Codec;
const installV2Binding: WireCodec<'install', 2, InstallV2Dto> = installV2Codec;
const listCodec: WireCodec<'list', 2, ListV2Dto> = listV2Codec;
const uninstallV2Binding: WireCodec<'uninstall', 2, UninstallV2Dto> = uninstallV2Codec;
const agentsV2Binding: WireCodec<'agents', 2, AgentsV2Dto> = agentsV2Codec;
const commandsV2Binding: WireCodec<'commands', 2, CommandsV2Dto> = commandsV2Codec;
const flipV3Binding: WireCodec<'flip', 3, FlipV3Dto> = flipV3Codec;
const listV3Binding: WireCodec<'list', 3, ListV3Dto> = listV3Codec;

type _AgentsMapperReturn = Assert<Equal<ReturnType<typeof toAgentsV1Dto>, AgentsV1Dto>>;
type _HealthMapperReturn = Assert<Equal<ReturnType<typeof toHealthV1Dto>, HealthV1Dto>>;
type _CommandsMapperReturn = Assert<Equal<ReturnType<typeof toCommandsV1Dto>, CommandsV1Dto>>;
type _ConfigGetMapperReturn = Assert<Equal<ReturnType<typeof toConfigGetV1Dto>, ConfigGetV1Dto>>;
type _ConfigListMapperReturn = Assert<Equal<ReturnType<typeof toConfigListV1Dto>, ConfigListV1Dto>>;
type _ConfigSetMapperReturn = Assert<Equal<ReturnType<typeof toConfigSetV1Dto>, ConfigSetV1Dto>>;
type _ConfigUnsetMapperReturn = Assert<
  Equal<ReturnType<typeof toConfigUnsetV1Dto>, ConfigUnsetV1Dto>
>;
type _InstallMapperReturn = Assert<Equal<ReturnType<typeof toInstallV1Dto>, InstallV1Dto>>;
type _InitMapperReturn = Assert<Equal<ReturnType<typeof toInitV1Dto>, InitV1Dto>>;
type _StatusMapperReturn = Assert<Equal<ReturnType<typeof toStatusV1Dto>, StatusV1Dto>>;
type _UninstallMapperReturn = Assert<Equal<ReturnType<typeof toUninstallV1Dto>, UninstallV1Dto>>;
type _UndoMapperReturn = Assert<Equal<ReturnType<typeof toUndoV1Dto>, UndoReportV1Dto>>;
type _VerifyMapperReturn = Assert<Equal<ReturnType<typeof toVerifyV1Dto>, VerifyV1Dto>>;
type _ErrorMapperReturn = Assert<Equal<ReturnType<typeof toErrorV1Dto>, ErrorV1Dto>>;
type _CapabilityMapperReturn = Assert<
  Equal<ReturnType<typeof toCapabilitySnapshotV1Dto>, CapabilitySnapshotV1Dto>
>;
type _FlipMapperReturn = Assert<Equal<ReturnType<typeof toFlipV2Dto>, FlipV2Dto>>;
type _HealthV2MapperReturn = Assert<Equal<ReturnType<typeof toHealthV2Dto>, HealthV2Dto>>;
type _InstallV2MapperReturn = Assert<Equal<ReturnType<typeof toInstallV2Dto>, InstallV2Dto>>;
type _ListMapperReturn = Assert<Equal<ReturnType<typeof toListV2Dto>, ListV2Dto>>;
type _UninstallV2MapperReturn = Assert<Equal<ReturnType<typeof toUninstallV2Dto>, UninstallV2Dto>>;
type _AgentsV2MapperReturn = Assert<Equal<ReturnType<typeof toAgentsV2Dto>, AgentsV2Dto>>;
type _CommandsV2MapperReturn = Assert<Equal<ReturnType<typeof toCommandsV2Dto>, CommandsV2Dto>>;
type _FlipV3MapperReturn = Assert<Equal<ReturnType<typeof toFlipV3Dto>, FlipV3Dto>>;
type _ListV3MapperReturn = Assert<Equal<ReturnType<typeof toListV3Dto>, ListV3Dto>>;
type _VerifyFactoryReturn = Assert<
  ReturnType<typeof createVerifyV1Codec> extends WireCodec<'verify', 1, VerifyV1Dto> ? true : false
>;

const mappings = [
  { commandPath: 'skillsmith agents', contractId: 'agents', version: 1 },
  { commandPath: 'skillsmith dev', contractId: 'flip', version: 2 },
] as const satisfies readonly WireContractMapping[];

const registry: WireContractRegistry = createWireContractRegistry(
  [agentsCodec, errorCodec, flipCodec],
  mappings,
);

registry.get('agents', 1);
registry.latest('agents');
registry.forCommand('skillsmith agents');

export type VersionClosureCanaries = [
  ForbiddenV1FromRoot,
  ForbiddenV2FromRoot,
  ForbiddenFlipDtoFromV1,
  ForbiddenListDtoFromV1,
  ForbiddenInstallV2DtoFromV1,
  ForbiddenUninstallV2DtoFromV1,
  ForbiddenAgentsDtoFromV2,
  ForbiddenCapabilityDtoFromV2,
  ForbiddenCommandsDtoFromV2,
  ForbiddenConfigGetDtoFromV2,
  ForbiddenConfigListDtoFromV2,
  ForbiddenConfigSetDtoFromV2,
  ForbiddenConfigUnsetDtoFromV2,
  ForbiddenErrorDtoFromV2,
  ForbiddenHealthDtoFromV2,
  ForbiddenInstallDtoFromV2,
  ForbiddenStatusDtoFromV2,
  ForbiddenInitDtoFromV2,
  ForbiddenUninstallDtoFromV2,
  ForbiddenUndoDtoFromV2,
  ForbiddenVerifyDtoFromV2,
  ForbiddenAgentsDtoFromV3,
  ForbiddenListDtoFromV2,
];

void [
  applyCodec,
  healthCodec,
  commandsCodec,
  configGetCodec,
  configListCodec,
  configSetCodec,
  configUnsetCodec,
  installCodec,
  initCodec,
  statusCodec,
  uninstallCodec,
  undoCodec,
  verifyCodec,
  capabilityCodec,
  healthV2Binding,
  installV2Binding,
  listCodec,
  uninstallV2Binding,
  agentsV2Binding,
  commandsV2Binding,
  flipV3Binding,
  listV3Binding,
  toAgentsV1Dto,
  toHealthV1Dto,
  toCommandsV1Dto,
  toConfigGetV1Dto,
  toConfigListV1Dto,
  toConfigSetV1Dto,
  toConfigUnsetV1Dto,
  toInstallV1Dto,
  toInitV1Dto,
  toStatusV1Dto,
  toUninstallV1Dto,
  toUndoV1Dto,
  toVerifyV1Dto,
  toErrorV1Dto,
  toCapabilitySnapshotV1Dto,
  toFlipV2Dto,
  toHealthV2Dto,
  toInstallV2Dto,
  toListV2Dto,
  toUninstallV2Dto,
  toAgentsV2Dto,
  toCommandsV2Dto,
  toFlipV3Dto,
  toListV3Dto,
  createVerifyV1Codec,
  registry,
];

export type PublicWireCompileContract = {
  readonly registry: typeof registry;
  readonly agents: AgentsV1Dto;
  readonly apply: ApplyReportV1Dto;
  readonly health: HealthV1Dto;
  readonly commands: CommandsV1Dto;
  readonly configGet: ConfigGetV1Dto;
  readonly configList: ConfigListV1Dto;
  readonly configSet: ConfigSetV1Dto;
  readonly configUnset: ConfigUnsetV1Dto;
  readonly install: InstallV1Dto;
  readonly init: InitV1Dto;
  readonly status: StatusV1Dto;
  readonly uninstall: UninstallV1Dto;
  readonly undo: UndoReportV1Dto;
  readonly verify: VerifyV1Dto;
  readonly error: ErrorV1Dto;
  readonly capability: CapabilitySnapshotV1Dto;
  readonly flip: FlipV2Dto;
  readonly installV2: InstallV2Dto;
  readonly list: ListV2Dto;
  readonly uninstallV2: UninstallV2Dto;
};
