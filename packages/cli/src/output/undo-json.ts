import type { WireCodec } from '@skillsmith/core/contracts';
import type { UndoReportV1Dto } from '@skillsmith/core/contracts/v1';
import { encodeWire } from './wire-codec.ts';

/** Encode only through the current strict undo@1 wire contract. */
export const renderUndoJson = (
  report: UndoReportV1Dto,
  codec: WireCodec<'undo', 1, UndoReportV1Dto>,
): string => encodeWire(codec, report);
