import { toolRegistry } from '../../agents/registry.ts';
import { resolveDataDir, storeRootOf } from '../../place/paths.ts';
import type { Check, Finding } from '../types.ts';

const titleForTool = (tool: string): string =>
  tool
    .split('-')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');

const homeRelativePath = (homeDir: string, path: string): string | null =>
  path.startsWith(`${homeDir}/`) ? path.slice(homeDir.length) : null;

export const legacyInstall: Check = {
  id: 'legacy-install',
  severity: 'warning',
  runsIn: ['doctor'],
  run: async (ctx) => {
    const findings: Finding[] = [];
    const rootsCtx = { cwd: ctx.cwd, configuration: ctx.configuration };
    const storeRoot = storeRootOf(resolveDataDir(ctx.env, ctx.configuration));
    for (const tool of ctx.tools) {
      const placement = toolRegistry.get(tool)?.placement;
      if (placement === undefined) continue;
      const inventory = await placement.list(ctx.env, rootsCtx, storeRoot);
      const legacyDir = inventory.legacyRoot;
      if (legacyDir !== null) {
        if (await ctx.env.fileExists(legacyDir)) {
          const entries = await ctx.env.listDir(legacyDir);
          if (entries.length > 0) {
            const label = titleForTool(tool);
            const currentDir = inventory.currentRoot ?? '';
            const currentSuffix = homeRelativePath(ctx.env.homeDir, currentDir);
            const currentDisplay = currentSuffix === null ? currentDir : `~${currentSuffix}`;
            const currentHome = currentSuffix === null ? currentDir : `$HOME${currentSuffix}`;
            findings.push({
              checkId: 'legacy-install',
              severity: 'warning',
              title: `${label} deprecated skills path in use`,
              message: `skills present at ${legacyDir}; the current ${label} path is ${currentDisplay}`,
              remediation: `migrate to ${currentDisplay} (or ${currentHome})`,
              tool,
            });
          }
        }
      }
    }
    return findings;
  },
};
