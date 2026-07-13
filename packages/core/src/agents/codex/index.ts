import type { InventoryBundle, ToolAdapter } from '../adapter-types.ts';
import { getCommandRoots } from './command-roots.ts';
import { CODEX_VERIFIED_AGAINST, codexDescriptor } from './descriptor.ts';
import { detect } from './detect.ts';
import { installHint } from './install-hint.ts';
import { codexPlacementBundle } from './placement.ts';
import { getPluginCommandDir, getPluginSkillDir } from './plugin-paths.ts';
import { getSkillRoots } from './skill-roots.ts';
import { verifyCodex } from './verify.ts';

export const codexAgent: InventoryBundle<'codex'> = {
  tool: 'codex',
  installHint,
  detect,
  getSkillRoots,
  getCommandRoots,
  getPluginSkillDir,
  getPluginCommandDir,
};

export const codexAdapter: ToolAdapter<'codex'> = {
  descriptor: codexDescriptor,
  inventory: codexAgent,
  verification: {
    verifiedAgainst: CODEX_VERIFIED_AGAINST,
    modes: ['static', 'deep'],
    verify: verifyCodex,
    gatePolicy: { installDeep: true, promote: 'static+deep' },
    targetManifests: ['.codex-plugin/plugin.json'],
    renderedFacts: {
      deepSkillCoverageSuffix: null,
      installStaticNotice: (skill) =>
        `codex static checks the manifest only — run 'skillsmith verify ${skill} --deep' for a full load check`,
    },
  },
  placement: codexPlacementBundle,
};
