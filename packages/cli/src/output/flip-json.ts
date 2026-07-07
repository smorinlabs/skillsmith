import { FLIP_TOOLS } from '@skillsmith/core';
import type { FlipReport } from '@skillsmith/core';
import { z } from 'zod';

const ToolSchema = z.enum(FLIP_TOOLS);
const OpSchema = z.enum(['promote', 'dev', 'rollback']);
const ActionSchema = z.enum([
  'flipped',
  'updated',
  'noop',
  'skipped',
  'refused',
  'failed',
  'rolled-back',
]);
const ModeSchema = z.enum(['dev', 'pinned']);
const GateSchema = z.enum(['passed', 'warned', 'failed', 'skipped', 'inconclusive']);
const VerdictSchema = z.enum(['pass', 'warn', 'fail', 'inconclusive']);

const PlacementStateSchema = z
  .object({
    mode: ModeSchema,
    symlinkTarget: z.string().optional(),
    storePath: z.string().nullable().optional(),
  })
  .nullable();

const StoreSchema = z
  .object({
    path: z.string(),
    rev: z.string(),
    gitSha: z.string().nullable(),
    dirty: z.boolean(),
    reused: z.boolean(),
  })
  .nullable();

const VerifySchema = z
  .object({
    gate: GateSchema,
    verdict: VerdictSchema.nullable(),
  })
  .nullable();

const FlipResultSchema = z.object({
  skill: z.string(),
  tool: ToolSchema.nullable(),
  placementPath: z.string().nullable(),
  action: ActionSchema,
  reason: z.string().nullable(),
  before: PlacementStateSchema,
  after: PlacementStateSchema,
  store: StoreSchema,
  verify: VerifySchema,
});

export const FlipJsonSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('skillsmith.flip'),
  op: OpSchema,
  dryRun: z.boolean(),
  requested: z.object({
    targets: z.array(z.string()),
    all: z.boolean(),
    tools: z.array(ToolSchema),
    explicitTools: z.boolean(),
  }),
  results: z.array(FlipResultSchema),
  summary: z.object({
    flipped: z.number(),
    updated: z.number(),
    noop: z.number(),
    skipped: z.number(),
    refused: z.number(),
    failed: z.number(),
    rolledBack: z.number(),
  }),
});

/** Versioned `skillsmith.flip` JSON contract (spec §11). Drops the core-only `error` field from
 *  each result — it never reaches the wire, only `flipExitCode` (CLI-side) consumes it. */
export const renderFlipJson = (report: FlipReport): string => {
  const payload = {
    schemaVersion: 1 as const,
    kind: 'skillsmith.flip' as const,
    op: report.op,
    dryRun: report.dryRun,
    requested: report.requested,
    results: report.results.map(({ error: _error, ...rest }) => rest),
    summary: report.summary,
  };
  const parsed = FlipJsonSchema.parse(payload);
  return JSON.stringify(parsed, null, 2);
};
