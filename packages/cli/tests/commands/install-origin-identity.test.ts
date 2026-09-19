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

setDefaultTimeout(60_000);

const CLI_ENTRYPOINT = resolve(import.meta.dir, '..', '..', 'src', 'index.ts');
const BUN_EXE = process.execPath;

const HOST_A = 'a.fixture.invalid';
const HOST_B = 'b.fixture.invalid';
const REPO = 'acme/skills';
const SKILL_PATH = 'skills/review';
const SKILL = 'review';

interface OriginFixture {
  root: string;
  home: string;
  data: string;
  cwdDir: string;
  gitConfig: string;
  cloneA: string;
  cloneB: string;
  srcA: string;
  srcB: string;
  shaA: string;
  shaB: string;
  envOverrides: Record<string, string>;
  ledgerPath: string;
  livePath: string;
  manifestPath: string;
  lockPath: string;
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

const writeSkillRepo = (workDir: string, payload: string): void => {
  mkdirSync(join(workDir, 'skills', 'review'), { recursive: true });
  writeFileSync(
    join(workDir, 'skills', 'review', 'SKILL.md'),
    `---\nname: review\ndescription: Fixture.\n---\n\n${payload}\n`,
  );
  runGitSync(workDir, ['init', '-q', '-b', 'main']);
  runGitSync(workDir, [
    '-c',
    'user.email=fixture@skillsmith.test',
    '-c',
    'user.name=fixture',
    '-c',
    'commit.gpgsign=false',
    'add',
    '-A',
  ]);
  runGitSync(workDir, [
    '-c',
    'user.email=fixture@skillsmith.test',
    '-c',
    'user.name=fixture',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    `fixture: ${payload.slice(0, 24)}`,
  ]);
};

const buildOriginFixture = (payloadA: string, payloadB: string): OriginFixture => {
  const root = mkdtempSync(join(tmpdir(), 'skillsmith-origin-identity-'));
  const home = join(root, 'home');
  const data = join(root, 'data');
  const cwdDir = join(root, 'cwd');
  const binDir = join(root, 'bin');
  for (const dir of [home, data, cwdDir, binDir]) mkdirSync(dir, { recursive: true });
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });

  const claudePath = join(binDir, 'claude');
  writeFileSync(claudePath, '#!/bin/sh\necho "claude 9.9.9-fixture"\n');
  chmodSync(claudePath, 0o755);

  const workA = join(root, 'a-work');
  const workB = join(root, 'b-work');
  mkdirSync(workA, { recursive: true });
  mkdirSync(workB, { recursive: true });
  writeSkillRepo(workA, payloadA);
  writeSkillRepo(workB, payloadB);
  const shaA = runGitSync(workA, ['rev-parse', 'HEAD']).trim();
  const shaB = runGitSync(workB, ['rev-parse', 'HEAD']).trim();
  const bareA = join(root, 'a.git');
  const bareB = join(root, 'b.git');
  runGitSync(root, ['clone', '-q', '--bare', workA, bareA]);
  runGitSync(root, ['clone', '-q', '--bare', workB, bareB]);
  for (const bare of [bareA, bareB]) {
    runGitSync(bare, ['config', 'uploadpack.allowFilter', 'true']);
    runGitSync(bare, ['config', 'uploadpack.allowReachableSHA1InWant', 'true']);
  }

  const cloneA = `https://${HOST_A}/${REPO}.git`;
  const cloneB = `https://${HOST_B}/${REPO}.git`;
  const gitConfig = join(root, 'gitconfig');
  writeFileSync(
    gitConfig,
    `[url "file://${bareA}"]
	insteadOf = ${cloneA}
[url "file://${bareB}"]
	insteadOf = ${cloneB}
[url "file://${bareA}"]
	insteadOf = https://${HOST_A}/${REPO}
[url "file://${bareB}"]
	insteadOf = https://${HOST_B}/${REPO}
[protocol "file"]
	allow = always
[protocol "https"]
	allow = never
[protocol "http"]
	allow = never
[protocol "ssh"]
	allow = never
[protocol "git"]
	allow = never
[core]
	hooksPath = /dev/null
[commit]
	gpgsign = false
[tag]
	gpgsign = false
[credential]
	helper =
`,
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
    cloneA,
    cloneB,
    srcA: `${cloneA}//${SKILL_PATH}`,
    srcB: `${cloneB}//${SKILL_PATH}`,
    shaA,
    shaB,
    envOverrides,
    ledgerPath: join(data, 'placements.json'),
    livePath: join(home, '.claude', 'skills', SKILL),
    manifestPath: join(xdgConfig, 'skillsmith', 'skillsmith.toml'),
    lockPath: join(xdgConfig, 'skillsmith', 'skillsmith.lock'),
  };
};

const destroyOriginFixture = (fixture: OriginFixture): void => {
  rmSync(fixture.root, { recursive: true, force: true });
};

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const runCli = async (fixture: OriginFixture, args: string[]): Promise<CliResult> => {
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

interface InstallJsonResult {
  action: string;
  reason: string | null;
  origin: { host: string; repo: string; skillPath: string; refResolved: string } | null;
}

const firstResult = (stdout: string): InstallJsonResult => {
  const report = JSON.parse(stdout) as { results: InstallJsonResult[] };
  const result = report.results[0];
  if (!result) throw new Error(`expected one result in stdout:\n${stdout.slice(0, 2000)}`);
  return result;
};

interface InstallJsonArtifactEffect {
  skill: string | null;
  manifestAction: string;
  lockAction: string;
}

const artifactEffects = (stdout: string): InstallJsonArtifactEffect[] => {
  const report = JSON.parse(stdout) as { artifactEffects?: InstallJsonArtifactEffect[] };
  return report.artifactEffects ?? [];
};

const readLedgerOrigin = (
  fixture: OriginFixture,
): { host: string; repo: string; refResolved: string } => {
  const raw = JSON.parse(readFileSync(fixture.ledgerPath, 'utf8')) as {
    skills?: Record<
      string,
      { tools?: Record<string, { origin?: { host: string; repo: string; refResolved: string } }> }
    >;
  };
  const origin = raw.skills?.[SKILL]?.tools?.['claude-code']?.origin;
  if (!origin) throw new Error(`missing ledger origin in ${fixture.ledgerPath}`);
  return origin;
};

const readLiveBytes = (fixture: OriginFixture): string =>
  readFileSync(join(fixture.livePath, 'SKILL.md'), 'utf8');

const readArtifact = (path: string): string | null =>
  existsSync(path) ? readFileSync(path, 'utf8') : null;

describe('install origin identity (SC-I60-R2)', () => {
  test('live-only --no-save cross-host without --force refuses and preserves origin/live', async () => {
    const fixture = buildOriginFixture('# review A payload-AAA', '# review B payload-BBB-DISTINCT');
    try {
      expect(fixture.shaA).not.toBe(fixture.shaB);
      const seed = await runCli(fixture, [
        '--no-prompt',
        'install',
        fixture.srcA,
        '--tool',
        'claude-code',
        '--user',
        '--json',
        '--no-verify',
        '--no-save',
      ]);
      requireExit(seed, 0, 'seed install A --no-save');
      expect(firstResult(seed.stdout).action).toBe('installed');

      const ledgerBefore = readFileSync(fixture.ledgerPath, 'utf8');
      const originBefore = readLedgerOrigin(fixture);
      expect(originBefore.host).toBe(HOST_A);
      const liveBefore = readLiveBytes(fixture);

      const attempt = await runCli(fixture, [
        '--no-prompt',
        'install',
        fixture.srcB,
        '--tool',
        'claude-code',
        '--user',
        '--json',
        '--no-verify',
        '--no-save',
      ]);
      requireExit(attempt, 2, 'cross-host B --no-save without force');
      const refused = firstResult(attempt.stdout);
      expect(refused.action).toBe('refused');
      expect(refused.reason ?? '').toContain('--force');

      expect(readFileSync(fixture.ledgerPath, 'utf8')).toBe(ledgerBefore);
      expect(readLedgerOrigin(fixture)).toEqual(originBefore);
      expect(readLiveBytes(fixture)).toBe(liveBefore);
    } finally {
      destroyOriginFixture(fixture);
    }
  });

  test('desired-state (default) cross-host without --force refuses and preserves live/ledger/artifacts', async () => {
    const fixture = buildOriginFixture('# review A payload-AAA', '# review B payload-BBB-DISTINCT');
    try {
      const seed = await runCli(fixture, [
        '--no-prompt',
        'install',
        fixture.srcA,
        '--tool',
        'claude-code',
        '--user',
        '--json',
        '--no-verify',
      ]);
      requireExit(seed, 0, 'seed install A desired-state');
      expect(firstResult(seed.stdout).action).toBe('installed');

      const ledgerBefore = readFileSync(fixture.ledgerPath, 'utf8');
      const originBefore = readLedgerOrigin(fixture);
      const liveBefore = readLiveBytes(fixture);
      const manifestBefore = readArtifact(fixture.manifestPath);
      expect(manifestBefore).not.toBeNull();
      expect(manifestBefore).toContain(HOST_A);
      const lockBefore = readArtifact(fixture.lockPath);
      expect(lockBefore).not.toBeNull();

      const attempt = await runCli(fixture, [
        '--no-prompt',
        'install',
        fixture.srcB,
        '--tool',
        'claude-code',
        '--user',
        '--json',
        '--no-verify',
      ]);
      requireExit(attempt, 2, 'cross-host B desired-state without force');
      expect(firstResult(attempt.stdout).action).toBe('refused');

      // Legacy owner fix preserves live placement and recorded origin.
      expect(readFileSync(fixture.ledgerPath, 'utf8')).toBe(ledgerBefore);
      expect(readLedgerOrigin(fixture)).toEqual(originBefore);
      expect(readLiveBytes(fixture)).toBe(liveBefore);

      // SC-I60-R2 amendment 1: a refused install decides nothing, so the
      // desired-state manifest and lockfile keep their pre-attempt bytes.
      const manifestAfter = readArtifact(fixture.manifestPath);
      expect(manifestAfter).toBe(manifestBefore);
      expect(manifestAfter ?? '').toContain(HOST_A);
      expect(manifestAfter ?? '').not.toContain(HOST_B);
      expect(readArtifact(fixture.lockPath)).toBe(lockBefore);
    } finally {
      destroyOriginFixture(fixture);
    }
  });

  test('live-only preview (--dry-run --no-save) refuses instead of predicting update', async () => {
    const fixture = buildOriginFixture('# review A payload-AAA', '# review B payload-BBB-DISTINCT');
    try {
      const seed = await runCli(fixture, [
        '--no-prompt',
        'install',
        fixture.srcA,
        '--tool',
        'claude-code',
        '--user',
        '--json',
        '--no-verify',
        '--no-save',
      ]);
      requireExit(seed, 0, 'seed install A --no-save');
      const ledgerBefore = readFileSync(fixture.ledgerPath, 'utf8');

      const preview = await runCli(fixture, [
        '--no-prompt',
        'install',
        fixture.srcB,
        '--tool',
        'claude-code',
        '--user',
        '--json',
        '--no-verify',
        '--no-save',
        '--dry-run',
      ]);
      requireExit(preview, 2, 'cross-host B preview');
      expect(firstResult(preview.stdout).action).toBe('refused');
      expect(readFileSync(fixture.ledgerPath, 'utf8')).toBe(ledgerBefore);
    } finally {
      destroyOriginFixture(fixture);
    }
  });

  test('explicit --force cross-host replaces origin/live', async () => {
    const fixture = buildOriginFixture('# review A payload-AAA', '# review B payload-BBB-DISTINCT');
    try {
      const seed = await runCli(fixture, [
        '--no-prompt',
        'install',
        fixture.srcA,
        '--tool',
        'claude-code',
        '--user',
        '--json',
        '--no-verify',
        '--no-save',
      ]);
      requireExit(seed, 0, 'seed install A --no-save');

      const forced = await runCli(fixture, [
        '--no-prompt',
        'install',
        fixture.srcB,
        '--tool',
        'claude-code',
        '--user',
        '--json',
        '--no-verify',
        '--no-save',
        '--force',
        '--yes',
      ]);
      requireExit(forced, 0, 'cross-host B --force --no-save');
      expect(firstResult(forced.stdout).action).toBe('updated');
      expect(readLedgerOrigin(fixture).host).toBe(HOST_B);
      expect(readLiveBytes(fixture)).toContain('payload-BBB-DISTINCT');
    } finally {
      destroyOriginFixture(fixture);
    }
  });

  test('identical payload cross-host preserves recorded origin/live', async () => {
    const fixture = buildOriginFixture('# review SAME payload', '# review SAME payload');
    try {
      const seed = await runCli(fixture, [
        '--no-prompt',
        'install',
        fixture.srcA,
        '--tool',
        'claude-code',
        '--user',
        '--json',
        '--no-verify',
        '--no-save',
      ]);
      requireExit(seed, 0, 'seed install A --no-save');
      const ledgerBefore = readFileSync(fixture.ledgerPath, 'utf8');
      const liveBefore = readLiveBytes(fixture);

      const attempt = await runCli(fixture, [
        '--no-prompt',
        'install',
        fixture.srcB,
        '--tool',
        'claude-code',
        '--user',
        '--json',
        '--no-verify',
        '--no-save',
      ]);
      const result = firstResult(attempt.stdout);
      expect(readLedgerOrigin(fixture).host).toBe(HOST_A);
      expect(readLiveBytes(fixture)).toBe(liveBefore);
      if (result.action === 'refused') {
        expect(attempt.code).toBe(2);
        expect(readFileSync(fixture.ledgerPath, 'utf8')).toBe(ledgerBefore);
      } else {
        expect(['noop', 'repaired']).toContain(result.action);
      }
    } finally {
      destroyOriginFixture(fixture);
    }
  });

  test('desired-state explicit --force cross-host advances manifest, lock, live, and ledger together', async () => {
    const fixture = buildOriginFixture('# review A payload-AAA', '# review B payload-BBB-DISTINCT');
    try {
      const seed = await runCli(fixture, [
        '--no-prompt',
        'install',
        fixture.srcA,
        '--tool',
        'claude-code',
        '--user',
        '--json',
        '--no-verify',
      ]);
      requireExit(seed, 0, 'seed install A desired-state');
      expect(firstResult(seed.stdout).action).toBe('installed');
      const manifestBefore = readArtifact(fixture.manifestPath);
      const lockBefore = readArtifact(fixture.lockPath);

      const forced = await runCli(fixture, [
        '--no-prompt',
        'install',
        fixture.srcB,
        '--tool',
        'claude-code',
        '--user',
        '--json',
        '--no-verify',
        '--force',
        '--yes',
      ]);
      requireExit(forced, 0, 'cross-host B --force desired-state');
      expect(firstResult(forced.stdout).action).toBe('updated');

      expect(readLedgerOrigin(fixture).host).toBe(HOST_B);
      expect(readLiveBytes(fixture)).toContain('payload-BBB-DISTINCT');
      const manifestAfter = readArtifact(fixture.manifestPath);
      expect(manifestAfter).not.toBe(manifestBefore);
      expect(manifestAfter ?? '').toContain(HOST_B);
      expect(manifestAfter ?? '').not.toContain(HOST_A);
      const lockAfter = readArtifact(fixture.lockPath);
      expect(lockAfter).not.toBe(lockBefore);
      expect(lockAfter ?? '').toContain(HOST_B);
      expect(lockAfter ?? '').not.toContain(HOST_A);
    } finally {
      destroyOriginFixture(fixture);
    }
  });

  test('desired-state cross-host refusal completes planning with no artifact effects', async () => {
    const fixture = buildOriginFixture('# review A payload-AAA', '# review B payload-BBB-DISTINCT');
    try {
      const seed = await runCli(fixture, [
        '--no-prompt',
        'install',
        fixture.srcA,
        '--tool',
        'claude-code',
        '--user',
        '--json',
        '--no-verify',
      ]);
      requireExit(seed, 0, 'seed install A desired-state');
      expect(firstResult(seed.stdout).action).toBe('installed');
      const manifestBefore = readArtifact(fixture.manifestPath);
      const lockBefore = readArtifact(fixture.lockPath);

      const attempt = await runCli(fixture, [
        '--no-prompt',
        'install',
        fixture.srcB,
        '--tool',
        'claude-code',
        '--user',
        '--json',
        '--no-verify',
      ]);
      requireExit(attempt, 2, 'cross-host B desired-state without force');
      const refused = firstResult(attempt.stdout);
      expect(refused.action).toBe('refused');
      expect(refused.reason ?? '').toContain('--force');

      const effects = artifactEffects(attempt.stdout);
      expect(effects).toHaveLength(1);
      expect(effects[0]).toMatchObject({
        skill: SKILL,
        manifestAction: 'keep',
        lockAction: 'keep',
      });
      expect(readArtifact(fixture.manifestPath)).toBe(manifestBefore);
      expect(readArtifact(fixture.lockPath)).toBe(lockBefore);
    } finally {
      destroyOriginFixture(fixture);
    }
  });
});
