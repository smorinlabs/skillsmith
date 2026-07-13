import type { InstallReport, UninstallReport } from '@skillsmith/core';
import { toInstallV1Dto, toUninstallV1Dto } from '@skillsmith/core/contracts/v1';
import { currentWireCodecs } from '../contracts/wire-contracts.ts';
import { encodeWire, wireSchema } from './wire-codec.ts';

export const InstallJsonSchema = wireSchema(currentWireCodecs.install);
export const UninstallJsonSchema = wireSchema(currentWireCodecs.uninstall);

export const renderInstallJson = (report: InstallReport): string =>
  encodeWire(currentWireCodecs.install, toInstallV1Dto(report));

export const renderUninstallJson = (report: UninstallReport): string =>
  encodeWire(currentWireCodecs.uninstall, toUninstallV1Dto(report));
