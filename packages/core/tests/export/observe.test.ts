import { describe, expect, test } from 'bun:test';
import type { CurrentApplicationContext } from '../../src/application/types.ts';
import type { ProjectContext } from '../../src/context/types.ts';
import { observeExport } from '../../src/export/observe.ts';
import type { ExportRequest } from '../../src/export/types.ts';

describe('export observation boundary', () => {
  test('turns hostile port exceptions into a sanitized owned failure', async () => {
    const canary = 'machine-local-observation-canary';
    const context = {
      ports: new Proxy(
        {},
        {
          get: () => {
            throw new Error(canary);
          },
        },
      ),
      configuration: {},
      signal: undefined,
    } as unknown as CurrentApplicationContext;
    const project = {
      effectiveCwd: '/project',
      projectRoot: null,
    } as ProjectContext;
    const request = {
      tools: ['claude-code'],
      scope: 'user',
    } as unknown as ExportRequest;
    const result = await observeExport(context, project, request, null);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'export-observation', message: 'export observation failed' },
    });
    expect(JSON.stringify(result)).not.toContain(canary);
  });
});
