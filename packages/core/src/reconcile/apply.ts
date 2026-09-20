import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AcquisitionPorts } from '../acquire/types.ts';
import { classifyPlacementRoot } from '../agents/placement-shared.ts';
import { toolRegistry } from '../agents/registry.ts';
import type { SupportedTool } from '../agents/types.ts';
import { selectReadableArtifactContext } from '../artifacts/discovery.ts';
import { hashCanonicalInput, hashManifestBytes } from '../artifacts/hash.ts';
import { hashPortableLock } from '../artifacts/lock.ts';
import type { PortableLockV1 } from '../artifacts/lock.ts';
import { resolveArtifactPair } from '../artifacts/pair.ts';
import type { ResolvedArtifactPair } from '../artifacts/pair.ts';
import type {
  CapabilityPreconditionV1,
  PlanLocationV1,
  ResourcePreconditionV1,
  SavedPlanV1,
  SelectionPreconditionV1,
} from '../artifacts/plan-types.ts';
import { artifactContractRegistry } from '../artifacts/registry.ts';
import {
  type ArtifactReadEnvelope,
  type ArtifactReadResult,
  readLedgerArtifact,
  readLockArtifact,
  readManifestArtifact,
  readSavedPlanArtifact,
} from '../artifacts/repository.ts';
import { hashSourceContentV1, projectSourceContent } from '../artifacts/source-content.ts';
import type { NormalizedManifestV1 } from '../artifacts/types.ts';
import { resolveProjectContext } from '../context/project.ts';
import type { ProjectContext } from '../context/types.ts';
import { errorMessage, safeErrorCode } from '../errors.ts';
import { ledgerPathOf, resolveDataDir, storeRootOf } from '../place/paths.ts';
import { clampStoreNs } from '../place/store.ts';
import { createOperationPlan } from '../planning/create.ts';
import { canonicalPlanningString } from '../planning/order.ts';
import type { OperationPlan, OperationPlanInput } from '../planning/types.ts';
import type { ResolvedRuntimeConfiguration } from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';
import { observePlanArtifacts, observeReconcileInput } from './observe.ts';
import { createReconcilePlan } from './plan.ts';
import { resolvePlanInput } from './resolve.ts';
import {
  type SavedPlanProjection,
  type SavedPlanScopedArtifactFacts,
  createSavedPlanProjection,
  createSavedPlanScopedArtifactFacts,
} from './saved.ts';
import type {
  ObservedReconcileInput,
  PlanReconcileError,
  ReconcileExecutionCommandV1,
  ReconcilePlanProduct,
} from './types.ts';

export interface PrepareReconcilePlanRequest {
  readonly file?: string;
  readonly lockfile?: string;
  readonly tools: readonly SupportedTool[];
  readonly scope: 'user' | 'project' | null;
  readonly locked: boolean;
  readonly prune: boolean;
  readonly check: boolean;
}

export interface PrepareReconcilePlanRuntime {
  readonly ports: AcquisitionPorts;
  readonly configuration: ResolvedRuntimeConfiguration;
  readonly invocationCwd: string;
  readonly cd?: string;
  readonly explicitConfigPath?: string;
  readonly projectContext?: ProjectContext;
  readonly signal?: AbortSignal;
}

export interface PreparedReconcilePlan {
  readonly product: ReconcilePlanProduct;
  readonly projection: SavedPlanProjection;
  readonly observation: ObservedReconcileInput;
  readonly artifactSelectionSource:
    | 'explicit'
    | 'discovered-project'
    | 'project-default'
    | 'user-default';
}

export interface ValidateSavedReconcilePlanRequest {
  readonly planPath: string;
}

export interface ValidateSavedReconcilePlanRuntime {
  readonly ports: AcquisitionPorts;
  readonly configuration: ResolvedRuntimeConfiguration;
  readonly projectContext: ProjectContext;
  readonly signal?: AbortSignal;
}

export interface SavedReconcileExecutionGuards {
  /** Same saved identities, rebound to the byte revisions observed during validation. */
  readonly resourcePreconditions: readonly ResourcePreconditionV1[];
  readonly selectionPreconditions: readonly SelectionPreconditionV1[];
  readonly capabilityPreconditions: readonly CapabilityPreconditionV1[];
}

export interface ValidatedSavedReconcilePlanValue<
  Command extends ReconcileExecutionCommandV1 = 'apply',
> {
  readonly savedPlan: SavedPlanV1;
  readonly plan: OperationPlan<Command>;
  readonly pair: ResolvedArtifactPair;
  readonly selectionOutcome: 'selected' | 'filter-noop';
  readonly resolvedTokens: ReadonlyMap<string, string>;
  readonly guards: SavedReconcileExecutionGuards;
}

export interface ValidatedSavedReconcilePlan extends ValidatedSavedReconcilePlanValue<'apply'> {
  /** Owner-retained decoded envelope preserves the exact source bytes and strict v1 model. */
  readonly artifact: ArtifactReadEnvelope<SavedPlanV1>;
}

const cancelled = (): PlanReconcileError => ({
  code: 'plan-cancelled',
  message: 'plan was cancelled',
  exitClass: 'cancelled',
});

const savedCancelled = (): PlanReconcileError => ({
  code: 'apply-saved-cancelled',
  message: 'saved plan validation was cancelled',
  exitClass: 'cancelled',
});

const stale = (code: string, subject: string): PlanReconcileError => ({
  code,
  message: `${subject}; regenerate a new plan and review it before applying`,
  exitClass: 'state',
});

const permission = (subject: string): PlanReconcileError => ({
  code: 'apply-saved-permission',
  message: subject,
  exitClass: 'permission',
});

const usage = (code: string, message: string): PlanReconcileError => ({
  code,
  message,
  exitClass: 'usage',
});

const savedCompatibilityError = (path: readonly (string | number)[]): PlanReconcileError => {
  const fields = new Set(path.filter((segment): segment is string => typeof segment === 'string'));
  if (fields.has('capabilityPreconditions') || fields.has('capabilityVersion')) {
    return stale('apply-saved-capability', 'saved plan capability contract is incompatible');
  }
  if (fields.has('executorSchemaVersion')) {
    return stale('apply-saved-executor-schema', 'saved plan executor schema is incompatible');
  }
  if (fields.has('hashSchemaVersion')) {
    return stale('apply-saved-hash-schema', 'saved plan hash schema is incompatible');
  }
  return stale('apply-saved-schema', 'saved plan schema is incompatible');
};

const isCancellation = (error: unknown, signal?: AbortSignal): boolean => {
  if (signal?.aborted) return true;
  const code = safeErrorCode(error);
  if (code === 'cancelled' || code === 'ABORT_ERR') return true;
  if (error === null || typeof error !== 'object') return false;
  const name = Object.getOwnPropertyDescriptor(error, 'name');
  return Boolean(name !== undefined && 'value' in name && name.value === 'AbortError');
};

const isPermission = (error: unknown): boolean => {
  const code = safeErrorCode(error);
  return (
    code === 'permission' || code === 'permission-denied' || code === 'EACCES' || code === 'EPERM'
  );
};

const sourceObservationError = (
  error: unknown,
  signal: AbortSignal | undefined,
  subject: string,
): PlanReconcileError => {
  if (isCancellation(error, signal)) return savedCancelled();
  if (isPermission(error)) return permission(`${subject} could not be read`);
  return {
    code: 'apply-saved-source',
    message: `${subject} could not be validated`,
    exitClass: 'source',
  };
};

const artifactReadError = (
  subject: string,
  error: Readonly<{
    readonly reason: string;
    readonly path?: readonly (string | number)[];
  }>,
): PlanReconcileError => {
  if (error.reason === 'invalid-request') {
    return usage('apply-saved-request', `${subject} selector is invalid`);
  }
  if (
    subject === 'saved plan' &&
    (error.reason === 'invalid-shape' || error.reason === 'unsupported-version')
  ) {
    return savedCompatibilityError(error.path ?? []);
  }
  return error.reason === 'permission-denied'
    ? permission(`${subject} could not be read because permission was denied`)
    : stale('apply-saved-artifact', `${subject} is missing, invalid, or incompatible`);
};

const isWithin = (root: string, candidate: string): boolean => {
  const displacement = relative(root, candidate);
  return (
    displacement === '' ||
    (displacement !== '..' && !displacement.startsWith(`..${sep}`) && !isAbsolute(displacement))
  );
};

const portableProjectPath = (projectRoot: string | null, token: string): string | null => {
  if (projectRoot === null) return null;
  if (token === 'project:root') return projectRoot;
  if (!token.startsWith('project:')) return null;
  const suffix = token.slice('project:'.length);
  if (
    suffix.length === 0 ||
    suffix.startsWith('/') ||
    suffix.includes('\\') ||
    suffix.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    return null;
  }
  const path = resolve(projectRoot, ...suffix.split('/'));
  return isWithin(projectRoot, path) ? path : null;
};

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const transformLocations = async (
  input: JsonValue,
  resolveToken: (token: string) => Promise<Result<string, PlanReconcileError>>,
): Promise<Result<JsonValue, PlanReconcileError>> => {
  if (input === null || typeof input !== 'object') return ok(input);
  if (Array.isArray(input)) {
    const output: JsonValue[] = [];
    for (const value of input) {
      const transformed = await transformLocations(value, resolveToken);
      if (!transformed.ok) return transformed;
      output.push(transformed.value);
    }
    return ok(output);
  }
  if (
    input.kind === 'portable' &&
    typeof input.token === 'string' &&
    Object.keys(input).length === 2
  ) {
    const path = await resolveToken(input.token);
    return path.ok ? ok({ kind: 'machine-bound', path: path.value }) : path;
  }
  const output: { [key: string]: JsonValue } = {};
  for (const [key, value] of Object.entries(input)) {
    const transformed = await transformLocations(value, resolveToken);
    if (!transformed.ok) return transformed;
    output[key] = transformed.value;
  }
  return ok(output);
};

const reprojectLocations = (
  input: JsonValue,
  tokenByPath: ReadonlyMap<string, string>,
): JsonValue => {
  if (input === null || typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.map((value) => reprojectLocations(value, tokenByPath));
  if (
    input.kind === 'machine-bound' &&
    typeof input.path === 'string' &&
    Object.keys(input).length === 2
  ) {
    const token = tokenByPath.get(input.path);
    return token === undefined ? input : { kind: 'portable', token };
  }
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, reprojectLocations(value, tokenByPath)]),
  );
};

const jsonValue = (value: unknown): JsonValue => structuredClone(value) as JsonValue;

const deepFreeze = <T>(value: T, seen = new Set<object>()): T => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
};

class ImmutableReadonlyMap<Key, Value> implements ReadonlyMap<Key, Value> {
  readonly #values: Map<Key, Value>;

  constructor(entries: Iterable<readonly [Key, Value]>) {
    this.#values = new Map(entries);
    Object.freeze(this);
  }

  get size(): number {
    return this.#values.size;
  }

  get(key: Key): Value | undefined {
    return this.#values.get(key);
  }

  has(key: Key): boolean {
    return this.#values.has(key);
  }

  entries(): MapIterator<[Key, Value]> {
    return this.#values.entries();
  }

  keys(): MapIterator<Key> {
    return this.#values.keys();
  }

  values(): MapIterator<Value> {
    return this.#values.values();
  }

  forEach(
    callbackfn: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.#values) callbackfn.call(thisArg, value, key, this);
  }

  [Symbol.iterator](): MapIterator<[Key, Value]> {
    return this.entries();
  }

  get [Symbol.toStringTag](): string {
    return 'ImmutableReadonlyMap';
  }

  set(): never {
    throw new TypeError('validated saved-plan token bindings are immutable');
  }

  delete(): never {
    throw new TypeError('validated saved-plan token bindings are immutable');
  }

  clear(): never {
    throw new TypeError('validated saved-plan token bindings are immutable');
  }
}

const resourceKey = (value: unknown): string => JSON.stringify(value);

const validateSavedGraph = (plan: SavedPlanV1): Result<void, PlanReconcileError> => {
  const resourceIds = new Set(
    plan.resourcePreconditions.map(({ preconditionId }) => preconditionId),
  );
  const selectionIds = new Set(
    plan.selectionPreconditions.map(({ preconditionId }) => preconditionId),
  );
  const capabilityIds = new Set(
    plan.capabilityPreconditions.map(({ preconditionId }) => preconditionId),
  );
  const all = new Set([...resourceIds, ...selectionIds, ...capabilityIds]);
  if (all.size !== resourceIds.size + selectionIds.size + capabilityIds.size) {
    return err(stale('apply-saved-precondition-graph', 'saved precondition identities collide'));
  }
  for (const operation of plan.operations) {
    if (operation.preconditionIds.some((id) => !all.has(id))) {
      return err(
        stale(
          'apply-saved-precondition-graph',
          `saved operation ${operation.operationId} references an unknown precondition`,
        ),
      );
    }
  }
  for (const precondition of plan.selectionPreconditions) {
    if (
      precondition.members.some(({ resource, resourceHash }) =>
        plan.resourcePreconditions.every(
          (candidate) =>
            resourceKey(candidate.resource) !== resourceKey(resource) ||
            canonicalPlanningString(candidate.expectedHash) !==
              canonicalPlanningString(resourceHash),
        ),
      )
    ) {
      return err(
        stale(
          'apply-saved-selection-graph',
          'saved selection references an unknown or mismatched resource fact',
        ),
      );
    }
  }
  const referencedIds = new Set(plan.operations.flatMap(({ preconditionIds }) => preconditionIds));
  for (const check of plan.checks) {
    if (check.kind === 'precondition-validation') {
      for (const id of check.preconditionIds) referencedIds.add(id);
    }
  }
  if (plan.portability.kind === 'machine-bound') {
    for (const reason of plan.portability.reasons) {
      for (const id of reason.preconditionIds) referencedIds.add(id);
    }
  }
  const selectedResourceKeys = new Set(
    plan.selectionPreconditions.flatMap(({ members }) =>
      members.map(({ resource }) => resourceKey(resource)),
    ),
  );
  if (
    plan.resourcePreconditions.some(
      ({ preconditionId, resource }) =>
        !referencedIds.has(preconditionId) && !selectedResourceKeys.has(resourceKey(resource)),
    )
  ) {
    return err(
      stale('apply-saved-precondition-graph', 'saved plan contains an unreferenced resource fact'),
    );
  }
  return ok(undefined);
};

const selectionHash = (precondition: SavedPlanV1['selectionPreconditions'][number]) =>
  hashCanonicalInput(
    'selection-set',
    1,
    JSON.stringify([
      'skillsmith-saved-plan-selection',
      1,
      precondition.selectionSource,
      [...precondition.skills].sort(),
      [...precondition.tools].sort(),
      [...precondition.scopes].sort(),
      precondition.members,
    ]),
  );

const capabilityHash = (precondition: SavedPlanV1['capabilityPreconditions'][number]) =>
  hashCanonicalInput(
    'capability',
    1,
    JSON.stringify([
      'skillsmith-capability-precondition',
      1,
      precondition.tool,
      precondition.operation,
      precondition.capabilityVersion,
      true,
      precondition.scopes,
    ]),
  );

const validateScopedArtifactAuthorization = (
  plan: SavedPlanV1,
  manifest: ArtifactReadEnvelope<NormalizedManifestV1>,
  lock: ArtifactReadResult<PortableLockV1>,
): Result<
  Readonly<{ mode: 'scoped' | 'legacy-global'; facts: SavedPlanScopedArtifactFacts }>,
  PlanReconcileError
> => {
  const selection = plan.selectionPreconditions[0];
  if (selection === undefined || plan.selectionPreconditions.length !== 1) {
    return err(stale('apply-saved-selection-set', 'saved selection authority is incomplete'));
  }
  const scoped = createSavedPlanScopedArtifactFacts({
    manifest: manifest.model,
    lock: lock.state === 'present' ? lock.model : null,
    predicates: {
      skills: selection.skills,
      tools: selection.tools,
      scopes: selection.scopes,
    },
    prune: plan.options.prune,
  });
  if (!scoped.ok) {
    return err(stale('apply-saved-selection-set', 'current selected state could not be hashed'));
  }
  const selectedManifestMember = selection.members.find(
    ({ resource, resourceHash }) =>
      resource.kind === 'manifest-bytes' && resourceHash.domain === 'manifest-semantic',
  );
  const selectedLockMember = selection.members.find(
    ({ resource, resourceHash }) =>
      resource.kind === 'lock' && resourceHash.domain === 'lock-canonical',
  );
  const manifestFact = plan.resourcePreconditions.find(
    ({ resource, expectedHash }) =>
      selectedManifestMember !== undefined &&
      resourceKey(resource) === resourceKey(selectedManifestMember.resource) &&
      canonicalPlanningString(expectedHash) ===
        canonicalPlanningString(selectedManifestMember.resourceHash),
  );
  const lockFact = plan.resourcePreconditions.find(
    ({ resource, expectedHash }) =>
      selectedLockMember !== undefined &&
      resourceKey(resource) === resourceKey(selectedLockMember.resource) &&
      canonicalPlanningString(expectedHash) ===
        canonicalPlanningString(selectedLockMember.resourceHash),
  );
  if (manifestFact === undefined || lockFact === undefined) {
    return err(stale('apply-saved-artifact-graph', 'saved artifact facts are incomplete'));
  }
  const sameSelection =
    canonicalPlanningString(plan.selection.skills) ===
      canonicalPlanningString(scoped.value.selectedSkills) &&
    canonicalPlanningString(plan.selection.tools) ===
      canonicalPlanningString(scoped.value.selectedTools) &&
    canonicalPlanningString(plan.selection.scopes) ===
      canonicalPlanningString(scoped.value.selectedScopes);
  if (!sameSelection) {
    return err(stale('apply-saved-selection-set', 'selected manifest membership changed'));
  }
  const markedScoped =
    String(manifestFact.expectedHash.digest) !== String(plan.manifestSemanticHash);
  if (markedScoped) {
    if (String(manifestFact.expectedHash.digest) !== scoped.value.scopedManifestSemanticHash) {
      return err(stale('apply-saved-manifest-semantic', 'selected manifest semantics changed'));
    }
    if (String(lockFact.expectedHash.digest) !== scoped.value.scopedLockCanonicalHash) {
      return err(stale('apply-saved-lock-canonical', 'selected lock state changed'));
    }
    return ok({ mode: 'scoped', facts: scoped.value });
  }

  const globalLock =
    lock.state === 'present'
      ? hashPortableLock(lock.model)
      : hashCanonicalInput('lock-canonical', 1, 'absent');
  if (!globalLock.ok) {
    return err(stale('apply-saved-lock-canonical', 'current lock fact could not be hashed'));
  }
  if (
    manifest.semanticRevision === null ||
    String(plan.manifestSemanticHash) !== manifest.semanticRevision ||
    String(manifestFact.expectedHash.digest) !== manifest.semanticRevision
  ) {
    return err(stale('apply-saved-manifest-semantic', 'selected manifest semantics changed'));
  }
  const legacyLockMatch =
    (plan.lockCanonicalHash === null
      ? lock.state === 'absent'
      : lock.state === 'present' && String(plan.lockCanonicalHash) === globalLock.value) &&
    String(lockFact.expectedHash.digest) === globalLock.value;
  return legacyLockMatch
    ? ok({ mode: 'legacy-global', facts: scoped.value })
    : err(stale('apply-saved-lock-canonical', 'selected lock state changed'));
};

const locationOf = (value: JsonValue): PlanLocationV1 | null => {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    ((value.kind === 'portable' && typeof value.token === 'string') ||
      (value.kind === 'machine-bound' && typeof value.path === 'string'))
  ) {
    return value as PlanLocationV1;
  }
  return null;
};

const collectLocations = (input: JsonValue, output: PlanLocationV1[] = []): PlanLocationV1[] => {
  const location = locationOf(input);
  if (location !== null) {
    output.push(location);
    return output;
  }
  if (Array.isArray(input)) {
    for (const value of input) collectLocations(value, output);
  } else if (input !== null && typeof input === 'object') {
    for (const value of Object.values(input)) collectLocations(value, output);
  }
  return output;
};

const validateMachineReasonAssociations = (
  plan: SavedPlanV1,
  localSources: ReadonlyMap<string, string>,
): Result<void, PlanReconcileError> => {
  if (plan.portability.kind !== 'machine-bound') return ok(undefined);
  const preconditions = new Map(
    plan.resourcePreconditions.map((precondition) => [precondition.preconditionId, precondition]),
  );
  for (const reason of plan.portability.reasons) {
    for (const id of reason.preconditionIds) {
      const precondition = preconditions.get(id);
      if (precondition === undefined) {
        return err(
          stale(
            'apply-saved-machine-binding',
            'machine reason references an unknown resource fact',
          ),
        );
      }
      const direct = collectLocations(jsonValue(precondition.resource)).some(
        (location) => location.kind === 'machine-bound' && location.path === reason.path,
      );
      const source =
        reason.code === 'local-dev-source' &&
        precondition.resource.kind === 'store' &&
        localSources.get(reason.path) === String(precondition.resource.contentHash);
      const operation = plan.operations.some(
        (candidate) =>
          candidate.preconditionIds.includes(id) &&
          (collectLocations(jsonValue(candidate)).some(
            (location) => location.kind === 'machine-bound' && location.path === reason.path,
          ) ||
            [
              candidate.source,
              candidate.before.kind === 'placement' ? candidate.before.source : null,
              candidate.after.kind === 'placement' ? candidate.after.source : null,
            ].some(
              (candidateSource) =>
                candidateSource?.kind === 'local-dev' && candidateSource.path === reason.path,
            )),
      );
      if (!direct && !source && !operation) {
        return err(
          stale(
            'apply-saved-machine-binding',
            `machine reason ${reason.code} is not associated with its resource fact`,
          ),
        );
      }
    }
  }
  return ok(undefined);
};

const sourceStoreBindings = (plan: SavedPlanV1, storeRoot: string): ReadonlyMap<string, string> => {
  const output = new Map<string, string>();
  const add = (source: SavedPlanV1['operations'][number]['source'], skill: string | null): void => {
    if (source?.kind !== 'portable' || skill === null) return;
    const token = `store:${source.contentHash.slice('sha256:'.length)}/${skill}`;
    const identity = clampStoreNs(source.identity.repository);
    output.set(
      token,
      join(storeRoot, identity.ns, `${identity.name}@${source.resolvedSha.slice(0, 12)}`, skill),
    );
  };
  for (const operation of plan.operations) {
    add(operation.source, operation.skill);
    for (const image of [operation.before, operation.after]) {
      if (image.kind === 'placement') add(image.source, image.resource.skill);
      if (
        image.kind !== 'placement' ||
        image.linkTarget?.kind !== 'portable' ||
        !image.linkTarget.token.startsWith('store:') ||
        image.source?.kind !== 'portable'
      ) {
        continue;
      }
      const expectedToken = `store:${image.source.contentHash.slice('sha256:'.length)}/${image.resource.skill}`;
      if (expectedToken !== image.linkTarget.token) continue;
      add(image.source, image.resource.skill);
    }
  }
  return output;
};

const imageLocation = (image: SavedPlanV1['operations'][number]['before']): string | null => {
  const location =
    image.kind === 'absent' || image.kind === 'placement'
      ? image.resource.kind === 'live'
        ? image.resource.location
        : null
      : image.kind === 'manifest' || image.kind === 'lock'
        ? image.location
        : null;
  return location?.kind === 'machine-bound' ? location.path : null;
};

const observedLivePathKind = async (
  runtime: ValidateSavedReconcilePlanRuntime,
  path: string,
): Promise<Awaited<ReturnType<AcquisitionPorts['pathKind']>>> =>
  (await classifyPlacementRoot(runtime.ports, dirname(path))) === 'container'
    ? runtime.ports.pathKind(path)
    : 'absent';

const validateObservedBefore = async (
  operation: SavedPlanV1['operations'][number],
  runtime: ValidateSavedReconcilePlanRuntime,
  storeBindings: ReadonlyMap<string, string>,
  manifest: ArtifactReadEnvelope<NormalizedManifestV1>,
  lock: ArtifactReadResult<PortableLockV1>,
): Promise<Result<void, PlanReconcileError>> => {
  if (runtime.signal?.aborted) return err(savedCancelled());
  const image = operation.before;
  if (image.kind === 'manifest') {
    const currentShape = manifest.sourceVersion === 'legacy' ? 'legacy' : 'canonical';
    const currentValue = {
      version: 1 as const,
      defaults:
        manifest.model.defaults === undefined
          ? null
          : {
              tools: manifest.model.defaults.tools ?? null,
              scope: manifest.model.defaults.scope ?? null,
              path: manifest.model.defaults.path ?? null,
            },
      registry:
        manifest.model.registry === undefined
          ? null
          : { default: manifest.model.registry.default ?? null },
      skills: manifest.model.skills.map((skill) => ({
        ...skill,
        source: { ...skill.source },
      })),
    };
    if (
      image.version !== manifest.model.version ||
      image.shape !== currentShape ||
      String(image.byteHash) !== hashManifestBytes(manifest.source) ||
      String(image.semanticHash) !== manifest.semanticRevision ||
      canonicalPlanningString(image.value) !== canonicalPlanningString(currentValue)
    ) {
      return err(stale('apply-saved-manifest-semantic', 'selected manifest semantics changed'));
    }
    return ok(undefined);
  }
  if (image.kind === 'lock') {
    if (lock.state !== 'present') {
      return err(stale('apply-saved-lock-canonical', 'selected lock state changed'));
    }
    const currentHash = hashPortableLock(lock.model);
    if (
      !currentHash.ok ||
      image.version !== lock.model.version ||
      String(image.canonicalHash) !== currentHash.value ||
      canonicalPlanningString(image.value) !== canonicalPlanningString(lock.model)
    ) {
      return err(stale('apply-saved-lock-canonical', 'selected lock state changed'));
    }
    return ok(undefined);
  }
  if (image.kind === 'ledger') {
    const observed = await readLedgerArtifact(
      runtime.ports,
      ledgerPathOf(resolveDataDir(runtime.ports, runtime.configuration)),
    );
    if (!observed.ok) return err(artifactReadError('referenced ledger', observed.error));
    if (
      observed.value.state !== 'present' ||
      observed.value.semanticRevision !== image.semanticHash ||
      observed.value.sourceVersion !== image.schemaVersion
    ) {
      return err(stale('apply-saved-ledger-resource', 'referenced ledger state changed'));
    }
    return ok(undefined);
  }
  const resource = image.resource;
  if (resource.kind === 'manifest-bytes' || resource.kind === 'lock') return ok(undefined);
  if (resource.kind === 'store') {
    const prefix = `store:${resource.contentHash.slice('sha256:'.length)}/`;
    const candidates = [...storeBindings]
      .filter(([token]) => token.startsWith(prefix))
      .map(([, path]) => path);
    const candidate = candidates.length === 1 ? candidates[0] : undefined;
    if (candidate === undefined) {
      return err(
        stale('apply-saved-store-binding', 'referenced store location is not reconstructible'),
      );
    }
    try {
      const kind = await runtime.ports.pathKind(candidate);
      if (image.kind === 'absent') {
        return kind === 'absent'
          ? ok(undefined)
          : err(stale('apply-saved-store-resource', 'referenced store state changed'));
      }
      return ok(undefined);
    } catch (error) {
      if (isCancellation(error, runtime.signal)) return err(savedCancelled());
      if (isPermission(error))
        return err(permission('referenced store resource could not be read'));
      return err(
        stale('apply-saved-store-observation', 'referenced store state could not be observed'),
      );
    }
  }
  if (resource.kind !== 'live') return ok(undefined);
  const path = imageLocation(image);
  if (path === null) {
    return err(stale('apply-saved-live-binding', 'referenced live location did not resolve'));
  }
  let kind: Awaited<ReturnType<AcquisitionPorts['pathKind']>>;
  try {
    kind = await observedLivePathKind(runtime, path);
  } catch (error) {
    if (isCancellation(error, runtime.signal)) return err(savedCancelled());
    return err(
      isPermission(error)
        ? permission('referenced live resource could not be inspected')
        : stale('apply-saved-live-observation', 'referenced live resource could not be observed'),
    );
  }
  try {
    if (image.kind === 'absent') {
      return kind === 'absent'
        ? ok(undefined)
        : err(
            stale(
              'apply-saved-live-resource',
              `referenced live resource ${resource.skill} changed`,
            ),
          );
    }
    if (kind !== 'dir' && kind !== 'symlink') {
      return err(
        stale('apply-saved-live-resource', `referenced live resource ${resource.skill} changed`),
      );
    }
    const representation = kind === 'dir' ? 'copy' : 'symlink';
    if (representation !== image.representation) {
      return err(
        stale(
          'apply-saved-live-resource',
          `referenced live resource ${resource.skill} representation changed`,
        ),
      );
    }
    if (kind === 'symlink') {
      const target = resolve(path, '..', await runtime.ports.readLink(path));
      const expected = image.linkTarget?.kind === 'machine-bound' ? image.linkTarget.path : null;
      if (expected === null || target !== expected) {
        return err(
          stale(
            'apply-saved-live-resource',
            `referenced live resource ${resource.skill} target changed`,
          ),
        );
      }
    }
    if (image.contentHash !== null) {
      const contentRoot = kind === 'symlink' ? await runtime.ports.realpath(path) : path;
      const projected = await projectSourceContent(runtime.ports, contentRoot);
      const content = projected.ok ? hashSourceContentV1(projected.value) : projected;
      if (!content.ok || content.value !== String(image.contentHash)) {
        return err(
          stale(
            'apply-saved-live-resource',
            `referenced live resource ${resource.skill} content changed`,
          ),
        );
      }
    }
    return ok(undefined);
  } catch (error) {
    if (isCancellation(error, runtime.signal)) return err(savedCancelled());
    if (isPermission(error)) {
      return err(permission(`referenced live resource ${resource.skill} could not be read`));
    }
    return err(
      stale(
        'apply-saved-live-observation',
        `referenced live resource ${resource.skill} could not be observed`,
      ),
    );
  }
};

const locationPath = (location: PlanLocationV1 | null): string | null =>
  location?.kind === 'machine-bound' ? location.path : null;

const validateReferencedResources = async (
  preconditions: readonly ResourcePreconditionV1[],
  runtime: ValidateSavedReconcilePlanRuntime,
  storeBindings: ReadonlyMap<string, string>,
  localSources: ReadonlyMap<string, string>,
  manifest: ArtifactReadEnvelope<NormalizedManifestV1>,
  lock: ArtifactReadResult<PortableLockV1>,
): Promise<Result<void, PlanReconcileError>> => {
  let ledger: Awaited<ReturnType<typeof readLedgerArtifact>> | null = null;
  const readLedger = async () => {
    ledger ??= await readLedgerArtifact(
      runtime.ports,
      ledgerPathOf(resolveDataDir(runtime.ports, runtime.configuration)),
    );
    return ledger;
  };
  for (const precondition of preconditions) {
    if (runtime.signal?.aborted) return err(savedCancelled());
    const { resource } = precondition;
    if (resource.kind === 'manifest-bytes') {
      if (precondition.expectedState !== 'present' || manifest.state !== 'present') {
        return err(stale('apply-saved-manifest-resource', 'selected manifest state changed'));
      }
      continue;
    }
    if (resource.kind === 'lock') {
      if (precondition.expectedState !== lock.state) {
        return err(stale('apply-saved-lock-resource', 'selected lock state changed'));
      }
      continue;
    }
    if (resource.kind === 'project-context') {
      const root = locationPath(resource.root);
      const currentRoot = runtime.projectContext.projectRoot ?? runtime.projectContext.effectiveCwd;
      if (precondition.expectedState !== 'present' || root === null || root !== currentRoot) {
        return err(stale('apply-saved-project-resource', 'referenced project context changed'));
      }
      continue;
    }
    if (resource.kind === 'ledger' || resource.kind === 'ledger-schema') {
      const observed = await readLedger();
      if (!observed.ok) return err(artifactReadError('referenced ledger', observed.error));
      if (observed.value.state !== precondition.expectedState) {
        return err(stale('apply-saved-ledger-resource', 'referenced ledger state changed'));
      }
      if (
        resource.kind === 'ledger-schema' &&
        observed.value.state === 'present' &&
        String(precondition.expectedHash.digest) !== observed.value.byteRevision
      ) {
        return err(stale('apply-saved-ledger-resource', 'referenced ledger schema bytes changed'));
      }
      continue;
    }
    if (resource.kind === 'live') {
      const path = locationPath(resource.location);
      if (path === null) {
        return err(stale('apply-saved-live-binding', 'referenced live location did not resolve'));
      }
      try {
        const kind = await observedLivePathKind(runtime, path);
        const state = kind === 'absent' ? 'absent' : 'present';
        if (state !== precondition.expectedState) {
          return err(
            stale(
              'apply-saved-live-resource',
              `referenced live resource ${resource.skill} changed`,
            ),
          );
        }
      } catch (error) {
        if (isCancellation(error, runtime.signal)) return err(savedCancelled());
        if (isPermission(error)) {
          return err(permission(`referenced live resource ${resource.skill} could not be read`));
        }
        return err(
          stale(
            'apply-saved-live-observation',
            `referenced live resource ${resource.skill} could not be observed`,
          ),
        );
      }
      continue;
    }
    if (resource.kind === 'store') {
      const contentHash = String(resource.contentHash);
      if (
        precondition.expectedHash.domain === 'source-content' &&
        precondition.expectedState === 'present' &&
        [...localSources.values()].includes(contentHash)
      ) {
        continue;
      }
      const prefix = `store:${contentHash.slice('sha256:'.length)}/`;
      const candidates = [...storeBindings]
        .filter(([token]) => token.startsWith(prefix))
        .map(([, path]) => path);
      if (candidates.length !== 1) {
        return err(
          stale('apply-saved-store-binding', 'referenced store location is not reconstructible'),
        );
      }
      const path = candidates[0] as string;
      try {
        const kind = await runtime.ports.pathKind(path);
        const state = kind === 'absent' ? 'absent' : 'present';
        if (state !== precondition.expectedState) {
          return err(stale('apply-saved-store-resource', 'referenced store state changed'));
        }
        if (state === 'present') {
          if (kind !== 'dir') {
            return err(stale('apply-saved-store-resource', 'referenced store is invalid'));
          }
          const projected = await projectSourceContent(runtime.ports, path);
          const actual = projected.ok ? hashSourceContentV1(projected.value) : projected;
          if (!actual.ok || actual.value !== contentHash) {
            return err(stale('apply-saved-store-resource', 'referenced store content changed'));
          }
        }
      } catch (error) {
        if (isCancellation(error, runtime.signal)) return err(savedCancelled());
        if (isPermission(error)) return err(permission('referenced store could not be read'));
        return err(
          stale('apply-saved-store-observation', 'referenced store could not be observed'),
        );
      }
    }
  }
  return ok(undefined);
};

const validateCurrentSelectedLiveInventory = async (
  plan: SavedPlanV1,
  manifest: ArtifactReadEnvelope<NormalizedManifestV1>,
  lock: ArtifactReadResult<PortableLockV1>,
  runtime: ValidateSavedReconcilePlanRuntime,
): Promise<Result<void, PlanReconcileError>> => {
  const selection = plan.selectionPreconditions[0];
  if (selection === undefined) {
    return err(stale('apply-saved-selection-set', 'saved selection authority is incomplete'));
  }
  const selectedPairs = new Map<string, { tool: SupportedTool; scope: 'user' | 'project' }>();
  const relevantNames = new Set<string>();
  for (const declaration of manifest.model.skills) {
    if (selection.skills.length > 0 && !selection.skills.includes(declaration.name)) continue;
    if (selection.scopes.length > 0 && !selection.scopes.includes(declaration.scope)) continue;
    const tools = declaration.tools.filter(
      (tool) => selection.tools.length === 0 || selection.tools.includes(tool),
    );
    if (tools.length === 0) continue;
    relevantNames.add(declaration.name);
    for (const tool of tools) {
      selectedPairs.set(`${tool}\0${declaration.scope}`, {
        tool,
        scope: declaration.scope,
      });
    }
  }
  if (plan.options.prune && selectedPairs.size > 0 && lock.state === 'present') {
    const declaredNames = new Set(manifest.model.skills.map(({ name }) => name));
    for (const pin of lock.model.skills) {
      if (!declaredNames.has(pin.name)) relevantNames.add(pin.name);
    }
  }

  const signedLive = new Set(
    selection.members.flatMap(({ resource }) =>
      resource.kind === 'live' && resource.location.kind === 'machine-bound'
        ? [
            `${resource.tool}\0${resource.scope}\0${resource.skill}\0${resolve(resource.location.path)}`,
          ]
        : [],
    ),
  );
  const storeRoot = storeRootOf(resolveDataDir(runtime.ports, runtime.configuration));
  for (const { tool, scope } of selectedPairs.values()) {
    if (runtime.signal?.aborted) return err(savedCancelled());
    const adapter = toolRegistry.get(tool);
    if (adapter?.placement === undefined) {
      return err(stale('apply-saved-capability', `required ${tool} inventory is unavailable`));
    }
    try {
      const inventory = await adapter.placement.listScoped(
        runtime.ports,
        {
          cwd:
            scope === 'project'
              ? (runtime.projectContext.projectRoot ?? runtime.projectContext.effectiveCwd)
              : runtime.projectContext.effectiveCwd,
          configuration: runtime.configuration,
        },
        storeRoot,
        scope,
      );
      for (const placement of inventory.placements) {
        if (placement.class === 'absent' || !relevantNames.has(placement.skill)) continue;
        const key = `${tool}\0${scope}\0${placement.skill}\0${resolve(placement.path)}`;
        if (!signedLive.has(key)) {
          return err(
            stale(
              'apply-saved-selection-set',
              `selected live inventory gained ${placement.skill} for ${tool}/${scope}`,
            ),
          );
        }
      }
    } catch (error) {
      if (isCancellation(error, runtime.signal)) return err(savedCancelled());
      if (isPermission(error)) {
        return err(permission(`selected ${tool}/${scope} live inventory could not be read`));
      }
      return err(
        stale(
          'apply-saved-live-observation',
          `selected ${tool}/${scope} live inventory could not be observed`,
        ),
      );
    }
  }
  return ok(undefined);
};

/**
 * Validate an already strict in-memory saved projection. Fresh apply uses this seam so the
 * approved/rendered portable operation IDs are the exact IDs handed to execution, without a
 * temporary plan artifact or a second planning pass.
 */
export const validateSavedReconcilePlanValue = async <
  Command extends ReconcileExecutionCommandV1 = 'apply',
>(
  input: SavedPlanV1,
  runtime: ValidateSavedReconcilePlanRuntime,
  command: Command = 'apply' as Command,
): Promise<Result<ValidatedSavedReconcilePlanValue<Command>, PlanReconcileError>> => {
  if (runtime.signal?.aborted) return err(savedCancelled());
  const codec = artifactContractRegistry.get('plan', 1);
  if (codec === undefined) {
    return err(stale('apply-saved-schema', 'saved plan schema is unavailable'));
  }
  const decoded = codec.toDto(input);
  if (!decoded.ok) {
    return err(savedCompatibilityError(decoded.error.path));
  }
  const savedPlan = decoded.value as unknown as SavedPlanV1;
  const graph = validateSavedGraph(savedPlan);
  if (!graph.ok) return graph;

  for (const selection of savedPlan.selectionPreconditions) {
    const hash = selectionHash(selection);
    if (!hash.ok || hash.value !== selection.expectedHash) {
      return err(stale('apply-saved-selection-set', 'saved selection authorization is invalid'));
    }
  }
  for (const capability of savedPlan.capabilityPreconditions) {
    const adapter = toolRegistry.get(capability.tool);
    const current = adapter?.descriptor.operations[capability.operation];
    const hash = capabilityHash(capability);
    if (
      !hash.ok ||
      hash.value !== capability.expectedHash ||
      adapter?.descriptor.capabilityVersion !== capability.capabilityVersion ||
      current?.supported !== true ||
      capability.scopes.some((scope) => !current.scopes.includes(scope))
    ) {
      return err(
        stale(
          'apply-saved-capability',
          `required ${capability.tool} capability changed or is unsupported`,
        ),
      );
    }
  }

  const projectRoot = runtime.projectContext.projectRoot;
  const exactProjectContextRoot = projectRoot ?? runtime.projectContext.effectiveCwd;
  const storeRoot = storeRootOf(resolveDataDir(runtime.ports, runtime.configuration));
  const storeBindings = sourceStoreBindings(savedPlan, storeRoot);
  const machineLocations = new Set(
    collectLocations(jsonValue(savedPlan))
      .filter((location) => location.kind === 'machine-bound')
      .map((location) => (location as Extract<PlanLocationV1, { kind: 'machine-bound' }>).path),
  );
  const localSources = new Map<string, string>();
  const addSource = (source: SavedPlanV1['operations'][number]['source']): void => {
    if (source?.kind === 'local-dev') localSources.set(source.path, String(source.contentHash));
  };
  for (const operation of savedPlan.operations) {
    addSource(operation.source);
    for (const image of [operation.before, operation.after]) {
      if (image.kind === 'placement') addSource(image.source);
    }
  }
  for (const check of savedPlan.checks) {
    if (check.kind === 'source-resolution' || check.kind === 'content-integrity') {
      addSource(check.source);
    }
  }
  for (const diagnostic of savedPlan.diagnostics) addSource(diagnostic.affected.source);
  const machineAssociations = validateMachineReasonAssociations(savedPlan, localSources);
  if (!machineAssociations.ok) return machineAssociations;

  if (
    savedPlan.portability.kind === 'portable' &&
    (machineLocations.size > 0 || localSources.size > 0)
  ) {
    return err(stale('apply-saved-portability', 'portable plan contains a machine binding'));
  }
  if (savedPlan.portability.kind === 'machine-bound') {
    const reasonPaths = new Set(savedPlan.portability.reasons.map(({ path }) => path));
    const resourceIds = new Set(
      savedPlan.resourcePreconditions.map(({ preconditionId }) => preconditionId),
    );
    if (
      [...machineLocations, ...localSources.keys()].some((path) => !reasonPaths.has(path)) ||
      savedPlan.portability.reasons.some((reason) =>
        reason.preconditionIds.some((id) => !resourceIds.has(id)),
      )
    ) {
      return err(
        stale('apply-saved-machine-binding', 'saved machine binding authorization is incomplete'),
      );
    }
    for (const reason of savedPlan.portability.reasons) {
      if (reason.code === 'local-project-root' && reason.path !== exactProjectContextRoot) {
        return err(
          stale('apply-saved-machine-binding', 'saved project binding does not match this project'),
        );
      }
    }
    if (
      savedPlan.portability.reasons.some(({ code }) => code === 'absolute-artifact-selector') &&
      !savedPlan.portability.reasons.some(({ code }) => code === 'local-project-root')
    ) {
      return err(
        stale(
          'apply-saved-machine-binding',
          'saved absolute artifact binding lacks an exact project-context authorization',
        ),
      );
    }
  }

  const resolvedTokens = new Map<string, string>();
  const tokenByPath = new Map<string, string>();
  const bindToken = (token: string, path: string): Result<string, PlanReconcileError> => {
    const normalized = resolve(path);
    const existingPath = resolvedTokens.get(token);
    if (existingPath !== undefined && existingPath !== normalized) {
      return err(stale('apply-saved-token-ambiguous', `portable token '${token}' is ambiguous`));
    }
    const existingToken = tokenByPath.get(normalized);
    const isAuthorizedProjectRootAlias =
      token === 'project:root' && projectRoot !== null && normalized === exactProjectContextRoot;
    if (
      (existingToken !== undefined && existingToken !== token) ||
      (machineLocations.has(normalized) && !isAuthorizedProjectRootAlias)
    ) {
      return err(
        stale('apply-saved-token-ambiguous', `portable token '${token}' has an ambiguous binding`),
      );
    }
    resolvedTokens.set(token, normalized);
    tokenByPath.set(normalized, token);
    return ok(normalized);
  };
  const resolveToken = async (token: string): Promise<Result<string, PlanReconcileError>> => {
    const cached = resolvedTokens.get(token);
    if (cached !== undefined) return ok(cached);
    const projectPath = portableProjectPath(projectRoot, token);
    if (projectPath !== null) return bindToken(token, projectPath);
    if (token === 'user:skillsmith.toml') {
      return bindToken(token, join(runtime.ports.xdg.config, 'skillsmith', 'skillsmith.toml'));
    }
    if (token === 'user:skillsmith.lock') {
      return bindToken(token, join(runtime.ports.xdg.config, 'skillsmith', 'skillsmith.lock'));
    }
    const store = storeBindings.get(token);
    if (store !== undefined) return bindToken(token, store);
    const skill = /^skills\/(user|project)\/([^/]+)\/([^/]+)$/u.exec(token);
    if (skill !== null) {
      const scope = skill[1] as 'user' | 'project';
      const tool = skill[2] ?? '';
      const name = skill[3] ?? '';
      const adapter = toolRegistry.get(tool);
      if (adapter?.placement === undefined || (scope === 'project' && projectRoot === null)) {
        return err(stale('apply-saved-token-unknown', `portable token '${token}' is unsupported`));
      }
      // A scope the tool does not manage (muse in project scope) binds no
      // saved token: resolving would throw the no-destination invariant.
      if (
        adapter.placement.rootFacts(runtime.ports, scope, {
          cwd: scope === 'project' ? (projectRoot as string) : runtime.projectContext.effectiveCwd,
          configuration: runtime.configuration,
        }).length === 0
      ) {
        return err(stale('apply-saved-token-unknown', `portable token '${token}' is unsupported`));
      }
      try {
        const placement = await adapter.placement.resolveScoped(
          runtime.ports,
          {
            cwd:
              scope === 'project' ? (projectRoot as string) : runtime.projectContext.effectiveCwd,
            configuration: runtime.configuration,
          },
          storeRoot,
          name,
          scope,
        );
        if (placement.duplicateReason !== null) {
          return err(
            stale('apply-saved-token-ambiguous', `portable token '${token}' is ambiguous`),
          );
        }
        return bindToken(token, placement.placement.path);
      } catch (error) {
        const code =
          error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        return err(
          code === 'EACCES' || code === 'EPERM'
            ? permission(`portable token '${token}' could not be resolved`)
            : stale('apply-saved-token-observation', `portable token '${token}' could not resolve`),
        );
      }
    }
    return err(stale('apply-saved-token-unknown', `portable token '${token}' is unknown`));
  };

  for (const [token, path] of storeBindings) {
    const bound = bindToken(token, path);
    if (!bound.ok) return bound;
  }

  const remapped = await transformLocations(jsonValue(savedPlan), resolveToken);
  if (!remapped.ok) return remapped;
  const runtimeSavedPlan = remapped.value as unknown as SavedPlanV1;
  const manifestPath =
    runtimeSavedPlan.artifactPair.manifest.kind === 'machine-bound'
      ? runtimeSavedPlan.artifactPair.manifest.path
      : null;
  const lockPath =
    runtimeSavedPlan.artifactPair.lock.kind === 'machine-bound'
      ? runtimeSavedPlan.artifactPair.lock.path
      : null;
  if (manifestPath === null || lockPath === null) {
    return err(stale('apply-saved-artifact-binding', 'saved artifact pair did not resolve'));
  }
  const pair = await resolveArtifactPair(
    runtime.ports,
    runtime.projectContext,
    runtimeSavedPlan.artifactPair.lockSource === 'explicit'
      ? { file: manifestPath, lockfile: lockPath }
      : { file: manifestPath },
  );
  if (
    !pair.ok ||
    pair.value.lockfileSource !== runtimeSavedPlan.artifactPair.lockSource ||
    resolve(pair.value.file.path) !== resolve(manifestPath) ||
    resolve(pair.value.lockfile.path) !== resolve(lockPath)
  ) {
    return err(
      stale(
        'apply-saved-artifact-binding',
        'saved artifact pair does not match its signed lock source',
      ),
    );
  }
  const manifestRead = await readManifestArtifact(runtime.ports, manifestPath);
  if (!manifestRead.ok) return err(artifactReadError('selected manifest', manifestRead.error));
  if (manifestRead.value.state !== 'present' || manifestRead.value.semanticRevision === null) {
    return err(stale('apply-saved-manifest-semantic', 'selected manifest is absent or invalid'));
  }
  const lockRead = await readLockArtifact(runtime.ports, lockPath);
  if (!lockRead.ok) return err(artifactReadError('selected lock', lockRead.error));
  const artifactAuthorization = validateScopedArtifactAuthorization(
    savedPlan,
    manifestRead.value,
    lockRead.value,
  );
  if (!artifactAuthorization.ok) return artifactAuthorization;

  for (const [path, expectedHash] of localSources) {
    if (runtime.signal?.aborted) return err(savedCancelled());
    let readFailure: unknown = null;
    const track = async <T>(read: () => Promise<T>): Promise<T> => {
      try {
        return await read();
      } catch (error) {
        readFailure ??= error;
        throw error;
      }
    };
    const projected = await projectSourceContent(
      {
        listDir: (candidate) => track(() => runtime.ports.listDir(candidate)),
        readBytes: (candidate) => track(() => runtime.ports.readBytes(candidate)),
        readLink: (candidate) => track(() => runtime.ports.readLink(candidate)),
        readFileMetadata: (candidate) => track(() => runtime.ports.readFileMetadata(candidate)),
      },
      path,
    );
    if (runtime.signal?.aborted) return err(savedCancelled());
    if (!projected.ok) {
      return err(
        sourceObservationError(readFailure ?? projected.error, runtime.signal, 'local source'),
      );
    }
    const hashed = hashSourceContentV1(projected.value);
    if (!hashed.ok || hashed.value !== expectedHash) {
      return err(
        hashed.ok
          ? stale('apply-saved-source-content', 'referenced local source content changed')
          : sourceObservationError(hashed.error, runtime.signal, 'local source'),
      );
    }
  }
  const referencedResources = await validateReferencedResources(
    runtimeSavedPlan.resourcePreconditions.map(
      (value) => jsonValue(value) as unknown as ResourcePreconditionV1,
    ),
    runtime,
    storeBindings,
    localSources,
    manifestRead.value,
    lockRead.value,
  );
  if (!referencedResources.ok) return referencedResources;
  const currentLiveInventory = await validateCurrentSelectedLiveInventory(
    runtimeSavedPlan,
    manifestRead.value,
    lockRead.value,
    runtime,
  );
  if (!currentLiveInventory.ok) return currentLiveInventory;
  for (const operation of runtimeSavedPlan.operations) {
    const observed = await validateObservedBefore(
      operation,
      runtime,
      storeBindings,
      manifestRead.value,
      lockRead.value,
    );
    if (!observed.ok) return observed;
  }

  const operationInputs = runtimeSavedPlan.operations.map(({ dependsOn, ...operation }) => ({
    ...operation,
    dependencyMetadata: {
      domain: 'skillsmith.operation-dependency' as const,
      schemaVersion: 1 as const,
      operationIds: dependsOn,
    },
  }));
  let plan: OperationPlan<Command>;
  try {
    plan = createOperationPlan({
      domain: 'skillsmith.operation-plan',
      schemaVersion: 1,
      command,
      selection: {
        source: runtimeSavedPlan.selection.selectionSource,
        skills: runtimeSavedPlan.selection.skills,
        tools: runtimeSavedPlan.selection.tools,
        scopes: runtimeSavedPlan.selection.scopes,
      },
      batchPolicy: 'fail-fast',
      operations: operationInputs,
      checks: runtimeSavedPlan.checks,
      diagnostics: runtimeSavedPlan.diagnostics,
    } as unknown as OperationPlanInput<Command>);
  } catch {
    return err(stale('apply-saved-operation-graph', 'saved operation graph is incompatible'));
  }

  const savedOperations = plan.operations.map(({ dependencyMetadata, ...operation }) => ({
    ...operation,
    dependsOn: dependencyMetadata.operationIds,
  }));
  const exactProjection = {
    operations: reprojectLocations(jsonValue(savedOperations), tokenByPath),
    checks: reprojectLocations(jsonValue(plan.checks), tokenByPath),
    diagnostics: reprojectLocations(jsonValue(plan.diagnostics), tokenByPath),
  };
  const canonicalInverse = codec.toDto({
    ...savedPlan,
    ...exactProjection,
  } as unknown as SavedPlanV1);
  if (!canonicalInverse.ok) {
    return err(
      stale(
        'apply-saved-inverse-projection',
        'remapped operations do not exactly reproject to the saved authorization',
      ),
    );
  }
  const canonicalInversePlan = canonicalInverse.value as SavedPlanV1;
  if (
    canonicalPlanningString({
      operations: canonicalInversePlan.operations,
      checks: canonicalInversePlan.checks,
      diagnostics: canonicalInversePlan.diagnostics,
    }) !==
    canonicalPlanningString({
      operations: savedPlan.operations,
      checks: savedPlan.checks,
      diagnostics: savedPlan.diagnostics,
    })
  ) {
    return err(
      stale(
        'apply-saved-inverse-projection',
        'remapped operations do not exactly reproject to the saved authorization',
      ),
    );
  }

  const manifestByteHash = hashManifestBytes(manifestRead.value.source);
  const guards: ResourcePreconditionV1[] = [];
  for (const candidate of runtimeSavedPlan.resourcePreconditions) {
    const precondition = jsonValue(candidate) as unknown as ResourcePreconditionV1;
    if (precondition.resource.kind === 'manifest-bytes') {
      guards.push({
        ...precondition,
        expectedHash:
          precondition.expectedHash.domain === 'manifest-bytes'
            ? { ...precondition.expectedHash, digest: manifestByteHash }
            : precondition.expectedHash.domain === 'manifest-semantic'
              ? {
                  ...precondition.expectedHash,
                  digest: manifestRead.value.semanticRevision,
                }
              : precondition.expectedHash,
        expectedRevision: { kind: 'artifact-bytes', digest: manifestRead.value.byteRevision },
      });
    } else if (precondition.resource.kind === 'lock') {
      const currentLockHash =
        lockRead.value.state === 'present'
          ? hashPortableLock(lockRead.value.model)
          : hashCanonicalInput('lock-canonical', 1, 'absent');
      if (!currentLockHash.ok) {
        return err(stale('apply-saved-lock-canonical', 'current lock fact could not be hashed'));
      }
      guards.push({
        ...precondition,
        expectedHash: { ...precondition.expectedHash, digest: currentLockHash.value },
        expectedRevision:
          lockRead.value.state === 'present'
            ? { kind: 'artifact-bytes', digest: lockRead.value.byteRevision }
            : null,
      });
    } else {
      guards.push(precondition);
    }
  }
  return ok(
    deepFreeze({
      savedPlan,
      plan,
      pair: pair.value,
      selectionOutcome: artifactAuthorization.value.facts.selectionOutcome,
      resolvedTokens: new ImmutableReadonlyMap(resolvedTokens),
      guards: {
        resourcePreconditions: guards,
        selectionPreconditions: runtimeSavedPlan.selectionPreconditions.map(
          (value) => jsonValue(value) as unknown as SelectionPreconditionV1,
        ),
        capabilityPreconditions: runtimeSavedPlan.capabilityPreconditions.map(
          (value) => jsonValue(value) as unknown as CapabilityPreconditionV1,
        ),
      },
    }),
  );
};

/** Decode one strict v1 plan artifact and preserve its exact source envelope before validation. */
export const validateSavedReconcilePlan = async (
  request: Readonly<ValidateSavedReconcilePlanRequest>,
  runtime: Readonly<ValidateSavedReconcilePlanRuntime>,
): Promise<Result<ValidatedSavedReconcilePlan, PlanReconcileError>> => {
  if (runtime.signal?.aborted) return err(savedCancelled());
  const artifact = await readSavedPlanArtifact(runtime.ports, request.planPath);
  if (runtime.signal?.aborted) return err(savedCancelled());
  if (!artifact.ok) return err(artifactReadError('saved plan', artifact.error));
  if (artifact.value.state !== 'present') {
    return err(stale('apply-saved-artifact', 'saved plan is absent'));
  }
  const validated = await validateSavedReconcilePlanValue(artifact.value.model, runtime);
  return validated.ok
    ? ok(deepFreeze({ ...validated.value, artifact: artifact.value }))
    : validated;
};

/**
 * Prepare the one immutable reconciliation product shared by plan and fresh apply.
 *
 * Callers own command grammar and presentation. This use case owns artifact selection,
 * observation, source resolution, reconciliation planning, and the saved-plan projection so the
 * preview and executor cannot reconstruct or drift from the signed plan pipeline.
 */
export const prepareReconcilePlan = async (
  request: Readonly<PrepareReconcilePlanRequest>,
  runtime: Readonly<PrepareReconcilePlanRuntime>,
): Promise<Result<PreparedReconcilePlan, PlanReconcileError>> => {
  if (runtime.signal?.aborted) return err(cancelled());

  const project =
    runtime.projectContext === undefined
      ? await resolveProjectContext(runtime.ports, {
          invocationCwd: runtime.invocationCwd,
          ...(runtime.cd === undefined ? {} : { cd: runtime.cd }),
          ...(runtime.explicitConfigPath === undefined
            ? {}
            : { explicitConfigPath: runtime.explicitConfigPath }),
        })
      : { ok: true as const, value: runtime.projectContext };
  if (runtime.signal?.aborted) return err(cancelled());
  if (!project.ok) {
    return err({
      code: 'plan-project-context',
      message: errorMessage(project.error),
      exitClass: 'state',
    });
  }

  const readable = selectReadableArtifactContext(runtime.ports, project.value, {
    ...(request.file === undefined ? {} : { explicitFile: request.file }),
    scope: request.scope,
  });
  if (readable.state === 'unselected') {
    return err({
      code: 'plan-artifact-unselected',
      message: 'plan requires one user or project artifact pair',
      exitClass: 'usage',
    });
  }

  const pair = await resolveArtifactPair(
    runtime.ports,
    project.value,
    readable.source === 'explicit'
      ? {
          file: request.file as string,
          ...(request.lockfile === undefined ? {} : { lockfile: request.lockfile }),
        }
      : { discoveredFile: readable.file },
  );
  if (runtime.signal?.aborted) return err(cancelled());
  if (!pair.ok) return err(pair.error);

  const observed = await observePlanArtifacts(runtime.ports, project.value, pair.value, {
    ledgerPath: ledgerPathOf(resolveDataDir(runtime.ports, runtime.configuration)),
    ...(readable.source === 'user-default'
      ? {
          artifactPortableTokens: {
            manifest: 'user:skillsmith.toml',
            lock: 'user:skillsmith.lock',
          },
        }
      : {}),
  });
  if (runtime.signal?.aborted) return err(cancelled());
  if (!observed.ok) return observed;

  const resolved = await resolvePlanInput(
    observed.value,
    {
      tools: request.tools,
      scope: request.scope,
      locked: request.locked,
      prune: request.prune,
      check: request.check,
    },
    {
      ports: runtime.ports,
      configuration: runtime.configuration,
      ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
    },
  );
  if (runtime.signal?.aborted) return err(cancelled());
  if (!resolved.ok) return resolved;

  const observation = await observeReconcileInput(resolved.value, {
    ports: runtime.ports,
    configuration: runtime.configuration,
    ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
  });
  if (runtime.signal?.aborted) return err(cancelled());
  if (!observation.ok) return observation;

  const planned = createReconcilePlan(observation.value);
  if (!planned.ok) return planned;
  const projection = createSavedPlanProjection(planned.value, observation.value);
  if (!projection.ok) return projection;

  return ok(
    Object.freeze({
      product: planned.value,
      projection: projection.value,
      observation: observation.value,
      artifactSelectionSource: readable.source,
    }),
  );
};
