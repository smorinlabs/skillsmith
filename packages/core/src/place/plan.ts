import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  claudeCodeSkillRootsUser,
  listClaudeCodePlacements,
} from '../agents/claude-code/placement.ts';
import type { SkillRootsCtx } from '../agents/claude-code/skill-roots.ts';
import { listCodexPlacements } from '../agents/codex/placement.ts';
import { getSkillRoots as getCodexSkillRoots } from '../agents/codex/skill-roots.ts';
import {
  type Placement,
  type PlacementClass,
  classifyPlacement,
} from '../agents/placement-shared.ts';
import type { ScanEnv } from '../env/types.ts';
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

export const LEGACY_ROOT_NOTICE =
  'codex placement is in the legacy ~/.codex/skills; the current convention is ~/.agents/skills — ' +
  "a future 'skillsmith install' can migrate it";

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

interface CodexRoots {
  current: string;
  legacy: string;
}

const codexRootsOf = (env: ScanEnv, ctx: SkillRootsCtx): CodexRoots => {
  const [current, legacy] = getCodexSkillRoots(env, 'user', ctx);
  return { current: current ?? '', legacy: legacy ?? '' };
};

interface ToolResolution {
  placement: Placement;
  notices: string[];
  duplicateReason: string | null;
}

const resolveClaudeCode = async (
  env: ScanEnv,
  ctx: SkillRootsCtx,
  storeRoot: string,
  skill: string,
): Promise<ToolResolution> => {
  const [root] = claudeCodeSkillRootsUser(env, ctx);
  const claudeRoot = root ?? join(env.homeDir, '.claude', 'skills');
  const placement = await classifyPlacement(env, claudeRoot, skill, storeRoot);
  return { placement, notices: [], duplicateReason: null };
};

const resolveCodex = async (
  env: ScanEnv,
  ctx: SkillRootsCtx,
  storeRoot: string,
  skill: string,
): Promise<ToolResolution> => {
  const roots = codexRootsOf(env, ctx);
  const current = await classifyPlacement(env, roots.current, skill, storeRoot);
  const legacy = await classifyPlacement(env, roots.legacy, skill, storeRoot);
  const currentPresent = current.class !== 'absent';
  const legacyPresent = legacy.class !== 'absent';

  if (currentPresent && legacyPresent) {
    return {
      placement: current,
      notices: [],
      duplicateReason: `found in both ${roots.current} and ${roots.legacy}; resolve the duplicate first`,
    };
  }
  if (legacyPresent) {
    return { placement: legacy, notices: [LEGACY_ROOT_NOTICE], duplicateReason: null };
  }
  return { placement: current, notices: [], duplicateReason: null };
};

const searchedRootsDescription = (env: ScanEnv, ctx: SkillRootsCtx): string => {
  const [claudeRoot] = claudeCodeSkillRootsUser(env, ctx);
  const codex = codexRootsOf(env, ctx);
  return [claudeRoot, codex.current, codex.legacy]
    .filter((r): r is string => Boolean(r))
    .join(', ');
};

const resolveNamedTarget = async (
  env: ScanEnv,
  ctx: SkillRootsCtx,
  storeRoot: string,
  target: string,
  toolsInOrder: readonly FlipTool[],
  explicitTools: boolean,
): Promise<{ pairs: PairPlan[]; preResults: FlipResult[] }> => {
  const pairs: PairPlan[] = [];
  const preResults: FlipResult[] = [];
  let anyFlippableFound = false;

  for (const tool of toolsInOrder) {
    const res =
      tool === 'claude-code'
        ? await resolveClaudeCode(env, ctx, storeRoot, target)
        : await resolveCodex(env, ctx, storeRoot, target);

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

    if (!isFlippableClass(res.placement.class)) {
      if (explicitTools) {
        const reason = `'${target}' has no flippable placement for ${tool} (found: ${res.placement.class})`;
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
  env: ScanEnv,
  ctx: SkillRootsCtx,
  storeRoot: string,
  target: string,
  selectedTools: readonly FlipTool[],
  explicitTools: boolean,
): Promise<Result<{ pairs: PairPlan[]; preResults: FlipResult[] }, SkillSmithError>> => {
  const resolved = resolve(ctx.cwd, target);
  const parent = dirname(resolved);
  const skill = basename(resolved);

  const [claudeRoot] = claudeCodeSkillRootsUser(env, ctx);
  const codex = codexRootsOf(env, ctx);

  let tool: FlipTool | null = null;
  let notices: string[] = [];
  let root: string | null = null;
  if (claudeRoot !== undefined && parent === claudeRoot) {
    tool = 'claude-code';
    root = claudeRoot;
  } else if (codex.current !== '' && parent === codex.current) {
    tool = 'codex';
    root = codex.current;
  } else if (codex.legacy !== '' && parent === codex.legacy) {
    tool = 'codex';
    notices = [LEGACY_ROOT_NOTICE];
    root = codex.legacy;
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
  if (!isFlippableClass(placement.class)) {
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

/** Target & tool resolution (spec §5/D2/D3). `opts.op` picks the `--all` flippable class:
 *  `dev` for promote, `pinned` for dev. Named/path targets accept either class (dev.md §4's
 *  convergent no-op / already-dev no-op both need the pair to reach the run layer). `ledger` is
 *  read-only here, consulted only for `dev --all`'s "pinned with a recorded dev source" filter. */
export const planFlips = async (
  env: ScanEnv,
  opts: FlipOptions & { op: FlipOp },
  storeRoot: string,
  ledger: LedgerFile,
): Promise<Result<FlipPlanOutcome, SkillSmithError>> => {
  const ctx: SkillRootsCtx = { cwd: opts.cwd, envVars: opts.envVars };
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
    const flippableClass: PlacementClass = opts.op === 'promote' ? 'dev' : 'pinned';
    const perTool = new Map<FlipTool, Map<string, Placement>>();

    for (const tool of toolsInOrder) {
      if (tool === 'claude-code') {
        const list = await listClaudeCodePlacements(env, ctx, storeRoot);
        const byName = new Map(
          list.filter((p) => p.class === flippableClass).map((p) => [p.skill, p]),
        );
        perTool.set(tool, byName);
        continue;
      }

      const scan = await listCodexPlacements(env, ctx, storeRoot);
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
            'codex',
            join(scan.legacyRoot, dupSkill),
            reason,
            flipRefusedError(reason),
          ),
        );
      }
    }

    const allSkillNames = new Set<string>();
    for (const byName of perTool.values())
      for (const name of byName.keys()) allSkillNames.add(name);

    const codexLegacyRoot = codexRootsOf(env, ctx).legacy;
    for (const skill of [...allSkillNames].sort()) {
      for (const tool of toolsInOrder) {
        const placement = perTool.get(tool)?.get(skill);
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

        const notices =
          tool === 'codex' && placement.root === codexLegacyRoot ? [LEGACY_ROOT_NOTICE] : [];
        pairs.push({ skill, tool, placement, notices });
      }
    }

    return ok({ pairs, preResults });
  }

  for (const target of opts.targets) {
    if (isPathTarget(target)) {
      const resolved = await resolvePathTarget(
        env,
        ctx,
        storeRoot,
        target,
        toolsInOrder,
        explicitTools,
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
    );
    pairs.push(...resolved.pairs);
    preResults.push(...resolved.preResults);
  }

  return ok({ pairs, preResults });
};
