import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { antigravityPlacementBundle } from '../../../src/agents/antigravity/placement.ts';
import { resolveRuntimeConfiguration } from '../../../src/config/runtime.ts';
import { defaultRuntimePorts } from '../../../src/ports/default.ts';
import type { InventoryReadPorts } from '../../../src/ports/types.ts';

let home = '';
let env: InventoryReadPorts = undefined as never;
const ctx = () => ({ cwd: join(home, 'ws'), configuration: resolveRuntimeConfiguration({}) });
const native = () => join(home, '.gemini', 'config', 'skills');
const STORE = 'store-root-unused-here';

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'antigravity-placement-'));
  const ports = await defaultRuntimePorts();
  env = {
    ...ports,
    homeDir: home,
    xdg: {
      config: join(home, '.config'),
      data: join(home, '.local', 'share'),
      cache: join(home, '.cache'),
    },
  };
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const seed = async (skill: string, kind: 'dir' | 'link-out' | 'link-store' | 'dangling') => {
  const path = join(native(), skill);
  await mkdir(native(), { recursive: true });
  if (kind === 'dir') await mkdir(path);
  if (kind === 'link-out') {
    const target = join(home, 'src', skill);
    await mkdir(target, { recursive: true });
    await symlink(target, path);
  }
  if (kind === 'link-store') {
    const target = join(home, 'store', skill);
    await mkdir(target, { recursive: true });
    await symlink(target, path);
  }
  if (kind === 'dangling') await symlink(join(home, 'nowhere', skill), path);
};

describe('antigravityPlacementBundle roots', () => {
  test('user exposes only the native destination; other scopes expose nothing', () => {
    expect(antigravityPlacementBundle.roots(env, 'user', ctx())).toEqual([native()]);
    expect(antigravityPlacementBundle.roots(env, 'project', ctx())).toEqual([]);
    expect(antigravityPlacementBundle.roots(env, 'system', ctx())).toEqual([]);
    expect(antigravityPlacementBundle.roots(env, 'managed', ctx())).toEqual([]);
    expect(antigravityPlacementBundle.rootFacts?.(env, 'user', ctx())).toEqual([
      { path: native(), role: 'destination' },
    ]);
    expect(antigravityPlacementBundle.rootFacts?.(env, 'project', ctx())).toEqual([]);
    expect(antigravityPlacementBundle.standardRoots(env, ctx())).toEqual([native()]);
  });

  test('noticeForRoot is always null (no legacy root)', async () => {
    const inventory = await antigravityPlacementBundle.list(env, ctx(), STORE);
    expect(antigravityPlacementBundle.noticeForRoot(native(), inventory)).toBeNull();
  });
});

describe('antigravityPlacementBundle list', () => {
  test('missing root lists empty but names the destination', async () => {
    const inventory = await antigravityPlacementBundle.list(env, ctx(), STORE);
    expect(inventory).toEqual({
      placements: [],
      duplicates: [],
      currentRoot: native(),
      legacyRoot: null,
    });
  });

  test('classifies dir, store-linked, dev, and dangling placements', async () => {
    await seed('pinned-skill', 'dir');
    await seed('linked-skill', 'link-store');
    await seed('dev-skill', 'link-out');
    await seed('dangling-skill', 'dangling');
    const inventory = await antigravityPlacementBundle.list(env, ctx(), join(home, 'store'));
    const bySkill = new Map(inventory.placements.map((p) => [p.skill, p]));
    expect(bySkill.get('pinned-skill')?.class).toBe('pinned');
    expect(bySkill.get('linked-skill')?.class).toBe('store-linked');
    expect(bySkill.get('dev-skill')).toMatchObject({ class: 'dev', dangling: false });
    expect(bySkill.get('dangling-skill')).toMatchObject({ class: 'dev', dangling: true });
    expect(inventory.duplicates).toEqual([]);
    expect(inventory.legacyRoot).toBeNull();
  });

  test('excludes dot-prefixed entries and ignores ~/.agents/skills compat root', async () => {
    await mkdir(join(native(), '.hidden'), { recursive: true });
    await writeFile(join(native(), '.hidden', 'meta.json'), '{}');
    await mkdir(join(home, '.agents', 'skills', 'codex-only'), { recursive: true });
    await seed('real-skill', 'dir');
    const inventory = await antigravityPlacementBundle.list(env, ctx(), STORE);
    expect(inventory.placements.map((p) => p.skill)).toEqual(['real-skill']);
  });

  test('non-user scopes list empty', async () => {
    const inventory = await antigravityPlacementBundle.listScoped?.(env, ctx(), STORE, 'project');
    expect(inventory).toEqual({
      placements: [],
      duplicates: [],
      currentRoot: null,
      legacyRoot: null,
    });
  });
});

describe('antigravityPlacementBundle resolve', () => {
  test('present skill resolves without notices or duplicates', async () => {
    await seed('alpha', 'dir');
    const resolution = await antigravityPlacementBundle.resolve(env, ctx(), STORE, 'alpha');
    expect(resolution.placement).toMatchObject({
      skill: 'alpha',
      root: native(),
      path: join(native(), 'alpha'),
      class: 'pinned',
    });
    expect(resolution.notices).toEqual([]);
    expect(resolution.duplicateReason).toBeNull();
  });

  test('absent skill resolves to the destination path', async () => {
    const resolution = await antigravityPlacementBundle.resolve(env, ctx(), STORE, 'ghost');
    expect(resolution.placement).toMatchObject({
      skill: 'ghost',
      path: join(native(), 'ghost'),
      class: 'absent',
    });
    expect(resolution.duplicateReason).toBeNull();
  });

  test('non-user scopes throw the placement invariant', async () => {
    await expect(
      antigravityPlacementBundle.resolveScoped?.(env, ctx(), STORE, 'alpha', 'project'),
    ).rejects.toThrow('antigravity placement invariant: no project destination root');
  });
});
