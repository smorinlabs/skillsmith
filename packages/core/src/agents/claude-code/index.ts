import type { InventoryBundle, InventoryIdentitySurface, ToolAdapter } from '../adapter-types.ts';
import { getCommandRoots } from './command-roots.ts';
import { CLAUDE_CODE_VERIFIED_AGAINST, claudeCodeDescriptor } from './descriptor.ts';
import { detect } from './detect.ts';
import { installHint } from './install-hint.ts';
import { claudeCodePlacementBundle } from './placement.ts';
import { getPluginCommandDir, getPluginSkillDir } from './plugin-paths.ts';
import { getSkillRoots } from './skill-roots.ts';
import { verifyClaudeCode } from './verify.ts';

const inventoryIdentity = (surface: InventoryIdentitySurface): string => {
  if (surface.origin.kind !== 'plugin') return surface.name;
  const separator = surface.origin.pluginId.lastIndexOf('@');
  const namespace = surface.origin.pluginId.slice(0, separator);
  if (
    separator <= 0 ||
    separator === surface.origin.pluginId.length - 1 ||
    namespace.length === 0
  ) {
    throw new Error('Claude plugin inventory identity requires plugin-name@marketplace');
  }
  return `${namespace}:${surface.name}`;
};

const resolveInventoryCollision = (
  candidates: readonly InventoryIdentitySurface[],
): string | null => {
  const rank = (scope: InventoryIdentitySurface['scope']): number | null => {
    if (scope === 'managed') return 0;
    if (scope === 'user') return 1;
    if (scope === 'project') return 2;
    return null;
  };
  const ranked = candidates.map((candidate) => ({ candidate, rank: rank(candidate.scope) }));
  if (ranked.some((entry) => entry.rank === null)) return null;
  const best = Math.min(...ranked.map((entry) => entry.rank as number));
  const winners = ranked.filter((entry) => entry.rank === best);
  return winners.length === 1 ? (winners[0]?.candidate.path ?? null) : null;
};

export const claudeCodeAgent: InventoryBundle<'claude-code'> = {
  tool: 'claude-code',
  installHint,
  detect,
  getSkillRoots,
  getCommandRoots,
  getPluginSkillDir,
  getPluginCommandDir,
  inventoryIdentity,
  resolveInventoryCollision,
};

export const claudeCodeAdapter = {
  descriptor: claudeCodeDescriptor,
  inventory: claudeCodeAgent,
  verification: {
    verifiedAgainst: CLAUDE_CODE_VERIFIED_AGAINST,
    modes: ['static', 'deep'],
    verify: verifyClaudeCode,
    gatePolicy: { installDeep: false, promote: 'static', update: 'static' },
    targetManifests: ['.claude-plugin/plugin.json'],
    renderedFacts: {
      deepSkillCoverageSuffix: ' (presence)',
      installStaticNotice: null,
    },
  },
  placement: claudeCodePlacementBundle,
} satisfies ToolAdapter<'claude-code'>;
