import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermeticGitEnv } from '../../../core/tests/fixtures/git-env.ts';
import {
  TEST_COORDINATION_PRELOAD,
  TEST_COORDINATION_ROOT_ENV,
} from '../../../core/tests/fixtures/test-coordination.ts';
import { CLI_ENTRYPOINT } from '../fixtures/cli.ts';
const coordinationRoot = mkdtempSync(join(tmpdir(), 'skillsmith-config-coordination-'));
afterAll(async () => {
  await rm(coordinationRoot, { recursive: true, force: true });
});
const run = async (args: string[], env: Record<string, string> = {}) => {
  const proc = Bun.spawn(['bun', '--preload', TEST_COORDINATION_PRELOAD, CLI_ENTRYPOINT, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: hermeticGitEnv({ [TEST_COORDINATION_ROOT_ENV]: coordinationRoot, ...env }),
  });
  const code = await proc.exited;
  return {
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
    code,
  };
};

describe('skillsmith config', () => {
  test('get/set round-trip at user scope', async () => {
    const d = join('/tmp', `skillsmith-config-rt-${Date.now()}`);
    await mkdir(d, { recursive: true });
    try {
      const setR = await run(['config', 'set', 'tool', 'codex'], { XDG_CONFIG_HOME: d });
      expect(setR.code).toBe(0);
      const getR = await run(['config', 'get', 'tool'], { XDG_CONFIG_HOME: d });
      expect(getR.code).toBe(0);
      expect(getR.stdout.trim()).toBe('codex');
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  test('list --json emits structured output', async () => {
    const d = join('/tmp', `sk-list-${Date.now()}`);
    await mkdir(join(d, 'skillsmith'), { recursive: true });
    await writeFile(join(d, 'skillsmith/config.toml'), 'tool = "codex"\n');
    try {
      const r = await run(['config', 'list', '--json'], { XDG_CONFIG_HOME: d });
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.effective.tool).toBe('codex');
      expect(parsed.sources.tool).toBe('user');
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  test('unset removes a key', async () => {
    const d = join('/tmp', `skillsmith-config-unset-${Date.now()}`);
    await mkdir(join(d, 'skillsmith'), { recursive: true });
    await writeFile(join(d, 'skillsmith/config.toml'), 'tool = "codex"\nscope = "user"\n');
    try {
      const r = await run(['config', 'unset', 'tool'], { XDG_CONFIG_HOME: d });
      expect(r.code).toBe(0);
      const getR = await run(['config', 'get', 'tool'], { XDG_CONFIG_HOME: d });
      expect(getR.code).toBe(1);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  test('unknown key exits 2', async () => {
    const r = await run(['config', 'get', 'nope']);
    expect(r.code).toBe(2);
  });

  test('set with invalid tool value exits 2', async () => {
    const d = join('/tmp', `sk-invalid-${Date.now()}`);
    try {
      const r = await run(['config', 'set', 'tool', 'bogus'], { XDG_CONFIG_HOME: d });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('invalid value');
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  test('malformed config exits 3', async () => {
    const d = join('/tmp', `sk-bad-${Date.now()}`);
    await mkdir(join(d, 'skillsmith'), { recursive: true });
    await writeFile(join(d, 'skillsmith/config.toml'), 'garbage = nope bar\n');
    try {
      const r = await run(['config', 'list'], { XDG_CONFIG_HOME: d });
      expect(r.code).toBe(3);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});
