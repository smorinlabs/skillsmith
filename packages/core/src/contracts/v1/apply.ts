import { z } from 'zod';
import { createJsonWireCodec } from '../codec.ts';
import type { WireCodec } from '../types.ts';
import { planV1Codec } from './plan.ts';
import type { PlanCheckV1Dto, PlanDiagnosticV1Dto, PlanOperationV1Dto, PlanV1Dto } from './plan.ts';

export type ApplyModeV1 =
  | 'fresh-execute'
  | 'fresh-dry-run'
  | 'fresh-check'
  | 'saved-execute'
  | 'saved-dry-run'
  | 'saved-check';

export interface ApplyOperationResultV1Dto {
  readonly operationId: string;
  readonly outcome: 'succeeded' | 'failed' | 'cancelled' | 'rolled-back' | 'skipped';
  readonly reason: string | null;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly remediation: string;
  } | null;
}

export interface ApplyReportV1Dto {
  readonly schemaVersion: 1;
  readonly kind: 'skillsmith.apply-report';
  readonly command: 'apply';
  readonly mode: ApplyModeV1;
  readonly state: 'ready' | 'refused' | 'completed' | 'partial';
  readonly artifactPair: PlanV1Dto['artifactPair'] | null;
  readonly savedPlan: {
    readonly path: string;
    readonly portability: 'portable' | 'machine-bound';
    readonly executorSchemaVersion: 1;
    readonly hashSchemaVersion: 1;
  } | null;
  readonly project: PlanV1Dto['project'];
  readonly options: {
    readonly locked: boolean;
    readonly prune: boolean;
    readonly check: boolean;
    readonly dryRun: boolean;
    readonly continueOnError: boolean;
  };
  readonly selection: PlanV1Dto['selection'];
  readonly operations: PlanOperationV1Dto[];
  readonly checks: PlanCheckV1Dto[];
  readonly diagnostics: PlanDiagnosticV1Dto[];
  readonly approval: {
    readonly required: boolean;
    readonly outcome:
      | 'not-required'
      | 'pending'
      | 'approved'
      | 'refused'
      | 'cancelled'
      | 'prior-authorization';
  };
  readonly validation: {
    readonly outcome: 'not-run' | 'valid' | 'stale' | 'incompatible';
    readonly replanned: false;
  };
  readonly results: ApplyOperationResultV1Dto[];
  readonly summary: PlanV1Dto['summary'] & {
    readonly succeeded: number;
    readonly failed: number;
    readonly cancelled: number;
    readonly rolledBack: number;
    readonly skipped: number;
  };
}

const CountSchema = z.number().int().nonnegative();
const PlanArtifactPairSchema = z.custom<PlanV1Dto['artifactPair']>();
const PlanProjectSchema = z.custom<PlanV1Dto['project']>();
const PlanSelectionSchema = z.custom<PlanV1Dto['selection']>();
const PlanOperationSchema = z.custom<PlanOperationV1Dto>();
const PlanCheckSchema = z.custom<PlanCheckV1Dto>();
const PlanDiagnosticSchema = z.custom<PlanDiagnosticV1Dto>();
const OperationKindCountsSchema = z
  .object({
    install: CountSchema,
    update: CountSchema,
    remove: CountSchema,
    'link-dev': CountSchema,
    promote: CountSchema,
    'move-scope': CountSchema,
    adapt: CountSchema,
    repair: CountSchema,
    'write-manifest': CountSchema,
    'write-lock': CountSchema,
    'migrate-project-config': CountSchema,
    'migrate-ledger': CountSchema,
  })
  .strict();
const CheckKindCountsSchema = z
  .object({
    'source-resolution': CountSchema,
    capability: CountSchema,
    'content-integrity': CountSchema,
    verification: CountSchema,
    'precondition-validation': CountSchema,
  })
  .strict();
const DiagnosticKindCountsSchema = z
  .object({
    noop: CountSchema,
    skip: CountSchema,
    refuse: CountSchema,
    conflict: CountSchema,
    warning: CountSchema,
  })
  .strict();

const ApplyV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('skillsmith.apply-report'),
    command: z.literal('apply'),
    mode: z.enum([
      'fresh-execute',
      'fresh-dry-run',
      'fresh-check',
      'saved-execute',
      'saved-dry-run',
      'saved-check',
    ]),
    state: z.enum(['ready', 'refused', 'completed', 'partial']),
    artifactPair: PlanArtifactPairSchema.nullable(),
    savedPlan: z
      .object({
        path: z.string().min(1),
        portability: z.enum(['portable', 'machine-bound']),
        executorSchemaVersion: z.literal(1),
        hashSchemaVersion: z.literal(1),
      })
      .strict()
      .nullable(),
    project: PlanProjectSchema,
    options: z
      .object({
        locked: z.boolean(),
        prune: z.boolean(),
        check: z.boolean(),
        dryRun: z.boolean(),
        continueOnError: z.boolean(),
      })
      .strict(),
    selection: PlanSelectionSchema,
    operations: z.array(PlanOperationSchema),
    checks: z.array(PlanCheckSchema),
    diagnostics: z.array(PlanDiagnosticSchema),
    approval: z
      .object({
        required: z.boolean(),
        outcome: z.enum([
          'not-required',
          'pending',
          'approved',
          'refused',
          'cancelled',
          'prior-authorization',
        ]),
      })
      .strict(),
    validation: z
      .object({
        outcome: z.enum(['not-run', 'valid', 'stale', 'incompatible']),
        replanned: z.literal(false),
      })
      .strict(),
    results: z.array(
      z
        .object({
          operationId: z.string().min(1),
          outcome: z.enum(['succeeded', 'failed', 'cancelled', 'rolled-back', 'skipped']),
          reason: z.string().min(1).nullable(),
          error: z
            .object({
              code: z.string().min(1),
              message: z.string().min(1),
              remediation: z.string().min(1),
            })
            .strict()
            .nullable(),
        })
        .strict(),
    ),
    summary: z
      .object({
        operations: CountSchema,
        checks: CountSchema,
        diagnostics: CountSchema,
        drift: CountSchema,
        refusals: CountSchema,
        operationKinds: OperationKindCountsSchema,
        checkKinds: CheckKindCountsSchema,
        diagnosticKinds: DiagnosticKindCountsSchema,
        succeeded: CountSchema,
        failed: CountSchema,
        cancelled: CountSchema,
        rolledBack: CountSchema,
        skipped: CountSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const planSummary: PlanV1Dto['summary'] = {
      operations: value.summary.operations,
      checks: value.summary.checks,
      diagnostics: value.summary.diagnostics,
      drift: value.summary.drift,
      refusals: value.summary.refusals,
      operationKinds: value.summary.operationKinds,
      checkKinds: value.summary.checkKinds,
      diagnosticKinds: value.summary.diagnosticKinds,
    };
    const planProjection: PlanV1Dto = {
      schemaVersion: 1,
      kind: 'skillsmith.plan-report',
      command: 'plan',
      state: planSummary.refusals > 0 ? 'refused' : 'ready',
      artifactPair: value.artifactPair ?? {
        manifestPath: '<saved-plan>',
        lockPath: '<saved-plan>',
        lockSource: 'sibling',
        selectionSource: 'explicit',
      },
      project: value.project,
      options: {
        locked: value.options.locked,
        prune: value.options.prune,
        check: value.options.check,
      },
      selection: value.selection,
      operations: value.operations,
      checks: value.checks,
      diagnostics: value.diagnostics,
      summary: planSummary,
      savedOutput: null,
    };
    const validatedProjection = planV1Codec.validate(planProjection);
    if (!validatedProjection.ok) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...validatedProjection.error.path],
        message: `apply plan projection is invalid: ${validatedProjection.error.message}`,
      });
    }

    const savedMode = value.mode.startsWith('saved-');
    const executeMode = value.mode.endsWith('-execute');
    const dryRunMode = value.mode.endsWith('-dry-run');
    const checkMode = value.mode.endsWith('-check');
    if ((value.savedPlan !== null) !== savedMode || (value.artifactPair === null) !== savedMode) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'apply mode does not match its artifact selection',
      });
    }
    if (
      value.options.dryRun !== dryRunMode ||
      value.options.check !== checkMode ||
      (executeMode && (value.options.dryRun || value.options.check))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'apply mode does not match its validation-mode options',
      });
    }
    if (savedMode && value.options.continueOnError) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options', 'continueOnError'],
        message: 'saved apply uses schema-v1 implicit fail-fast execution',
      });
    }

    const approvalRequiresConfirmation = ['pending', 'approved', 'refused', 'cancelled'].includes(
      value.approval.outcome,
    );
    if (value.approval.required !== approvalRequiresConfirmation) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approval'],
        message: 'apply approval requirement and outcome are inconsistent',
      });
    }
    if (savedMode && value.approval.outcome !== 'prior-authorization') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approval', 'outcome'],
        message: 'saved apply requires prior authorization',
      });
    }
    if (!savedMode && value.approval.outcome === 'prior-authorization') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approval', 'outcome'],
        message: 'fresh apply cannot claim saved-plan prior authorization',
      });
    }
    if (!savedMode && value.validation.outcome === 'incompatible') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['validation', 'outcome'],
        message: 'fresh apply cannot have saved-plan incompatibility',
      });
    }

    const operationIds = value.operations.map(({ operationId }) => operationId);
    const resultIds = value.results.map(({ operationId }) => operationId);
    if (
      new Set(resultIds).size !== resultIds.length ||
      resultIds.some((operationId, index) => operationId !== operationIds[index])
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['results'],
        message: 'apply results must preserve exact operation order',
      });
    }
    const noResults = value.results.length === 0;
    const fullSuccess =
      value.results.length === value.operations.length &&
      value.results.every(({ outcome }) => outcome === 'succeeded');
    const truthfulPartial =
      value.operations.length > 0 &&
      value.results.length > 0 &&
      value.results.length <= value.operations.length &&
      value.results.some(({ outcome }) => outcome !== 'succeeded');
    if ((value.state === 'ready' || value.state === 'refused') && !noResults) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['results'],
        message: 'ready or refused apply cannot carry execution results',
      });
    }
    if (value.state === 'completed' && !fullSuccess) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['results'],
        message: 'completed apply requires one successful result per operation',
      });
    }
    if (value.state === 'partial' && !truthfulPartial) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['results'],
        message: 'partial apply requires a nonempty exact prefix with a non-success outcome',
      });
    }

    const approval = value.approval;
    const validation = value.validation.outcome;
    const operationCount = value.operations.length;
    let lifecycleValid = false;
    if (!executeMode && !savedMode) {
      lifecycleValid =
        (value.state === 'ready' || value.state === 'refused') &&
        !approval.required &&
        approval.outcome === 'not-required' &&
        validation === 'not-run' &&
        noResults;
    } else if (!executeMode && savedMode) {
      lifecycleValid =
        !approval.required &&
        approval.outcome === 'prior-authorization' &&
        noResults &&
        ((validation === 'valid' && value.state === 'ready') ||
          ((validation === 'stale' || validation === 'incompatible') && value.state === 'refused'));
    } else if (executeMode && !savedMode) {
      if (value.state === 'ready') {
        lifecycleValid =
          operationCount > 0 &&
          approval.required &&
          approval.outcome === 'pending' &&
          validation === 'not-run' &&
          noResults;
      } else if (value.state === 'refused') {
        lifecycleValid =
          noResults &&
          ((!approval.required &&
            approval.outcome === 'not-required' &&
            (validation === 'not-run' || (operationCount > 0 && validation === 'stale'))) ||
            (operationCount > 0 &&
              approval.required &&
              (approval.outcome === 'refused' || approval.outcome === 'cancelled') &&
              validation === 'valid') ||
            (operationCount > 0 &&
              approval.required &&
              approval.outcome === 'approved' &&
              (validation === 'valid' || validation === 'stale')));
      } else if (value.state === 'completed') {
        lifecycleValid =
          (operationCount === 0 &&
            !approval.required &&
            approval.outcome === 'not-required' &&
            validation === 'not-run') ||
          (operationCount > 0 &&
            approval.required &&
            approval.outcome === 'approved' &&
            validation === 'valid');
      } else {
        lifecycleValid =
          operationCount > 0 &&
          approval.required &&
          approval.outcome === 'approved' &&
          validation === 'valid';
      }
    } else if (executeMode && savedMode) {
      lifecycleValid =
        !approval.required &&
        approval.outcome === 'prior-authorization' &&
        ((value.state === 'refused' &&
          noResults &&
          (validation === 'valid' || validation === 'stale' || validation === 'incompatible')) ||
          ((value.state === 'completed' || value.state === 'partial') && validation === 'valid'));
    }
    if (!lifecycleValid) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'apply mode, state, approval, validation, and results are inconsistent',
      });
    }

    const outcomeCounts = {
      succeeded: value.results.filter(({ outcome }) => outcome === 'succeeded').length,
      failed: value.results.filter(({ outcome }) => outcome === 'failed').length,
      cancelled: value.results.filter(({ outcome }) => outcome === 'cancelled').length,
      rolledBack: value.results.filter(({ outcome }) => outcome === 'rolled-back').length,
      skipped: value.results.filter(({ outcome }) => outcome === 'skipped').length,
    };
    if (
      Object.entries(outcomeCounts).some(
        ([outcome, count]) => value.summary[outcome as keyof typeof outcomeCounts] !== count,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['summary'],
        message: 'apply execution summary is inconsistent',
      });
    }
    for (const [index, result] of value.results.entries()) {
      if ((result.outcome === 'failed') !== (result.error !== null)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['results', index, 'error'],
          message: 'only failed apply results carry an error',
        });
      }
    }
  });

export const applyV1Codec = createJsonWireCodec(
  {
    id: 'apply-report',
    version: 1,
    wireKind: 'skillsmith.apply-report',
    embeddedVersion: 'schemaVersion',
    unknownFields: 'reject-recursive',
    formatting: { indent: 2, terminalLf: true },
    migrations: [],
    compatibility: 'conservative',
  } as const,
  ApplyV1Schema,
) as unknown as WireCodec<'apply-report', 1, ApplyReportV1Dto>;
