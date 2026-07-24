import { z } from 'zod';
import { toolRegistry } from '../../agents/registry.ts';
import { containsSensitiveMaterial } from '../../safety/redaction.ts';
import type { UndoReport, UndoTool } from '../../undo/types.ts';
import { createJsonWireCodec } from '../codec.ts';
import type { WireCodec } from '../types.ts';
import { planV1Codec } from './plan.ts';
import type { PlanCheckV1Dto, PlanDiagnosticV1Dto, PlanOperationV1Dto, PlanV1Dto } from './plan.ts';

export interface UndoSelectionV1Dto {
  readonly source: 'explicit-targets' | 'explicit-all';
  readonly outcome: 'selected' | 'filter-zero';
  readonly targets: readonly string[];
  readonly all: boolean;
  readonly tools: readonly UndoTool[];
  readonly scopes: readonly ('user' | 'project')[];
  readonly groupIds: readonly string[];
  readonly batchPolicy: 'fail-fast' | 'continue-on-error';
}

export interface UndoPairV1Dto {
  readonly pairId: string;
  readonly tool: UndoTool;
  readonly path: string;
  readonly action: 'abort-pending' | 'reverse-committed';
  readonly operationFamily: 'dev' | 'promote' | 'install' | 'uninstall' | 'update';
  readonly disposition: 'rollback';
  readonly phase: 'prepared' | 'staged' | 'backed-up' | 'live' | 'committed';
  readonly executionMode: 'convert-to-rollback' | 'resume-rollback';
  readonly sourceTransactionId: string;
  readonly activeTransactionId: string;
  readonly sourceOperationId: string;
  readonly activeOperationId: string;
  readonly parentOperationId: string | null;
  readonly beforeState: 'absent' | 'dev' | 'pinned';
  readonly eligibility: 'eligible' | 'already-reversed';
  readonly retention: {
    readonly required: boolean;
    readonly resourceIds: readonly string[];
  };
  readonly operations: readonly string[];
  readonly outcome:
    | 'planned'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'not-run'
    | 'already-reversed';
  readonly failure: { readonly code: string; readonly message: string } | null;
}

export interface UndoGroupV1Dto {
  readonly groupId: string;
  readonly skill: string;
  readonly scope: 'user' | 'project';
  readonly pairs: readonly UndoPairV1Dto[];
  readonly operations: readonly string[];
  readonly outcome:
    | 'planned'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'not-run'
    | 'already-reversed';
  readonly failure: { readonly code: string; readonly message: string } | null;
}

export interface UndoOperationResultV1Dto {
  readonly operationId: string;
  readonly outcome: 'succeeded' | 'failed' | 'cancelled' | 'rolled-back' | 'skipped-after-failure';
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly remediation: string;
  } | null;
}

export interface UndoEffectV1Dto {
  readonly role: 'ledger' | 'store' | 'live' | 'backup';
  readonly action: string;
  readonly operationId: string | null;
  readonly groupId: string;
  readonly outcome: 'planned' | 'succeeded' | 'failed' | 'cancelled' | 'not-run';
}

export interface UndoSummaryV1Dto {
  readonly selected: number;
  readonly actionable: number;
  readonly alreadyReversed: number;
  readonly planned: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly skipped: number;
  readonly notRun: number;
  readonly effects: number;
  readonly refusals: number;
}

/** Exact operation wire shared with flip@4; plan@1's `dependsOn` alias is not emitted here. */
export type UndoOperationV1Dto = Omit<PlanOperationV1Dto, 'dependsOn'> & {
  readonly dependencyMetadata: {
    readonly domain: 'skillsmith.operation-dependency';
    readonly schemaVersion: 1;
    readonly operationIds: readonly string[];
  };
};

export interface UndoReportV1Dto {
  readonly schemaVersion: 1;
  readonly kind: 'skillsmith.undo';
  readonly command: 'undo';
  readonly mode: 'dry-run' | 'execute';
  readonly state: 'ready' | 'refused' | 'completed' | 'partial';
  readonly project: {
    readonly effectiveCwd: string;
    readonly root: string | null;
    readonly identity: string | null;
  };
  readonly selection: UndoSelectionV1Dto;
  readonly approval: {
    readonly required: boolean;
    readonly outcome: 'not-required' | 'pending' | 'approved' | 'refused' | 'cancelled';
  };
  readonly groups: readonly UndoGroupV1Dto[];
  readonly operations: readonly UndoOperationV1Dto[];
  readonly checks: readonly PlanCheckV1Dto[];
  readonly results: readonly UndoOperationResultV1Dto[];
  readonly effects: readonly UndoEffectV1Dto[];
  readonly diagnostics: readonly PlanDiagnosticV1Dto[];
  readonly summary: UndoSummaryV1Dto;
}

const IdSchema = z.string().min(1);
const CountSchema = z.number().int().nonnegative();
const UNDO_TOOLS = Object.freeze([...toolRegistry.toolsFor('undo')]) as readonly [
  UndoTool,
  ...UndoTool[],
];
const UNDO_TOOL_ORDER = new Map(UNDO_TOOLS.map((tool, index) => [tool, index] as const));
const ToolSchema = z.enum(UNDO_TOOLS);
const ScopeSchema = z.enum(['user', 'project']);
const FailureSchema = z.object({ code: IdSchema, message: z.string().min(1) }).strict();
const DependencySchema = z
  .object({
    domain: z.literal('skillsmith.operation-dependency'),
    schemaVersion: z.literal(1),
    operationIds: z.array(IdSchema),
  })
  .strict();
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const hasExactDependencyMetadata = (value: unknown): boolean => {
  if (!isRecord(value) || Object.hasOwn(value, 'dependsOn')) return false;
  const dependency = value.dependencyMetadata;
  return DependencySchema.safeParse(dependency).success;
};
const UndoOperationSchema = z.custom<UndoOperationV1Dto>(hasExactDependencyMetadata, {
  message: 'undo operations require exact dependencyMetadata and forbid dependsOn',
});
const SelectionSchema = z
  .object({
    source: z.enum(['explicit-targets', 'explicit-all']),
    outcome: z.enum(['selected', 'filter-zero']),
    targets: z.array(z.string().min(1)),
    all: z.boolean(),
    tools: z.array(ToolSchema),
    scopes: z.array(ScopeSchema),
    groupIds: z.array(IdSchema),
    batchPolicy: z.enum(['fail-fast', 'continue-on-error']),
  })
  .strict();
const PairSchema = z
  .object({
    pairId: IdSchema,
    tool: ToolSchema,
    path: z.string().min(1),
    action: z.enum(['abort-pending', 'reverse-committed']),
    operationFamily: z.enum(['dev', 'promote', 'install', 'uninstall', 'update']),
    disposition: z.literal('rollback'),
    phase: z.enum(['prepared', 'staged', 'backed-up', 'live', 'committed']),
    executionMode: z.enum(['convert-to-rollback', 'resume-rollback']),
    sourceTransactionId: IdSchema,
    activeTransactionId: IdSchema,
    sourceOperationId: IdSchema,
    activeOperationId: IdSchema,
    parentOperationId: IdSchema.nullable(),
    beforeState: z.enum(['absent', 'dev', 'pinned']),
    eligibility: z.enum(['eligible', 'already-reversed']),
    retention: z.object({ required: z.boolean(), resourceIds: z.array(IdSchema) }).strict(),
    operations: z.array(IdSchema),
    outcome: z.enum(['planned', 'succeeded', 'failed', 'cancelled', 'not-run', 'already-reversed']),
    failure: FailureSchema.nullable(),
  })
  .strict();
const GroupSchema = z
  .object({
    groupId: IdSchema,
    skill: z.string().min(1),
    scope: ScopeSchema,
    pairs: z.array(PairSchema).min(1),
    operations: z.array(IdSchema),
    outcome: z.enum(['planned', 'succeeded', 'failed', 'cancelled', 'not-run', 'already-reversed']),
    failure: FailureSchema.nullable(),
  })
  .strict();
const ResultSchema = z
  .object({
    operationId: IdSchema,
    outcome: z.enum(['succeeded', 'failed', 'cancelled', 'rolled-back', 'skipped-after-failure']),
    error: z
      .object({ code: IdSchema, message: z.string().min(1), remediation: z.string() })
      .strict()
      .nullable(),
  })
  .strict();
const EffectSchema = z
  .object({
    role: z.enum(['ledger', 'store', 'live', 'backup']),
    action: z.string().min(1),
    operationId: IdSchema.nullable(),
    groupId: IdSchema,
    outcome: z.enum(['planned', 'succeeded', 'failed', 'cancelled', 'not-run']),
  })
  .strict();
const SummarySchema = z
  .object({
    selected: CountSchema,
    actionable: CountSchema,
    alreadyReversed: CountSchema,
    planned: CountSchema,
    succeeded: CountSchema,
    failed: CountSchema,
    cancelled: CountSchema,
    skipped: CountSchema,
    notRun: CountSchema,
    effects: CountSchema,
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
const vectorsMatch = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);
const toolOrder = (tool: UndoTool): number => UNDO_TOOL_ORDER.get(tool) ?? Number.MAX_SAFE_INTEGER;
const pairAggregateOutcome = (pairs: readonly UndoPairV1Dto[]): UndoGroupV1Dto['outcome'] => {
  const precedence: Readonly<Record<UndoGroupV1Dto['outcome'], number>> = {
    failed: 6,
    cancelled: 5,
    'not-run': 4,
    succeeded: 3,
    planned: 2,
    'already-reversed': 1,
  };
  return pairs.reduce<UndoGroupV1Dto['outcome']>(
    (selected, pair) => (precedence[pair.outcome] > precedence[selected] ? pair.outcome : selected),
    'already-reversed',
  );
};
const groupReduction = (
  group: UndoGroupV1Dto,
  pairs: readonly UndoPairV1Dto[],
  results: ReadonlyMap<string, UndoOperationResultV1Dto>,
  reduce: boolean,
): Readonly<{
  outcome: UndoGroupV1Dto['outcome'];
  failure: UndoGroupV1Dto['failure'];
}> => {
  if (!reduce) return { outcome: pairAggregateOutcome(pairs), failure: null };
  const own = group.operations.map((operationId) => results.get(operationId));
  const failed = own.find(
    (result): result is UndoOperationResultV1Dto => result?.outcome === 'failed',
  );
  if (failed !== undefined) {
    return {
      outcome: 'failed',
      failure: {
        code: failed.error?.code ?? 'undo-execution-failed',
        message: failed.error?.message ?? 'undo execution failed',
      },
    };
  }
  if (own.some((result) => result?.outcome === 'cancelled')) {
    return { outcome: 'cancelled', failure: null };
  }
  if (
    own.length > 0 &&
    own.some((result) => result === undefined || result.outcome === 'skipped-after-failure')
  ) {
    return { outcome: 'not-run', failure: null };
  }
  return { outcome: pairAggregateOutcome(pairs), failure: null };
};
const pairReduction = (
  pair: UndoPairV1Dto,
  results: ReadonlyMap<string, UndoOperationResultV1Dto>,
  reduce: boolean,
): Readonly<{
  outcome: UndoPairV1Dto['outcome'];
  failure: UndoPairV1Dto['failure'];
}> => {
  if (pair.eligibility === 'already-reversed') {
    return { outcome: 'already-reversed', failure: null };
  }
  if (!reduce) return { outcome: 'planned', failure: null };
  const own = pair.operations.map((operationId) => results.get(operationId));
  const failed = own.find(
    (result): result is UndoOperationResultV1Dto => result?.outcome === 'failed',
  );
  if (failed !== undefined) {
    return {
      outcome: 'failed',
      failure: {
        code: failed.error?.code ?? 'undo-execution-failed',
        message: failed.error?.message ?? 'undo execution failed',
      },
    };
  }
  if (own.some((result) => result?.outcome === 'cancelled')) {
    return { outcome: 'cancelled', failure: null };
  }
  if (
    own.length === 0 ||
    own.some((result) => result === undefined || result.outcome === 'skipped-after-failure')
  ) {
    return { outcome: 'not-run', failure: null };
  }
  return { outcome: 'succeeded', failure: null };
};
const canonicalEffects = (
  operations: readonly UndoOperationV1Dto[],
  mode: UndoReportV1Dto['mode'],
  results: ReadonlyMap<string, UndoOperationResultV1Dto>,
): readonly UndoEffectV1Dto[] =>
  operations.flatMap((operation) => {
    const result = results.get(operation.operationId);
    const outcome: UndoEffectV1Dto['outcome'] =
      mode === 'dry-run'
        ? 'planned'
        : result?.outcome === 'failed'
          ? 'failed'
          : result?.outcome === 'cancelled'
            ? 'cancelled'
            : result === undefined || result.outcome === 'skipped-after-failure'
              ? 'not-run'
              : 'succeeded';
    const roles = [
      ...(operation.mutates.ledger ? (['ledger'] as const) : []),
      ...(operation.mutates.live ? (['live'] as const) : []),
    ];
    return roles.map((role) => ({
      role,
      action: operation.kind,
      operationId: operation.operationId,
      groupId: operation.groupId,
      outcome,
    }));
  });
const effectVectorsMatch = (
  left: readonly UndoEffectV1Dto[],
  right: readonly UndoEffectV1Dto[],
): boolean =>
  left.length === right.length &&
  left.every(
    (effect, index) =>
      effect.role === right[index]?.role &&
      effect.action === right[index]?.action &&
      effect.operationId === right[index]?.operationId &&
      effect.groupId === right[index]?.groupId &&
      effect.outcome === right[index]?.outcome,
  );

const containsForbiddenOutput = (input: unknown): boolean => {
  if (typeof input === 'string') {
    return containsSensitiveMaterial(input) || /(?:https?|ssh):\/\//iu.test(input);
  }
  if (Array.isArray(input)) return input.some(containsForbiddenOutput);
  if (input === null || typeof input !== 'object') return false;
  return Object.values(input).some(containsForbiddenOutput);
};

const UndoV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('skillsmith.undo'),
    command: z.literal('undo'),
    mode: z.enum(['dry-run', 'execute']),
    state: z.enum(['ready', 'refused', 'completed', 'partial']),
    project: z
      .object({
        effectiveCwd: z.string().min(1),
        root: z.string().min(1).nullable(),
        identity: z.string().min(1).nullable(),
      })
      .strict(),
    selection: SelectionSchema,
    approval: z
      .object({
        required: z.boolean(),
        outcome: z.enum(['not-required', 'pending', 'approved', 'refused', 'cancelled']),
      })
      .strict(),
    groups: z.array(GroupSchema),
    operations: z.array(UndoOperationSchema),
    checks: z.array(z.custom<PlanCheckV1Dto>()),
    results: z.array(ResultSchema),
    effects: z.array(EffectSchema),
    diagnostics: z.array(z.custom<PlanDiagnosticV1Dto>()),
    summary: SummarySchema,
  })
  .strict()
  .superRefine((value, context) => {
    const operationGroupIds = new Set(value.operations.map(({ groupId }) => groupId));
    const projectedDiagnostics = value.diagnostics.map((diagnostic) =>
      diagnostic.correlation.groupId !== null &&
      diagnostic.correlation.operationId === null &&
      !operationGroupIds.has(diagnostic.correlation.groupId) &&
      (diagnostic.correlation.pairId === null || diagnostic.reason.code === 'undo-cleanup-pending')
        ? {
            ...diagnostic,
            correlation: { ...diagnostic.correlation, groupId: null, pairId: null },
          }
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
    const projection: PlanV1Dto = {
      schemaVersion: 1,
      kind: 'skillsmith.plan-report',
      command: 'plan',
      state: planSummary.refusals > 0 ? 'refused' : 'ready',
      artifactPair: {
        manifestPath: '<undo>',
        lockPath: '<undo>',
        lockSource: 'sibling',
        selectionSource: 'explicit',
      },
      project: value.project,
      options: { locked: false, prune: false, check: false },
      selection: {
        selectionSource: value.selection.source,
        selectionOutcome: value.selection.outcome === 'filter-zero' ? 'filter-noop' : 'selected',
        requestedTools: value.selection.tools,
        requestedScope:
          value.selection.scopes.length === 1 ? (value.selection.scopes[0] ?? null) : null,
        skills: value.groups.map(({ skill }) => skill),
        tools: value.selection.tools,
        scopes: value.selection.scopes,
      },
      operations: value.operations.map(({ dependencyMetadata, ...operation }) => ({
        ...operation,
        dependsOn: [...dependencyMetadata.operationIds],
        preconditionIds: [...operation.preconditionIds],
        requiredCheckIds: [...operation.requiredCheckIds],
        reversibility:
          operation.reversibility.kind === 'none'
            ? { kind: 'none' as const, retentionResourceIds: [] as [] }
            : {
                kind: operation.reversibility.kind,
                retentionResourceIds: [...operation.reversibility.retentionResourceIds] as [
                  string,
                  ...string[],
                ],
              },
      })),
      checks: value.checks,
      diagnostics: projectedDiagnostics,
      summary: planSummary,
      savedOutput: null,
    };
    const validatedPlan = planV1Codec.validate(projection);
    if (!validatedPlan.ok) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...validatedPlan.error.path],
        message: `undo plan projection is invalid: ${validatedPlan.error.message}`,
      });
    }

    if (containsForbiddenOutput(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'undo reports cannot contain source URLs or credential material',
      });
    }

    const groupIds = value.groups.map(({ groupId }) => groupId);
    if (
      !unique(value.selection.groupIds) ||
      !unique(value.selection.targets) ||
      !unique(value.selection.tools) ||
      !unique(value.selection.scopes) ||
      !vectorsMatch(value.selection.groupIds, groupIds) ||
      (value.selection.source === 'explicit-targets') !== !value.selection.all ||
      (value.selection.source === 'explicit-targets') !== value.selection.targets.length > 0 ||
      (value.selection.outcome === 'filter-zero' && value.groups.length > 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selection'],
        message: 'undo selection provenance and group identity are inconsistent',
      });
    }

    const selectedGroups = new Set(value.selection.groupIds);
    const migrationGroups = new Set(
      value.operations
        .filter(({ kind }) => kind === 'migrate-ledger')
        .map(({ groupId }) => groupId),
    );
    const operationIds = value.operations.map(({ operationId }) => operationId);
    const operationIdSet = new Set(operationIds);
    const operationById = new Map(
      value.operations.map((operation) => [operation.operationId, operation]),
    );
    const resultById = new Map(value.results.map((result) => [result.operationId, result]));
    const reducePairs =
      value.mode === 'execute' &&
      !['pending', 'refused', 'cancelled'].includes(value.approval.outcome);
    if (!unique(operationIds)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['operations'],
        message: 'undo operation identities must be unique',
      });
    }
    for (const [index, operation] of value.operations.entries()) {
      if (
        (!selectedGroups.has(operation.groupId) && operation.kind !== 'migrate-ledger') ||
        ![
          'install',
          'update',
          'remove',
          'link-dev',
          'promote',
          'move-scope',
          'repair',
          'migrate-ledger',
          'write-manifest',
          'write-lock',
        ].includes(operation.kind)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['operations', index],
          message: 'undo operation is outside the selected groups or undo vocabulary',
        });
      }
    }
    const coveredOperationIds: string[] = [];
    const pairIds: string[] = [];
    for (const [index, group] of value.groups.entries()) {
      const exactGroupOperations = value.operations
        .filter(({ groupId, kind }) => groupId === group.groupId && kind !== 'migrate-ledger')
        .map(({ operationId }) => operationId);
      const pairOperations = group.pairs.flatMap(({ operations }) => operations);
      const expectedGroup = groupReduction(group, group.pairs, resultById, reducePairs);
      if (
        !unique(pairOperations) ||
        !vectorsMatch(group.operations, exactGroupOperations) ||
        pairOperations.some((operationId) => !group.operations.includes(operationId)) ||
        group.outcome !== expectedGroup.outcome ||
        (group.failure?.code ?? null) !== (expectedGroup.failure?.code ?? null) ||
        (group.failure?.message ?? null) !== (expectedGroup.failure?.message ?? null) ||
        group.pairs.some(
          (pair, pairIndex) =>
            pairIndex > 0 &&
            toolOrder(group.pairs[pairIndex - 1]?.tool ?? pair.tool) >= toolOrder(pair.tool),
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['groups', index],
          message: 'undo group pair order, operation coverage, outcome, or failure is inconsistent',
        });
      }
      for (const [pairIndex, pair] of group.pairs.entries()) {
        pairIds.push(pair.pairId);
        coveredOperationIds.push(...pair.operations);
        const pairOperationFacts = pair.operations.map((operationId) =>
          operationById.get(operationId),
        );
        const expectedPair = pairReduction(pair, resultById, reducePairs);
        if (
          !unique(pair.operations) ||
          (pair.outcome === 'already-reversed') !== (pair.eligibility === 'already-reversed') ||
          (pair.outcome === 'already-reversed' &&
            (pair.operations.length > 0 || pair.failure !== null)) ||
          (pair.outcome === 'failed') !== (pair.failure !== null) ||
          pair.outcome !== expectedPair.outcome ||
          (pair.failure?.code ?? null) !== (expectedPair.failure?.code ?? null) ||
          (pair.failure?.message ?? null) !== (expectedPair.failure?.message ?? null) ||
          pair.retention.required !== pair.retention.resourceIds.length > 0 ||
          (pair.action === 'reverse-committed' && pair.parentOperationId === null) ||
          pairOperationFacts.some(
            (operation) =>
              operation === undefined ||
              operation.groupId !== group.groupId ||
              operation.pairId !== pair.pairId ||
              operation.skill !== group.skill ||
              operation.tool !== pair.tool ||
              operation.scope !== group.scope ||
              operation.kind === 'migrate-ledger',
          )
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['groups', index, 'pairs', pairIndex],
            message: 'undo pair linkage, retention, operation, or outcome facts are inconsistent',
          });
        }
      }
    }
    const executableOperationIds = value.operations
      .filter(({ kind, pairId }) => kind !== 'migrate-ledger' && pairId !== null)
      .map(({ operationId }) => operationId);
    const invalidGroupOperations = value.operations.filter(
      (operation) =>
        operation.kind !== 'migrate-ledger' &&
        operation.pairId === null &&
        (operation.skill !== null ||
          operation.source !== null ||
          operation.tool !== null ||
          operation.scope !== null ||
          (operation.kind !== 'write-manifest' && operation.kind !== 'write-lock')),
    );
    if (
      !unique(pairIds) ||
      !unique(coveredOperationIds) ||
      !vectorsMatch(coveredOperationIds, executableOperationIds) ||
      invalidGroupOperations.length > 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['groups'],
        message:
          'undo pairs must have distinct identities and cover each executable operation once',
      });
    }
    for (const [index, result] of value.results.entries()) {
      if (
        !operationIdSet.has(result.operationId) ||
        (result.outcome === 'failed') !== (result.error !== null)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['results', index],
          message: 'undo result does not match a planned operation or failure fact',
        });
      }
    }
    if (
      !unique(value.results.map(({ operationId }) => operationId)) ||
      (value.mode === 'dry-run' && value.results.length > 0) ||
      (value.mode === 'execute' &&
        value.state !== 'ready' &&
        value.state !== 'refused' &&
        !vectorsMatch(
          value.results.map(({ operationId }) => operationId),
          operationIds,
        ))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['results'],
        message: 'undo results must exactly follow executable operation identity order',
      });
    }
    const expectedEffects = canonicalEffects(value.operations, value.mode, resultById);
    if (!effectVectorsMatch(value.effects, expectedEffects)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['effects'],
        message: 'undo effects must equal the exact canonical operation effect vector',
      });
    }
    for (const [index, diagnostic] of value.diagnostics.entries()) {
      if (
        diagnostic.correlation.groupId !== null &&
        !selectedGroups.has(diagnostic.correlation.groupId) &&
        !migrationGroups.has(diagnostic.correlation.groupId)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['diagnostics', index, 'correlation', 'groupId'],
          message: 'undo diagnostic references an unselected group',
        });
      }
    }
    const cleanupDiagnostics = value.diagnostics.filter(
      ({ reason }) => reason.code === 'undo-cleanup-pending',
    );
    const cleanupPairs: string[] = [];
    for (const diagnostic of cleanupDiagnostics) {
      const group = value.groups.find(({ groupId }) => groupId === diagnostic.correlation.groupId);
      const pair = group?.pairs.find(({ pairId }) => pairId === diagnostic.correlation.pairId);
      if (group !== undefined && pair !== undefined) cleanupPairs.push(pair.pairId);
      if (
        group === undefined ||
        pair === undefined ||
        pair.outcome !== 'already-reversed' ||
        diagnostic.kind !== 'warning' ||
        diagnostic.severity !== 'warning' ||
        diagnostic.refusalClass !== null ||
        diagnostic.correlation.operationId !== null ||
        diagnostic.affected.skill !== group.skill ||
        diagnostic.affected.source !== null ||
        diagnostic.affected.tool !== pair.tool ||
        diagnostic.affected.scope !== group.scope ||
        diagnostic.affected.path?.kind !== 'machine-bound' ||
        diagnostic.affected.path.path !== pair.path ||
        diagnostic.selectionSource !== value.selection.source ||
        diagnostic.reason.message !==
          `Committed undo cleanup remains pending for '${group.skill}' on ${pair.tool}.`
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['diagnostics'],
          message: 'undo cleanup diagnostics must correlate exactly to one already-reversed pair',
        });
      }
    }
    if (!unique(cleanupPairs) || cleanupPairs.length !== cleanupDiagnostics.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['diagnostics'],
        message: 'undo cleanup diagnostics must be unique per cleanup-pending pair',
      });
    }

    const actionable = value.groups.filter(({ pairs }) =>
      pairs.some(({ eligibility }) => eligibility === 'eligible'),
    ).length;
    const counts = {
      planned: value.groups.filter(({ outcome }) => outcome === 'planned').length,
      succeeded: value.groups.filter(({ outcome }) => outcome === 'succeeded').length,
      failed: value.groups.filter(({ outcome }) => outcome === 'failed').length,
      cancelled: value.groups.filter(({ outcome }) => outcome === 'cancelled').length,
      notRun: value.groups.filter(({ outcome }) => outcome === 'not-run').length,
    };
    if (
      value.summary.selected !== value.groups.length ||
      value.summary.actionable !== actionable ||
      value.summary.alreadyReversed !==
        value.groups.filter(({ outcome }) => outcome === 'already-reversed').length ||
      value.summary.effects !== value.effects.length ||
      value.summary.refusals !== value.diagnostics.filter(({ kind }) => kind === 'refuse').length ||
      value.summary.skipped !== 0 ||
      Object.entries(counts).some(
        ([name, count]) => value.summary[name as keyof typeof counts] !== count,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['summary'],
        message: 'undo summary is inconsistent',
      });
    }

    const changing = value.operations.length > 0 || cleanupDiagnostics.length > 0;
    const approvalValid =
      value.mode === 'dry-run'
        ? !value.approval.required && value.approval.outcome === 'not-required'
        : changing
          ? value.approval.required && value.approval.outcome !== 'not-required'
          : !value.approval.required && value.approval.outcome === 'not-required';
    const lifecycleValid =
      (value.mode === 'dry-run' && ['ready', 'refused'].includes(value.state)) ||
      (value.mode === 'execute' &&
        (value.state === 'ready' ||
          value.state === 'refused' ||
          (value.state === 'completed' &&
            value.summary.failed === 0 &&
            value.summary.cancelled === 0) ||
          (value.state === 'partial' &&
            (value.summary.failed > 0 ||
              value.summary.cancelled > 0 ||
              value.summary.notRun > 0))));
    if (
      !approvalValid ||
      !lifecycleValid ||
      (value.approval.outcome === 'pending' && value.state !== 'ready') ||
      ((value.approval.outcome === 'refused' || value.approval.outcome === 'cancelled') &&
        value.state !== 'refused')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approval'],
        message: 'undo mode, state, and approval facts are inconsistent',
      });
    }
  });

/** Project the closed undo domain report through the strict schema into newly owned JSON data. */
export const toUndoV1Dto = (report: UndoReport): UndoReportV1Dto =>
  UndoV1Schema.parse({
    schemaVersion: report.schemaVersion,
    kind: report.kind,
    command: report.command,
    mode: report.mode,
    state: report.state,
    project: {
      effectiveCwd: report.project.effectiveCwd,
      root: report.project.root,
      identity: report.project.identity,
    },
    selection: {
      source: report.selection.source,
      outcome: report.selection.outcome,
      targets: [...report.selection.targets],
      all: report.selection.all,
      tools: [...report.selection.tools],
      scopes: [...report.selection.scopes],
      groupIds: [...report.selection.groupIds],
      batchPolicy: report.selection.batchPolicy,
    },
    approval: {
      required: report.approval.required,
      outcome: report.approval.outcome,
    },
    groups: report.groups.map((group) => ({
      groupId: group.groupId,
      skill: group.name,
      scope: group.scope,
      pairs: group.pairs.map((pair) => ({
        pairId: pair.pairId,
        tool: pair.tool,
        path: pair.path,
        action: pair.action,
        operationFamily: pair.operationFamily,
        disposition: pair.disposition,
        phase: pair.phase,
        executionMode: pair.executionMode,
        sourceTransactionId: pair.sourceTransactionId,
        activeTransactionId: pair.activeTransactionId,
        sourceOperationId: pair.sourceOperationId,
        activeOperationId: pair.activeOperationId,
        parentOperationId: pair.parentOperationId,
        beforeState: pair.beforeState,
        eligibility: pair.eligibility,
        retention: {
          required: pair.retention.required,
          resourceIds: [...pair.retention.resourceIds],
        },
        operations: [...pair.operationIds],
        outcome: pair.outcome,
        failure:
          pair.failure === null ? null : { code: pair.failure.code, message: pair.failure.message },
      })),
      operations: [...group.operationIds],
      outcome: group.outcome,
      failure:
        group.failure === null
          ? null
          : { code: group.failure.code, message: group.failure.message },
    })),
    operations: structuredClone(report.operations),
    checks: structuredClone(report.checks),
    results: report.results.map((result) => ({
      operationId: result.operationId,
      outcome: result.outcome,
      error:
        result.error === null
          ? null
          : {
              code: result.error.code,
              message: result.error.message,
              remediation: result.error.remediation,
            },
    })),
    effects: report.effects.map((effect) => ({
      role: effect.role,
      action: effect.action,
      operationId: effect.operationId,
      groupId: effect.groupId,
      outcome: effect.outcome,
    })),
    diagnostics: structuredClone(report.diagnostics),
    summary: {
      selected: report.summary.selected,
      actionable: report.summary.actionable,
      alreadyReversed: report.summary.alreadyReversed,
      planned: report.summary.planned,
      succeeded: report.summary.succeeded,
      failed: report.summary.failed,
      cancelled: report.summary.cancelled,
      skipped: report.summary.skipped,
      notRun: report.summary.notRun,
      effects: report.summary.effects,
      refusals: report.summary.refusals,
    },
  });

export const undoV1Codec = createJsonWireCodec(
  {
    id: 'undo',
    version: 1,
    wireKind: 'skillsmith.undo',
    embeddedVersion: 'schemaVersion',
    unknownFields: 'reject-recursive',
    formatting: { indent: 2, terminalLf: true },
    migrations: [],
    compatibility: 'conservative',
  } as const,
  UndoV1Schema,
) as unknown as WireCodec<'undo', 1, UndoReportV1Dto>;
