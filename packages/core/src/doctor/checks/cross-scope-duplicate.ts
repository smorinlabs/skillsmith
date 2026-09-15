import type { SupportedTool } from '../../agents/types.ts';
import { listSkills } from '../../scan/list-skills.ts';
import type { Check, Finding } from '../types.ts';

export const crossScopeDuplicate: Check = {
  id: 'cross-scope-duplicate',
  severity: 'warning',
  runsIn: ['doctor'],
  run: async (ctx) => {
    const r = await listSkills(ctx.env, {
      tools: ctx.tools,
      scopes: ctx.scopes,
      duplicatesOnly: true,
      cwd: ctx.cwd,
      envVars: ctx.envVars,
      logger: ctx.logger,
    });
    if (!r.ok) return [];
    const byName = new Map<string, { name: string; tool: SupportedTool; locations: string[] }>();
    for (const s of r.value) {
      const key = `${s.tool}\0${s.name}`;
      if (!byName.has(key)) byName.set(key, { name: s.name, tool: s.tool, locations: [] });
      byName.get(key)?.locations.push(`${s.scope}:${s.path}`);
    }
    const findings: Finding[] = [];
    for (const { name, tool, locations } of byName.values()) {
      findings.push({
        checkId: 'cross-scope-duplicate',
        severity: 'warning',
        title: `'${name}' installed in multiple scopes`,
        tool,
        message: locations.join(', '),
        remediation: "run 'skillsmith list --duplicates' and remove from the unintended scope",
      });
    }
    return findings;
  },
};
