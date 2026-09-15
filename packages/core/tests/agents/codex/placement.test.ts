import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexPlacementBundle, listCodexPlacements } from '../../../src/agents/codex/placement.ts';
import { resolveRuntimeConfiguration } from '../../../src/config/runtime.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../../fixtures/place/fleet.ts';

describe('codex placement detection', () => {
  let fleet: FixtureFleet | null = null;

  afterEach(async () => {
    if (fleet) {
      await destroyFixtureFleet(fleet);
      fleet = null;
    }
  });

  const storeRootOf = (f: FixtureFleet) => join(f.data, 'store');

  test('ordinary files and links to files are not managed legacy directories', async () => {
    fleet = await buildFixtureFleet();
    const scan = await listCodexPlacements(fleet.env, ctxOf(fleet), storeRootOf(fleet));
    await writeFile(join(scan.legacyRoot, 'README'), 'ordinary user file');
    await symlink(join(scan.legacyRoot, 'README'), join(scan.legacyRoot, 'readme-link'));
    for (const entry of ['README', 'readme-link']) {
      expect(
        await codexPlacementBundle.isManagedLegacyEntry?.(fleet.env, scan.legacyRoot, entry),
      ).toBe(false);
    }
  });
  const portsOf = (f: FixtureFleet) => f.env;
  const ctxOf = (
    f: FixtureFleet,
    environment: Readonly<Record<string, string | undefined>> = {},
  ) => ({ cwd: f.base, configuration: resolveRuntimeConfiguration(environment) });

  test('placements include beta (current, dev), legacy-only (legacy, dev), gamma (legacy, dev, target gammaSrc)', async () => {
    fleet = await buildFixtureFleet();
    const scan = await listCodexPlacements(portsOf(fleet), ctxOf(fleet), storeRootOf(fleet));

    const beta = scan.placements.find((p) => p.skill === 'beta' && p.root === scan.currentRoot);
    expect(beta?.class).toBe('dev');

    const legacyOnly = scan.placements.find(
      (p) => p.skill === 'legacy-only' && p.root === scan.legacyRoot,
    );
    expect(legacyOnly?.class).toBe('dev');

    const gamma = scan.placements.find((p) => p.skill === 'gamma' && p.root === scan.legacyRoot);
    expect(gamma?.class).toBe('dev');
    expect(gamma?.symlinkTarget).toBe(fleet.gammaSrc);
  });

  test('duplicates === ["dup"]', async () => {
    fleet = await buildFixtureFleet();
    const scan = await listCodexPlacements(portsOf(fleet), ctxOf(fleet), storeRootOf(fleet));
    expect(scan.duplicates).toEqual(['dup']);
  });

  test('currentRoot ends with .agents/skills; legacyRoot ends with .codex/skills', async () => {
    fleet = await buildFixtureFleet();
    const scan = await listCodexPlacements(portsOf(fleet), ctxOf(fleet), storeRootOf(fleet));
    expect(scan.currentRoot.endsWith(join('.agents', 'skills'))).toBe(true);
    expect(scan.legacyRoot.endsWith(join('.codex', 'skills'))).toBe(true);
  });

  test('runtime configuration CODEX_HOME relocates legacyRoot', async () => {
    fleet = await buildFixtureFleet();
    const codexHome = await mkdtemp(join(tmpdir(), 'skillsmith-codex-home-'));
    try {
      const scan = await listCodexPlacements(
        portsOf(fleet),
        ctxOf(fleet, { CODEX_HOME: codexHome }),
        storeRootOf(fleet),
      );
      expect(scan.legacyRoot).toBe(join(codexHome, 'skills'));
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });
});
