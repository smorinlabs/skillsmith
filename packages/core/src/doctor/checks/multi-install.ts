import { getAgent } from '../../agents/registry.ts';
import type { Check, Finding } from '../types.ts';

export const multiInstall: Check = {
  id: 'multi-install',
  severity: 'warning',
  runsIn: ['doctor'],
  run: async (ctx) => {
    const findings: Finding[] = [];
    for (const tool of ctx.tools) {
      const a = getAgent(tool);
      if (!a.ok) continue;
      const r = await a.value.detect(ctx.env, ctx.signal);
      if (!r.ok) continue;
      if (r.value.length > 1) {
        findings.push({
          checkId: 'multi-install',
          severity: 'warning',
          title: `${tool} installed in multiple locations`,
          message: r.value.map((i) => `${i.path} (${i.installMethod})`).join(', '),
          remediation: 'prefer a single install method to avoid version skew',
          tool,
        });
      }
    }
    return findings;
  },
};
