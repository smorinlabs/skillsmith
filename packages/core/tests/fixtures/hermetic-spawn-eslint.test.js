import { describe, expect, test } from 'bun:test';
import tsParser from '@typescript-eslint/parser';
import { Linter } from 'eslint';
import { hermeticTestSpawnRule } from '../../../../eslint.config.js';

const verify = (source) => {
  const linter = new Linter({ configType: 'flat' });
  return linter.verify(
    source,
    [
      {
        files: ['**/*.ts'],
        languageOptions: {
          parser: tsParser,
          parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
        },
        plugins: {
          skillsmith: { rules: { 'hermetic-test-spawn': hermeticTestSpawnRule } },
        },
        rules: { 'skillsmith/hermetic-test-spawn': 'error' },
      },
    ],
    { filename: 'spawn-probe.ts' },
  );
};

describe('hermetic test spawn ESLint rule', () => {
  test('accepts a top-level hermetic env, including TypeScript wrappers', () => {
    expect(verify("Bun.spawn(['git'], { env: hermeticGitEnv() } as const);")).toEqual([]);
    expect(verify("Bun.spawnSync(['git'], { env: hermeticGitEnv() });")).toEqual([]);
  });

  test('rejects a missing or non-hermetic env', () => {
    expect(verify("Bun.spawn(['git'], { stdout: 'pipe' });")).toHaveLength(1);
    expect(verify("Bun.spawn(['git'], { env: process.env });")).toHaveLength(1);
  });

  test('rejects a nested hermetic env bypass', () => {
    const messages = verify("Bun.spawn(['git'], { options: { env: hermeticGitEnv() } });");

    expect(messages).toHaveLength(1);
    expect(messages[0]?.ruleId).toBe('skillsmith/hermetic-test-spawn');
  });
});
