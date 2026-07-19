import { dirname, resolve } from 'node:path';
import type { Placement } from '../agents/placement-shared.ts';
import { hashCanonicalInput } from '../artifacts/hash.ts';
import { normalizeSourceIdentity } from '../artifacts/identity.ts';
import type { LedgerPairV1Dto } from '../artifacts/ledger-types.ts';
import type { PortableLockV1 } from '../artifacts/lock.ts';
import { hashPortableLock } from '../artifacts/lock.ts';
import type {
  HashFactV1,
  RepositoryRevisionV1,
  ResourceIdentityV1,
  ResourcePreconditionV1,
} from '../artifacts/plan-types.ts';
import type { NormalizedManifestV1 } from '../artifacts/types.ts';
import { operationSourceFromLedgerPairV1 } from '../planning/create.ts';
import {
  type ExecutableOperation,
  type OperationImage,
  type OperationSource,
  createOperationGroupId,
  createOperationId,
  createOperationPairId,
  createOperationPlan,
  createPlanCheckId,
  createPlanningDiagnosticId,
} from '../planning/index.ts';
import { canonicalPlanningString } from '../planning/order.ts';
import type { OperationDigest, OperationResourceIdentity, PlanCheck } from '../planning/types.ts';
import { type Result, ok } from '../result.ts';
import type {
  ObservedDesiredPlacement,
  ObservedPrunePlacement,
  ObservedReconcileInput,
  ObservedUndeclaredPlacement,
  PlanReconcileError,
  ReconcilePlanProduct,
  ResolvedPlanDeclaration,
  ResolvedPlanInput,
} from './types.ts';

const machineLocation = (path: string) => ({ kind: 'machine-bound' as const, path });

type DesiredObservation = Extract<ObservedDesiredPlacement, { readonly state: 'observed' }>;

const lockSnapshot = (lock: PortableLockV1) => ({
  version: 1 as const,
  hashSchemaVersion: 1 as const,
  manifestHash: lock.manifestHash as OperationDigest,
  skills: lock.skills.map((skill) => ({
    ...skill,
    contentHash: skill.contentHash as OperationDigest,
  })),
});

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

const sourceFor = (row: ResolvedPlanDeclaration): OperationSource => ({
  kind: 'portable',
  identity: { ...row.declaration.source },
  requestedRef: row.declaration.ref,
  resolvedSha: row.lock.resolvedSha,
  sourcePath: row.lock.sourcePath,
  contentHash: row.lock.contentHash as OperationDigest,
});

const preconditionIdFor = (label: string, value: unknown): string => {
  const hashed = hashCanonicalInput(
    'resource',
    1,
    canonicalPlanningString({
      domain: 'skillsmith.reconcile-observation-precondition',
      schemaVersion: 1,
      label,
      value,
    }),
  );
  if (!hashed.ok) throw new Error(hashed.error.message);
  return `precondition:v1:${hashed.value.slice('sha256:'.length)}`;
};

const resourcePreconditionFor = (
  label: string,
  value: unknown,
  resource: ResourceIdentityV1,
  expectedState: 'absent' | 'present',
  domain: HashFactV1['domain'] = 'resource',
  expectedRevision: RepositoryRevisionV1 | null = null,
): ResourcePreconditionV1 => {
  const hashed = hashCanonicalInput(
    domain,
    1,
    canonicalPlanningString({
      domain: 'skillsmith.reconcile-observed-resource',
      schemaVersion: 1,
      label,
      value,
    }),
  );
  if (!hashed.ok) throw new Error(hashed.error.message);
  const revision: RepositoryRevisionV1 | null =
    expectedState === 'absent'
      ? null
      : (expectedRevision ?? { kind: 'resource', digest: hashed.value });
  return Object.freeze({
    preconditionId: preconditionIdFor(label, value),
    resource,
    expectedState,
    expectedHash: { domain, hashSchemaVersion: 1 as const, digest: hashed.value },
    expectedRevision: revision,
  });
};

const projectRootForScope = (
  input: ResolvedPlanInput,
  scope: 'user' | 'project',
): ReturnType<typeof machineLocation> | null =>
  scope === 'project' && input.observed.project.projectRoot !== null
    ? machineLocation(input.observed.project.projectRoot)
    : null;

const resourceForPlacement = (
  input: ResolvedPlanInput,
  row: ResolvedPlanDeclaration,
  scope: 'user' | 'project',
  placement: Placement,
): Extract<OperationResourceIdentity, { kind: 'live' }> => ({
  kind: 'live',
  skill: row.declaration.name,
  tool: row.tool,
  scope,
  projectRoot: projectRootForScope(input, scope),
  location: machineLocation(placement.path),
});

const representationFor = (placement: Placement): 'symlink' | 'copy' | 'other' =>
  placement.class === 'dev' || placement.class === 'store-linked'
    ? 'symlink'
    : placement.class === 'pinned'
      ? 'copy'
      : 'other';

const sourceFromLedger = (pair: LedgerPairV1Dto | null): OperationSource | null =>
  operationSourceFromLedgerPairV1(pair, null);

const placementImage = (
  placement: Placement,
  resource: Extract<OperationResourceIdentity, { kind: 'live' }>,
  contentHash: OperationDigest | null,
  ledgerPair: LedgerPairV1Dto | null,
): OperationImage => {
  const ledgerSource = sourceFromLedger(ledgerPair);
  const exactLedgerSource = ledgerPair?.pinned?.contentHash === contentHash ? ledgerSource : null;
  const source: OperationSource | null =
    contentHash === null
      ? null
      : (exactLedgerSource ?? {
          kind: 'local-dev',
          path: placement.path,
          contentHash,
        });
  return {
    kind: 'placement',
    resource,
    classification:
      ledgerPair === null || placement.class === 'absent' ? 'unmanaged' : placement.class,
    representation: representationFor(placement),
    linkTarget:
      placement.symlinkTarget === null
        ? null
        : machineLocation(resolve(dirname(placement.path), placement.symlinkTarget)),
    dangling: placement.dangling,
    source,
    contentHash,
  };
};

const refusalDiagnostic = (
  refused: Extract<ObservedDesiredPlacement, { readonly state: 'refused' }>,
) => {
  const source = sourceFor(refused.row);
  const identity = {
    domain: 'skillsmith.planning-diagnostic-identity' as const,
    schemaVersion: 1 as const,
    kind: 'refuse' as const,
    severity: 'error' as const,
    refusalClass: refused.refusalClass,
    affected: {
      skill: refused.row.declaration.name,
      source,
      tool: refused.row.tool,
      scope: refused.row.declaration.scope,
      path: refused.path === null ? null : machineLocation(refused.path),
    },
    correlation: { groupId: null, pairId: null, operationId: null },
    reasonCode: refused.reasonCode,
    selectionSource: 'bounded-default' as const,
  };
  return {
    diagnosticId: createPlanningDiagnosticId(identity),
    kind: identity.kind,
    severity: identity.severity,
    refusalClass: identity.refusalClass,
    affected: identity.affected,
    correlation: identity.correlation,
    reason: { code: identity.reasonCode, message: refused.remediation },
    selectionSource: identity.selectionSource,
  };
};

const resourcePreconditionsForRefusal = (
  input: ResolvedPlanInput,
  refused: Extract<ObservedDesiredPlacement, { readonly state: 'refused' }>,
): readonly ResourcePreconditionV1[] => {
  const ledgerRevision =
    input.observed.ledger?.state === 'present'
      ? {
          state: 'present' as const,
          byteRevision: input.observed.ledger.byteRevision,
          semanticRevision: input.observed.ledger.semanticRevision,
        }
      : { state: 'absent' as const };
  const ledgerExpectedRevision: RepositoryRevisionV1 | null =
    input.observed.ledger?.state === 'present'
      ? { kind: 'artifact-bytes', digest: input.observed.ledger.byteRevision }
      : null;
  return Object.freeze(
    refused.evidence.flatMap((evidence) => [
      resourcePreconditionFor(
        'refused-live',
        {
          tool: refused.row.tool,
          scope: evidence.scope,
          placement: evidence.placement,
          contentHash: evidence.contentHash,
        },
        resourceForPlacement(input, refused.row, evidence.scope, evidence.placement),
        evidence.placement.class === 'absent' ? 'absent' : 'present',
      ),
      resourcePreconditionFor(
        'refused-ledger',
        {
          revision: ledgerRevision,
          projectRoot: evidence.scope === 'project' ? input.observed.project.projectRoot : null,
          skill: refused.row.declaration.name,
          tool: refused.row.tool,
          pair: evidence.ledgerPair,
        },
        { kind: 'ledger', projectRoot: projectRootForScope(input, evidence.scope) },
        input.observed.ledger?.state === 'present' ? 'present' : 'absent',
        'resource',
        ledgerExpectedRevision,
      ),
    ]),
  );
};

const noopDiagnostic = () => {
  const identity = {
    domain: 'skillsmith.planning-diagnostic-identity' as const,
    schemaVersion: 1 as const,
    kind: 'noop' as const,
    severity: 'info' as const,
    refusalClass: null,
    affected: { skill: null, source: null, tool: null, scope: null, path: null },
    correlation: { groupId: null, pairId: null, operationId: null },
    reasonCode: 'plan-already-converged',
    selectionSource: 'bounded-default' as const,
  };
  return {
    diagnosticId: createPlanningDiagnosticId(identity),
    kind: identity.kind,
    severity: identity.severity,
    refusalClass: identity.refusalClass,
    affected: identity.affected,
    correlation: identity.correlation,
    reason: {
      code: identity.reasonCode,
      message: 'Selected desired and current state are converged.',
    },
    selectionSource: identity.selectionSource,
  };
};

const undeclaredPlacementDiagnostic = (undeclared: ObservedUndeclaredPlacement) => {
  const identity = {
    domain: 'skillsmith.planning-diagnostic-identity' as const,
    schemaVersion: 1 as const,
    kind: 'warning' as const,
    severity: 'warning' as const,
    refusalClass: null,
    affected: {
      skill: undeclared.placement.skill,
      source: sourceFromLedger(undeclared.ledgerPair),
      tool: undeclared.tool,
      scope: undeclared.scope,
      path: machineLocation(undeclared.placement.path),
    },
    correlation: { groupId: null, pairId: null, operationId: null },
    reasonCode: 'plan-undeclared-placement-preserved',
    selectionSource: 'bounded-default' as const,
  };
  return {
    diagnosticId: createPlanningDiagnosticId(identity),
    kind: identity.kind,
    severity: identity.severity,
    refusalClass: identity.refusalClass,
    affected: identity.affected,
    correlation: identity.correlation,
    reason: {
      code: identity.reasonCode,
      message:
        'Undeclared live placement is preserved because no matching prune authority was proven.',
    },
    selectionSource: identity.selectionSource,
  };
};

const ledgerMatchesDesired = (
  pair: LedgerPairV1Dto | null,
  row: ResolvedPlanDeclaration,
  placementPath: string,
): boolean => {
  if (
    pair === null ||
    pair.mode !== 'pinned' ||
    pair.pinned == null ||
    pair.origin === undefined ||
    pair.journal != null ||
    pair.placementPath !== placementPath ||
    pair.pinned.contentHash !== row.lock.contentHash ||
    pair.origin.host !== row.declaration.source.host ||
    pair.origin.repo !== row.declaration.source.repository ||
    pair.origin.skillPath !== (row.declaration.source.path ?? '.') ||
    pair.origin.refRequested !== row.lock.requestedRef ||
    pair.origin.refResolved !== row.lock.resolvedSha ||
    (pair.pinned.gitSha !== null && pair.pinned.gitSha !== row.lock.resolvedSha)
  ) {
    return false;
  }
  const actualSource = sourceFromLedger(pair);
  return (
    actualSource !== null &&
    canonicalPlanningString(actualSource) === canonicalPlanningString(sourceFor(row))
  );
};

const desiredRepresentationMatches = (desired: DesiredObservation): boolean => {
  if (desired.row.declaration.placement === 'copy') {
    return desired.placement.class === 'pinned' && desired.placement.symlinkTarget === null;
  }
  return (
    desired.placement.class === 'store-linked' &&
    desired.placement.symlinkTarget !== null &&
    resolve(dirname(desired.placement.path), desired.placement.symlinkTarget) ===
      resolve(desired.store.path)
  );
};

const moveCandidate = (desired: DesiredObservation): DesiredObservation['opposite'] => {
  const opposite = desired.opposite;
  if (
    desired.placement.class !== 'absent' ||
    desired.ledgerPair !== null ||
    opposite === null ||
    opposite.placement.class === 'absent' ||
    opposite.placement.class === 'dev' ||
    opposite.placement.dangling ||
    opposite.contentHash !== desired.row.lock.contentHash ||
    !ledgerMatchesDesired(opposite.ledgerPair, desired.row, opposite.placement.path)
  ) {
    return null;
  }
  return opposite;
};

const operationKindFor = (desired: DesiredObservation): ExecutableOperation['kind'] | null => {
  if (moveCandidate(desired) !== null) return 'move-scope';
  if (desired.placement.class === 'absent') return 'install';
  const exactLedger = ledgerMatchesDesired(desired.ledgerPair, desired.row, desired.placement.path);
  const exactContent = desired.contentHash === desired.row.lock.contentHash;
  const exactRepresentation = desiredRepresentationMatches(desired);
  const exactStore =
    desired.store.state === 'present' && desired.store.contentHash === desired.row.lock.contentHash;
  if (exactLedger && exactContent && exactRepresentation && exactStore) return null;
  if (
    desired.placement.dangling ||
    (exactLedger && exactContent && exactRepresentation && !exactStore) ||
    (desired.ledgerPair === null && exactContent && exactRepresentation)
  ) {
    return 'repair';
  }
  return 'update';
};

const observedPlacementPreconditions = (
  input: ResolvedPlanInput,
  desired: DesiredObservation,
): readonly string[] =>
  Object.freeze(
    resourcePreconditionsForDesired(input, desired)
      .map(({ preconditionId }) => preconditionId)
      .sort(),
  );

const resourcePreconditionsForDesired = (
  input: ResolvedPlanInput,
  desired: DesiredObservation,
): readonly ResourcePreconditionV1[] => {
  const ledgerRevision =
    input.observed.ledger?.state === 'present'
      ? {
          state: 'present',
          byteRevision: input.observed.ledger.byteRevision,
          semanticRevision: input.observed.ledger.semanticRevision,
        }
      : { state: 'absent' };
  const desiredLiveFacts = {
    tool: desired.row.tool,
    scope: desired.row.declaration.scope,
    placement: desired.placement,
    contentHash: desired.contentHash,
  };
  const desiredLedgerFacts = {
    revision: ledgerRevision,
    projectRoot:
      desired.row.declaration.scope === 'project' ? input.observed.project.projectRoot : null,
    skill: desired.row.declaration.name,
    tool: desired.row.tool,
    pair: desired.ledgerPair,
  };
  const ledgerExpectedRevision: RepositoryRevisionV1 | null =
    input.observed.ledger?.state === 'present'
      ? { kind: 'artifact-bytes', digest: input.observed.ledger.byteRevision }
      : null;
  const preconditions = [
    resourcePreconditionFor(
      'desired-live',
      desiredLiveFacts,
      resourceForPlacement(
        input,
        desired.row,
        desired.row.declaration.scope,
        desired.placement,
      ) as ResourceIdentityV1,
      desired.placement.class === 'absent' ? 'absent' : 'present',
    ),
    resourcePreconditionFor(
      'desired-ledger',
      desiredLedgerFacts,
      {
        kind: 'ledger',
        projectRoot: projectRootForScope(input, desired.row.declaration.scope),
      },
      input.observed.ledger?.state === 'present' ? 'present' : 'absent',
      'resource',
      ledgerExpectedRevision,
    ),
    resourcePreconditionFor(
      'desired-store',
      desired.store,
      { kind: 'store', contentHash: desired.row.lock.contentHash },
      desired.store.state === 'absent' ? 'absent' : 'present',
      'source-content',
    ),
  ];
  const opposite = moveCandidate(desired);
  if (opposite !== null) {
    const oppositeLiveFacts = {
      tool: desired.row.tool,
      scope: opposite.scope,
      placement: opposite.placement,
      contentHash: opposite.contentHash,
    };
    const oppositeLedgerFacts = {
      revision: ledgerRevision,
      projectRoot: opposite.scope === 'project' ? input.observed.project.projectRoot : null,
      skill: desired.row.declaration.name,
      tool: desired.row.tool,
      pair: opposite.ledgerPair,
    };
    preconditions.push(
      resourcePreconditionFor(
        'opposite-live',
        oppositeLiveFacts,
        resourceForPlacement(
          input,
          desired.row,
          opposite.scope,
          opposite.placement,
        ) as ResourceIdentityV1,
        'present',
      ),
      resourcePreconditionFor(
        'opposite-ledger',
        oppositeLedgerFacts,
        { kind: 'ledger', projectRoot: projectRootForScope(input, opposite.scope) },
        'present',
        'resource',
        ledgerExpectedRevision,
      ),
    );
  }
  return Object.freeze(preconditions);
};

const conflictFor = (
  desired: DesiredObservation,
  resource: Extract<OperationResourceIdentity, { kind: 'live' }>,
): ExecutableOperation['conflict'] => {
  if (desired.placement.class === 'absent' || moveCandidate(desired) !== null) return null;
  if (desired.ledgerPair === null) {
    return {
      class: 'unmanaged-target',
      normal: 'refuse',
      forced: 'backup-and-replace',
      target: resource,
      backup: 'required',
    };
  }
  const pinned = desired.ledgerPair.pinned;
  if (
    pinned != null &&
    (pinned.placement ?? 'copy') === 'copy' &&
    desired.placement.class === 'pinned' &&
    desired.contentHash !== null &&
    desired.contentHash !== pinned.contentHash
  ) {
    return {
      class: 'modified-managed-target',
      normal: 'refuse',
      forced: 'backup-and-replace',
      target: resource,
      backup: 'required',
    };
  }
  const currentSource = sourceFromLedger(desired.ledgerPair);
  if (
    currentSource === null ||
    canonicalPlanningString(currentSource) !== canonicalPlanningString(sourceFor(desired.row))
  ) {
    return {
      class: 'source-changed',
      normal: 'refuse',
      forced: 'replace',
      target: resource,
      backup: 'none',
    };
  }
  return null;
};

const operationFromPlacement = (
  input: ResolvedPlanInput,
  desired: DesiredObservation,
  kind: ExecutableOperation['kind'],
): ExecutableOperation => {
  const row = desired.row;
  const source = sourceFor(row);
  const resource = resourceForPlacement(input, row, row.declaration.scope, desired.placement);
  const groupId = createOperationGroupId({
    domain: 'skillsmith.operation-group-identity',
    schemaVersion: 1,
    command: 'plan',
    skill: row.declaration.name,
    source,
    scope: row.declaration.scope,
    target: null,
  });
  const pairId = createOperationPairId({
    domain: 'skillsmith.operation-pair-identity',
    schemaVersion: 1,
    groupId,
    tool: row.tool,
    resource,
  });
  const operationId = createOperationId({
    domain: 'skillsmith.operation-identity',
    schemaVersion: 1,
    groupId,
    pairId,
    kind,
    skill: row.declaration.name,
    source,
    tool: row.tool,
    scope: row.declaration.scope,
  });
  const opposite = moveCandidate(desired);
  const before: OperationImage =
    opposite !== null
      ? placementImage(
          opposite.placement,
          resourceForPlacement(input, row, opposite.scope, opposite.placement),
          opposite.contentHash,
          opposite.ledgerPair,
        )
      : desired.placement.class === 'absent'
        ? { kind: 'absent', resource }
        : placementImage(desired.placement, resource, desired.contentHash, desired.ledgerPair);
  const after: OperationImage = {
    kind: 'placement',
    resource,
    classification: 'pinned',
    representation: row.declaration.placement,
    linkTarget:
      row.declaration.placement === 'symlink' ? machineLocation(desired.store.path) : null,
    dangling: false,
    source,
    contentHash: source.contentHash,
  };
  return {
    operationId,
    groupId,
    pairId,
    kind,
    dependencyMetadata: {
      domain: 'skillsmith.operation-dependency',
      schemaVersion: 1,
      operationIds: [],
    },
    skill: row.declaration.name,
    source,
    tool: row.tool,
    scope: row.declaration.scope,
    before,
    after,
    reason: {
      code:
        kind === 'install'
          ? 'desired-placement-absent'
          : kind === 'move-scope'
            ? 'desired-placement-move-scope'
            : kind === 'repair'
              ? 'desired-placement-repair'
              : desired.contentHash === row.lock.contentHash &&
                  !desiredRepresentationMatches(desired)
                ? 'desired-placement-relink'
                : 'desired-placement-update',
      message:
        kind === 'install'
          ? 'The selected desired placement is absent.'
          : kind === 'move-scope'
            ? 'The ledger-owned placement belongs in the selected scope.'
            : kind === 'repair'
              ? 'The selected managed placement requires repair.'
              : 'The selected placement requires a desired-state update.',
    },
    selectionSource: 'bounded-default',
    preconditionIds: observedPlacementPreconditions(input, desired),
    requiredCheckIds: [],
    reversibility: { kind: 'conditional', retentionResourceIds: [pairId] },
    mutates: { live: true, manifest: false, lock: false, ledger: true },
    conflict: conflictFor(desired, resource),
  };
};

const resourcePreconditionsForPrune = (
  input: ResolvedPlanInput,
  prune: ObservedPrunePlacement,
): readonly ResourcePreconditionV1[] => {
  const liveFacts = {
    scope: prune.scope,
    tool: prune.tool,
    placement: prune.placement,
    contentHash: prune.contentHash,
  };
  const ledgerFacts = {
    revision:
      input.observed.ledger?.state === 'present'
        ? {
            byteRevision: input.observed.ledger.byteRevision,
            semanticRevision: input.observed.ledger.semanticRevision,
          }
        : null,
    projectRoot: prune.scope === 'project' ? input.observed.project.projectRoot : null,
    skill: prune.pin.name,
    tool: prune.tool,
    pair: prune.ledgerPair,
  };
  return Object.freeze([
    resourcePreconditionFor(
      'prune-live',
      liveFacts,
      {
        kind: 'live',
        skill: prune.pin.name,
        tool: prune.tool,
        scope: prune.scope,
        projectRoot: projectRootForScope(input, prune.scope),
        location: machineLocation(prune.placement.path),
      },
      'present',
    ),
    resourcePreconditionFor(
      'prune-ledger',
      ledgerFacts,
      { kind: 'ledger', projectRoot: projectRootForScope(input, prune.scope) },
      'present',
      'resource',
      input.observed.ledger?.state === 'present'
        ? { kind: 'artifact-bytes', digest: input.observed.ledger.byteRevision }
        : null,
    ),
  ]);
};

const removeOperationFromPlacement = (
  input: ResolvedPlanInput,
  prune: ObservedPrunePlacement,
): ExecutableOperation | null => {
  const { pin, tool, scope, placement, ledgerPair } = prune;
  if (ledgerPair === null) return null;
  const identity = normalizeSourceIdentity(
    pin.source.includes('://') ? pin.source : `https://${pin.source}`,
    'plan.prune.source',
  );
  if (!identity.ok) return null;
  const source: OperationSource = {
    kind: 'portable',
    identity: identity.value,
    requestedRef: pin.requestedRef,
    resolvedSha: pin.resolvedSha,
    sourcePath: pin.sourcePath,
    contentHash: pin.contentHash as OperationDigest,
  };
  const originIdentity = normalizeSourceIdentity(
    ledgerPair.origin?.source ?? '',
    'plan.prune.ledger',
  );
  if (
    !originIdentity.ok ||
    ledgerPair.mode !== 'pinned' ||
    ledgerPair.pinned == null ||
    ledgerPair.origin === undefined ||
    ledgerPair.journal != null ||
    ledgerPair.placementPath !== placement.path ||
    ledgerPair.pinned.contentHash !== pin.contentHash ||
    prune.contentHash !== pin.contentHash ||
    canonicalPlanningString(originIdentity.value) !== canonicalPlanningString(identity.value) ||
    ledgerPair.origin.host !== identity.value.host ||
    ledgerPair.origin.repo !== identity.value.repository ||
    ledgerPair.origin.skillPath !== pin.sourcePath ||
    ledgerPair.origin.refRequested !== pin.requestedRef ||
    ledgerPair.origin.refResolved !== pin.resolvedSha ||
    (ledgerPair.pinned.gitSha !== null && ledgerPair.pinned.gitSha !== pin.resolvedSha) ||
    ((ledgerPair.pinned.placement ?? 'copy') === 'symlink'
      ? placement.class !== 'store-linked' ||
        placement.symlinkTarget === null ||
        resolve(dirname(placement.path), placement.symlinkTarget) !==
          resolve(ledgerPair.pinned.storePath)
      : placement.class !== 'pinned')
  ) {
    return null;
  }
  const projectRoot = projectRootForScope(input, scope);
  const resource = {
    kind: 'live' as const,
    skill: pin.name,
    tool,
    scope,
    projectRoot,
    location: machineLocation(placement.path),
  };
  const groupId = createOperationGroupId({
    domain: 'skillsmith.operation-group-identity',
    schemaVersion: 1,
    command: 'plan',
    skill: pin.name,
    source,
    scope,
    target: null,
  });
  const pairId = createOperationPairId({
    domain: 'skillsmith.operation-pair-identity',
    schemaVersion: 1,
    groupId,
    tool,
    resource,
  });
  const operationId = createOperationId({
    domain: 'skillsmith.operation-identity',
    schemaVersion: 1,
    groupId,
    pairId,
    kind: 'remove',
    skill: pin.name,
    source,
    tool,
    scope,
  });
  return {
    operationId,
    groupId,
    pairId,
    kind: 'remove',
    dependencyMetadata: {
      domain: 'skillsmith.operation-dependency',
      schemaVersion: 1,
      operationIds: [],
    },
    skill: pin.name,
    source,
    tool,
    scope,
    before: placementImage(placement, resource, prune.contentHash, ledgerPair),
    after: { kind: 'absent', resource },
    reason: {
      code: 'prune-lock-owned-placement',
      message: 'The selected artifact pair no longer declares this managed placement.',
    },
    selectionSource: 'bounded-default',
    preconditionIds: Object.freeze(
      resourcePreconditionsForPrune(input, prune)
        .map(({ preconditionId }) => preconditionId)
        .sort(),
    ),
    requiredCheckIds: [],
    reversibility: { kind: 'conditional', retentionResourceIds: [pairId] },
    mutates: { live: true, manifest: false, lock: false, ledger: true },
    conflict: null,
  };
};

const lockOperation = (input: ResolvedPlanInput): ExecutableOperation | null => {
  const replacement = input.replacementLock;
  if (replacement === null) return null;
  const location = machineLocation(input.observed.pair.lockfile.path);
  const resource = { kind: 'lock' as const, location };
  const groupId = createOperationGroupId({
    domain: 'skillsmith.operation-group-identity',
    schemaVersion: 1,
    command: 'plan',
    skill: null,
    source: null,
    scope: null,
    target: input.observed.pair.lockfile.path,
  });
  const kind = 'write-lock' as const;
  const operationId = createOperationId({
    domain: 'skillsmith.operation-identity',
    schemaVersion: 1,
    groupId,
    pairId: null,
    kind,
    skill: null,
    source: null,
    tool: null,
    scope: null,
  });
  const afterHash = hashPortableLock(replacement);
  if (!afterHash.ok) throw new Error(afterHash.error.message);
  let before: OperationImage = { kind: 'absent', resource };
  if (input.observed.lock.state === 'present') {
    const beforeHash = hashPortableLock(input.observed.lock.model);
    if (!beforeHash.ok) throw new Error(beforeHash.error.message);
    before = {
      kind: 'lock',
      location,
      version: 1,
      canonicalHash: beforeHash.value as OperationDigest,
      value: lockSnapshot(input.observed.lock.model),
    };
  }
  return {
    operationId,
    groupId,
    pairId: null,
    kind,
    dependencyMetadata: {
      domain: 'skillsmith.operation-dependency',
      schemaVersion: 1,
      operationIds: [],
    },
    skill: null,
    source: null,
    tool: null,
    scope: null,
    before,
    after: {
      kind: 'lock',
      location,
      version: 1,
      canonicalHash: afterHash.value as OperationDigest,
      value: lockSnapshot(replacement),
    },
    reason: { code: 'portable-lock-stale', message: 'The selected portable lock needs refresh.' },
    selectionSource: 'bounded-default',
    preconditionIds: [],
    requiredCheckIds: [],
    reversibility: { kind: 'none', retentionResourceIds: [] },
    mutates: { live: false, manifest: false, lock: true, ledger: false },
    conflict: null,
  };
};

const ledgerMigrationOperation = (input: ResolvedPlanInput): ExecutableOperation | null => {
  const ledger = input.observed.ledger;
  const ledgerPath = input.observed.ledgerPath;
  if (
    ledgerPath === undefined ||
    ledger?.state !== 'present' ||
    ledger.sourceVersion !== 1 ||
    ledger.migration?.kind !== 'ledger-v1-to-v2'
  ) {
    return null;
  }
  const migration = ledger.migration;
  const groupId = createOperationGroupId({
    domain: 'skillsmith.operation-group-identity',
    schemaVersion: 1,
    command: 'plan',
    skill: null,
    source: null,
    scope: null,
    target: ledgerPath,
  });
  const operationId = createOperationId({
    domain: 'skillsmith.operation-identity',
    schemaVersion: 1,
    groupId,
    pairId: null,
    kind: 'migrate-ledger',
    skill: null,
    source: null,
    tool: null,
    scope: null,
  });
  return {
    operationId,
    groupId,
    pairId: null,
    kind: 'migrate-ledger',
    dependencyMetadata: {
      domain: 'skillsmith.operation-dependency',
      schemaVersion: 1,
      operationIds: [],
    },
    skill: null,
    source: null,
    tool: null,
    scope: null,
    before: {
      kind: 'ledger',
      projectRoot: null,
      schemaVersion: 1,
      byteHash: migration.sourceByteRevision as OperationDigest,
      semanticHash: migration.sourceSemanticRevision as OperationDigest,
    },
    after: {
      kind: 'ledger',
      projectRoot: null,
      schemaVersion: 2,
      byteHash: migration.targetByteRevision as OperationDigest,
      semanticHash: migration.targetSemanticRevision as OperationDigest,
    },
    reason: {
      code: 'migrate-ledger',
      message: 'The placement ledger requires canonical v2 migration before convergence.',
    },
    selectionSource: 'bounded-default',
    preconditionIds: [],
    requiredCheckIds: [],
    reversibility: { kind: 'none', retentionResourceIds: [] },
    mutates: { live: false, manifest: false, lock: false, ledger: true },
    conflict: null,
  };
};

const projectConfigMigrationOperation = (input: ResolvedPlanInput): ExecutableOperation | null => {
  const manifest = input.observed.manifest;
  if (
    manifest.sourceVersion !== 'legacy' ||
    manifest.migration?.kind !== 'migrate-project-config'
  ) {
    return null;
  }
  const migration = manifest.migration;
  const location = machineLocation(input.observed.pair.file.path);
  const groupId = createOperationGroupId({
    domain: 'skillsmith.operation-group-identity',
    schemaVersion: 1,
    command: 'plan',
    skill: null,
    source: null,
    scope: null,
    target: input.observed.pair.file.path,
  });
  const operationId = createOperationId({
    domain: 'skillsmith.operation-identity',
    schemaVersion: 1,
    groupId,
    pairId: null,
    kind: 'migrate-project-config',
    skill: null,
    source: null,
    tool: null,
    scope: null,
  });
  const value = manifestSnapshot(manifest.model);
  return {
    operationId,
    groupId,
    pairId: null,
    kind: 'migrate-project-config',
    dependencyMetadata: {
      domain: 'skillsmith.operation-dependency',
      schemaVersion: 1,
      operationIds: [],
    },
    skill: null,
    source: null,
    tool: null,
    scope: null,
    before: {
      kind: 'manifest',
      location,
      shape: 'legacy',
      version: 1,
      byteHash: migration.expectedByteRevision as OperationDigest,
      semanticHash: migration.expectedSemanticRevision as OperationDigest,
      value,
    },
    after: {
      kind: 'manifest',
      location,
      shape: 'canonical',
      version: 1,
      byteHash: migration.resultByteRevision as OperationDigest,
      semanticHash: migration.resultSemanticRevision as OperationDigest,
      value,
    },
    reason: {
      code: 'migrate-project-config',
      message: 'The selected legacy project artifact has an exact canonical migration.',
    },
    selectionSource: 'bounded-default',
    preconditionIds: [],
    requiredCheckIds: [],
    reversibility: { kind: 'none', retentionResourceIds: [] },
    mutates: { live: false, manifest: true, lock: false, ledger: false },
    conflict: null,
  };
};

const checksFor = (
  input: ObservedReconcileInput,
  operations: readonly ExecutableOperation[],
): Readonly<{
  readonly operations: readonly ExecutableOperation[];
  readonly checks: readonly PlanCheck[];
}> => {
  const checks: PlanCheck[] = [];
  const checkIdsByOperation = new Map<string, string[]>();
  const add = (check: PlanCheck): void => {
    checks.push(check);
    for (const operationId of check.operationIds) {
      const current = checkIdsByOperation.get(operationId) ?? [];
      current.push(check.checkId);
      checkIdsByOperation.set(operationId, current);
    }
  };

  for (const operation of operations) {
    if (operation.source === null) continue;
    const identity = {
      domain: 'skillsmith.plan-check-identity' as const,
      schemaVersion: 1 as const,
      kind: 'content-integrity' as const,
      operationIds: [operation.operationId] as const,
      source: operation.source,
      expectedContentHash: operation.source.contentHash,
    };
    add({
      checkId: createPlanCheckId(identity),
      blocking: true,
      kind: identity.kind,
      operationIds: identity.operationIds,
      source: identity.source,
      expectedContentHash: identity.expectedContentHash,
    });
  }

  for (const precondition of input.capabilityPreconditions) {
    const operationIds = operations
      .filter(
        (operation) =>
          operation.tool === precondition.tool &&
          operation.scope !== null &&
          precondition.scopes.includes(operation.scope),
      )
      .map(({ operationId }) => operationId);
    const first = operationIds[0];
    if (first === undefined) continue;
    const identity = {
      domain: 'skillsmith.plan-check-identity' as const,
      schemaVersion: 1 as const,
      kind: 'capability' as const,
      operationIds: [first, ...operationIds.slice(1)] as [string, ...string[]],
      capabilityPreconditionId: precondition.preconditionId,
    };
    add({
      checkId: createPlanCheckId(identity),
      blocking: true,
      kind: identity.kind,
      operationIds: identity.operationIds,
      capabilityPreconditionId: identity.capabilityPreconditionId,
    });
  }

  return {
    operations: operations.map((operation) => ({
      ...operation,
      requiredCheckIds: checkIdsByOperation.get(operation.operationId) ?? [],
    })),
    checks,
  };
};

export const createReconcilePlan = (
  observation: ObservedReconcileInput,
): Result<ReconcilePlanProduct, PlanReconcileError> => {
  const input = observation.resolved;
  const operations: ExecutableOperation[] = [];
  const resourcePreconditionById = new Map<string, ResourcePreconditionV1>();
  const addPreconditions = (items: readonly ResourcePreconditionV1[]): void => {
    for (const item of items) resourcePreconditionById.set(item.preconditionId, item);
  };
  const diagnostics = [];
  const machineBoundLivePaths = new Set<string>();
  const removedLiveKeys = new Set<string>();

  for (const desired of observation.desiredPlacements) {
    if (desired.state === 'refused') {
      for (const evidence of desired.evidence) {
        if (evidence.binding === 'custom') {
          machineBoundLivePaths.add(evidence.placement.path);
        }
      }
      diagnostics.push(refusalDiagnostic(desired));
      addPreconditions(resourcePreconditionsForRefusal(input, desired));
      continue;
    }
    if (desired.binding === 'custom') machineBoundLivePaths.add(desired.placement.path);
    if (desired.opposite?.binding === 'custom') {
      machineBoundLivePaths.add(desired.opposite.placement.path);
    }
    const kind = operationKindFor(desired);
    if (kind !== null) {
      operations.push(operationFromPlacement(input, desired, kind));
      addPreconditions(resourcePreconditionsForDesired(input, desired));
    }
  }

  for (const prune of observation.prunePlacements) {
    if (
      prune.duplicateReason !== null ||
      prune.placement.class === 'absent' ||
      prune.placement.class === 'dev' ||
      prune.placement.dangling ||
      prune.contentHash !== prune.pin.contentHash
    ) {
      continue;
    }
    const removal = removeOperationFromPlacement(input, prune);
    if (removal !== null) {
      operations.push(removal);
      removedLiveKeys.add(
        `${prune.tool}\0${prune.scope}\0${prune.pin.name}\0${prune.placement.path}`,
      );
      addPreconditions(resourcePreconditionsForPrune(input, prune));
    }
  }

  for (const undeclared of observation.undeclaredPlacements) {
    const key = `${undeclared.tool}\0${undeclared.scope}\0${undeclared.placement.skill}\0${undeclared.placement.path}`;
    if (!removedLiveKeys.has(key)) diagnostics.push(undeclaredPlacementDiagnostic(undeclared));
  }

  const lock = lockOperation(input);
  if (lock !== null) operations.push(lock);
  const projectMigration = projectConfigMigrationOperation(input);
  if (projectMigration !== null) operations.push(projectMigration);
  if (operations.some((operation) => operation.mutates.ledger)) {
    const migration = ledgerMigrationOperation(input);
    if (migration !== null) operations.push(migration);
  }
  if (operations.length === 0 && diagnostics.length === 0) diagnostics.push(noopDiagnostic());
  const dependencyBoundOperations =
    lock === null
      ? operations
      : operations.map((operation) =>
          operation.mutates.live
            ? {
                ...operation,
                dependencyMetadata: {
                  ...operation.dependencyMetadata,
                  operationIds: Object.freeze(
                    [
                      ...new Set([...operation.dependencyMetadata.operationIds, lock.operationId]),
                    ].sort(),
                  ),
                },
              }
            : operation,
        );
  const checked = checksFor(observation, dependencyBoundOperations);

  return ok(
    Object.freeze({
      input,
      resourcePreconditions: Object.freeze(
        [...resourcePreconditionById.values()].sort((left, right) =>
          left.preconditionId.localeCompare(right.preconditionId),
        ),
      ),
      capabilityPreconditions: observation.capabilityPreconditions,
      machineBoundLivePaths: Object.freeze([...machineBoundLivePaths].sort()),
      plan: createOperationPlan({
        domain: 'skillsmith.operation-plan',
        schemaVersion: 1,
        command: 'plan',
        selection: {
          source: 'bounded-default',
          outcome: input.selectionOutcome,
          skills: input.selectedSkills,
          tools: input.selectedTools,
          scopes: input.selectedScopes,
        },
        batchPolicy: 'fail-fast',
        operations: checked.operations,
        checks: checked.checks,
        diagnostics,
      }),
    }),
  );
};
