import type { InventoryBundle, ToolAdapter } from '../adapter-types.ts';
import { getCommandRoots } from './command-roots.ts';
import { opencodeDescriptor } from './descriptor.ts';
import { detect } from './detect.ts';
import { installHint } from './install-hint.ts';
import { getPluginCommandDir, getPluginSkillDir } from './plugin-paths.ts';
import { getSkillRoots } from './skill-roots.ts';

export const opencodeAgent: InventoryBundle<'opencode'> = {
  tool: 'opencode',
  installHint,
  detect,
  getSkillRoots,
  getCommandRoots,
  getPluginSkillDir,
  getPluginCommandDir,
  resolveInventoryCollision: () => null,
};

export const opencodeAdapter = {
  descriptor: opencodeDescriptor,
  inventory: opencodeAgent,
} satisfies ToolAdapter<'opencode'>;
