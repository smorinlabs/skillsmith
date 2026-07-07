import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, readlink, stat } from 'node:fs/promises';
import { buildFixtureFleet, destroyFixtureFleet } from '../fixtures/place/fleet.ts';

describe('FixtureFleet', () => {
  let fleet: Awaited<ReturnType<typeof buildFixtureFleet>> | null = null;

  afterEach(async () => {
    if (fleet) {
      await destroyFixtureFleet(fleet);
      fleet = null;
    }
  });

  test('buildFixtureFleet() resolves', async () => {
    fleet = await buildFixtureFleet();
    expect(fleet).toBeDefined();
  });

  test('checkout/.git exists', async () => {
    fleet = await buildFixtureFleet();
    try {
      await lstat(`${fleet.checkout}/.git`);
      expect(true).toBe(true);
    } catch {
      expect(false).toBe(true);
    }
  });

  test('headSha matches /^[0-9a-f]{40}$/', async () => {
    fleet = await buildFixtureFleet();
    expect(fleet.headSha).toMatch(/^[0-9a-f]{40}$/);
  });

  test('git status is clean initially', async () => {
    fleet = await buildFixtureFleet();
    const result = Bun.spawnSync(['git', '-C', fleet.checkout, 'status', '--porcelain'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = new TextDecoder().decode(result.stdout);
    expect(output).toBe('');
  });

  test('after makeCheckoutDirty(), git status contains alpha/SKILL.md', async () => {
    fleet = await buildFixtureFleet();
    await fleet.makeCheckoutDirty();
    const result = Bun.spawnSync(['git', '-C', fleet.checkout, 'status', '--porcelain'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = new TextDecoder().decode(result.stdout);
    expect(output).toContain('plugins/fh/skills/alpha/SKILL.md');
  });

  test('home/.claude/skills/alpha is an absolute symlink to alphaSrc', async () => {
    fleet = await buildFixtureFleet();
    const linkStats = await lstat(`${fleet.home}/.claude/skills/alpha`);
    expect(linkStats.isSymbolicLink()).toBe(true);
    const target = await readlink(`${fleet.home}/.claude/skills/alpha`);
    expect(target).toBe(fleet.alphaSrc);
  });

  test('home/.claude/skills/copied is a real directory', async () => {
    fleet = await buildFixtureFleet();
    const stats = await lstat(`${fleet.home}/.claude/skills/copied`);
    expect(stats.isDirectory()).toBe(true);
    expect(stats.isSymbolicLink()).toBe(false);
  });

  test('home/.claude/skills/dangler is a dangling symlink', async () => {
    fleet = await buildFixtureFleet();
    const linkStats = await lstat(`${fleet.home}/.claude/skills/dangler`);
    expect(linkStats.isSymbolicLink()).toBe(true);
    // Attempting to stat a dangling symlink should reject
    await expect(stat(`${fleet.home}/.claude/skills/dangler`)).rejects.toBeDefined();
  });

  test('home/.agents/skills/dup and home/.codex/skills/dup are both real directories', async () => {
    fleet = await buildFixtureFleet();
    const agentDupStats = await lstat(`${fleet.home}/.agents/skills/dup`);
    expect(agentDupStats.isDirectory()).toBe(true);
    const codexDupStats = await lstat(`${fleet.home}/.codex/skills/dup`);
    expect(codexDupStats.isDirectory()).toBe(true);
  });

  test('home/.codex/skills/gamma is an absolute symlink to gammaSrc', async () => {
    fleet = await buildFixtureFleet();
    const linkStats = await lstat(`${fleet.home}/.codex/skills/gamma`);
    expect(linkStats.isSymbolicLink()).toBe(true);
    const target = await readlink(`${fleet.home}/.codex/skills/gamma`);
    expect(target).toBe(fleet.gammaSrc);
  });

  test('alpha/bin/run.sh has owner-exec bit set', async () => {
    fleet = await buildFixtureFleet();
    const stats = await lstat(`${fleet.alphaSrc}/bin/run.sh`);
    expect((stats.mode & 0o100) !== 0).toBe(true);
  });

  test('alpha/link.md is a relative symlink with target SKILL.md', async () => {
    fleet = await buildFixtureFleet();
    const linkStats = await lstat(`${fleet.alphaSrc}/link.md`);
    expect(linkStats.isSymbolicLink()).toBe(true);
    const target = await readlink(`${fleet.alphaSrc}/link.md`);
    expect(target).toBe('SKILL.md');
  });

  test('env.homeDir equals fleet.home', async () => {
    fleet = await buildFixtureFleet();
    expect(fleet.env.homeDir).toBe(fleet.home);
  });

  test('envVars.SKILLSMITH_HOME equals fleet.data', async () => {
    fleet = await buildFixtureFleet();
    expect(fleet.envVars.SKILLSMITH_HOME).toBe(fleet.data);
  });

  test('destroyFixtureFleet removes base directory', async () => {
    fleet = await buildFixtureFleet();
    let baseExists = false;
    try {
      await lstat(fleet.base);
      baseExists = true;
    } catch {
      baseExists = false;
    }
    expect(baseExists).toBe(true);
    await destroyFixtureFleet(fleet);
    let baseExistsAfter = false;
    try {
      await lstat(fleet.base);
      baseExistsAfter = true;
    } catch {
      baseExistsAfter = false;
    }
    expect(baseExistsAfter).toBe(false);
    fleet = null;
  });
});
