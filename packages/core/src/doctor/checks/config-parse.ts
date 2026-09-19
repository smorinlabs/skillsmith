import { loadConfig } from '../../config/load.ts';
import type { Check } from '../types.ts';

export const configParse: Check = {
  id: 'config-parse',
  severity: 'error',
  runsIn: ['doctor', 'check'],
  run: async (ctx) => {
    const r = await loadConfig(ctx.env, {
      configuration: ctx.configuration,
      cwd: ctx.cwd,
      ...(ctx.artifactPair ? { explicitFile: ctx.artifactPair.file } : {}),
      readFile: ctx.env.readText,
    });
    if (r.ok) return [];
    if (r.error.code !== 'config-error') return [];
    return [
      {
        checkId: 'config-parse',
        severity: 'error',
        title: 'config parse failed',
        message: r.error.message,
        remediation: r.error.file
          ? `fix the config at ${r.error.file} and rerun`
          : 'review your SkillSmith config',
      },
    ];
  },
};
