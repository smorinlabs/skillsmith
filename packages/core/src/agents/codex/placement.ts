import type { InventoryReadPorts } from '../../ports/types.ts';
import type { SkillRootsCtx } from '../claude-code/skill-roots.ts';
import { type Placement, listPlacements } from '../placement-shared.ts';
import { getSkillRoots } from './skill-roots.ts';

export interface CodexPlacementScan {
  placements: Placement[]; // from both roots; current root (~/.agents/skills) listed first
  duplicates: string[]; // skill names present (as flippable classes) in BOTH roots
  legacyRoot: string; // resolved legacy root (~/.codex/skills or $CODEX_HOME/skills)
  currentRoot: string; // resolved current root (~/.agents/skills)
}

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
