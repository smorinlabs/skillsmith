import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { listClaudeCodePlacements } from '../../../src/agents/claude-code/placement.ts';
import { classifyPlacement } from '../../../src/agents/placement-shared.ts';
import { resolveRuntimeConfiguration } from '../../../src/config/runtime.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../../fixtures/place/fleet.ts';

describe('claude-code placement detection', () => {
  let fleet: FixtureFleet | null = null;

  afterEach(async () => {
    if (fleet) {
      await destroyFixtureFleet(fleet);
      fleet = null;
    }
  });

  const ctxOf = (f: FixtureFleet) => ({
    cwd: f.base,
    configuration: resolveRuntimeConfiguration({}),
  });
  const portsOf = (f: FixtureFleet) => f.env;
  const storeRootOf = (f: FixtureFleet) => join(f.data, 'store');
  const rootOf = (f: FixtureFleet) => join(f.home, '.claude', 'skills');

  test('alpha -> dev, symlinkTarget = alphaSrc, dangling false', async () => {
    fleet = await buildFixtureFleet();
    const placements = await listClaudeCodePlacements(
      portsOf(fleet),
      ctxOf(fleet),
      storeRootOf(fleet),
    );
    const alpha = placements.find((p) => p.skill === 'alpha');
    expect(alpha?.class).toBe('dev');
    expect(alpha?.symlinkTarget).toBe(fleet.alphaSrc);
    expect(alpha?.dangling).toBe(false);
  });

  test('copied -> pinned, symlinkTarget null', async () => {
    fleet = await buildFixtureFleet();
    const placements = await listClaudeCodePlacements(
      portsOf(fleet),
      ctxOf(fleet),
      storeRootOf(fleet),
    );
    const copied = placements.find((p) => p.skill === 'copied');
    expect(copied?.class).toBe('pinned');
    expect(copied?.symlinkTarget).toBeNull();
  });

  test('dangler -> dev, dangling true', async () => {
    fleet = await buildFixtureFleet();
    const placements = await listClaudeCodePlacements(
      portsOf(fleet),
      ctxOf(fleet),
      storeRootOf(fleet),
    );
    const dangler = placements.find((p) => p.skill === 'dangler');
    expect(dangler?.class).toBe('dev');
    expect(dangler?.dangling).toBe(true);
  });

  test('a name with no entry -> absent', async () => {
    fleet = await buildFixtureFleet();
    const placement = await classifyPlacement(
      portsOf(fleet),
      rootOf(fleet),
      'nonexistent',
      storeRootOf(fleet),
    );
    expect(placement.class).toBe('absent');
  });

  test('listClaudeCodePlacements returns exactly {alpha, copied, dangler} — no .system', async () => {
    fleet = await buildFixtureFleet();
    const placements = await listClaudeCodePlacements(
      portsOf(fleet),
      ctxOf(fleet),
      storeRootOf(fleet),
    );
    expect(placements.map((p) => p.skill).sort()).toEqual(['alpha', 'copied', 'dangler']);
  });

  test('store-linked: symlink resolving inside storeRoot classifies as store-linked', async () => {
    fleet = await buildFixtureFleet();
    const storeRoot = storeRootOf(fleet);
    const realDir = join(storeRoot, 'local', 'x@content-abcdef123456', 'x');
    await mkdir(realDir, { recursive: true });
    const linkPath = join(rootOf(fleet), 'slink');
    await symlink(realDir, linkPath);

    const placement = await classifyPlacement(portsOf(fleet), rootOf(fleet), 'slink', storeRoot);
    expect(placement.class).toBe('store-linked');
  });

  test('dot-staging/backup dirs are invisible to listClaudeCodePlacements', async () => {
    fleet = await buildFixtureFleet();
    const root = rootOf(fleet);
    await mkdir(join(root, '.skillsmith-staging-alpha-deadbeef'), { recursive: true });
    await mkdir(join(root, '.skillsmith-backup-alpha-deadbeef'), { recursive: true });

    const placements = await listClaudeCodePlacements(
      portsOf(fleet),
      ctxOf(fleet),
      storeRootOf(fleet),
    );
    expect(placements.map((p) => p.skill).sort()).toEqual(['alpha', 'copied', 'dangler']);
  });
});
