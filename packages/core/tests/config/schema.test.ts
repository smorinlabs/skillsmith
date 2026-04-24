import { describe, expect, test } from 'bun:test';
import { parseConfig } from '../../src/config/schema.ts';

describe('parseConfig', () => {
  test('accepts empty TOML', () => {
    const r = parseConfig('');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({});
  });

  test('accepts a valid config with tool, scope, path, registry.default', () => {
    const toml = `
tool = "claude-code"
scope = "user"
path = "/custom"

[registry]
default = "github.com/acme"
`;
    const r = parseConfig(toml);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.tool).toBe('claude-code');
      expect(r.value.scope).toBe('user');
      expect(r.value.path).toBe('/custom');
      expect(r.value.registry?.default).toBe('github.com/acme');
    }
  });

  test('rejects unknown top-level key as config-error', () => {
    const r = parseConfig('garbage = 1\n');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('config-error');
  });

  test('rejects unknown nested key', () => {
    const r = parseConfig('[registry]\nbogus = "x"\n');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('config-error');
  });

  test('rejects invalid tool value', () => {
    const r = parseConfig('tool = "not-a-tool"\n');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('config-error');
  });

  test('rejects malformed TOML syntax', () => {
    const r = parseConfig('this is not = valid toml\n');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('config-error');
  });
});
