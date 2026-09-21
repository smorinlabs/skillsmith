import type { SearchReport } from '@skillsmith/core';
import type { WireCodec } from '@skillsmith/core/contracts';
import { type SearchV1Dto, searchV1Codec, toSearchV1Dto } from '@skillsmith/core/contracts/v1';
import { encodeWire } from './wire-codec.ts';

export const renderSearchJson = (
  report: SearchReport,
  codec: WireCodec<'search', 1, SearchV1Dto> = searchV1Codec,
): string => encodeWire(codec, toSearchV1Dto(report));
