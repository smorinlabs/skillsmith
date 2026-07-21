import type { WireCodec } from '@skillsmith/core/contracts';
import type { SyncReportV1Dto } from '@skillsmith/core/contracts/v1';
import { encodeWire } from './wire-codec.ts';

export const renderSyncJson = (
  report: SyncReportV1Dto,
  codec: WireCodec<'sync', 1, SyncReportV1Dto>,
): string => encodeWire(codec, report);
