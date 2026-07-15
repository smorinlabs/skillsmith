import type { StatusV1Dto } from '@skillsmith/core/contracts/v1';
import { currentWireCodecs } from '../contracts/wire-contracts.ts';
import { encodeWire } from './wire-codec.ts';

/** Encode the already redacted and validated application DTO through the authoritative binding. */
export const renderStatusJson = (dto: StatusV1Dto): string =>
  encodeWire(currentWireCodecs.status, dto);
