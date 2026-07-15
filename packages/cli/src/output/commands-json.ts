import type { CommandEntry, CommandsReport } from '@skillsmith/core';
import { toCommandsV2Dto } from '@skillsmith/core/contracts/v2';
import { currentWireCodecs } from '../contracts/wire-contracts.ts';
import { encodeWire, wireSchema } from './wire-codec.ts';

export const CommandsJsonSchema = wireSchema(currentWireCodecs.commands);

export const renderCommandsJson = (value: readonly CommandEntry[] | CommandsReport): string =>
  encodeWire(
    currentWireCodecs.commands,
    toCommandsV2Dto(
      Array.isArray(value)
        ? ({ entries: value, long: false } satisfies CommandsReport)
        : (value as CommandsReport),
    ),
  );
