import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { ESLint } from 'eslint';

const ROOT = resolve(import.meta.dir, '../../../..');
const lintCommandProbe = async (source: string, relativePath = '__lint_probe.ts') => {
  const eslint = new ESLint({
    cwd: ROOT,
    overrideConfigFile: resolve(ROOT, 'eslint.config.js'),
  });
  const [result] = await eslint.lintText(source, {
    filePath: resolve(ROOT, 'packages/cli/src/commands', relativePath),
  });
  return result?.messages ?? [];
};

describe('command-zone ownership boundary', () => {
  test('rejects environment discovery and every shared runtime composition surface', async () => {
    const forbiddenImports = [
      "import { defaultScanEnv } from '@skillsmith/core';",
      "import '../runtime/context.ts';",
      "import '../runtime/environment.ts';",
      "import '../runtime/interaction.ts';",
      "import '../runtime/io.ts';",
      "import '../runtime/adapter.ts';",
      "import '../runtime/current-renderers.ts';",
      "import '../runtime/command-spec.ts';",
      "import '../runtime/preflight.ts';",
      "import '../spec/index.ts';",
    ];

    const messages = (await lintCommandProbe(forbiddenImports.join('\n'))).filter(
      (message) => message.ruleId === 'no-restricted-imports',
    );

    expect(messages).toHaveLength(forbiddenImports.length);
    expect(messages.map((message) => message.line)).toEqual(
      forbiddenImports.map((_, index) => index + 1),
    );
  });

  test('continues to permit core application types and pure compatibility helpers', async () => {
    const messages = await lintCommandProbe(
      [
        "import { type VerifyReport, defaultInstallDeps } from '@skillsmith/core';",
        'export const compatibility = (report: VerifyReport) => ({ report, defaultInstallDeps });',
      ].join('\n'),
    );

    expect(messages).toEqual([]);
  });

  test('rejects shared runtime ownership imports from nested command modules', async () => {
    const messages = await lintCommandProbe(
      ["import '../../runtime/context.ts';", "import '../../spec/index.ts';"].join('\n'),
      'compatibility/nested-probe.ts',
    );

    expect(messages.filter((message) => message.ruleId === 'no-restricted-imports')).toHaveLength(
      2,
    );
  });
});
