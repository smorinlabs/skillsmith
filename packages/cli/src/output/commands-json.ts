import type { CommandEntry, CommandsReport } from '@skillsmith/core';
import { toCommandsV1Dto } from '@skillsmith/core/contracts/v1';
import { currentWireCodecs } from '../contracts/wire-contracts.ts';
import { encodeWire, wireSchema } from './wire-codec.ts';

export const CommandsJsonSchema = wireSchema(currentWireCodecs.commands);

export const renderCommandsJson = (entries: readonly CommandEntry[]): string =>
  encodeWire(
    currentWireCodecs.commands,
    toCommandsV1Dto({ entries, long: false } satisfies CommandsReport),
  );
