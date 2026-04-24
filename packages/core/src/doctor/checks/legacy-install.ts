import { join } from 'node:path';
import type { Check, Finding } from '../types.ts';

export const legacyInstall: Check = {
  id: 'legacy-install',
  severity: 'warning',
  runsIn: ['doctor'],
  run: async (ctx) => {
    const findings: Finding[] = [];
    // Codex deprecated path: $CODEX_HOME/skills (default ~/.codex/skills)
    if (ctx.tools.includes('codex')) {
      const base = ctx.envVars.CODEX_HOME ?? join(ctx.env.homeDir, '.codex');
      const legacyDir = join(base, 'skills');
      if (await ctx.env.fileExists(legacyDir)) {
        const entries = await ctx.env.listDir(legacyDir);
        if (entries.length > 0) {
          findings.push({
            checkId: 'legacy-install',
            severity: 'warning',
            title: 'Codex deprecated skills path in use',
            message: `skills present at ${legacyDir}; the current Codex path is ~/.agents/skills`,
            remediation: 'migrate to ~/.agents/skills (or $HOME/.agents/skills)',
            tool: 'codex',
          });
        }
      }
    }
    return findings;
  },
};
