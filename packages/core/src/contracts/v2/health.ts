import { z } from 'zod';
import type { Deprecation } from '../../application/types.ts';
import type { DoctorRunResult } from '../../doctor/types.ts';
import { createJsonWireCodec } from '../codec.ts';

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u) as z.ZodType<`sha256:${string}`>;
const operationId = z
  .string()
  .regex(/^operation:v1:[0-9a-f]{64}$/u) as z.ZodType<`operation:v1:${string}`>;
const findingId = z
  .string()
  .regex(/^finding:v1:[0-9a-f]{64}$/u) as z.ZodType<`finding:v1:${string}`>;
const counter = z.number().int().nonnegative().safe();

const FindingV2Schema = z
  .object({
    findingId,
    checkId: z.string(),
    severity: z.enum(['error', 'warning', 'info']),
    title: z.string(),
    message: z.string(),
    remediation: z.string().optional(),
    tool: z.string().optional(),
    scope: z.string().optional(),
    path: z.string().optional(),
    operation: z.string().optional(),
    reason: z.string().optional(),
    scopeInUse: z.boolean().optional(),
  })
  .strict();

const ArtifactSummarySchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('absent'),
      schemaVersion: z.null(),
      byteRevision: z.null(),
      semanticRevision: z.null(),
    })
    .strict(),
  z
    .object({
      state: z.literal('present'),
      schemaVersion: z.number().int().positive().nullable(),
      byteRevision: digest,
      semanticRevision: digest.nullable(),
    })
    .strict(),
]);

const RepairOperationSchema = z
  .object({
    operationId,
    kind: z.enum(['migrate-ledger', 'migrate-project-config', 'write-lock']),
    artifact: z.enum(['ledger', 'manifest', 'lock']),
    path: z.string().min(1),
    before: ArtifactSummarySchema,
    after: ArtifactSummarySchema,
    findingIds: z.array(findingId),
  })
  .strict()
  .superRefine((operation, context) => {
    if (
      operation.findingIds.length === 0 ||
      new Set(operation.findingIds).size !== operation.findingIds.length ||
      operation.findingIds.some((id, index) => {
        const previous = operation.findingIds[index - 1];
        return index > 0 && previous !== undefined && id < previous;
      })
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'finding IDs must be sorted unique',
      });
    }
    const before = operation.before;
    const after = operation.after;
    const valid =
      after.state === 'present' &&
      after.semanticRevision !== null &&
      ((operation.kind === 'migrate-ledger' &&
        operation.artifact === 'ledger' &&
        before.state === 'present' &&
        before.schemaVersion === 1 &&
        before.semanticRevision !== null &&
        after.schemaVersion === 2) ||
        (operation.kind === 'migrate-project-config' &&
          operation.artifact === 'manifest' &&
          before.state === 'present' &&
          before.schemaVersion === null &&
          before.semanticRevision !== null &&
          after.schemaVersion === 1) ||
        (operation.kind === 'write-lock' &&
          operation.artifact === 'lock' &&
          (before.state === 'absent' ||
            (before.schemaVersion === null && before.semanticRevision === null) ||
            (before.schemaVersion === 1 && before.semanticRevision !== null)) &&
          after.schemaVersion === 1));
    if (!valid) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'repair artifact transition is invalid',
      });
    }
  });

const SanitizedErrorSchema = z
  .object({ code: z.string().min(1), message: z.string().min(1), remediation: z.string().min(1) })
  .strict();

const RepairResultSchema = z
  .object({
    operationId,
    outcome: z.enum(['changed', 'unchanged', 'failed']),
    error: SanitizedErrorSchema.nullable(),
  })
  .strict()
  .superRefine((result, context) => {
    if ((result.outcome === 'failed') !== (result.error !== null)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'failed results require an error' });
    }
  });

const DeprecationV1Schema = z
  .object({
    spelling: z.string(),
    replacement: z.string(),
    removalVersion: z.string(),
    message: z.string(),
  })
  .strict();

const HealthV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    experimental: z.literal(true),
    findings: z.array(FindingV2Schema),
    counts: z.object({ ok: counter, warning: counter, error: counter }).strict(),
    repair: z
      .object({
        mode: z.enum(['not-requested', 'preview', 'execute']),
        operations: z.array(RepairOperationSchema),
        results: z.array(RepairResultSchema),
      })
      .strict(),
    mutation: z
      .object({
        kind: z.enum(['none', 'preview', 'applied']),
        planned: counter,
        changed: counter,
        unchanged: counter,
        failed: counter,
      })
      .strict(),
    deprecations: z.array(DeprecationV1Schema).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.findings.map((finding) => finding.findingId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'finding IDs must be unique' });
    }
    const knownFindings = new Set(ids);
    const operationIds = value.repair.operations.map((operation) => operation.operationId);
    if (
      new Set(operationIds).size !== operationIds.length ||
      value.repair.operations.some((operation) =>
        operation.findingIds.some((id) => !knownFindings.has(id)),
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'repair identity correlation is invalid',
      });
    }
    const expectedResults = value.repair.mode === 'execute' ? operationIds : [];
    if (
      value.repair.results.length !== expectedResults.length ||
      value.repair.results.some((result, index) => result.operationId !== expectedResults[index])
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'repair results are not correlated',
      });
    }
    const changed = value.repair.results.filter((result) => result.outcome === 'changed').length;
    const unchanged = value.repair.results.filter(
      (result) => result.outcome === 'unchanged',
    ).length;
    const failed = value.repair.results.filter((result) => result.outcome === 'failed').length;
    const planned = operationIds.length;
    const validMutation =
      (value.repair.mode === 'not-requested' &&
        value.mutation.kind === 'none' &&
        planned === 0 &&
        value.mutation.planned === 0 &&
        changed === 0 &&
        unchanged === 0 &&
        failed === 0) ||
      (value.repair.mode === 'preview' &&
        value.mutation.kind === (planned === 0 ? 'none' : 'preview') &&
        value.mutation.planned === planned &&
        value.mutation.changed === 0 &&
        value.mutation.unchanged === 0 &&
        value.mutation.failed === 0) ||
      (value.repair.mode === 'execute' &&
        value.mutation.kind === (planned === 0 ? 'none' : 'applied') &&
        value.mutation.planned === planned &&
        value.mutation.changed === changed &&
        value.mutation.unchanged === unchanged &&
        value.mutation.failed === failed &&
        changed + unchanged + failed === planned);
    if (!validMutation) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'mutation summary is inconsistent',
      });
    }
  });

export type HealthV2Dto = z.infer<typeof HealthV2Schema>;

export const toHealthV2Dto = (
  result: DoctorRunResult,
  deprecations: readonly Deprecation[] = [],
): HealthV2Dto => {
  const dto = {
    schemaVersion: 2 as const,
    experimental: true as const,
    findings: result.findings.map((finding) => {
      const projected: Record<string, unknown> = {
        findingId: finding.findingId,
        checkId: finding.checkId,
        severity: finding.severity,
        title: finding.title,
        message: finding.message,
      };
      for (const key of [
        'remediation',
        'tool',
        'scope',
        'path',
        'operation',
        'reason',
        'scopeInUse',
      ] as const) {
        if (finding[key] !== undefined) projected[key] = finding[key];
      }
      return projected;
    }),
    counts: { ...result.counts },
    repair: {
      mode: result.repair.mode,
      operations: result.repair.operations.map((operation) => ({
        ...operation,
        before: { ...operation.before },
        after: { ...operation.after },
        findingIds: [...operation.findingIds],
      })),
      results: result.repair.results.map((repairResult) => ({
        ...repairResult,
        error: repairResult.error === null ? null : { ...repairResult.error },
      })),
    },
    mutation: { ...result.mutation },
    ...(deprecations.length === 0
      ? {}
      : { deprecations: deprecations.map((deprecation) => ({ ...deprecation })) }),
  };
  return HealthV2Schema.parse(dto);
};

export const healthV2Codec = createJsonWireCodec(
  {
    id: 'health',
    version: 2,
    wireKind: null,
    embeddedVersion: 'schemaVersion',
    unknownFields: 'reject-recursive',
    formatting: { indent: 2, terminalLf: false },
    migrations: [],
    compatibility: 'conservative',
  },
  HealthV2Schema,
);
