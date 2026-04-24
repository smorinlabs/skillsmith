import { describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { saveConfig } from '../../src/config/save.ts';
import { defaultScanEnv } from '../../src/env/default.ts';

const tmpDir = async (name: string): Promise<string> => {
  const d = join('/tmp', `sk-save-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(d, { recursive: true });
  return d;
};

describe('saveConfig', () => {
  test('writes a new user config file', async () => {
    const env = await defaultScanEnv();
    const d = await tmpDir('new');
    const xdgEnv = { ...env, xdg: { ...env.xdg, config: d } };
    const r = await saveConfig(xdgEnv, { scope: 'user', patch: { tool: 'codex' } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const content = await readFile(r.value.file, 'utf8');
      expect(content).toContain('tool');
      expect(content).toContain('codex');
    }
    await rm(d, { recursive: true, force: true });
  });

  test('merges into existing file, preserving other keys', async () => {
    const env = await defaultScanEnv();
    const d = await tmpDir('merge');
    await mkdir(join(d, 'skillsmith'), { recursive: true });
    await writeFile(join(d, 'skillsmith/config.toml'), 'scope = "user"\n');
    const xdgEnv = { ...env, xdg: { ...env.xdg, config: d } };
    const r = await saveConfig(xdgEnv, { scope: 'user', patch: { tool: 'codex' } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const content = await readFile(r.value.file, 'utf8');
      expect(content).toContain('scope');
      expect(content).toContain('tool');
    }
    await rm(d, { recursive: true, force: true });
  });

  test('deletes a key when requested', async () => {
    const env = await defaultScanEnv();
    const d = await tmpDir('delete');
    await mkdir(join(d, 'skillsmith'), { recursive: true });
    await writeFile(join(d, 'skillsmith/config.toml'), 'tool = "codex"\nscope = "user"\n');
    const xdgEnv = { ...env, xdg: { ...env.xdg, config: d } };
    const r = await saveConfig(xdgEnv, { scope: 'user', patch: {}, delete: ['tool'] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const content = await readFile(r.value.file, 'utf8');
      expect(content).not.toContain('tool');
      expect(content).toContain('scope');
    }
    await rm(d, { recursive: true, force: true });
  });
});
