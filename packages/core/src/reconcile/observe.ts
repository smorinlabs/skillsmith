import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  createRelevantCapabilitySnapshotV1,
  toCapabilityPreconditionsV1,
} from '../agents/capabilities.ts';
import { type Placement, classifyPlacement } from '../agents/placement-shared.ts';
import { toolRegistry } from '../agents/registry.ts';
import { normalizeSourceIdentity } from '../artifacts/identity.ts';
import type { LedgerModel, LedgerPairV1Dto } from '../artifacts/ledger-types.ts';
import { correlatePortableLock } from '../artifacts/lock.ts';
import type { ResolvedArtifactPair } from '../artifacts/pair.ts';
import {
  type ArtifactReadPorts,
  readLedgerArtifact,
  readLockArtifact,
  readManifestArtifact,
} from '../artifacts/repository.ts';
import { hashSourceContentV1, projectSourceContent } from '../artifacts/source-content.ts';
import type { ProjectContext } from '../context/types.ts';
import { resolveDataDir, storeRootOf } from '../place/paths.ts';
import { clampStoreNs } from '../place/store.ts';
import { canonicalPlanningString } from '../planning/order.ts';
import type { OperationDigest } from '../planning/types.ts';
import { isPortError } from '../ports/errors.ts';
import type {
  FileMetadataReadPort,
  InventoryReadPorts,
  ResolvedRuntimeConfiguration,
} from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';
import type {
  ObservedDesiredPlacement,
  ObservedPlacementEvidence,
  ObservedPlanArtifacts,
  ObservedPrunePlacement,
  ObservedReconcileInput,
  ObservedUndeclaredPlacement,
  PlanReconcileError,
  ResolvedPlanInput,
} from './types.ts';

type RefusedDesiredPlacement = Extract<ObservedDesiredPlacement, { readonly state: 'refused' }>;

const repositoryError = (error: {
  readonly reason: string;
  readonly message: string;
  readonly exitCode: number;
}): PlanReconcileError => ({
  code: `plan-${error.reason}`,
  message: error.message,
  exitClass: error.exitCode === 6 ? 'permission' : error.exitCode === 2 ? 'usage' : 'state',
});

export const observePlanArtifacts = async (
  ports: ArtifactReadPorts,
  project: ProjectContext,
  pair: ResolvedArtifactPair,
  options: Readonly<{
    readonly ledgerPath?: string;
    readonly artifactPortableTokens?: Readonly<{
      readonly manifest: string;
      readonly lock: string;
    }>;
  }> = {},
): Promise<Result<ObservedPlanArtifacts, PlanReconcileError>> => {
  const [manifest, lock, ledger] = await Promise.all([
    readManifestArtifact(ports, pair.file.path),
    readLockArtifact(ports, pair.lockfile.path),
    options.ledgerPath === undefined
      ? Promise.resolve(null)
      : readLedgerArtifact(ports, options.ledgerPath),
  ]);
  if (!manifest.ok) return err(repositoryError(manifest.error));
  if (!lock.ok) return err(repositoryError(lock.error));
  if (ledger !== null && !ledger.ok) return err(repositoryError(ledger.error));
  if (manifest.value.state === 'absent') {
    return err({
      code: 'plan-manifest-absent',
      message: 'the selected desired-state manifest does not exist',
      exitClass: 'state',
    });
  }
  const lockModel = lock.value.state === 'present' ? lock.value.model : null;
  return ok(
    Object.freeze({
      project,
      pair,
      manifest: manifest.value,
      lock: lock.value,
      relationship: correlatePortableLock(manifest.value.model, lockModel),
      ...(options.ledgerPath === undefined || ledger === null
        ? {}
        : { ledgerPath: options.ledgerPath, ledger: ledger.value }),
      ...(options.artifactPortableTokens === undefined
        ? {}
        : { artifactPortableTokens: { ...options.artifactPortableTokens } }),
    }),
  );
};

export interface ReconcileObservationRuntime {
  readonly ports: InventoryReadPorts & FileMetadataReadPort;
  readonly configuration: ResolvedRuntimeConfiguration;
  readonly signal?: AbortSignal;
  readonly operation?: 'plan' | 'update';
}

const cancellation = (): PlanReconcileError => ({
  code: 'plan-cancelled',
  message: 'plan observation was cancelled',
  exitClass: 'cancelled',
});

const isCancellation = (error: unknown, signal?: AbortSignal): boolean => {
  if (signal?.aborted) return true;
  if (error === null || typeof error !== 'object') return false;
  const code = Object.getOwnPropertyDescriptor(error, 'code');
  const name = Object.getOwnPropertyDescriptor(error, 'name');
  return Boolean(
    (code && 'value' in code && (code.value === 'cancelled' || code.value === 'ABORT_ERR')) ||
      (name && 'value' in name && name.value === 'AbortError'),
  );
};

const observationFailure = (
  error: unknown,
  signal: AbortSignal | undefined,
  code: string,
  message: string,
  fallback: PlanReconcileError['exitClass'] = 'state',
): PlanReconcileError => {
  if (isCancellation(error, signal)) return cancellation();
  return {
    code,
    message,
    exitClass: isPortError(error) && error.code === 'permission' ? 'permission' : fallback,
  };
};

const ownedPlacement = (placement: Placement): Placement =>
  Object.freeze({
    skill: placement.skill,
    root: placement.root,
    path: placement.path,
    class: placement.class,
    symlinkTarget: placement.symlinkTarget,
    dangling: placement.dangling,
  });

const refusedDesiredPlacement = (
  row: ResolvedPlanInput['declarations'][number],
  refusalClass: RefusedDesiredPlacement['refusalClass'],
  reasonCode: string,
  path: string | null,
  remediation: string,
  evidence: readonly ObservedPlacementEvidence[] = [],
): RefusedDesiredPlacement =>
  Object.freeze({
    state: 'refused',
    row,
    refusalClass,
    reasonCode,
    path,
    remediation,
    evidence: Object.freeze([...evidence]),
  });

const placementContentHash = async (
  ports: ReconcileObservationRuntime['ports'],
  placement: Placement,
  signal?: AbortSignal,
): Promise<Result<OperationDigest | null, PlanReconcileError>> => {
  if (signal?.aborted) return err(cancellation());
  if (placement.class === 'absent' || placement.dangling) return ok(null);
  try {
    const root =
      placement.class === 'dev' || placement.class === 'store-linked'
        ? await ports.realpath(placement.path)
        : placement.path;
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
        listDir: (path) => track(() => ports.listDir(path)),
        readBytes: (path) => track(() => ports.readBytes(path)),
        readLink: (path) => track(() => ports.readLink(path)),
        readFileMetadata: (path) => track(() => ports.readFileMetadata(path)),
      },
      root,
    );
    if (signal?.aborted) return err(cancellation());
    if (!projected.ok) {
      return err(
        observationFailure(readFailure, signal, 'plan-live-content', projected.error.message),
      );
    }
    const hashed = hashSourceContentV1(projected.value);
    return hashed.ok
      ? ok(hashed.value as OperationDigest)
      : err({ code: 'plan-live-content', message: hashed.error.message, exitClass: 'state' });
  } catch (error) {
    return err(
      observationFailure(
        error,
        signal,
        'plan-live-content',
        'live placement content could not be observed',
      ),
    );
  }
};

const placementEvidence = async (
  ports: ReconcileObservationRuntime['ports'],
  scope: 'user' | 'project',
  binding: 'standard' | 'custom',
  placement: Placement,
  ledgerPair: LedgerPairV1Dto | null,
  signal?: AbortSignal,
): Promise<Result<ObservedPlacementEvidence, PlanReconcileError>> => {
  const contentHash = await placementContentHash(ports, placement, signal);
  if (!contentHash.ok) return contentHash;
  return ok(
    Object.freeze({
      scope,
      binding,
      placement,
      contentHash: contentHash.value,
      ledgerPair,
    }),
  );
};

const ledgerPairAt = (
  ledger: LedgerModel | null,
  projectRoot: string | null,
  skill: string,
  tool: string,
): LedgerPairV1Dto | null => {
  if (ledger === null) return null;
  const skills = projectRoot === null ? ledger.skills : ledger.projects[projectRoot]?.skills;
  return skills?.[skill]?.tools[tool] ?? null;
};

const ledgerPairMatchesDesiredSource = (
  pair: LedgerPairV1Dto | null,
  row: ResolvedPlanInput['declarations'][number],
  placementPath: string,
  storePath: string,
  representation: 'symlink' | 'copy',
): boolean => {
  if (
    pair === null ||
    pair.mode !== 'pinned' ||
    pair.pinned == null ||
    pair.origin === undefined ||
    pair.journal != null ||
    pair.placementPath !== placementPath ||
    resolve(pair.pinned.storePath) !== resolve(storePath) ||
    (pair.pinned.placement ?? 'copy') !== representation ||
    pair.origin.host !== row.declaration.source.host ||
    pair.origin.repo !== row.declaration.source.repository ||
    pair.origin.skillPath !== row.lock.sourcePath ||
    pair.origin.refRequested !== row.lock.requestedRef ||
    pair.origin.refResolved !== row.lock.resolvedSha ||
    (pair.pinned.gitSha !== null && pair.pinned.gitSha !== row.lock.resolvedSha)
  ) {
    return false;
  }
  const originIdentity = normalizeSourceIdentity(pair.origin.source, 'plan.ledger.origin');
  return (
    originIdentity.ok &&
    canonicalPlanningString(originIdentity.value) ===
      canonicalPlanningString(row.declaration.source)
  );
};

const projectRootForScope = (
  input: ResolvedPlanInput,
  scope: 'user' | 'project',
): string | null | undefined =>
  scope === 'user' ? null : (input.observed.project.projectRoot ?? undefined);

const placementCwdForScope = (input: ResolvedPlanInput, scope: 'user' | 'project'): string =>
  scope === 'project'
    ? (input.observed.project.projectRoot ?? input.observed.project.effectiveCwd)
    : input.observed.project.effectiveCwd;

const storePathFor = (
  storeRoot: string,
  row: ResolvedPlanInput['declarations'][number],
): string => {
  const identity = clampStoreNs(row.declaration.source.repository);
  return join(
    storeRoot,
    identity.ns,
    `${identity.name}@${row.lock.resolvedSha.slice(0, 12)}`,
    row.declaration.name,
  );
};

const customRootFor = (
  input: ResolvedPlanInput,
  row: ResolvedPlanInput['declarations'][number],
  ports: ReconcileObservationRuntime['ports'],
): string | null => {
  const path = row.declaration.path;
  if (path === null) return null;
  if (path.startsWith('~/')) return resolve(ports.homeDir, path.slice(2));
  if (path.startsWith('./')) {
    return resolve(
      row.declaration.scope === 'project'
        ? (input.observed.project.projectRoot ?? input.observed.project.effectiveCwd)
        : input.observed.project.effectiveCwd,
      path.slice(2),
    );
  }
  return isAbsolute(path)
    ? resolve(path)
    : resolve(placementCwdForScope(input, row.declaration.scope), path);
};

const observeStore = async (
  ports: ReconcileObservationRuntime['ports'],
  path: string,
  signal?: AbortSignal,
): Promise<
  Result<
    Readonly<{
      path: string;
      state: 'absent' | 'present' | 'invalid';
      contentHash: OperationDigest | null;
    }>,
    PlanReconcileError
  >
> => {
  if (signal?.aborted) return err(cancellation());
  try {
    const kind = await ports.pathKind(path);
    if (kind === 'absent') return ok(Object.freeze({ path, state: 'absent', contentHash: null }));
    if (kind !== 'dir' && kind !== 'symlink') {
      return ok(Object.freeze({ path, state: 'invalid', contentHash: null }));
    }
    const placement: Placement = {
      skill: '',
      root: path,
      path,
      class: kind === 'symlink' ? 'store-linked' : 'pinned',
      symlinkTarget: kind === 'symlink' ? await ports.readLink(path) : null,
      dangling: false,
    };
    const content = await placementContentHash(ports, placement, signal);
    if (!content.ok) return content;
    return ok(Object.freeze({ path, state: 'present', contentHash: content.value }));
  } catch (error) {
    return err(
      observationFailure(
        error,
        signal,
        'plan-store-content',
        'store content could not be observed',
      ),
    );
  }
};

/**
 * Owns every environment-dependent read needed for desired/current reconciliation.
 * The returned value is sufficient for createReconcilePlan to run synchronously.
 */
export const observeReconcileInput = async (
  resolved: ResolvedPlanInput,
  runtime: ReconcileObservationRuntime,
): Promise<Result<ObservedReconcileInput, PlanReconcileError>> => {
  if (runtime.signal?.aborted) return err(cancellation());
  const storeRoot = storeRootOf(resolveDataDir(runtime.ports, runtime.configuration));
  const operation = runtime.operation ?? 'plan';
  const ledger =
    resolved.observed.ledger?.state === 'present' ? resolved.observed.ledger.model : null;
  const desiredPlacements: ObservedDesiredPlacement[] = [];
  const selectedPairs = [
    ...new Map(
      resolved.declarations.map((row) => [
        `${row.tool}\0${row.declaration.scope}`,
        { tool: row.tool, scope: row.declaration.scope },
      ]),
    ).values(),
  ].sort((left, right) =>
    `${left.tool}\0${left.scope}`.localeCompare(`${right.tool}\0${right.scope}`),
  );

  for (const row of resolved.declarations) {
    if (runtime.signal?.aborted) return err(cancellation());
    const capability = toolRegistry.capability(row.tool, operation);
    if ('code' in capability) {
      if (capability.code === 'usage') {
        return err({ code: capability.code, message: capability.message, exitClass: 'usage' });
      }
      desiredPlacements.push(
        refusedDesiredPlacement(
          row,
          'capability',
          'plan-capability-unavailable',
          null,
          capability.remediation,
        ),
      );
      continue;
    }
    const adapter = toolRegistry.get(row.tool);
    if (adapter?.placement === undefined) {
      desiredPlacements.push(
        refusedDesiredPlacement(
          row,
          'capability',
          'plan-placement-adapter-unavailable',
          null,
          `${row.tool} has no planner placement adapter`,
        ),
      );
      continue;
    }
    // A scope the tool does not manage (muse in project scope) refuses like
    // a missing adapter: resolving would throw the no-destination invariant.
    if (
      adapter.placement.rootFacts(runtime.ports, row.declaration.scope, {
        cwd: placementCwdForScope(resolved, row.declaration.scope),
        configuration: runtime.configuration,
      }).length === 0
    ) {
      desiredPlacements.push(
        refusedDesiredPlacement(
          row,
          'capability',
          'plan-placement-scope-unsupported',
          null,
          `${row.tool} does not manage ${row.declaration.scope} scope`,
        ),
      );
      continue;
    }
    try {
      const customRoot = customRootFor(resolved, row, runtime.ports);
      const standardResolution = await adapter.placement.resolveScoped(
        runtime.ports,
        {
          cwd: placementCwdForScope(resolved, row.declaration.scope),
          configuration: runtime.configuration,
        },
        storeRoot,
        row.declaration.name,
        row.declaration.scope,
      );
      const customPlacement =
        customRoot === null
          ? null
          : await classifyPlacement(runtime.ports, customRoot, row.declaration.name, storeRoot);
      const standardShadowsCustom =
        customPlacement !== null &&
        standardResolution.placement.path !== customPlacement.path &&
        standardResolution.placement.class !== 'absent';
      const resolution =
        customPlacement === null
          ? standardResolution
          : {
              placement: customPlacement,
              notices: [],
              duplicateReason:
                standardResolution.duplicateReason ??
                (standardShadowsCustom
                  ? `found a standard placement at ${standardResolution.placement.path}; resolve the custom-target ambiguity first`
                  : null),
            };
      if (runtime.signal?.aborted) return err(cancellation());
      if (resolution.duplicateReason !== null) {
        const scopeProjectRoot = projectRootForScope(resolved, row.declaration.scope);
        const ledgerPair =
          scopeProjectRoot === undefined
            ? null
            : ledgerPairAt(ledger, scopeProjectRoot, row.declaration.name, row.tool);
        const evidence: ObservedPlacementEvidence[] = [];
        const candidates =
          customPlacement === null
            ? (
                await adapter.placement.listScoped(
                  runtime.ports,
                  {
                    cwd: placementCwdForScope(resolved, row.declaration.scope),
                    configuration: runtime.configuration,
                  },
                  storeRoot,
                  row.declaration.scope,
                )
              ).placements.filter(
                (item) => item.skill === row.declaration.name && item.class !== 'absent',
              )
            : [customPlacement, standardResolution.placement].filter(
                (item) => item.class !== 'absent',
              );
        for (const candidate of candidates) {
          const observedEvidence = await placementEvidence(
            runtime.ports,
            row.declaration.scope,
            candidate.path === customPlacement?.path ? 'custom' : 'standard',
            ownedPlacement(candidate),
            ledgerPair,
            runtime.signal,
          );
          if (!observedEvidence.ok) return observedEvidence;
          evidence.push(observedEvidence.value);
        }
        desiredPlacements.push(
          refusedDesiredPlacement(
            row,
            'state',
            'plan-placement-ambiguous',
            resolution.placement.path,
            resolution.duplicateReason,
            evidence,
          ),
        );
        continue;
      }
      const placement = ownedPlacement(resolution.placement);
      const contentHash = await placementContentHash(runtime.ports, placement, runtime.signal);
      if (!contentHash.ok) return contentHash;
      const scopeProjectRoot = projectRootForScope(resolved, row.declaration.scope);
      const ledgerPair =
        scopeProjectRoot === undefined
          ? null
          : ledgerPairAt(ledger, scopeProjectRoot, row.declaration.name, row.tool);
      const store = await observeStore(runtime.ports, storePathFor(storeRoot, row), runtime.signal);
      if (!store.ok) return store;
      const ledgerStore =
        ledgerPair?.pinned?.storePath === undefined
          ? null
          : await observeStore(runtime.ports, ledgerPair.pinned.storePath, runtime.signal);
      if (ledgerStore !== null && !ledgerStore.ok) return ledgerStore;
      const oppositeScope = row.declaration.scope === 'user' ? 'project' : 'user';
      const oppositeProjectRoot = projectRootForScope(resolved, oppositeScope);
      let opposite: Extract<ObservedDesiredPlacement, { state: 'observed' }>['opposite'] = null;
      const oppositePair =
        oppositeProjectRoot === undefined
          ? null
          : ledgerPairAt(ledger, oppositeProjectRoot, row.declaration.name, row.tool);
      if (placement.class === 'absent') {
        const oppositeResolution = await adapter.placement.resolveScoped(
          runtime.ports,
          {
            cwd: placementCwdForScope(resolved, oppositeScope),
            configuration: runtime.configuration,
          },
          storeRoot,
          row.declaration.name,
          oppositeScope,
        );
        const oppositeLedgerPlacement =
          oppositePair !== null &&
          basename(oppositePair.placementPath) === row.declaration.name &&
          oppositePair.placementPath !== oppositeResolution.placement.path
            ? ownedPlacement(
                await classifyPlacement(
                  runtime.ports,
                  dirname(oppositePair.placementPath),
                  row.declaration.name,
                  storeRoot,
                ),
              )
            : null;
        const ledgerCustomShadowsStandard =
          oppositeLedgerPlacement !== null &&
          oppositeLedgerPlacement.class !== 'absent' &&
          oppositeResolution.placement.class !== 'absent' &&
          oppositeLedgerPlacement.path !== oppositeResolution.placement.path;
        const oppositeDuplicateReason =
          oppositeResolution.duplicateReason ??
          (ledgerCustomShadowsStandard
            ? 'found both standard and ledger-owned custom opposite-scope placements; resolve the ambiguity first'
            : null);
        if (oppositeDuplicateReason !== null) {
          const inventory = await adapter.placement.listScoped(
            runtime.ports,
            {
              cwd: placementCwdForScope(resolved, oppositeScope),
              configuration: runtime.configuration,
            },
            storeRoot,
            oppositeScope,
          );
          const evidence: ObservedPlacementEvidence[] = [
            Object.freeze({
              scope: row.declaration.scope,
              binding: customRoot === null ? 'standard' : 'custom',
              placement,
              contentHash: contentHash.value,
              ledgerPair,
            }),
          ];
          const candidates = [
            ...inventory.placements.filter(
              (item) => item.skill === row.declaration.name && item.class !== 'absent',
            ),
            ...(oppositeLedgerPlacement === null || oppositeLedgerPlacement.class === 'absent'
              ? []
              : [oppositeLedgerPlacement]),
          ].filter(
            (candidate, index, items) =>
              items.findIndex((item) => item.path === candidate.path) === index,
          );
          for (const candidate of candidates) {
            const observedEvidence = await placementEvidence(
              runtime.ports,
              oppositeScope,
              candidate.path === oppositeLedgerPlacement?.path ? 'custom' : 'standard',
              ownedPlacement(candidate),
              oppositePair,
              runtime.signal,
            );
            if (!observedEvidence.ok) return observedEvidence;
            evidence.push(observedEvidence.value);
          }
          desiredPlacements.push(
            refusedDesiredPlacement(
              row,
              'state',
              'plan-opposite-placement-ambiguous',
              oppositeLedgerPlacement?.path ?? oppositeResolution.placement.path,
              oppositeDuplicateReason,
              evidence,
            ),
          );
          continue;
        }
        const oppositeBinding =
          oppositeLedgerPlacement !== null && oppositeLedgerPlacement.class !== 'absent'
            ? 'custom'
            : 'standard';
        const oppositePlacement =
          oppositeBinding === 'custom'
            ? oppositeLedgerPlacement
            : ownedPlacement(oppositeResolution.placement);
        if (oppositePlacement === null) {
          throw new Error('opposite placement selection invariant failed');
        }
        if (oppositePlacement.class !== 'absent') {
          const oppositeEvidence = await placementEvidence(
            runtime.ports,
            oppositeScope,
            oppositeBinding,
            oppositePlacement,
            oppositePair,
            runtime.signal,
          );
          if (!oppositeEvidence.ok) return oppositeEvidence;
          const evidence = Object.freeze([
            Object.freeze({
              scope: row.declaration.scope,
              binding: customRoot === null ? 'standard' : 'custom',
              placement,
              contentHash: contentHash.value,
              ledgerPair,
            }),
            oppositeEvidence.value,
          ]);
          const unmanaged = oppositePair === null || oppositePlacement.class === 'dev';
          const sourceChanged =
            !unmanaged &&
            !ledgerPairMatchesDesiredSource(
              oppositePair,
              row,
              oppositePlacement.path,
              store.value.path,
              oppositePlacement.class === 'store-linked' ? 'symlink' : 'copy',
            );
          const modified =
            !unmanaged &&
            !sourceChanged &&
            oppositeEvidence.value.contentHash !== row.lock.contentHash;
          if (unmanaged || sourceChanged || modified || oppositePlacement.dangling) {
            const reasonCode = unmanaged
              ? 'plan-opposite-placement-unmanaged'
              : sourceChanged
                ? 'plan-opposite-placement-source-changed'
                : 'plan-opposite-placement-modified';
            desiredPlacements.push(
              refusedDesiredPlacement(
                row,
                'state',
                reasonCode,
                oppositePlacement.path,
                unmanaged
                  ? `an unmanaged opposite-scope placement exists at ${oppositePlacement.path}`
                  : sourceChanged
                    ? `an opposite-scope placement at ${oppositePlacement.path} is owned by different source state`
                    : `an opposite-scope placement at ${oppositePlacement.path} differs from its signed content`,
                evidence,
              ),
            );
            continue;
          }
          opposite = Object.freeze({
            scope: oppositeScope,
            binding: oppositeBinding,
            placement: oppositePlacement,
            contentHash: oppositeEvidence.value.contentHash,
            ledgerPair: oppositePair,
          });
        }
      }
      desiredPlacements.push(
        Object.freeze({
          state: 'observed',
          row,
          binding: customRoot === null ? 'standard' : 'custom',
          placement,
          contentHash: contentHash.value,
          ledgerPair,
          store: store.value,
          ledgerStore: ledgerStore?.value ?? null,
          opposite,
        }),
      );
    } catch (error) {
      return err(
        observationFailure(
          error,
          runtime.signal,
          'plan-observation-failed',
          error instanceof Error ? error.message : 'placement observation failed',
          'failure',
        ),
      );
    }
  }

  const undeclaredPlacements: ObservedUndeclaredPlacement[] = [];
  for (const { tool, scope } of selectedPairs) {
    if (runtime.signal?.aborted) return err(cancellation());
    const adapter = toolRegistry.get(tool);
    if (adapter?.placement === undefined) continue;
    const declaredNames = new Set(
      resolved.declarations
        .filter((row) => row.tool === tool && row.declaration.scope === scope)
        .map((row) => row.declaration.name),
    );
    try {
      const inventory = await adapter.placement.listScoped(
        runtime.ports,
        { cwd: placementCwdForScope(resolved, scope), configuration: runtime.configuration },
        storeRoot,
        scope,
      );
      for (const item of inventory.placements) {
        if (item.class === 'absent' || declaredNames.has(item.skill)) continue;
        const placement = ownedPlacement(item);
        const root = projectRootForScope(resolved, scope);
        undeclaredPlacements.push(
          Object.freeze({
            tool,
            scope,
            placement,
            ledgerPair:
              root === undefined ? null : ledgerPairAt(ledger, root, placement.skill, tool),
          }),
        );
      }
    } catch (error) {
      return err(
        observationFailure(
          error,
          runtime.signal,
          'plan-undeclared-observation',
          error instanceof Error ? error.message : 'undeclared placement observation failed',
          'failure',
        ),
      );
    }
  }

  const prunePlacements: ObservedPrunePlacement[] = [];
  if (
    resolved.request.prune &&
    resolved.selectionOutcome === 'selected' &&
    resolved.observed.manifest.model.skills.length > 0 &&
    resolved.observed.lock.state === 'present'
  ) {
    if (runtime.signal?.aborted) return err(cancellation());
    const desiredNames = new Set(
      resolved.observed.manifest.model.skills.map((skill) => skill.name),
    );
    const removedPins = resolved.observed.lock.model.skills.filter(
      (pin) => !desiredNames.has(pin.name),
    );
    for (const { tool, scope } of selectedPairs) {
      const adapter = toolRegistry.get(tool);
      if (adapter?.placement === undefined) continue;
      // A scope the tool does not manage holds no prunable placements.
      if (
        adapter.placement.rootFacts(runtime.ports, scope, {
          cwd: placementCwdForScope(resolved, scope),
          configuration: runtime.configuration,
        }).length === 0
      ) {
        continue;
      }
      for (const pin of removedPins) {
        try {
          if (runtime.signal?.aborted) return err(cancellation());
          const resolution = await adapter.placement.resolveScoped(
            runtime.ports,
            { cwd: placementCwdForScope(resolved, scope), configuration: runtime.configuration },
            storeRoot,
            pin.name,
            scope,
          );
          const placement = ownedPlacement(resolution.placement);
          let contentHash: OperationDigest | null = null;
          if (
            resolution.duplicateReason === null &&
            placement.class !== 'absent' &&
            placement.class !== 'dev' &&
            !placement.dangling
          ) {
            const observedContent = await placementContentHash(
              runtime.ports,
              placement,
              runtime.signal,
            );
            if (!observedContent.ok) return observedContent;
            contentHash = observedContent.value;
          }
          prunePlacements.push(
            Object.freeze({
              pin,
              tool,
              scope,
              placement,
              duplicateReason: resolution.duplicateReason,
              contentHash,
              ledgerPair: (() => {
                const root = projectRootForScope(resolved, scope);
                return root === undefined ? null : ledgerPairAt(ledger, root, pin.name, tool);
              })(),
            }),
          );
        } catch (error) {
          return err(
            observationFailure(
              error,
              runtime.signal,
              'plan-prune-observation',
              error instanceof Error ? error.message : 'prune observation failed',
              'failure',
            ),
          );
        }
      }
    }
  }

  const capabilityPreconditions = toCapabilityPreconditionsV1(
    createRelevantCapabilitySnapshotV1(
      toolRegistry,
      selectedPairs.map(({ tool, scope }) => ({
        schemaVersion: 1 as const,
        tool,
        operation,
        scope,
      })),
    ),
  );

  return ok(
    Object.freeze({
      resolved,
      storeRoot,
      desiredPlacements: Object.freeze(desiredPlacements),
      undeclaredPlacements: Object.freeze(undeclaredPlacements),
      prunePlacements: Object.freeze(prunePlacements),
      capabilityPreconditions,
    }),
  );
};
