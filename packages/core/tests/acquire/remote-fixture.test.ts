import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, readlink, realpath } from 'node:fs/promises';
import { buildRemoteFixture, destroyRemoteFixture } from '../fixtures/acquire/remote.ts';
import { buildFixtureFleet, destroyFixtureFleet } from '../fixtures/place/fleet.ts';

describe('RemoteFixture', () => {
  let fixture: Awaited<ReturnType<typeof buildRemoteFixture>> | null = null;

  afterEach(async () => {
    if (fixture) {
      await destroyRemoteFixture(fixture);
      fixture = null;
    }
  });

  test('buildRemoteFixture() resolves', async () => {
    fixture = await buildRemoteFixture();
    expect(fixture).toBeDefined();
  });

  test('multi.git exists and is a bare repository', async () => {
    fixture = await buildRemoteFixture();
    const result = Bun.spawnSync(
      ['git', '-C', `${fixture.base}/multi.git`, 'rev-parse', '--is-bare-repository'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const output = new TextDecoder().decode(result.stdout).trim();
    expect(output).toBe('true');
  });

  test('single.git exists and is a bare repository', async () => {
    fixture = await buildRemoteFixture();
    const result = Bun.spawnSync(
      ['git', '-C', `${fixture.base}/single.git`, 'rev-parse', '--is-bare-repository'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const output = new TextDecoder().decode(result.stdout).trim();
    expect(output).toBe('true');
  });

  test('root.git exists and is a bare repository', async () => {
    fixture = await buildRemoteFixture();
    const result = Bun.spawnSync(
      ['git', '-C', `${fixture.base}/root.git`, 'rev-parse', '--is-bare-repository'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const output = new TextDecoder().decode(result.stdout).trim();
    expect(output).toBe('true');
  });

  test('multi.git has uploadpack.allowFilter set to true', async () => {
    fixture = await buildRemoteFixture();
    const result = Bun.spawnSync(
      ['git', '-C', `${fixture.base}/multi.git`, 'config', '--get', 'uploadpack.allowFilter'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const output = new TextDecoder().decode(result.stdout).trim();
    expect(output).toBe('true');
  });

  test('multi.git has uploadpack.allowReachableSHA1InWant set to true', async () => {
    fixture = await buildRemoteFixture();
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
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const output = new TextDecoder().decode(result.stdout).trim();
    expect(output).toBe('true');
  });

  test('multiHead and multiTagSha are both 40-hex SHAs', async () => {
    fixture = await buildRemoteFixture();
    expect(fixture.multiHead).toMatch(/^[0-9a-f]{40}$/);
    expect(fixture.multiTagSha).toMatch(/^[0-9a-f]{40}$/);
  });

  test('singleHead is a 40-hex SHA', async () => {
    fixture = await buildRemoteFixture();
    expect(fixture.singleHead).toMatch(/^[0-9a-f]{40}$/);
  });

  test('rootHead is a 40-hex SHA', async () => {
    fixture = await buildRemoteFixture();
    expect(fixture.rootHead).toMatch(/^[0-9a-f]{40}$/);
  });

  test('multiTagSha differs from multiHead', async () => {
    fixture = await buildRemoteFixture();
    expect(fixture.multiTagSha).not.toBe(fixture.multiHead);
  });

  test('git ls-remote multiUrl HEAD contains multiHead', async () => {
    fixture = await buildRemoteFixture();
    const result = Bun.spawnSync(['git', 'ls-remote', fixture.multiUrl, 'HEAD'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = new TextDecoder().decode(result.stdout);
    expect(output).toContain(fixture.multiHead);
  });

  test('multiWork contains plugins/web/skills/review/SKILL.md', async () => {
    fixture = await buildRemoteFixture();
    try {
      await lstat(`${fixture.multiWork}/plugins/web/skills/review/SKILL.md`);
      expect(true).toBe(true);
    } catch {
      expect(false).toBe(true);
    }
  });

  test('multiWork contains plugins/api/skills/review/SKILL.md', async () => {
    fixture = await buildRemoteFixture();
    try {
      await lstat(`${fixture.multiWork}/plugins/api/skills/review/SKILL.md`);
      expect(true).toBe(true);
    } catch {
      expect(false).toBe(true);
    }
  });

  test('multiWork/plugins/fh/skills/factor-scan/bin/run.sh has owner-exec bit', async () => {
    fixture = await buildRemoteFixture();
    const stats = await lstat(`${fixture.multiWork}/plugins/fh/skills/factor-scan/bin/run.sh`);
    expect((stats.mode & 0o100) !== 0).toBe(true);
  });

  test('multiWork/plugins/fh/skills/factor-scan/link.md is a relative symlink with target SKILL.md', async () => {
    fixture = await buildRemoteFixture();
    const linkStats = await lstat(`${fixture.multiWork}/plugins/fh/skills/factor-scan/link.md`);
    expect(linkStats.isSymbolicLink()).toBe(true);
    const target = await readlink(`${fixture.multiWork}/plugins/fh/skills/factor-scan/link.md`);
    expect(target).toBe('SKILL.md');
  });

  test('destroyRemoteFixture removes base directory', async () => {
    fixture = await buildRemoteFixture();
    let baseExists = false;
    try {
      await lstat(fixture.base);
      baseExists = true;
    } catch {
      baseExists = false;
    }
    expect(baseExists).toBe(true);
    await destroyRemoteFixture(fixture);
    let baseExistsAfter = false;
    try {
      await lstat(fixture.base);
      baseExistsAfter = true;
    } catch {
      baseExistsAfter = false;
    }
    expect(baseExistsAfter).toBe(false);
    fixture = null;
  });
});

describe('FixtureFleet with project extensions', () => {
  let fleet: Awaited<ReturnType<typeof buildFixtureFleet>> | null = null;

  afterEach(async () => {
    if (fleet) {
      await destroyFixtureFleet(fleet);
      fleet = null;
    }
  });

  test('buildFixtureFleet() still resolves with all pre-existing fields', async () => {
    fleet = await buildFixtureFleet();
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

  test('buildFixtureFleet() has project field', async () => {
    fleet = await buildFixtureFleet();
    expect(fleet.project).toBeDefined();
  });

  test('buildFixtureFleet() has projectReal field', async () => {
    fleet = await buildFixtureFleet();
    expect(fleet.projectReal).toBeDefined();
  });

  test('project/.git exists', async () => {
    fleet = await buildFixtureFleet();
    try {
      await lstat(`${fleet.project}/.git`);
      expect(true).toBe(true);
    } catch {
      expect(false).toBe(true);
    }
  });

  test('projectReal equals realpath(project)', async () => {
    fleet = await buildFixtureFleet();
    const realPath = await realpath(fleet.project);
    expect(fleet.projectReal).toBe(realPath);
  });

  test('all pre-existing fleet assertions pass', async () => {
    fleet = await buildFixtureFleet();

    // From original fleet.test.ts
    expect(fleet.headSha).toMatch(/^[0-9a-f]{40}$/);

    // Check git status is clean
    const result = Bun.spawnSync(['git', '-C', fleet.checkout, 'status', '--porcelain'], {
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
