import { errorMessage } from '../../errors.ts';
import type { HttpPort } from '../../ports/types.ts';
import type { Check, Finding } from '../types.ts';

const TIMEOUT_MS = 3000;

export const networkReach: Check = {
  id: 'network-reach',
  severity: 'warning',
  runsIn: ['doctor'],
  run: async (ctx) => {
    if (ctx.offline) return [];
    try {
      const http: HttpPort = ctx.env.http;
      const res = await http.request({
        url: 'https://github.com',
        method: 'HEAD',
        headers: {},
        timeoutMs: TIMEOUT_MS,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      if (res.ok || res.status === 301 || res.status === 302) return [];
      const finding: Finding = {
        checkId: 'network-reach',
        severity: 'warning',
        title: `github.com HTTP ${res.status}`,
        message: `HEAD https://github.com returned ${res.status}`,
      };
      return [finding];
    } catch (e) {
      const finding: Finding = {
        checkId: 'network-reach',
        severity: 'warning',
        title: 'github.com unreachable',
        message: errorMessage(e),
        remediation: 'pass --offline or fix connectivity',
      };
      return [finding];
    }
  },
};
