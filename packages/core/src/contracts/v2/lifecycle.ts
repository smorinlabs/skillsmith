import { types as utilTypes } from 'node:util';
import { z } from 'zod';

import type {
  CurrentInstallReport,
  CurrentInstallResult,
  CurrentUninstallReport,
  CurrentUninstallResult,
} from '../../acquire/types.ts';
import { FLIP_TOOLS } from '../../agents/registry.ts';
import type { FlipTool } from '../../place/types.ts';
import type {
  BoundedForceEffect,
  OperationLocation,
  OperationResourceIdentity,
} from '../../planning/types.ts';
import { redactSensitiveString } from '../../safety/redaction.ts';
import { createJsonWireCodec } from '../codec.ts';

const ToolV2Schema = z.enum(FLIP_TOOLS);
const ScopeV2Schema = z.enum(['user', 'project']);
const PlacementV2Schema = z.enum(['symlink', 'copy']);
const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const CountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const LocationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('portable'), token: z.string() }).strict(),
  z.object({ kind: z.literal('machine-bound'), path: z.string() }).strict(),
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
      tool: ToolV2Schema,
      scope: ScopeV2Schema,
      projectRoot: LocationSchema.nullable(),
      location: LocationSchema,
    })
    .strict(),
  z.object({ kind: z.literal('store'), contentHash: DigestSchema }).strict(),
  z.object({ kind: z.literal('project-context'), root: LocationSchema }).strict(),
]);

const ForceEffectSchema = z.discriminatedUnion('conflictType', [
  z
    .object({
      requested: z.boolean(),
      applied: z.literal(false),
      conflictType: z.null(),
      target: z.null(),
      normalBehavior: z.null(),
      forcedBehavior: z.null(),
      backup: z.null(),
    })
    .strict(),
  z
    .object({
      requested: z.literal(true),
      applied: z.boolean(),
      conflictType: z.enum(['unmanaged-target', 'modified-managed-target', 'destination-exists']),
      target: ResourceIdentitySchema,
      normalBehavior: z.literal('refuse'),
      forcedBehavior: z.literal('backup-and-replace'),
      backup: z.literal('required'),
    })
    .strict(),
  z
    .object({
      requested: z.literal(true),
      applied: z.boolean(),
      conflictType: z.literal('source-changed'),
      target: ResourceIdentitySchema,
      normalBehavior: z.literal('refuse'),
      forcedBehavior: z.literal('replace'),
      backup: z.literal('none'),
    })
    .strict(),
]);

const ArtifactPairSchema = z
  .object({
    manifestPath: z.string(),
    lockPath: z.string(),
    lockSource: z.enum(['sibling', 'explicit']),
  })
  .strict()
  .nullable();

const ArtifactSelectionSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('selected'),
      selectedBy: z.enum([
        'explicit-file',
        'selected-project-owner',
        'project-root-owner',
        'user-owner',
        'new-project',
        'new-user',
        'legacy-project-migration',
      ]),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('none'),
      reason: z.enum(['no-save', 'no-owner', 'pre-resolution-failure']),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('refused'),
      reason: z.enum(['ambiguous-owner', 'split-owner', 'invalid-candidate', 'nonportable-path']),
      candidates: z.array(z.string()),
    })
    .strict(),
]);

const ArtifactEffectSchema = z
  .object({
    groupId: z.string().nullable(),
    skill: z.string().nullable(),
    manifestAction: z.enum([
      'create',
      'update',
      'remove-declaration',
      'retain',
      'keep',
      'not-write',
    ]),
    lockAction: z.enum(['create', 'update', 'remove-entry', 'retain', 'keep', 'not-write']),
    migration: z.enum(['none', 'planned', 'applied', 'failed', 'rolled-back']),
    outcome: z.enum([
      'planned',
      'succeeded',
      'failed',
      'cancelled',
      'rolled-back',
      'skipped-after-failure',
      'not-run',
    ]),
    reason: z.string().nullable(),
  })
  .strict();

const DesiredStateSummarySchema = z
  .object({
    changed: CountSchema,
    unchanged: CountSchema,
    retained: CountSchema,
    notWritten: CountSchema,
    failed: CountSchema,
  })
  .strict();

const DriftSchema = z
  .object({
    status: z.enum(['in-sync', 'desired-without-live', 'live-without-desired', 'not-evaluated']),
    futureApply: z.enum([
      'none',
      'restore-live',
      'replace-live',
      'prune-may-remove-live',
      'depends-on-selected-manifest',
    ]),
    reason: z.string().nullable(),
  })
  .strict();

const ExecutionOutcomeSchema = z
  .enum(['succeeded', 'failed', 'cancelled', 'rolled-back', 'skipped-after-failure'])
  .nullable();

interface LifecycleV2SharedFacts {
  readonly saveMode: 'desired-state' | 'live-only';
  readonly artifactPair: z.infer<typeof ArtifactPairSchema>;
  readonly artifactSelection: z.infer<typeof ArtifactSelectionSchema>;
  readonly artifactEffects: readonly z.infer<typeof ArtifactEffectSchema>[];
  readonly results: readonly { readonly drift: z.infer<typeof DriftSchema> }[];
  readonly summary: {
    readonly desiredState: z.infer<typeof DesiredStateSummarySchema>;
  };
}

const refineLifecycleFacts = (value: LifecycleV2SharedFacts, context: z.RefinementCtx): void => {
  const selected = value.artifactSelection.outcome === 'selected';
  if (selected !== (value.artifactPair !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['artifactPair'],
      message: 'artifactPair must be present exactly when artifactSelection is selected',
    });
  }
  if (value.saveMode !== 'live-only') return;

  if (value.artifactSelection.outcome !== 'none' || value.artifactSelection.reason !== 'no-save') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['artifactSelection'],
      message: 'live-only reports require the none/no-save artifact selection',
    });
  }
  for (const [index, effect] of value.artifactEffects.entries()) {
    if (
      effect.manifestAction !== 'not-write' ||
      effect.lockAction !== 'not-write' ||
      effect.migration !== 'none'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['artifactEffects', index],
        message: 'live-only artifact effects cannot write or migrate portable state',
      });
    }
  }
  for (const [index, result] of value.results.entries()) {
    if (
      result.drift.status !== 'not-evaluated' ||
      result.drift.futureApply !== 'depends-on-selected-manifest'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['results', index, 'drift'],
        message: 'live-only placement drift must remain unevaluated and conditional',
      });
    }
  }
  const desiredState = value.summary.desiredState;
  if (
    desiredState.changed !== 0 ||
    desiredState.unchanged !== 0 ||
    desiredState.retained !== 0 ||
    desiredState.failed !== 0
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['summary', 'desiredState'],
      message: 'live-only reports may count portable state only as not written',
    });
  }
};

const InstallStoreV2Schema = z
  .object({
    path: z.string(),
    rev: z.string(),
    gitSha: z.string(),
    reused: z.boolean(),
  })
  .strict()
  .nullable();

const InstallOriginV2Schema = z
  .object({
    host: z.string(),
    repo: z.string(),
    skillPath: z.string(),
    refRequested: z.string().nullable(),
    refResolved: z.string(),
    pin: z.boolean(),
  })
  .strict()
  .nullable();

const InstallVerifyV2Schema = z
  .object({
    gate: z.enum(['passed', 'warned', 'failed', 'skipped', 'inconclusive']),
    verdict: z.enum(['pass', 'warn', 'fail', 'inconclusive']).nullable(),
    mode: z.enum(['static', 'static+deep']).nullable(),
  })
  .strict()
  .nullable();

const InstallResultV2Schema = z
  .object({
    source: z.string(),
    skill: z.string().nullable(),
    tool: ToolV2Schema.nullable(),
    scope: ScopeV2Schema,
    placementPath: z.string().nullable(),
    action: z.enum(['installed', 'updated', 'repaired', 'noop', 'skipped', 'refused', 'failed']),
    reason: z.string().nullable(),
    placement: PlacementV2Schema.nullable(),
    store: InstallStoreV2Schema,
    origin: InstallOriginV2Schema,
    verify: InstallVerifyV2Schema,
    candidates: z.array(z.string()).nullable(),
    requestIndex: CountSchema,
    groupId: z.string().nullable(),
    pairId: z.string().nullable(),
    executionOutcome: ExecutionOutcomeSchema,
    drift: DriftSchema,
    force: ForceEffectSchema,
  })
  .strict();

const InstallV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    kind: z.literal('skillsmith.install'),
    dryRun: z.boolean(),
    saveMode: z.enum(['desired-state', 'live-only']),
    artifactPair: ArtifactPairSchema,
    artifactSelection: ArtifactSelectionSchema,
    artifactEffects: z.array(ArtifactEffectSchema),
    requested: z
      .object({
        sources: z.array(z.string()),
        tools: z.array(ToolV2Schema),
        explicitTools: z.boolean(),
        scope: ScopeV2Schema,
        explicitScope: z.boolean(),
        ref: z.string().nullable(),
        pin: z.boolean(),
        direct: z.boolean(),
        force: z.boolean(),
        verify: z.enum(['static', 'skipped']),
        deep: z.boolean(),
        batchPolicy: z.enum(['fail-fast', 'continue-on-error']),
        path: z.string().nullable(),
      })
      .strict(),
    results: z.array(InstallResultV2Schema),
    summary: z
      .object({
        installed: CountSchema,
        updated: CountSchema,
        repaired: CountSchema,
        noop: CountSchema,
        skipped: CountSchema,
        refused: CountSchema,
        failed: CountSchema,
        desiredState: DesiredStateSummarySchema,
      })
      .strict(),
  })
  .strict()
  .superRefine(refineLifecycleFacts);

const UninstallBeforeV2Schema = z
  .object({
    mode: z.enum(['dev', 'pinned']),
    placement: PlacementV2Schema.nullable(),
    storePath: z.string().nullable(),
    symlinkTarget: z.string().nullable(),
  })
  .strict()
  .nullable();

const UninstallResultV2Schema = z
  .object({
    skill: z.string(),
    tool: ToolV2Schema.nullable(),
    scope: ScopeV2Schema.nullable(),
    placementPath: z.string().nullable(),
    action: z.enum(['removed', 'noop', 'skipped', 'refused', 'failed']),
    reason: z.string().nullable(),
    before: UninstallBeforeV2Schema,
    storeRetained: z.string().nullable(),
    backupKept: z.string().nullable(),
    requestIndex: CountSchema,
    groupId: z.string().nullable(),
    pairId: z.string().nullable(),
    executionOutcome: ExecutionOutcomeSchema,
    drift: DriftSchema,
    force: ForceEffectSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const skippedAction = value.action === 'skipped';
    const skippedOutcome = value.executionOutcome === 'skipped-after-failure';
    if (skippedAction === skippedOutcome) return;
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: skippedAction ? ['executionOutcome'] : ['action'],
      message: 'uninstall skipped action and skipped-after-failure outcome must correspond',
    });
  });

const UninstallV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    kind: z.literal('skillsmith.uninstall'),
    dryRun: z.boolean(),
    saveMode: z.enum(['desired-state', 'live-only']),
    artifactPair: ArtifactPairSchema,
    artifactSelection: ArtifactSelectionSchema,
    artifactEffects: z.array(ArtifactEffectSchema),
    requested: z
      .object({
        targets: z.array(z.string()),
        tools: z.array(ToolV2Schema),
        explicitTools: z.boolean(),
        scope: ScopeV2Schema.nullable(),
        allScopes: z.boolean(),
        force: z.boolean(),
        batchPolicy: z.enum(['fail-fast', 'continue-on-error']),
      })
      .strict(),
    results: z.array(UninstallResultV2Schema),
    summary: z
      .object({
        removed: CountSchema,
        noop: CountSchema,
        refused: CountSchema,
        failed: CountSchema,
        desiredState: DesiredStateSummarySchema,
      })
      .strict(),
  })
  .strict()
  .superRefine(refineLifecycleFacts);

export type InstallV2Dto = z.infer<typeof InstallV2Schema>;
export type UninstallV2Dto = z.infer<typeof UninstallV2Schema>;

const assertCurrentReportVersion = (
  report: CurrentInstallReport | CurrentUninstallReport,
): void => {
  if (utilTypes.isProxy(report)) {
    throw new TypeError('v2 lifecycle mappers require an ordinary current report');
  }
  const version = Object.getOwnPropertyDescriptor(report, 'reportVersion');
  if (version === undefined || !('value' in version) || version.value !== 2) {
    throw new TypeError('v2 lifecycle mappers accept only reportVersion 2');
  }
};

const toLocationDto = (value: OperationLocation): z.infer<typeof LocationSchema> =>
  value.kind === 'portable'
    ? { kind: 'portable', token: value.token }
    : { kind: 'machine-bound', path: value.path };

const toResourceIdentityDto = (
  value: OperationResourceIdentity<FlipTool>,
): z.infer<typeof ResourceIdentitySchema> => {
  switch (value.kind) {
    case 'manifest-bytes':
      return { kind: 'manifest-bytes', location: toLocationDto(value.location) };
    case 'lock':
      return { kind: 'lock', location: toLocationDto(value.location) };
    case 'ledger':
      return {
        kind: 'ledger',
        projectRoot: value.projectRoot === null ? null : toLocationDto(value.projectRoot),
      };
    case 'ledger-schema':
      return {
        kind: 'ledger-schema',
        projectRoot: value.projectRoot === null ? null : toLocationDto(value.projectRoot),
      };
    case 'live':
      return {
        kind: 'live',
        skill: value.skill,
        tool: value.tool,
        scope: value.scope,
        projectRoot: value.projectRoot === null ? null : toLocationDto(value.projectRoot),
        location: toLocationDto(value.location),
      };
    case 'store':
      return { kind: 'store', contentHash: value.contentHash };
    case 'project-context':
      return { kind: 'project-context', root: toLocationDto(value.root) };
  }
};

const toForceEffectDto = (
  value: BoundedForceEffect<FlipTool>,
): z.infer<typeof ForceEffectSchema> => {
  if (value.conflictType === null) {
    return {
      requested: value.requested,
      applied: false,
      conflictType: null,
      target: null,
      normalBehavior: null,
      forcedBehavior: null,
      backup: null,
    };
  }
  if (value.conflictType === 'source-changed') {
    return {
      requested: true,
      applied: value.applied,
      conflictType: 'source-changed',
      target: toResourceIdentityDto(value.target),
      normalBehavior: 'refuse',
      forcedBehavior: 'replace',
      backup: 'none',
    };
  }
  return {
    requested: true,
    applied: value.applied,
    conflictType: value.conflictType,
    target: toResourceIdentityDto(value.target),
    normalBehavior: 'refuse',
    forcedBehavior: 'backup-and-replace',
    backup: 'required',
  };
};

const toArtifactPairDto = (
  value: CurrentInstallReport['artifactPair'] | CurrentUninstallReport['artifactPair'],
): InstallV2Dto['artifactPair'] =>
  value === null
    ? null
    : {
        manifestPath: value.manifestPath,
        lockPath: value.lockPath,
        lockSource: value.lockSource,
      };

const toArtifactSelectionDto = (
  value: CurrentInstallReport['artifactSelection'] | CurrentUninstallReport['artifactSelection'],
): InstallV2Dto['artifactSelection'] => {
  if (value.outcome === 'selected') {
    return { outcome: 'selected', selectedBy: value.selectedBy };
  }
  if (value.outcome === 'none') {
    return { outcome: 'none', reason: value.reason };
  }
  return {
    outcome: 'refused',
    reason: value.reason,
    candidates: value.candidates.map((candidate) => candidate),
  };
};

const toArtifactEffectDto = (
  value: CurrentInstallReport['artifactEffects'][number],
): InstallV2Dto['artifactEffects'][number] => ({
  groupId: value.groupId,
  skill: value.skill,
  manifestAction: value.manifestAction,
  lockAction: value.lockAction,
  migration: value.migration,
  outcome: value.outcome,
  reason: value.reason,
});

const toDriftDto = (
  value: CurrentInstallResult['drift'] | CurrentUninstallResult['drift'],
): InstallV2Dto['results'][number]['drift'] => ({
  status: value.status,
  futureApply: value.futureApply,
  reason: value.reason,
});

const toInstallResultV2Dto = (source: CurrentInstallResult): InstallV2Dto['results'][number] => ({
  source: redactSensitiveString(source.source),
  skill: source.skill,
  tool: source.tool,
  scope: source.scope,
  placementPath: source.placementPath,
  action: source.action,
  reason: source.reason,
  placement: source.placement,
  store:
    source.store === null
      ? null
      : {
          path: source.store.path,
          rev: source.store.rev,
          gitSha: source.store.gitSha,
          reused: source.store.reused,
        },
  origin:
    source.origin === null
      ? null
      : {
          host: source.origin.host,
          repo: source.origin.repo,
          skillPath: source.origin.skillPath,
          refRequested: source.origin.refRequested,
          refResolved: source.origin.refResolved,
          pin: source.origin.pin,
        },
  verify:
    source.verify === null
      ? null
      : {
          gate: source.verify.gate,
          verdict: source.verify.verdict,
          mode: source.verify.mode,
        },
  candidates: source.candidates === null ? null : source.candidates.map((candidate) => candidate),
  requestIndex: source.requestIndex,
  groupId: source.groupId,
  pairId: source.pairId,
  executionOutcome: source.executionOutcome,
  drift: toDriftDto(source.drift),
  force: toForceEffectDto(source.force),
});

const toUninstallResultV2Dto = (
  source: CurrentUninstallResult,
): UninstallV2Dto['results'][number] => ({
  skill: source.skill,
  tool: source.tool,
  scope: source.scope,
  placementPath: source.placementPath,
  action: source.action,
  reason: source.reason,
  before:
    source.before === null
      ? null
      : {
          mode: source.before.mode,
          placement: source.before.placement,
          storePath: source.before.storePath,
          symlinkTarget: source.before.symlinkTarget,
        },
  storeRetained: source.storeRetained,
  backupKept: source.backupKept,
  requestIndex: source.requestIndex,
  groupId: source.groupId,
  pairId: source.pairId,
  executionOutcome: source.executionOutcome,
  drift: toDriftDto(source.drift),
  force: toForceEffectDto(source.force),
});

/** Project the current install report without exposing plan internals or core-only errors. */
export const toInstallV2Dto = (report: CurrentInstallReport): InstallV2Dto => {
  assertCurrentReportVersion(report);
  return {
    schemaVersion: 2,
    kind: 'skillsmith.install',
    dryRun: report.dryRun,
    saveMode: report.saveMode,
    artifactPair: toArtifactPairDto(report.artifactPair),
    artifactSelection: toArtifactSelectionDto(report.artifactSelection),
    artifactEffects: report.artifactEffects.map(toArtifactEffectDto),
    requested: {
      sources: report.requested.sources.map(redactSensitiveString),
      tools: report.requested.tools.map((tool) => tool),
      explicitTools: report.requested.explicitTools,
      scope: report.requested.scope,
      explicitScope: report.requested.explicitScope,
      ref: report.requested.ref,
      pin: report.requested.pin,
      direct: report.requested.direct,
      force: report.requested.force,
      verify: report.requested.verify,
      deep: report.requested.deep,
      batchPolicy: report.requested.batchPolicy,
      path: report.requested.path,
    },
    results: report.results.map(toInstallResultV2Dto),
    summary: {
      installed: report.summary.installed,
      updated: report.summary.updated,
      repaired: report.summary.repaired,
      noop: report.summary.noop,
      skipped: report.summary.skipped,
      refused: report.summary.refused,
      failed: report.summary.failed,
      desiredState: {
        changed: report.summary.desiredState.changed,
        unchanged: report.summary.desiredState.unchanged,
        retained: report.summary.desiredState.retained,
        notWritten: report.summary.desiredState.notWritten,
        failed: report.summary.desiredState.failed,
      },
    },
  };
};

/** Project the current uninstall report without exposing plan internals or core-only errors. */
export const toUninstallV2Dto = (report: CurrentUninstallReport): UninstallV2Dto => {
  assertCurrentReportVersion(report);
  return {
    schemaVersion: 2,
    kind: 'skillsmith.uninstall',
    dryRun: report.dryRun,
    saveMode: report.saveMode,
    artifactPair: toArtifactPairDto(report.artifactPair),
    artifactSelection: toArtifactSelectionDto(report.artifactSelection),
    artifactEffects: report.artifactEffects.map(toArtifactEffectDto),
    requested: {
      targets: report.requested.targets.map((target) => target),
      tools: report.requested.tools.map((tool) => tool),
      explicitTools: report.requested.explicitTools,
      scope: report.requested.scope,
      allScopes: report.requested.allScopes,
      force: report.requested.force,
      batchPolicy: report.requested.batchPolicy,
    },
    results: report.results.map(toUninstallResultV2Dto),
    summary: {
      removed: report.summary.removed,
      noop: report.summary.noop,
      refused: report.summary.refused,
      failed: report.summary.failed,
      desiredState: {
        changed: report.summary.desiredState.changed,
        unchanged: report.summary.desiredState.unchanged,
        retained: report.summary.desiredState.retained,
        notWritten: report.summary.desiredState.notWritten,
        failed: report.summary.desiredState.failed,
      },
    },
  };
};

export const installV2Codec = createJsonWireCodec(
  {
    id: 'install',
    version: 2,
    wireKind: 'skillsmith.install',
    embeddedVersion: 'schemaVersion',
    unknownFields: 'reject-recursive',
    formatting: { indent: 2, terminalLf: false },
    migrations: [],
    compatibility: 'conservative',
  },
  InstallV2Schema,
);

export const uninstallV2Codec = createJsonWireCodec(
  {
    id: 'uninstall',
    version: 2,
    wireKind: 'skillsmith.uninstall',
    embeddedVersion: 'schemaVersion',
    unknownFields: 'reject-recursive',
    formatting: { indent: 2, terminalLf: false },
    migrations: [],
    compatibility: 'conservative',
  },
  UninstallV2Schema,
);
