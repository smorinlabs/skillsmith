import { isAbsolute, relative } from 'node:path';
import { type ArtifactDigest, hashCanonicalInput } from '../artifacts/hash.ts';
import {
  type PortableLockSkillV1,
  type PortableLockV1,
  hashPortableLock,
} from '../artifacts/lock.ts';
import type {
  MachineReasonV1,
  PlanImageV1,
  PlanLocationV1,
  PlanOperationV1,
  PlanScopeV1,
  PlanToolV1,
  ResourceIdentityV1,
  ResourcePreconditionV1,
  SavedPlanV1,
  SelectionPreconditionMemberV1,
  SelectionPreconditionV1,
} from '../artifacts/plan-types.ts';
import { artifactContractRegistry } from '../artifacts/registry.ts';
import type { NormalizedManifestV1 } from '../artifacts/types.ts';
import {
  createOperationGroupId,
  createOperationId,
  createOperationPairId,
  createPlanCheckId,
  createPlanningDiagnosticId,
} from '../planning/create.ts';
import { comparePlanChecks, comparePlanningDiagnostics } from '../planning/order.ts';
import type {
  OperationImage,
  OperationResourceIdentity,
  OperationSource,
  PlanCheck,
  PlanningDiagnostic,
} from '../planning/types.ts';
import { type Result, err, ok } from '../result.ts';
import { VERSION } from '../version.ts';
import type { ObservedReconcileInput, PlanReconcileError, ReconcilePlanProduct } from './types.ts';

const location = (path: string): PlanLocationV1 => ({ kind: 'machine-bound', path });
const portableLocation = (token: string): PlanLocationV1 => ({ kind: 'portable', token });

const projectToken = (projectRoot: string, path: string): string | null => {
  const displacement = relative(projectRoot, path).replaceAll('\\', '/');
  if (displacement === '..' || displacement.startsWith('../') || isAbsolute(displacement)) {
    return null;
  }
  return `project:${displacement.length === 0 ? 'root' : displacement}`;
};

const artifactLocation = (
  path: string,
  portability: 'portable' | 'machine-bound',
  portableToken: string | null,
  selectorToken: string | null,
  projectRoot: string | null,
  observedToken?: string,
): PlanLocationV1 => {
  if (observedToken !== undefined) return portableLocation(observedToken);
  if (portability === 'portable' && portableToken !== null) {
    return portableLocation(`project:${portableToken.replace(/^\.\//u, '')}`);
  }
  if (selectorToken === null && projectRoot !== null) {
    const project = projectToken(projectRoot, path);
    if (project !== null) return portableLocation(project);
  }
  return location(path);
};

const portableResource = (
  resource: OperationResourceIdentity,
  manifest: PlanLocationV1,
  lock: PlanLocationV1,
  machineBoundLivePaths: ReadonlySet<string>,
): ResourceIdentityV1 => {
  switch (resource.kind) {
    case 'manifest-bytes':
      return { ...resource, location: manifest };
    case 'lock':
      return { ...resource, location: lock };
    case 'live':
      return {
        ...resource,
        projectRoot: resource.scope === 'project' ? portableLocation('project:root') : null,
        location:
          resource.location.kind === 'machine-bound' &&
          machineBoundLivePaths.has(resource.location.path)
            ? resource.location
            : portableLocation(`skills/${resource.scope}/${resource.tool}/${resource.skill}`),
      };
    case 'ledger':
    case 'ledger-schema':
      return {
        ...resource,
        projectRoot: resource.projectRoot === null ? null : portableLocation('project:root'),
      };
    case 'project-context':
      return { ...resource, root: portableLocation('project:root') };
    case 'store':
      return resource as unknown as ResourceIdentityV1;
  }
};

const portableImage = (
  image: OperationImage,
  manifest: PlanLocationV1,
  lock: PlanLocationV1,
  machineBoundLivePaths: ReadonlySet<string>,
): PlanImageV1 => {
  if (image.kind === 'absent') {
    return {
      ...image,
      resource: portableResource(image.resource, manifest, lock, machineBoundLivePaths),
    } as unknown as PlanImageV1;
  }
  if (image.kind === 'placement') {
    const resource = portableResource(
      image.resource,
      manifest,
      lock,
      machineBoundLivePaths,
    ) as Extract<ResourceIdentityV1, { kind: 'live' }>;
    const linkTarget =
      image.linkTarget !== null && image.source?.kind === 'portable'
        ? portableLocation(
            `store:${image.source.contentHash.slice('sha256:'.length)}/${image.resource.skill}`,
          )
        : image.linkTarget;
    return { ...image, resource, linkTarget } as unknown as PlanImageV1;
  }
  if (image.kind === 'opaque-manifest') {
    throw new TypeError('saved plan cannot encode an opaque runtime manifest image');
  }
  if (image.kind === 'manifest') return { ...image, location: manifest } as unknown as PlanImageV1;
  if (image.kind === 'lock') return { ...image, location: lock } as unknown as PlanImageV1;
  return {
    ...image,
    projectRoot: image.projectRoot === null ? null : portableLocation('project:root'),
  } as unknown as PlanImageV1;
};

const reasonMessage: Readonly<Record<MachineReasonV1['code'], string>> = Object.freeze({
  'absolute-artifact-selector': 'plan binds an absolute artifact selector',
  'local-project-root': 'plan binds a local project root',
  'local-dev-source': 'plan binds a local development source',
  'absolute-live-placement': 'plan binds an absolute live placement',
  'custom-absolute-target': 'plan binds a custom absolute target',
});

const fallbackDigest = () => {
  const hashed = hashCanonicalInput('lock-canonical', 1, 'absent');
  if (!hashed.ok) throw new Error(hashed.error.message);
  return hashed.value;
};

const preconditionIdFor = (label: string, digest: string): string => {
  const hashed = hashCanonicalInput(
    'resource',
    1,
    JSON.stringify(['skillsmith-saved-plan-precondition-identity', 1, label, digest]),
  );
  if (!hashed.ok) throw new Error(hashed.error.message);
  return `precondition:v1:${hashed.value.slice('sha256:'.length)}`;
};

const resourceDigestFor = (label: string, value: unknown): ArtifactDigest => {
  const hashed = hashCanonicalInput(
    'resource',
    1,
    JSON.stringify(['skillsmith-saved-plan-resource', 1, label, value]),
  );
  if (!hashed.ok) throw new Error(hashed.error.message);
  return hashed.value;
};

const resourcePreconditionForImage = (image: PlanImageV1): ResourcePreconditionV1 | null => {
  if (image.kind === 'manifest' || image.kind === 'lock') return null;
  if (
    image.kind === 'absent' &&
    (image.resource.kind === 'manifest-bytes' || image.resource.kind === 'lock')
  ) {
    return null;
  }
  if (image.kind === 'ledger') {
    return {
      preconditionId: preconditionIdFor('ledger-schema', image.byteHash),
      resource: { kind: 'ledger-schema', projectRoot: image.projectRoot },
      expectedState: 'present',
      expectedHash: { domain: 'resource', hashSchemaVersion: 1, digest: image.byteHash },
      expectedRevision: { kind: 'artifact-bytes', digest: image.byteHash },
    };
  }
  const resource = image.resource;
  const digest = resourceDigestFor(image.kind, image);
  return {
    preconditionId: preconditionIdFor(image.kind, digest),
    resource,
    expectedState: image.kind === 'absent' ? 'absent' : 'present',
    expectedHash: { domain: 'resource', hashSchemaVersion: 1, digest },
    expectedRevision: image.kind === 'absent' ? null : { kind: 'resource', digest },
  };
};

const resourceKey = (resource: ResourceIdentityV1): string => JSON.stringify(resource);

const imageResource = (image: PlanImageV1): ResourceIdentityV1 => {
  if (image.kind === 'absent' || image.kind === 'placement') return image.resource;
  if (image.kind === 'manifest') return { kind: 'manifest-bytes', location: image.location };
  if (image.kind === 'lock') return { kind: 'lock', location: image.location };
  return { kind: 'ledger', projectRoot: image.projectRoot };
};

const canonicalResourcePrecondition = (
  precondition: ResourcePreconditionV1,
  resource: ResourceIdentityV1,
  observedImage: PlanImageV1 | undefined,
): ResourcePreconditionV1 => {
  const observation =
    observedImage ??
    (precondition.expectedRevision?.kind === 'artifact-bytes'
      ? { artifactByteRevision: precondition.expectedRevision.digest }
      : { state: precondition.expectedState });
  const hashed = hashCanonicalInput(
    precondition.expectedHash.domain,
    1,
    JSON.stringify([
      'skillsmith-saved-plan-observed-resource',
      1,
      resource,
      precondition.expectedState,
      observation,
    ]),
  );
  if (!hashed.ok) throw new Error(hashed.error.message);
  return {
    preconditionId: preconditionIdFor(
      `resource:${precondition.expectedHash.domain}:${resourceKey(resource)}`,
      hashed.value,
    ),
    resource,
    expectedState: precondition.expectedState,
    expectedHash: { ...precondition.expectedHash, digest: hashed.value },
    expectedRevision:
      precondition.expectedState === 'absent'
        ? null
        : precondition.expectedRevision?.kind === 'artifact-bytes'
          ? precondition.expectedRevision
          : { kind: 'resource', digest: hashed.value },
  };
};

const artifactGroupTarget = (
  operation: PlanOperationV1,
  manifest: PlanLocationV1,
  lock: PlanLocationV1,
): string | null => {
  if (operation.skill !== null || operation.source !== null || operation.scope !== null)
    return null;
  if (operation.kind === 'migrate-project-config' || operation.kind === 'write-lock') {
    return JSON.stringify({
      kind: 'artifact-pair',
      manifest: { kind: 'manifest-bytes', location: manifest },
      lock: { kind: 'lock', location: lock },
    });
  }
  return `resource:${resourceKey(imageResource(operation.after))}`;
};

export interface SavedPlanProjection {
  readonly plan: SavedPlanV1;
  readonly operationPreconditionIds: ReadonlyMap<string, readonly string[]>;
  readonly checkIds: ReadonlyMap<string, string>;
  readonly diagnosticIds: ReadonlyMap<string, string>;
}

export interface SavedPlanSelectionPredicates {
  readonly skills: readonly string[];
  readonly tools: readonly PlanToolV1[];
  readonly scopes: readonly PlanScopeV1[];
}

export interface SavedPlanScopedArtifactFacts {
  readonly scopedManifestSemanticHash: ArtifactDigest;
  /** The scoped resource fact exists for both present and absent reviewed lock states. */
  readonly scopedLockCanonicalHash: ArtifactDigest;
  readonly selectedSkills: readonly string[];
  readonly selectedTools: readonly PlanToolV1[];
  readonly selectedScopes: readonly PlanScopeV1[];
  readonly selectionOutcome: 'selected' | 'filter-noop';
}

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const canonicalPredicates = (
  predicates: SavedPlanSelectionPredicates,
): SavedPlanSelectionPredicates => ({
  skills: [...new Set(predicates.skills)].sort(compareStrings),
  tools: [...new Set(predicates.tools)].sort(compareStrings),
  scopes: [...new Set(predicates.scopes)].sort(compareStrings),
});

const declarationMatches = (
  declaration: NormalizedManifestV1['skills'][number],
  predicates: SavedPlanSelectionPredicates,
): boolean =>
  (predicates.skills.length === 0 || predicates.skills.includes(declaration.name)) &&
  (predicates.tools.length === 0 ||
    declaration.tools.some((tool) => predicates.tools.includes(tool))) &&
  (predicates.scopes.length === 0 || predicates.scopes.includes(declaration.scope));

const canonicalDeclaration = (
  declaration: NormalizedManifestV1['skills'][number],
  predicates: SavedPlanSelectionPredicates,
): NormalizedManifestV1['skills'][number] => ({
  name: declaration.name,
  source: {
    host: declaration.source.host,
    repository: declaration.source.repository,
    path: declaration.source.path,
  },
  ref: declaration.ref,
  tools: declaration.tools
    .filter((tool) => predicates.tools.length === 0 || predicates.tools.includes(tool))
    .sort(compareStrings),
  scope: declaration.scope,
  placement: declaration.placement,
  path: declaration.path,
});

const canonicalPin = (pin: PortableLockSkillV1): PortableLockSkillV1 => ({
  name: pin.name,
  source: pin.source,
  requestedRef: pin.requestedRef,
  resolvedSha: pin.resolvedSha,
  sourcePath: pin.sourcePath,
  contentHash: pin.contentHash,
});

/**
 * Compute the marked, selection-scoped artifact facts used by newly projected saved-v1 plans.
 * Empty predicate arrays mean wildcard. Prune additionally binds every lock pin whose name is
 * absent from the complete manifest because each such pin can authorize a delete candidate.
 */
export const createSavedPlanScopedArtifactFacts = (input: {
  readonly manifest: NormalizedManifestV1;
  readonly lock: PortableLockV1 | null;
  readonly predicates: SavedPlanSelectionPredicates;
  readonly prune: boolean;
}): Result<SavedPlanScopedArtifactFacts, PlanReconcileError> => {
  const predicates = canonicalPredicates(input.predicates);
  const rows = input.manifest.skills
    .filter((declaration) => declarationMatches(declaration, predicates))
    .map((declaration) => canonicalDeclaration(declaration, predicates))
    .sort((left, right) => compareStrings(left.name, right.name));
  const selectedNames = new Set(rows.map(({ name }) => name));
  const explicitFilter =
    predicates.skills.length > 0 || predicates.tools.length > 0 || predicates.scopes.length > 0;
  const selectedSkills = [...selectedNames].sort(compareStrings);
  const selectedTools =
    predicates.tools.length > 0
      ? [...predicates.tools]
      : [...new Set(rows.flatMap(({ tools }) => tools))].sort(compareStrings);
  const selectedScopes =
    predicates.scopes.length > 0
      ? [...predicates.scopes]
      : [...new Set(rows.map(({ scope }) => scope))].sort(compareStrings);
  const manifestNames = new Set(input.manifest.skills.map(({ name }) => name));
  const pins = (input.lock?.skills ?? [])
    .filter(
      ({ name }) =>
        selectedNames.has(name) || (input.prune && rows.length > 0 && !manifestNames.has(name)),
    )
    .map(canonicalPin)
    .sort((left, right) => compareStrings(left.name, right.name));
  const manifestHash = hashCanonicalInput(
    'manifest-semantic',
    1,
    JSON.stringify([
      'skillsmith-saved-plan-scoped-manifest',
      1,
      predicates,
      { prune: input.prune, rows },
    ]),
  );
  if (!manifestHash.ok) {
    return err({
      code: 'plan-scoped-manifest-hash',
      message: manifestHash.error.message,
      exitClass: 'failure',
    });
  }
  const lockHash = hashCanonicalInput(
    'lock-canonical',
    1,
    JSON.stringify([
      'skillsmith-saved-plan-scoped-lock',
      1,
      predicates,
      {
        prune: input.prune,
        state: input.lock === null ? 'absent' : 'present',
        pins,
      },
    ]),
  );
  if (!lockHash.ok) {
    return err({
      code: 'plan-scoped-lock-hash',
      message: lockHash.error.message,
      exitClass: 'failure',
    });
  }
  return ok({
    scopedManifestSemanticHash: manifestHash.value,
    scopedLockCanonicalHash: lockHash.value,
    selectedSkills,
    selectedTools,
    selectedScopes,
    selectionOutcome: explicitFilter && rows.length === 0 ? 'filter-noop' : 'selected',
  });
};

/**
 * Build the execution-bound plan projection once so every public representation
 * publishes the same operation precondition set.
 */
export const createSavedPlanProjection = (
  product: ReconcilePlanProduct,
  observation?: ObservedReconcileInput,
): Result<SavedPlanProjection, PlanReconcileError> => {
  const { observed } = product.input;
  const machineBoundLivePaths = new Set(product.machineBoundLivePaths);
  const manifestLocation = artifactLocation(
    observed.pair.file.path,
    observed.pair.file.portability,
    observed.pair.file.portableToken,
    observed.pair.file.token,
    observed.project.projectRoot,
    observed.artifactPortableTokens?.manifest,
  );
  const lockLocation = artifactLocation(
    observed.pair.lockfile.path,
    observed.pair.lockfile.portability,
    observed.pair.lockfile.portableToken,
    observed.pair.lockfileSource === 'sibling'
      ? observed.pair.file.token
      : observed.pair.lockfile.token,
    observed.project.projectRoot,
    observed.artifactPortableTokens?.lock,
  );
  const manifestSemanticRevision = observed.manifest.semanticRevision;
  if (manifestSemanticRevision === null) {
    return err({
      code: 'plan-manifest-hash',
      message: 'selected manifest has no semantic revision',
      exitClass: 'state',
    });
  }
  const selectionPredicates: SavedPlanSelectionPredicates = {
    skills: [],
    tools: [...product.input.request.tools],
    scopes: product.input.request.scope === null ? [] : [product.input.request.scope],
  };
  const scopedFacts = createSavedPlanScopedArtifactFacts({
    manifest: observed.manifest.model,
    lock: observed.lock.state === 'present' ? observed.lock.model : null,
    predicates: selectionPredicates,
    prune: product.input.request.prune,
  });
  if (!scopedFacts.ok) return scopedFacts;
  const manifestPreconditionId = preconditionIdFor(
    'manifest-semantic',
    scopedFacts.value.scopedManifestSemanticHash,
  );
  const manifestBytesPreconditionId = preconditionIdFor(
    'manifest-bytes',
    observed.manifest.byteRevision,
  );
  const lockHash =
    observed.lock.state === 'present'
      ? hashPortableLock(observed.lock.model)
      : ok(fallbackDigest());
  if (!lockHash.ok) {
    return err({ code: 'plan-lock-hash', message: lockHash.error.message, exitClass: 'state' });
  }
  const lockPreconditionId = preconditionIdFor(
    'lock-canonical',
    scopedFacts.value.scopedLockCanonicalHash,
  );
  const resourcePreconditions: ResourcePreconditionV1[] = [
    {
      preconditionId: manifestPreconditionId,
      resource: { kind: 'manifest-bytes', location: manifestLocation },
      expectedState: 'present',
      expectedHash: {
        domain: 'manifest-semantic',
        hashSchemaVersion: 1,
        digest: scopedFacts.value.scopedManifestSemanticHash,
      },
      expectedRevision: { kind: 'artifact-bytes', digest: observed.manifest.byteRevision },
    },
    {
      preconditionId: manifestBytesPreconditionId,
      resource: { kind: 'manifest-bytes', location: manifestLocation },
      expectedState: 'present',
      expectedHash: {
        domain: 'manifest-bytes',
        hashSchemaVersion: 1,
        digest: observed.manifest.byteRevision,
      },
      expectedRevision: { kind: 'artifact-bytes', digest: observed.manifest.byteRevision },
    },
    {
      preconditionId: lockPreconditionId,
      resource: { kind: 'lock', location: lockLocation },
      expectedState: observed.lock.state === 'present' ? 'present' : 'absent',
      expectedHash: {
        domain: 'lock-canonical',
        hashSchemaVersion: 1,
        digest: scopedFacts.value.scopedLockCanonicalHash,
      },
      expectedRevision:
        observed.lock.state === 'present'
          ? { kind: 'artifact-bytes', digest: observed.lock.byteRevision }
          : null,
    },
  ];
  const portableOperations = product.plan.operations.map(
    ({ dependencyMetadata, ...operation }): PlanOperationV1 =>
      ({
        ...operation,
        before: portableImage(
          operation.before,
          manifestLocation,
          lockLocation,
          machineBoundLivePaths,
        ),
        after: portableImage(
          operation.after,
          manifestLocation,
          lockLocation,
          machineBoundLivePaths,
        ),
        conflict:
          operation.conflict === null
            ? null
            : {
                ...operation.conflict,
                target: portableResource(
                  operation.conflict.target,
                  manifestLocation,
                  lockLocation,
                  machineBoundLivePaths,
                ),
              },
        dependsOn: [...dependencyMetadata.operationIds],
      }) as unknown as PlanOperationV1,
  );
  const portableDiagnostics = product.plan.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    affected: {
      ...diagnostic.affected,
      path:
        diagnostic.affected.path?.kind === 'machine-bound' &&
        diagnostic.affected.skill !== null &&
        diagnostic.affected.tool !== null &&
        diagnostic.affected.scope !== null &&
        !machineBoundLivePaths.has(diagnostic.affected.path.path)
          ? portableLocation(
              `skills/${diagnostic.affected.scope}/${diagnostic.affected.tool}/${diagnostic.affected.skill}`,
            )
          : diagnostic.affected.path,
    },
  }));

  const beforeImageByResource = new Map<string, PlanImageV1>();
  for (const operation of portableOperations) {
    beforeImageByResource.set(resourceKey(imageResource(operation.before)), operation.before);
  }
  const preconditionIdMap = new Map<string, string>();
  const resourcePreconditionByKey = new Map(
    resourcePreconditions.map((precondition) => [
      `${resourceKey(precondition.resource)}\0${precondition.expectedHash.domain}`,
      precondition,
    ]),
  );
  for (const precondition of product.resourcePreconditions) {
    const resource = portableResource(
      precondition.resource as OperationResourceIdentity,
      manifestLocation,
      lockLocation,
      machineBoundLivePaths,
    );
    const canonical = canonicalResourcePrecondition(
      precondition,
      resource,
      beforeImageByResource.get(resourceKey(resource)),
    );
    const key = `${resourceKey(resource)}\0${canonical.expectedHash.domain}`;
    const selected = resourcePreconditionByKey.get(key) ?? canonical;
    if (!resourcePreconditionByKey.has(key)) {
      resourcePreconditions.push(selected);
      resourcePreconditionByKey.set(key, selected);
    }
    preconditionIdMap.set(precondition.preconditionId, selected.preconditionId);
  }

  const manifestMigrationBefore = portableOperations.find(
    (operation) => operation.kind === 'migrate-project-config',
  )?.before;
  const manifestMigrationSemanticPreconditionId =
    manifestMigrationBefore?.kind === 'manifest'
      ? preconditionIdFor('manifest-migration-semantic', manifestMigrationBefore.semanticHash)
      : null;
  if (manifestMigrationBefore?.kind === 'manifest') {
    resourcePreconditions.push({
      preconditionId: manifestMigrationSemanticPreconditionId as string,
      resource: { kind: 'manifest-bytes', location: manifestLocation },
      expectedState: 'present',
      expectedHash: {
        domain: 'manifest-semantic',
        hashSchemaVersion: 1,
        digest: manifestMigrationBefore.semanticHash,
      },
      expectedRevision: { kind: 'artifact-bytes', digest: manifestMigrationBefore.byteHash },
    });
  }

  const groupIdMap = new Map<string, string>();
  for (const operation of portableOperations) {
    if (groupIdMap.has(operation.groupId)) continue;
    groupIdMap.set(
      operation.groupId,
      createOperationGroupId({
        domain: 'skillsmith.operation-group-identity',
        schemaVersion: 1,
        command: 'plan',
        skill: operation.skill,
        source: operation.source as unknown as OperationSource | null,
        scope: operation.scope,
        target: artifactGroupTarget(operation, manifestLocation, lockLocation),
      }),
    );
  }
  const pairIdMap = new Map<string, string>();
  for (const operation of portableOperations) {
    if (operation.pairId === null || pairIdMap.has(operation.pairId)) continue;
    const groupId = groupIdMap.get(operation.groupId);
    const resource = imageResource(operation.after);
    if (groupId === undefined || operation.tool === null || resource.kind !== 'live') {
      throw new TypeError(`saved plan cannot project pair '${operation.pairId}'`);
    }
    pairIdMap.set(
      operation.pairId,
      createOperationPairId({
        domain: 'skillsmith.operation-pair-identity',
        schemaVersion: 1,
        groupId,
        tool: operation.tool,
        resource,
      }),
    );
  }
  const operationIdMap = new Map<string, string>();
  for (const operation of portableOperations) {
    const groupId = groupIdMap.get(operation.groupId);
    if (groupId === undefined) throw new TypeError('saved plan operation group projection failed');
    const pairId = operation.pairId === null ? null : pairIdMap.get(operation.pairId);
    if (operation.pairId !== null && pairId === undefined) {
      throw new TypeError('saved plan operation pair projection failed');
    }
    operationIdMap.set(
      operation.operationId,
      createOperationId({
        domain: 'skillsmith.operation-identity',
        schemaVersion: 1,
        groupId,
        pairId: pairId ?? null,
        kind: operation.kind,
        skill: operation.skill,
        source: operation.source as unknown as OperationSource | null,
        tool: operation.tool,
        scope: operation.scope,
      }),
    );
  }

  const resourceIdsByOperation = new Map<string, string[]>();
  for (const operation of portableOperations) {
    const precondition = resourcePreconditionForImage(operation.before);
    if (precondition === null) continue;
    const key = `${resourceKey(precondition.resource)}\0${precondition.expectedHash.domain}`;
    const existing = resourcePreconditionByKey.get(key);
    const selected = existing ?? precondition;
    if (existing === undefined) {
      resourcePreconditions.push(selected);
      resourcePreconditionByKey.set(key, selected);
    }
    const operationResourceIds = [selected.preconditionId];
    if (operation.before.kind === 'ledger') {
      // The saved contract deliberately signs the v1 schema bytes as a ledger-schema resource.
      // Coordinator preflight separately requires a same-resource guard for the physical ledger
      // image. Retain both facts; neither substitutes for or weakens the other.
      const executionResource: ResourcePreconditionV1 = {
        preconditionId: preconditionIdFor('ledger-execution', operation.before.byteHash),
        resource: { kind: 'ledger', projectRoot: operation.before.projectRoot },
        expectedState: 'present',
        expectedHash: {
          domain: 'resource',
          hashSchemaVersion: 1,
          digest: operation.before.byteHash,
        },
        expectedRevision: { kind: 'artifact-bytes', digest: operation.before.byteHash },
      };
      const executionKey = `${resourceKey(executionResource.resource)}\0${executionResource.expectedHash.domain}`;
      const existingExecution = resourcePreconditionByKey.get(executionKey);
      const selectedExecution = existingExecution ?? executionResource;
      if (existingExecution === undefined) {
        resourcePreconditions.push(selectedExecution);
        resourcePreconditionByKey.set(executionKey, selectedExecution);
      }
      operationResourceIds.push(selectedExecution.preconditionId);
    }
    resourceIdsByOperation.set(operation.operationId, operationResourceIds);
  }

  const addBindingPrecondition = (
    label: string,
    resource: ResourceIdentityV1,
    domain: ResourcePreconditionV1['expectedHash']['domain'],
    value: unknown,
    expectedState: ResourcePreconditionV1['expectedState'] = 'present',
  ): string => {
    const key = `${resourceKey(resource)}\0${domain}`;
    const existing = resourcePreconditionByKey.get(key);
    if (existing !== undefined) return existing.preconditionId;
    const seedDigest = resourceDigestFor(label, value);
    const canonical = canonicalResourcePrecondition(
      {
        preconditionId: preconditionIdFor(label, seedDigest),
        resource,
        expectedState,
        expectedHash: { domain, hashSchemaVersion: 1, digest: seedDigest },
        expectedRevision:
          expectedState === 'present' ? { kind: 'resource', digest: seedDigest } : null,
      },
      resource,
      undefined,
    );
    resourcePreconditions.push(canonical);
    resourcePreconditionByKey.set(key, canonical);
    return canonical.preconditionId;
  };
  const addSourceBindingPrecondition = (source: OperationSource | null): void => {
    if (source?.kind !== 'local-dev') return;
    addBindingPrecondition(
      'local-dev-source',
      { kind: 'store', contentHash: source.contentHash as ArtifactDigest },
      'source-content',
      { contentHash: source.contentHash },
    );
  };
  for (const operation of product.plan.operations) addSourceBindingPrecondition(operation.source);
  for (const check of product.plan.checks) {
    if (check.kind === 'source-resolution' || check.kind === 'content-integrity') {
      addSourceBindingPrecondition(check.source);
    }
  }
  for (const diagnostic of portableDiagnostics) {
    addSourceBindingPrecondition(diagnostic.affected.source as OperationSource | null);
    const { affected } = diagnostic;
    if (
      affected.skill !== null &&
      affected.tool !== null &&
      affected.scope !== null &&
      affected.path !== null
    ) {
      const resource: ResourceIdentityV1 = {
        kind: 'live',
        skill: affected.skill,
        tool: affected.tool,
        scope: affected.scope,
        projectRoot: affected.scope === 'project' ? portableLocation('project:root') : null,
        location: affected.path,
      };
      addBindingPrecondition('diagnostic-live-placement', resource, 'resource', {
        reasonCode: diagnostic.reason.code,
        source: affected.source,
      });
    }
  }

  const addObservedLivePrecondition = (
    label: string,
    input: Readonly<{
      readonly skill: string;
      readonly tool: PlanToolV1;
      readonly scope: PlanScopeV1;
      readonly placement: Readonly<{
        readonly path: string;
        readonly class: 'dev' | 'pinned' | 'store-linked' | 'absent';
        readonly dangling: boolean;
      }>;
    }>,
  ): void => {
    const runtimeResource: OperationResourceIdentity = {
      kind: 'live',
      skill: input.skill,
      tool: input.tool,
      scope: input.scope,
      projectRoot:
        input.scope === 'project' && observed.project.projectRoot !== null
          ? location(observed.project.projectRoot)
          : null,
      location: location(input.placement.path),
    };
    const resource = portableResource(
      runtimeResource,
      manifestLocation,
      lockLocation,
      machineBoundLivePaths,
    );
    const expectedState = input.placement.class === 'absent' ? 'absent' : 'present';
    addBindingPrecondition(
      label,
      resource,
      'resource',
      {
        resource,
        expectedState,
        classification: input.placement.class,
        dangling: input.placement.dangling,
      },
      expectedState,
    );
  };

  if (observation !== undefined) {
    if (observation.resolved !== product.input) {
      return err({
        code: 'plan-observation-product-mismatch',
        message: 'saved plan inventory observation does not belong to the planned product',
        exitClass: 'failure',
      });
    }
    for (const desired of observation.desiredPlacements) {
      if (desired.state === 'observed') {
        addObservedLivePrecondition('selected-live-inventory', {
          skill: desired.row.declaration.name,
          tool: desired.row.tool,
          scope: desired.row.declaration.scope,
          placement: desired.placement,
        });
        if (desired.opposite !== null) {
          addObservedLivePrecondition('selected-opposite-live-inventory', {
            skill: desired.row.declaration.name,
            tool: desired.row.tool,
            scope: desired.opposite.scope,
            placement: desired.opposite.placement,
          });
        }
      } else {
        for (const evidence of desired.evidence) {
          addObservedLivePrecondition('selected-refusal-live-inventory', {
            skill: desired.row.declaration.name,
            tool: desired.row.tool,
            scope: evidence.scope,
            placement: evidence.placement,
          });
        }
      }
    }
    for (const undeclared of observation.undeclaredPlacements) {
      addObservedLivePrecondition('selected-undeclared-live-inventory', {
        skill: undeclared.placement.skill,
        tool: undeclared.tool,
        scope: undeclared.scope,
        placement: undeclared.placement,
      });
    }
    for (const prune of observation.prunePlacements) {
      addObservedLivePrecondition('selected-prune-live-inventory', {
        skill: prune.pin.name,
        tool: prune.tool,
        scope: prune.scope,
        placement: prune.placement,
      });
    }
  }

  let projectContextPreconditionId: string | null = null;
  if (manifestLocation.kind === 'machine-bound' || lockLocation.kind === 'machine-bound') {
    const root = observed.project.projectRoot ?? observed.project.effectiveCwd;
    projectContextPreconditionId = addBindingPrecondition(
      'absolute-artifact-project-context',
      { kind: 'project-context', root: location(root) },
      'resource',
      { root },
    );
  }

  const memberByResource = new Map<string, SelectionPreconditionMemberV1>();
  for (const precondition of resourcePreconditions) {
    const key = resourceKey(precondition.resource);
    if (memberByResource.has(key)) continue;
    memberByResource.set(key, {
      resource: precondition.resource,
      resourceHash: precondition.expectedHash,
    });
  }
  const selectionMembers = [...memberByResource.values()].sort((left, right) => {
    const a = JSON.stringify(left);
    const b = JSON.stringify(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const selectionHash = hashCanonicalInput(
    'selection-set',
    1,
    JSON.stringify([
      'skillsmith-saved-plan-selection',
      1,
      product.plan.selection.source,
      [...selectionPredicates.skills].sort(),
      [...selectionPredicates.tools].sort(),
      [...selectionPredicates.scopes].sort(),
      selectionMembers,
    ]),
  );
  if (!selectionHash.ok) {
    return err({
      code: 'plan-selection-hash',
      message: selectionHash.error.message,
      exitClass: 'failure',
    });
  }
  const selectionPrecondition: SelectionPreconditionV1 = {
    preconditionId: preconditionIdFor('selection-set', selectionHash.value),
    domain: 'selection-set',
    hashSchemaVersion: 1,
    expectedHash: selectionHash.value,
    selectionSource: product.plan.selection.source,
    skills: [...selectionPredicates.skills],
    tools: [...selectionPredicates.tools],
    scopes: [...selectionPredicates.scopes],
    members: selectionMembers,
  };

  const capabilityPreconditions = product.capabilityPreconditions
    .map((precondition) => ({
      ...precondition,
      scopes: [...precondition.scopes],
    }))
    .sort((left, right) => left.preconditionId.localeCompare(right.preconditionId));
  const capabilityIdByToolScope = new Map<string, string>();
  for (const precondition of capabilityPreconditions) {
    for (const scope of precondition.scopes) {
      capabilityIdByToolScope.set(`${precondition.tool}\0${scope}`, precondition.preconditionId);
    }
  }
  const operationsWithoutChecks = portableOperations.map((operation): PlanOperationV1 => {
    const preconditionIds = new Set([
      manifestPreconditionId,
      manifestBytesPreconditionId,
      lockPreconditionId,
      selectionPrecondition.preconditionId,
      ...(projectContextPreconditionId === null ? [] : [projectContextPreconditionId]),
      ...operation.preconditionIds.map((id) => preconditionIdMap.get(id) ?? id),
    ]);
    if (operation.kind === 'migrate-project-config') {
      if (manifestMigrationSemanticPreconditionId === null) {
        throw new TypeError('saved manifest migration semantic precondition is missing');
      }
      preconditionIds.add(manifestMigrationSemanticPreconditionId);
    }
    for (const resourceId of resourceIdsByOperation.get(operation.operationId) ?? []) {
      preconditionIds.add(resourceId);
    }
    if (operation.tool !== null && operation.scope !== null) {
      const capabilityId = capabilityIdByToolScope.get(`${operation.tool}\0${operation.scope}`);
      if (capabilityId !== undefined) preconditionIds.add(capabilityId);
    }
    const operationId = operationIdMap.get(operation.operationId);
    const groupId = groupIdMap.get(operation.groupId);
    if (operationId === undefined || groupId === undefined) {
      throw new TypeError('saved plan operation identity projection failed');
    }
    return {
      ...operation,
      operationId,
      groupId,
      pairId: operation.pairId === null ? null : (pairIdMap.get(operation.pairId) ?? null),
      dependsOn: operation.dependsOn.map((id) => operationIdMap.get(id) ?? id).sort(),
      preconditionIds: [...preconditionIds].sort(),
      reversibility: {
        ...operation.reversibility,
        retentionResourceIds: operation.reversibility.retentionResourceIds
          .map((id) => pairIdMap.get(id) ?? operationIdMap.get(id) ?? id)
          .sort(),
      } as PlanOperationV1['reversibility'],
    };
  });

  const referencedGuardIds = new Set(
    operationsWithoutChecks.flatMap(({ preconditionIds }) => preconditionIds),
  );
  const unreferencedGuardIds = [
    ...resourcePreconditions,
    selectionPrecondition,
    ...capabilityPreconditions,
  ]
    .map(({ preconditionId }) => preconditionId)
    .filter((preconditionId) => !referencedGuardIds.has(preconditionId))
    .sort();
  const guardCoveredOperations = operationsWithoutChecks.map((operation, index) =>
    index === 0 && unreferencedGuardIds.length > 0
      ? {
          ...operation,
          preconditionIds: [...operation.preconditionIds, ...unreferencedGuardIds].sort(),
        }
      : operation,
  );

  const checkIdMap = new Map<string, string>();
  const portableOperationIndex = new Map(
    portableOperations.map(
      (operation, index) =>
        [operationIdMap.get(operation.operationId) ?? operation.operationId, index] as const,
    ),
  );
  const checks = product.plan.checks
    .map((check): SavedPlanV1['checks'][number] => {
      const operationIds = check.operationIds.map((id) => operationIdMap.get(id) ?? id).sort() as [
        string,
        ...string[],
      ];
      const projected = {
        ...check,
        operationIds,
        ...('preconditionIds' in check
          ? {
              preconditionIds: check.preconditionIds.map(
                (id) => preconditionIdMap.get(id) ?? id,
              ) as [string, ...string[]],
            }
          : {}),
      } as unknown as PlanCheck;
      const { checkId: _checkId, blocking: _blocking, ...identity } = projected;
      const checkId = createPlanCheckId({
        domain: 'skillsmith.plan-check-identity',
        schemaVersion: 1,
        ...identity,
      });
      checkIdMap.set(check.checkId, checkId);
      return { ...projected, checkId } as unknown as SavedPlanV1['checks'][number];
    })
    .sort((left, right) =>
      comparePlanChecks(
        portableOperationIndex,
        left as unknown as PlanCheck,
        right as unknown as PlanCheck,
      ),
    );
  const operations = guardCoveredOperations.map(
    (operation, index): PlanOperationV1 => ({
      ...operation,
      requiredCheckIds:
        portableOperations[index]?.requiredCheckIds.map((id) => checkIdMap.get(id) ?? id).sort() ??
        [],
    }),
  );

  const diagnosticIdMap = new Map<string, string>();
  const diagnostics = portableDiagnostics
    .map((diagnostic): SavedPlanV1['diagnostics'][number] => {
      const correlation = {
        groupId:
          diagnostic.correlation.groupId === null
            ? null
            : (groupIdMap.get(diagnostic.correlation.groupId) ?? diagnostic.correlation.groupId),
        pairId:
          diagnostic.correlation.pairId === null
            ? null
            : (pairIdMap.get(diagnostic.correlation.pairId) ?? diagnostic.correlation.pairId),
        operationId:
          diagnostic.correlation.operationId === null
            ? null
            : (operationIdMap.get(diagnostic.correlation.operationId) ??
              diagnostic.correlation.operationId),
      };
      const projected = {
        ...diagnostic,
        correlation,
        reason: {
          ...diagnostic.reason,
          message: `Saved planning diagnostic: ${diagnostic.reason.code}`,
        },
      } as unknown as PlanningDiagnostic;
      const diagnosticId = createPlanningDiagnosticId({
        domain: 'skillsmith.planning-diagnostic-identity',
        schemaVersion: 1,
        kind: projected.kind,
        severity: projected.severity,
        refusalClass: projected.refusalClass,
        affected: projected.affected,
        correlation: projected.correlation,
        reasonCode: projected.reason.code,
        selectionSource: projected.selectionSource,
      });
      diagnosticIdMap.set(diagnostic.diagnosticId, diagnosticId);
      return { ...projected, diagnosticId } as unknown as SavedPlanV1['diagnostics'][number];
    })
    .sort((left, right) =>
      comparePlanningDiagnostics(
        left as unknown as PlanningDiagnostic,
        right as unknown as PlanningDiagnostic,
      ),
    );

  const resourcePreconditionIds = new Set(
    resourcePreconditions.map(({ preconditionId }) => preconditionId),
  );
  const idsByResource = new Map<string, string[]>();
  for (const precondition of resourcePreconditions) {
    const key = resourceKey(precondition.resource);
    const ids = idsByResource.get(key) ?? [];
    ids.push(precondition.preconditionId);
    idsByResource.set(key, ids);
  }
  const machineBindings = new Map<
    string,
    { readonly code: MachineReasonV1['code']; readonly preconditionIds: Set<string> }
  >();
  const addBinding = (
    code: MachineReasonV1['code'],
    path: string,
    preconditionIds: readonly string[],
  ): void => {
    const key = `${code}\0${path}`;
    const binding = machineBindings.get(key) ?? { code, preconditionIds: new Set<string>() };
    for (const id of preconditionIds) {
      if (resourcePreconditionIds.has(id)) binding.preconditionIds.add(id);
    }
    machineBindings.set(key, binding);
  };
  const addLocation = (
    code: MachineReasonV1['code'],
    value: PlanLocationV1 | null,
    preconditionIds: readonly string[],
  ): void => {
    if (value?.kind === 'machine-bound') addBinding(code, value.path, preconditionIds);
  };
  const addSource = (
    source:
      | Readonly<{
          readonly kind: 'local-dev';
          readonly path: string;
          readonly contentHash: unknown;
        }>
      | Readonly<{ readonly kind: 'portable' }>
      | null,
    preconditionIds: readonly string[],
  ): void => {
    if (source?.kind === 'local-dev') {
      const storeIds = idsByResource.get(
        resourceKey({ kind: 'store', contentHash: String(source.contentHash) as ArtifactDigest }),
      );
      addBinding('local-dev-source', source.path, storeIds ?? preconditionIds);
    }
  };
  const addResource = (
    resource: ResourceIdentityV1,
    preconditionIds: readonly string[] = idsByResource.get(resourceKey(resource)) ?? [],
  ): void => {
    if (resource.kind === 'manifest-bytes' || resource.kind === 'lock') {
      addLocation('absolute-artifact-selector', resource.location, preconditionIds);
    } else if (resource.kind === 'live') {
      addLocation('local-project-root', resource.projectRoot, preconditionIds);
      addLocation('absolute-live-placement', resource.location, preconditionIds);
    } else if (resource.kind === 'ledger' || resource.kind === 'ledger-schema') {
      addLocation('local-project-root', resource.projectRoot, preconditionIds);
    } else if (resource.kind === 'project-context') {
      addLocation('local-project-root', resource.root, preconditionIds);
    }
  };
  addLocation('absolute-artifact-selector', manifestLocation, [
    manifestPreconditionId,
    manifestBytesPreconditionId,
  ]);
  addLocation('absolute-artifact-selector', lockLocation, [lockPreconditionId]);
  for (const operation of operations) {
    const operationResourceIds = operation.preconditionIds.filter((id) =>
      resourcePreconditionIds.has(id),
    );
    addSource(operation.source, operationResourceIds);
    for (const image of [operation.before, operation.after]) {
      if (image.kind === 'absent') addResource(image.resource);
      else if (image.kind === 'placement') {
        const liveIds = idsByResource.get(resourceKey(image.resource)) ?? operationResourceIds;
        addResource(image.resource, liveIds);
        addLocation('custom-absolute-target', image.linkTarget, liveIds);
        addSource(image.source, operationResourceIds);
      } else if (image.kind === 'manifest') {
        addLocation('absolute-artifact-selector', image.location, [
          manifestPreconditionId,
          manifestBytesPreconditionId,
        ]);
      } else if (image.kind === 'lock') {
        addLocation('absolute-artifact-selector', image.location, [lockPreconditionId]);
      } else {
        addResource({ kind: 'ledger', projectRoot: image.projectRoot });
      }
    }
    if (operation.conflict !== null) addResource(operation.conflict.target);
  }
  for (const check of checks) {
    if (check.kind === 'source-resolution' || check.kind === 'content-integrity') {
      const checkResourceIds = check.operationIds.flatMap(
        (id) =>
          operations
            .find(({ operationId }) => operationId === id)
            ?.preconditionIds.filter((preconditionId) =>
              resourcePreconditionIds.has(preconditionId),
            ) ?? [],
      );
      addSource(check.source, checkResourceIds);
    }
  }
  for (const diagnostic of diagnostics) {
    const correlatedIds =
      operations
        .find(({ operationId }) => operationId === diagnostic.correlation.operationId)
        ?.preconditionIds.filter((id) => resourcePreconditionIds.has(id)) ?? [];
    const affected = diagnostic.affected;
    const diagnosticResourceIds =
      affected.skill !== null &&
      affected.tool !== null &&
      affected.scope !== null &&
      affected.path !== null
        ? (idsByResource.get(
            resourceKey({
              kind: 'live',
              skill: affected.skill,
              tool: affected.tool,
              scope: affected.scope,
              projectRoot: affected.scope === 'project' ? portableLocation('project:root') : null,
              location: affected.path,
            }),
          ) ?? correlatedIds)
        : correlatedIds;
    addSource(affected.source, diagnosticResourceIds);
    addLocation(
      affected.skill !== null && affected.tool !== null && affected.scope !== null
        ? 'absolute-live-placement'
        : 'custom-absolute-target',
      affected.path,
      diagnosticResourceIds,
    );
  }
  for (const precondition of resourcePreconditions) addResource(precondition.resource);
  const reasons: MachineReasonV1[] = [];
  for (const [binding, reason] of [...machineBindings.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const preconditionIds = [...reason.preconditionIds].sort();
    if (preconditionIds.length === 0) {
      return err({
        code: 'plan-machine-binding-precondition',
        message: `machine binding '${binding.replace('\0', ':')}' has no corresponding resource precondition`,
        exitClass: 'state',
      });
    }
    reasons.push({
      code: reason.code,
      message: reasonMessage[reason.code],
      path: binding.slice(binding.indexOf('\0') + 1),
      preconditionIds: preconditionIds as [string, ...string[]],
    });
  }

  const candidate: SavedPlanV1 = {
    schemaVersion: 1,
    kind: 'skillsmith.plan',
    skillsmithVersion: VERSION,
    executorSchemaVersion: 1,
    hashSchemaVersion: 1,
    portability:
      reasons.length === 0
        ? { kind: 'portable', reasons: [] }
        : {
            kind: 'machine-bound',
            reasons: reasons as [MachineReasonV1, ...MachineReasonV1[]],
          },
    artifactPair: {
      manifest: manifestLocation,
      lock: lockLocation,
      lockSource: observed.pair.lockfileSource,
    },
    manifestSemanticHash: manifestSemanticRevision,
    lockCanonicalHash: observed.lock.state === 'present' ? lockHash.value : null,
    options: { prune: product.input.request.prune, locked: product.input.request.locked },
    selection: {
      selectionSource: product.plan.selection.source,
      skills: [...product.input.selectedSkills],
      tools: [...product.input.selectedTools],
      scopes: [...product.input.selectedScopes],
    },
    operations,
    checks,
    diagnostics,
    resourcePreconditions: resourcePreconditions.sort((left, right) =>
      left.preconditionId.localeCompare(right.preconditionId),
    ),
    selectionPreconditions: [selectionPrecondition],
    capabilityPreconditions: [...capabilityPreconditions],
  };
  const savedPlanCodec = artifactContractRegistry.get('plan', 1);
  if (savedPlanCodec === undefined) {
    return err({
      code: 'plan-saved-contract',
      message: 'saved plan artifact codec 1 is unavailable',
      exitClass: 'failure',
    });
  }
  const validated = savedPlanCodec.toDto(candidate);
  if (!validated.ok) {
    return err({
      code: 'plan-saved-contract',
      message: `saved plan contract rejected at ${validated.error.path.join('.') || 'root'}`,
      exitClass: 'failure',
    });
  }
  const plan = validated.value as SavedPlanV1;
  const operationPreconditionIds = new Map<string, readonly string[]>();
  for (const [index, operation] of plan.operations.entries()) {
    const ids = Object.freeze([...operation.preconditionIds]);
    operationPreconditionIds.set(operation.operationId, ids);
    const runtimeId = product.plan.operations[index]?.operationId;
    if (runtimeId !== undefined) operationPreconditionIds.set(runtimeId, ids);
  }
  return ok({
    plan,
    operationPreconditionIds,
    checkIds: new Map(checkIdMap),
    diagnosticIds: new Map(diagnosticIdMap),
  });
};

export const createSavedPlan = (
  product: ReconcilePlanProduct,
): Result<SavedPlanV1, PlanReconcileError> => {
  const projection = createSavedPlanProjection(product);
  return projection.ok ? ok(projection.value.plan) : projection;
};
