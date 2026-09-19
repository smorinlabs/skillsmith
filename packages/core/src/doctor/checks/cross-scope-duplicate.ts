import { readSkillInventory } from '../../inventory/read.ts';
import { resolveObservationBundle } from '../../observation/logger-compat.ts';
import type { Check, Finding } from '../types.ts';

export const crossScopeDuplicate: Check = {
  id: 'cross-scope-duplicate',
  severity: 'warning',
  runsIn: ['doctor'],
  run: async (ctx) => {
    const observation = resolveObservationBundle(ctx.observation, ctx.logger, 'diagnostics', [
      ...new Set(ctx.tools),
    ]);
    const r = await readSkillInventory(ctx.env, {
      tools: ctx.tools,
      scopes: ctx.scopes,
      duplicatesOnly: true,
      cwd: ctx.cwd,
      configuration: ctx.configuration,
      observation,
    });
    if (!r.ok) return [];
    const findings: Finding[] = r.value.collisionGroups.map((group) => ({
      checkId: 'cross-scope-duplicate',
      severity: 'warning',
      title: `'${group.name}' has conflicting placements`,
      tool: group.tool,
      message: group.members.map((member) => `${member.scope}:${member.path}`).join(', '),
      remediation: "run 'skillsmith list --duplicates' and remove the unintended placement",
    }));
    return findings;
  },
};
