import type { ListReport, SkillEntry } from '@skillsmith/core';
import { toListV3Dto } from '@skillsmith/core/contracts/v3';
import { currentWireCodecs } from '../contracts/wire-contracts.ts';
import { encodeWire, wireSchema } from './wire-codec.ts';

export const ListJsonSchema = wireSchema(currentWireCodecs.list);

export const renderListJson = (value: readonly SkillEntry[] | ListReport): string =>
  encodeWire(
    currentWireCodecs.list,
    toListV3Dto(
      Array.isArray(value)
        ? ({ entries: value, collisionGroups: [], long: false } satisfies ListReport)
        : (value as ListReport),
    ),
  );
