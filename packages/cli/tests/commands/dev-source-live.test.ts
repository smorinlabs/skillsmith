import { describe, expect, test } from 'bun:test';
import { lstat, readlink, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hermeticGitEnv } from '../../../core/tests/fixtures/git-env.ts';
import {
  codexDefaultSkillsDestFor,
  makeSkillSource,
} from '../../../core/tests/fixtures/place/dev-source.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../../../core/tests/fixtures/place/fleet.ts';
import { FlipJsonSchema } from '../../src/output/flip-json.ts';

// Env-gated live e2e against the real `claude` / `codex` CLIs — the P13 drift-canary extension.
// Same gate and sandbox pattern as `packages/core/tests/verify/live-e2e.test.ts` and
// `flip-live.test.ts`: CI never sets SKILLSMITH_E2E and its runners have neither tool CLI
// installed, so this whole suite reports skipped and `bun run check` stays green. Run locally:
// `SKILLSMITH_E2E=1 bun test packages/cli/tests/commands/dev-source-live.test.ts`
//
// `dev-source.test.ts`'s "sandboxed CLI e2e" always passes `--no-verify` to stay hermetic — it
// proves the create/adopt state machine without touching a real tool binary. These cases
// deliberately do NOT pass `--no-verify` for the create/adopt step: D2 makes static verify the
// DEFAULT gate, so a plain `dev --source` call shells the real `claude`/`codex` CLI exactly like
// `verify`'s live e2e does. A future tool release that changes static-mode output shape fails THIS
// suite while the canned dev-source unit tests (which use canned `FlipDeps.verify`) stay green —
// that's the version-drift signal this file exists to catch, extended to cover create/adopt.
const E2E = process.env.SKILLSMITH_E2E === '1';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const BIN = 'packages/cli/src/index.ts';

const sandboxEnv = (f: FixtureFleet): Record<string, string> => ({
  HOME: f.home,
  CLAUDE_CONFIG_DIR: join(f.home, '.claude'),
  CODEX_HOME: join(f.home, '.codex'),
  SKILLSMITH_HOME: f.data,
});

const run = async (
  args: string[],
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> => {
  const proc = Bun.spawn(['bun', 'run', BIN, ...args], {
    cwd: REPO_ROOT,
    env: hermeticGitEnv(env),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, code };
};

/** Fails with the full process transcript, not just a bare exit-code mismatch. */
const requireExit = (
  r: { stdout: string; stderr: string; code: number },
  expected: number,
  label: string,
): void => {
  if (r.code !== expected) {
    throw new Error(
      `${label}: expected exit ${expected}, got ${r.code}\n` +
        `--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
    );
  }
};

interface FlipJsonLike {
  schemaVersion: number;
  results: {
    action: string;
    placementPath: string | null;
    verify: { gate: string; verdict: string | null } | null;
  }[];
  summary: Record<string, number>;
}

/** Parses stdout AND validates it against the real (non-canned) `FlipJsonSchema` — the same
 *  schema `renderFlipJson` uses in production — so a live-tool drift that reshapes the report gets
 *  caught here, not just in the canned contract tests. */
const parseFlipJson = (stdout: string): FlipJsonLike => {
  const parsed: unknown = JSON.parse(stdout);
  expect(() => FlipJsonSchema.parse(parsed)).not.toThrow();
  return parsed as FlipJsonLike;
};

describe.skipIf(!E2E)(
  'dev --source live e2e (real claude/codex CLIs) — P13 create/adopt drift canary',
  () => {
    describe.skipIf(!Bun.which('claude'))('claude-code', () => {
      const claudeRoot = (f: FixtureFleet): string => join(f.home, '.claude', 'skills');

      test('create: real static verify gate, symlink + ledger record + v2 report fields', async () => {
        const f = await buildFixtureFleet();
        try {
          const source = await makeSkillSource(f.base, 'canary-create-claude');
          const r = await run(
            ['dev', 'canary-create-claude', '--tool', 'claude-code', '--source', source, '--json'],
            sandboxEnv(f),
          );
          requireExit(r, 0, 'dev --source create (claude-code)');

          const report = parseFlipJson(r.stdout);
          expect(report.schemaVersion).toBe(2);
          const result = report.results[0];
          expect(result?.action).toBe('created');
          expect(result?.placementPath).toBe(join(claudeRoot(f), 'canary-create-claude'));
          expect(result?.verify?.gate).toBe('passed');
          expect(result?.verify?.verdict).toBe('pass');
          expect(report.summary.created).toBe(1);

          const placementPath = join(claudeRoot(f), 'canary-create-claude');
          const st = await lstat(placementPath);
          expect(st.isSymbolicLink()).toBe(true);
          expect(await readlink(placementPath)).toBe(resolve(source));

          const ledger = JSON.parse(await Bun.file(join(f.data, 'placements.json')).text());
          const pair = ledger.skills['canary-create-claude']?.tools['claude-code'];
          expect(pair?.mode).toBe('dev');
          expect(pair?.dev?.sourcePath).toBe(resolve(source));
          expect(pair?.pinned ?? null).toBeNull();
          expect(pair?.journal ?? null).toBeNull();
        } finally {
          await destroyFixtureFleet(f);
        }
      }, 120_000);

      test('adopt: pre-made ln -s -> record-only; disk mtime/target unchanged', async () => {
        const f = await buildFixtureFleet();
        try {
          const source = await makeSkillSource(f.base, 'canary-adopt-claude');
          const placementPath = join(claudeRoot(f), 'canary-adopt-claude');
          await symlink(resolve(source), placementPath);
          const before = await lstat(placementPath);
          const beforeTarget = await readlink(placementPath);

          const r = await run(
            ['dev', 'canary-adopt-claude', '--tool', 'claude-code', '--source', source, '--json'],
            sandboxEnv(f),
          );
          requireExit(r, 0, 'dev --source adopt (claude-code)');

          const report = parseFlipJson(r.stdout);
          expect(report.results[0]?.action).toBe('adopted');
          expect(report.summary.adopted).toBe(1);

          // Disk untouched: same inode-level mtime, same literal symlink target.
          const after = await lstat(placementPath);
          expect(after.mtimeMs).toBe(before.mtimeMs);
          expect(await readlink(placementPath)).toBe(beforeTarget);

          const ledger = JSON.parse(await Bun.file(join(f.data, 'placements.json')).text());
          const pair = ledger.skills['canary-adopt-claude']?.tools['claude-code'];
          expect(pair?.mode).toBe('dev');
          expect(pair?.dev?.sourcePath).toBe(resolve(source));
        } finally {
          await destroyFixtureFleet(f);
        }
      }, 120_000);

      test('re-run over an already-recorded pair -> noop', async () => {
        const f = await buildFixtureFleet();
        try {
          const source = await makeSkillSource(f.base, 'canary-noop-claude');
          const seed = await run(
            ['dev', 'canary-noop-claude', '--tool', 'claude-code', '--source', source, '--json'],
            sandboxEnv(f),
          );
          requireExit(seed, 0, 'dev --source create (seed)');
          expect(parseFlipJson(seed.stdout).results[0]?.action).toBe('created');

          const rerun = await run(
            ['dev', 'canary-noop-claude', '--tool', 'claude-code', '--source', source, '--json'],
            sandboxEnv(f),
          );
          requireExit(rerun, 0, 'dev --source re-run (claude-code)');
          const report = parseFlipJson(rerun.stdout);
          expect(report.results[0]?.action).toBe('noop');
          expect(report.summary.noop).toBe(1);
          expect(report.summary.created).toBe(0);
        } finally {
          await destroyFixtureFleet(f);
        }
      }, 120_000);

      test('round-trip interop: promote the created pair, then dev it back — P13 records feed P12 flips', async () => {
        const f = await buildFixtureFleet();
        try {
          const source = await makeSkillSource(f.base, 'canary-roundtrip-claude');
          const placementPath = join(claudeRoot(f), 'canary-roundtrip-claude');

          const created = await run(
            [
              'dev',
              'canary-roundtrip-claude',
              '--tool',
              'claude-code',
              '--source',
              source,
              '--json',
            ],
            sandboxEnv(f),
          );
          requireExit(created, 0, 'dev --source create (seed)');
          expect(parseFlipJson(created.stdout).results[0]?.action).toBe('created');

          // --no-verify here: promote's deep gate needs real tool auth, which is orthogonal to
          // what this canary extension is proving (that P13's dev record round-trips through
          // P12's promote/dev, per flip-live.test.ts's own precedent of --no-verify on promote).
          const promoted = await run(
            [
              'promote',
              'canary-roundtrip-claude',
              '--tool',
              'claude-code',
              '--no-verify',
              '--json',
            ],
            sandboxEnv(f),
          );
          requireExit(promoted, 0, 'promote');
          const promoteReport = parseFlipJson(promoted.stdout);
          expect(promoteReport.results[0]?.action).toBe('flipped');
          expect((await lstat(placementPath)).isDirectory()).toBe(true);

          // No --source: P12's dev reads the retained record that P13's create wrote.
          const devBack = await run(
            ['dev', 'canary-roundtrip-claude', '--tool', 'claude-code', '--no-verify', '--json'],
            sandboxEnv(f),
          );
          requireExit(devBack, 0, 'dev (round-trip back)');
          const devReport = parseFlipJson(devBack.stdout);
          expect(devReport.results[0]?.action).toBe('flipped');
          expect(await readlink(placementPath)).toBe(resolve(source));
        } finally {
          await destroyFixtureFleet(f);
        }
      }, 120_000);
    });

    describe.skipIf(!Bun.which('codex'))('codex', () => {
      const codexRoot = (f: FixtureFleet): string => codexDefaultSkillsDestFor(f.home);

      test('create: real static verify gate, symlink + ledger record + v2 report fields', async () => {
        const f = await buildFixtureFleet();
        try {
          const source = await makeSkillSource(f.base, 'canary-create-codex');
          const r = await run(
            ['dev', 'canary-create-codex', '--tool', 'codex', '--source', source, '--json'],
            sandboxEnv(f),
          );
          requireExit(r, 0, 'dev --source create (codex)');

          const report = parseFlipJson(r.stdout);
          expect(report.schemaVersion).toBe(2);
          const result = report.results[0];
          expect(result?.action).toBe('created');
          expect(result?.placementPath).toBe(join(codexRoot(f), 'canary-create-codex'));
          expect(result?.verify?.gate).toBe('passed');
          expect(result?.verify?.verdict).toBe('pass');
          expect(report.summary.created).toBe(1);

          const placementPath = join(codexRoot(f), 'canary-create-codex');
          const st = await lstat(placementPath);
          expect(st.isSymbolicLink()).toBe(true);
          expect(await readlink(placementPath)).toBe(resolve(source));

          const ledger = JSON.parse(await Bun.file(join(f.data, 'placements.json')).text());
          const pair = ledger.skills['canary-create-codex']?.tools.codex;
          expect(pair?.mode).toBe('dev');
          expect(pair?.dev?.sourcePath).toBe(resolve(source));
          expect(pair?.pinned ?? null).toBeNull();
          expect(pair?.journal ?? null).toBeNull();
        } finally {
          await destroyFixtureFleet(f);
        }
      }, 120_000);

      test('adopt: pre-made ln -s -> record-only; disk mtime/target unchanged', async () => {
        const f = await buildFixtureFleet();
        try {
          const source = await makeSkillSource(f.base, 'canary-adopt-codex');
          // The fixture fleet already creates home/.agents/skills (fleet.ts).
          const placementPath = join(codexRoot(f), 'canary-adopt-codex');
          await symlink(resolve(source), placementPath);
          const before = await lstat(placementPath);
          const beforeTarget = await readlink(placementPath);

          const r = await run(
            ['dev', 'canary-adopt-codex', '--tool', 'codex', '--source', source, '--json'],
            sandboxEnv(f),
          );
          requireExit(r, 0, 'dev --source adopt (codex)');

          const report = parseFlipJson(r.stdout);
          expect(report.results[0]?.action).toBe('adopted');
          expect(report.summary.adopted).toBe(1);

          const after = await lstat(placementPath);
          expect(after.mtimeMs).toBe(before.mtimeMs);
          expect(await readlink(placementPath)).toBe(beforeTarget);

          const ledger = JSON.parse(await Bun.file(join(f.data, 'placements.json')).text());
          const pair = ledger.skills['canary-adopt-codex']?.tools.codex;
          expect(pair?.mode).toBe('dev');
          expect(pair?.dev?.sourcePath).toBe(resolve(source));
        } finally {
          await destroyFixtureFleet(f);
        }
      }, 120_000);

      test('re-run over an already-recorded pair -> noop', async () => {
        const f = await buildFixtureFleet();
        try {
          const source = await makeSkillSource(f.base, 'canary-noop-codex');
          const seed = await run(
            ['dev', 'canary-noop-codex', '--tool', 'codex', '--source', source, '--json'],
            sandboxEnv(f),
          );
          requireExit(seed, 0, 'dev --source create (seed)');
          expect(parseFlipJson(seed.stdout).results[0]?.action).toBe('created');

          const rerun = await run(
            ['dev', 'canary-noop-codex', '--tool', 'codex', '--source', source, '--json'],
            sandboxEnv(f),
          );
          requireExit(rerun, 0, 'dev --source re-run (codex)');
          const report = parseFlipJson(rerun.stdout);
          expect(report.results[0]?.action).toBe('noop');
          expect(report.summary.noop).toBe(1);
          expect(report.summary.created).toBe(0);
        } finally {
          await destroyFixtureFleet(f);
        }
      }, 120_000);

      test('round-trip interop: promote the created pair, then dev it back — P13 records feed P12 flips', async () => {
        const f = await buildFixtureFleet();
        try {
          const source = await makeSkillSource(f.base, 'canary-roundtrip-codex');
          const placementPath = join(codexRoot(f), 'canary-roundtrip-codex');

          const created = await run(
            ['dev', 'canary-roundtrip-codex', '--tool', 'codex', '--source', source, '--json'],
            sandboxEnv(f),
          );
          requireExit(created, 0, 'dev --source create (seed)');
          expect(parseFlipJson(created.stdout).results[0]?.action).toBe('created');

          const promoted = await run(
            ['promote', 'canary-roundtrip-codex', '--tool', 'codex', '--no-verify', '--json'],
            sandboxEnv(f),
          );
          requireExit(promoted, 0, 'promote');
          const promoteReport = parseFlipJson(promoted.stdout);
          expect(promoteReport.results[0]?.action).toBe('flipped');
          expect((await lstat(placementPath)).isDirectory()).toBe(true);

          const devBack = await run(
            ['dev', 'canary-roundtrip-codex', '--tool', 'codex', '--no-verify', '--json'],
            sandboxEnv(f),
          );
          requireExit(devBack, 0, 'dev (round-trip back)');
          const devReport = parseFlipJson(devBack.stdout);
          expect(devReport.results[0]?.action).toBe('flipped');
          expect(await readlink(placementPath)).toBe(resolve(source));
        } finally {
          await destroyFixtureFleet(f);
        }
      }, 120_000);
    });
  },
);
