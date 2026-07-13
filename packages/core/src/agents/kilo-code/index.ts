import type { InventoryBundle, ToolAdapter } from '../adapter-types.ts';
import { getCommandRoots } from './command-roots.ts';
import { kiloCodeDescriptor } from './descriptor.ts';
import { detect } from './detect.ts';
import { installHint } from './install-hint.ts';
import { getPluginCommandDir, getPluginSkillDir } from './plugin-paths.ts';
import { getSkillRoots } from './skill-roots.ts';

export const kiloCodeAgent: InventoryBundle<'kilo-code'> = {
  tool: 'kilo-code',
  installHint,
  detect,
  getSkillRoots,
  getCommandRoots,
  getPluginSkillDir,
  getPluginCommandDir,
};

export const kiloCodeAdapter: ToolAdapter<'kilo-code'> = {
  descriptor: kiloCodeDescriptor,
  inventory: kiloCodeAgent,
};
