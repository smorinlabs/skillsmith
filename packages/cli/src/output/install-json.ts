import type { CurrentInstallReport, CurrentUninstallReport } from '@skillsmith/core';
import { toInstallV2Dto, toUninstallV2Dto } from '@skillsmith/core/contracts/v2';
import { currentWireCodecs } from '../contracts/wire-contracts.ts';
import { encodeWire, wireSchema } from './wire-codec.ts';

export const InstallJsonSchema = wireSchema(currentWireCodecs.install);
export const UninstallJsonSchema = wireSchema(currentWireCodecs.uninstall);

export const renderInstallJson = (report: CurrentInstallReport): string =>
  encodeWire(currentWireCodecs.install, toInstallV2Dto(report));

export const renderUninstallJson = (report: CurrentUninstallReport): string =>
  encodeWire(currentWireCodecs.uninstall, toUninstallV2Dto(report));
