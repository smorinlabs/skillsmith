import { getAgent } from '../../agents/registry.ts';
import { detectionPortsWithoutVersionProbe } from '../run.ts';
import type { Check, Finding } from '../types.ts';

export const toolDetected: Check = {
  id: 'tool-detected',
  severity: 'warning',
  runsIn: ['doctor'],
  run: async (ctx) => {
    const findings: Finding[] = [];
    for (const tool of ctx.tools) {
      const a = getAgent(tool);
      if (!a.ok) continue;
      const r = await a.value.detect(detectionPortsWithoutVersionProbe(ctx.env), ctx.signal);
      if (!r.ok || r.value.length === 0) {
        findings.push({
          checkId: 'tool-detected',
          severity: 'warning',
          title: `${tool} not installed`,
          message: `no ${tool} binary found on PATH or well-known locations`,
          remediation: a.value.installHint,
          tool,
        });
      }
    }
    return findings;
  },
};
