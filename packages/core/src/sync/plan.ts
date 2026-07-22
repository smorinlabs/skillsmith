import { join } from 'node:path';
import { type BuiltInToolId, FLIP_TOOLS, type PlacementToolId } from '../agents/registry.ts';
import type { SupportedTool } from '../agents/types.ts';
import type { PlacementSnapshotAuthority } from '../place/execute.ts';
import {
  type PairPlan,
  type PlacementSyncIntentV1,
  type PlacementSyncPlanRequestV1,
  createPlacementPlan,
} from '../place/plan.ts';
import type { SnapshotBoundOperationPlanV1, SnapshotPlanningErrorV1 } from '../planning/create.ts';
import type {
  ExecutableOperation,
  OperationSelection,
  PlanningDiagnostic,
  PlanningToolContext,
} from '../planning/types.ts';
import { type Result, err, ok } from '../result.ts';
import {
  type ObservedStateSnapshotV1,
  createContentObservationIdentityV1,
} from '../state/types.ts';
import type {
  SyncFleetObservation,
  SyncMemberObservation,
  SyncObservationFailure,
} from './types.ts';

export type SyncPlacementIntentV1 = PlacementSyncIntentV1;

export interface SyncPlanRequestV1<ToolId extends string = SupportedTool> {
  readonly schemaVersion: 1;
  readonly selection: OperationSelection<ToolId>;
  readonly batchPolicy: 'fail-fast' | 'continue-on-error';
  readonly force: boolean;
  readonly intents: readonly PlacementSyncIntentV1[];
  readonly diagnostics?: readonly PlanningDiagnostic<ToolId>[];
  readonly compatibilityOperations?: readonly ExecutableOperation<ToolId>[];
}

/**
 * Pure sync projection. It intentionally delegates operation construction, semantic IDs,
 * canonical ordering, checks, diagnostics, and snapshot binding to the shared placement planner.
 */
export const createSyncPlan = <ToolId extends string = SupportedTool>(
  request: SyncPlanRequestV1<ToolId>,
  snapshot: ObservedStateSnapshotV1<unknown>,
  planningContext?: PlanningToolContext<ToolId>,
): Result<SnapshotBoundOperationPlanV1<'sync', ToolId>, SnapshotPlanningErrorV1> => {
  const placementRequest: PlacementSyncPlanRequestV1 = {
    schemaVersion: request.schemaVersion,
    command: 'sync',
    selection: request.selection as OperationSelection,
    batchPolicy: request.batchPolicy,
    force: request.force,
    intents: request.intents,
    ...(request.diagnostics === undefined
      ? {}
      : { diagnostics: request.diagnostics as readonly PlanningDiagnostic[] }),
    ...(request.compatibilityOperations === undefined
      ? {}
      : {
          compatibilityOperations:
            request.compatibilityOperations as readonly ExecutableOperation[],
        }),
  };
  const projected = createPlacementPlan(
    placementRequest,
    snapshot,
    planningContext as PlanningToolContext<string> | undefined,
  );
  if (!projected.ok) return err(projected.error);
  return ok(projected.value as SnapshotBoundOperationPlanV1<'sync', ToolId>);
};

export interface SyncFleetPlanOptionsV1 {
  readonly targets: readonly string[];
  readonly delete: boolean;
  readonly continueOnError: boolean;
  readonly save: boolean;
  readonly force: boolean;
}

/** Runtime bindings produced while materializing the selector-owned store descriptors. */
export interface SyncFleetStoreBindingsV1 {
  /** Exact selected pair key to authority store resource ID; content-only lookup is forbidden. */
  readonly storeResourceIdsByPair: Readonly<Record<string, string>>;
  /** Exact selected pair key to its artifact-prefix dependencies; skill-only lookup is ambiguous. */
  readonly artifactPrefixOperationIdsByPair?: Readonly<Record<string, readonly string[]>>;
  readonly compatibilityOperations?: readonly ExecutableOperation<BuiltInToolId>[];
}

export interface SyncFleetSelectedStoreV1 {
  readonly bindingKey: string;
  readonly skill: string;
  readonly tool: PlacementToolId;
  readonly sourcePath: string;
  readonly contentHash: `sha256:${string}`;
}

export interface SyncFleetSelectedPairV1 {
  readonly bindingKey: string;
  readonly action: 'converge' | 'remove';
  readonly pair: PairPlan;
  readonly source: SyncMemberObservation | null;
  readonly destination: SyncMemberObservation | null;
  readonly operationSource: PlacementSyncIntentV1['source'];
  readonly sourceContent?: NonNullable<PlacementSyncIntentV1['sourceContent']>;
  readonly store: SyncFleetSelectedStoreV1 | null;
  readonly representation: 'symlink' | 'copy';
  readonly groupIdentityTarget: string;
}

/** One immutable selector result used both to create snapshot authority and to project the plan. */
export interface SyncFleetResourceSelectionV1 {
  readonly schemaVersion: 1;
  readonly options: Readonly<SyncFleetPlanOptionsV1>;
  readonly destinationEndpointIdentity: string;
  readonly tools: readonly BuiltInToolId[];
  readonly scope: 'user' | 'project';
  readonly projectRoot: Readonly<{ readonly kind: 'machine-bound'; readonly path: string }> | null;
  readonly pairs: readonly SyncFleetSelectedPairV1[];
  readonly stores: readonly SyncFleetSelectedStoreV1[];
  readonly sourceMembership: NonNullable<PlacementSyncIntentV1['membershipContent']>[0];
  readonly destinationMembership: NonNullable<PlacementSyncIntentV1['membershipContent']>[1];
  readonly sourceMembershipHash: SyncFleetObservation['source']['membershipHash'];
  readonly destinationMembershipHash: SyncFleetObservation['destination']['membershipHash'];
}

export interface SyncFleetPlannedPairV1 {
  readonly skill: string;
  readonly tool: BuiltInToolId;
  readonly liveResourceId: string;
  readonly storeResourceId: string | null;
  readonly source: SyncMemberObservation | null;
  readonly destination: SyncMemberObservation | null;
}

export interface SyncFleetPlanProjectionV1 {
  readonly request: SyncPlanRequestV1<BuiltInToolId>;
  readonly pairs: readonly SyncFleetPlannedPairV1[];
  readonly sourceMembershipHash: SyncFleetObservation['source']['membershipHash'];
  readonly destinationMembershipHash: SyncFleetObservation['destination']['membershipHash'];
}

const projectionFailure = (
  code: string,
  message: string,
  exitClass: SyncObservationFailure['exitClass'] = 'state',
): Result<never, SyncObservationFailure> => err(Object.freeze({ code, message, exitClass }));

const wildcardPattern = (target: string): RegExp => {
  const escaped = target.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/gu, '.*').replace(/\?/gu, '.')}$`, 'u');
};

const selectedMember = (member: SyncMemberObservation): boolean =>
  member.entry.visibility.state === 'unique';

const memberKey = (member: SyncMemberObservation): string =>
  `${member.entry.tool}\0${member.entry.name}`;

const selectedSourceMembers = (
  fleet: SyncFleetObservation,
  targets: readonly string[],
): Result<readonly SyncMemberObservation[], SyncObservationFailure> => {
  if (fleet.source.entries.some(({ entry }) => entry.visibility.state !== 'unique')) {
    return projectionFailure(
      'sync-source-ambiguous',
      'sync source contains an ambiguous selected identity',
      'usage',
    );
  }
  const visible = fleet.source.entries.filter(selectedMember);
  if (targets.length === 0) return ok(Object.freeze(visible));
  const patterns = [...new Set(targets)].map(wildcardPattern);
  return ok(
    Object.freeze(
      visible.filter(({ entry }) => patterns.some((pattern) => pattern.test(entry.name))),
    ),
  );
};

export const syncFleetStorePairKeyV1 = (member: SyncMemberObservation): string =>
  JSON.stringify([
    member.entry.tool,
    member.entry.name,
    member.entry.realpath,
    member.liveContentHash,
  ]);

const portableGroupIdentity = (member: SyncMemberObservation): string | null => {
  if (member.portable.outcome !== 'portable') return null;
  const candidate = member.portable.candidate;
  return JSON.stringify([
    candidate.name,
    candidate.scope,
    candidate.source,
    candidate.requestedRef,
    candidate.resolvedSha,
    candidate.sourcePath,
    candidate.contentHash,
    candidate.placement,
    candidate.path,
  ]);
};

const validatePortableGroups = (
  members: readonly SyncMemberObservation[],
): Result<void, SyncObservationFailure> => {
  const bySkill = new Map<string, SyncMemberObservation[]>();
  for (const member of members) {
    const group = bySkill.get(member.entry.name) ?? [];
    group.push(member);
    bySkill.set(member.entry.name, group);
  }
  for (const group of bySkill.values()) {
    const identities = group.map(portableGroupIdentity);
    if (identities.some((identity) => identity === null) || new Set(identities).size !== 1) {
      return projectionFailure(
        'sync-source-portable-group-conflict',
        'selected sync tool members do not collapse to one portable declaration',
        'usage',
      );
    }
  }
  return ok(undefined);
};

const operationSourceFor = (
  member: SyncMemberObservation,
  save: boolean,
): Result<PlacementSyncIntentV1['source'], SyncObservationFailure> => {
  const contentHash = member.liveContentHash;
  if (contentHash === null) {
    return projectionFailure(
      'sync-source-content-unavailable',
      'sync source content is unavailable',
    );
  }
  if (!save) {
    return {
      ok: true,
      value: {
        kind: 'local-dev',
        path: member.entry.realpath,
        contentHash: contentHash as `sha256:${string}`,
      },
    };
  }
  if (member.portable.outcome !== 'portable') {
    return projectionFailure(
      'sync-source-nonportable',
      'sync save requires exact portable source proof',
      'usage',
    );
  }
  const candidate = member.portable.candidate;
  if (!candidate.tools.includes(member.entry.tool)) {
    return projectionFailure(
      'sync-source-portable-tool-mismatch',
      'sync portable proof differs from the selected tool member',
    );
  }
  return {
    ok: true,
    value: {
      kind: 'portable',
      identity: {
        host: candidate.source.host,
        repository: candidate.source.repository,
        path: candidate.source.path,
      },
      requestedRef: candidate.requestedRef,
      resolvedSha: candidate.resolvedSha,
      sourcePath: candidate.sourcePath,
      // Placement/store identity retains the existing live-tree digest domain. The portable
      // candidate separately carries the exact source-content digest used by manifest/lock state.
      contentHash: contentHash as `sha256:${string}`,
    },
  };
};

const membershipContentFor = (role: 'source' | 'destination', fleet: SyncFleetObservation) => {
  const observed = role === 'source' ? fleet.source : fleet.destination;
  const endpoint = role === 'source' ? fleet.endpoints.from : fleet.endpoints.to;
  const targetIdentity =
    endpoint.canonicalBase ?? endpoint.roots[0]?.canonicalPath ?? endpoint.project.effectiveCwd;
  return createContentObservationIdentityV1({
    schemaVersion: 1,
    resourceId: `sync-membership:${role}:${endpoint.identity}`,
    targetIdentity,
    targetKind: 'directory',
    contentRevision: observed.membershipHash,
  });
};

const selectedPairPlan = (
  member: SyncMemberObservation,
  destination: SyncMemberObservation | null,
  tool: PlacementToolId,
  root: string,
  path: string,
  scope: 'user' | 'project',
  scopeKey: string | null,
): PairPlan => {
  const pair: PairPlan = {
    skill: member.entry.name,
    tool,
    scope,
    scopeKey,
    placement: {
      skill: member.entry.name,
      root,
      path,
      class: destination === null ? 'absent' : destination.entry.mode === 'dev' ? 'dev' : 'pinned',
      symlinkTarget: destination?.entry.placement === 'symlink' ? destination.entry.source : null,
      dangling: false,
    },
    notices: [],
  };
  Object.freeze(pair.placement);
  Object.freeze(pair.notices);
  return Object.freeze(pair);
};

/**
 * Pure first stage: selects the exact bounded source/destination members once and returns every
 * descriptor needed to materialize stores and construct placement snapshot authority.
 */
export const selectSyncFleetResourcesV1 = (
  fleet: SyncFleetObservation,
  options: SyncFleetPlanOptionsV1,
): Result<SyncFleetResourceSelectionV1, SyncObservationFailure> => {
  if (options.save !== (fleet.portableProof === 'exact')) {
    return projectionFailure(
      'sync-portable-proof-mode',
      'sync observation proof mode differs from save selection',
      'usage',
    );
  }
  const sourceSelection = selectedSourceMembers(fleet, options.targets);
  if (!sourceSelection.ok) return sourceSelection;
  if (fleet.destination.entries.some(({ entry }) => entry.visibility.state !== 'unique')) {
    return projectionFailure(
      'sync-destination-ambiguous',
      'sync destination contains an ambiguous selected identity',
      'usage',
    );
  }
  const sourceMembers = sourceSelection.value;
  if (sourceMembers.some((member) => member.pendingJournal)) {
    return projectionFailure(
      'sync-source-pending-journal',
      'sync source contains a pending placement journal',
    );
  }
  if (options.save) {
    const portableGroups = validatePortableGroups(sourceMembers);
    if (!portableGroups.ok) return portableGroups;
  }
  if (
    (fleet.endpoints.to.scope !== 'user' && fleet.endpoints.to.scope !== 'project') ||
    (fleet.endpoints.to.scope === 'project' && fleet.endpoints.to.canonicalBase === null)
  ) {
    return projectionFailure(
      'sync-destination-scope',
      'sync destination is not a writable user or project scope',
      'capability',
    );
  }
  const destinationMembers = fleet.destination.entries.filter(selectedMember);
  const destinationByKey = new Map(destinationMembers.map((member) => [memberKey(member), member]));
  const sourceKeys = new Set(sourceMembers.map(memberKey));
  const removalMembers =
    options.delete && options.targets.length === 0
      ? destinationMembers.filter((member) => !sourceKeys.has(memberKey(member)))
      : [];
  const projectRoot =
    fleet.endpoints.to.scope === 'project' && fleet.endpoints.to.canonicalBase !== null
      ? ({ kind: 'machine-bound', path: fleet.endpoints.to.canonicalBase } as const)
      : null;
  const scope = fleet.endpoints.to.scope;
  const scopeKey = projectRoot?.path ?? null;
  const pairs: SyncFleetSelectedPairV1[] = [];
  const stores: SyncFleetSelectedStoreV1[] = [];
  for (const member of sourceMembers) {
    if (!(FLIP_TOOLS as readonly string[]).includes(member.entry.tool)) {
      return projectionFailure(
        'sync-destination-capability',
        'sync selected tool cannot write placements',
        'capability',
      );
    }
    const tool = member.entry.tool as PlacementToolId;
    const destination = destinationByKey.get(memberKey(member)) ?? null;
    const root = fleet.endpoints.to.roots.find((candidate) => candidate.tool === tool);
    if (root === undefined) {
      return projectionFailure('sync-destination-root-missing', 'sync destination root is missing');
    }
    const placementPath = destination?.entry.path ?? join(root.path, member.entry.name);
    const source = operationSourceFor(member, options.save);
    if (!source.ok) return err(source.error);
    if (source.value === null) {
      return projectionFailure('sync-source-missing', 'sync source projection is missing');
    }
    const plannedSource = source.value;
    const bindingKey = syncFleetStorePairKeyV1(member);
    const store = Object.freeze({
      bindingKey,
      skill: member.entry.name,
      tool,
      sourcePath: member.entry.realpath,
      contentHash: plannedSource.contentHash,
    });
    stores.push(store);
    const representation =
      plannedSource.kind === 'portable' && member.portable.outcome === 'portable'
        ? member.portable.candidate.placement
        : 'copy';
    pairs.push(
      Object.freeze({
        bindingKey,
        action: 'converge',
        pair: selectedPairPlan(
          member,
          destination,
          tool,
          root.path,
          placementPath,
          scope,
          scopeKey,
        ),
        source: member,
        destination,
        operationSource: plannedSource,
        sourceContent: createContentObservationIdentityV1({
          schemaVersion: 1,
          resourceId: `sync-source:${fleet.endpoints.from.identity}:${tool}:${member.entry.name}`,
          targetIdentity: member.entry.realpath,
          targetKind: 'directory',
          contentRevision: plannedSource.contentHash,
        }),
        store,
        representation,
        groupIdentityTarget: JSON.stringify([
          fleet.endpoints.to.identity,
          fleet.source.membershipHash,
          member.entry.name,
          plannedSource.contentHash,
        ]),
      }),
    );
  }

  for (const member of removalMembers) {
    if (!(FLIP_TOOLS as readonly string[]).includes(member.entry.tool)) {
      return projectionFailure(
        'sync-destination-capability',
        'sync selected tool cannot remove placements',
        'capability',
      );
    }
    const tool = member.entry.tool as PlacementToolId;
    const root = fleet.endpoints.to.roots.find((candidate) => candidate.tool === tool);
    if (root === undefined) {
      return projectionFailure('sync-destination-root-missing', 'sync destination root is missing');
    }
    const bindingKey = JSON.stringify([
      'remove',
      member.entry.tool,
      member.entry.name,
      member.entry.path,
    ]);
    pairs.push(
      Object.freeze({
        bindingKey,
        action: 'remove',
        pair: selectedPairPlan(member, member, tool, root.path, member.entry.path, scope, scopeKey),
        source: null,
        destination: member,
        operationSource: null,
        store: null,
        representation: 'copy',
        groupIdentityTarget: JSON.stringify([
          fleet.endpoints.to.identity,
          fleet.source.membershipHash,
          member.entry.name,
          'remove',
        ]),
      }),
    );
  }
  const normalizedOptions = Object.freeze({
    targets: Object.freeze([...new Set(options.targets)]),
    delete: options.delete,
    continueOnError: options.continueOnError,
    save: options.save,
    force: options.force,
  });
  return ok(
    Object.freeze({
      schemaVersion: 1,
      options: normalizedOptions,
      destinationEndpointIdentity: fleet.endpoints.to.identity,
      tools: Object.freeze([...fleet.endpoints.tools]),
      scope,
      projectRoot,
      pairs: Object.freeze(pairs),
      stores: Object.freeze(stores),
      sourceMembership: membershipContentFor('source', fleet),
      destinationMembership: membershipContentFor('destination', fleet),
      sourceMembershipHash: fleet.source.membershipHash,
      destinationMembershipHash: fleet.destination.membershipHash,
    }),
  );
};

/** Second stage: binds the exact frozen selection to one already-observed placement authority. */
export const projectSyncFleetPlanV1 = (
  selection: SyncFleetResourceSelectionV1,
  authority: PlacementSnapshotAuthority,
  bindings: SyncFleetStoreBindingsV1,
): Result<SyncFleetPlanProjectionV1, SyncObservationFailure> => {
  const intents: PlacementSyncIntentV1[] = [];
  const pairs: SyncFleetPlannedPairV1[] = [];
  for (const selected of selection.pairs) {
    const { pair } = selected;
    const liveResource = authority.liveResources.find(
      (resource) =>
        resource.tool === pair.tool &&
        resource.skill === pair.skill &&
        resource.scope === pair.scope &&
        resource.projectIdentity === pair.scopeKey &&
        resource.placementPath === pair.placement.path,
    );
    if (liveResource === undefined) {
      return projectionFailure(
        'sync-live-authority-missing',
        'sync selected placement is absent from the immutable execution authority',
      );
    }
    const artifactPrefixOperationIds =
      bindings.artifactPrefixOperationIdsByPair?.[selected.bindingKey];
    if (selected.action === 'remove') {
      intents.push({
        kind: 'sync',
        action: 'remove',
        skill: pair.skill,
        tool: pair.tool,
        scope: pair.scope,
        projectRoot: selection.projectRoot,
        liveResourceId: liveResource.resourceId,
        storeResourceId: null,
        source: null,
        representation: selected.representation,
        desiredContentHash: null,
        endpointIdentity: selection.destinationEndpointIdentity,
        groupSource: null,
        groupIdentityTarget: selected.groupIdentityTarget,
        membershipContent: [selection.sourceMembership, selection.destinationMembership],
        ...(artifactPrefixOperationIds === undefined ? {} : { artifactPrefixOperationIds }),
      });
      pairs.push({
        skill: pair.skill,
        tool: pair.tool,
        liveResourceId: liveResource.resourceId,
        storeResourceId: null,
        source: null,
        destination: selected.destination,
      });
      continue;
    }
    if (
      selected.operationSource === null ||
      selected.sourceContent === undefined ||
      selected.store === null
    ) {
      return projectionFailure('sync-source-missing', 'sync source projection is missing');
    }
    const storeResourceId = bindings.storeResourceIdsByPair[selected.bindingKey];
    const storeResource = authority.storeResources.find(
      (resource) =>
        resource.resourceId === storeResourceId &&
        resource.contentHash === selected.store?.contentHash,
    );
    if (storeResource === undefined) {
      return projectionFailure(
        'sync-store-authority-missing',
        'sync selected content is absent from the immutable store authority',
      );
    }
    intents.push({
      kind: 'sync',
      action: 'converge',
      skill: pair.skill,
      tool: pair.tool,
      scope: pair.scope,
      projectRoot: selection.projectRoot,
      liveResourceId: liveResource.resourceId,
      storeResourceId: storeResource.resourceId,
      source: selected.operationSource,
      sourceContent: selected.sourceContent,
      representation: selected.representation,
      desiredContentHash: selected.operationSource.contentHash,
      endpointIdentity: selection.destinationEndpointIdentity,
      groupSource: null,
      groupIdentityTarget: selected.groupIdentityTarget,
      membershipContent: [selection.sourceMembership, selection.destinationMembership],
      ...(artifactPrefixOperationIds === undefined ? {} : { artifactPrefixOperationIds }),
    });
    pairs.push({
      skill: pair.skill,
      tool: pair.tool,
      liveResourceId: liveResource.resourceId,
      storeResourceId: storeResource.resourceId,
      source: selected.source,
      destination: selected.destination,
    });
  }
  const skills = [...new Set(pairs.map(({ skill }) => skill))];
  return ok(
    Object.freeze({
      request: Object.freeze({
        schemaVersion: 1,
        selection: Object.freeze({
          source: selection.options.targets.length === 0 ? 'bounded-default' : 'explicit-targets',
          outcome: intents.length === 0 ? 'filter-noop' : 'selected',
          targets: selection.options.targets,
          skills: Object.freeze(skills),
          tools: selection.tools,
          scopes: Object.freeze([selection.scope]),
        }),
        batchPolicy: selection.options.continueOnError ? 'continue-on-error' : 'fail-fast',
        force: selection.options.force,
        intents: Object.freeze(intents),
        ...(bindings.compatibilityOperations === undefined
          ? {}
          : { compatibilityOperations: bindings.compatibilityOperations }),
      }),
      pairs: Object.freeze(pairs),
      sourceMembershipHash: selection.sourceMembershipHash,
      destinationMembershipHash: selection.destinationMembershipHash,
    }),
  );
};
