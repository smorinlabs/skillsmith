import { z } from 'zod';
import { SUPPORTED_TOOLS, type SupportedTool } from '../../agents/types.ts';
import { containsSensitiveMaterial } from '../../safety/redaction.ts';
import { createJsonWireCodec } from '../codec.ts';
import type { WireCodec } from '../types.ts';
import { planV1Codec } from './plan.ts';
import type { PlanCheckV1Dto, PlanDiagnosticV1Dto, PlanOperationV1Dto, PlanV1Dto } from './plan.ts';

export interface UpdateSelectionV1Dto {
  readonly selectionSource: 'bounded-default' | 'explicit-targets' | 'explicit-all';
  readonly selectionOutcome: 'selected' | 'filter-noop';
  readonly targets: readonly string[];
  readonly skills: readonly string[];
  readonly tools: readonly SupportedTool[];
  readonly groupIds: readonly string[];
}

export interface UpdateSourceFactV1Dto {
  readonly requestedRef: string | null;
  readonly kind: 'default' | 'branch' | 'tag' | 'sha';
  readonly resolvedSha: string;
  readonly contentHash: string;
}

export interface UpdateCandidateV1Dto {
  readonly groupId: string;
  readonly skill: string;
  readonly current: UpdateSourceFactV1Dto;
  readonly proposed: UpdateSourceFactV1Dto | null;
  readonly transition: 'preserve' | 'track' | 'pin';
  readonly outcome: 'current' | 'available' | 'skipped-fixed' | 'failed';
  readonly failure: { readonly code: string; readonly message: string } | null;
}

export interface UpdateVerificationV1Dto {
  readonly tool: SupportedTool;
  readonly mode: 'static' | 'static+deep';
  readonly gate: 'pending' | 'passed' | 'warned' | 'failed' | 'inconclusive' | 'skipped';
}

export interface UpdateGroupResultV1Dto {
  readonly groupId: string;
  readonly skill: string;
  readonly tools: readonly SupportedTool[];
  readonly verification: readonly UpdateVerificationV1Dto[];
  readonly action: 'update' | 'noop' | 'skip' | 'refuse';
  readonly outcome: 'planned' | 'succeeded' | 'failed' | 'cancelled' | 'skipped' | 'not-run';
  readonly skipReason: string | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
  readonly drift: { readonly artifact: boolean; readonly live: boolean };
}

export interface UpdateEffectV1Dto {
  readonly role: 'manifest' | 'lock' | 'store' | 'ledger' | 'live' | 'backup';
  readonly action: string;
  readonly operationId: string | null;
  readonly groupId: string;
  readonly outcome: 'planned' | 'succeeded' | 'failed' | 'cancelled' | 'not-run';
}

export interface UpdateSummaryV1Dto {
  readonly groups: number;
  readonly candidates: number;
  readonly current: number;
  readonly available: number;
  readonly skippedFixed: number;
  readonly candidateFailed: number;
  readonly planned: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly skipped: number;
  readonly notRun: number;
  readonly effects: number;
  readonly artifactDrift: number;
  readonly liveDrift: number;
  readonly refusals: number;
}

export interface UpdateReportV1Dto {
  readonly schemaVersion: 1;
  readonly kind: 'skillsmith.update';
  readonly command: 'update';
  readonly mode: 'check' | 'dry-run' | 'execute';
  readonly state: 'current' | 'changes-available' | 'ready' | 'refused' | 'completed' | 'partial';
  readonly artifactPair: {
    readonly manifestPath: string;
    readonly lockPath: string;
    readonly lockSource: 'sibling' | 'explicit';
    readonly selectionSource:
      | 'explicit'
      | 'discovered-project'
      | 'project-default'
      | 'user-default';
  };
  readonly options: {
    readonly all: boolean;
    readonly ref: string | null;
    readonly pin: boolean;
    readonly strict: boolean;
    readonly continueOnError: boolean;
  };
  readonly selection: UpdateSelectionV1Dto;
  readonly candidates: readonly UpdateCandidateV1Dto[];
  readonly operations: readonly PlanOperationV1Dto[];
  readonly checks: readonly PlanCheckV1Dto[];
  readonly diagnostics: readonly PlanDiagnosticV1Dto[];
  readonly approval: {
    readonly required: boolean;
    readonly outcome: 'not-required' | 'pending' | 'approved' | 'refused' | 'cancelled';
  };
  readonly groups: readonly UpdateGroupResultV1Dto[];
  readonly effects: readonly UpdateEffectV1Dto[];
  readonly summary: UpdateSummaryV1Dto;
}

const CountSchema = z.number().int().nonnegative();
const IdSchema = z.string().min(1);
const ToolSchema = z.enum(SUPPORTED_TOOLS);
const ShaSchema = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u);
const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const SourceFactSchema = z
  .object({
    requestedRef: z.string().min(1).nullable(),
    kind: z.enum(['default', 'branch', 'tag', 'sha']),
    resolvedSha: ShaSchema,
    contentHash: DigestSchema,
  })
  .strict();
const SelectionSchema = z
  .object({
    selectionSource: z.enum(['bounded-default', 'explicit-targets', 'explicit-all']),
    selectionOutcome: z.enum(['selected', 'filter-noop']),
    targets: z.array(z.string().min(1)),
    skills: z.array(z.string().min(1)),
    tools: z.array(ToolSchema),
    groupIds: z.array(IdSchema),
  })
  .strict();
const CandidateSchema = z
  .object({
    groupId: IdSchema,
    skill: z.string().min(1),
    current: SourceFactSchema,
    proposed: SourceFactSchema.nullable(),
    transition: z.enum(['preserve', 'track', 'pin']),
    outcome: z.enum(['current', 'available', 'skipped-fixed', 'failed']),
    failure: z
      .object({ code: IdSchema, message: z.string().min(1) })
      .strict()
      .nullable(),
  })
  .strict();
const VerificationSchema = z
  .object({
    tool: ToolSchema,
    mode: z.enum(['static', 'static+deep']),
    gate: z.enum(['pending', 'passed', 'warned', 'failed', 'inconclusive', 'skipped']),
  })
  .strict();
const GroupSchema = z
  .object({
    groupId: IdSchema,
    skill: z.string().min(1),
    tools: z.array(ToolSchema),
    verification: z.array(VerificationSchema),
    action: z.enum(['update', 'noop', 'skip', 'refuse']),
    outcome: z.enum(['planned', 'succeeded', 'failed', 'cancelled', 'skipped', 'not-run']),
    skipReason: z.string().min(1).nullable(),
    failure: z
      .object({ code: IdSchema, message: z.string().min(1) })
      .strict()
      .nullable(),
    drift: z.object({ artifact: z.boolean(), live: z.boolean() }).strict(),
  })
  .strict();
const EffectSchema = z
  .object({
    role: z.enum(['manifest', 'lock', 'store', 'ledger', 'live', 'backup']),
    action: z.string().min(1),
    operationId: IdSchema.nullable(),
    groupId: IdSchema,
    outcome: z.enum(['planned', 'succeeded', 'failed', 'cancelled', 'not-run']),
  })
  .strict();
const SummarySchema = z
  .object({
    groups: CountSchema,
    candidates: CountSchema,
    current: CountSchema,
    available: CountSchema,
    skippedFixed: CountSchema,
    candidateFailed: CountSchema,
    planned: CountSchema,
    succeeded: CountSchema,
    failed: CountSchema,
    cancelled: CountSchema,
    skipped: CountSchema,
    notRun: CountSchema,
    effects: CountSchema,
    artifactDrift: CountSchema,
    liveDrift: CountSchema,
    refusals: CountSchema,
  })
  .strict();

const countKinds = <Kind extends string>(
  kinds: readonly Kind[],
  rows: readonly Readonly<{ readonly kind: Kind }>[],
): Record<Kind, number> =>
  Object.fromEntries(
    kinds.map((kind) => [kind, rows.filter((row) => row.kind === kind).length]),
  ) as Record<Kind, number>;

const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;

const containsForbiddenOutput = (input: unknown): boolean => {
  if (typeof input === 'string') {
    return containsSensitiveMaterial(input) || /(?:https?|ssh):\/\//iu.test(input);
  }
  if (Array.isArray(input)) return input.some(containsForbiddenOutput);
  if (input === null || typeof input !== 'object') return false;
  return Object.values(input).some(containsForbiddenOutput);
};

const containsLocalDevelopmentSource = (input: unknown): boolean => {
  if (Array.isArray(input)) return input.some(containsLocalDevelopmentSource);
  if (input === null || typeof input !== 'object') return false;
  const value = input as Readonly<Record<string, unknown>>;
  return value.kind === 'local-dev' || Object.values(value).some(containsLocalDevelopmentSource);
};

const UpdateV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('skillsmith.update'),
    command: z.literal('update'),
    mode: z.enum(['check', 'dry-run', 'execute']),
    state: z.enum(['current', 'changes-available', 'ready', 'refused', 'completed', 'partial']),
    artifactPair: z
      .object({
        manifestPath: z.string().min(1),
        lockPath: z.string().min(1),
        lockSource: z.enum(['sibling', 'explicit']),
        selectionSource: z.enum([
          'explicit',
          'discovered-project',
          'project-default',
          'user-default',
        ]),
      })
      .strict(),
    options: z
      .object({
        all: z.boolean(),
        ref: z.string().min(1).nullable(),
        pin: z.boolean(),
        strict: z.boolean(),
        continueOnError: z.boolean(),
      })
      .strict(),
    selection: SelectionSchema,
    candidates: z.array(CandidateSchema),
    operations: z.array(z.custom<PlanOperationV1Dto>()),
    checks: z.array(z.custom<PlanCheckV1Dto>()),
    diagnostics: z.array(z.custom<PlanDiagnosticV1Dto>()),
    approval: z
      .object({
        required: z.boolean(),
        outcome: z.enum(['not-required', 'pending', 'approved', 'refused', 'cancelled']),
      })
      .strict(),
    groups: z.array(GroupSchema),
    effects: z.array(EffectSchema),
    summary: SummarySchema,
  })
  .strict()
  .superRefine((value, context) => {
    const operationGroupIds = new Set(value.operations.map(({ groupId }) => groupId));
    const projectedDiagnostics = value.diagnostics.map((diagnostic) =>
      diagnostic.correlation.groupId !== null &&
      diagnostic.correlation.operationId === null &&
      diagnostic.correlation.pairId === null &&
      !operationGroupIds.has(diagnostic.correlation.groupId)
        ? { ...diagnostic, correlation: { ...diagnostic.correlation, groupId: null } }
        : diagnostic,
    );
    const operationKinds = [
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
    ] as const;
    const checkKinds = [
      'source-resolution',
      'capability',
      'content-integrity',
      'verification',
      'precondition-validation',
    ] as const;
    const diagnosticKinds = ['noop', 'skip', 'refuse', 'conflict', 'warning'] as const;
    const planSummary: PlanV1Dto['summary'] = {
      operations: value.operations.length,
      checks: value.checks.length,
      diagnostics: value.diagnostics.length,
      drift: value.operations.length,
      refusals: value.diagnostics.filter(({ kind }) => kind === 'refuse').length,
      operationKinds: countKinds(operationKinds, value.operations),
      checkKinds: countKinds(checkKinds, value.checks),
      diagnosticKinds: countKinds(diagnosticKinds, value.diagnostics),
    };
    const scopes = [
      ...new Set(value.operations.flatMap(({ scope }) => (scope === null ? [] : [scope]))),
    ];
    const projection: PlanV1Dto = {
      schemaVersion: 1,
      kind: 'skillsmith.plan-report',
      command: 'plan',
      state: planSummary.refusals > 0 ? 'refused' : 'ready',
      artifactPair: value.artifactPair,
      project: { effectiveCwd: '<update>', root: null, identity: null },
      options: { locked: false, prune: false, check: value.mode === 'check' },
      selection: {
        selectionSource: value.selection.selectionSource,
        selectionOutcome: value.selection.selectionOutcome,
        requestedTools: value.selection.tools,
        requestedScope: null,
        skills: value.selection.skills,
        tools: value.selection.tools,
        scopes,
      },
      operations: value.operations,
      checks: value.checks,
      diagnostics: projectedDiagnostics,
      summary: planSummary,
      savedOutput: null,
    };
    const validated = planV1Codec.validate(projection);
    if (!validated.ok) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...validated.error.path],
        message: `update plan projection is invalid: ${validated.error.message}`,
      });
    }

    if (containsLocalDevelopmentSource(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'update reports cannot contain local-development source paths',
      });
    }
    if (containsForbiddenOutput(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'update reports cannot contain source URLs or credential material',
      });
    }

    const selectionSourceValid =
      (value.selection.selectionSource === 'explicit-targets' &&
        value.selection.targets.length > 0 &&
        !value.options.all) ||
      (value.selection.selectionSource === 'explicit-all' &&
        value.selection.targets.length === 0 &&
        value.options.all) ||
      (value.selection.selectionSource === 'bounded-default' &&
        value.selection.targets.length === 0 &&
        !value.options.all);
    if (
      !selectionSourceValid ||
      (value.options.ref !== null && value.selection.targets.length !== 1) ||
      (value.selection.selectionOutcome === 'filter-noop' && value.groups.length > 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selection'],
        message: 'update selection provenance and options are inconsistent',
      });
    }

    const groupIds = value.groups.map(({ groupId }) => groupId);
    const groupSkills = value.groups.map(({ skill }) => skill);
    const candidateIds = value.candidates.map(({ groupId }) => groupId);
    const candidateSkills = value.candidates.map(({ skill }) => skill);
    const vectorsMatch = (left: readonly string[], right: readonly string[]): boolean =>
      left.length === right.length && left.every((item, index) => item === right[index]);
    if (
      !unique(value.selection.groupIds) ||
      !unique(value.selection.skills) ||
      !unique(value.selection.tools) ||
      !vectorsMatch(value.selection.groupIds, groupIds) ||
      !vectorsMatch(value.selection.groupIds, candidateIds) ||
      !vectorsMatch(value.selection.skills, groupSkills) ||
      !vectorsMatch(value.selection.skills, candidateSkills)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selection'],
        message: 'update selection, candidate, and group identity is inconsistent',
      });
    }

    const selectedGroups = new Set(value.selection.groupIds);
    const selectedTools = new Set(value.selection.tools);
    const operationIds = new Set(value.operations.map(({ operationId }) => operationId));
    for (const [index, operation] of value.operations.entries()) {
      if (
        !selectedGroups.has(operation.groupId) ||
        (operation.kind !== 'update' &&
          operation.kind !== 'repair' &&
          operation.kind !== 'write-manifest' &&
          operation.kind !== 'write-lock')
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['operations', index],
          message:
            'update operation is outside the selected declaration groups or command vocabulary',
        });
      }
    }
    for (const [index, diagnostic] of value.diagnostics.entries()) {
      if (
        diagnostic.correlation.groupId !== null &&
        !selectedGroups.has(diagnostic.correlation.groupId)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['diagnostics', index, 'correlation', 'groupId'],
          message: 'update diagnostic references an unselected group',
        });
      }
    }
    for (const [index, effect] of value.effects.entries()) {
      if (
        !selectedGroups.has(effect.groupId) ||
        (effect.operationId !== null && !operationIds.has(effect.operationId))
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['effects', index],
          message: 'update effect references an unselected group or operation',
        });
      }
    }

    for (const [index, candidate] of value.candidates.entries()) {
      const proposedRequired = candidate.outcome === 'current' || candidate.outcome === 'available';
      const action = value.groups[index]?.action;
      const expectedAction = {
        current: 'noop',
        available: 'update',
        'skipped-fixed': 'skip',
        failed: 'refuse',
      }[candidate.outcome];
      const currentRefValid =
        (candidate.current.kind === 'default') === (candidate.current.requestedRef === null);
      const proposedRefValid =
        candidate.proposed === null ||
        (candidate.proposed.kind === 'default') === (candidate.proposed.requestedRef === null);
      if (
        (candidate.proposed !== null) !== proposedRequired ||
        (candidate.failure !== null) !== (candidate.outcome === 'failed') ||
        action !== expectedAction ||
        !currentRefValid ||
        !proposedRefValid
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['candidates', index],
          message: 'update candidate facts are inconsistent',
        });
      }
    }

    for (const [index, group] of value.groups.entries()) {
      const verificationTools = group.verification.map(({ tool }) => tool);
      if (
        !unique(group.tools) ||
        !unique(verificationTools) ||
        !vectorsMatch(group.tools, verificationTools) ||
        group.tools.some((tool) => !selectedTools.has(tool)) ||
        (group.outcome === 'failed') !== (group.failure !== null) ||
        (group.outcome === 'skipped') !== (group.skipReason !== null) ||
        ((value.mode === 'check' || value.mode === 'dry-run') &&
          group.verification.some(({ gate }) => gate === 'pending'))
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['groups', index],
          message: 'update group tools, outcome, or verification facts are inconsistent',
        });
      }
    }

    const mutatingGroups = value.groups.filter(({ action }) => action === 'update');
    const approvalRequired = value.mode === 'execute' && mutatingGroups.length > 1;
    const optionalApprovalValid =
      value.approval.outcome === 'not-required' ||
      (value.mode === 'execute' && value.approval.outcome === 'approved');
    if (
      value.approval.required !== approvalRequired ||
      (approvalRequired && value.approval.outcome === 'not-required') ||
      (!approvalRequired && !optionalApprovalValid) ||
      (value.approval.outcome === 'pending' && value.state !== 'ready') ||
      ((value.approval.outcome === 'refused' || value.approval.outcome === 'cancelled') &&
        value.state !== 'refused')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approval'],
        message: 'update approval facts are inconsistent',
      });
    }

    const candidateCounts = {
      current: value.candidates.filter(({ outcome }) => outcome === 'current').length,
      available: value.candidates.filter(({ outcome }) => outcome === 'available').length,
      skippedFixed: value.candidates.filter(({ outcome }) => outcome === 'skipped-fixed').length,
      candidateFailed: value.candidates.filter(({ outcome }) => outcome === 'failed').length,
    };
    const outcomeCounts = {
      planned: value.groups.filter(({ outcome }) => outcome === 'planned').length,
      succeeded: value.groups.filter(({ outcome }) => outcome === 'succeeded').length,
      failed: value.groups.filter(({ outcome }) => outcome === 'failed').length,
      cancelled: value.groups.filter(({ outcome }) => outcome === 'cancelled').length,
      skipped: value.groups.filter(({ outcome }) => outcome === 'skipped').length,
      notRun: value.groups.filter(({ outcome }) => outcome === 'not-run').length,
    };
    const summaryInvalid =
      value.summary.groups !== value.groups.length ||
      value.summary.candidates !== value.candidates.length ||
      value.summary.effects !== value.effects.length ||
      value.summary.artifactDrift !== value.groups.filter(({ drift }) => drift.artifact).length ||
      value.summary.liveDrift !== value.groups.filter(({ drift }) => drift.live).length ||
      value.summary.refusals !== value.diagnostics.filter(({ kind }) => kind === 'refuse').length ||
      Object.entries(candidateCounts).some(
        ([name, count]) => value.summary[name as keyof typeof candidateCounts] !== count,
      ) ||
      Object.entries(outcomeCounts).some(
        ([name, count]) => value.summary[name as keyof typeof outcomeCounts] !== count,
      );
    if (summaryInvalid) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['summary'],
        message: 'update summary is inconsistent',
      });
    }

    const hasChanges = candidateCounts.available > 0;
    const stateValid =
      (value.mode === 'check' &&
        ['current', 'changes-available', 'refused', 'partial'].includes(value.state) &&
        (value.state !== 'current' || !hasChanges) &&
        (value.state !== 'changes-available' || hasChanges)) ||
      (value.mode === 'dry-run' &&
        ['current', 'ready', 'refused', 'partial'].includes(value.state) &&
        (value.state !== 'current' || !hasChanges) &&
        (value.state !== 'ready' || hasChanges)) ||
      (value.mode === 'execute' &&
        ['current', 'ready', 'refused', 'completed', 'partial'].includes(value.state));
    if (!stateValid) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['state'],
        message: 'update mode, state, and candidate outcomes are inconsistent',
      });
    }
  });

export const updateV1Codec = createJsonWireCodec(
  {
    id: 'update',
    version: 1,
    wireKind: 'skillsmith.update',
    embeddedVersion: 'schemaVersion',
    unknownFields: 'reject-recursive',
    formatting: { indent: 2, terminalLf: true },
    migrations: [],
    compatibility: 'conservative',
  } as const,
  UpdateV1Schema,
) as unknown as WireCodec<'update', 1, UpdateReportV1Dto>;
