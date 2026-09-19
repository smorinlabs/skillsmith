import { z } from 'zod';
import { SUPPORTED_TOOLS, type SupportedTool } from '../../agents/types.ts';
import { containsSensitiveMaterial } from '../../safety/redaction.ts';
import { createJsonWireCodec } from '../codec.ts';
import type { WireCodec } from '../types.ts';
import { planV1Codec } from './plan.ts';
import type { PlanCheckV1Dto, PlanDiagnosticV1Dto, PlanOperationV1Dto, PlanV1Dto } from './plan.ts';

export interface SyncEndpointV1Dto {
  readonly kind: 'user' | 'project' | 'system' | 'managed' | 'path';
  readonly scope: 'user' | 'project' | 'system' | 'managed';
  readonly selectedInput: string;
  readonly projectRoot: string | null;
}

export interface SyncSelectionV1Dto {
  readonly selectionSource: 'bounded-default' | 'explicit-targets';
  readonly selectionOutcome: 'selected' | 'filter-noop';
  readonly targets: readonly string[];
  readonly skills: readonly string[];
  readonly tools: readonly SupportedTool[];
  readonly groupIds: readonly string[];
  readonly sourceMembers: number;
  readonly destinationMembers: number;
}

export interface SyncPairResultV1Dto {
  readonly tool: SupportedTool;
  readonly source: { readonly scope: SyncEndpointV1Dto['scope']; readonly present: boolean };
  readonly destination: { readonly scope: SyncEndpointV1Dto['scope']; readonly present: boolean };
  readonly action: 'install' | 'update' | 'remove' | 'noop' | 'refuse';
  readonly outcome: 'planned' | 'succeeded' | 'failed' | 'cancelled' | 'skipped' | 'not-run';
  readonly skipReason: string | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
  readonly force: {
    readonly requested: boolean;
    readonly used: boolean;
    readonly conflictType:
      | 'unmanaged-target'
      | 'modified-managed-target'
      | 'destination-exists'
      | 'source-changed'
      | null;
    readonly destination: string | null;
    readonly normal: 'apply' | 'refuse';
    readonly forced: 'not-applicable' | 'backup-and-replace' | 'replace';
    readonly required: boolean;
    readonly outcome: 'not-required' | 'planned' | 'succeeded' | 'failed' | 'cancelled' | 'not-run';
  };
  readonly drift: { readonly artifact: boolean; readonly live: boolean };
}

export interface SyncGroupResultV1Dto {
  readonly groupId: string;
  readonly skill: string;
  readonly pairs: readonly SyncPairResultV1Dto[];
}

export interface SyncEffectV1Dto {
  readonly role: 'manifest' | 'lock' | 'ledger' | 'store' | 'live' | 'backup';
  readonly action: string;
  readonly operationId: string | null;
  readonly groupId: string;
  readonly outcome: 'planned' | 'succeeded' | 'failed' | 'cancelled' | 'not-run';
}

export interface SyncSummaryV1Dto {
  readonly groups: number;
  readonly pairs: number;
  readonly planned: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly skipped: number;
  readonly notRun: number;
  readonly changed: number;
  readonly unchanged: number;
  readonly effects: number;
  readonly drift: number;
  readonly refusals: number;
}

export interface SyncReportV1Dto {
  readonly schemaVersion: 1;
  readonly kind: 'skillsmith.sync';
  readonly command: 'sync';
  readonly mode: 'dry-run' | 'execute';
  readonly state: 'ready' | 'refused' | 'completed' | 'partial';
  readonly endpoints: { readonly from: SyncEndpointV1Dto; readonly to: SyncEndpointV1Dto };
  readonly artifactPair: null | {
    readonly manifestPath: string;
    readonly lockPath: string;
    readonly lockSource: 'sibling' | 'explicit';
    readonly selectionSource: 'explicit' | 'destination-project' | 'destination-user';
  };
  readonly options: {
    readonly force: boolean;
    readonly delete: boolean;
    readonly save: boolean;
    readonly dryRun: boolean;
    readonly continueOnError: boolean;
  };
  readonly selection: SyncSelectionV1Dto;
  readonly operations: readonly PlanOperationV1Dto[];
  readonly checks: readonly PlanCheckV1Dto[];
  readonly diagnostics: readonly PlanDiagnosticV1Dto[];
  readonly approval: {
    readonly required: boolean;
    readonly outcome: 'not-required' | 'pending' | 'approved' | 'refused' | 'cancelled';
  };
  readonly groups: readonly SyncGroupResultV1Dto[];
  readonly effects: readonly SyncEffectV1Dto[];
  readonly summary: SyncSummaryV1Dto;
}

const CountSchema = z.number().int().nonnegative();
const IdSchema = z.string().min(1);
const ScopeSchema = z.enum(['user', 'project', 'system', 'managed']);
const ToolSchema = z.enum(SUPPORTED_TOOLS);
const EndpointSchema = z
  .object({
    kind: z.enum(['user', 'project', 'system', 'managed', 'path']),
    scope: ScopeSchema,
    selectedInput: z.string().min(1),
    projectRoot: z.string().min(1).nullable(),
  })
  .strict();
const SelectionSchema = z
  .object({
    selectionSource: z.enum(['bounded-default', 'explicit-targets']),
    selectionOutcome: z.enum(['selected', 'filter-noop']),
    targets: z.array(z.string().min(1)),
    skills: z.array(z.string().min(1)),
    tools: z.array(ToolSchema),
    groupIds: z.array(IdSchema),
    sourceMembers: CountSchema,
    destinationMembers: CountSchema,
  })
  .strict();
const PairSchema = z
  .object({
    tool: ToolSchema,
    source: z.object({ scope: ScopeSchema, present: z.boolean() }).strict(),
    destination: z.object({ scope: ScopeSchema, present: z.boolean() }).strict(),
    action: z.enum(['install', 'update', 'remove', 'noop', 'refuse']),
    outcome: z.enum(['planned', 'succeeded', 'failed', 'cancelled', 'skipped', 'not-run']),
    skipReason: z.string().min(1).nullable(),
    failure: z
      .object({ code: IdSchema, message: z.string().min(1) })
      .strict()
      .nullable(),
    force: z
      .object({
        requested: z.boolean(),
        used: z.boolean(),
        conflictType: z
          .enum([
            'unmanaged-target',
            'modified-managed-target',
            'destination-exists',
            'source-changed',
          ])
          .nullable(),
        destination: z.string().min(1).nullable(),
        normal: z.enum(['apply', 'refuse']),
        forced: z.enum(['not-applicable', 'backup-and-replace', 'replace']),
        required: z.boolean(),
        outcome: z.enum(['not-required', 'planned', 'succeeded', 'failed', 'cancelled', 'not-run']),
      })
      .strict(),
    drift: z.object({ artifact: z.boolean(), live: z.boolean() }).strict(),
  })
  .strict();
const GroupSchema = z
  .object({ groupId: IdSchema, skill: z.string().min(1), pairs: z.array(PairSchema).nonempty() })
  .strict();
const EffectSchema = z
  .object({
    role: z.enum(['manifest', 'lock', 'ledger', 'store', 'live', 'backup']),
    action: z.string().min(1),
    operationId: IdSchema.nullable(),
    groupId: IdSchema,
    outcome: z.enum(['planned', 'succeeded', 'failed', 'cancelled', 'not-run']),
  })
  .strict();
const SummarySchema = z
  .object({
    groups: CountSchema,
    pairs: CountSchema,
    planned: CountSchema,
    succeeded: CountSchema,
    failed: CountSchema,
    cancelled: CountSchema,
    skipped: CountSchema,
    notRun: CountSchema,
    changed: CountSchema,
    unchanged: CountSchema,
    effects: CountSchema,
    drift: CountSchema,
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

const containsForbiddenOutput = (input: unknown): boolean => {
  if (typeof input === 'string') {
    return (
      containsSensitiveMaterial(input) ||
      /[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(input) ||
      /^git@[^@/:]+:.+$/u.test(input)
    );
  }
  if (Array.isArray(input)) return input.some(containsForbiddenOutput);
  if (input === null || typeof input !== 'object') return false;
  return Object.values(input).some(containsForbiddenOutput);
};

const SyncV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('skillsmith.sync'),
    command: z.literal('sync'),
    mode: z.enum(['dry-run', 'execute']),
    state: z.enum(['ready', 'refused', 'completed', 'partial']),
    endpoints: z.object({ from: EndpointSchema, to: EndpointSchema }).strict(),
    artifactPair: z
      .object({
        manifestPath: z.string().min(1),
        lockPath: z.string().min(1),
        lockSource: z.enum(['sibling', 'explicit']),
        selectionSource: z.enum(['explicit', 'destination-project', 'destination-user']),
      })
      .strict()
      .nullable(),
    options: z
      .object({
        force: z.boolean(),
        delete: z.boolean(),
        save: z.boolean(),
        dryRun: z.boolean(),
        continueOnError: z.boolean(),
      })
      .strict(),
    selection: SelectionSchema,
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
    if (containsForbiddenOutput(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'sync reports cannot contain source URLs or credential material',
      });
    }

    const operationGroupIds = new Set(value.operations.map(({ groupId }) => groupId));
    // plan-report@1 has no selected-group vector, so a truthful group-only noop/skip/refusal
    // correlation cannot be anchored when that group has no executable operation. Sync validates
    // those correlations against its own exact selection below; omit only that unavailable anchor
    // from the embedded plan-codec projection.
    const projectedDiagnostics = value.diagnostics.map((diagnostic) =>
      diagnostic.correlation.groupId !== null &&
      diagnostic.correlation.operationId === null &&
      diagnostic.correlation.pairId === null &&
      !operationGroupIds.has(diagnostic.correlation.groupId)
        ? {
            ...diagnostic,
            correlation: { ...diagnostic.correlation, groupId: null },
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
    const destinationScope = value.endpoints.to.scope;
    const projection: PlanV1Dto = {
      schemaVersion: 1,
      kind: 'skillsmith.plan-report',
      command: 'plan',
      state: planSummary.refusals > 0 ? 'refused' : 'ready',
      artifactPair:
        value.artifactPair === null
          ? {
              manifestPath: '<sync>',
              lockPath: '<sync>',
              lockSource: 'sibling',
              selectionSource: 'explicit',
            }
          : {
              manifestPath: value.artifactPair.manifestPath,
              lockPath: value.artifactPair.lockPath,
              lockSource: value.artifactPair.lockSource,
              selectionSource:
                value.artifactPair.selectionSource === 'destination-project'
                  ? 'project-default'
                  : value.artifactPair.selectionSource === 'destination-user'
                    ? 'user-default'
                    : 'explicit',
            },
      project: { effectiveCwd: '<sync>', root: value.endpoints.to.projectRoot, identity: null },
      options: { locked: false, prune: value.options.delete, check: false },
      selection: {
        selectionSource: value.selection.selectionSource,
        selectionOutcome: value.selection.selectionOutcome,
        requestedTools: value.selection.tools,
        requestedScope:
          destinationScope === 'user' || destinationScope === 'project' ? destinationScope : null,
        skills: value.selection.skills,
        tools: value.selection.tools,
        scopes:
          destinationScope === 'user' || destinationScope === 'project' ? [destinationScope] : [],
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
        message: `sync plan projection is invalid: ${validated.error.message}`,
      });
    }

    for (const [role, endpoint] of Object.entries(value.endpoints)) {
      const projectEndpoint = endpoint.scope === 'project';
      if (
        (endpoint.projectRoot !== null) !== projectEndpoint ||
        (endpoint.kind === 'path' && !projectEndpoint)
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['endpoints', role],
          message: 'sync endpoint kind, scope, and project root are inconsistent',
        });
    }
    const fromIdentity = value.endpoints.from.projectRoot ?? value.endpoints.from.scope;
    const toIdentity = value.endpoints.to.projectRoot ?? value.endpoints.to.scope;
    if (fromIdentity === toIdentity)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endpoints'],
        message: 'sync source and destination must be canonically distinct',
      });

    const pairs = value.groups.flatMap(({ pairs }) => pairs);
    const outcomeCounts = {
      planned: pairs.filter(({ outcome }) => outcome === 'planned').length,
      succeeded: pairs.filter(({ outcome }) => outcome === 'succeeded').length,
      failed: pairs.filter(({ outcome }) => outcome === 'failed').length,
      cancelled: pairs.filter(({ outcome }) => outcome === 'cancelled').length,
      skipped: pairs.filter(({ outcome }) => outcome === 'skipped').length,
      notRun: pairs.filter(({ outcome }) => outcome === 'not-run').length,
    };
    const drift = pairs.filter(({ drift }) => drift.artifact || drift.live).length;
    const changed = pairs.filter(
      ({ action }) => action === 'install' || action === 'update' || action === 'remove',
    ).length;
    const unchanged = pairs.filter(({ action }) => action === 'noop').length;
    if (
      value.summary.groups !== value.groups.length ||
      value.summary.pairs !== pairs.length ||
      value.summary.effects !== value.effects.length ||
      value.summary.drift !== drift ||
      value.summary.changed !== changed ||
      value.summary.unchanged !== unchanged ||
      value.summary.refusals !== value.diagnostics.filter(({ kind }) => kind === 'refuse').length ||
      Object.entries(outcomeCounts).some(
        ([key, count]) => value.summary[key as keyof typeof outcomeCounts] !== count,
      )
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['summary'],
        message: 'sync summary is inconsistent',
      });
    if (
      (value.selection.selectionSource === 'bounded-default' &&
        value.selection.targets.length > 0) ||
      (value.selection.selectionSource === 'explicit-targets' &&
        value.selection.targets.length === 0) ||
      (value.selection.selectionOutcome === 'filter-noop' && value.groups.length > 0)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selection'],
        message: 'sync selection provenance and outcome are inconsistent',
      });
    if (
      new Set(value.selection.groupIds).size !== value.selection.groupIds.length ||
      value.selection.groupIds.length !== value.groups.length ||
      value.groups.some((group, index) => group.groupId !== value.selection.groupIds[index])
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selection', 'groupIds'],
        message: 'sync groups must preserve exact selected group order',
      });
    }
    if ((value.mode === 'dry-run') !== value.options.dryRun)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options', 'dryRun'],
        message: 'sync mode and dry-run option are inconsistent',
      });
    const approvalRequired = value.approval.outcome !== 'not-required';
    if (
      value.approval.required !== approvalRequired ||
      (value.mode === 'dry-run' && value.approval.required)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approval'],
        message: 'sync approval facts are inconsistent',
      });
    const pairOutcomes = pairs.map(({ outcome }) => outcome);
    const lifecycleValid =
      (value.mode === 'dry-run' &&
        (value.state === 'ready' || value.state === 'refused') &&
        !value.approval.required &&
        pairOutcomes.every((outcome) => outcome === 'planned' || outcome === 'not-run')) ||
      (value.mode === 'execute' &&
        ((value.state === 'ready' && pairOutcomes.every((outcome) => outcome === 'planned')) ||
          (value.state === 'refused' && pairOutcomes.every((outcome) => outcome !== 'succeeded')) ||
          (value.state === 'completed' &&
            pairOutcomes.every((outcome) => outcome === 'succeeded')) ||
          (value.state === 'partial' &&
            pairOutcomes.some((outcome) =>
              ['failed', 'cancelled', 'skipped', 'not-run'].includes(outcome),
            ))));
    if (
      !lifecycleValid ||
      (value.approval.outcome === 'pending' && value.state !== 'ready') ||
      ((value.approval.outcome === 'refused' || value.approval.outcome === 'cancelled') &&
        value.state !== 'refused')
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'sync mode, state, approval, and pair outcomes are inconsistent',
      });
    for (const [groupIndex, group] of value.groups.entries()) {
      if (new Set(group.pairs.map(({ tool }) => tool)).size !== group.pairs.length)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['groups', groupIndex, 'pairs'],
          message: 'sync group tools must be distinct',
        });
      for (const [pairIndex, pair] of group.pairs.entries()) {
        const path = ['groups', groupIndex, 'pairs', pairIndex] as const;
        if (
          (pair.outcome === 'failed') !== (pair.failure !== null) ||
          (pair.outcome === 'skipped') !== (pair.skipReason !== null)
        )
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path],
            message: 'sync pair reason is inconsistent with its outcome',
          });
        if (pair.force.used && !pair.force.requested)
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, 'force'],
            message: 'sync cannot use an unrequested force override',
          });
        if (
          pair.force.requested !== value.options.force ||
          (pair.action === 'remove' && !value.options.delete) ||
          !value.selection.tools.includes(pair.tool) ||
          !value.selection.skills.includes(group.skill)
        )
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path],
            message: 'sync pair is inconsistent with the invocation selection',
          });
        if ((pair.force.outcome === 'not-required') !== !pair.force.required)
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, 'force'],
            message: 'sync backup facts are inconsistent',
          });
        const backupRequired =
          pair.force.conflictType !== null && pair.force.conflictType !== 'source-changed';
        const forcedBehavior =
          pair.force.conflictType === 'source-changed'
            ? 'replace'
            : pair.force.conflictType === null
              ? 'not-applicable'
              : 'backup-and-replace';
        if (
          (pair.force.conflictType === null) !== (pair.force.destination === null) ||
          pair.force.required !== backupRequired ||
          pair.force.forced !== forcedBehavior ||
          (pair.force.conflictType === null
            ? pair.force.normal !== 'apply' || pair.force.used
            : pair.force.normal !== 'refuse')
        )
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, 'force'],
            message: 'sync force projection is inconsistent',
          });
      }
    }
    const groupIds = new Set(value.selection.groupIds);
    for (const [index, diagnostic] of value.diagnostics.entries()) {
      if (
        diagnostic.correlation.groupId !== null &&
        !groupIds.has(diagnostic.correlation.groupId)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['diagnostics', index, 'correlation', 'groupId'],
          message: 'sync diagnostic references an unselected group',
        });
      }
    }
    const operationIds = new Set(value.operations.map(({ operationId }) => operationId));
    for (const [index, effect] of value.effects.entries()) {
      if (
        !groupIds.has(effect.groupId) ||
        (effect.operationId !== null && !operationIds.has(effect.operationId))
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['effects', index],
          message: 'sync effect references an unselected group or operation',
        });
    }
  });

export const syncV1Codec = createJsonWireCodec(
  {
    id: 'sync',
    version: 1,
    wireKind: 'skillsmith.sync',
    embeddedVersion: 'schemaVersion',
    unknownFields: 'reject-recursive',
    formatting: { indent: 2, terminalLf: true },
    migrations: [],
    compatibility: 'conservative',
  } as const,
  SyncV1Schema,
) as unknown as WireCodec<'sync', 1, SyncReportV1Dto>;
