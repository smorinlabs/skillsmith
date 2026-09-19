import { z } from 'zod';
import { SUPPORTED_TOOLS } from '../../agents/registry.ts';
import type { ExportReport, ExportResult } from '../../export/types.ts';
import { createJsonWireCodec } from '../codec.ts';

const ToolSchema = z.enum(SUPPORTED_TOOLS);
const ScopeSchema = z.enum(['user', 'project', 'system', 'managed']);
const SourceSchema = z
  .object({
    host: z.string(),
    repository: z.string(),
    path: z.string().nullable(),
  })
  .strict();

const PortableResultSchema = z
  .object({
    name: z.string(),
    tools: z.array(ToolSchema),
    scope: z.enum(['user', 'project']),
    source: SourceSchema,
    sourceText: z.string(),
    requestedRef: z.string().nullable(),
    resolvedSha: z.string(),
    sourcePath: z.string(),
    contentHash: z.string(),
    placement: z.enum(['symlink', 'copy']),
    path: z.string().nullable(),
    classification: z.enum(['portable-managed', 'portable-dev']),
    action: z.enum(['add', 'merge', 'refresh', 'unchanged']),
    reason: z.null(),
  })
  .strict();

const SkipReasonSchema = z.enum([
  'ambiguous',
  'dirty-git',
  'incomplete-provenance',
  'invalid-content',
  'invalid-path',
  'invalid-source',
  'live-content-mismatch',
  'non-git-dev',
  'pending-journal',
  'stale-ledger',
  'unmanaged',
  'unsupported-scope',
]);

const SkippedResultSchema = z
  .object({
    name: z.string(),
    tools: z.array(ToolSchema),
    scope: ScopeSchema,
    classification: SkipReasonSchema,
    action: z.literal('skipped'),
    reason: SkipReasonSchema,
  })
  .strict();

const ConflictResultSchema = z
  .object({
    name: z.string(),
    tools: z.array(ToolSchema),
    scope: ScopeSchema,
    classification: z.literal('conflict'),
    action: z.literal('conflict'),
    reason: z.enum([
      'custom-path-conflict',
      'duplicate-selected-placement',
      'existing-declaration-conflict',
      'selected-candidate-conflict',
    ]),
  })
  .strict();

const ArtifactSelectionSchema = z.union([
  z
    .object({
      outcome: z.literal('selected'),
      selectedBy: z.enum(['explicit-file', 'project', 'user']),
      manifestPath: z.string(),
      lockPath: z.string(),
      lockSource: z.enum(['sibling', 'explicit']),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('none'),
      reason: z.enum(['no-portable-candidates', 'filter-noop']),
    })
    .strict(),
  z.object({ outcome: z.literal('refused'), reason: z.string() }).strict(),
]);

const ExportV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('skillsmith.export'),
    reportVersion: z.literal(1),
    dryRun: z.boolean(),
    requested: z
      .object({
        tools: z.array(ToolSchema),
        explicitTools: z.boolean(),
        scope: ScopeSchema,
        explicitScope: z.boolean(),
        strict: z.boolean(),
        force: z.boolean(),
      })
      .strict(),
    artifactSelection: ArtifactSelectionSchema,
    results: z.array(z.union([PortableResultSchema, SkippedResultSchema, ConflictResultSchema])),
    effects: z.array(
      z
        .object({
          role: z.enum(['ledger', 'manifest', 'lock']),
          action: z.enum(['create', 'migrate', 'update', 'refresh', 'unchanged', 'not-written']),
          operationId: z.string().nullable(),
          outcome: z.enum(['planned', 'succeeded', 'failed', 'cancelled', 'not-run']),
        })
        .strict(),
    ),
    summary: z
      .object({
        observed: z.number().int().nonnegative(),
        portable: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
        conflicts: z.number().int().nonnegative(),
        changed: z.number().int().nonnegative(),
        unchanged: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type ExportV1Dto = z.infer<typeof ExportV1Schema>;

const toExportResultV1Dto = (result: ExportResult): ExportV1Dto['results'][number] => {
  if (result.action === 'skipped') {
    return {
      name: result.name,
      tools: Array.from(result.tools),
      scope: result.scope,
      classification: result.classification,
      action: result.action,
      reason: result.reason,
    };
  }
  if (result.action === 'conflict') {
    return {
      name: result.name,
      tools: Array.from(result.tools),
      scope: result.scope,
      classification: result.classification,
      action: result.action,
      reason: result.reason,
    };
  }
  return {
    name: result.name,
    tools: Array.from(result.tools),
    scope: result.scope,
    source: { ...result.source },
    sourceText: result.sourceText,
    requestedRef: result.requestedRef,
    resolvedSha: result.resolvedSha,
    sourcePath: result.sourcePath,
    contentHash: result.contentHash,
    placement: result.placement,
    path: result.path,
    classification: result.classification,
    action: result.action,
    reason: result.reason,
  };
};

export const toExportV1Dto = (report: ExportReport): ExportV1Dto => ({
  schemaVersion: 1,
  kind: 'skillsmith.export',
  reportVersion: 1,
  dryRun: report.dryRun,
  requested: {
    tools: Array.from(report.requested.tools),
    explicitTools: report.requested.explicitTools,
    scope: report.requested.scope,
    explicitScope: report.requested.explicitScope,
    strict: report.requested.strict,
    force: report.requested.force,
  },
  artifactSelection: { ...report.artifactSelection },
  results: report.results.map(toExportResultV1Dto),
  effects: report.effects.map((effect) => ({ ...effect })),
  summary: { ...report.summary },
});

export const exportV1Codec = createJsonWireCodec(
  {
    id: 'export',
    version: 1,
    wireKind: 'skillsmith.export',
    embeddedVersion: 'schemaVersion',
    unknownFields: 'reject-recursive',
    formatting: { indent: 2, terminalLf: true },
    migrations: [],
    compatibility: 'conservative',
  } as const,
  ExportV1Schema,
);
