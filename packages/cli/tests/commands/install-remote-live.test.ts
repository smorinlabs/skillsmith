import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Env-gated NETWORK e2e against the real `smorinlabs/smorinlabs-harness` repo — the PRD §10 live
// acceptance. CI never sets SKILLSMITH_E2E, so this suite reports as skipped and `bun run check`
// stays green. This is the one suite in the P09 acceptance set that needs an actual workstation
// with network access; the SIGKILL/journal-barrier suite (install-live.test.ts) is fully hermetic
// and covers crash recovery without any network dependency. Run on a networked workstation:
// `SKILLSMITH_E2E=1 bun test packages/cli/tests/commands/install-remote-live.test.ts`
const E2E = process.env.SKILLSMITH_E2E === '1';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const BIN = 'packages/cli/src/index.ts';
const HARNESS_REPO = 'smorinlabs/smorinlabs-harness';
const SKILL_PATH = 'plugins/factor-harness/skills/factor-scan';
const SKILL_NAME = 'factor-scan';

interface ProcResult {
  stdout: string;
  stderr: string;
  code: number;
}

// Every invocation forces `--user`: `install`/`uninstall` (unlike `promote`/`dev`, which are
// always user-scope) default to PROJECT scope when `cwd` is inside a git work tree — and the spawn
// `cwd` here MUST be this repo's root so the relative `packages/cli/src/index.ts` path resolves.
// Without `--user`, a literal run would place skills into THIS repo's own `.claude/skills/`
// instead of the scratch HOME below (confirmed the hard way while building install-live.test.ts —
// see the Task 10 report).
const run = async (
  args: string[],
  env: Record<string, string>,
  opts: { stdin?: 'ignore' | 'pipe' } = {},
): Promise<ProcResult> => {
  const proc = Bun.spawn(['bun', BIN, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdin: opts.stdin ?? 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, code };
};

const requireExit = (r: ProcResult, expected: number, label: string): void => {
  if (r.code !== expected) {
    throw new Error(
      `${label}: expected exit ${expected}, got ${r.code}\n` +
        `--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
    );
  }
};

const runGit = (cwd: string, args: string[]): string => {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(result.stderr)}`);
  }
  return new TextDecoder().decode(result.stdout);
};

interface Scratch {
  home: string;
  data: string;
  env: Record<string, string>;
}

const makeScratch = (): Scratch => {
  const home = mkdtempSync(join(tmpdir(), 'skillsmith-remote-live-home-'));
  const data = mkdtempSync(join(tmpdir(), 'skillsmith-remote-live-data-'));
  return { home, data, env: { HOME: home, SKILLSMITH_HOME: data, SKILLSMITH_E2E: '1' } };
};

const destroyScratch = (s: Scratch): void => {
  rmSync(s.home, { recursive: true, force: true });
  rmSync(s.data, { recursive: true, force: true });
};

describe.skipIf(!E2E)(
  'skillsmith install live e2e (real network, smorinlabs/smorinlabs-harness)',
  () => {
    test('bare form (ambiguous) -> harvested //path re-run line, name form, and explicit //path form all resolve to the same store entry; --json parses', async () => {
      const s = makeScratch();
      try {
        // Bare (whole-repo) form on an EMPTY ledger is genuinely ambiguous — 14+ skills, no prior
        // install to elide against (F-fetch elision only kicks in once a matching (repo, sha) pair
        // already exists in the ledger).
        const bareResult = await run(
          ['install', HARNESS_REPO, '--tool', 'claude-code', '--no-verify', '--user'],
          s.env,
        );
        requireExit(bareResult, 2, 'install (bare, ambiguous)');
        const candidateLine = bareResult.stderr
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l.includes(`${HARNESS_REPO}//${SKILL_PATH}`));
        if (!candidateLine) {
          throw new Error(
            `expected a //${SKILL_PATH} re-run line in stderr:\n${bareResult.stderr}`,
          );
        }

        // Re-run using the harvested candidate line (path form) -> installs.
        const pathResult = await run(
          ['install', candidateLine, '--tool', 'claude-code', '--no-verify', '--user', '--json'],
          s.env,
        );
        requireExit(pathResult, 0, 'install (harvested //path form)');
        const pathReport = JSON.parse(pathResult.stdout);
        expect(pathReport.kind).toBe('skillsmith.install');
        const storePath = pathReport.results[0]?.store?.path;
        expect(typeof storePath).toBe('string');
        expect(pathReport.results[0]?.action).toBe('installed');

        // Name form (owner/repo/<name>) resolves to the SAME store entry (noop: already installed).
        const nameResult = await run(
          [
            'install',
            `${HARNESS_REPO}/${SKILL_NAME}`,
            '--tool',
            'claude-code',
            '--no-verify',
            '--user',
            '--json',
          ],
          s.env,
        );
        requireExit(nameResult, 0, 'install (name form)');
        const nameReport = JSON.parse(nameResult.stdout);
        expect(nameReport.kind).toBe('skillsmith.install');
        expect(nameReport.results[0]?.action).toBe('noop');
        expect(nameReport.results[0]?.store?.path).toBe(storePath);
      } finally {
        destroyScratch(s);
      }
    }, 120_000);

    test('non-TTY ambiguity on a multi-skill selector -> exit 2, stderr lists exact //path re-run lines (R2)', async () => {
      const s = makeScratch();
      try {
        const r = await run(
          ['install', HARNESS_REPO, '--tool', 'claude-code', '--no-verify', '--user'],
          s.env,
          { stdin: 'ignore' }, // never a TTY under bun:test regardless
        );
        requireExit(r, 2, 'install (bare, non-TTY)');
        const pathLines = r.stderr
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.startsWith(`${HARNESS_REPO}//`));
        expect(pathLines.length).toBeGreaterThan(1);
        expect(pathLines.some((l) => l === `${HARNESS_REPO}//${SKILL_PATH}`)).toBe(true);
      } finally {
        destroyScratch(s);
      }
    }, 120_000);

    test('scenario-4 round-trip against a real local clone: dev --source -> promote -> dev --rollback -> uninstall', async () => {
      const s = makeScratch();
      const cloneRoot = mkdtempSync(join(tmpdir(), 'skillsmith-remote-live-clone-'));
      try {
        const ins = await run(
          [
            'install',
            `${HARNESS_REPO}/${SKILL_NAME}`,
            '--tool',
            'claude-code',
            '--no-verify',
            '--user',
          ],
          s.env,
        );
        requireExit(ins, 0, 'install (seed)');

        runGit(cloneRoot, ['clone', '-q', `https://github.com/${HARNESS_REPO}.git`, '.']);
        const clonedSkillPath = join(cloneRoot, SKILL_PATH);

        // `dev` never gates on verify (no --no-verify flag exists — the flip is a pure symlink swap).
        const dev = await run(['dev', SKILL_NAME, '--source', clonedSkillPath], s.env);
        requireExit(dev, 0, 'dev --source <clone>');

        const promote = await run(['promote', SKILL_NAME, '--no-verify'], s.env);
        requireExit(promote, 0, 'promote');

        const devRollback = await run(['dev', '--rollback', SKILL_NAME], s.env);
        requireExit(devRollback, 0, 'dev --rollback');

        const uninstall = await run(
          ['uninstall', SKILL_NAME, '--tool', 'claude-code', '--user'],
          s.env,
        );
        requireExit(uninstall, 0, 'uninstall');
        expect(uninstall.stdout).toContain('store entry retained:');
      } finally {
        rmSync(cloneRoot, { recursive: true, force: true });
        destroyScratch(s);
      }
    }, 120_000);

    test('scenario 5: --force --ref <tag> up/downgrade round trip', async () => {
      const s = makeScratch();
      try {
        const fresh = await run(
          [
            'install',
            `${HARNESS_REPO}/${SKILL_NAME}`,
            '--tool',
            'claude-code',
            '--no-verify',
            '--user',
            '--json',
          ],
          s.env,
        );
        requireExit(fresh, 0, 'install (fresh, HEAD)');
        const freshReport = JSON.parse(fresh.stdout);
        const headRev = freshReport.results[0]?.store?.rev;
        expect(typeof headRev).toBe('string');

        const downgrade = await run(
          [
            'install',
            `${HARNESS_REPO}/${SKILL_NAME}`,
            '--tool',
            'claude-code',
            '--no-verify',
            '--user',
            '--force',
            '--ref',
            'v0.2.0',
            '--json',
          ],
          s.env,
        );
        requireExit(downgrade, 0, 'install --force --ref v0.2.0');
        const downgradeReport = JSON.parse(downgrade.stdout);
        expect(downgradeReport.results[0]?.action).toBe('updated');
        const tagRev = downgradeReport.results[0]?.store?.rev;
        expect(tagRev).not.toBe(headRev);

        const upgrade = await run(
          [
            'install',
            `${HARNESS_REPO}/${SKILL_NAME}`,
            '--tool',
            'claude-code',
            '--no-verify',
            '--user',
            '--force',
            '--json',
          ],
          s.env,
        );
        requireExit(upgrade, 0, 'install --force (back to HEAD)');
        const upgradeReport = JSON.parse(upgrade.stdout);
        expect(upgradeReport.results[0]?.action).toBe('updated');
        expect(upgradeReport.results[0]?.store?.rev).toBe(headRev);

        // Both revisions' store entries coexist (immortal, write-once).
        expect(downgradeReport.results[0]?.store?.path).not.toBe(
          upgradeReport.results[0]?.store?.path,
        );
      } finally {
        destroyScratch(s);
      }
    }, 120_000);
  },
);
