import { describe, expect, test } from 'bun:test';
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { saveConfig } from '../../src/config/save.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';

const tmpDir = async (name: string): Promise<string> => {
  const d = join('/tmp', `sk-save-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(d, { recursive: true });
  return d;
};

describe('saveConfig', () => {
  test('writes a new user config file', async () => {
    const env = await defaultRuntimePorts();
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
    const env = await defaultRuntimePorts();
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
    const env = await defaultRuntimePorts();
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

  test('losslessly edits canonical CRLF bytes and preserves regular-file mode', async () => {
    const env = await defaultRuntimePorts();
    const d = await tmpDir('canonical');
    const file = join(d, 'team.toml');
    const before =
      '# retained\r\nversion = 1\r\n\r\n[defaults]\r\n"tools"\t=\t[ "codex", \'opencode\', ] # selected\r\nscope = "project"\r\n';
    const after = before.replace('[ "codex", \'opencode\', ]', '[ "claude-code", ]');
    await writeFile(file, before);
    await chmod(file, 0o640);

    const result = await saveConfig(env, {
      scope: 'project',
      file,
      patch: { tool: 'claude-code' },
    });
    expect(result).toMatchObject({ ok: true, value: { file, changed: true, unchanged: false } });
    expect(await readFile(file, 'utf8')).toBe(after);
    expect((await stat(file)).mode & 0o777).toBe(0o640);
    expect((await readdir(d)).sort()).toEqual(['team.toml']);
    await rm(d, { recursive: true, force: true });
  });

  test('returns an exact no-op without staging or reserializing human content', async () => {
    const env = await defaultRuntimePorts();
    const d = await tmpDir('noop');
    const directory = join(d, 'skillsmith');
    const file = join(directory, 'config.toml');
    const before = '# retained\ntool  =  "codex" # selected\n';
    await mkdir(directory, { recursive: true });
    await writeFile(file, before);
    const identity = (await env.readFileMetadata(file)).identity;

    const result = await saveConfig(
      { ...env, xdg: { ...env.xdg, config: d } },
      {
        scope: 'user',
        patch: { tool: 'codex' },
      },
    );
    expect(result).toEqual({ ok: true, value: { file, changed: false, unchanged: true } });
    expect(await readFile(file, 'utf8')).toBe(before);
    expect((await env.readFileMetadata(file)).identity).toBe(identity);
    await rm(d, { recursive: true, force: true });
  });

  test('migrates exact legacy project bytes in the same missing-key unset edit', async () => {
    const env = await defaultRuntimePorts();
    const d = await tmpDir('migration');
    const file = join(d, 'skillsmith.toml');
    await writeFile(
      file,
      '# retained owner\ntool = "codex"\nscope = "project"\npath = "./skills"\n',
    );
    const result = await saveConfig(env, {
      scope: 'project',
      file,
      delete: ['registry.default'],
    });
    expect(result).toMatchObject({
      ok: true,
      value: { changed: true, unchanged: false, operation: 'migrate-project-config' },
    });
    expect(await readFile(file, 'utf8')).toBe(
      '# retained owner\nversion = 1\n\n[defaults]\ntools = ["codex"]\nscope = "project"\npath = "./skills"\n',
    );
    expect(await readdir(d)).toEqual(['skillsmith.toml']);
    await rm(d, { recursive: true, force: true });
  });

  test('classifies rename permission denial and cleans the staged file', async () => {
    const env = await defaultRuntimePorts();
    const d = await tmpDir('permission');
    const file = join(d, 'config.toml');
    const before = 'tool = "codex"\n';
    await writeFile(file, before);
    const denied = {
      ...env,
      rename: async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      },
    };
    const result = await saveConfig(denied, {
      scope: 'user',
      file,
      patch: { tool: 'opencode' },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'permission-denied', path: file } });
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(await readdir(d)).toEqual(['config.toml']);
    await rm(d, { recursive: true, force: true });
  });

  test('refuses unsafe editor shapes without touching the destination', async () => {
    const env = await defaultRuntimePorts();
    for (const [label, before] of [
      [
        'duplicate',
        'version = 1\n[defaults]\ntools = ["codex"]\ntools = ["opencode"]\nscope = "project"\n',
      ],
      [
        'reopened',
        'version = 1\n[defaults]\ntools = ["codex"]\nscope = "project"\n[defaults]\npath = "./skills"\n',
      ],
      ['multiline', 'version = 1\n[defaults]\ntools = [\n  "codex",\n]\nscope = "project"\n'],
    ] as const) {
      const d = await tmpDir(`unsafe-${label}`);
      const file = join(d, 'skillsmith.toml');
      await writeFile(file, before);
      const result = await saveConfig(env, {
        scope: 'project',
        file,
        patch: { tool: 'claude-code' },
      });
      expect(result.ok, label).toBeFalse();
      expect(await readFile(file, 'utf8')).toBe(before);
      expect(await readdir(d)).toEqual(['skillsmith.toml']);
      await rm(d, { recursive: true, force: true });
    }
  });
});
