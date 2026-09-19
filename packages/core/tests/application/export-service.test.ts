import { describe, expect, test } from 'bun:test';
import { runExportApplication } from '../../src/application/export-service.ts';
import type { CurrentApplicationContext } from '../../src/application/types.ts';

describe('export application service', () => {
  test('rejects an unknown tool before reading application context', async () => {
    const context = new Proxy({} as CurrentApplicationContext, {
      get: (_target, property) => {
        throw new Error(`invalid selection unexpectedly read ${String(property)}`);
      },
    });
    const outcome = await runExportApplication(
      { arguments: [], options: { tool: ['unknown-tool'] } },
      context,
    );
    expect(outcome).toMatchObject({
      exitClass: 'usage',
      report: {
        artifactSelection: { outcome: 'refused', reason: 'export-invalid-selection' },
      },
      mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
    });
  });

  test('rejects multiple source scopes before discovery', async () => {
    const outcome = await runExportApplication(
      { arguments: [], options: { user: true, project: true } },
      {} as CurrentApplicationContext,
    );
    expect(outcome.exitClass).toBe('usage');
    expect(outcome.report.artifactSelection).toEqual({
      outcome: 'refused',
      reason: 'export-invalid-selection',
    });
  });
});
