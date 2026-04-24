import { errorMessage } from '../../errors.ts';
import type { Check, Finding } from '../types.ts';

const TIMEOUT_MS = 3000;

export const networkReach: Check = {
  id: 'network-reach',
  severity: 'warning',
  runsIn: ['doctor'],
  run: async (ctx) => {
    if (ctx.offline) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch('https://github.com', {
        method: 'HEAD',
        signal: ctx.signal ?? controller.signal,
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
    } finally {
      clearTimeout(timer);
    }
  },
};
