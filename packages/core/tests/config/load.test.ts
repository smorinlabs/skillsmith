import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../../src/config/load.ts';
import type { ScanEnv } from '../../src/env/types.ts';

const makeEnv = (files: Record<string, string | undefined>): ScanEnv => ({
  homeDir: '/home/u',
  path: [],
  platform: 'linux',
  xdg: { config: '/home/u/.config', data: '/home/u/.local/share', cache: '/home/u/.cache' },
  fileExists: async (p) => p in files,
  realpath: async (p) => p,
  listDir: async () => [],
  readText: async () => '',
  runVersion: async () => 'unknown',
  exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
});

describe('loadConfig', () => {
  test('empty system → returns defaults', async () => {
    const r = await loadConfig(makeEnv({}), { envVars: {}, readFile: async () => '' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.value).toEqual({});
      expect(Object.keys(r.value.sources)).toHaveLength(0);
    }
  });

  test('user file wins over system', async () => {
    const files: Record<string, string> = {
      '/etc/skillsmith/config.toml': 'tool = "codex"\n',
      '/home/u/.config/skillsmith/config.toml': 'tool = "claude-code"\n',
    };
    const env = makeEnv(files);
    const r = await loadConfig(env, { envVars: {}, readFile: async (p) => files[p] ?? '' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.value.tool).toBe('claude-code');
      expect(r.value.sources.tool).toBe('user');
    }
  });

  test('env wins over user', async () => {
    const files: Record<string, string> = {
      '/home/u/.config/skillsmith/config.toml': 'tool = "claude-code"\n',
    };
    const env = makeEnv(files);
    const r = await loadConfig(env, {
      envVars: { SKILLSMITH_TOOL: 'codex' },
      readFile: async (p) => files[p] ?? '',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.value.tool).toBe('codex');
      expect(r.value.sources.tool).toBe('env');
    }
  });

  test('env wins over explicit-file too (per §2.2 precedence)', async () => {
    const files: Record<string, string> = { '/tmp/explicit.toml': 'tool = "claude-code"\n' };
    const env = makeEnv(files);
    const r = await loadConfig(env, {
      envVars: { SKILLSMITH_TOOL: 'codex' },
      explicitFile: '/tmp/explicit.toml',
      readFile: async (p) => files[p] ?? '',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.sources.tool).toBe('env');
  });

  test('malformed user config → config-error', async () => {
    const files: Record<string, string> = {
      '/home/u/.config/skillsmith/config.toml': 'garbage = nope bar\n',
    };
    const env = makeEnv(files);
    const r = await loadConfig(env, { envVars: {}, readFile: async (p) => files[p] ?? '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('config-error');
  });
});
