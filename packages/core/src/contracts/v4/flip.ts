import type { z } from 'zod';
import type { FlipReport } from '../../place/types.ts';
import { createJsonWireCodec } from '../codec.ts';
import { createFlipWireSchema, toFlipWireDto } from '../v3/flip.ts';

export type FlipV4ExecutionResult = Omit<
  NonNullable<FlipReport['executionResults']>[number],
  'outcome'
> & {
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'rolled-back' | 'skipped-after-failure';
};

export interface FlipV4Dto {
  schemaVersion: 4;
  kind: 'skillsmith.flip';
  op: 'promote' | 'dev' | 'rollback';
  dryRun: boolean;
  summary: FlipReport['summary'];
  selection: {
    source: 'explicit-targets' | 'explicit-all' | 'bounded-default';
    outcome: 'selected' | 'filter-noop';
    targets: string[];
    all: boolean;
    tools: string[];
    scopes: Array<'user' | 'project'>;
    groupIds: string[];
    batchPolicy: 'fail-fast' | 'continue-on-error';
  };
  operations: Array<NonNullable<FlipReport['plan']>['operations'][number]>;
  checks: Array<NonNullable<FlipReport['plan']>['checks'][number]>;
  diagnostics: Array<NonNullable<FlipReport['plan']>['diagnostics'][number]>;
  results: FlipV4ExecutionResult[];
}

const FlipV4Schema = createFlipWireSchema(
  4,
  ['succeeded', 'failed', 'cancelled', 'rolled-back', 'skipped-after-failure'],
  true,
) as unknown as z.ZodType<FlipV4Dto>;

/** Project the immutable runtime plan and scheduling result sidecar into strict flip@4. */
export const toFlipV4Dto = (report: FlipReport): FlipV4Dto =>
  toFlipWireDto(report, 4) as unknown as FlipV4Dto;

export const flipV4Codec = createJsonWireCodec(
  {
    id: 'flip',
    version: 4,
    wireKind: 'skillsmith.flip',
    embeddedVersion: 'schemaVersion',
    unknownFields: 'reject-recursive',
    formatting: { indent: 2, terminalLf: false },
    migrations: [],
    compatibility: 'conservative',
  },
  FlipV4Schema,
);
