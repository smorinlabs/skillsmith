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
  test('drops unsafe registry environment values before they enter configuration', () => {
    for (const value of [
      'https://user:secret@github.com/acme',
      'github.com/acme?token=secret',
      'github.com/acme#fragment',
      'github.com/acme%2fsecret',
    ]) {
      expect(configFromEnv({ SKILLSMITH_REGISTRY: value })).toEqual({});
    }
  });
  test('ignores unknown SKILLSMITH_* vars', () => {
    expect(configFromEnv({ SKILLSMITH_EXTRA: 'x', SKILLSMITH_TOOL: 'codex' })).toEqual({
      tool: 'codex',
    });
  });
  test('drops SKILLSMITH_TOOL when value is not a supported tool', () => {
    expect(configFromEnv({ SKILLSMITH_TOOL: 'bogus' })).toEqual({});
  });
  test('drops SKILLSMITH_SCOPE when value is not a valid scope', () => {
    expect(configFromEnv({ SKILLSMITH_SCOPE: 'root' })).toEqual({});
  });
  test('accepts valid tool even alongside invalid scope', () => {
    expect(configFromEnv({ SKILLSMITH_TOOL: 'claude-code', SKILLSMITH_SCOPE: 'root' })).toEqual({
      tool: 'claude-code',
    });
  });
});
