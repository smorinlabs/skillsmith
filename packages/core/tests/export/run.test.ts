import { describe, expect, test } from 'bun:test';
import type { CurrentApplicationContext } from '../../src/application/types.ts';
import type { PreparedExportArtifacts } from '../../src/export/merge.ts';
import type { ExportObservation } from '../../src/export/observe.ts';
import { executeExportArtifacts } from '../../src/export/run.ts';

describe('export artifact execution', () => {
  test('byte-identical rerun binds no lock and reports both roles not-run', async () => {
    const context = new Proxy({} as CurrentApplicationContext, {
      get: (_target, property) => {
        throw new Error(`unchanged execution unexpectedly read ${String(property)}`);
      },
    });
    const result = await executeExportArtifacts(
      context,
      {
        pair: { file: {}, lockfile: {} },
        request: { tools: ['claude-code'], scope: 'user' },
      } as unknown as ExportObservation,
      {
        manifestChanged: false,
        manifestAction: 'unchanged',
        lockChanged: false,
        lockAction: 'unchanged',
      } as PreparedExportArtifacts,
    );
    expect(result).toMatchObject({
      ok: true,
      value: [
        { role: 'ledger', action: 'not-written', operationId: null, outcome: 'not-run' },
        { role: 'manifest', action: 'unchanged', operationId: null, outcome: 'not-run' },
        { role: 'lock', action: 'unchanged', operationId: null, outcome: 'not-run' },
      ],
    });
  });
});
