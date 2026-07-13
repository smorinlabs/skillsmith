import { describe, expect, test } from 'bun:test';
import {
  classifyConfigDocument,
  parseConfig,
  parseProjectConfig,
} from '../../src/config/schema.ts';

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

describe('project config document boundary', () => {
  test('classifies the closed shape set before reading', () => {
    const cases = [
      ['canonical', 'version = 1\n'],
      ['legacy', 'tool = "codex"\n'],
      ['mixed', 'version = 1\ntool = "codex"\n'],
      ['empty', '# comment only\n'],
      ['malformed', 'tool = [\n'],
      ['unknown', 'mystery = true\n'],
      ['future', 'version = 2\n'],
    ] as const;
    for (const [shape, source] of cases) expect(classifyConfigDocument(source)).toBe(shape);
  });

  test('normalizes canonical plural defaults while retaining scalar singleton compatibility', () => {
    const plural = parseProjectConfig(
      'version = 1\n[defaults]\ntools = ["codex", "claude-code"]\nscope = "project"\npath = "./skills"\n',
    );
    expect(plural.ok).toBeTrue();
    if (plural.ok) {
      expect(plural.value).toMatchObject({ shape: 'canonical', migrationPending: false });
      expect(plural.value.config).toEqual({
        tools: ['claude-code', 'codex'],
        scope: 'project',
        path: './skills',
      });
    }

    const singleton = parseProjectConfig(
      'version = 1\n[defaults]\ntools = ["codex"]\nscope = "project"\n',
    );
    expect(singleton.ok).toBeTrue();
    if (singleton.ok) expect(singleton.value.config.tool).toBe('codex');
  });

  test('rejects duplicate tools and every unreadable project shape', () => {
    for (const source of [
      'version = 1\n[defaults]\ntools = ["codex", "codex"]\n',
      '',
      '# comment only\n',
      'version = 1\ntool = "codex"\n',
      'version = 2\n',
      'unknown = true\n',
    ]) {
      expect(parseProjectConfig(source).ok, source).toBeFalse();
    }
  });

  test('enforces portable stored paths and credential-free registry identities', () => {
    for (const source of [
      'tool = "codex"\npath = "/opt/shared/skills"\n',
      'tool = "codex"\npath = "../escape"\n',
      '[registry]\ndefault = "https://user:secret@github.com/acme"\n',
      '[registry]\ndefault = "github.com/acme?token=secret"\n',
    ]) {
      expect(parseProjectConfig(source).ok, source).toBeFalse();
    }
    expect(
      parseProjectConfig(
        'tool = "codex"\nscope = "project"\npath = "./skills"\n[registry]\ndefault = "https://github.com/acme"\n',
      ).ok,
    ).toBeTrue();
  });

  test('flat user/system config rejects stored credential registries without changing path compatibility', () => {
    expect(parseConfig('path = "/custom"\n').ok).toBeTrue();
    expect(
      parseConfig('[registry]\ndefault = "https://user:secret@github.com/acme"\n').ok,
    ).toBeFalse();
  });
});
