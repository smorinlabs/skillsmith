import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { lstat, readlink, realpath } from 'node:fs/promises';
import { buildRemoteFixture, destroyRemoteFixture } from '../fixtures/acquire/remote.ts';
import { hermeticGitEnv } from '../fixtures/git-env.ts';
import { buildFixtureFleet, destroyFixtureFleet } from '../fixtures/place/fleet.ts';

describe('RemoteFixture', () => {
  // The bare remotes are immutable during these read-only assertions, so the fixture is built
  // once for the whole suite rather than per test — rebuilding it per test spins up three bare
  // git repos each time and saturates git subprocess spawns (a source of CI flakiness).
  let fixture: Awaited<ReturnType<typeof buildRemoteFixture>>;

  beforeAll(async () => {
    fixture = await buildRemoteFixture();
  });

  afterAll(async () => {
    await destroyRemoteFixture(fixture);
  });

  test('buildRemoteFixture() resolves', () => {
    expect(fixture).toBeDefined();
  });

  test('multi.git exists and is a bare repository', () => {
    const result = Bun.spawnSync(
      ['git', '-C', `${fixture.base}/multi.git`, 'rev-parse', '--is-bare-repository'],
      {
        env: hermeticGitEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const output = new TextDecoder().decode(result.stdout).trim();
    expect(output).toBe('true');
  });

  test('single.git exists and is a bare repository', () => {
    const result = Bun.spawnSync(
      ['git', '-C', `${fixture.base}/single.git`, 'rev-parse', '--is-bare-repository'],
      {
        env: hermeticGitEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const output = new TextDecoder().decode(result.stdout).trim();
    expect(output).toBe('true');
  });

  test('root.git exists and is a bare repository', () => {
    const result = Bun.spawnSync(
      ['git', '-C', `${fixture.base}/root.git`, 'rev-parse', '--is-bare-repository'],
      {
        env: hermeticGitEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const output = new TextDecoder().decode(result.stdout).trim();
    expect(output).toBe('true');
  });

  test('multi.git has uploadpack.allowFilter set to true', () => {
    const result = Bun.spawnSync(
      ['git', '-C', `${fixture.base}/multi.git`, 'config', '--get', 'uploadpack.allowFilter'],
      {
        env: hermeticGitEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const output = new TextDecoder().decode(result.stdout).trim();
    expect(output).toBe('true');
  });

  test('multi.git has uploadpack.allowReachableSHA1InWant set to true', () => {
    const result = Bun.spawnSync(
      [
        'git',
        '-C',
        `${fixture.base}/multi.git`,
        'config',
        '--get',
        'uploadpack.allowReachableSHA1InWant',
      ],
      {
        env: hermeticGitEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const output = new TextDecoder().decode(result.stdout).trim();
    expect(output).toBe('true');
  });

  test('multiHead and multiTagSha are both 40-hex SHAs', () => {
    expect(fixture.multiHead).toMatch(/^[0-9a-f]{40}$/);
    expect(fixture.multiTagSha).toMatch(/^[0-9a-f]{40}$/);
  });

  test('singleHead is a 40-hex SHA', () => {
    expect(fixture.singleHead).toMatch(/^[0-9a-f]{40}$/);
  });

  test('rootHead is a 40-hex SHA', () => {
    expect(fixture.rootHead).toMatch(/^[0-9a-f]{40}$/);
  });

  test('multiTagSha differs from multiHead', () => {
    expect(fixture.multiTagSha).not.toBe(fixture.multiHead);
  });

  test('git ls-remote multiUrl HEAD contains multiHead', () => {
    const result = Bun.spawnSync(['git', 'ls-remote', fixture.multiUrl, 'HEAD'], {
      env: hermeticGitEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = new TextDecoder().decode(result.stdout);
    expect(output).toContain(fixture.multiHead);
  });

  test('multiWork contains plugins/web/skills/review/SKILL.md', async () => {
    const stats = await lstat(`${fixture.multiWork}/plugins/web/skills/review/SKILL.md`);
    expect(stats.isFile()).toBe(true);
  });

  test('multiWork contains plugins/api/skills/review/SKILL.md', async () => {
    const stats = await lstat(`${fixture.multiWork}/plugins/api/skills/review/SKILL.md`);
    expect(stats.isFile()).toBe(true);
  });

  test('multiWork/plugins/fh/skills/factor-scan/bin/run.sh has owner-exec bit', async () => {
    const stats = await lstat(`${fixture.multiWork}/plugins/fh/skills/factor-scan/bin/run.sh`);
    expect((stats.mode & 0o100) !== 0).toBe(true);
  });

  test('multiWork/plugins/fh/skills/factor-scan/link.md is a relative symlink with target SKILL.md', async () => {
    const linkStats = await lstat(`${fixture.multiWork}/plugins/fh/skills/factor-scan/link.md`);
    expect(linkStats.isSymbolicLink()).toBe(true);
    const target = await readlink(`${fixture.multiWork}/plugins/fh/skills/factor-scan/link.md`);
    expect(target).toBe('SKILL.md');
  });

  test('destroyRemoteFixture removes base directory', async () => {
    // This test owns its own throwaway fixture because it asserts teardown behavior; it must not
    // destroy the suite-shared fixture that beforeAll built.
    const own = await buildRemoteFixture();
    expect((await lstat(own.base)).isDirectory()).toBe(true);
    await destroyRemoteFixture(own);
    let baseExistsAfter = false;
    try {
      await lstat(own.base);
      baseExistsAfter = true;
    } catch {
      baseExistsAfter = false;
    }
    expect(baseExistsAfter).toBe(false);
  });
});

describe('FixtureFleet with project extensions', () => {
  // Read-only assertions against an immutable fleet — built once for the suite (no test calls
  // makeCheckoutDirty, so the shared checkout stays clean).
  let fleet: Awaited<ReturnType<typeof buildFixtureFleet>>;

  beforeAll(async () => {
    fleet = await buildFixtureFleet();
  });

  afterAll(async () => {
    await destroyFixtureFleet(fleet);
  });

  test('buildFixtureFleet() still resolves with all pre-existing fields', () => {
    expect(fleet).toBeDefined();
    expect(fleet.base).toBeDefined();
    expect(fleet.home).toBeDefined();
    expect(fleet.data).toBeDefined();
    expect(fleet.checkout).toBeDefined();
    expect(fleet.alphaSrc).toBeDefined();
    expect(fleet.betaSrc).toBeDefined();
    expect(fleet.gammaSrc).toBeDefined();
    expect(fleet.headSha).toBeDefined();
    expect(fleet.env).toBeDefined();
    expect(fleet.envVars).toBeDefined();
    expect(fleet.makeCheckoutDirty).toBeDefined();
  });

  test('buildFixtureFleet() has project field', () => {
    expect(fleet.project).toBeDefined();
  });

  test('buildFixtureFleet() has projectReal field', () => {
    expect(fleet.projectReal).toBeDefined();
  });

  test('project/.git exists', async () => {
    const stats = await lstat(`${fleet.project}/.git`);
    expect(stats.isDirectory()).toBe(true);
  });

  test('projectReal equals realpath(project)', async () => {
    const realPath = await realpath(fleet.project);
    expect(fleet.projectReal).toBe(realPath);
  });

  test('all pre-existing fleet assertions pass', async () => {
    // From original fleet.test.ts
    expect(fleet.headSha).toMatch(/^[0-9a-f]{40}$/);

    // Check git status is clean
    const result = Bun.spawnSync(['git', '-C', fleet.checkout, 'status', '--porcelain'], {
      env: hermeticGitEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = new TextDecoder().decode(result.stdout);
    expect(output).toBe('');

    // Check symlink
    const linkStats = await lstat(`${fleet.home}/.claude/skills/alpha`);
    expect(linkStats.isSymbolicLink()).toBe(true);
    const target = await readlink(`${fleet.home}/.claude/skills/alpha`);
    expect(target).toBe(fleet.alphaSrc);

    // Check alpha/bin/run.sh has owner-exec bit
    const runStats = await lstat(`${fleet.alphaSrc}/bin/run.sh`);
    expect((runStats.mode & 0o100) !== 0).toBe(true);

    // Check alpha/link.md is relative symlink
    const alphaLinkStats = await lstat(`${fleet.alphaSrc}/link.md`);
    expect(alphaLinkStats.isSymbolicLink()).toBe(true);
    const alphaLinkTarget = await readlink(`${fleet.alphaSrc}/link.md`);
    expect(alphaLinkTarget).toBe('SKILL.md');

    // Check env.homeDir
    expect(fleet.env.homeDir).toBe(fleet.home);

    // Check envVars
    expect(fleet.envVars.SKILLSMITH_HOME).toBe(fleet.data);
  });
});
