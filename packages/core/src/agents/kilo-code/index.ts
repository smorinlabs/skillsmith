import type { InventoryBundle, InventoryIdentitySurface, ToolAdapter } from '../adapter-types.ts';
import { getCommandRoots } from './command-roots.ts';
import { kiloCodeDescriptor } from './descriptor.ts';
import { detect } from './detect.ts';
import { installHint } from './install-hint.ts';
import { getPluginCommandDir, getPluginSkillDir } from './plugin-paths.ts';
import { getSkillRoots } from './skill-roots.ts';

const resolveInventoryCollision = (
  candidates: readonly InventoryIdentitySurface[],
): string | null => {
  const isNative = (candidate: InventoryIdentitySurface): boolean =>
    candidate.root.includes('/.kilo/skills');
  if (candidates.some((candidate) => !isNative(candidate))) return null;
  const project = candidates.filter((candidate) => candidate.scope === 'project');
  if (project.length !== 1) return null;
  if (candidates.some((candidate) => candidate.scope !== 'project' && candidate.scope !== 'user')) {
    return null;
  }
  return project[0]?.path ?? null;
};

export const kiloCodeAgent: InventoryBundle<'kilo-code'> = {
  tool: 'kilo-code',
  installHint,
  detect,
  getSkillRoots,
  getCommandRoots,
  getPluginSkillDir,
  getPluginCommandDir,
  resolveInventoryCollision,
};

export const kiloCodeAdapter = {
  descriptor: kiloCodeDescriptor,
  inventory: kiloCodeAgent,
} satisfies ToolAdapter<'kilo-code'>;
