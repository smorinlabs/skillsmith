import type { InventoryBundle, ToolAdapter } from '../adapter-types.ts';
import { getCommandRoots } from './command-roots.ts';
import { CLAUDE_CODE_VERIFIED_AGAINST, claudeCodeDescriptor } from './descriptor.ts';
import { detect } from './detect.ts';
import { installHint } from './install-hint.ts';
import { claudeCodePlacementBundle } from './placement.ts';
import { getPluginCommandDir, getPluginSkillDir } from './plugin-paths.ts';
import { getSkillRoots } from './skill-roots.ts';
import { verifyClaudeCode } from './verify.ts';

export const claudeCodeAgent: InventoryBundle<'claude-code'> = {
  tool: 'claude-code',
  installHint,
  detect,
  getSkillRoots,
  getCommandRoots,
  getPluginSkillDir,
  getPluginCommandDir,
};

export const claudeCodeAdapter = {
  descriptor: claudeCodeDescriptor,
  inventory: claudeCodeAgent,
  verification: {
    verifiedAgainst: CLAUDE_CODE_VERIFIED_AGAINST,
    modes: ['static', 'deep'],
    verify: verifyClaudeCode,
    gatePolicy: { installDeep: false, promote: 'static' },
    targetManifests: ['.claude-plugin/plugin.json'],
    renderedFacts: {
      deepSkillCoverageSuffix: ' (presence)',
      installStaticNotice: null,
    },
  },
  placement: claudeCodePlacementBundle,
} satisfies ToolAdapter<'claude-code'>;
