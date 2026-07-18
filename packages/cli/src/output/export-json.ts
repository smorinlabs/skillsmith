import type { ExportReport } from '@skillsmith/core';
import { toExportV1Dto } from '@skillsmith/core/contracts/v1';
import { currentWireCodecs } from '../contracts/wire-contracts.ts';
import { encodeWire, wireSchema } from './wire-codec.ts';

export const ExportJsonSchema = wireSchema(currentWireCodecs.export);

export const renderExportJson = (report: ExportReport): string =>
  encodeWire(currentWireCodecs.export, toExportV1Dto(report));
