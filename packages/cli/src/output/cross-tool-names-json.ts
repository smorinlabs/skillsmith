import type { CrossToolNamesReport } from '@skillsmith/core';
import { toCrossToolNamesV1Dto } from '@skillsmith/core/contracts/v1';
import { currentWireCodecs } from '../contracts/wire-contracts.ts';
import { encodeWire, wireSchema } from './wire-codec.ts';

export const CrossToolNamesJsonSchema = wireSchema(currentWireCodecs.crossToolNames);

export const renderCrossToolNamesJson = (value: CrossToolNamesReport): string =>
  encodeWire(currentWireCodecs.crossToolNames, toCrossToolNamesV1Dto(value));
