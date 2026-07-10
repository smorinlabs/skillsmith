import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { lstat, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { makeSkillSource } from '../../../core/tests/fixtures/place/dev-source.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../../../core/tests/fixtures/place/fleet.ts';

setDefaultTimeout(30_000);

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const BIN = 'packages/cli/src/index.ts';

const run = async (
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> => {
  const proc = Bun.spawn(['bun', 'run', BIN, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, code };
};

const sandboxEnv = (f: FixtureFleet): Record<string, string> => ({
  HOME: f.home,
  CLAUDE_CONFIG_DIR: join(f.home, '.claude'),
  CODEX_HOME: join(f.home, '.codex'),
  SKILLSMITH_HOME: f.data,
});

describe('skillsmith dev --source — usage errors (P13)', () => {
  test('--all combined with --source -> exit 2, error names both flags', async () => {
    const r = await run(['dev', '--all', '--source', '/tmp/nowhere']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--all');
    expect(r.stderr).toContain('--source');
  });

  test('--dest without --tool -> exit 2, error says --dest needs exactly one --tool', async () => {
    const r = await run(['dev', 'x', '--source', '/tmp/nowhere', '--dest', '/tmp/d']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--dest');
    expect(r.stderr).toContain('--tool');
  });

  test('--dest with two --tool values -> exit 2 (exactly one required)', async () => {
    const r = await run([
      'dev',
      'x',
      '--source',
      '/tmp/nowhere',
      '--dest',
      '/tmp/d',
      '--tool',
      'claude-code',
      '--tool',
      'codex',
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/exactly one/);
  });

  test('--help documents the P13 surface: --dest, --no-verify, --strict', async () => {
    const r = await run(['dev', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--source');
    expect(r.stdout).toContain('--dest');
    expect(r.stdout).toContain('--no-verify');
    expect(r.stdout).toContain('--strict');
  });
});

describe('skillsmith dev --source — sandboxed CLI e2e (P13)', () => {
  test('create with one --tool and --dest: exit 0, JSON v2 created, placement under --dest', async () => {
    const f = await buildFixtureFleet();
    try {
      const source = await makeSkillSource(f.base, 'newskill');
      const dest = join(f.base, 'custom-skills');
      await f.env.makeDir(dest);

      const r = await run(
        [
          'dev',
          'newskill',
          '--tool',
          'claude-code',
          '--source',
          source,
          '--dest',
          dest,
          '--no-verify',
          '--json',
        ],
        sandboxEnv(f),
      );
      if (r.code !== 0) {
        throw new Error(
          `expected exit 0, got ${r.code}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
        );
      }

      const report = JSON.parse(r.stdout) as {
        schemaVersion: number;
        results: { action: string; placementPath: string | null }[];
        summary: Record<string, number>;
      };
      expect(report.schemaVersion).toBe(2);
      expect(report.results[0]?.action).toBe('created');
      expect(report.results[0]?.placementPath).toBe(join(dest, 'newskill'));
      expect(report.summary.created).toBe(1);

      const st = await lstat(join(dest, 'newskill'));
      expect(st.isSymbolicLink()).toBe(true);
    } finally {
      await destroyFixtureFleet(f);
    }
  });

  test('re-run over a hand-made ln -s: exit 0, action adopted (record-only)', async () => {
    const f = await buildFixtureFleet();
    try {
      const source = await makeSkillSource(f.base, 'handmade');
      await symlink(source, join(f.home, '.claude', 'skills', 'handmade'));

      const r = await run(
        ['dev', 'handmade', '--tool', 'claude-code', '--source', source, '--no-verify', '--json'],
        sandboxEnv(f),
      );
      if (r.code !== 0) {
        throw new Error(
          `expected exit 0, got ${r.code}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
        );
      }

      const report = JSON.parse(r.stdout) as {
        schemaVersion: number;
        results: { action: string }[];
        summary: Record<string, number>;
      };
      expect(report.results[0]?.action).toBe('adopted');
      expect(report.summary.adopted).toBe(1);
    } finally {
      await destroyFixtureFleet(f);
    }
  });

  test('relative --source is recorded absolute (resolved against the CLI cwd)', async () => {
    const f = await buildFixtureFleet();
    try {
      await makeSkillSource(f.base, 'relskill');
      const expected = resolve(f.base, 'srcs', 'relskill');

      // The CLI resolves --source against ITS cwd; spawn from the fixture base.
      const proc = Bun.spawn(
        [
          'bun',
          'run',
          join(REPO_ROOT, BIN),
          'dev',
          'relskill',
          '--tool',
          'claude-code',
          '--source',
          join('srcs', 'relskill'),
          '--no-verify',
          '--json',
        ],
        {
          cwd: f.base,
          env: { ...process.env, ...sandboxEnv(f) },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const code = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      if (code !== 0) {
        throw new Error(
          `expected exit 0, got ${code}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
        );
      }

      const report = JSON.parse(stdout) as { results: { action: string }[] };
      expect(report.results[0]?.action).toBe('created');

      const ledgerText = await Bun.file(join(f.data, 'placements.json')).text();
      const ledger = JSON.parse(ledgerText) as {
        skills: Record<
          string,
          { tools: Record<string, { dev?: { sourcePath: string; resolvedPath: string } }> }
        >;
      };
      const dev = ledger.skills.relskill?.tools['claude-code']?.dev;
      expect(dev?.sourcePath).toBe(expected);
      expect(dev?.resolvedPath).toBe(expected);
    } finally {
      await destroyFixtureFleet(f);
    }
  });
});
