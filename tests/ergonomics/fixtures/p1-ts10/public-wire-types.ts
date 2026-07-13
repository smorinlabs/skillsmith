import {
  type WireCodec,
  type WireCodecError,
  type WireContractMapping,
  type WireContractRegistry,
  createWireContractRegistry,
} from '@skillsmith/core/contracts';
import {
  type AgentsV1Dto,
  type CapabilitySnapshotV1Dto,
  type ErrorV1Dto,
  type InstallV1Dto,
  agentsV1Codec,
  capabilitySnapshotV1Codec,
  errorV1Codec,
  installV1Codec,
  toAgentsV1Dto,
  toCapabilitySnapshotV1Dto,
  toErrorV1Dto,
  toInstallV1Dto,
} from '@skillsmith/core/contracts/v1';
import {
  type FlipV2Dto,
  type ListV2Dto,
  flipV2Codec,
  listV2Codec,
  toFlipV2Dto,
  toListV2Dto,
} from '@skillsmith/core/contracts/v2';

// @ts-expect-error versioned v1 entry point must not leak v2 contracts
import type { FlipV2Dto as ForbiddenV2FromV1 } from '@skillsmith/core/contracts/v1';
// @ts-expect-error versioned v2 entry point must not leak v1 contracts
import type { AgentsV1Dto as ForbiddenV1FromV2 } from '@skillsmith/core/contracts/v2';

export type VersionClosureCanaries = [ForbiddenV2FromV1, ForbiddenV1FromV2];

type Assert<T extends true> = T;
type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false;
type Not<T extends boolean> = T extends true ? false : true;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

const agentsCodec: WireCodec<'agents', 1, AgentsV1Dto> = agentsV1Codec;
const errorCodec: WireCodec<'error', 1, ErrorV1Dto> = errorV1Codec;
const flipCodec: WireCodec<'flip', 2, FlipV2Dto> = flipV2Codec;

const mappings = [
  { commandPath: 'agents', contractId: 'agents', version: 1 },
  { commandPath: 'dev', contractId: 'flip', version: 2 },
] as const satisfies readonly WireContractMapping[];

const registry: WireContractRegistry = createWireContractRegistry(
  [agentsCodec, errorCodec, flipCodec],
  mappings,
);

registry.get('agents', 1);
registry.latest('agents');
registry.forCommand('agents');

type _CodecErrorIsSafeRecord = Assert<
  Equal<keyof WireCodecError, 'code' | 'contractId' | 'requestedVersion' | 'path' | 'message'>
>;
type _AgentsExcludeDomainMap = Assert<Not<HasKey<AgentsV1Dto, 'detections'>>>;
type _InstallExcludesCoreError = Assert<Not<HasKey<InstallV1Dto['results'][number], 'error'>>>;
type _FlipExcludesCoreError = Assert<Not<HasKey<FlipV2Dto['results'][number], 'error'>>>;
type _CapabilityExcludesInventoryAdapter = Assert<
  Not<HasKey<CapabilitySnapshotV1Dto['tools'][number], 'inventory'>>
>;
type _CapabilityExcludesVerificationFunctions = Assert<
  Not<HasKey<CapabilitySnapshotV1Dto['tools'][number], 'verification'>>
>;
type _CapabilityExcludesRegistryMethods = Assert<Not<HasKey<CapabilitySnapshotV1Dto, 'get'>>>;
type _ErrorHasOnlyPublicFields = Assert<
  Equal<keyof ErrorV1Dto, 'schemaVersion' | 'kind' | 'code' | 'message' | 'exitCode'>
>;

// Mapper inputs stay domain-facing while their outputs are codec-derived public DTOs.
const agentsMapper: (...args: Parameters<typeof toAgentsV1Dto>) => AgentsV1Dto = toAgentsV1Dto;
const capabilityMapper: (
  ...args: Parameters<typeof toCapabilitySnapshotV1Dto>
) => CapabilitySnapshotV1Dto = toCapabilitySnapshotV1Dto;
const installMapper: (...args: Parameters<typeof toInstallV1Dto>) => InstallV1Dto = toInstallV1Dto;
const errorMapper: (...args: Parameters<typeof toErrorV1Dto>) => ErrorV1Dto = toErrorV1Dto;
const flipMapper: (...args: Parameters<typeof toFlipV2Dto>) => FlipV2Dto = toFlipV2Dto;
const listMapper: (...args: Parameters<typeof toListV2Dto>) => ListV2Dto = toListV2Dto;

void [
  capabilitySnapshotV1Codec,
  installV1Codec,
  listV2Codec,
  agentsMapper,
  capabilityMapper,
  installMapper,
  errorMapper,
  flipMapper,
  listMapper,
  registry,
];

export type PublicWireCompileContract = {
  readonly registry: typeof registry;
  readonly agents: AgentsV1Dto;
  readonly capability: CapabilitySnapshotV1Dto;
  readonly error: ErrorV1Dto;
  readonly install: InstallV1Dto;
  readonly flip: FlipV2Dto;
  readonly list: ListV2Dto;
};
