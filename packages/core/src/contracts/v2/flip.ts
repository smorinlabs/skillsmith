import { z } from 'zod';

import { FLIP_TOOLS, type FlipReport, type FlipResult } from '../../place/types.ts';
import { createJsonWireCodec } from '../codec.ts';
import type { WireCodecDescriptor } from '../types.ts';

const FlipToolSchema = z.enum(FLIP_TOOLS);
const FlipOpSchema = z.enum(['promote', 'dev', 'rollback']);
const FlipActionSchema = z.enum([
  'flipped',
  'updated',
  'noop',
  'skipped',
  'refused',
  'failed',
  'rolled-back',
  'created',
  'adopted',
]);
const PlacementModeSchema = z.enum(['dev', 'pinned']);
const VerifyGateSchema = z.enum(['passed', 'warned', 'failed', 'skipped', 'inconclusive']);
const VerifyVerdictSchema = z.enum(['pass', 'warn', 'fail', 'inconclusive']);

const PlacementStateSchema = z
  .object({
    mode: PlacementModeSchema,
    symlinkTarget: z.string().optional(),
    storePath: z.string().nullable().optional(),
  })
  .strict()
  .nullable();

const StoreSchema = z
  .object({
    path: z.string(),
    rev: z.string(),
    gitSha: z.string().nullable(),
    dirty: z.boolean(),
    reused: z.boolean(),
  })
  .strict()
  .nullable();

const VerifySchema = z
  .object({
    gate: VerifyGateSchema,
    verdict: VerifyVerdictSchema.nullable(),
  })
  .strict()
  .nullable();

const FlipResultSchema = z
  .object({
    skill: z.string(),
    tool: FlipToolSchema.nullable(),
    placementPath: z.string().nullable(),
    action: FlipActionSchema,
    reason: z.string().nullable(),
    before: PlacementStateSchema,
    after: PlacementStateSchema,
    store: StoreSchema,
    verify: VerifySchema,
  })
  .strict();

const FlipV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    kind: z.literal('skillsmith.flip'),
    op: FlipOpSchema,
    dryRun: z.boolean(),
    requested: z
      .object({
        targets: z.array(z.string()),
        all: z.boolean(),
        tools: z.array(FlipToolSchema),
        explicitTools: z.boolean(),
      })
      .strict(),
    results: z.array(FlipResultSchema),
    summary: z
      .object({
        flipped: z.number(),
        updated: z.number(),
        noop: z.number(),
        skipped: z.number(),
        refused: z.number(),
        failed: z.number(),
        rolledBack: z.number(),
        created: z.number(),
        adopted: z.number(),
      })
      .strict(),
  })
  .strict();

export type FlipV2Dto = z.infer<typeof FlipV2Schema>;

const descriptor = Object.freeze({
  id: 'flip',
  version: 2,
  wireKind: 'skillsmith.flip',
  embeddedVersion: 'schemaVersion',
  unknownFields: 'reject-recursive',
  formatting: Object.freeze({ indent: 2, terminalLf: false }),
  migrations: Object.freeze([]),
  compatibility: 'conservative',
} as const satisfies WireCodecDescriptor<'flip', 2>);

export const flipV2Codec = createJsonWireCodec(descriptor, FlipV2Schema);

const toPlacementStateDto = (
  value: FlipResult['before'] | FlipResult['after'],
): FlipV2Dto['results'][number]['before'] =>
  value === null
    ? null
    : {
        mode: value.mode,
        symlinkTarget: value.symlinkTarget,
        storePath: value.storePath,
      };

const toStoreDto = (value: FlipResult['store']): FlipV2Dto['results'][number]['store'] =>
  value === null
    ? null
    : {
        path: value.path,
        rev: value.rev,
        gitSha: value.gitSha,
        dirty: value.dirty,
        reused: value.reused,
      };

const toVerifyDto = (value: FlipResult['verify']): FlipV2Dto['results'][number]['verify'] =>
  value === null
    ? null
    : {
        gate: value.gate,
        verdict: value.verdict,
      };

const toFlipResultDto = (value: FlipResult): FlipV2Dto['results'][number] => ({
  skill: value.skill,
  tool: value.tool,
  placementPath: value.placementPath,
  action: value.action,
  reason: value.reason,
  before: toPlacementStateDto(value.before),
  after: toPlacementStateDto(value.after),
  store: toStoreDto(value.store),
  verify: toVerifyDto(value.verify),
});

/** Maps the lifecycle report to the stable wire DTO without observing core-only result errors. */
export const toFlipV2Dto = (report: FlipReport): FlipV2Dto => ({
  schemaVersion: 2,
  kind: 'skillsmith.flip',
  op: report.op,
  dryRun: report.dryRun,
  requested: {
    targets: report.requested.targets.map((target) => target),
    all: report.requested.all,
    tools: report.requested.tools.map((tool) => tool),
    explicitTools: report.requested.explicitTools,
  },
  results: report.results.map(toFlipResultDto),
  summary: {
    flipped: report.summary.flipped,
    updated: report.summary.updated,
    noop: report.summary.noop,
    skipped: report.summary.skipped,
    refused: report.summary.refused,
    failed: report.summary.failed,
    rolledBack: report.summary.rolledBack,
    created: report.summary.created,
    adopted: report.summary.adopted,
  },
});
