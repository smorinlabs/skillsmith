import type { InventoryReadPorts } from '../../ports/types.ts';
import type { PlacementBundle } from '../adapter-types.ts';
import type { SkillRootsCtx } from '../claude-code/skill-roots.ts';
import { type Placement, classifyPlacement, listPlacements } from '../placement-shared.ts';
import { getSkillRoots } from './skill-roots.ts';

export interface CodexPlacementScan {
  placements: Placement[]; // from both roots; current root (~/.agents/skills) listed first
  duplicates: string[]; // skill names present (as flippable classes) in BOTH roots
  legacyRoot: string; // resolved legacy root (~/.codex/skills or $CODEX_HOME/skills)
  currentRoot: string; // resolved current root (~/.agents/skills)
}

export const CODEX_LEGACY_ROOT_NOTICE =
  'codex placement is in the legacy ~/.codex/skills; the current convention is ~/.agents/skills — ' +
  "a future 'skillsmith install' can migrate it";

export const listCodexPlacements = async (
  env: InventoryReadPorts,
  ctx: SkillRootsCtx,
  storeRoot: string,
): Promise<CodexPlacementScan> => {
  const [currentRoot, legacyRoot] = getSkillRoots(env, 'user', ctx);
  if (currentRoot === undefined || legacyRoot === undefined) {
    return { placements: [], duplicates: [], legacyRoot: '', currentRoot: '' };
  }

  const currentPlacements = await listPlacements(env, currentRoot, storeRoot);
  const legacyPlacements = await listPlacements(env, legacyRoot, storeRoot);

  const flippable = (p: Placement): boolean => p.class !== 'absent';
  const currentBySkill = new Map(currentPlacements.map((p) => [p.skill, p]));
  const legacyBySkill = new Map(legacyPlacements.map((p) => [p.skill, p]));

  const duplicates = [...currentBySkill.keys()].filter((skill) => {
    const current = currentBySkill.get(skill);
    const legacy = legacyBySkill.get(skill);
    return current !== undefined && legacy !== undefined && flippable(current) && flippable(legacy);
  });

  return {
    placements: [...currentPlacements, ...legacyPlacements],
    duplicates,
    legacyRoot,
    currentRoot,
  };
};

export const codexPlacementBundle: PlacementBundle = {
  roots: getSkillRoots,
  standardRoots: (env, ctx) => getSkillRoots(env, 'user', ctx),
  list: async (env, ctx, storeRoot) => {
    const scan = await listCodexPlacements(env, ctx, storeRoot);
    return {
      placements: scan.placements,
      duplicates: scan.duplicates,
      currentRoot: scan.currentRoot || null,
      legacyRoot: scan.legacyRoot || null,
    };
  },
  resolve: async (env, ctx, storeRoot, skill) => {
    const [currentRoot = '', legacyRoot = ''] = getSkillRoots(env, 'user', ctx);
    const current = await classifyPlacement(env, currentRoot, skill, storeRoot);
    const legacy = await classifyPlacement(env, legacyRoot, skill, storeRoot);
    const currentPresent = current.class !== 'absent';
    const legacyPresent = legacy.class !== 'absent';
    if (currentPresent && legacyPresent) {
      return {
        placement: current,
        notices: [],
        duplicateReason: `found in both ${currentRoot} and ${legacyRoot}; resolve the duplicate first`,
      };
    }
    if (legacyPresent) {
      return {
        placement: legacy,
        notices: [CODEX_LEGACY_ROOT_NOTICE],
        duplicateReason: null,
      };
    }
    return { placement: current, notices: [], duplicateReason: null };
  },
  noticeForRoot: (root, inventory) =>
    inventory.legacyRoot === root ? CODEX_LEGACY_ROOT_NOTICE : null,
};
