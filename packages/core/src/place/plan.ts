import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import type { PlacementInventory, SkillRootsCtx } from '../agents/adapter-types.ts';
import {
  type Placement,
  type PlacementClass,
  classifyPlacement,
} from '../agents/placement-shared.ts';
import {
  type LifecycleToolRegistry,
  toolRegistry as defaultLifecycleToolRegistry,
} from '../agents/registry.ts';
import { parseArtifactDigest } from '../artifacts/hash.ts';
import type { PlanImageV1, PlanSourceV1 } from '../artifacts/plan-types.ts';
import { logicalJournalPairIdentity } from '../artifacts/registry.ts';
import { type SkillSmithError, flipRefusedError, placementNotFoundError } from '../errors.ts';
import {
  type SnapshotBoundOperationPlanV1,
  type SnapshotPlanningErrorV1,
  bindOperationPlanToSnapshotV1,
  createOperationGroupId,
  createOperationId,
  createOperationPairId,
  createOperationPlan,
  createPlanCheckId,
  createPlanningDiagnosticId,
  expectedRevisionPreconditionIdsForSnapshotV1,
  operationImageFromLiveStateV1,
  operationSourceFromLedgerPairV1,
} from '../planning/create.ts';
import { canonicalPlanningString } from '../planning/order.ts';
import type {
  CurrentMutatorCommand,
  ExecutableOperation,
  OperationImage,
  OperationLocation,
  OperationPlan,
  OperationPlanInput,
  OperationSelection,
  OperationSource,
  PlanCheck,
  PlanCheckIdentity,
  PlanningDiagnostic,
  PlanningDiagnosticIdentity,
  PlanningToolContext,
} from '../planning/types.ts';
import { type Result, err, ok } from '../result.ts';
import {
  type ContentObservationIdentityV1,
  type LivePlacementStateV1,
  type ObservedStateSnapshotV1,
  type StoreStateV1,
  createContentObservationPreconditionIdV1,
  createStoreSnapshotIdentityV1,
} from '../state/types.ts';
import { getPairAt } from './ledger.ts';
import { logicalRollbackExecutionMode } from './logical-transactions.ts';
import type {
  FlipOp,
  FlipOptions,
  FlipResult,
  FlipTool,
  LedgerFile,
  PlacementReadPorts,
} from './types.ts';

export interface PairPlan {
  skill: string;
  tool: FlipTool;
  scope: 'user' | 'project';
  scopeKey: string | null;
  placement: Placement;
  notices: string[]; // e.g. legacy-root info
}

export interface FlipPlanOutcome {
  pairs: PairPlan[]; // eligible, in (target-order x tool-order) sequence
  preResults: FlipResult[]; // already-decided results (refusals, skips, not-found)
  /** Explicit named targets with no live or recorded placement under any known tool/scope. */
  unmatchedTargets?: string[];
}

const compatibilityLegacyInventory = {
  placements: [],
  duplicates: [],
  currentRoot: null,
  legacyRoot: '__skillsmith_legacy_root__',
} as const;

/** @deprecated Compatibility view; placement bundles own legacy-root notices. */
export const LEGACY_ROOT_NOTICE = (() => {
  for (const tool of defaultLifecycleToolRegistry.toolsFor('install')) {
    const notice = defaultLifecycleToolRegistry
      .get(tool)
      ?.placement?.noticeForRoot(
        compatibilityLegacyInventory.legacyRoot,
        compatibilityLegacyInventory,
      );
    if (notice) return notice;
  }
  throw new Error('tool registry invariant: no legacy-root notice is registered');
})();

const emptyFlipResult = (
  skill: string,
  tool: FlipTool | null,
  placementPath: string | null,
  reason: string,
  error: SkillSmithError,
): FlipResult => ({
  skill,
  tool,
  placementPath,
  action: 'refused',
  reason,
  before: null,
  after: null,
  store: null,
  verify: null,
  error,
});

const isPathTarget = (target: string): boolean => target.includes('/') || isAbsolute(target);

const isFlippableClass = (cls: PlacementClass): boolean => cls === 'dev' || cls === 'pinned';

/** D9: a `store-linked` placement (a symlink into the store) is never in `--all` sets, but for a
 *  named/path target it surfaces into the plan so the run layer can converge/re-pin/flip it per
 *  its ledger record — the run layer refuses a recordless one with reinstall guidance. Named-target
 *  resolution keeps ONE exception: with an EXPLICIT `--tool`, a store-linked placement carrying no
 *  ledger record stays a plan-level "not flippable" preResult (P12 shape), just reworded — it is
 *  not routed to the run layer in that narrower case. */
const isStoreLinkedFlippableFor = (
  ledger: LedgerFile,
  scopeKey: string | null,
  skill: string,
  tool: FlipTool,
  explicitTools: boolean,
): boolean => !explicitTools || getPairAt(ledger, scopeKey, skill, tool) !== null;

/** A pair carries an uncommitted journal when an earlier swap was interrupted (crash / SIGKILL).
 *  Such a pair must surface into the plan regardless of its current filesystem class — a crash
 *  window can leave the live path absent (backup holds the old artifact) or in the wrong class —
 *  so the run layer's resume/rollback/refuse logic (spec §8.4) stays reachable via every route. */
const hasOpenJournal = (
  ledger: LedgerFile,
  scopeKey: string | null,
  skill: string,
  tool: FlipTool,
): boolean => {
  const journal = getPairAt(ledger, scopeKey, skill, tool)?.journal;
  return journal != null && journal.phase !== 'committed';
};

/** P15 (issue #11): a pair is rollbackable when the run layer's direction-agnostic rollback (D10)
 *  can invert it — an uncommitted journal restores the journaled before-state, otherwise a committed
 *  flip is inverted from the retained inverse record (pinned needs a dev record, dev needs a pinned
 *  record). Mirrors `runRollbackPair`'s "nothing to roll back" guard so `--rollback --all` plans
 *  exactly the pairs it will act on, independent of the forward verb's placement-class filter. */
const isRollbackablePair = (
  ledger: LedgerFile,
  scopeKey: string | null,
  skill: string,
  tool: FlipTool,
): boolean => {
  if (hasOpenJournal(ledger, scopeKey, skill, tool)) return true;
  const pair = getPairAt(ledger, scopeKey, skill, tool);
  if (pair === null) return false;
  // BF-2: `!= null` (not `!== null`) so a RAW dev-only record whose `pinned` key is OMITTED
  // (undefined) is not selected as rollbackable — a dev-created pair has no pinned state to invert.
  return pair.mode === 'pinned' ? pair.dev != null : pair.pinned != null;
};

type PlacementLifecycleOperation = 'dev' | 'promote' | 'undo';
type PlacementPlanningContext = PlanningToolContext<string>;

const createCanonicalPlacementPlan = <Command extends CurrentMutatorCommand>(
  input: OperationPlanInput<Command>,
  context: PlacementPlanningContext | undefined,
): OperationPlan<Command> =>
  context === undefined
    ? createOperationPlan(input)
    : (createOperationPlan(input, context) as OperationPlan<Command>);

const createPlacementCheckId = (
  identity: PlanCheckIdentity,
  context: PlacementPlanningContext | undefined,
): string =>
  context === undefined ? createPlanCheckId(identity) : createPlanCheckId(identity, context);

const placementToolsFor = (
  registry: LifecycleToolRegistry,
  operation: PlacementLifecycleOperation,
): readonly FlipTool[] =>
  registry
    .toolsFor(operation)
    .filter((tool) => registry.get(tool)?.placement !== undefined) as readonly FlipTool[];

export const placementSelectionFor = (
  registry: LifecycleToolRegistry,
  opts: FlipOptions,
  operation: PlacementLifecycleOperation,
) => {
  const requestedTools = opts.tools;
  const registeredTools = placementToolsFor(registry, operation);
  const explicitTools = requestedTools !== undefined && requestedTools.length > 0;
  const source: 'explicit-targets' | 'explicit-all' =
    opts.selectionSource ?? (opts.all ? 'explicit-all' : 'explicit-targets');
  return {
    source,
    requested: {
      targets: [...opts.targets],
      all: Boolean(opts.all),
      tools: explicitTools ? [...requestedTools] : [...registeredTools],
      explicitTools,
    },
    registeredTools,
    selectedTools:
      requestedTools !== undefined && requestedTools.length > 0
        ? [...requestedTools]
        : [...registeredTools],
    planTools: requestedTools ? [...requestedTools] : [...registeredTools],
  };
};

const placementBundleFor = (registry: LifecycleToolRegistry, tool: FlipTool) => {
  const placement = registry.get(tool)?.placement;
  if (placement === undefined) throw new Error(`tool registry invariant: ${tool} has no placement`);
  return placement;
};

/** The standard user-scope skills roots a tool owns (claude-code: one; codex: current + legacy).
 *  Used to decide whether a ledger-recorded placementPath lives at a CUSTOM location (a `--dest`
 *  create) — BF-1(d). */
const standardRootsFor = (
  registry: LifecycleToolRegistry,
  env: PlacementReadPorts,
  ctx: SkillRootsCtx,
  tool: FlipTool,
  scope: 'user' | 'project' = 'user',
): readonly string[] =>
  placementBundleFor(registry, tool)
    .rootFacts(env, scope, ctx)
    .map((fact) => fact.path);

/** BF-1(a): a skill NAME target must be a single leaf — never `.`/`..`/empty/`/`-bearing, which
 *  would classify (and could clobber) the skills ROOT itself rather than a skill in it. */
const isValidLeafName = (name: string): boolean =>
  name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes(sep);

interface ToolResolution {
  placement: Placement;
  notices: string[];
  duplicateReason: string | null;
}

const classifyForTool = (
  registry: LifecycleToolRegistry,
  env: PlacementReadPorts,
  ctx: SkillRootsCtx,
  storeRoot: string,
  skill: string,
  tool: FlipTool,
  scope: 'user' | 'project' = 'user',
): Promise<ToolResolution> => {
  const bundle = placementBundleFor(registry, tool);
  return bundle
    .resolveScoped(env, ctx, storeRoot, skill, scope)
    .then((resolution) => ({ ...resolution, notices: [...resolution.notices] }));
};

const listForTool = async (
  registry: LifecycleToolRegistry,
  env: PlacementReadPorts,
  ctx: SkillRootsCtx,
  storeRoot: string,
  tool: FlipTool,
  scope: 'user' | 'project',
): Promise<PlacementInventory> =>
  placementBundleFor(registry, tool).listScoped(env, ctx, storeRoot, scope);

const searchedRootsDescription = (
  registry: LifecycleToolRegistry,
  env: PlacementReadPorts,
  ctx: SkillRootsCtx,
  tools: readonly FlipTool[],
  scopes: readonly ('user' | 'project')[] = ['user'],
): string => {
  return scopes
    .flatMap((scope) => tools.flatMap((tool) => standardRootsFor(registry, env, ctx, tool, scope)))
    .join(', ');
};

const resolveNamedTarget = async (
  registry: LifecycleToolRegistry,
  env: PlacementReadPorts,
  ctx: SkillRootsCtx,
  storeRoot: string,
  target: string,
  toolsInOrder: readonly FlipTool[],
  explicitTools: boolean,
  ledger: LedgerFile,
  scope: 'user' | 'project',
  scopeKey: string | null,
  withSource: boolean,
  dest: string | undefined,
): Promise<{ pairs: PairPlan[]; preResults: FlipResult[] }> => {
  const pairs: PairPlan[] = [];
  const preResults: FlipResult[] = [];
  let anyFlippableFound = false;

  // BF-1(a): reject a non-leaf/dot name before it can classify the skills ROOT itself.
  if (!isValidLeafName(target)) {
    const reason = `'${target}' is not a valid skill name`;
    return {
      pairs: [],
      preResults: [emptyFlipResult(target, null, null, reason, flipRefusedError(reason))],
    };
  }

  for (const tool of toolsInOrder) {
    let res: ToolResolution;
    if (dest !== undefined) {
      // P13 `--dest`: create at a custom root (requires exactly one --tool). `dest` is already
      // resolved absolute + normalized by planFlips (BF-1b), and the leaf-name check above keeps
      // join(dest, target) contained under dest.
      const destPlacement = await classifyPlacement(env, dest, target, storeRoot);
      // BF-1(c): a `--dest` create must not shadow an existing placement in the tool's STANDARD
      // roots (codex modern/legacy included) or an existing ledger pair — that silently creates a
      // duplicate the lifecycle can't reconcile. The old code hard-coded duplicateReason:null here.
      const normal = await classifyForTool(registry, env, ctx, storeRoot, target, tool, scope);
      const hasPair = getPairAt(ledger, scopeKey, target, tool) !== null;
      if (normal.duplicateReason || normal.placement.class !== 'absent' || hasPair) {
        anyFlippableFound = true;
        const where = normal.duplicateReason
          ? `both ${tool} roots`
          : normal.placement.class !== 'absent'
            ? normal.placement.path
            : 'the placements ledger';
        const reason = `refusing to create '${target}' (${tool}) at ${destPlacement.path}: a placement already exists (${where}); resolve it first`;
        preResults.push(
          emptyFlipResult(target, tool, destPlacement.path, reason, flipRefusedError(reason)),
        );
        continue;
      }
      res = { placement: destPlacement, notices: [], duplicateReason: null };
    } else {
      res = await classifyForTool(registry, env, ctx, storeRoot, target, tool, scope);
      // BF-1(d): the ledger is the source of truth for a placement's LOCATION. When the standard
      // roots don't hold it but a ledger pair records a placement at a CUSTOM location (a `--dest`
      // create), classify THERE so promote/dev/uninstall stay able to manage it for its whole life.
      if (res.placement.class === 'absent') {
        const recorded = getPairAt(ledger, scopeKey, target, tool)?.placementPath;
        if (
          recorded &&
          !standardRootsFor(registry, env, ctx, tool, scope).includes(dirname(recorded))
        ) {
          res = {
            placement: await classifyPlacement(env, dirname(recorded), target, storeRoot),
            notices: [],
            duplicateReason: null,
          };
        }
      }
    }

    if (res.duplicateReason) {
      anyFlippableFound = true;
      preResults.push(
        emptyFlipResult(
          target,
          tool,
          res.placement.path,
          res.duplicateReason,
          flipRefusedError(res.duplicateReason),
        ),
      );
      continue;
    }

    const flippableNow =
      isFlippableClass(res.placement.class) ||
      (res.placement.class === 'store-linked' &&
        isStoreLinkedFlippableFor(ledger, scopeKey, target, tool, explicitTools)) ||
      // P13 S1/S6: with `--source`, an absent placement routes to the run layer for create (or a
      // foreign-object refusal when a real file already occupies the placement path).
      (withSource && res.placement.class === 'absent');

    if (!flippableNow) {
      // A journaled pair surfaces even when its live path is absent/wrong-class (F1), so the run
      // layer can resume/rollback/refuse it. Committed/absent-journal pairs keep prior behavior.
      if (hasOpenJournal(ledger, scopeKey, target, tool)) {
        anyFlippableFound = true;
        pairs.push({
          skill: target,
          tool,
          scope,
          scopeKey,
          placement: res.placement,
          notices: res.notices,
        });
        continue;
      }
      if (explicitTools) {
        const reason =
          res.placement.class === 'store-linked'
            ? `'${target}' has no flippable placement for ${tool} (found: store-linked, no managed record); reinstall with 'skillsmith install --force'`
            : `'${target}' has no flippable placement for ${tool} (found: ${res.placement.class})`;
        preResults.push(
          emptyFlipResult(
            target,
            tool,
            res.placement.class === 'absent' ? null : res.placement.path,
            reason,
            placementNotFoundError(reason),
          ),
        );
      }
      continue;
    }

    anyFlippableFound = true;
    pairs.push({
      skill: target,
      tool,
      scope,
      scopeKey,
      placement: res.placement,
      notices: res.notices,
    });
  }

  if (!anyFlippableFound && !explicitTools) {
    const reason = `no placement found for '${target}'; searched: ${searchedRootsDescription(registry, env, ctx, toolsInOrder, [scope])}`;
    preResults.push(emptyFlipResult(target, null, null, reason, placementNotFoundError(reason)));
  }

  return { pairs, preResults };
};

const resolvePathTarget = async (
  registry: LifecycleToolRegistry,
  env: PlacementReadPorts,
  ctx: SkillRootsCtx,
  storeRoot: string,
  target: string,
  availableTools: readonly FlipTool[],
  selectedTools: readonly FlipTool[],
  explicitTools: boolean,
  ledger: LedgerFile,
  scope: 'user' | 'project',
  scopeKey: string | null,
  withSource: boolean,
): Promise<Result<{ pairs: PairPlan[]; preResults: FlipResult[] }, SkillSmithError>> => {
  const resolved = resolve(ctx.cwd, target);
  const parent = dirname(resolved);
  const skill = basename(resolved);

  // BF-1(a): a path whose leaf resolves to `.`/`..`/'' (e.g. `.`, `foo/..`) would target a skills
  // ROOT, not a skill — refuse.
  if (!isValidLeafName(skill)) {
    const reason = `'${target}' does not name a skill`;
    return err(flipRefusedError(reason));
  }

  let tool: FlipTool | null = null;
  let notices: string[] = [];
  let root: string | null = null;
  let selectedPlacement: Placement | null = null;
  for (const candidate of availableTools) {
    const bundle = placementBundleFor(registry, candidate);
    const candidateRoot = bundle
      .rootFacts(env, scope, ctx)
      .find((fact) => fact.path === parent)?.path;
    if (candidateRoot === undefined) continue;
    const resolution = await bundle.resolveScoped(env, ctx, storeRoot, skill, scope);
    if (resolution.duplicateReason !== null) {
      return ok({
        pairs: [],
        preResults: [
          emptyFlipResult(
            skill,
            candidate,
            resolution.placement.path,
            resolution.duplicateReason,
            flipRefusedError(resolution.duplicateReason),
          ),
        ],
      });
    }
    if (resolution.placement.class !== 'absent' && resolution.placement.root !== candidateRoot) {
      const notice = resolution.notices.length === 0 ? '' : ` ${resolution.notices.join('; ')}`;
      const reason = `'${target}' conflicts with the existing ${candidate} placement at ${resolution.placement.path}.${notice} Resolve it first`;
      return ok({
        pairs: [],
        preResults: [
          emptyFlipResult(
            skill,
            candidate,
            resolution.placement.path,
            reason,
            flipRefusedError(reason),
          ),
        ],
      });
    }
    tool = candidate;
    notices = [...resolution.notices];
    root = candidateRoot;
    selectedPlacement = resolution.placement.root === candidateRoot ? resolution.placement : null;
    break;
  }
  if (tool === null) {
    // BF-1(d): a custom-location path (outside every standard root) is still managed if the ledger
    // records a pair at exactly this placementPath (a `--dest` create). The ledger owns LOCATION.
    for (const t of availableTools) {
      if (getPairAt(ledger, scopeKey, skill, t)?.placementPath === resolved) {
        tool = t;
        root = parent;
        break;
      }
    }
  }

  if (tool === null || root === null) {
    const reason = `'${target}' is outside every known skills root (${searchedRootsDescription(registry, env, ctx, availableTools, [scope])})`;
    return err(flipRefusedError(reason));
  }

  if (explicitTools && !selectedTools.includes(tool)) {
    const reason = `'${target}' resolves to ${tool}, which is not in the requested --tool set`;
    return ok({
      pairs: [],
      preResults: [emptyFlipResult(skill, tool, resolved, reason, placementNotFoundError(reason))],
    });
  }

  const placement = selectedPlacement ?? (await classifyPlacement(env, root, skill, storeRoot));
  // A journaled pair surfaces even when its live path is absent/wrong-class (F1); otherwise a
  // non-flippable class is a placement-not-found refusal as before. A path target resolves to
  // exactly one tool already (no multi-tool search to fall back on), so — unlike a named target —
  // store-linked always surfaces here regardless of a ledger record; the run layer decides.
  // BF-1(e): an explicit absent path target with `--source` routes to S1 create (the run layer
  // creates the placement at exactly this path).
  const flippable =
    isFlippableClass(placement.class) ||
    placement.class === 'store-linked' ||
    (withSource && placement.class === 'absent');
  if (!flippable && !hasOpenJournal(ledger, scopeKey, skill, tool)) {
    const reason = `'${target}' has no flippable placement for ${tool} (found: ${placement.class})`;
    return ok({
      pairs: [],
      preResults: [
        emptyFlipResult(
          skill,
          tool,
          placement.class === 'absent' ? null : placement.path,
          reason,
          placementNotFoundError(reason),
        ),
      ],
    });
  }

  return ok({
    pairs: [{ skill, tool, scope, scopeKey, placement, notices }],
    preResults: [],
  });
};

/** Target & tool resolution (spec §5/D2/D3). For a forward flip, `opts.op` picks the `--all`
 *  flippable class: `dev` for promote, `pinned` for dev. When `opts.rollback` is set, the `--all`
 *  selection is direction-agnostic instead (D10 / P15): pairs are chosen by their own rollbackable
 *  ledger state, not the verb's class filter. Named/path targets accept either class (dev.md §4's
 *  convergent no-op / already-dev no-op both need the pair to reach the run layer). `ledger` is
 *  read-only here: consulted for `dev --all`'s "pinned with a recorded dev source" filter and for
 *  rollback selection, and — across every route — to surface any pair carrying an uncommitted
 *  journal regardless of its filesystem class, so an interrupted swap stays reachable by
 *  --rollback / re-run / resume (F1). */
export const planFlipsWithRegistry = async (
  registry: LifecycleToolRegistry,
  env: PlacementReadPorts,
  opts: FlipOptions & { op: FlipOp },
  storeRoot: string,
  ledger: LedgerFile,
): Promise<Result<FlipPlanOutcome, SkillSmithError>> => {
  // Project context is normalized by the application/runner boundary. Candidate planning is a
  // pure consumer of that authority and never re-discovers Git or widens the selected scope.
  const projectRoot = opts.projectRoot ?? null;
  const selectedScopes: readonly ('user' | 'project')[] =
    opts.scope !== undefined ? [opts.scope] : projectRoot === null ? ['user'] : ['user', 'project'];
  const scopes = selectedScopes.map((scope) => ({
    scope,
    scopeKey: scope === 'project' ? projectRoot : null,
    ctx: {
      cwd: scope === 'project' ? (projectRoot ?? opts.cwd) : opts.cwd,
      configuration: opts.configuration,
    } satisfies SkillRootsCtx,
  }));
  const operation: PlacementLifecycleOperation =
    opts.rollback || opts.op === 'rollback' ? 'undo' : opts.op;
  const {
    requested: { explicitTools },
    registeredTools: registeredPlacementTools,
    selectedTools,
  } = placementSelectionFor(registry, opts, operation);
  const toolsInOrder = registeredPlacementTools.filter((t) => selectedTools.includes(t));

  const pairs: PairPlan[] = [];
  const preResults: FlipResult[] = [];
  const unmatchedTargets: string[] = [];

  if (opts.all) {
    // P15 (issue #11): bulk rollback is direction-agnostic (D10). Select each pair by its OWN
    // rollbackable state — NOT the forward verb's placement-class filter below, which made
    // `promote --rollback --all` (dev class) and `dev --rollback --all` (pinned class) choose
    // opposite, non-overlapping sets. The run layer inverts each pair from its retained records
    // regardless of the verb, so the plan must offer exactly the pairs that layer can invert.
    if (opts.rollback) {
      for (const { scope, scopeKey, ctx } of scopes) {
        const skills =
          scopeKey === null ? ledger.skills : (ledger.projects?.[scopeKey]?.skills ?? {});
        for (const skill of Object.keys(skills).sort()) {
          for (const tool of toolsInOrder) {
            if (!isRollbackablePair(ledger, scopeKey, skill, tool)) continue;
            // The ledger owns custom placement locations in either scope.
            const recorded = getPairAt(ledger, scopeKey, skill, tool)?.placementPath;
            const res: ToolResolution =
              recorded &&
              !standardRootsFor(registry, env, ctx, tool, scope).includes(dirname(recorded))
                ? {
                    placement: await classifyPlacement(env, dirname(recorded), skill, storeRoot),
                    notices: [],
                    duplicateReason: null,
                  }
                : await classifyForTool(registry, env, ctx, storeRoot, skill, tool, scope);
            if (res.duplicateReason) {
              preResults.push(
                emptyFlipResult(
                  skill,
                  tool,
                  res.placement.path,
                  res.duplicateReason,
                  flipRefusedError(res.duplicateReason),
                ),
              );
              continue;
            }
            pairs.push({
              skill,
              tool,
              scope,
              scopeKey,
              placement: res.placement,
              notices: res.notices,
            });
          }
        }
      }
      return ok({ pairs, preResults });
    }

    const flippableClass: PlacementClass = opts.op === 'promote' ? 'dev' : 'pinned';
    for (const { scope, scopeKey, ctx } of scopes) {
      const perTool = new Map<FlipTool, Map<string, Placement>>();
      const inventories = new Map<FlipTool, PlacementInventory>();
      for (const tool of toolsInOrder) {
        const scan = await listForTool(registry, env, ctx, storeRoot, tool, scope);
        inventories.set(tool, scan);
        const byName = new Map<string, Placement>();
        for (const placement of scan.placements) {
          if (placement.class !== flippableClass || scan.duplicates.includes(placement.skill))
            continue;
          if (!byName.has(placement.skill)) byName.set(placement.skill, placement);
        }
        perTool.set(tool, byName);
        for (const dupSkill of scan.duplicates) {
          if (!scan.placements.some((p) => p.skill === dupSkill && p.class === flippableClass))
            continue;
          const resolution = await classifyForTool(
            registry,
            env,
            ctx,
            storeRoot,
            dupSkill,
            tool,
            scope,
          );
          const reason =
            resolution.duplicateReason ??
            `found '${dupSkill}' in multiple adapter roots; resolve the duplicate first`;
          preResults.push(
            emptyFlipResult(
              dupSkill,
              tool,
              resolution.placement.path,
              reason,
              flipRefusedError(reason),
            ),
          );
        }
      }
      const allSkillNames = new Set<string>();
      for (const byName of perTool.values())
        for (const name of byName.keys()) allSkillNames.add(name);
      const skills =
        scopeKey === null ? ledger.skills : (ledger.projects?.[scopeKey]?.skills ?? {});
      for (const skill of Object.keys(skills)) {
        if (toolsInOrder.some((tool) => hasOpenJournal(ledger, scopeKey, skill, tool))) {
          allSkillNames.add(skill);
        }
      }
      for (const skill of [...allSkillNames].sort()) {
        for (const tool of toolsInOrder) {
          const placement = perTool.get(tool)?.get(skill);
          if (!inventories.has(tool))
            throw new Error(`tool registry invariant: ${tool} placement inventory is missing`);
          if (hasOpenJournal(ledger, scopeKey, skill, tool)) {
            const resolution = await classifyForTool(
              registry,
              env,
              ctx,
              storeRoot,
              skill,
              tool,
              scope,
            );
            const live = placement ?? resolution.placement;
            pairs.push({
              skill,
              tool,
              scope,
              scopeKey,
              placement: live,
              notices: resolution.notices,
            });
            continue;
          }
          if (!placement) continue;
          if (opts.op === 'dev' && !getPairAt(ledger, scopeKey, skill, tool)?.dev?.sourcePath) {
            preResults.push({
              skill,
              tool,
              placementPath: placement.path,
              action: 'skipped',
              reason: 'no recorded dev source',
              before: null,
              after: null,
              store: null,
              verify: null,
            });
            continue;
          }
          const resolution = await classifyForTool(
            registry,
            env,
            ctx,
            storeRoot,
            skill,
            tool,
            scope,
          );
          pairs.push({
            skill,
            tool,
            scope,
            scopeKey,
            placement,
            notices: resolution.notices,
          });
        }
      }
    }

    return ok({ pairs, preResults });
  }

  // BF-1(b): resolve `--dest` to an ABSOLUTE, normalized path once, so the recorded placementPath is
  // never relative and join(dest, leaf) is contained under it.
  const resolvedDest = opts.dest !== undefined ? resolve(opts.cwd, opts.dest) : undefined;

  for (const target of opts.targets) {
    if (isPathTarget(target)) {
      const matches: PairPlan[] = [];
      const pathResults: FlipResult[] = [];
      let firstError: SkillSmithError | null = null;
      for (const { scope, scopeKey, ctx } of scopes) {
        const resolvedPath = await resolvePathTarget(
          registry,
          env,
          ctx,
          storeRoot,
          target,
          registeredPlacementTools,
          toolsInOrder,
          explicitTools,
          ledger,
          scope,
          scopeKey,
          opts.source !== undefined,
        );
        if (resolvedPath.ok) {
          matches.push(...resolvedPath.value.pairs);
          pathResults.push(...resolvedPath.value.preResults);
        } else if (firstError === null) {
          firstError = resolvedPath.error;
        }
      }
      if (matches.length === 0) {
        if (pathResults.length > 0) {
          preResults.push(...pathResults);
        } else {
          if (firstError !== null) return err(firstError);
          const reason = `'${target}' is outside the selected skills scope`;
          preResults.push(emptyFlipResult(target, null, null, reason, flipRefusedError(reason)));
        }
      } else if (matches.length > 1) {
        const reason = `'${target}' is ambiguous across user and project scopes`;
        preResults.push(emptyFlipResult(target, null, null, reason, flipRefusedError(reason)));
      } else {
        pairs.push(...matches);
        preResults.push(...pathResults);
      }
      continue;
    }
    const scoped = [] as {
      scope: 'user' | 'project';
      pairs: PairPlan[];
      preResults: FlipResult[];
    }[];
    for (const { scope, scopeKey, ctx } of scopes) {
      const resolvedTarget = await resolveNamedTarget(
        registry,
        env,
        ctx,
        storeRoot,
        target,
        toolsInOrder,
        explicitTools,
        ledger,
        scope,
        scopeKey,
        opts.source !== undefined,
        resolvedDest,
      );
      scoped.push({ scope, ...resolvedTarget });
    }
    let candidates = scoped.flatMap((entry) => entry.pairs);
    const presentScopes = new Set(
      candidates.filter((pair) => pair.placement.class !== 'absent').map((pair) => pair.scope),
    );
    if (presentScopes.size > 0) {
      // Presence selects a scope, not an individual tool pair. Keep absent pairs in that same
      // scope so `dev --source` can independently create them when another tool refuses.
      candidates = candidates.filter((pair) => presentScopes.has(pair.scope));
    } else if (opts.source !== undefined && candidates.length > 1) {
      candidates = candidates.filter(
        (pair) => pair.scope === (projectRoot === null ? 'user' : 'project'),
      );
    }
    const candidateScopes = new Set(candidates.map((pair) => pair.scope));
    if (candidateScopes.size > 1) {
      const reason = `'${target}' is ambiguous across user and project scopes; pass --scope`;
      return err(flipRefusedError(reason));
    }
    if (candidates.length > 0) {
      pairs.push(...candidates);
      const selectedScope = candidates[0]?.scope;
      preResults.push(
        ...scoped
          .filter((entry) => entry.scope === selectedScope)
          .flatMap((entry) => entry.preResults),
      );
    } else {
      const allPreResults = scoped.flatMap((entry) => entry.preResults);
      let existsAnywhere = allPreResults.some((result) => result.placementPath !== null);
      if (!existsAnywhere) {
        for (const { scope, scopeKey, ctx } of scopes) {
          for (const tool of registeredPlacementTools) {
            const resolution = await classifyForTool(
              registry,
              env,
              ctx,
              storeRoot,
              target,
              tool,
              scope,
            );
            if (
              resolution.duplicateReason !== null ||
              resolution.placement.class !== 'absent' ||
              getPairAt(ledger, scopeKey, target, tool) !== null
            ) {
              existsAnywhere = true;
              break;
            }
          }
          if (existsAnywhere) break;
        }
      }
      if (!existsAnywhere) unmatchedTargets.push(target);
      preResults.push(
        ...(allPreResults.length > 0
          ? allPreResults
          : [
              emptyFlipResult(
                target,
                null,
                null,
                `no placement found for '${target}'`,
                placementNotFoundError(`no placement found for '${target}'`),
              ),
            ]),
      );
    }
  }

  return ok({ pairs, preResults, unmatchedTargets });
};

export const planFlips = (
  env: PlacementReadPorts,
  opts: FlipOptions & { op: FlipOp },
  storeRoot: string,
  ledger: LedgerFile,
): Promise<Result<FlipPlanOutcome, SkillSmithError>> =>
  planFlipsWithRegistry(defaultLifecycleToolRegistry, env, opts, storeRoot, ledger);

interface PlacementPlanRequestCommonV1 {
  readonly schemaVersion: 1;
  readonly selection: OperationSelection;
  readonly batchPolicy: 'fail-fast' | 'continue-on-error';
  readonly diagnostics?: readonly PlanningDiagnostic[];
  readonly compatibilityOperations?: readonly ExecutableOperation[];
}

export interface PlacementDevPlanRequestV1 extends PlacementPlanRequestCommonV1 {
  readonly command: 'dev';
  readonly mode?: 'forward';
  readonly intents: readonly PlacementDevIntentV1[];
}

export interface PlacementPromotePlanRequestV1 extends PlacementPlanRequestCommonV1 {
  readonly command: 'promote';
  readonly mode?: 'forward';
  readonly intents: readonly PlacementPromoteIntentV1[];
}

export interface PlacementRollbackPlanRequestV1 extends PlacementPlanRequestCommonV1 {
  readonly command: 'dev' | 'promote' | 'undo';
  readonly mode: 'rollback';
  readonly intents: readonly PlacementRollbackIntentV1[];
}

export interface PlacementSyncPlanRequestV1 extends PlacementPlanRequestCommonV1 {
  readonly command: 'sync';
  readonly force?: boolean;
  readonly intents: readonly PlacementSyncIntentV1[];
}

export type PlacementPlanRequestV1 =
  | PlacementDevPlanRequestV1
  | PlacementPromotePlanRequestV1
  | PlacementRollbackPlanRequestV1
  | PlacementSyncPlanRequestV1;

interface PlacementIntentIdentityV1 {
  readonly skill: string;
  readonly tool: FlipTool;
  readonly scope: 'user' | 'project';
  readonly projectRoot: OperationLocation | null;
  readonly liveResourceId: string;
  readonly sourceContent?: ContentObservationIdentityV1;
  readonly verification?: Readonly<{
    readonly mode: 'static' | 'static+deep';
    readonly expectedContentHash: `sha256:${string}`;
  }>;
}

export interface PlacementDevIntentV1 extends PlacementIntentIdentityV1 {
  readonly kind: 'link-dev';
  readonly source: Extract<OperationSource, { readonly kind: 'local-dev' }>;
  readonly sourceContent: ContentObservationIdentityV1;
}

export interface PlacementPromoteIntentV1 extends PlacementIntentIdentityV1 {
  readonly kind: 'promote';
  readonly storeResourceId: string;
  readonly source: Extract<OperationSource, { readonly kind: 'local-dev' }>;
  readonly representation: 'symlink' | 'copy';
  readonly desiredContentHash: `sha256:${string}`;
  readonly sourceContent: ContentObservationIdentityV1;
}

export interface PlacementRollbackIntentV1 extends PlacementIntentIdentityV1 {
  readonly kind: 'rollback';
  readonly storeResourceId: string | null;
  readonly sourceContent?: ContentObservationIdentityV1;
}

export type PlacementSyncIntentV1 = PlacementIntentIdentityV1 &
  Readonly<{
    readonly kind: 'sync';
    readonly action: 'converge' | 'remove';
    readonly source: OperationSource | null;
    readonly sourceContent?: ContentObservationIdentityV1;
    readonly storeResourceId: string | null;
    readonly representation: 'symlink' | 'copy';
    readonly desiredContentHash: `sha256:${string}` | null;
    /** Stable normalized endpoint identity; participates in the destination-skill group ID. */
    readonly endpointIdentity: string;
    /** Shared aggregate source identity for every tool pair in one destination-skill group. */
    readonly groupSource: OperationSource | null;
    /** Endpoint + source-membership/content aggregate used by the semantic group identity. */
    readonly groupIdentityTarget: string;
    /** Exact source and destination fleet memberships consumed by this selected pair. */
    readonly membershipContent: readonly [
      ContentObservationIdentityV1,
      ContentObservationIdentityV1,
    ];
    /** Exact earlier write-lock prefixes for branch-safe same-pair artifact composition. */
    readonly artifactPrefixOperationIds?: readonly string[];
  }>;

const placementPlanningError = (error: unknown): SnapshotPlanningErrorV1 =>
  Object.freeze({
    code: 'planning-invalid',
    message: error instanceof Error ? error.message : 'placement planning failed',
  });

const placementExpectedRevisionIds = (
  snapshot: ObservedStateSnapshotV1<unknown>,
): readonly string[] => expectedRevisionPreconditionIdsForSnapshotV1(snapshot);

const placementLiveObservation = (
  snapshot: ObservedStateSnapshotV1<unknown>,
  resourceId: string,
): ObservedStateSnapshotV1<unknown>['live'][number] => {
  const matches = snapshot.live.filter(
    (observation) =>
      observation.revision.domain === 'live' && observation.revision.resourceId === resourceId,
  );
  if (matches.length !== 1) {
    throw new TypeError('placement planning: live resource observation is missing or ambiguous');
  }
  const observation = matches[0] as ObservedStateSnapshotV1<unknown>['live'][number];
  const revision = observation.revision;
  const state = observation.value;
  if (revision.domain !== 'live') {
    throw new TypeError('placement planning: live resource observation is incoherent');
  }
  if (revision.state === 'absent') {
    if (state !== null) {
      throw new TypeError('placement planning: live resource observation is incoherent');
    }
    return observation;
  }
  const targetKind = state?.representation === 'directory' ? 'directory' : state?.representation;
  if (
    revision.state !== 'present' ||
    state === null ||
    revision.targetIdentity !== state.path ||
    revision.targetKind !== targetKind ||
    revision.contentRevision !== state.contentRevision
  ) {
    throw new TypeError('placement planning: live resource observation is incoherent');
  }
  return observation;
};

const placementStoreObservation = (
  snapshot: ObservedStateSnapshotV1<unknown>,
  resourceId: string,
): ObservedStateSnapshotV1<unknown>['store'][number] => {
  const matches = snapshot.store.filter(
    (observation) =>
      observation.revision.domain === 'store' && observation.revision.resourceId === resourceId,
  );
  if (matches.length !== 1) {
    throw new TypeError('placement planning: store resource observation is missing or ambiguous');
  }
  const observation = matches[0] as ObservedStateSnapshotV1<unknown>['store'][number];
  const revision = observation.revision;
  const state = observation.value;
  if (revision.domain !== 'store') {
    throw new TypeError('placement planning: store resource observation is incoherent');
  }
  if (revision.state === 'absent') {
    if (state !== null) {
      throw new TypeError('placement planning: store resource observation is incoherent');
    }
    return observation;
  }
  if (
    revision.state !== 'present' ||
    state === null ||
    revision.targetIdentity !== state.path ||
    revision.contentRevision !== state.contentRevision ||
    revision.resourceRevision !== state.repositoryRevision ||
    revision.snapshotIdentity !== state.snapshotIdentity
  ) {
    throw new TypeError('placement planning: store resource observation is incoherent');
  }
  return observation;
};

const placementLiveLocation = (
  observation: ObservedStateSnapshotV1<unknown>['live'][number],
): Extract<OperationLocation, { readonly kind: 'machine-bound' }> => {
  if (observation.value !== null) {
    return { kind: 'machine-bound', path: observation.value.path };
  }
  if (observation.revision.state !== 'absent') {
    throw new TypeError('placement planning: live resource observation is invalid');
  }
  return { kind: 'machine-bound', path: observation.revision.targetIdentity };
};

const validatePlacementLive = (
  intent: PlacementIntentIdentityV1,
  state: LivePlacementStateV1 | null,
): void => {
  if (state === null) return;
  if (
    state.skill !== intent.skill ||
    state.tool !== intent.tool ||
    state.scope !== intent.scope ||
    (intent.projectRoot?.kind === 'machine-bound' &&
      state.projectIdentity !== intent.projectRoot.path)
  ) {
    throw new TypeError('placement planning: live resource does not match placement intent');
  }
};

interface PlacementStoreFactsV1 {
  readonly path: string;
  readonly state: StoreStateV1 | null;
}

const validatePlacementStore = (
  resourceId: string,
  desiredContentHash: `sha256:${string}`,
  observation: ObservedStateSnapshotV1<unknown>['store'][number],
  requirePresent: boolean,
): PlacementStoreFactsV1 => {
  const state = observation.value;
  const revision = observation.revision;
  const expectedSnapshotIdentity = createStoreSnapshotIdentityV1(resourceId, desiredContentHash);
  if (
    (requirePresent && revision.state !== 'present') ||
    (revision.state === 'present' &&
      (state === null ||
        state.contentRevision !== desiredContentHash ||
        state.snapshotIdentity !== expectedSnapshotIdentity))
  ) {
    throw new TypeError('placement planning: store resource does not match placement intent');
  }
  return {
    path: revision.state === 'absent' ? revision.targetIdentity : (state as StoreStateV1).path,
    state,
  };
};

const placementLedgerPair = (
  snapshot: ObservedStateSnapshotV1<unknown>,
  intent: PlacementIntentIdentityV1,
  observation: ObservedStateSnapshotV1<unknown>['live'][number],
  live: LivePlacementStateV1 | null,
) => {
  const ledger = snapshot.ledger.value;
  if (
    (snapshot.ledger.revision.state === 'absent' && ledger !== null) ||
    (snapshot.ledger.revision.state === 'present' && ledger === null)
  ) {
    throw new TypeError('placement planning: ledger observation is incoherent');
  }
  if (ledger === null) return null;
  const projectIdentity =
    intent.scope === 'user'
      ? null
      : (live?.projectIdentity ??
        (intent.projectRoot?.kind === 'machine-bound' ? intent.projectRoot.path : null));
  const skills =
    projectIdentity === null ? ledger.skills : ledger.projects[projectIdentity]?.skills;
  const pair = skills?.[intent.skill]?.tools[intent.tool] ?? null;
  const livePath =
    live === null && observation.revision.state === 'absent'
      ? observation.revision.targetIdentity
      : live?.path;
  if (pair !== null && pair.placementPath !== livePath) {
    throw new TypeError('placement planning: ledger/live placement paths differ');
  }
  return pair;
};

const placementLiveResource = (
  intent: PlacementIntentIdentityV1,
  observation: ObservedStateSnapshotV1<unknown>['live'][number],
) => ({
  kind: 'live' as const,
  skill: intent.skill,
  tool: intent.tool,
  scope: intent.scope,
  projectRoot: intent.projectRoot,
  location: placementLiveLocation(observation),
});

const placementOperationIds = (
  request: PlacementPlanRequestV1,
  intent: PlacementIntentIdentityV1,
  liveResource: ReturnType<typeof placementLiveResource>,
  kind: ExecutableOperation['kind'],
  source: OperationSource | null,
  target: string | null = null,
  planningContext?: PlacementPlanningContext,
) => {
  const groupSource =
    request.command === 'sync' ? (intent as PlacementSyncIntentV1).groupSource : source;
  const groupId = createOperationGroupId({
    domain: 'skillsmith.operation-group-identity',
    schemaVersion: 1,
    command: request.command,
    skill: intent.skill,
    source: groupSource,
    scope: intent.scope,
    target,
  });
  const pairIdentity = {
    domain: 'skillsmith.operation-pair-identity',
    schemaVersion: 1,
    groupId,
    tool: intent.tool,
    resource: liveResource,
  } as const;
  const pairId =
    planningContext === undefined
      ? createOperationPairId(pairIdentity)
      : createOperationPairId(pairIdentity, planningContext);
  const operationIdentity = {
    domain: 'skillsmith.operation-identity',
    schemaVersion: 1,
    groupId,
    pairId,
    kind,
    skill: intent.skill,
    source,
    tool: intent.tool,
    scope: intent.scope,
  } as const;
  const operationId =
    planningContext === undefined
      ? createOperationId(operationIdentity)
      : createOperationId(operationIdentity, planningContext);
  return { groupId, pairId, operationId };
};

const placementOperationBase = (
  request: PlacementPlanRequestV1,
  intent: PlacementIntentIdentityV1,
  snapshot: ObservedStateSnapshotV1<unknown>,
  liveResource: ReturnType<typeof placementLiveResource>,
  kind: ExecutableOperation['kind'],
  source: OperationSource | null,
  target: string | null = null,
  planningContext?: PlacementPlanningContext,
) => {
  const ids = placementOperationIds(
    request,
    intent,
    liveResource,
    kind,
    source,
    target,
    planningContext,
  );
  const requiredCheckIds =
    intent.verification === undefined
      ? []
      : [
          createPlacementCheckId(
            {
              domain: 'skillsmith.plan-check-identity',
              schemaVersion: 1,
              kind: 'verification',
              operationIds: [ids.operationId],
              tool: intent.tool,
              mode: intent.verification.mode,
              expectedContentHash: intent.verification.expectedContentHash,
            },
            planningContext,
          ),
        ];
  return {
    ...ids,
    kind,
    dependencyMetadata: {
      domain: 'skillsmith.operation-dependency' as const,
      schemaVersion: 1 as const,
      operationIds: [],
    },
    skill: intent.skill,
    source,
    tool: intent.tool,
    scope: intent.scope,
    selectionSource: request.selection.source,
    preconditionIds: [
      ...placementExpectedRevisionIds(snapshot),
      ...(intent.sourceContent === undefined
        ? []
        : [createContentObservationPreconditionIdV1(intent.sourceContent)]),
      ...(request.command === 'sync'
        ? (intent as PlacementSyncIntentV1).membershipContent.map(
            createContentObservationPreconditionIdV1,
          )
        : []),
    ],
    requiredCheckIds,
    reversibility: {
      kind: 'conditional' as const,
      retentionResourceIds: [ids.pairId] as const,
    },
    mutates: { live: true, manifest: false, lock: false, ledger: true },
    conflict: null,
  };
};

const validatePlacementSourceContent = (
  source: OperationSource,
  sourceContent: ContentObservationIdentityV1,
): void => {
  if (
    sourceContent.targetKind !== 'directory' ||
    (source.kind === 'local-dev' && sourceContent.targetIdentity !== resolve(source.path)) ||
    sourceContent.contentRevision !== source.contentHash
  ) {
    throw new TypeError('placement planning: source content observation differs from intent');
  }
};

const syncConflictFor = (
  liveResource: ReturnType<typeof placementLiveResource>,
  liveState: LivePlacementStateV1 | null,
  ledgerPair: ReturnType<typeof placementLedgerPair>,
) => {
  if (liveState === null) return null;
  if (ledgerPair === null) {
    return {
      class: 'unmanaged-target' as const,
      normal: 'refuse' as const,
      forced: 'backup-and-replace' as const,
      target: liveResource,
      backup: 'required' as const,
    };
  }
  if (
    ledgerPair.pinned?.contentHash !== null &&
    ledgerPair.pinned?.contentHash !== undefined &&
    liveState.contentRevision !== ledgerPair.pinned.contentHash
  ) {
    return {
      class: 'modified-managed-target' as const,
      normal: 'refuse' as const,
      forced: 'backup-and-replace' as const,
      target: liveResource,
      backup: 'required' as const,
    };
  }
  return null;
};

type PlacementSyncProjectionV1 = Readonly<{
  operation: ExecutableOperation | null;
  diagnostics: readonly PlanningDiagnostic[];
  groupId: string;
}>;

const syncConflictDiagnostic = (
  intent: PlacementSyncIntentV1,
  operation: ExecutableOperation,
  planningContext: PlacementPlanningContext | undefined,
): PlanningDiagnostic => {
  const identity: PlanningDiagnosticIdentity = {
    domain: 'skillsmith.planning-diagnostic-identity',
    schemaVersion: 1,
    kind: 'refuse',
    severity: 'error',
    refusalClass: 'usage',
    affected: {
      skill: intent.skill,
      source: operation.source,
      tool: intent.tool,
      scope: intent.scope,
      path: operation.conflict?.target.kind === 'live' ? operation.conflict.target.location : null,
    },
    correlation: {
      groupId: operation.groupId,
      pairId: operation.pairId,
      operationId: operation.operationId,
    },
    reasonCode: 'sync-force-required',
    selectionSource: operation.selectionSource,
  };
  const diagnosticId =
    planningContext === undefined
      ? createPlanningDiagnosticId(identity)
      : createPlanningDiagnosticId(identity, planningContext);
  return {
    diagnosticId,
    kind: identity.kind,
    severity: identity.severity,
    refusalClass: identity.refusalClass,
    affected: identity.affected,
    correlation: identity.correlation,
    reason: {
      code: identity.reasonCode,
      message: `${intent.skill} has a destination conflict; rerun with force to replace it.`,
    },
    selectionSource: identity.selectionSource,
  };
};

const placementSyncProjectionFor = (
  request: PlacementSyncPlanRequestV1,
  intent: PlacementSyncIntentV1,
  snapshot: ObservedStateSnapshotV1<unknown>,
  planningContext: PlacementPlanningContext | undefined,
): PlacementSyncProjectionV1 => {
  const observation = placementLiveObservation(snapshot, intent.liveResourceId);
  const liveState = observation.value;
  validatePlacementLive(intent, liveState);
  const ledgerPair = placementLedgerPair(snapshot, intent, observation, liveState);
  const liveResource = placementLiveResource(intent, observation);
  const exactLiveHash =
    liveState?.contentRevision != null && /^sha256:[0-9a-f]{64}$/u.test(liveState.contentRevision)
      ? (liveState.contentRevision as `sha256:${string}`)
      : null;
  const beforeSource =
    operationSourceFromLedgerPairV1(ledgerPair, liveState) ??
    (ledgerPair?.mode === 'pinned' &&
    ledgerPair.pinned != null &&
    liveState !== null &&
    exactLiveHash !== null
      ? {
          kind: 'local-dev' as const,
          path:
            exactLiveHash === ledgerPair.pinned.contentHash
              ? ledgerPair.pinned.storePath
              : (liveState.realpath ?? liveState.path),
          contentHash: exactLiveHash,
        }
      : null);
  const projectedBefore = operationImageFromLiveStateV1({
    resource: liveResource,
    state: liveState,
    managed: ledgerPair !== null,
    source: beforeSource,
  });
  const before: OperationImage =
    projectedBefore.kind === 'placement' &&
    projectedBefore.classification === 'unmanaged' &&
    projectedBefore.contentHash === null &&
    liveState?.contentRevision != null &&
    /^sha256:[0-9a-f]{64}$/u.test(liveState.contentRevision)
      ? {
          ...projectedBefore,
          contentHash: liveState.contentRevision as `sha256:${string}`,
        }
      : projectedBefore;
  const source = intent.source;
  if (
    intent.membershipContent.length !== 2 ||
    new Set(intent.membershipContent.map(({ resourceId }) => resourceId)).size !== 2
  ) {
    throw new TypeError('placement planning: sync membership authority is incomplete');
  }
  const groupId = createOperationGroupId({
    domain: 'skillsmith.operation-group-identity',
    schemaVersion: 1,
    command: 'sync',
    skill: intent.skill,
    source: intent.groupSource,
    scope: intent.scope,
    target: intent.groupIdentityTarget,
  });

  if (intent.action === 'remove') {
    if (
      source !== null ||
      intent.sourceContent !== undefined ||
      intent.storeResourceId !== null ||
      intent.desiredContentHash !== null
    ) {
      throw new TypeError('placement planning: sync remove intent carries source state');
    }
    if (before.kind === 'absent') {
      return {
        operation: null,
        groupId,
        diagnostics: [
          syncNoopDiagnostic(
            intent,
            groupId,
            null,
            liveResource,
            request.selection.source,
            planningContext,
          ),
        ],
      };
    }
    const base = placementOperationBase(
      request,
      intent,
      snapshot,
      liveResource,
      'remove',
      null,
      intent.groupIdentityTarget,
      planningContext,
    );
    const operation: ExecutableOperation = {
      ...base,
      dependencyMetadata: {
        ...base.dependencyMetadata,
        operationIds: [...(intent.artifactPrefixOperationIds ?? [])],
      },
      before,
      after: { kind: 'absent', resource: liveResource },
      reason: { code: 'sync-remove-selected', message: `Remove extra ${intent.skill}.` },
      conflict: syncConflictFor(liveResource, liveState, ledgerPair),
    };
    return {
      groupId: base.groupId,
      diagnostics:
        operation.conflict !== null && request.force !== true
          ? [syncConflictDiagnostic(intent, operation, planningContext)]
          : [],
      operation,
    };
  }

  if (
    source === null ||
    intent.sourceContent === undefined ||
    intent.storeResourceId === null ||
    intent.desiredContentHash === null ||
    source.contentHash !== intent.desiredContentHash
  ) {
    throw new TypeError('placement planning: sync convergence intent is incomplete');
  }
  if (source.kind === 'local-dev' && intent.representation !== 'copy') {
    throw new TypeError('placement planning: machine-bound sync must produce a pinned copy');
  }
  validatePlacementSourceContent(source, intent.sourceContent);
  const store = validatePlacementStore(
    intent.storeResourceId,
    intent.desiredContentHash,
    placementStoreObservation(snapshot, intent.storeResourceId),
    false,
  );
  const desiredLink = intent.representation === 'symlink' ? resolve(store.path) : null;
  const actualLink =
    liveState?.linkTarget == null ? null : resolve(dirname(liveState.path), liveState.linkTarget);
  const exact =
    liveState !== null &&
    liveState.brokenReason === null &&
    !liveState.dangling &&
    liveState.contentRevision === intent.desiredContentHash &&
    liveState.representation === (intent.representation === 'symlink' ? 'symlink' : 'directory') &&
    actualLink === desiredLink &&
    ledgerPair?.mode === 'pinned' &&
    ledgerPair.pinned?.storePath === store.path &&
    ledgerPair.pinned.contentHash === intent.desiredContentHash &&
    (ledgerPair.pinned.placement ?? 'copy') === intent.representation &&
    (source.kind === 'local-dev'
      ? ledgerPair.origin === undefined
      : ledgerPair.origin?.host === source.identity.host &&
        ledgerPair.origin.repo === source.identity.repository &&
        ledgerPair.origin.skillPath === source.sourcePath &&
        ledgerPair.origin.refRequested === source.requestedRef &&
        ledgerPair.origin.refResolved === source.resolvedSha);
  if (exact) {
    return {
      operation: null,
      groupId,
      diagnostics: [
        syncNoopDiagnostic(
          intent,
          groupId,
          source,
          liveResource,
          request.selection.source,
          planningContext,
        ),
      ],
    };
  }

  const kind: ExecutableOperation['kind'] =
    before.kind === 'absent'
      ? 'install'
      : before.kind === 'placement' && before.contentHash === intent.desiredContentHash
        ? 'repair'
        : 'update';
  const base = placementOperationBase(
    request,
    intent,
    snapshot,
    liveResource,
    kind,
    source,
    intent.groupIdentityTarget,
    planningContext,
  );
  const operation: ExecutableOperation = {
    ...base,
    dependencyMetadata: {
      ...base.dependencyMetadata,
      operationIds: [...(intent.artifactPrefixOperationIds ?? [])],
    },
    before,
    after: {
      kind: 'placement',
      resource: liveResource,
      classification: 'pinned',
      representation: intent.representation,
      linkTarget:
        intent.representation === 'symlink' ? { kind: 'machine-bound', path: store.path } : null,
      dangling: false,
      source,
      contentHash: intent.desiredContentHash,
    },
    reason: {
      code: `sync-${kind}-selected`,
      message: `${kind === 'install' ? 'Install' : kind === 'repair' ? 'Repair' : 'Update'} ${intent.skill} from the selected sync source.`,
    },
    conflict: syncConflictFor(liveResource, liveState, ledgerPair),
  };
  return {
    groupId: base.groupId,
    diagnostics:
      operation.conflict !== null && request.force !== true
        ? [syncConflictDiagnostic(intent, operation, planningContext)]
        : [],
    operation,
  };
};

const syncNoopDiagnostic = (
  intent: PlacementSyncIntentV1,
  groupId: string,
  source: OperationSource | null,
  liveResource: ReturnType<typeof placementLiveResource>,
  selectionSource: OperationSelection['source'],
  planningContext: PlacementPlanningContext | undefined,
): PlanningDiagnostic => {
  const identity: PlanningDiagnosticIdentity = {
    domain: 'skillsmith.planning-diagnostic-identity',
    schemaVersion: 1,
    kind: 'noop',
    severity: 'info',
    refusalClass: null,
    affected: {
      skill: intent.skill,
      source,
      tool: intent.tool,
      scope: intent.scope,
      path: liveResource.location,
    },
    correlation: { groupId, pairId: null, operationId: null },
    reasonCode: 'sync-destination-current',
    selectionSource,
  };
  const diagnosticId =
    planningContext === undefined
      ? createPlanningDiagnosticId(identity)
      : createPlanningDiagnosticId(identity, planningContext);
  return {
    diagnosticId,
    kind: 'noop',
    severity: 'info',
    refusalClass: null,
    affected: identity.affected,
    correlation: identity.correlation,
    reason: { code: identity.reasonCode, message: `${intent.skill} is already synchronized.` },
    selectionSource,
  };
};

const placementDevOperationFor = (
  request: PlacementDevPlanRequestV1,
  intent: PlacementDevIntentV1,
  snapshot: ObservedStateSnapshotV1<unknown>,
  planningContext: PlacementPlanningContext | undefined,
): ExecutableOperation | null => {
  validatePlacementSourceContent(intent.source, intent.sourceContent);
  const observation = placementLiveObservation(snapshot, intent.liveResourceId);
  const liveState = observation.value;
  validatePlacementLive(intent, liveState);
  const ledgerPair = placementLedgerPair(snapshot, intent, observation, liveState);
  const liveResource = placementLiveResource(intent, observation);
  const beforeSource = operationSourceFromLedgerPairV1(ledgerPair, liveState);
  if (
    liveState?.placementClass === 'dev' &&
    liveState.brokenReason === null &&
    !liveState.dangling &&
    liveState.representation === 'symlink' &&
    liveState.linkTarget !== null &&
    resolve(dirname(liveState.path), liveState.linkTarget) === resolve(intent.source.path) &&
    liveState.contentRevision === intent.source.contentHash &&
    ledgerPair?.mode === 'dev' &&
    ledgerPair.dev?.resolvedPath === intent.source.path
  ) {
    return null;
  }
  return {
    ...placementOperationBase(
      request,
      intent,
      snapshot,
      liveResource,
      'link-dev',
      intent.source,
      null,
      planningContext,
    ),
    before: operationImageFromLiveStateV1({
      resource: liveResource,
      state: liveState,
      managed: ledgerPair !== null,
      source: beforeSource,
    }),
    after: {
      kind: 'placement',
      resource: liveResource,
      classification: 'dev',
      representation: 'symlink',
      linkTarget: { kind: 'machine-bound', path: intent.source.path },
      dangling: false,
      source: intent.source,
      contentHash: intent.source.contentHash,
    },
    reason: {
      code: 'link-dev-selected',
      message: `Link ${intent.skill} for ${intent.tool} to its development source.`,
    },
  };
};

const placementPromoteOperationFor = (
  request: PlacementPromotePlanRequestV1,
  intent: PlacementPromoteIntentV1,
  snapshot: ObservedStateSnapshotV1<unknown>,
  planningContext: PlacementPlanningContext | undefined,
): ExecutableOperation | null => {
  validatePlacementSourceContent(intent.source, intent.sourceContent);
  const observation = placementLiveObservation(snapshot, intent.liveResourceId);
  const liveState = observation.value;
  validatePlacementLive(intent, liveState);
  if (intent.source.contentHash !== intent.desiredContentHash) {
    throw new TypeError('placement planning: source/store content revisions differ');
  }
  const ledgerPair = placementLedgerPair(snapshot, intent, observation, liveState);
  if (liveState?.placementClass === 'dev') {
    const expectedPath =
      liveState.linkTarget === null ? null : resolve(dirname(liveState.path), liveState.linkTarget);
    if (
      intent.source.kind !== 'local-dev' ||
      expectedPath !== intent.source.path ||
      liveState.contentRevision !== intent.source.contentHash ||
      (ledgerPair?.dev !== null &&
        ledgerPair?.dev !== undefined &&
        ledgerPair.dev.resolvedPath !== intent.source.path)
    ) {
      throw new TypeError('placement planning: dev promotion requires an exact local source');
    }
  }
  const storeFacts = validatePlacementStore(
    intent.storeResourceId,
    intent.desiredContentHash,
    placementStoreObservation(snapshot, intent.storeResourceId),
    false,
  );
  const operationKind: ExecutableOperation['kind'] =
    liveState?.placementClass === 'pinned' || liveState?.placementClass === 'store-linked'
      ? 'update'
      : 'promote';
  const beforeSource =
    liveState?.placementClass === 'dev'
      ? intent.source
      : operationSourceFromLedgerPairV1(ledgerPair, liveState);
  const liveResource = placementLiveResource(intent, observation);
  const expectedLinkTarget = intent.representation === 'symlink' ? resolve(storeFacts.path) : null;
  const observedLinkTarget =
    liveState?.linkTarget === null || liveState?.linkTarget === undefined
      ? null
      : resolve(dirname(liveState.path), liveState.linkTarget);
  if (
    (liveState?.placementClass === 'pinned' || liveState?.placementClass === 'store-linked') &&
    liveState.brokenReason === null &&
    !liveState.dangling &&
    liveState.representation === (intent.representation === 'symlink' ? 'symlink' : 'directory') &&
    observedLinkTarget === expectedLinkTarget &&
    liveState.contentRevision === intent.desiredContentHash &&
    ledgerPair?.mode === 'pinned' &&
    ledgerPair.pinned?.storePath === storeFacts.path &&
    ledgerPair.pinned.contentHash === intent.desiredContentHash &&
    (ledgerPair.pinned.placement === undefined ||
      ledgerPair.pinned.placement === intent.representation)
  ) {
    return null;
  }
  return {
    ...placementOperationBase(
      request,
      intent,
      snapshot,
      liveResource,
      operationKind,
      intent.source,
      null,
      planningContext,
    ),
    before: operationImageFromLiveStateV1({
      resource: liveResource,
      state: liveState,
      managed: ledgerPair !== null || liveState?.placementClass === 'dev',
      source: beforeSource,
    }),
    after: {
      kind: 'placement',
      resource: liveResource,
      classification: 'pinned',
      representation: intent.representation,
      linkTarget:
        intent.representation === 'symlink'
          ? { kind: 'machine-bound', path: storeFacts.path }
          : null,
      dangling: false,
      source: intent.source,
      contentHash: intent.desiredContentHash,
    },
    reason: {
      code: operationKind === 'update' ? 'update-selected' : 'promote-selected',
      message:
        operationKind === 'update'
          ? `Update ${intent.skill} for ${intent.tool}.`
          : `Promote ${intent.skill} for ${intent.tool}.`,
    },
  };
};

const pinnedRollbackSource = (
  pair: NonNullable<ReturnType<typeof placementLedgerPair>>,
  contentHash: string,
): Extract<OperationSource, { readonly kind: 'portable' }> | null => {
  if (
    pair.pinned == null ||
    pair.origin === undefined ||
    pair.pinned.contentHash !== contentHash ||
    pair.origin.host.length === 0 ||
    pair.origin.repo.length === 0 ||
    pair.origin.refResolved.length === 0 ||
    !/^sha256:[0-9a-f]{64}$/u.test(contentHash)
  ) {
    return null;
  }
  return {
    kind: 'portable',
    identity: {
      host: pair.origin.host,
      repository: pair.origin.repo,
      path: pair.origin.skillPath,
    },
    requestedRef: pair.origin.refRequested,
    resolvedSha: pair.origin.refResolved,
    sourcePath: pair.origin.skillPath.length === 0 ? '.' : pair.origin.skillPath,
    contentHash: contentHash as `sha256:${string}`,
  };
};

const ownedOperationDigest = (value: unknown): `sha256:${string}` => {
  const parsed = parseArtifactDigest(value);
  if (!parsed.ok) {
    throw new TypeError('placement planning: retained rollback digest is invalid');
  }
  return `sha256:${parsed.value.slice('sha256:'.length)}`;
};

const ownedOperationSource = (source: PlanSourceV1 | null): OperationSource | null => {
  if (source === null) return null;
  const contentHash = ownedOperationDigest(source.contentHash);
  return source.kind === 'local-dev'
    ? { kind: 'local-dev', path: source.path, contentHash }
    : {
        kind: 'portable',
        identity: {
          host: source.identity.host,
          repository: source.identity.repository,
          path: source.identity.path,
        },
        requestedRef: source.requestedRef,
        resolvedSha: source.resolvedSha,
        sourcePath: source.sourcePath,
        contentHash,
      };
};

type LiveOperationImage =
  | Extract<OperationImage, { readonly kind: 'absent' }>
  | Extract<OperationImage, { readonly kind: 'placement' }>;

const placementOperationImage = (image: OperationImage): LiveOperationImage => {
  if (image.kind === 'absent' || image.kind === 'placement') return image;
  throw new TypeError('placement planning: live projection returned a non-placement image');
};

const ownedLiveOperationImage = (
  image: PlanImageV1,
  liveResource: ReturnType<typeof placementLiveResource>,
): LiveOperationImage => {
  if (image.kind !== 'placement' && image.kind !== 'absent') {
    throw new TypeError('placement planning: retained rollback history is not placement-scoped');
  }
  if (
    image.resource.kind !== 'live' ||
    canonicalPlanningString(image.resource) !== canonicalPlanningString(liveResource)
  ) {
    throw new TypeError('placement planning: retained rollback history targets another placement');
  }
  if (image.kind === 'absent') return { kind: 'absent', resource: liveResource };
  const source = ownedOperationSource(image.source);
  const contentHash = image.contentHash === null ? null : ownedOperationDigest(image.contentHash);
  return {
    kind: 'placement',
    resource: liveResource,
    classification: image.classification,
    representation: image.representation,
    linkTarget:
      image.linkTarget === null
        ? null
        : image.linkTarget.kind === 'portable'
          ? { kind: 'portable', token: image.linkTarget.token }
          : { kind: 'machine-bound', path: image.linkTarget.path },
    dangling: image.dangling,
    source,
    contentHash,
  };
};

const retainedPlacementMatchesLive = (
  retained: LiveOperationImage,
  current: LiveOperationImage,
): boolean => {
  if (canonicalPlanningString(retained) === canonicalPlanningString(current)) return true;
  // A managed pinned symlink is observed physically as store-linked; no other image field aliases.
  if (
    retained.kind !== 'placement' ||
    current.kind !== 'placement' ||
    retained.classification !== 'pinned' ||
    current.classification !== 'store-linked' ||
    retained.representation !== 'symlink' ||
    current.representation !== 'symlink'
  ) {
    return false;
  }
  return (
    canonicalPlanningString(retained) ===
    canonicalPlanningString({ ...current, classification: 'pinned' })
  );
};

const retainedPlacementHistoryInverse = (
  snapshot: ObservedStateSnapshotV1<unknown>,
  intent: PlacementRollbackIntentV1,
  current: LiveOperationImage,
  liveResource: ReturnType<typeof placementLiveResource>,
) => {
  const ledger = snapshot.ledger.value;
  if (ledger === null) return null;
  const projectRoot = intent.projectRoot?.kind === 'machine-bound' ? intent.projectRoot.path : null;
  for (let index = ledger.history.length - 1; index >= 0; index -= 1) {
    const journal = ledger.history[index];
    if (journal === undefined) continue;
    const identity = logicalJournalPairIdentity(journal);
    if (
      identity === null ||
      identity.projectRoot !== projectRoot ||
      identity.skill !== intent.skill ||
      identity.tool !== intent.tool
    ) {
      continue;
    }
    if (journal.phase !== 'committed' || journal.disposition !== 'forward') return null;
    const inverse = ownedLiveOperationImage(journal.intent.before, liveResource);
    const retainedCurrent = ownedLiveOperationImage(journal.intent.after, liveResource);
    if (!retainedPlacementMatchesLive(retainedCurrent, current)) {
      throw new TypeError(
        'placement planning: retained rollback history does not match live state',
      );
    }
    return { journal, inverse, current: retainedCurrent };
  }
  return null;
};

const pendingFreshPlacementHistoryInverse = (
  snapshot: ObservedStateSnapshotV1<unknown>,
  intent: PlacementRollbackIntentV1,
  liveResource: ReturnType<typeof placementLiveResource>,
  pair: NonNullable<ReturnType<typeof placementLedgerPair>>,
) => {
  const ledger = snapshot.ledger.value;
  const transactionId = pair.journal?.txId;
  if (ledger === null || transactionId === undefined) return null;
  const child = ledger.transactions[transactionId];
  if (
    child === undefined ||
    child.disposition !== 'rollback' ||
    child.context.parentOperationId === null ||
    child.context.parentOperationId === child.intent.operationId
  ) {
    return null;
  }
  const mode = logicalRollbackExecutionMode(ledger, child);
  if (!mode.ok || mode.value !== 'fresh-reversal') {
    throw new TypeError('placement planning: fresh rollback linkage is inconsistent');
  }
  const parents = ledger.history.filter(
    (journal) => journal.intent.operationId === child.context.parentOperationId,
  );
  const parent = parents.length === 1 ? parents[0] : undefined;
  const identity = parent === undefined ? null : logicalJournalPairIdentity(parent);
  const pairId = parent?.intent.pairId ?? null;
  const projectRoot = intent.projectRoot?.kind === 'machine-bound' ? intent.projectRoot.path : null;
  if (
    parent === undefined ||
    identity === null ||
    identity.projectRoot !== projectRoot ||
    identity.skill !== intent.skill ||
    identity.tool !== intent.tool ||
    pairId === null ||
    child.intent.pairId !== pairId
  ) {
    throw new TypeError('placement planning: fresh rollback parent targets another placement');
  }
  return {
    child,
    parent,
    pairId,
    before: ownedLiveOperationImage(parent.intent.after, liveResource),
    after: ownedLiveOperationImage(parent.intent.before, liveResource),
  };
};

const placementRollbackOperationFor = (
  request: PlacementRollbackPlanRequestV1,
  intent: PlacementRollbackIntentV1,
  snapshot: ObservedStateSnapshotV1<unknown>,
  planningContext: PlacementPlanningContext | undefined,
): ExecutableOperation => {
  const observation = placementLiveObservation(snapshot, intent.liveResourceId);
  const liveState = observation.value;
  validatePlacementLive(intent, liveState);
  const ledgerPair = placementLedgerPair(snapshot, intent, observation, liveState);
  const liveResource = placementLiveResource(intent, observation);
  const pendingFresh =
    ledgerPair === null
      ? null
      : pendingFreshPlacementHistoryInverse(snapshot, intent, liveResource, ledgerPair);
  if (pendingFresh !== null) {
    const { child, pairId, before: parentAfter, after: parentBefore } = pendingFresh;
    const kind: ExecutableOperation['kind'] =
      parentBefore.kind === 'absent'
        ? 'remove'
        : parentBefore.classification === 'dev'
          ? 'link-dev'
          : parentAfter.kind === 'absent'
            ? 'install'
            : 'promote';
    const source = parentBefore.kind === 'placement' ? parentBefore.source : null;
    const target =
      kind === 'link-dev' &&
      parentBefore.kind === 'placement' &&
      parentBefore.linkTarget?.kind === 'machine-bound'
        ? parentBefore.linkTarget.path
        : null;
    if (kind === 'link-dev' && (source?.kind !== 'local-dev' || target === null)) {
      throw new TypeError('placement planning: fresh dev rollback history is incomplete');
    }
    const base = placementOperationBase(
      request,
      intent,
      snapshot,
      liveResource,
      kind,
      source,
      target,
      planningContext,
    );
    return {
      ...base,
      operationId: child.intent.operationId,
      groupId: child.intent.groupId,
      pairId,
      reversibility: {
        kind: 'conditional',
        retentionResourceIds: [pairId],
      },
      before: parentAfter,
      after: parentBefore,
      reason: {
        code: 'rollback-inverse',
        message: `Resume the retained placement reversal for ${intent.skill}.`,
      },
    };
  }
  const observedBeforeSource = operationSourceFromLedgerPairV1(ledgerPair, liveState);
  const before = placementOperationImage(
    operationImageFromLiveStateV1({
      resource: liveResource,
      state: liveState,
      managed: true,
      source: observedBeforeSource,
    }),
  );
  // D9 retains both portable origin and local-dev facts. Prefer the latter only for retained
  // history comparison when the ledger, source observation, and live content prove it exactly.
  const retainedDevSource =
    ledgerPair !== null &&
    (observedBeforeSource === null || liveState?.placementClass === 'store-linked') &&
    ledgerPair.mode === 'pinned' &&
    ledgerPair.dev != null &&
    ledgerPair.pinned != null &&
    intent.sourceContent !== undefined &&
    resolve(ledgerPair.dev.resolvedPath) === intent.sourceContent.targetIdentity &&
    ledgerPair.pinned.contentHash === intent.sourceContent.contentRevision &&
    liveState?.contentRevision === intent.sourceContent.contentRevision
      ? {
          kind: 'local-dev' as const,
          path: intent.sourceContent.targetIdentity,
          contentHash: intent.sourceContent.contentRevision,
        }
      : null;
  const retainedBefore =
    retainedDevSource === null
      ? before
      : placementOperationImage(
          operationImageFromLiveStateV1({
            resource: liveResource,
            state: liveState,
            managed: true,
            source: retainedDevSource,
          }),
        );
  const retainedHistory =
    ledgerPair?.journal == null
      ? retainedPlacementHistoryInverse(snapshot, intent, retainedBefore, liveResource)
      : null;
  if (retainedHistory !== null) {
    const { inverse: after, current: canonicalBefore, journal } = retainedHistory;
    const kind: ExecutableOperation['kind'] =
      after.kind === 'absent'
        ? 'remove'
        : after.classification === 'dev'
          ? 'link-dev'
          : canonicalBefore.kind === 'absent'
            ? 'install'
            : 'promote';
    const source = after.kind === 'placement' ? after.source : null;
    const target =
      kind === 'link-dev' &&
      after.kind === 'placement' &&
      after.linkTarget?.kind === 'machine-bound'
        ? after.linkTarget.path
        : null;
    if (kind === 'link-dev' && (source?.kind !== 'local-dev' || target === null)) {
      throw new TypeError('placement planning: retained dev rollback history is incomplete');
    }
    if (journal.intent.pairId === null) {
      throw new TypeError('placement planning: retained rollback pair identity is missing');
    }
    const base = placementOperationBase(
      request,
      intent,
      snapshot,
      liveResource,
      kind,
      source,
      target,
      planningContext,
    );
    const operationIdentity = {
      domain: 'skillsmith.operation-identity',
      schemaVersion: 1,
      groupId: journal.intent.groupId,
      pairId: journal.intent.pairId,
      kind,
      skill: intent.skill,
      source,
      tool: intent.tool,
      scope: intent.scope,
    } as const;
    const operationId =
      planningContext === undefined
        ? createOperationId(operationIdentity)
        : createOperationId(operationIdentity, planningContext);
    return {
      ...base,
      groupId: journal.intent.groupId,
      pairId: journal.intent.pairId,
      operationId,
      reversibility: {
        kind: 'conditional',
        retentionResourceIds: [journal.intent.pairId],
      },
      before: canonicalBefore,
      after,
      reason: {
        code: 'rollback-inverse',
        message: `Rollback inverse restores the retained placement for ${intent.skill}.`,
      },
    };
  }
  if (ledgerPair === null) {
    throw new TypeError('placement planning: rollback intent has no retained inverse');
  }
  const rollbackBefore =
    ledgerPair.journal?.before ??
    (ledgerPair.mode === 'pinned' && ledgerPair.dev != null
      ? {
          mode: 'dev' as const,
          symlinkTarget: ledgerPair.dev.resolvedPath,
          liveKind: 'symlink' as const,
        }
      : ledgerPair.mode === 'dev' && ledgerPair.pinned != null
        ? {
            mode: 'pinned' as const,
            storePath: ledgerPair.pinned.storePath,
            contentHash: ledgerPair.pinned.contentHash,
            liveKind:
              ledgerPair.pinned.placement === 'symlink' ? ('symlink' as const) : ('dir' as const),
            ...(ledgerPair.pinned.placement === 'symlink'
              ? { symlinkTarget: ledgerPair.pinned.storePath }
              : {}),
          }
        : null);
  if (rollbackBefore === null) {
    throw new TypeError('placement planning: rollback intent has no retained inverse');
  }
  if (rollbackBefore.mode === 'absent') {
    return {
      ...placementOperationBase(
        request,
        intent,
        snapshot,
        liveResource,
        'remove',
        null,
        null,
        planningContext,
      ),
      before,
      after: { kind: 'absent', resource: liveResource },
      reason: {
        code: 'rollback-inverse',
        message: `Remove the interrupted fresh placement for ${intent.skill}.`,
      },
    };
  }
  if (rollbackBefore.mode === 'dev') {
    if (intent.storeResourceId !== null) {
      throw new TypeError('placement planning: dev rollback must not select a store resource');
    }
    const targetPath = resolve(dirname(liveResource.location.path), rollbackBefore.symlinkTarget);
    if (intent.sourceContent === undefined) {
      throw new TypeError('placement planning: dev rollback source observation is missing');
    }
    const source = {
      kind: 'local-dev' as const,
      path: targetPath,
      contentHash: intent.sourceContent.contentRevision,
    };
    validatePlacementSourceContent(source, intent.sourceContent);
    return {
      ...placementOperationBase(
        request,
        intent,
        snapshot,
        liveResource,
        'link-dev',
        source,
        targetPath,
        planningContext,
      ),
      before,
      after: {
        kind: 'placement',
        resource: liveResource,
        classification: 'dev',
        representation: 'symlink',
        linkTarget: { kind: 'machine-bound', path: targetPath },
        dangling: false,
        source,
        contentHash: source.contentHash,
      },
      reason: {
        code: 'rollback-inverse',
        message: `Restore the retained development placement for ${intent.skill}.`,
      },
    };
  }
  const rollbackLiveKind =
    rollbackBefore.liveKind ??
    (rollbackBefore.symlinkTarget === undefined ? ('dir' as const) : ('symlink' as const));
  if (rollbackLiveKind !== 'dir' && rollbackLiveKind !== 'symlink') {
    throw new TypeError('placement planning: pinned rollback inverse is incomplete');
  }
  if (intent.storeResourceId === null || rollbackBefore.contentHash === null) {
    if (intent.storeResourceId !== null || rollbackBefore.contentHash !== null) {
      throw new TypeError('placement planning: pinned rollback inverse is incomplete');
    }
    const representation = rollbackLiveKind === 'dir' ? 'copy' : 'symlink';
    const linkTarget =
      representation === 'symlink' && rollbackBefore.symlinkTarget !== undefined
        ? {
            kind: 'machine-bound' as const,
            path: resolve(dirname(liveResource.location.path), rollbackBefore.symlinkTarget),
          }
        : null;
    return {
      ...placementOperationBase(
        request,
        intent,
        snapshot,
        liveResource,
        'promote',
        null,
        null,
        planningContext,
      ),
      before,
      after: {
        kind: 'placement',
        resource: liveResource,
        classification: 'pinned',
        representation,
        linkTarget,
        dangling: false,
        source: null,
        contentHash: null,
      },
      reason: {
        code: 'rollback-inverse',
        message: `Restore the retained pinned placement for ${intent.skill}.`,
      },
    };
  }
  const storeFacts = validatePlacementStore(
    intent.storeResourceId,
    rollbackBefore.contentHash as `sha256:${string}`,
    placementStoreObservation(snapshot, intent.storeResourceId),
    true,
  );
  if (storeFacts.path !== rollbackBefore.storePath) {
    throw new TypeError('placement planning: rollback store path differs from retained inverse');
  }
  const source =
    pinnedRollbackSource(ledgerPair, rollbackBefore.contentHash) ??
    (intent.sourceContent !== undefined &&
    intent.sourceContent.contentRevision === rollbackBefore.contentHash
      ? {
          kind: 'local-dev' as const,
          path: intent.sourceContent.targetIdentity,
          contentHash: intent.sourceContent.contentRevision,
        }
      : null);
  if (source === null) {
    throw new TypeError('placement planning: rollback pinned source is incomplete');
  }
  if (source.kind === 'local-dev' && intent.sourceContent !== undefined) {
    validatePlacementSourceContent(source, intent.sourceContent);
  }
  const representation = rollbackLiveKind === 'dir' ? 'copy' : 'symlink';
  if (representation === 'symlink' && rollbackBefore.symlinkTarget === undefined) {
    throw new TypeError('placement planning: pinned rollback symlink target is incomplete');
  }
  return {
    ...placementOperationBase(
      request,
      intent,
      snapshot,
      liveResource,
      'promote',
      source,
      null,
      planningContext,
    ),
    before,
    after: {
      kind: 'placement',
      resource: liveResource,
      classification: 'pinned',
      representation,
      linkTarget:
        representation === 'symlink'
          ? {
              kind: 'machine-bound',
              path: resolve(
                dirname(liveResource.location.path),
                rollbackBefore.symlinkTarget ?? '',
              ),
            }
          : null,
      dangling: false,
      source,
      contentHash: rollbackBefore.contentHash as `sha256:${string}`,
    },
    reason: {
      code: 'rollback-inverse',
      message: `Restore the retained pinned placement for ${intent.skill}.`,
    },
  };
};

const placementChecksFor = (
  request: PlacementPlanRequestV1,
  operations: readonly ExecutableOperation[],
): readonly PlanCheck[] => {
  const intents = request.intents as readonly PlacementIntentIdentityV1[];
  const checks: PlanCheck[] = [];
  for (const operation of operations) {
    const intent = intents.find(
      (candidate) =>
        candidate.skill === operation.skill &&
        candidate.tool === operation.tool &&
        candidate.scope === operation.scope,
    );
    if (intent?.verification === undefined) continue;
    const checkId = operation.requiredCheckIds[0];
    if (checkId === undefined) {
      throw new TypeError('placement planning: verification check identity is missing');
    }
    checks.push({
      checkId,
      blocking: true,
      operationIds: [operation.operationId],
      kind: 'verification',
      tool: intent.tool,
      mode: intent.verification.mode,
      expectedContentHash: intent.verification.expectedContentHash,
    });
  }
  return checks;
};

/**
 * Pure snapshot-bound placement planning seam. `planFlips` remains the compatibility observer
 * while callers migrate their reads into `ObservedStateSnapshotV1`.
 */
export function createPlacementPlan(
  request: PlacementDevPlanRequestV1 | PlacementPromotePlanRequestV1,
  snapshot: ObservedStateSnapshotV1<unknown>,
  planningContext?: PlacementPlanningContext,
): Result<SnapshotBoundOperationPlanV1<'dev' | 'promote'>, SnapshotPlanningErrorV1>;
export function createPlacementPlan<Command extends PlacementRollbackPlanRequestV1['command']>(
  request: Omit<PlacementRollbackPlanRequestV1, 'command'> & Readonly<{ command: Command }>,
  snapshot: ObservedStateSnapshotV1<unknown>,
  planningContext?: PlacementPlanningContext,
): Result<SnapshotBoundOperationPlanV1<Command>, SnapshotPlanningErrorV1>;
export function createPlacementPlan(
  request: PlacementSyncPlanRequestV1,
  snapshot: ObservedStateSnapshotV1<unknown>,
  planningContext?: PlacementPlanningContext,
): Result<SnapshotBoundOperationPlanV1<'sync'>, SnapshotPlanningErrorV1>;
export function createPlacementPlan(
  request: PlacementPlanRequestV1,
  snapshot: ObservedStateSnapshotV1<unknown>,
  planningContext?: PlacementPlanningContext,
): Result<
  SnapshotBoundOperationPlanV1<'dev' | 'promote' | 'sync' | 'undo'>,
  SnapshotPlanningErrorV1
> {
  try {
    if (
      request.schemaVersion !== 1 ||
      (request.command !== 'dev' &&
        request.command !== 'promote' &&
        request.command !== 'sync' &&
        request.command !== 'undo') ||
      ('mode' in request &&
        request.mode !== undefined &&
        request.mode !== 'forward' &&
        request.mode !== 'rollback')
    ) {
      throw new TypeError('placement planning: unsupported request');
    }
    const syncProjections =
      request.command === 'sync'
        ? request.intents.map((intent) =>
            placementSyncProjectionFor(request, intent, snapshot, planningContext),
          )
        : [];
    const plannedOperations: readonly ExecutableOperation[] =
      request.command === 'sync'
        ? syncProjections.flatMap(({ operation }) => (operation === null ? [] : [operation]))
        : request.mode === 'rollback'
          ? request.intents.map((intent) =>
              placementRollbackOperationFor(request, intent, snapshot, planningContext),
            )
          : request.command === 'dev'
            ? request.intents
                .map((intent) =>
                  placementDevOperationFor(request, intent, snapshot, planningContext),
                )
                .filter((operation): operation is ExecutableOperation => operation !== null)
            : request.intents
                .map((intent) =>
                  placementPromoteOperationFor(request, intent, snapshot, planningContext),
                )
                .filter((operation): operation is ExecutableOperation => operation !== null);
    const expectedRevisionIds = placementExpectedRevisionIds(snapshot);
    const compatibilityOperations = (request.compatibilityOperations ?? []).map((operation) => ({
      ...operation,
      preconditionIds: [...new Set([...operation.preconditionIds, ...expectedRevisionIds])],
    }));
    const operations = [...compatibilityOperations, ...plannedOperations];
    const syncDiagnostics = syncProjections.flatMap(({ diagnostics }) => diagnostics);
    const selectedGroupIds =
      request.command === 'sync'
        ? syncProjections.map(({ groupId }) => groupId)
        : operations.map((operation) => operation.groupId);
    const plan = createCanonicalPlacementPlan(
      {
        domain: 'skillsmith.operation-plan',
        schemaVersion: 1,
        command: request.command,
        selection: {
          ...request.selection,
          groupIds: [...new Set(selectedGroupIds)],
        },
        batchPolicy: request.batchPolicy,
        operations,
        checks: placementChecksFor(request, plannedOperations),
        diagnostics: [...(request.diagnostics ?? []), ...syncDiagnostics],
      },
      planningContext,
    );
    return ok(bindOperationPlanToSnapshotV1(snapshot, plan));
  } catch (error) {
    return err(placementPlanningError(error));
  }
}
