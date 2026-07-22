import type { WireCodec } from '@skillsmith/core/contracts';
import type { UpdateReportV1Dto } from '@skillsmith/core/contracts/v1';
import { encodeWire } from './wire-codec.ts';

/** Encode only through the current strict update@1 wire contract. */
export const renderUpdateJson = (
  report: UpdateReportV1Dto,
  codec: WireCodec<'update', 1, UpdateReportV1Dto>,
): string => encodeWire(codec, report);
