import type { FlipReport } from '@skillsmith/core';
import type { WireCodec } from '@skillsmith/core/contracts';
import { type FlipV2Dto, toFlipV2Dto } from '@skillsmith/core/contracts/v2';
import { type FlipV3Dto, toFlipV3Dto } from '@skillsmith/core/contracts/v3';
import { type FlipV4Dto, toFlipV4Dto } from '@skillsmith/core/contracts/v4';
import { currentWireCodecs } from '../contracts/wire-contracts.ts';
import { encodeWire, wireSchema } from './wire-codec.ts';

export const FlipJsonSchema = wireSchema(currentWireCodecs.dev);

export type FlipJsonCodec =
  | WireCodec<'flip', 2, FlipV2Dto>
  | WireCodec<'flip', 3, FlipV3Dto>
  | WireCodec<'flip', 4, FlipV4Dto>;

export const renderFlipJson = (
  report: FlipReport,
  codec: FlipJsonCodec = currentWireCodecs.dev,
): string => {
  if (codec.descriptor.version === 2) {
    return encodeWire(codec as WireCodec<'flip', 2, FlipV2Dto>, toFlipV2Dto(report));
  }
  if (codec.descriptor.version === 3) {
    return encodeWire(codec as WireCodec<'flip', 3, FlipV3Dto>, toFlipV3Dto(report));
  }
  return encodeWire(codec as WireCodec<'flip', 4, FlipV4Dto>, toFlipV4Dto(report));
};
