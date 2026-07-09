import { FLIP_TOOLS } from '@skillsmith/core';
import type { InstallReport, UninstallReport } from '@skillsmith/core';
import { z } from 'zod';

const ToolSchema = z.enum(FLIP_TOOLS);
const ScopeSchema = z.enum(['user', 'project']);
const PlacementSchema = z.enum(['symlink', 'copy']);

const InstallActionSchema = z.enum([
  'installed',
  'updated',
  'repaired',
  'noop',
  'skipped',
  'refused',
  'failed',
]);

const InstallGateSchema = z.enum(['passed', 'warned', 'failed', 'skipped', 'inconclusive']);
const InstallVerdictSchema = z.enum(['pass', 'warn', 'fail', 'inconclusive']);
const InstallVerifyModeSchema = z.enum(['static', 'static+deep']);

const InstallStoreSchema = z
  .object({
    path: z.string(),
    rev: z.string(),
    gitSha: z.string(),
    reused: z.boolean(),
  })
  .nullable();

const InstallOriginSchema = z
  .object({
    host: z.string(),
    repo: z.string(),
    skillPath: z.string(),
    refRequested: z.string().nullable(),
    refResolved: z.string(),
    pin: z.boolean(),
  })
  .nullable();

const InstallVerifySchema = z
  .object({
    gate: InstallGateSchema,
    verdict: InstallVerdictSchema.nullable(),
    mode: InstallVerifyModeSchema.nullable(),
  })
  .nullable();

const InstallResultSchema = z.object({
  source: z.string(),
  skill: z.string().nullable(),
  tool: ToolSchema.nullable(),
  scope: ScopeSchema,
  placementPath: z.string().nullable(),
  action: InstallActionSchema,
  reason: z.string().nullable(),
  placement: PlacementSchema.nullable(),
  store: InstallStoreSchema,
  origin: InstallOriginSchema,
  verify: InstallVerifySchema,
  candidates: z.array(z.string()).nullable(),
});

export const InstallJsonSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('skillsmith.install'),
  dryRun: z.boolean(),
  requested: z.object({
    sources: z.array(z.string()),
    tools: z.array(ToolSchema),
    explicitTools: z.boolean(),
    scope: ScopeSchema,
    explicitScope: z.boolean(),
    ref: z.string().nullable(),
    pin: z.boolean(),
    direct: z.boolean(),
    force: z.boolean(),
    verify: z.enum(['static', 'skipped']),
    deep: z.boolean(),
  }),
  results: z.array(InstallResultSchema),
  summary: z.object({
    installed: z.number(),
    updated: z.number(),
    repaired: z.number(),
    noop: z.number(),
    skipped: z.number(),
    refused: z.number(),
    failed: z.number(),
  }),
});

/** Versioned `skillsmith.install` JSON contract (task-9 brief). Drops the core-only `error`
 *  field from each result — it never reaches the wire, only `acquireExitCode` consumes it. */
export const renderInstallJson = (report: InstallReport): string => {
  const payload = {
    schemaVersion: 1 as const,
    kind: 'skillsmith.install' as const,
    dryRun: report.dryRun,
    requested: report.requested,
    results: report.results.map(({ error: _error, ...rest }) => rest),
    summary: report.summary,
  };
  const parsed = InstallJsonSchema.parse(payload);
  return JSON.stringify(parsed, null, 2);
};

const UninstallActionSchema = z.enum(['removed', 'noop', 'refused', 'failed']);
const UninstallModeSchema = z.enum(['dev', 'pinned']);

const UninstallBeforeSchema = z
  .object({
    mode: UninstallModeSchema,
    placement: PlacementSchema.nullable(),
    storePath: z.string().nullable(),
    symlinkTarget: z.string().nullable(),
  })
  .nullable();

const UninstallResultSchema = z.object({
  skill: z.string(),
  tool: ToolSchema.nullable(),
  scope: ScopeSchema.nullable(),
  placementPath: z.string().nullable(),
  action: UninstallActionSchema,
  reason: z.string().nullable(),
  before: UninstallBeforeSchema,
  storeRetained: z.string().nullable(),
  backupKept: z.string().nullable(),
});

export const UninstallJsonSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('skillsmith.uninstall'),
  dryRun: z.boolean(),
  requested: z.object({
    targets: z.array(z.string()),
    tools: z.array(ToolSchema),
    explicitTools: z.boolean(),
    scope: ScopeSchema.nullable(),
    allScopes: z.boolean(),
    force: z.boolean(),
  }),
  results: z.array(UninstallResultSchema),
  summary: z.object({
    removed: z.number(),
    noop: z.number(),
    refused: z.number(),
    failed: z.number(),
  }),
});

/** Versioned `skillsmith.uninstall` JSON contract (task-9 brief). Drops the core-only `error`
 *  field, same rationale as `renderInstallJson`. */
export const renderUninstallJson = (report: UninstallReport): string => {
  const payload = {
    schemaVersion: 1 as const,
    kind: 'skillsmith.uninstall' as const,
    dryRun: report.dryRun,
    requested: report.requested,
    results: report.results.map(({ error: _error, ...rest }) => rest),
    summary: report.summary,
  };
  const parsed = UninstallJsonSchema.parse(payload);
  return JSON.stringify(parsed, null, 2);
};
