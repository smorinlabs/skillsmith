import type { Check } from '../types.ts';

export const xdgPaths: Check = {
  id: 'xdg-paths',
  severity: 'error',
  runsIn: ['doctor', 'check'],
  run: async (ctx) => {
    const missing: string[] = [];
    if (!ctx.env.xdg.config) missing.push('XDG_CONFIG_HOME');
    if (!ctx.env.xdg.data) missing.push('XDG_DATA_HOME');
    if (!ctx.env.xdg.cache) missing.push('XDG_CACHE_HOME');
    if (missing.length === 0) return [];
    return [
      {
        checkId: 'xdg-paths',
        severity: 'error',
        title: 'XDG path not resolvable',
        message: `Cannot resolve: ${missing.join(', ')}`,
        remediation: `Set ${missing[0]} or $HOME and rerun.`,
      },
    ];
  },
};
