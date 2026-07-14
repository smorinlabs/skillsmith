import { describe, expect, test } from 'bun:test';
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactCoordinatorPorts } from '../../src/artifacts/coordinator-types.ts';
import { createTestNodeArtifactCoordinatorPorts } from '../../src/artifacts/node-coordinator.ts';
import { saveConfig } from '../../src/config/save.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';

const saveConfigWithCoordinator = saveConfig as unknown as (
  ports: Parameters<typeof saveConfig>[0],
  opts: Parameters<typeof saveConfig>[1],
  coordinator: ArtifactCoordinatorPorts,
) => ReturnType<typeof saveConfig>;

const tmpDir = async (name: string): Promise<string> => {
  const d = join(
    '/tmp',
    `skillsmith-save-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(d, { recursive: true });
  return d;
};

describe('saveConfig', () => {
  test('uses the injected coordinator root without selecting the account-global adapter', async () => {
    const env = await defaultRuntimePorts();
    const root = await tmpDir('injected-coordinator');
    const file = join(root, 'config.toml');
    const coordinationRoot = join(root, 'coordination');
    const delegate = await createTestNodeArtifactCoordinatorPorts(coordinationRoot);
    const lockTargets: string[] = [];
    const withFileLock: ArtifactCoordinatorPorts['withFileLock'] = async (
      target,
      options,
      operation,
    ) => {
      lockTargets.push(target);
      return delegate.withFileLock(target, options, operation);
    };
    const coordinator: ArtifactCoordinatorPorts = Object.freeze({
      ...delegate,
      withFileLock,
    });

    const result = await saveConfigWithCoordinator(
      env,
      { scope: 'user', file, patch: { tool: 'codex' } },
      coordinator,
    );

    expect(result).toEqual({ ok: true, value: { file, changed: true, unchanged: false } });
    expect(await readFile(file, 'utf8')).toContain('tool = "codex"');
    expect(lockTargets).toContain(join(coordinationRoot, 'global'));
    expect(lockTargets).toContain(file);
    expect(
      lockTargets.every((target) => target === file || target.startsWith(`${coordinationRoot}/`)),
    ).toBeTrue();
    await rm(root, { recursive: true, force: true });
  });

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

  test('unset removes only key/value syntax while preserving inline trivia byte-for-byte', async () => {
    const env = await defaultRuntimePorts();
    for (const [label, scope, before, after] of [
      [
        'flat-lf',
        'user',
        '# owner\ntool = "codex" # why selected\nscope = "user"\n',
        '# owner\n # why selected\nscope = "user"\n',
      ],
      [
        'flat-crlf-quoted',
        'user',
        '# owner\r\n  "tool"\t=\t"codex"  # why selected\r\nscope = "user"\r\n',
        '# owner\r\n    # why selected\r\nscope = "user"\r\n',
      ],
      ['flat-no-final-newline', 'user', 'tool = "codex" # why selected', ' # why selected'],
      [
        'project-lf-quoted',
        'project',
        'version = 1\n[defaults]\n"tools" = ["codex"] # why selected\nscope = "project"\n',
        'version = 1\n[defaults]\n # why selected\nscope = "project"\n',
      ],
      [
        'project-crlf',
        'project',
        'version = 1\r\n[defaults]\r\ntools = ["codex"]\t# why selected\r\n',
        'version = 1\r\n[defaults]\r\n\t# why selected\r\n',
      ],
    ] as const) {
      const d = await tmpDir(`unset-inline-${label}`);
      const file = join(d, scope === 'project' ? 'skillsmith.toml' : 'config.toml');
      await writeFile(file, before);

      const result = await saveConfig(env, { scope, file, delete: ['tool'] });
      expect(result.ok, label).toBeTrue();
      expect(await readFile(file, 'utf8'), label).toBe(after);
      expect(await readdir(d), label).toEqual([
        scope === 'project' ? 'skillsmith.toml' : 'config.toml',
      ]);
      await rm(d, { recursive: true, force: true });
    }
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

  test('range-migrates legacy newline/mode variants without losing registry or trailing bytes', async () => {
    const env = await defaultRuntimePorts();
    for (const [label, newline, mode, finalNewline] of [
      ['lf-600', '\n', 0o600, true],
      ['crlf-640', '\r\n', 0o640, true],
      ['lf-644-no-final', '\n', 0o644, false],
    ] as const) {
      const d = await tmpDir(`migration-${label}`);
      const file = join(d, 'skillsmith.toml');
      const suffix = finalNewline ? newline : '';
      const before =
        [
          '# retained owner',
          "'tool'\t=\t'codex' # selected",
          "scope  =  'project'",
          'path = "./skills"',
          '',
          '# registry attachment retained',
          '[registry] # team',
          '"default"\t=\t"https://github.com/acme" # identity',
          '# trailing bytes retained',
        ].join(newline) + suffix;
      const expected = before
        .replace(
          "'tool'\t=\t'codex' # selected",
          `version = 1${newline}${newline}[defaults]${newline}'tools'\t=\t['codex'] # selected`,
        )
        .replace('"https://github.com/acme"', '"github.com/acme"');
      await writeFile(file, before);
      await chmod(file, mode);

      const result = await saveConfig(env, {
        scope: 'project',
        file,
        patch: { scope: 'project' },
      });
      expect(result.ok, label).toBeTrue();
      expect(await readFile(file, 'utf8')).toBe(expected);
      expect((await stat(file)).mode & 0o777).toBe(mode);
      expect((await readFile(file, 'utf8')).match(/\[registry]/g)).toHaveLength(1);
      expect(await readdir(d)).toEqual(['skillsmith.toml']);
      await rm(d, { recursive: true, force: true });
    }
  });

  test('uses valid TOML quoting when a replacement contains an apostrophe', async () => {
    const env = await defaultRuntimePorts();
    const d = await tmpDir('apostrophe');
    const file = join(d, 'skillsmith.toml');
    await writeFile(
      file,
      "version = 1\n[defaults]\ntools = ['codex']\nscope = 'project'\npath = './skills'\n",
    );
    const result = await saveConfig(env, {
      scope: 'project',
      file,
      patch: { path: "./team's-skills" },
    });
    expect(result.ok).toBeTrue();
    expect(await readFile(file, 'utf8')).toContain('path = "./team\'s-skills"');
    await rm(d, { recursive: true, force: true });
  });

  test('refuses ambiguous comment/table attachment with a deterministic secret-safe patch', async () => {
    const env = await defaultRuntimePorts();
    const canary = 'P17_EDITOR_COMMENT_CANARY';
    for (const [label, before] of [
      [
        'between-tables',
        `version = 1\n[defaults]\nscope = "project"\n# ${canary}\n[registry]\ndefault = "github.com/acme"\n`,
      ],
      [
        'before-appended-table',
        `version = 1\n[registry]\ndefault = "github.com/acme"\n# ${canary}\n`,
      ],
    ] as const) {
      const d = await tmpDir(`attachment-${label}`);
      const file = join(d, 'skillsmith.toml');
      await writeFile(file, before);
      const result = await saveConfig(env, {
        scope: 'project',
        file,
        patch: { tool: 'codex' },
      });
      expect(result.ok, label).toBeFalse();
      if (!result.ok) {
        expect(result.error).toMatchObject({ code: 'invalid-argument' });
        const message = 'message' in result.error ? result.error.message : '';
        expect(message).toContain('--- a/config.toml\n+++ b/config.toml\n@@ -1 +1 @@');
        expect(message).toContain('[defaults]');
        expect(message).toContain('+tools = ["codex"]');
        expect(message).not.toContain('ambiguous source range retained');
        expect(message).not.toContain('using a validated value');
        expect(JSON.stringify(result.error)).not.toContain(canary);
      }
      expect(await readFile(file, 'utf8')).toBe(before);
      expect(await readdir(d)).toEqual(['skillsmith.toml']);
      await rm(d, { recursive: true, force: true });
    }
  });

  test('manual patches encode semantic unset content and redact sensitive set values', async () => {
    const env = await defaultRuntimePorts();
    const unsetRoot = await tmpDir('manual-unset');
    const unsetFile = join(unsetRoot, 'skillsmith.toml');
    const multiline = 'version = 1\n[defaults]\ntools = [\n  "codex",\n]\nscope = "project"\n';
    await writeFile(unsetFile, multiline);
    const unset = await saveConfig(env, {
      scope: 'project',
      file: unsetFile,
      delete: ['tool'],
    });
    expect(unset.ok).toBeFalse();
    if (!unset.ok) {
      const message = 'message' in unset.error ? unset.error.message : '';
      expect(message).toContain('[defaults]');
      expect(message).toContain('-tools = ["codex"]');
      expect(message).not.toContain('[REDACTED]');
    }
    expect(await readFile(unsetFile, 'utf8')).toBe(multiline);
    expect(await readdir(unsetRoot)).toEqual(['skillsmith.toml']);
    await rm(unsetRoot, { recursive: true, force: true });

    const sensitiveRoot = await tmpDir('manual-sensitive');
    const sensitiveFile = join(sensitiveRoot, 'config.toml');
    const canary = 'P17_MANUAL_PATCH_SECRET';
    const before = 'tool = "codex"\n# retained boundary\n[registry]\n';
    await writeFile(sensitiveFile, before);
    const sensitive = await saveConfig(env, {
      scope: 'user',
      file: sensitiveFile,
      patch: { path: `https://user:${canary}@example.test/skills?token=${canary}` },
    });
    expect(sensitive.ok).toBeFalse();
    if (!sensitive.ok) {
      const message = 'message' in sensitive.error ? sensitive.error.message : '';
      expect(message).toContain('+path = "[REDACTED]"');
      expect(message).toContain('replace "[REDACTED]" locally with the requested validated value');
      expect(message).not.toContain(canary);
    }
    expect(await readFile(sensitiveFile, 'utf8')).toBe(before);
    expect(await readdir(sensitiveRoot)).toEqual(['config.toml']);
    await rm(sensitiveRoot, { recursive: true, force: true });
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
