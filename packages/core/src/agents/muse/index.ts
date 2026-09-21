import type { InventoryBundle, InventoryIdentitySurface, ToolAdapter } from '../adapter-types.ts';
import { getCommandRoots } from './command-roots.ts';
import { MUSE_VERIFIED_AGAINST, museDescriptor } from './descriptor.ts';
import { detect } from './detect.ts';
import { resolveStandaloneActivation } from './enablement.ts';
import { installHint } from './install-hint.ts';
import { musePlacementBundle } from './placement.ts';
import { getPluginCommandDir, getPluginSkillDir } from './plugin-paths.ts';
import { getSkillRoots } from './skill-roots.ts';
import { MUSE_TARGET_MANIFEST, verifyMuse } from './verify.ts';

// Verified Muse precedence: project shadows user, and the native user root
// shadows the `.agents` compatibility root, including when the winner is
// disabled (no fallback to lower-priority duplicates).
const precedenceRank = (candidate: InventoryIdentitySurface): number => {
  const root = candidate.root.replaceAll('\\', '/');
  const native = /(?:^|\/)muse\/skills\/?$/.test(root);
  if (candidate.scope === 'project') return 0;
  if (candidate.scope === 'user' && native) return 1;
  if (candidate.scope === 'user') return 2;
  return 3;
};

const resolveInventoryCollision = (
  candidates: readonly InventoryIdentitySurface[],
): string | null => {
  const ordered = [...candidates].sort((a, b) => precedenceRank(a) - precedenceRank(b));
  return ordered[0]?.path ?? null;
};

export const museAgent: InventoryBundle<'muse'> = {
  tool: 'muse',
  installHint,
  detect,
  getSkillRoots,
  getCommandRoots,
  getPluginSkillDir,
  getPluginCommandDir,
  resolveInventoryCollision,
  resolveStandaloneActivation,
};

export const museAdapter = {
  descriptor: museDescriptor,
  inventory: museAgent,
  verification: {
    verifiedAgainst: MUSE_VERIFIED_AGAINST,
    modes: ['static', 'deep'],
    verify: verifyMuse,
    gatePolicy: { installDeep: true, promote: 'static+deep', update: 'static+deep' },
    targetManifests: [MUSE_TARGET_MANIFEST],
    renderedFacts: {
      deepSkillCoverageSuffix: null,
      installStaticNotice: null,
    },
  },
  placement: musePlacementBundle,
} satisfies ToolAdapter<'muse'>;
