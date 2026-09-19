import type { WireCodec } from '@skillsmith/core/contracts';
import type { PlanV1Dto } from '@skillsmith/core/contracts/v1';
import { encodeWire } from './wire-codec.ts';

export const renderPlanJson = (
  report: PlanV1Dto,
  codec: WireCodec<'plan-report', 1, PlanV1Dto>,
): string => encodeWire(codec, report);
