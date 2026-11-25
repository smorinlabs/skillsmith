import type { InventoryBundle, InventoryIdentitySurface, ToolAdapter } from '../adapter-types.ts';
import { getCommandRoots } from './command-roots.ts';
import { ANTIGRAVITY_VERIFIED_AGAINST, antigravityDescriptor } from './descriptor.ts';
import { detect } from './detect.ts';
import { installHint } from './install-hint.ts';
import { antigravityPlacementBundle } from './placement.ts';
import { getPluginCommandDir, getPluginSkillDir } from './plugin-paths.ts';
import { getSkillRoots } from './skill-roots.ts';
import { ANTIGRAVITY_TARGET_MANIFEST, verifyAntigravity } from './verify.ts';

// Verified Antigravity precedence: project roots shadow user roots (with
// `.agents/skills` ahead of `.agent`/`_agents`/`_agent` aliases via
// rootOrdinal), and the native user root (`~/.gemini/config/skills`) shadows
// the `~/.agents/skills` compatibility root.
const precedenceKey = (candidate: InventoryIdentitySurface): readonly [number, number] => {
  const root = candidate.root.replaceAll('\\', '/');
  const native = /(?:^|\/)\.gemini\/config\/skills\/?$/.test(root);
  if (candidate.scope === 'project') return [0, candidate.rootOrdinal];
  if (candidate.scope === 'user' && native) return [1, candidate.rootOrdinal];
  if (candidate.scope === 'user') return [2, candidate.rootOrdinal];
  return [3, candidate.rootOrdinal];
};

const resolveInventoryCollision = (
  candidates: readonly InventoryIdentitySurface[],
): string | null => {
  const ordered = [...candidates].sort((a, b) => {
    const [rankA, ordA] = precedenceKey(a);
    const [rankB, ordB] = precedenceKey(b);
    return rankA - rankB || ordA - ordB;
  });
  return ordered[0]?.path ?? null;
};

export const antigravityAgent: InventoryBundle<'antigravity'> = {
  tool: 'antigravity',
  installHint,
  detect,
  getSkillRoots,
  getCommandRoots,
  getPluginSkillDir,
  getPluginCommandDir,
  resolveInventoryCollision,
};

export const antigravityAdapter = {
  descriptor: antigravityDescriptor,
  inventory: antigravityAgent,
  verification: {
    verifiedAgainst: ANTIGRAVITY_VERIFIED_AGAINST,
    modes: ['static', 'deep'],
    verify: verifyAntigravity,
    gatePolicy: { installDeep: false, promote: 'static', update: 'static' },
    targetManifests: [ANTIGRAVITY_TARGET_MANIFEST],
    renderedFacts: {
      deepSkillCoverageSuffix: ' (presence)',
      installStaticNotice: null,
    },
  },
  placement: antigravityPlacementBundle,
} satisfies ToolAdapter<'antigravity'>;
