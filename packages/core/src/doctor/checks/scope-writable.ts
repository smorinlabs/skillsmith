import { constants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { getAgent } from '../../agents/registry.ts';
import { errorMessage } from '../../errors.ts';
import type { Check, Finding } from '../types.ts';

export const scopeWritable: Check = {
  id: 'scope-writable',
  severity: 'error',
  runsIn: ['doctor', 'check'],
  run: async (ctx) => {
    const findings: Finding[] = [];
    for (const tool of ctx.tools) {
      const a = getAgent(tool);
      if (!a.ok) continue;
      for (const scope of ctx.scopes) {
        const roots = a.value.getSkillRoots(ctx.env, scope, {
          cwd: ctx.cwd,
          envVars: ctx.envVars,
        });
        for (const root of roots) {
          try {
            await mkdir(root, { recursive: true });
            await access(root, constants.W_OK);
          } catch (e) {
            findings.push({
              checkId: 'scope-writable',
              severity: 'error',
              title: 'skill root not writable',
              message: `${tool}/${scope} root ${root}: ${errorMessage(e)}`,
              remediation: `ensure ${root} exists and is writable, or pass --scope=user`,
              tool,
              scope,
            });
          }
        }
      }
    }
    return findings;
  },
};
