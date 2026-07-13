import type * as publicContracts from '@skillsmith/core/contracts';
import type * as publicV1 from '@skillsmith/core/contracts/v1';
import type * as publicV2 from '@skillsmith/core/contracts/v2';
import * as implementationContracts from '../../../../packages/core/src/contracts/index.ts';
import * as implementationV1 from '../../../../packages/core/src/contracts/v1/index.ts';
import * as implementationV2 from '../../../../packages/core/src/contracts/v2/index.ts';

type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
    ? true
    : false
  : false;

type DtoDeclarationClosure = [
  Assert<Equal<publicV1.AgentsV1Dto, implementationV1.AgentsV1Dto>>,
  Assert<Equal<publicV1.HealthV1Dto, implementationV1.HealthV1Dto>>,
  Assert<Equal<publicV1.CommandsV1Dto, implementationV1.CommandsV1Dto>>,
  Assert<Equal<publicV1.ConfigGetV1Dto, implementationV1.ConfigGetV1Dto>>,
  Assert<Equal<publicV1.ConfigListV1Dto, implementationV1.ConfigListV1Dto>>,
  Assert<Equal<publicV1.InstallV1Dto, implementationV1.InstallV1Dto>>,
  Assert<Equal<publicV1.UninstallV1Dto, implementationV1.UninstallV1Dto>>,
  Assert<Equal<publicV1.VerifyV1Dto, implementationV1.VerifyV1Dto>>,
  Assert<Equal<publicV1.ErrorV1Dto, implementationV1.ErrorV1Dto>>,
  Assert<Equal<publicV1.CapabilitySnapshotV1Dto, implementationV1.CapabilitySnapshotV1Dto>>,
  Assert<Equal<publicV2.FlipV2Dto, implementationV2.FlipV2Dto>>,
  Assert<Equal<publicV2.ListV2Dto, implementationV2.ListV2Dto>>,
];

const builder: typeof publicContracts.createWireContractRegistry =
  implementationContracts.createWireContractRegistry;

const v1Bindings: typeof publicV1 = implementationV1;
const v2Bindings: typeof publicV2 = implementationV2;

const dtoDeclarationClosure: DtoDeclarationClosure = [
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
];

void [builder, v1Bindings, v2Bindings, dtoDeclarationClosure];
