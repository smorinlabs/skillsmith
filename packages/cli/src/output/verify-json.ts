import { toolRegistry } from '@skillsmith/core';
import type { ToolRegistry, VerifyReport } from '@skillsmith/core';
import { createVerifyV1Codec, toVerifyV1Dto } from '@skillsmith/core/contracts/v1';
import { currentWireCodecs } from '../contracts/wire-contracts.ts';
import { encodeWire, wireSchema } from './wire-codec.ts';

type VerifySchemaRegistry = Pick<ToolRegistry, 'toolsFor'>;

export const createVerifyJsonSchema = (registry: VerifySchemaRegistry) =>
  wireSchema(createVerifyV1Codec(registry));

export const VerifyJsonSchema = createVerifyJsonSchema(toolRegistry);

export const renderVerifyJson = (report: VerifyReport): string =>
  encodeWire(currentWireCodecs.verify, toVerifyV1Dto(report));
