import { describe, expect, test } from 'bun:test';
import { runInitApplication } from '../../src/application/init-service.ts';
import type { CurrentApplicationContext } from '../../src/application/types.ts';

describe('init application service', () => {
  test('rejects unknown tools and conflicting scopes before reading context', async () => {
    const context = new Proxy({} as CurrentApplicationContext, {
      get: (_target, property) => {
        throw new Error(`invalid init selection unexpectedly read ${String(property)}`);
      },
    });
    for (const options of [{ tool: ['unknown'] }, { user: true, project: true }]) {
      const outcome = await runInitApplication({ arguments: [], options }, context);
      expect(outcome).toMatchObject({
        report: null,
        exitClass: 'usage',
        mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
      });
    }
  });

  test('rejects a recognized read-only tool as capability before context reads', async () => {
    const outcome = await runInitApplication(
      { arguments: [], options: { tool: ['kilo-code'] } },
      {} as CurrentApplicationContext,
    );
    expect(outcome).toMatchObject({
      report: null,
      exitClass: 'capability',
      diagnostics: [{ code: 'capability' }],
    });
  });
});
