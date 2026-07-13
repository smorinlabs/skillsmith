import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { PlacementBundle, SkillRootsCtx } from '../agents/adapter-types.ts';
import {
  type Placement,
  type PlacementClass,
  classifyPlacement,
} from '../agents/placement-shared.ts';
import { toolRegistry } from '../agents/registry.ts';
import { type SkillSmithError, flipRefusedError, placementNotFoundError } from '../errors.ts';
import { type Result, err, ok } from '../result.ts';
import { getPair } from './ledger.ts';
import {
  FLIP_TOOLS,
  type FlipOp,
  type FlipOptions,
  type FlipResult,
  type FlipTool,
  type LedgerFile,
  type PlacementReadPorts,
} from './types.ts';

export interface PairPlan {
  skill: string;
  tool: FlipTool;
  placement: Placement;
  notices: string[]; // e.g. legacy-root info
}

export interface FlipPlanOutcome {
  pairs: PairPlan[]; // eligible, in (target-order x tool-order) sequence
  preResults: FlipResult[]; // already-decided results (refusals, skips, not-found)
}

const compatibilityLegacyInventory = {
  placements: [],
  duplicates: [],
  currentRoot: null,
  legacyRoot: '__skillsmith_legacy_root__',
} as const;

/** @deprecated Compatibility view; placement bundles own legacy-root notices. */
export const LEGACY_ROOT_NOTICE = (() => {
  for (const adapter of toolRegistry.adapters) {
    const notice = adapter.placement?.noticeForRoot(
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
  skill: string,
  tool: FlipTool,
  explicitTools: boolean,
): boolean => !explicitTools || getPair(ledger, skill, tool) !== null;

/** A pair carries an uncommitted journal when an earlier swap was interrupted (crash / SIGKILL).
 *  Such a pair must surface into the plan regardless of its current filesystem class — a crash
 *  window can leave the live path absent (backup holds the old artifact) or in the wrong class —
 *  so the run layer's resume/rollback/refuse logic (spec §8.4) stays reachable via every route. */
const hasOpenJournal = (ledger: LedgerFile, skill: string, tool: FlipTool): boolean => {
  const journal = getPair(ledger, skill, tool)?.journal;
  return journal != null && journal.phase !== 'committed';
};

/** P15 (issue #11): a pair is rollbackable when the run layer's direction-agnostic rollback (D10)
 *  can invert it — an uncommitted journal restores the journaled before-state, otherwise a committed
 *  flip is inverted from the retained inverse record (pinned needs a dev record, dev needs a pinned
 *  record). Mirrors `runRollbackPair`'s "nothing to roll back" guard so `--rollback --all` plans
 *  exactly the pairs it will act on, independent of the forward verb's placement-class filter. */
const isRollbackablePair = (ledger: LedgerFile, skill: string, tool: FlipTool): boolean => {
  if (hasOpenJournal(ledger, skill, tool)) return true;
  const pair = getPair(ledger, skill, tool);
  if (pair === null) return false;
  // BF-2: `!= null` (not `!== null`) so a RAW dev-only record whose `pinned` key is OMITTED
  // (undefined) is not selected as rollbackable — a dev-created pair has no pinned state to invert.
  return pair.mode === 'pinned' ? pair.dev != null : pair.pinned != null;
};

const placementBundleFor = (tool: FlipTool): PlacementBundle => {
  const placement = toolRegistry.get(tool)?.placement;
  if (placement === undefined) throw new Error(`tool registry invariant: ${tool} has no placement`);
  return placement;
};

/** The standard user-scope skills roots a tool owns (claude-code: one; codex: current + legacy).
 *  Used to decide whether a ledger-recorded placementPath lives at a CUSTOM location (a `--dest`
 *  create) — BF-1(d). */
const standardRootsFor = (
  env: PlacementReadPorts,
  ctx: SkillRootsCtx,
  tool: FlipTool,
): readonly string[] => placementBundleFor(tool).standardRoots(env, ctx);

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
  env: PlacementReadPorts,
  ctx: SkillRootsCtx,
  storeRoot: string,
  skill: string,
  tool: FlipTool,
): Promise<ToolResolution> =>
  placementBundleFor(tool)
    .resolve(env, ctx, storeRoot, skill)
    .then((resolution) => ({ ...resolution, notices: [...resolution.notices] }));

const searchedRootsDescription = (env: PlacementReadPorts, ctx: SkillRootsCtx): string => {
  return FLIP_TOOLS.flatMap((tool) => standardRootsFor(env, ctx, tool)).join(', ');
};

const resolveNamedTarget = async (
  env: PlacementReadPorts,
  ctx: SkillRootsCtx,
  storeRoot: string,
  target: string,
  toolsInOrder: readonly FlipTool[],
  explicitTools: boolean,
  ledger: LedgerFile,
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
      const normal = await classifyForTool(env, ctx, storeRoot, target, tool);
      const hasPair = getPair(ledger, target, tool) !== null;
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
      res = await classifyForTool(env, ctx, storeRoot, target, tool);
      // BF-1(d): the ledger is the source of truth for a placement's LOCATION. When the standard
      // roots don't hold it but a ledger pair records a placement at a CUSTOM location (a `--dest`
      // create), classify THERE so promote/dev/uninstall stay able to manage it for its whole life.
      if (res.placement.class === 'absent') {
        const recorded = getPair(ledger, target, tool)?.placementPath;
        if (recorded && !standardRootsFor(env, ctx, tool).includes(dirname(recorded))) {
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
        isStoreLinkedFlippableFor(ledger, target, tool, explicitTools)) ||
      // P13 S1/S6: with `--source`, an absent placement routes to the run layer for create (or a
      // foreign-object refusal when a real file already occupies the placement path).
      (withSource && res.placement.class === 'absent');

    if (!flippableNow) {
      // A journaled pair surfaces even when its live path is absent/wrong-class (F1), so the run
      // layer can resume/rollback/refuse it. Committed/absent-journal pairs keep prior behavior.
      if (hasOpenJournal(ledger, target, tool)) {
        anyFlippableFound = true;
        pairs.push({ skill: target, tool, placement: res.placement, notices: res.notices });
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
    pairs.push({ skill: target, tool, placement: res.placement, notices: res.notices });
  }

  if (!anyFlippableFound && !explicitTools) {
    const reason = `no placement found for '${target}'; searched: ${searchedRootsDescription(env, ctx)}`;
    preResults.push(emptyFlipResult(target, null, null, reason, placementNotFoundError(reason)));
  }

  return { pairs, preResults };
};

const resolvePathTarget = async (
  env: PlacementReadPorts,
  ctx: SkillRootsCtx,
  storeRoot: string,
  target: string,
  selectedTools: readonly FlipTool[],
  explicitTools: boolean,
  ledger: LedgerFile,
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
  for (const candidate of FLIP_TOOLS) {
    const bundle = placementBundleFor(candidate);
    const candidateRoot = bundle.standardRoots(env, ctx).find((value) => value === parent);
    if (candidateRoot === undefined) continue;
    const inventory = await bundle.list(env, ctx, storeRoot);
    const notice = bundle.noticeForRoot(candidateRoot, inventory);
    tool = candidate;
    notices = notice === null ? [] : [notice];
    root = candidateRoot;
    break;
  }
  if (tool === null) {
    // BF-1(d): a custom-location path (outside every standard root) is still managed if the ledger
    // records a pair at exactly this placementPath (a `--dest` create). The ledger owns LOCATION.
    for (const t of FLIP_TOOLS) {
      if (getPair(ledger, skill, t)?.placementPath === resolved) {
        tool = t;
        root = parent;
        break;
      }
    }
  }

  if (tool === null || root === null) {
    const reason = `'${target}' is outside every known skills root (${searchedRootsDescription(env, ctx)})`;
    return err(flipRefusedError(reason));
  }

  if (explicitTools && !selectedTools.includes(tool)) {
    const reason = `'${target}' resolves to ${tool}, which is not in the requested --tool set`;
    return ok({
      pairs: [],
      preResults: [emptyFlipResult(skill, tool, resolved, reason, placementNotFoundError(reason))],
    });
  }

  const placement = await classifyPlacement(env, root, skill, storeRoot);
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
  if (!flippable && !hasOpenJournal(ledger, skill, tool)) {
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

  return ok({ pairs: [{ skill, tool, placement, notices }], preResults: [] });
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
export const planFlips = async (
  env: PlacementReadPorts,
  opts: FlipOptions & { op: FlipOp },
  storeRoot: string,
  ledger: LedgerFile,
): Promise<Result<FlipPlanOutcome, SkillSmithError>> => {
  const ctx: SkillRootsCtx = { cwd: opts.cwd, configuration: opts.configuration };
  const requestedTools = opts.tools;
  const explicitTools = requestedTools !== undefined && requestedTools.length > 0;
  const selectedTools: FlipTool[] =
    requestedTools !== undefined && requestedTools.length > 0
      ? [...requestedTools]
      : [...FLIP_TOOLS];
  const toolsInOrder = FLIP_TOOLS.filter((t) => selectedTools.includes(t));

  const pairs: PairPlan[] = [];
  const preResults: FlipResult[] = [];

  if (opts.all) {
    // P15 (issue #11): bulk rollback is direction-agnostic (D10). Select each pair by its OWN
    // rollbackable state — NOT the forward verb's placement-class filter below, which made
    // `promote --rollback --all` (dev class) and `dev --rollback --all` (pinned class) choose
    // opposite, non-overlapping sets. The run layer inverts each pair from its retained records
    // regardless of the verb, so the plan must offer exactly the pairs that layer can invert.
    if (opts.rollback) {
      for (const skill of Object.keys(ledger.skills).sort()) {
        for (const tool of toolsInOrder) {
          if (!isRollbackablePair(ledger, skill, tool)) continue;
          // BF-1(d)/R3: the ledger owns a placement's LOCATION unconditionally. Classify — and later
          // swap — at the pair's RECORDED placementPath, NOT the standard root. A same-name real
          // artifact that appears at the standard root is UNMANAGED and must never be touched: the
          // pre-fix order classified the standard root FIRST and fell back to the recorded path only
          // when standard was absent, so such an artifact hijacked the pair — mutating the unrelated
          // artifact and orphaning the custom placement. When the recorded path IS a standard root,
          // classifyForTool yields the identical placement (plus codex current/legacy handling), so
          // standard-recorded pairs are unaffected.
          const recorded = getPair(ledger, skill, tool)?.placementPath;
          const res: ToolResolution =
            recorded && !standardRootsFor(env, ctx, tool).includes(dirname(recorded))
              ? {
                  placement: await classifyPlacement(env, dirname(recorded), skill, storeRoot),
                  notices: [],
                  duplicateReason: null,
                }
              : await classifyForTool(env, ctx, storeRoot, skill, tool);
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
          pairs.push({ skill, tool, placement: res.placement, notices: res.notices });
        }
      }
      return ok({ pairs, preResults });
    }

    const flippableClass: PlacementClass = opts.op === 'promote' ? 'dev' : 'pinned';
    const perTool = new Map<FlipTool, Map<string, Placement>>();
    const inventories = new Map<FlipTool, Awaited<ReturnType<PlacementBundle['list']>>>();

    for (const tool of toolsInOrder) {
      const bundle = placementBundleFor(tool);
      const scan = await bundle.list(env, ctx, storeRoot);
      inventories.set(tool, scan);
      const byName = new Map<string, Placement>();
      for (const p of scan.placements) {
        if (p.class !== flippableClass) continue;
        if (scan.duplicates.includes(p.skill)) continue;
        if (!byName.has(p.skill)) byName.set(p.skill, p);
      }
      perTool.set(tool, byName);

      for (const dupSkill of scan.duplicates) {
        // Only relevant to this op's --all set when at least one side actually carries the
        // class this op flips; a both-pinned duplicate is noise for `promote --all`, for example.
        const relevant = scan.placements.some(
          (p) => p.skill === dupSkill && p.class === flippableClass,
        );
        if (!relevant) continue;
        const reason = `found in both ${scan.currentRoot} and ${scan.legacyRoot}; resolve the duplicate first`;
        preResults.push(
          emptyFlipResult(
            dupSkill,
            tool,
            join(scan.legacyRoot ?? scan.currentRoot ?? '', dupSkill),
            reason,
            flipRefusedError(reason),
          ),
        );
      }
    }

    const allSkillNames = new Set<string>();
    for (const byName of perTool.values())
      for (const name of byName.keys()) allSkillNames.add(name);
    // F1: also consider any skill whose ledger pair carries an uncommitted journal for a selected
    // tool, even when the filesystem scan missed it (a crash window can leave the live path absent,
    // so it never appears in the placement listing — nor in the wrong class the op filters for).
    for (const skill of Object.keys(ledger.skills))
      if (toolsInOrder.some((tool) => hasOpenJournal(ledger, skill, tool)))
        allSkillNames.add(skill);

    for (const skill of [...allSkillNames].sort()) {
      for (const tool of toolsInOrder) {
        const placement = perTool.get(tool)?.get(skill);
        const bundle = placementBundleFor(tool);
        const inventory = inventories.get(tool);
        if (inventory === undefined) {
          throw new Error(`tool registry invariant: ${tool} placement inventory is missing`);
        }

        // A journaled pair surfaces regardless of filesystem class or the op's dev-source filter,
        // so the run layer's resume/rollback/refuse logic remains reachable (F1).
        if (hasOpenJournal(ledger, skill, tool)) {
          const p =
            placement ?? (await classifyForTool(env, ctx, storeRoot, skill, tool)).placement;
          const notice = bundle.noticeForRoot(p.root, inventory);
          const notices = notice === null ? [] : [notice];
          pairs.push({ skill, tool, placement: p, notices });
          continue;
        }

        if (!placement) continue;

        if (opts.op === 'dev' && !getPair(ledger, skill, tool)?.dev?.sourcePath) {
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

        const notice = bundle.noticeForRoot(placement.root, inventory);
        const notices = notice === null ? [] : [notice];
        pairs.push({ skill, tool, placement, notices });
      }
    }

    return ok({ pairs, preResults });
  }

  // BF-1(b): resolve `--dest` to an ABSOLUTE, normalized path once, so the recorded placementPath is
  // never relative and join(dest, leaf) is contained under it.
  const resolvedDest = opts.dest !== undefined ? resolve(ctx.cwd, opts.dest) : undefined;

  for (const target of opts.targets) {
    if (isPathTarget(target)) {
      const resolved = await resolvePathTarget(
        env,
        ctx,
        storeRoot,
        target,
        toolsInOrder,
        explicitTools,
        ledger,
        opts.source !== undefined,
      );
      if (!resolved.ok) return resolved;
      pairs.push(...resolved.value.pairs);
      preResults.push(...resolved.value.preResults);
      continue;
    }
    const resolved = await resolveNamedTarget(
      env,
      ctx,
      storeRoot,
      target,
      toolsInOrder,
      explicitTools,
      ledger,
      opts.source !== undefined,
      resolvedDest,
    );
    pairs.push(...resolved.pairs);
    preResults.push(...resolved.preResults);
  }

  return ok({ pairs, preResults });
};
