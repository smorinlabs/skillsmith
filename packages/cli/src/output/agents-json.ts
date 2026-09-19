import type { AgentsReport, InstallRecord, SupportedTool } from '@skillsmith/core';
import { toAgentsV2Dto } from '@skillsmith/core/contracts/v2';
import { currentWireCodecs } from '../contracts/wire-contracts.ts';
import { encodeWire, wireSchema } from './wire-codec.ts';

export const AgentsJsonSchema = wireSchema(currentWireCodecs.agents);

export const renderAgentsJson = (
  value: ReadonlyMap<SupportedTool, readonly InstallRecord[]> | AgentsReport,
): string =>
  encodeWire(
    currentWireCodecs.agents,
    toAgentsV2Dto(
      value instanceof Map
        ? ({
            detections: value,
            format: 'json',
            detectedOnly: false,
          } satisfies AgentsReport)
        : (value as AgentsReport),
    ),
  );
