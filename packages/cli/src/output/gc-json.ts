import type { WireCodec } from '@skillsmith/core/contracts';
import type { GcReportV1Dto } from '@skillsmith/core/contracts/v1';
import { encodeWire } from './wire-codec.ts';

/** Encode only through the current strict gc@1 wire contract. */
export const renderGcJson = (
  report: GcReportV1Dto,
  codec: WireCodec<'gc', 1, GcReportV1Dto>,
): string => encodeWire(codec, report);
