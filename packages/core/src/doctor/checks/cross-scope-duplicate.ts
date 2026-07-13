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
      configuration: ctx.configuration,
      logger: ctx.logger,
    });
    if (!r.ok) return [];
    const byName = new Map<string, string[]>();
    for (const s of r.value) {
      if (!byName.has(s.name)) byName.set(s.name, []);
      byName.get(s.name)?.push(`${s.scope}:${s.path}`);
    }
    const findings: Finding[] = [];
    for (const [name, locations] of byName) {
      findings.push({
        checkId: 'cross-scope-duplicate',
        severity: 'warning',
        title: `'${name}' installed in multiple scopes`,
        message: locations.join(', '),
        remediation: "run 'skillsmith list --duplicates' and remove from the unintended scope",
      });
    }
    return findings;
  },
};
