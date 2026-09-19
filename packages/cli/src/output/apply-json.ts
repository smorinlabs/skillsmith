import type { WireCodec } from '@skillsmith/core/contracts';
import type { ApplyReportV1Dto } from '@skillsmith/core/contracts/v1';
import { encodeWire } from './wire-codec.ts';

/** Encode only through the current strict apply-report wire contract. */
export const renderApplyJson = (
  report: ApplyReportV1Dto,
  codec: WireCodec<'apply-report', 1, ApplyReportV1Dto>,
): string => encodeWire(codec, report);
