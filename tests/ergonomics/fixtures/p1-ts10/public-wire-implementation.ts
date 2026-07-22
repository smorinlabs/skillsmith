import type * as publicContracts from '@skillsmith/core/contracts';
import type * as publicV1 from '@skillsmith/core/contracts/v1';
import type * as publicV2 from '@skillsmith/core/contracts/v2';
import type * as publicV3 from '@skillsmith/core/contracts/v3';
import * as implementationContracts from '../../../../packages/core/src/contracts/index.ts';
import * as implementationV1 from '../../../../packages/core/src/contracts/v1/index.ts';
import * as implementationV2 from '../../../../packages/core/src/contracts/v2/index.ts';
import * as implementationV3 from '../../../../packages/core/src/contracts/v3/index.ts';

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
  Assert<Equal<publicV1.ConfigSetV1Dto, implementationV1.ConfigSetV1Dto>>,
  Assert<Equal<publicV1.ConfigUnsetV1Dto, implementationV1.ConfigUnsetV1Dto>>,
  Assert<Equal<publicV1.InstallV1Dto, implementationV1.InstallV1Dto>>,
  Assert<Equal<publicV1.PlanV1Dto, implementationV1.PlanV1Dto>>,
  Assert<Equal<publicV1.ApplyReportV1Dto, implementationV1.ApplyReportV1Dto>>,
  Assert<Equal<publicV1.StatusV1Dto, implementationV1.StatusV1Dto>>,
  Assert<Equal<publicV1.SyncReportV1Dto, implementationV1.SyncReportV1Dto>>,
  Assert<Equal<publicV1.UninstallV1Dto, implementationV1.UninstallV1Dto>>,
  Assert<Equal<publicV1.VerifyV1Dto, implementationV1.VerifyV1Dto>>,
  Assert<Equal<publicV1.ErrorV1Dto, implementationV1.ErrorV1Dto>>,
  Assert<Equal<publicV1.ExportV1Dto, implementationV1.ExportV1Dto>>,
  Assert<Equal<publicV1.InitV1Dto, implementationV1.InitV1Dto>>,
  Assert<Equal<publicV1.CapabilitySnapshotV1Dto, implementationV1.CapabilitySnapshotV1Dto>>,
  Assert<Equal<publicV2.FlipV2Dto, implementationV2.FlipV2Dto>>,
  Assert<Equal<publicV2.ListV2Dto, implementationV2.ListV2Dto>>,
  Assert<Equal<publicV2.AgentsV2Dto, implementationV2.AgentsV2Dto>>,
  Assert<Equal<publicV2.CommandsV2Dto, implementationV2.CommandsV2Dto>>,
  Assert<Equal<publicV2.InstallV2Dto, implementationV2.InstallV2Dto>>,
  Assert<Equal<publicV2.UninstallV2Dto, implementationV2.UninstallV2Dto>>,
  Assert<Equal<publicV3.ListV3Dto, implementationV3.ListV3Dto>>,
];

const builder: typeof publicContracts.createWireContractRegistry =
  implementationContracts.createWireContractRegistry;

const v1Bindings: typeof publicV1 = implementationV1;
const v2Bindings: typeof publicV2 = implementationV2;
const v3Bindings: typeof publicV3 = implementationV3;

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
  true,
];

void [builder, v1Bindings, v2Bindings, v3Bindings, dtoDeclarationClosure];
