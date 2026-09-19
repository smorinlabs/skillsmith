import type { InitReport } from '@skillsmith/core';
import type { WireCodec } from '@skillsmith/core/contracts';
import { toInitV1Dto } from '@skillsmith/core/contracts/v1';
import { encodeWire } from './wire-codec.ts';

export const renderInitJson = (
  report: InitReport,
  codec: WireCodec<'init', 1, ReturnType<typeof toInitV1Dto>>,
): string => encodeWire(codec, toInitV1Dto(report));
