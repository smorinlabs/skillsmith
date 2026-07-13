import type { ListReport, SkillEntry } from '@skillsmith/core';
import { toListV2Dto } from '@skillsmith/core/contracts/v2';
import { currentWireCodecs } from '../contracts/wire-contracts.ts';
import { encodeWire, wireSchema } from './wire-codec.ts';

export const ListJsonSchema = wireSchema(currentWireCodecs.list);

export const renderListJson = (entries: readonly SkillEntry[]): string =>
  encodeWire(currentWireCodecs.list, toListV2Dto({ entries, long: false } satisfies ListReport));
