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
import {
  CM2_CONTROL_NAME,
  CM2_CONTROL_PATH,
  CM2_CONTROL_SKILL_MD,
  CM2_DASH_SKILL_MD,
  CM2_HOST,
  CM2_REPO,
  CM2_ROOT_NAME,
  CM2_ROOT_REPO,
  CM2_ROOT_SKILL_MD,
  CM2_SKILL_NAME,
  CM2_SKILL_PATH,
  type Cm2Fixture,
  buildCm2Fixture,
  destroyCm2Fixture,
} from '../../../core/tests/fixtures/acquire/cm2-leading-dash.ts';
import { hermeticGitEnv } from '../../../core/tests/fixtures/git-env.ts';

setDefaultTimeout(60_000);

const CLI_ENTRYPOINT = resolve(import.meta.dir, '..', '..', 'src', 'index.ts');
const BUN_EXE = process.execPath;

interface Cm2CliFixture {
  root: string;
  home: string;
  data: string;
  cwdDir: string;
  gitConfig: string;
  cm2: Cm2Fixture;
  envOverrides: Record<string, string>;
  dashSource: string;
  controlSource: string;
  rootSource: string;
  ledgerPath: string;
  manifestPath: string;
  lockPath: string;
}

const buildCm2CliFixture = async (): Promise<Cm2CliFixture> => {
  const root = mkdtempSync(join(tmpdir(), 'skillsmith-cm2-cli-'));
  const cm2 = await buildCm2Fixture();
  const home = join(root, 'home');
  const data = join(root, 'data');
  const cwdDir = join(root, 'cwd');
  const binDir = join(root, 'bin');
  for (const dir of [home, data, cwdDir, binDir]) mkdirSync(dir, { recursive: true });
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });

  const claudePath = join(binDir, 'claude');
  writeFileSync(claudePath, '#!/bin/sh\necho "claude 9.9.9-fixture"\n');
  chmodSync(claudePath, 0o755);

  // One exact fixture-owned global config: https identities rewrite to the real
  // owned file:// remotes; every network protocol is refused so a missing
  // rewrite fails offline instead of touching the network.
  const gitConfig = join(root, 'gitconfig');
  writeFileSync(
    gitConfig,
    `[url "file://${cm2.bareRepo}"]
	insteadOf = ${cm2.cloneUrl}
[url "file://${cm2.bareRepo}"]
	insteadOf = https://${CM2_HOST}/${CM2_REPO}
[url "file://${cm2.rootBareRepo}"]
	insteadOf = ${cm2.rootCloneUrl}
[url "file://${cm2.rootBareRepo}"]
	insteadOf = https://${CM2_HOST}/${CM2_ROOT_REPO}
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
    cm2,
    envOverrides,
    dashSource: `${cm2.cloneUrl}//${CM2_SKILL_PATH}@${cm2.head}`,
    controlSource: `${cm2.cloneUrl}//${CM2_CONTROL_PATH}@${cm2.head}`,
    rootSource: `${cm2.rootCloneUrl}@${cm2.rootHead}`,
    ledgerPath: join(data, 'placements.json'),
    manifestPath: join(xdgConfig, 'skillsmith', 'skillsmith.toml'),
    lockPath: join(xdgConfig, 'skillsmith', 'skillsmith.lock'),
  };
};

const destroyCm2CliFixture = async (fixture: Cm2CliFixture): Promise<void> => {
  await destroyCm2Fixture(fixture.cm2);
  rmSync(fixture.root, { recursive: true, force: true });
};

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const runCli = async (fixture: Cm2CliFixture, args: string[]): Promise<CliResult> => {
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
  const report = JSON.parse(stdout) as { kind: string; results: InstallJsonResult[] };
  expect(report.kind).toBe('skillsmith.install');
  const result = report.results[0];
  if (!result) throw new Error(`expected one result in stdout:\n${stdout.slice(0, 2000)}`);
  return result;
};

const readLedgerOrigin = (
  fixture: Cm2CliFixture,
  skill: string,
): { host: string; repo: string; refResolved: string } => {
  const raw = JSON.parse(readFileSync(fixture.ledgerPath, 'utf8')) as {
    skills?: Record<
      string,
      { tools?: Record<string, { origin?: { host: string; repo: string; refResolved: string } }> }
    >;
  };
  const origin = raw.skills?.[skill]?.tools?.['claude-code']?.origin;
  if (!origin) throw new Error(`missing ledger origin for ${skill} in ${fixture.ledgerPath}`);
  return origin;
};

const readLiveBytes = (fixture: Cm2CliFixture, skill: string): string =>
  readFileSync(join(fixture.home, '.claude', 'skills', skill, 'SKILL.md'), 'utf8');

describe('install leading-dash sparse path (SC-I60-CM2)', () => {
  test('fresh regular-path install succeeds first (control)', async () => {
    const fixture = await buildCm2CliFixture();
    try {
      const r = await runCli(fixture, [
        '--no-prompt',
        'install',
        fixture.controlSource,
        '--tool',
        'claude-code',
        '--user',
        '--json',
        '--no-verify',
      ]);
      requireExit(r, 0, 'regular-path install');
      expect(firstResult(r.stdout).action).toBe('installed');
      expect(readLiveBytes(fixture, CM2_CONTROL_NAME)).toBe(CM2_CONTROL_SKILL_MD);
      expect(readLedgerOrigin(fixture, CM2_CONTROL_NAME).refResolved).toBe(fixture.cm2.head);
    } finally {
      await destroyCm2CliFixture(fixture);
    }
  });

  test('leading-dash subtree installs with correct payload and recorded source/path/SHA', async () => {
    const fixture = await buildCm2CliFixture();
    try {
      const r = await runCli(fixture, [
        '--no-prompt',
        'install',
        fixture.dashSource,
        '--tool',
        'claude-code',
        '--user',
        '--json',
        '--no-verify',
      ]);
      requireExit(r, 0, 'leading-dash install');
      const result = firstResult(r.stdout);
      expect(result.action).toBe('installed');
      expect(result.origin).toMatchObject({
        host: CM2_HOST,
        repo: CM2_REPO,
        skillPath: CM2_SKILL_PATH,
        refResolved: fixture.cm2.head,
      });
      expect(readLiveBytes(fixture, CM2_SKILL_NAME)).toBe(CM2_DASH_SKILL_MD);
      expect(readLedgerOrigin(fixture, CM2_SKILL_NAME)).toMatchObject({
        host: CM2_HOST,
        repo: CM2_REPO,
        refResolved: fixture.cm2.head,
      });
      expect(existsSync(fixture.manifestPath)).toBe(true);
      expect(readFileSync(fixture.manifestPath, 'utf8')).toContain(CM2_HOST);
      expect(existsSync(fixture.lockPath)).toBe(true);
    } finally {
      await destroyCm2CliFixture(fixture);
    }
  });

  test('root install succeeds (control)', async () => {
    const fixture = await buildCm2CliFixture();
    try {
      const r = await runCli(fixture, [
        '--no-prompt',
        'install',
        fixture.rootSource,
        '--tool',
        'claude-code',
        '--user',
        '--json',
        '--no-verify',
      ]);
      requireExit(r, 0, 'root install');
      expect(firstResult(r.stdout).action).toBe('installed');
      // Root installs take the repo-leaf name (R5 characterization), which the
      // fixture aligns with the manifest name: owner/cm2root -> cm2root.
      expect(readLiveBytes(fixture, CM2_ROOT_NAME)).toBe(CM2_ROOT_SKILL_MD);
      expect(readLedgerOrigin(fixture, CM2_ROOT_NAME).refResolved).toBe(fixture.cm2.rootHead);
    } finally {
      await destroyCm2CliFixture(fixture);
    }
  });
});
