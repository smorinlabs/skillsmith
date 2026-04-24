import { describe, expect, test } from 'bun:test';
import { configFromEnv } from '../../src/config/env.ts';

describe('configFromEnv', () => {
  test('empty env → empty config', () => {
    expect(configFromEnv({})).toEqual({});
  });
  test('SKILLSMITH_TOOL, SKILLSMITH_SCOPE populate top-level', () => {
    expect(configFromEnv({ SKILLSMITH_TOOL: 'codex', SKILLSMITH_SCOPE: 'user' })).toEqual({
      tool: 'codex',
      scope: 'user',
    });
  });
  test('SKILLSMITH_PATH populates path', () => {
    expect(configFromEnv({ SKILLSMITH_PATH: '/x' })).toEqual({ path: '/x' });
  });
  test('SKILLSMITH_REGISTRY populates registry.default', () => {
    expect(configFromEnv({ SKILLSMITH_REGISTRY: 'gh/acme' })).toEqual({
      registry: { default: 'gh/acme' },
    });
  });
  test('ignores unknown SKILLSMITH_* vars', () => {
    expect(configFromEnv({ SKILLSMITH_EXTRA: 'x', SKILLSMITH_TOOL: 'codex' })).toEqual({
      tool: 'codex',
    });
  });
});
