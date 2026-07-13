import type { AgentsReport, InstallRecord, SupportedTool } from '@skillsmith/core';
import { toAgentsV1Dto } from '@skillsmith/core/contracts/v1';
import { currentWireCodecs } from '../contracts/wire-contracts.ts';
import { encodeWire, wireSchema } from './wire-codec.ts';

export const AgentsJsonSchema = wireSchema(currentWireCodecs.agents);

export const renderAgentsJson = (
  results: ReadonlyMap<SupportedTool, readonly InstallRecord[]>,
): string =>
  encodeWire(
    currentWireCodecs.agents,
    toAgentsV1Dto({
      detections: results,
      format: 'json',
      detectedOnly: false,
    } satisfies AgentsReport),
  );
