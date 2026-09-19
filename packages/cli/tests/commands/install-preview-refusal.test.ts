import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hermeticGitEnv } from '../../../core/tests/fixtures/git-env.ts';

// SC-I60-R6 redprove (PLAN_ACCEPTED_NOT_RELEASED): unmanaged same-name directory with
// NONMATCHING bytes, no force — compare preview action vs actual install outcome.
// PROVEN if they disagree; INVALIDATED if they agree.

setDefaultTimeout(60_000);

const CLI_ENTRYPOINT = resolve(import.meta.dir, '..', '..', 'src', 'index.ts');
const BUN_EXE = process.execPath;

const HOST = 'r6.fixture.invalid';
const REPO = 'acme/skills';
const SKILL_PATH = 'skills/review';
const SKILL = 'review';
const TOOL = 'claude-code';

interface R6Fixture {
  root: string;
  home: string;
  data: string;
  cwdDir: string;
  gitConfig: string;
  src: string;
  sha: string;
  envOverrides: Record<string, string>;
  ledgerPath: string;
  livePath: string;
}

const runGitSync = (cwd: string, args: string[]): string => {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: hermeticGitEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr);
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${stderr}`);
  }
  return new TextDecoder().decode(result.stdout);
};

const REMOTE_PAYLOAD = '# review REMOTE payload\n\nRemote canonical bytes.\n';

const buildR6Fixture = (): R6Fixture => {
  const root = mkdtempSync(join(tmpdir(), 'skillsmith-r6-redprove-'));
  const home = join(root, 'home');
  const data = join(root, 'data');
  const cwdDir = join(root, 'cwd');
  const binDir = join(root, 'bin');
  for (const dir of [home, data, cwdDir, binDir]) mkdirSync(dir, { recursive: true });
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });

  const claudePath = join(binDir, 'claude');
  writeFileSync(claudePath, '#!/bin/sh\necho "claude 9.9.9-fixture"\n');
  chmodSync(claudePath, 0o755);

  const work = join(root, 'work');
  mkdirSync(join(work, 'skills', 'review'), { recursive: true });
  writeFileSync(
    join(work, 'skills', 'review', 'SKILL.md'),
    `---\nname: review\ndescription: Fixture.\n---\n\n${REMOTE_PAYLOAD}`,
  );
  runGitSync(work, ['init', '-q', '-b', 'main']);
  runGitSync(work, [
    '-c',
    'user.email=fixture@skillsmith.test',
    '-c',
    'user.name=fixture',
    '-c',
    'commit.gpgsign=false',
    'add',
    '-A',
  ]);
  runGitSync(work, [
    '-c',
    'user.email=fixture@skillsmith.test',
    '-c',
    'user.name=fixture',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'fixture: remote review',
  ]);
  const sha = runGitSync(work, ['rev-parse', 'HEAD']).trim();
  const bare = join(root, 'remote.git');
  runGitSync(root, ['clone', '-q', '--bare', work, bare]);
  runGitSync(bare, ['config', 'uploadpack.allowFilter', 'true']);
  runGitSync(bare, ['config', 'uploadpack.allowReachableSHA1InWant', 'true']);

  const clone = `https://${HOST}/${REPO}.git`;
  const gitConfig = join(root, 'gitconfig');
  writeFileSync(
    gitConfig,
    `[url "file://${bare}"]\n\tinsteadOf = ${clone}\n[url "file://${bare}"]\n\tinsteadOf = https://${HOST}/${REPO}\n[protocol "file"]\n\tallow = always\n[protocol "https"]\n\tallow = never\n[protocol "http"]\n\tallow = never\n[protocol "ssh"]\n\tallow = never\n[protocol "git"]\n\tallow = never\n[core]\n\thooksPath = /dev/null\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[credential]\n\thelper =\n`,
  );

  const xdgConfig = join(root, 'xdg-config');
  const xdgData = join(root, 'xdg-data');
  const xdgCache = join(root, 'xdg-cache');
  for (const dir of [xdgConfig, xdgData, xdgCache]) mkdirSync(dir, { recursive: true });

  const envOverrides: Record<string, string> = {
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_ALLOW_PROTOCOL: 'file',
    GIT_TERMINAL_PROMPT: '0',
    HOME: home,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    XDG_CACHE_HOME: xdgCache,
    SKILLSMITH_HOME: data,
    PATH: `${binDir}:/usr/local/bin:/usr/bin:/bin`,
  };

  return {
    root,
    home,
    data,
    cwdDir,
    gitConfig,
    src: `${clone}//${SKILL_PATH}`,
    sha,
    envOverrides,
    ledgerPath: join(data, 'placements.json'),
    livePath: join(home, '.claude', 'skills', SKILL),
  };
};

const destroyR6Fixture = (fixture: R6Fixture): void => {
  rmSync(fixture.root, { recursive: true, force: true });
};

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const runCli = async (fixture: R6Fixture, args: string[]): Promise<CliResult> => {
  const proc = Bun.spawn([BUN_EXE, CLI_ENTRYPOINT, ...args], {
    cwd: fixture.cwdDir,
    env: hermeticGitEnv(fixture.envOverrides, { globalConfigPath: fixture.gitConfig }),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
};

const requireExit = (result: CliResult, expected: number, label: string): void => {
  if (result.code !== expected) {
    throw new Error(
      `${label}: expected exit ${expected}, got ${result.code}\n` +
        `--- stdout ---\n${result.stdout.slice(0, 4000)}\n--- stderr ---\n${result.stderr.slice(0, 2000)}`,
    );
  }
};

const firstResult = (stdout: string): { action: string; reason: string | null } => {
  const report = JSON.parse(stdout) as {
    results: Array<{ action: string; reason: string | null }>;
  };
  const result = report.results[0];
  if (!result) throw new Error(`expected one result in stdout:\n${stdout.slice(0, 2000)}`);
  return result;
};

const UNMANAGED_PAYLOAD =
  '---\nname: review\ndescription: Unmanaged local bytes.\n---\n\nLOCAL UNMANAGED BYTES — definitely not the remote.\n';
const SENTINEL = 'R6-UNMANAGED-SENTINEL\n';
// Byte-identical to what buildR6Fixture commits as skills/review/SKILL.md.
const REMOTE_SKILL_FILE = `---\nname: review\ndescription: Fixture.\n---\n\n${REMOTE_PAYLOAD}`;

const plantUnmanagedDifferent = (fixture: R6Fixture): void => {
  mkdirSync(fixture.livePath, { recursive: true });
  writeFileSync(join(fixture.livePath, 'SKILL.md'), UNMANAGED_PAYLOAD);
  writeFileSync(join(fixture.livePath, '.sentinel'), SENTINEL);
};

const readLiveSkill = (fixture: R6Fixture): string =>
  readFileSync(join(fixture.livePath, 'SKILL.md'), 'utf8');

describe('install preview refusal (SC-I60-R6 redprove)', () => {
  test('DECISIVE live-only: preview vs actual on unmanaged different-content, --no-save', async () => {
    const fixture = buildR6Fixture();
    try {
      plantUnmanagedDifferent(fixture);
      expect(existsSync(fixture.ledgerPath)).toBe(false);
      expect(readLiveSkill(fixture)).not.toContain('Remote canonical bytes');
      const liveBefore = readLiveSkill(fixture);

      const preview = await runCli(fixture, [
        '--no-prompt',
        'install',
        fixture.src,
        '--tool',
        TOOL,
        '--user',
        '--json',
        '--no-verify',
        '--no-save',
        '--dry-run',
      ]);
      const previewAction = firstResult(preview.stdout).action;
      console.log(`R6 DECISIVE --no-save: preview exit=${preview.code} action=${previewAction}`);
      // Dry-run must leave durable state byte-identical: live target, sentinel, no ledger.
      expect(readLiveSkill(fixture)).toBe(liveBefore);
      expect(readFileSync(join(fixture.livePath, '.sentinel'), 'utf8')).toBe(SENTINEL);
      expect(existsSync(fixture.ledgerPath)).toBe(false);

      const actual = await runCli(fixture, [
        '--no-prompt',
        'install',
        fixture.src,
        '--tool',
        TOOL,
        '--user',
        '--json',
        '--no-verify',
        '--no-save',
      ]);
      const actualAction = firstResult(actual.stdout).action;
      console.log(`R6 DECISIVE --no-save: actual  exit=${actual.code} action=${actualAction}`);

      // Actual comparator precondition: genuine unmanaged-content refusal.
      requireExit(actual, 2, 'actual no-force unmanaged different-content');
      expect(actualAction).toBe('refused');
      expect(readLiveSkill(fixture)).toBe(liveBefore);

      // Load-bearing RED: preview must agree with the refusal.
      expect(previewAction).toBe('refused');
    } finally {
      destroyR6Fixture(fixture);
    }
  });

  test('DECISIVE default route: preview vs actual on unmanaged different-content', async () => {
    const fixture = buildR6Fixture();
    try {
      plantUnmanagedDifferent(fixture);
      expect(existsSync(fixture.ledgerPath)).toBe(false);
      const liveBefore = readLiveSkill(fixture);

      const preview = await runCli(fixture, [
        '--no-prompt',
        'install',
        fixture.src,
        '--tool',
        TOOL,
        '--user',
        '--json',
        '--no-verify',
        '--dry-run',
      ]);
      const previewAction = firstResult(preview.stdout).action;
      console.log(`R6 DECISIVE default: preview exit=${preview.code} action=${previewAction}`);
      expect(readLiveSkill(fixture)).toBe(liveBefore);
      expect(existsSync(fixture.ledgerPath)).toBe(false);

      const actual = await runCli(fixture, [
        '--no-prompt',
        'install',
        fixture.src,
        '--tool',
        TOOL,
        '--user',
        '--json',
        '--no-verify',
      ]);
      const actualAction = firstResult(actual.stdout).action;
      console.log(`R6 DECISIVE default: actual  exit=${actual.code} action=${actualAction}`);

      requireExit(actual, 2, 'actual no-force unmanaged different-content (default)');
      expect(actualAction).toBe('refused');
      expect(readLiveSkill(fixture)).toBe(liveBefore);

      expect(previewAction).toBe('refused');
    } finally {
      destroyR6Fixture(fixture);
    }
  });

  test('CONTROL absent slot: preview and actual agree on install', async () => {
    const fixture = buildR6Fixture();
    try {
      expect(existsSync(fixture.livePath)).toBe(false);
      const preview = await runCli(fixture, [
        '--no-prompt',
        'install',
        fixture.src,
        '--tool',
        TOOL,
        '--user',
        '--json',
        '--no-verify',
        '--no-save',
        '--dry-run',
      ]);
      requireExit(preview, 0, 'absent-slot preview');
      const previewAction = firstResult(preview.stdout).action;
      console.log(`R6 CONTROL absent: preview exit=${preview.code} action=${previewAction}`);
      expect(previewAction).toBe('installed');
      expect(existsSync(fixture.livePath)).toBe(false);

      const actual = await runCli(fixture, [
        '--no-prompt',
        'install',
        fixture.src,
        '--tool',
        TOOL,
        '--user',
        '--json',
        '--no-verify',
        '--no-save',
      ]);
      requireExit(actual, 0, 'absent-slot actual');
      expect(firstResult(actual.stdout).action).toBe('installed');
      expect(readLiveSkill(fixture)).toContain('Remote canonical bytes');
    } finally {
      destroyR6Fixture(fixture);
    }
  });

  test('CONTROL matching-content unmanaged: record-repair preserved, preview recorded', async () => {
    const fixture = buildR6Fixture();
    try {
      mkdirSync(fixture.livePath, { recursive: true });
      writeFileSync(join(fixture.livePath, 'SKILL.md'), REMOTE_SKILL_FILE);
      expect(existsSync(fixture.ledgerPath)).toBe(false);
      const liveBefore = readLiveSkill(fixture);

      const preview = await runCli(fixture, [
        '--no-prompt',
        'install',
        fixture.src,
        '--tool',
        TOOL,
        '--user',
        '--json',
        '--no-verify',
        '--no-save',
        '--dry-run',
      ]);
      const previewAction = firstResult(preview.stdout).action;
      console.log(`R6 CONTROL matching: preview exit=${preview.code} action=${previewAction}`);
      expect(readLiveSkill(fixture)).toBe(liveBefore);

      const actual = await runCli(fixture, [
        '--no-prompt',
        'install',
        fixture.src,
        '--tool',
        TOOL,
        '--user',
        '--json',
        '--no-verify',
        '--no-save',
      ]);
      const actualAction = firstResult(actual.stdout).action;
      console.log(`R6 CONTROL matching: actual  exit=${actual.code} action=${actualAction}`);
      // Actual must preserve record-only repair semantics with unchanged live bytes.
      requireExit(actual, 0, 'matching-content unmanaged actual');
      expect(actualAction).toBe('repaired');
      expect(readLiveSkill(fixture)).toBe(liveBefore);
    } finally {
      destroyR6Fixture(fixture);
    }
  });

  test('CONTROL explicit force: different-content preview/action succeed', async () => {
    const fixture = buildR6Fixture();
    try {
      plantUnmanagedDifferent(fixture);
      const forced = await runCli(fixture, [
        '--no-prompt',
        'install',
        fixture.src,
        '--tool',
        TOOL,
        '--user',
        '--json',
        '--no-verify',
        '--no-save',
        '--force',
        '--yes',
      ]);
      requireExit(forced, 0, 'explicit-force actual');
      const action = firstResult(forced.stdout).action;
      console.log(`R6 CONTROL force: actual exit=${forced.code} action=${action}`);
      expect(['updated', 'installed']).toContain(action);
      expect(readLiveSkill(fixture)).toContain('Remote canonical bytes');
    } finally {
      destroyR6Fixture(fixture);
    }
  });
});
