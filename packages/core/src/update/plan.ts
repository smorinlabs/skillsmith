import { resolve } from 'node:path';
import type { AcquisitionArtifactExecutionActionV1 } from '../acquire/execute.ts';
import { toolRegistry } from '../agents/registry.ts';
import { hashCanonicalInput, hashManifestBytes, hashManifestSemantics } from '../artifacts/hash.ts';
import { normalizeSourceIdentity } from '../artifacts/identity.ts';
import { hashPortableLock } from '../artifacts/lock.ts';
import type { PortableLockV1 } from '../artifacts/lock.ts';
import type { SavedPlanV1, SelectionPreconditionMemberV1 } from '../artifacts/plan-types.ts';
import type { NormalizedManifestV1 } from '../artifacts/types.ts';
import type { ProjectContext } from '../context/types.ts';
import { ledgerPathOf, resolveDataDir } from '../place/paths.ts';
import {
  createOperationGroupId,
  createOperationId,
  createOperationPairId,
  createOperationPlan,
  createPlanCheckId,
  createPlanningDiagnosticId,
} from '../planning/create.ts';
import { canonicalPlanningString } from '../planning/order.ts';
import type {
  ExecutableOperation,
  OperationDigest,
  OperationPlan,
  PlanCheck,
  PlanCheckIdentity,
  PlanningDiagnostic,
} from '../planning/types.ts';
import type { ResolvedRuntimeConfiguration } from '../ports/types.ts';
import type { ReconcileArtifactExecutionActionV1 } from '../reconcile/apply-execution.ts';
import {
  createReconcilePlan,
  createSavedPlanProjection,
  observePlanArtifacts,
  observeReconcileInput,
} from '../reconcile/index.ts';
import type {
  ObservedReconcileInput,
  PlanReconcileError,
  ReconcilePlanProduct,
  ResolvedPlanDeclaration,
  ResolvedPlanInput,
  SavedPlanProjection,
} from '../reconcile/index.ts';
import { createSavedPlanScopedArtifactFacts } from '../reconcile/saved.ts';
import { type Result, err, ok } from '../result.ts';
import type { PreparedUpdateArtifactsV1 } from './artifacts.ts';
import type { PreparedUpdateObservationV1, UpdateArtifactTransitionV1 } from './observe.ts';
import type { UpdateApplicationRequestV1, UpdateSelectionV1 } from './types.ts';

export interface PreparedUpdatePlanBaseV1 {
  readonly product: ReconcilePlanProduct;
  readonly observation: ObservedReconcileInput;
  readonly projection: SavedPlanProjection;
  readonly update: PreparedUpdateObservationV1;
  readonly selection: UpdateSelectionV1;
}

export interface PrepareUpdatePlanBaseRequestV1 {
  readonly artifacts: PreparedUpdateArtifactsV1;
  readonly update: PreparedUpdateObservationV1;
  readonly selection: UpdateSelectionV1;
  readonly request: UpdateApplicationRequestV1;
  readonly project: ProjectContext;
}

export interface PrepareUpdatePlanRuntimeV1 {
  readonly ports: Parameters<typeof observeReconcileInput>[1]['ports'];
  readonly configuration: ResolvedRuntimeConfiguration;
  readonly signal?: AbortSignal;
}

const selectedDeclarationRows = (
  input: PrepareUpdatePlanBaseRequestV1,
): readonly ResolvedPlanDeclaration[] => {
  const manifestByName = new Map(input.update.manifest.skills.map((row) => [row.name, row]));
  const lockByName = new Map(input.update.lock.skills.map((row) => [row.name, row]));
  return Object.freeze(
    input.update.selections.flatMap((prepared) => {
      if (prepared.source === null) return [];
      const declaration = manifestByName.get(prepared.selected.declaration.name);
      const lock = lockByName.get(prepared.selected.declaration.name);
      if (declaration === undefined || lock === undefined) {
        throw new TypeError('prepared update declaration/lock projection is incomplete');
      }
      return prepared.selected.tools.map((tool) => Object.freeze({ declaration, lock, tool }));
    }),
  );
};

const savedPreconditionId = (label: string, digest: string): string => {
  const hashed = hashCanonicalInput(
    'resource',
    1,
    JSON.stringify(['skillsmith-saved-plan-precondition-identity', 1, label, digest]),
  );
  if (!hashed.ok) throw new TypeError(hashed.error.message);
  return `precondition:v1:${hashed.value.slice('sha256:'.length)}`;
};

const selectionMemberOrder = (left: unknown, right: unknown): number => {
  const a = JSON.stringify(left);
  const b = JSON.stringify(right);
  return a < b ? -1 : a > b ? 1 : 0;
};

/**
 * Update selects declarations before it expands tool pairs. The shared saved-v1 projector predates
 * declaration selectors and therefore treats an empty skill predicate as a wildcard. Rebind its
 * already-projected graph to update's exact declaration set, including every derived identity,
 * before the shared validator sees the plan.
 */
const bindUpdateSelectionAuthority = (
  projection: SavedPlanProjection,
  observation: ObservedReconcileInput,
  skills: readonly string[],
): Result<SavedPlanProjection, PlanReconcileError> => {
  const plan = projection.plan;
  const selection = plan.selectionPreconditions[0];
  if (selection === undefined || plan.selectionPreconditions.length !== 1) {
    return err({
      code: 'update-plan-selection-authority',
      message: 'shared plan projection did not produce one selection authority',
      exitClass: 'failure',
    });
  }
  const predicates = {
    skills: [...skills],
    tools: [...plan.selection.tools],
    scopes: [...plan.selection.scopes],
  };
  const scoped = createSavedPlanScopedArtifactFacts({
    manifest: observation.resolved.observed.manifest.model,
    lock:
      observation.resolved.observed.lock.state === 'present'
        ? observation.resolved.observed.lock.model
        : null,
    predicates,
    prune: plan.options.prune,
  });
  if (!scoped.ok) return scoped;
  if (
    JSON.stringify(scoped.value.selectedSkills) !== JSON.stringify(plan.selection.skills) ||
    JSON.stringify(scoped.value.selectedTools) !== JSON.stringify(plan.selection.tools) ||
    JSON.stringify(scoped.value.selectedScopes) !== JSON.stringify(plan.selection.scopes)
  ) {
    return err({
      code: 'update-plan-selection-authority',
      message: 'selected update declarations do not match the shared plan selection',
      exitClass: 'state',
    });
  }

  const manifestFacts = plan.resourcePreconditions.filter(
    ({ resource, expectedHash }) =>
      resource.kind === 'manifest-bytes' && expectedHash.domain === 'manifest-semantic',
  );
  const lockFacts = plan.resourcePreconditions.filter(
    ({ resource, expectedHash }) =>
      resource.kind === 'lock' && expectedHash.domain === 'lock-canonical',
  );
  if (manifestFacts.length !== 1 || lockFacts.length !== 1) {
    return err({
      code: 'update-plan-selection-authority',
      message: 'shared plan projection artifact authority is ambiguous',
      exitClass: 'failure',
    });
  }
  const manifestFact = manifestFacts[0];
  const lockFact = lockFacts[0];
  if (manifestFact === undefined || lockFact === undefined) {
    throw new TypeError('checked update artifact facts are absent');
  }
  const manifestPreconditionId = savedPreconditionId(
    'manifest-semantic',
    scoped.value.scopedManifestSemanticHash,
  );
  const lockPreconditionId = savedPreconditionId(
    'lock-canonical',
    scoped.value.scopedLockCanonicalHash,
  );
  const idMap = new Map<string, string>([
    [manifestFact.preconditionId, manifestPreconditionId],
    [lockFact.preconditionId, lockPreconditionId],
  ]);
  const remapIds = (ids: readonly string[]): string[] =>
    ids.map((id) => idMap.get(id) ?? id).sort();
  const resourcePreconditions = plan.resourcePreconditions.map((precondition) => {
    if (precondition.preconditionId === manifestFact.preconditionId) {
      return {
        ...precondition,
        preconditionId: manifestPreconditionId,
        expectedHash: {
          ...precondition.expectedHash,
          digest: scoped.value.scopedManifestSemanticHash,
        },
      };
    }
    if (precondition.preconditionId === lockFact.preconditionId) {
      return {
        ...precondition,
        preconditionId: lockPreconditionId,
        expectedHash: {
          ...precondition.expectedHash,
          digest: scoped.value.scopedLockCanonicalHash,
        },
      };
    }
    return precondition;
  });
  const members = selection.members
    .map((member) => {
      if (
        member.resource.kind === 'manifest-bytes' &&
        member.resourceHash.domain === 'manifest-semantic'
      ) {
        return {
          ...member,
          resourceHash: {
            ...member.resourceHash,
            digest: scoped.value.scopedManifestSemanticHash,
          },
        };
      }
      if (member.resource.kind === 'lock' && member.resourceHash.domain === 'lock-canonical') {
        return {
          ...member,
          resourceHash: {
            ...member.resourceHash,
            digest: scoped.value.scopedLockCanonicalHash,
          },
        };
      }
      return member;
    })
    .sort(selectionMemberOrder) as unknown as SelectionPreconditionMemberV1[];
  const selectionHash = hashCanonicalInput(
    'selection-set',
    1,
    JSON.stringify([
      'skillsmith-saved-plan-selection',
      1,
      selection.selectionSource,
      [...predicates.skills].sort(),
      [...predicates.tools].sort(),
      [...predicates.scopes].sort(),
      members,
    ]),
  );
  if (!selectionHash.ok) {
    return err({
      code: 'update-plan-selection-authority',
      message: selectionHash.error.message,
      exitClass: 'failure',
    });
  }
  const selectionPreconditionId = savedPreconditionId('selection-set', selectionHash.value);
  idMap.set(selection.preconditionId, selectionPreconditionId);

  const checkIdMap = new Map<string, string>();
  const checks = plan.checks.map((check) => {
    const rebound =
      check.kind === 'precondition-validation'
        ? {
            ...check,
            preconditionIds: remapIds(check.preconditionIds) as [string, ...string[]],
          }
        : check;
    const { checkId: _checkId, blocking: _blocking, ...identity } = rebound;
    const checkId = createPlanCheckId({
      ...identity,
      domain: 'skillsmith.plan-check-identity',
      schemaVersion: 1,
    } as unknown as PlanCheckIdentity);
    checkIdMap.set(check.checkId, checkId);
    return { ...rebound, checkId };
  }) as unknown as SavedPlanV1['checks'];
  const operations = plan.operations.map((operation) => ({
    ...operation,
    preconditionIds: remapIds(operation.preconditionIds),
    requiredCheckIds: operation.requiredCheckIds.map((id) => checkIdMap.get(id) ?? id).sort(),
  }));
  const reboundPlan: SavedPlanV1 = {
    ...plan,
    operations,
    checks,
    resourcePreconditions: resourcePreconditions.sort((left, right) =>
      left.preconditionId.localeCompare(right.preconditionId),
    ),
    selectionPreconditions: [
      {
        ...selection,
        preconditionId: selectionPreconditionId,
        expectedHash: selectionHash.value,
        skills: [...predicates.skills].sort(),
        tools: [...predicates.tools].sort(),
        scopes: [...predicates.scopes].sort(),
        members,
      },
    ],
    portability:
      plan.portability.kind === 'portable'
        ? plan.portability
        : {
            ...plan.portability,
            reasons: plan.portability.reasons.map((reason) => ({
              ...reason,
              preconditionIds: remapIds(reason.preconditionIds) as [string, ...string[]],
            })) as unknown as [
              (typeof plan.portability.reasons)[number],
              ...(typeof plan.portability.reasons)[number][],
            ],
          },
  };
  return ok({
    plan: reboundPlan,
    operationPreconditionIds: new Map(
      [...projection.operationPreconditionIds].map(([operationId, ids]) => [
        operationId,
        Object.freeze(remapIds(ids)),
      ]),
    ),
    checkIds: new Map(
      [...projection.checkIds].map(([runtimeId, savedId]) => [
        runtimeId,
        checkIdMap.get(savedId) ?? savedId,
      ]),
    ),
    diagnosticIds: projection.diagnosticIds,
  });
};

/** Reuse shared live/store/ledger observation and pure reconciliation for update's selected rows. */
export const prepareUpdatePlanBaseV1 = async (
  input: PrepareUpdatePlanBaseRequestV1,
  runtime: PrepareUpdatePlanRuntimeV1,
): Promise<Result<PreparedUpdatePlanBaseV1, PlanReconcileError>> => {
  const observed = await observePlanArtifacts(runtime.ports, input.project, input.artifacts.pair, {
    ledgerPath: ledgerPathOf(resolveDataDir(runtime.ports, runtime.configuration)),
  });
  if (!observed.ok) return observed;
  const declarations = selectedDeclarationRows(input);
  const executableNames = input.update.selections
    .filter(({ source }) => source !== null)
    .map(({ selected }) => selected.declaration.name);
  const selectedTools = toolRegistry.ids.filter((tool) =>
    declarations.some((row) => row.tool === tool),
  );
  const selectedScopes = [...new Set(declarations.map(({ declaration }) => declaration.scope))];
  const resolved: ResolvedPlanInput = Object.freeze({
    observed: observed.value,
    request: Object.freeze({
      tools: Object.freeze(selectedTools),
      skills: Object.freeze(executableNames),
      scope: null,
      locked: false,
      prune: false,
      check: input.request.check,
    }),
    declarations,
    selectedSkills: Object.freeze(executableNames),
    selectedTools: Object.freeze(selectedTools),
    selectedScopes: Object.freeze(selectedScopes),
    selectionOutcome: declarations.length === 0 ? 'filter-noop' : 'selected',
    replacementLock: null,
  });
  const observedReconcile = await observeReconcileInput(resolved, {
    ports: runtime.ports,
    configuration: runtime.configuration,
    operation: 'update',
    ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
  });
  if (!observedReconcile.ok) return observedReconcile;
  // Update is declaration-first; unrelated inventory is outside the selected roots and report.
  const boundedObservation: ObservedReconcileInput = Object.freeze({
    ...observedReconcile.value,
    undeclaredPlacements: Object.freeze([]),
    prunePlacements: Object.freeze([]),
  });
  const planned = createReconcilePlan(boundedObservation);
  if (!planned.ok) return planned;
  const selectionSource = input.selection.selectionSource;
  const plan = createOperationPlan({
    ...planned.value.plan,
    selection: {
      source: selectionSource,
      outcome: resolved.selectionOutcome,
      targets: [...input.selection.requestedTargets],
      all: input.request.all,
      skills: [...executableNames],
      tools: [...selectedTools],
      scopes: [...selectedScopes],
    },
    operations: planned.value.plan.operations.map((operation) => ({
      ...operation,
      selectionSource,
    })),
    diagnostics: planned.value.plan.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      selectionSource,
    })),
  });
  const product: ReconcilePlanProduct = Object.freeze({ ...planned.value, plan });
  const projection = createSavedPlanProjection(product, boundedObservation);
  if (!projection.ok) return projection;
  const boundedProjection = bindUpdateSelectionAuthority(
    projection.value,
    boundedObservation,
    executableNames,
  );
  if (!boundedProjection.ok) return boundedProjection;
  return ok(
    Object.freeze({
      product,
      observation: boundedObservation,
      projection: boundedProjection.value,
      update: input.update,
      selection: input.selection,
    }),
  );
};

const manifestSnapshot = (manifest: NormalizedManifestV1) => ({
  version: 1 as const,
  defaults:
    manifest.defaults === undefined
      ? null
      : {
          tools: manifest.defaults.tools ?? null,
          scope: manifest.defaults.scope ?? null,
          path: manifest.defaults.path ?? null,
        },
  registry: manifest.registry === undefined ? null : { default: manifest.registry.default ?? null },
  skills: manifest.skills.map((skill) => ({ ...skill, source: { ...skill.source } })),
});

const lockSnapshot = (lock: PortableLockV1) => ({
  version: 1 as const,
  hashSchemaVersion: 1 as const,
  manifestHash: lock.manifestHash as OperationDigest,
  skills: lock.skills.map((skill) => ({
    ...skill,
    contentHash: skill.contentHash as OperationDigest,
  })),
});

export const updateGroupIdV1 = (
  transition: Pick<UpdateArtifactTransitionV1, 'skill'>,
  source: Extract<ExecutableOperation['source'], { readonly kind: 'portable' }>,
  scope: 'user' | 'project',
): string =>
  createOperationGroupId({
    domain: 'skillsmith.operation-group-identity',
    schemaVersion: 1,
    command: 'update',
    skill: transition.skill,
    source,
    scope,
    target: null,
  });

const manifestOperation = (
  transition: UpdateArtifactTransitionV1,
  groupId: string,
  selectionSource: UpdateSelectionV1['selectionSource'],
  dependencies: readonly string[],
  preconditionIds: readonly string[],
): ExecutableOperation | null => {
  if (transition.manifestEdit === null) return null;
  const location = { kind: 'machine-bound' as const, path: '' };
  const operationId = createOperationId({
    domain: 'skillsmith.operation-identity',
    schemaVersion: 1,
    groupId,
    pairId: null,
    kind: 'write-manifest',
    skill: null,
    source: null,
    tool: null,
    scope: null,
  });
  return {
    operationId,
    groupId,
    pairId: null,
    kind: 'write-manifest',
    dependencyMetadata: {
      domain: 'skillsmith.operation-dependency',
      schemaVersion: 1,
      operationIds: Object.freeze([...dependencies]),
    },
    skill: null,
    source: null,
    tool: null,
    scope: null,
    before: {
      kind: 'manifest',
      location,
      shape: 'canonical',
      version: 1,
      byteHash: hashManifestBytes(transition.manifestBeforeBytes) as OperationDigest,
      semanticHash: hashManifestSemantics(transition.manifestBefore) as OperationDigest,
      value: manifestSnapshot(transition.manifestBefore),
    },
    after: {
      kind: 'manifest',
      location,
      shape: 'canonical',
      version: 1,
      byteHash: hashManifestBytes(transition.manifestAfterBytes) as OperationDigest,
      semanticHash: hashManifestSemantics(transition.manifestAfter) as OperationDigest,
      value: manifestSnapshot(transition.manifestAfter),
    },
    reason: { code: 'update-ref-intent', message: 'Update the selected declaration ref intent.' },
    selectionSource,
    preconditionIds: Object.freeze([...preconditionIds]),
    requiredCheckIds: [],
    reversibility: { kind: 'none', retentionResourceIds: [] },
    mutates: { live: false, manifest: true, lock: false, ledger: false },
    conflict: null,
  };
};

const lockOperation = (
  transition: UpdateArtifactTransitionV1,
  groupId: string,
  lockPath: string,
  selectionSource: UpdateSelectionV1['selectionSource'],
  dependencies: readonly string[],
  preconditionIds: readonly string[],
): ExecutableOperation | null => {
  const beforeHash = hashPortableLock(transition.lockBefore);
  const afterHash = hashPortableLock(transition.lockAfter);
  if (!beforeHash.ok || !afterHash.ok) throw new TypeError('update lock image is invalid');
  if (beforeHash.value === afterHash.value) return null;
  const operationId = createOperationId({
    domain: 'skillsmith.operation-identity',
    schemaVersion: 1,
    groupId,
    pairId: null,
    kind: 'write-lock',
    skill: null,
    source: null,
    tool: null,
    scope: null,
  });
  const location = { kind: 'machine-bound' as const, path: lockPath };
  return {
    operationId,
    groupId,
    pairId: null,
    kind: 'write-lock',
    dependencyMetadata: {
      domain: 'skillsmith.operation-dependency',
      schemaVersion: 1,
      operationIds: Object.freeze([...dependencies]),
    },
    skill: null,
    source: null,
    tool: null,
    scope: null,
    before: {
      kind: 'lock',
      location,
      version: 1,
      canonicalHash: beforeHash.value as OperationDigest,
      value: lockSnapshot(transition.lockBefore),
    },
    after: {
      kind: 'lock',
      location,
      version: 1,
      canonicalHash: afterHash.value as OperationDigest,
      value: lockSnapshot(transition.lockAfter),
    },
    reason: { code: 'update-lock-pin', message: 'Commit the selected declaration exact pin.' },
    selectionSource,
    preconditionIds: Object.freeze([...preconditionIds]),
    requiredCheckIds: [],
    reversibility: { kind: 'none', retentionResourceIds: [] },
    mutates: { live: false, manifest: false, lock: true, ledger: false },
    conflict: null,
  };
};

const checkIdentity = (check: PlanCheck): PlanCheckIdentity => {
  const common = {
    domain: 'skillsmith.plan-check-identity' as const,
    schemaVersion: 1 as const,
    operationIds: check.operationIds,
  };
  switch (check.kind) {
    case 'source-resolution':
      return { ...common, kind: check.kind, source: check.source };
    case 'capability':
      return {
        ...common,
        kind: check.kind,
        capabilityPreconditionId: check.capabilityPreconditionId,
      };
    case 'content-integrity':
      return {
        ...common,
        kind: check.kind,
        source: check.source,
        expectedContentHash: check.expectedContentHash,
      };
    case 'verification':
      return {
        ...common,
        kind: check.kind,
        tool: check.tool,
        mode: check.mode,
        expectedContentHash: check.expectedContentHash,
      };
    case 'precondition-validation':
      return { ...common, kind: check.kind, preconditionIds: check.preconditionIds };
  }
};

const diagnosticWithIds = (
  diagnostic: PlanningDiagnostic,
  groupIds: ReadonlyMap<string, string>,
  operationIds: ReadonlyMap<string, string>,
  selectionSource: UpdateSelectionV1['selectionSource'],
): PlanningDiagnostic => {
  const correlation = {
    groupId:
      diagnostic.correlation.groupId === null
        ? null
        : (groupIds.get(diagnostic.correlation.groupId) ?? diagnostic.correlation.groupId),
    pairId: diagnostic.correlation.pairId,
    operationId:
      diagnostic.correlation.operationId === null
        ? null
        : (operationIds.get(diagnostic.correlation.operationId) ??
          diagnostic.correlation.operationId),
  };
  const identity = {
    domain: 'skillsmith.planning-diagnostic-identity' as const,
    schemaVersion: 1 as const,
    kind: diagnostic.kind,
    severity: diagnostic.severity,
    refusalClass: diagnostic.refusalClass,
    affected: diagnostic.affected,
    correlation,
    reasonCode: diagnostic.reason.code,
    selectionSource,
  };
  return {
    ...diagnostic,
    diagnosticId: createPlanningDiagnosticId(identity),
    correlation,
    selectionSource,
  };
};

export interface PreparedUpdateExecutionPlanV1 {
  readonly plan: OperationPlan<'update'>;
  readonly artifactActions: readonly ReconcileArtifactExecutionActionV1[];
}

const exactPriorManagedPlacement = (
  base: PreparedUpdatePlanBaseV1,
  operation: ExecutableOperation,
): boolean => {
  if (operation.skill === null || operation.tool === null || operation.scope === null) return false;
  if (operation.source?.kind !== 'portable') return false;
  const observed = base.observation.desiredPlacements.find(
    (candidate) =>
      candidate.state === 'observed' &&
      candidate.row.declaration.name === operation.skill &&
      candidate.row.tool === operation.tool &&
      candidate.row.declaration.scope === operation.scope,
  );
  if (
    observed === undefined ||
    observed.state !== 'observed' ||
    observed.ledgerPair === null ||
    observed.ledgerStore?.state !== 'present' ||
    observed.contentHash === null ||
    observed.contentHash !== observed.ledgerStore.contentHash
  ) {
    return false;
  }
  const pair = observed.ledgerPair;
  const pinned = pair.pinned;
  const origin = pair.origin;
  if (
    pair.mode !== 'pinned' ||
    pinned == null ||
    origin === undefined ||
    pair.journal != null ||
    pair.placementPath !== observed.placement.path ||
    resolve(pinned.storePath) !== resolve(observed.ledgerStore.path) ||
    (pinned.placement ?? 'copy') !==
      (observed.placement.class === 'store-linked' ? 'symlink' : 'copy') ||
    origin.host !== observed.row.declaration.source.host ||
    origin.repo !== observed.row.declaration.source.repository ||
    origin.skillPath !== operation.source.sourcePath ||
    (pinned.gitSha !== null && pinned.gitSha !== origin.refResolved)
  ) {
    return false;
  }
  const identity = normalizeSourceIdentity(origin.source, 'update.ledger.origin');
  return (
    identity.ok &&
    canonicalPlanningString(identity.value) ===
      canonicalPlanningString(observed.row.declaration.source)
  );
};

/** Add exact per-declaration artifact prefixes to the already validated shared live plan. */
export const createUpdateExecutionPlanV1 = (
  base: PreparedUpdatePlanBaseV1,
  validatedLivePlan: OperationPlan<'update'>,
  guards: Readonly<{
    readonly resourcePreconditions: readonly { readonly preconditionId: string }[];
    readonly selectionPreconditions: readonly { readonly preconditionId: string }[];
    readonly capabilityPreconditions: readonly { readonly preconditionId: string }[];
  }>,
  continueOnError: boolean,
): Result<PreparedUpdateExecutionPlanV1, PlanReconcileError> => {
  try {
    const selectionSource = base.selection.selectionSource;
    const guardIds = Object.freeze(
      [
        ...guards.resourcePreconditions,
        ...guards.selectionPreconditions,
        ...guards.capabilityPreconditions,
      ].map(({ preconditionId }) => preconditionId),
    );
    const oldToNewGroup = new Map<string, string>();
    const oldToNewPair = new Map<string, string>();
    const oldToNewOperation = new Map<string, string>();
    const liveBySkill = new Map<string, ExecutableOperation[]>();
    for (const operation of validatedLivePlan.operations) {
      if (
        operation.skill === null ||
        operation.source?.kind !== 'portable' ||
        operation.scope === null
      )
        continue;
      const prepared = base.update.selections.find(
        ({ selected }) => selected.declaration.name === operation.skill,
      );
      if (prepared === undefined) continue;
      const transition = base.update.transitions.find(({ skill }) => skill === operation.skill);
      if (transition === undefined) continue;
      const groupId = updateGroupIdV1(transition, operation.source, operation.scope);
      oldToNewGroup.set(operation.groupId, groupId);
      const resource = operation.after.kind === 'placement' ? operation.after.resource : null;
      if (resource === null || operation.tool === null || operation.pairId === null) continue;
      const pairId = createOperationPairId({
        domain: 'skillsmith.operation-pair-identity',
        schemaVersion: 1,
        groupId,
        tool: operation.tool,
        resource,
      });
      oldToNewPair.set(operation.pairId, pairId);
      const kind =
        prepared.candidate.outcome === 'available' &&
        operation.before.kind === 'placement' &&
        operation.after.kind === 'placement' &&
        operation.before.contentHash !== operation.after.contentHash
          ? 'update'
          : 'repair';
      const operationId = createOperationId({
        domain: 'skillsmith.operation-identity',
        schemaVersion: 1,
        groupId,
        pairId,
        kind,
        skill: operation.skill,
        source: operation.source,
        tool: operation.tool,
        scope: operation.scope,
      });
      oldToNewOperation.set(operation.operationId, operationId);
      const currentHash = prepared.currentLock.contentHash;
      const expectedTransition =
        operation.before.kind === 'placement' && operation.before.contentHash === currentHash;
      const exactManagedPrior = exactPriorManagedPlacement(base, operation);
      const projected: ExecutableOperation = {
        ...operation,
        operationId,
        groupId,
        pairId,
        kind,
        selectionSource,
        dependencyMetadata: { ...operation.dependencyMetadata, operationIds: [] },
        requiredCheckIds: [],
        reversibility: { kind: 'conditional', retentionResourceIds: [pairId] },
        conflict:
          (expectedTransition || exactManagedPrior) &&
          (operation.conflict?.class === 'source-changed' ||
            operation.conflict?.class === 'modified-managed-target')
            ? null
            : operation.conflict,
      };
      const rows = liveBySkill.get(operation.skill) ?? [];
      rows.push(projected);
      liveBySkill.set(operation.skill, rows);
    }

    const remappedChecks: PlanCheck[] = [];
    for (const check of validatedLivePlan.checks) {
      const operationIds = check.operationIds
        .map((operationId) => oldToNewOperation.get(operationId))
        .filter((operationId): operationId is string => operationId !== undefined);
      if (operationIds.length === 0) continue;
      const withoutId = {
        ...check,
        operationIds: operationIds as [string, ...string[]],
      } as PlanCheck;
      remappedChecks.push({
        ...withoutId,
        checkId: createPlanCheckId(checkIdentity(withoutId)),
      } as PlanCheck);
    }

    const operations: ExecutableOperation[] = [];
    const checks: PlanCheck[] = [...remappedChecks];
    const actions: ReconcileArtifactExecutionActionV1[] = [];
    let priorArtifactTerminal: string | null = null;
    for (const prepared of base.update.selections) {
      if (prepared.source === null || prepared.candidate.outcome === 'skipped-fixed') continue;
      const transition = base.update.transitions.find(
        ({ skill }) => skill === prepared.selected.declaration.name,
      );
      if (transition === undefined) continue;
      const source = prepared.source.source;
      const groupId = updateGroupIdV1(transition, source, prepared.selected.declaration.scope);
      const groupDependencies = priorArtifactTerminal === null ? [] : [priorArtifactTerminal];
      const manifest = manifestOperation(
        transition,
        groupId,
        selectionSource,
        groupDependencies,
        guardIds,
      );
      if (manifest !== null) {
        // Bind the real selected path after identity construction kept it out of the operation ID.
        const path = base.product.input.observed.pair.file.path;
        const withPath = {
          ...manifest,
          before: { ...manifest.before, location: { kind: 'machine-bound' as const, path } },
          after: { ...manifest.after, location: { kind: 'machine-bound' as const, path } },
        } as ExecutableOperation;
        operations.push(withPath);
        actions.push({
          operationId: withPath.operationId,
          action: {
            role: 'manifest',
            action: {
              kind: 'edit',
              request: transition.manifestEdit as NonNullable<typeof transition.manifestEdit>,
            },
          },
        });
      }
      const lock = lockOperation(
        transition,
        groupId,
        base.product.input.observed.pair.lockfile.path,
        selectionSource,
        [...groupDependencies, ...(manifest === null ? [] : [manifest.operationId])],
        guardIds,
      );
      if (lock !== null) {
        operations.push(lock);
        actions.push({
          operationId: lock.operationId,
          action: {
            role: 'lock',
            action: { kind: 'replace', lock: transition.lockAfter },
          } satisfies AcquisitionArtifactExecutionActionV1,
        });
      }
      const prefix: string | null =
        lock?.operationId ?? manifest?.operationId ?? priorArtifactTerminal;
      const live = liveBySkill.get(prepared.selected.declaration.name) ?? [];
      for (const operation of live) {
        operations.push({
          ...operation,
          dependencyMetadata: {
            ...operation.dependencyMetadata,
            operationIds: [
              ...new Set([...groupDependencies, ...(prefix === null ? [] : [prefix])]),
            ],
          },
        });
      }
      if (lock !== null || manifest !== null) priorArtifactTerminal = prefix;

      const groupOperationIds = [
        ...(manifest === null ? [] : [manifest.operationId]),
        ...(lock === null ? [] : [lock.operationId]),
        ...live.map(({ operationId }) => operationId),
      ];
      const firstOperation = groupOperationIds[0];
      if (firstOperation !== undefined) {
        const sourceCheckBody = {
          checkId: 'check:v1:placeholder',
          blocking: true as const,
          kind: 'source-resolution' as const,
          source,
          operationIds: groupOperationIds as [string, ...string[]],
        };
        const sourceCheck = {
          ...sourceCheckBody,
          checkId: createPlanCheckId(checkIdentity(sourceCheckBody)),
        };
        checks.push(sourceCheck);
        for (const operation of live) {
          if (operation.source === null || operation.tool === null) continue;
          const mode = toolRegistry.get(operation.tool)?.verification?.gatePolicy.update;
          if (mode === undefined) continue;
          const body = {
            checkId: 'check:v1:placeholder',
            blocking: true as const,
            kind: 'verification' as const,
            tool: operation.tool,
            mode,
            expectedContentHash: operation.source.contentHash,
            operationIds: [operation.operationId] as [string],
          };
          checks.push({ ...body, checkId: createPlanCheckId(checkIdentity(body)) });
        }
      }
    }

    const checkIdsByOperation = new Map<string, string[]>();
    for (const check of checks) {
      for (const operationId of check.operationIds) {
        const ids = checkIdsByOperation.get(operationId) ?? [];
        ids.push(check.checkId);
        checkIdsByOperation.set(operationId, ids);
      }
    }
    const checkedOperations = operations.map((operation) => ({
      ...operation,
      requiredCheckIds: Object.freeze([
        ...new Set([
          ...operation.requiredCheckIds,
          ...(checkIdsByOperation.get(operation.operationId) ?? []),
        ]),
      ]),
    }));
    const hasWork = checkedOperations.length > 0;
    const diagnostics = validatedLivePlan.diagnostics
      .filter((diagnostic) => !(hasWork && diagnostic.kind === 'noop'))
      .map((diagnostic) =>
        diagnosticWithIds(diagnostic, oldToNewGroup, oldToNewOperation, selectionSource),
      );
    const plan = createOperationPlan({
      domain: 'skillsmith.operation-plan',
      schemaVersion: 1,
      command: 'update',
      selection: {
        source: selectionSource,
        outcome: base.product.input.selectionOutcome,
        targets: [...base.selection.requestedTargets],
        all: base.selection.selectionSource === 'explicit-all',
        skills: base.update.selections.flatMap(({ selected, source }) =>
          source === null ? [] : [selected.declaration.name],
        ),
        tools: [...base.product.input.selectedTools],
        scopes: [...base.product.input.selectedScopes],
        groupIds: [...new Set(checkedOperations.map(({ groupId }) => groupId))],
      },
      batchPolicy: continueOnError ? 'continue-on-error' : 'fail-fast',
      operations: checkedOperations,
      checks,
      diagnostics,
    });
    return ok(Object.freeze({ plan, artifactActions: Object.freeze(actions) }));
  } catch (error) {
    return err({
      code: 'update-plan-invalid',
      message: error instanceof Error ? error.message : 'update plan construction failed',
      exitClass: 'failure',
    });
  }
};
