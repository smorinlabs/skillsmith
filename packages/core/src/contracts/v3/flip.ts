import { z } from 'zod';
import { SUPPORTED_TOOLS } from '../../agents/registry.ts';
import type { FlipReport } from '../../place/types.ts';
import { createJsonWireCodec } from '../codec.ts';

const ToolSchema = z.enum(SUPPORTED_TOOLS);
const ScopeSchema = z.enum(['user', 'project']);
const SelectionSourceSchema = z.enum(['explicit-targets', 'explicit-all', 'bounded-default']);
const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const LocationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('portable'), token: z.string() }).strict(),
  z.object({ kind: z.literal('machine-bound'), path: z.string() }).strict(),
]);

const SourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('portable'),
      identity: z
        .object({
          host: z.string(),
          repository: z.string(),
          path: z.string().nullable(),
        })
        .strict(),
      requestedRef: z.string().nullable(),
      resolvedSha: z.string(),
      sourcePath: z.string(),
      contentHash: DigestSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('local-dev'),
      path: z.string(),
      contentHash: DigestSchema,
    })
    .strict(),
]);

const ResourceIdentitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manifest-bytes'), location: LocationSchema }).strict(),
  z.object({ kind: z.literal('lock'), location: LocationSchema }).strict(),
  z.object({ kind: z.literal('ledger'), projectRoot: LocationSchema.nullable() }).strict(),
  z.object({ kind: z.literal('ledger-schema'), projectRoot: LocationSchema.nullable() }).strict(),
  z
    .object({
      kind: z.literal('live'),
      skill: z.string(),
      tool: ToolSchema,
      scope: ScopeSchema,
      projectRoot: LocationSchema.nullable(),
      location: LocationSchema,
    })
    .strict(),
  z.object({ kind: z.literal('store'), contentHash: DigestSchema }).strict(),
  z.object({ kind: z.literal('project-context'), root: LocationSchema }).strict(),
]);

const OperationImageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('absent'), resource: ResourceIdentitySchema }).strict(),
  z
    .object({
      kind: z.literal('placement'),
      resource: ResourceIdentitySchema,
      classification: z.enum(['dev', 'pinned', 'store-linked', 'unmanaged']),
      representation: z.enum(['symlink', 'copy', 'other']),
      linkTarget: LocationSchema.nullable(),
      dangling: z.boolean(),
      source: SourceSchema.nullable(),
      contentHash: DigestSchema.nullable(),
    })
    .strict(),
]);

const ReasonSchema = z.object({ code: z.string(), message: z.string() }).strict();
const DependencySchema = z
  .object({
    domain: z.literal('skillsmith.operation-dependency'),
    schemaVersion: z.literal(1),
    operationIds: z.array(z.string()),
  })
  .strict();
const ReversibilitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none'), retentionResourceIds: z.tuple([]) }).strict(),
  z
    .object({
      kind: z.enum(['reversible', 'conditional']),
      retentionResourceIds: z.array(z.string()).nonempty(),
    })
    .strict(),
]);
const MutationFlagsSchema = z
  .object({
    live: z.boolean(),
    manifest: z.boolean(),
    lock: z.boolean(),
    ledger: z.boolean(),
  })
  .strict();
const ConflictSchema = z.discriminatedUnion('class', [
  z
    .object({
      class: z.enum(['unmanaged-target', 'modified-managed-target', 'destination-exists']),
      normal: z.literal('refuse'),
      forced: z.literal('backup-and-replace'),
      target: ResourceIdentitySchema,
      backup: z.literal('required'),
    })
    .strict(),
  z
    .object({
      class: z.literal('source-changed'),
      normal: z.literal('refuse'),
      forced: z.literal('replace'),
      target: ResourceIdentitySchema,
      backup: z.literal('none'),
    })
    .strict(),
]);

const OperationSchema = z
  .object({
    operationId: z.string(),
    groupId: z.string(),
    pairId: z.string().nullable(),
    kind: z.enum([
      'install',
      'update',
      'remove',
      'link-dev',
      'promote',
      'move-scope',
      'adapt',
      'repair',
      'write-manifest',
      'write-lock',
      'migrate-project-config',
      'migrate-ledger',
    ]),
    dependencyMetadata: DependencySchema,
    skill: z.string().nullable(),
    source: SourceSchema.nullable(),
    tool: ToolSchema.nullable(),
    scope: ScopeSchema.nullable(),
    before: OperationImageSchema,
    after: OperationImageSchema,
    reason: ReasonSchema,
    selectionSource: SelectionSourceSchema,
    preconditionIds: z.array(z.string()),
    requiredCheckIds: z.array(z.string()),
    reversibility: ReversibilitySchema,
    mutates: MutationFlagsSchema,
    conflict: ConflictSchema.nullable(),
  })
  .strict();

const CheckCommonSchema = {
  checkId: z.string(),
  blocking: z.literal(true),
  operationIds: z.array(z.string()).nonempty(),
} as const;
const CheckSchema = z.discriminatedUnion('kind', [
  z
    .object({ ...CheckCommonSchema, kind: z.literal('source-resolution'), source: SourceSchema })
    .strict(),
  z
    .object({
      ...CheckCommonSchema,
      kind: z.literal('capability'),
      capabilityPreconditionId: z.string(),
    })
    .strict(),
  z
    .object({
      ...CheckCommonSchema,
      kind: z.literal('content-integrity'),
      source: SourceSchema,
      expectedContentHash: DigestSchema,
    })
    .strict(),
  z
    .object({
      ...CheckCommonSchema,
      kind: z.literal('verification'),
      tool: ToolSchema,
      mode: z.enum(['static', 'static+deep']),
      expectedContentHash: DigestSchema,
    })
    .strict(),
  z
    .object({
      ...CheckCommonSchema,
      kind: z.literal('precondition-validation'),
      preconditionIds: z.array(z.string()).nonempty(),
    })
    .strict(),
]);

const DiagnosticSchema = z
  .object({
    diagnosticId: z.string(),
    kind: z.enum(['noop', 'skip', 'refuse', 'conflict', 'warning']),
    severity: z.enum(['info', 'warning', 'error']),
    refusalClass: z.enum(['usage', 'state', 'capability', 'source', 'permission']).nullable(),
    affected: z
      .object({
        skill: z.string().nullable(),
        source: SourceSchema.nullable(),
        tool: ToolSchema.nullable(),
        scope: ScopeSchema.nullable(),
        path: LocationSchema.nullable(),
      })
      .strict(),
    correlation: z
      .object({
        groupId: z.string().nullable(),
        pairId: z.string().nullable(),
        operationId: z.string().nullable(),
      })
      .strict(),
    reason: ReasonSchema,
    selectionSource: SelectionSourceSchema,
  })
  .strict();

const SelectionSchema = z
  .object({
    source: SelectionSourceSchema,
    outcome: z.enum(['selected', 'filter-noop']),
    targets: z.array(z.string()),
    all: z.boolean(),
    tools: z.array(ToolSchema),
    scopes: z.array(ScopeSchema),
    groupIds: z.array(z.string()),
    batchPolicy: z.enum(['fail-fast', 'continue-on-error']),
  })
  .strict();

const ForceSchema = z
  .object({
    requested: z.boolean(),
    applied: z.boolean(),
    conflictType: z
      .enum(['unmanaged-target', 'modified-managed-target', 'destination-exists', 'source-changed'])
      .nullable(),
    target: ResourceIdentitySchema.nullable(),
    normalBehavior: z.literal('refuse').nullable(),
    forcedBehavior: z.enum(['backup-and-replace', 'replace']).nullable(),
    backup: z.enum(['required', 'none']).nullable(),
  })
  .strict();
const ExecutionErrorSchema = z
  .object({ code: z.string(), message: z.string(), remediation: z.string() })
  .strict();
const ExecutionResultSchema = z
  .object({
    operationId: z.string(),
    outcome: z.enum(['succeeded', 'failed', 'cancelled', 'rolled-back']),
    actualBefore: OperationImageSchema,
    actualAfter: OperationImageSchema,
    force: ForceSchema.nullable(),
    error: ExecutionErrorSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.outcome === 'failed') !== (value.error !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['error'],
        message: 'error must be present exactly for failed outcomes',
      });
    }
  });

const SummarySchema = z
  .object({
    flipped: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    noop: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    refused: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    rolledBack: z.number().int().nonnegative(),
    created: z.number().int().nonnegative(),
    adopted: z.number().int().nonnegative(),
  })
  .strict();

const FlipV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    kind: z.literal('skillsmith.flip'),
    op: z.enum(['promote', 'dev', 'rollback']),
    dryRun: z.boolean(),
    summary: SummarySchema,
    selection: SelectionSchema,
    operations: z.array(OperationSchema),
    checks: z.array(CheckSchema),
    diagnostics: z.array(DiagnosticSchema),
    results: z.array(ExecutionResultSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const operationIds = new Set(value.operations.map((operation) => operation.operationId));
    const resultIds = new Set<string>();
    for (const [index, result] of value.results.entries()) {
      if (resultIds.has(result.operationId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['results', index, 'operationId'],
          message: 'execution result operation ID is duplicated',
        });
      }
      resultIds.add(result.operationId);
      if (!operationIds.has(result.operationId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['results', index, 'operationId'],
          message: 'execution result does not correlate to a planned operation',
        });
      }
    }
    if (value.dryRun && value.results.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['results'],
        message: 'dry-run reports cannot contain execution results',
      });
    } else if (
      !value.dryRun &&
      (value.results.length !== value.operations.length ||
        value.results.some(
          (result, index) => result.operationId !== value.operations[index]?.operationId,
        ))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['results'],
        message: 'execution results must exactly follow planned operation identity order',
      });
    }
  });

export type FlipV3Dto = z.infer<typeof FlipV3Schema>;

const uniqueGroupIds = (plan: NonNullable<FlipReport['plan']>): readonly string[] => {
  const selected = plan.selection.groupIds;
  if (selected !== undefined) return selected;
  return [...new Set(plan.operations.map((operation) => operation.groupId))];
};

/** Project the immutable runtime plan and its separate result sidecar into the strict flip@3 wire. */
export const toFlipV3Dto = (report: FlipReport): FlipV3Dto => {
  const plan = report.plan;
  const executionResults = report.executionResults;
  if (plan === undefined || executionResults === undefined) {
    throw new TypeError('flip@3 requires an immutable operation plan and execution-result sidecar');
  }
  return {
    schemaVersion: 3,
    kind: 'skillsmith.flip',
    op: report.op,
    dryRun: report.dryRun,
    summary: { ...report.summary },
    selection: {
      source: plan.selection.source,
      outcome:
        plan.selection.outcome ??
        (report.requested.all && plan.operations.length === 0 ? 'filter-noop' : 'selected'),
      targets: [...(plan.selection.targets ?? report.requested.targets)],
      all: plan.selection.all ?? report.requested.all,
      tools: [...plan.selection.tools],
      scopes: [...plan.selection.scopes],
      groupIds: [...uniqueGroupIds(plan)],
      batchPolicy: plan.batchPolicy,
    },
    operations: plan.operations.map((operation) => operation),
    checks: plan.checks.map((check) => check),
    diagnostics: plan.diagnostics.map((diagnostic) => diagnostic),
    results: executionResults.map((result) => result),
  } as unknown as FlipV3Dto;
};

export const flipV3Codec = createJsonWireCodec(
  {
    id: 'flip',
    version: 3,
    wireKind: 'skillsmith.flip',
    embeddedVersion: 'schemaVersion',
    unknownFields: 'reject-recursive',
    formatting: { indent: 2, terminalLf: false },
    migrations: [],
    compatibility: 'conservative',
  },
  FlipV3Schema,
);
