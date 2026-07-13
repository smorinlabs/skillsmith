import type { FlipReport } from '@skillsmith/core';
import { toFlipV2Dto } from '@skillsmith/core/contracts/v2';
import { currentWireCodecs } from '../contracts/wire-contracts.ts';
import { encodeWire, wireSchema } from './wire-codec.ts';

export const FlipJsonSchema = wireSchema(currentWireCodecs.dev);

export const renderFlipJson = (report: FlipReport, codec = currentWireCodecs.dev): string =>
  encodeWire(codec, toFlipV2Dto(report));
