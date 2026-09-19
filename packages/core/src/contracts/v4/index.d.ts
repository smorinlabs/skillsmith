import type { FlipReport } from '@skillsmith/core';
import type { WireCodec } from '@skillsmith/core/contracts';

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
  results: Array<
    Omit<NonNullable<FlipReport['executionResults']>[number], 'outcome'> & {
      outcome: 'succeeded' | 'failed' | 'cancelled' | 'rolled-back' | 'skipped-after-failure';
    }
  >;
}

export declare const flipV4Codec: WireCodec<'flip', 4, FlipV4Dto>;
export declare const toFlipV4Dto: (report: FlipReport) => FlipV4Dto;
