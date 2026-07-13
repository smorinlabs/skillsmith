import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listCodexPlacements } from '../../../src/agents/codex/placement.ts';
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
