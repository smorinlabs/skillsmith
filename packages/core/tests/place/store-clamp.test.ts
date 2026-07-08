import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { SkillSmithError } from '../../src/errors.ts';
import { storeRootOf } from '../../src/place/paths.ts';
import { clampStoreNs, resolveProvenance, snapshotToStore } from '../../src/place/store.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../fixtures/place/fleet.ts';

const msg = (e: SkillSmithError): string => ('message' in e ? e.message : e.code);

describe('clampStoreNs', () => {
  test('owner/repo → identity', () => {
    expect(clampStoreNs('owner/repo')).toEqual({ ns: 'owner', name: 'repo' });
  });

  test('acme/platform/tools → subgroup name joined with -', () => {
    expect(clampStoreNs('acme/platform/tools')).toEqual({ ns: 'acme', name: 'platform-tools' });
  });

  test('a/b/c/d → deep subgroup name joined with -', () => {
    expect(clampStoreNs('a/b/c/d')).toEqual({ ns: 'a', name: 'b-c-d' });
  });

  test('owner/repo.git → trailing .git stripped before sanitizing', () => {
    expect(clampStoreNs('owner/repo.git')).toEqual({ ns: 'owner', name: 'repo' });
  });

  test('illegal characters replaced with -', () => {
    expect(clampStoreNs('ac me/to ols')).toEqual({ ns: 'ac-me', name: 'to-ols' });
  });

  test('dots preserved in sanitize', () => {
    expect(clampStoreNs('acme.io/kit')).toEqual({ ns: 'acme.io', name: 'kit' });
  });

  test('defensive single-segment input clamps to { ns: seg, name: seg }', () => {
    expect(clampStoreNs('solo')).toEqual({ ns: 'solo', name: 'solo' });
  });
});

describe('parseRemote / resolveProvenance subgroup regression (PR #5 follow-up #4)', () => {
  let f: FixtureFleet;
  let storeRoot: string;
  beforeEach(async () => {
    f = await buildFixtureFleet();
    storeRoot = storeRootOf(f.data);
  });
  afterEach(async () => {
    await destroyFixtureFleet(f);
  });

  const setOrigin = async (url: string): Promise<void> => {
    const r = await f.env.exec('git', ['-C', f.checkout, 'remote', 'set-url', 'origin', url]);
    if (r.code !== 0) throw new Error(`git remote set-url failed: ${r.stderr}`);
  };

  test('ssh subgroup origin → ns/name clamped, remote stays unclamped', async () => {
    await setOrigin('git@gitlab.com:acme/platform/tools.git');
    const p = await resolveProvenance(f.env, f.alphaSrc);
    if (!p.ok) throw new Error(`resolveProvenance failed: ${msg(p.error)}`);
    expect(p.value.ns).toBe('acme');
    expect(p.value.name).toBe('platform-tools');
    expect(p.value.remote).toBe('acme/platform/tools');
  });

  test('ssh subgroup origin → snapshotToStore path has exactly 2 segments before @<sha12>', async () => {
    await setOrigin('git@gitlab.com:acme/platform/tools.git');
    const p = await resolveProvenance(f.env, f.alphaSrc);
    if (!p.ok) throw new Error(`resolveProvenance failed: ${msg(p.error)}`);
    const r = await snapshotToStore(f.env, {
      sourceDir: f.alphaSrc,
      skill: 'alpha',
      storeRoot,
      provenance: p.value,
      txId: 'aabbcc99',
    });
    if (!r.ok) throw new Error(`snapshot failed: ${msg(r.error)}`);
    const sha12 = f.headSha.slice(0, 12);
    expect(r.value.storePath).toBe(join(storeRoot, 'acme', `platform-tools@${sha12}`, 'alpha'));
  });

  test('https subgroup origin → identical clamp to the ssh variant', async () => {
    await setOrigin('https://gitlab.com/acme/platform/tools.git');
    const p = await resolveProvenance(f.env, f.alphaSrc);
    if (!p.ok) throw new Error(`resolveProvenance failed: ${msg(p.error)}`);
    expect(p.value.ns).toBe('acme');
    expect(p.value.name).toBe('platform-tools');
    expect(p.value.remote).toBe('acme/platform/tools');
  });

  test('cross-check: clampStoreNs(remote) equals the ns/name resolveProvenance produced', async () => {
    await setOrigin('git@gitlab.com:acme/platform/tools.git');
    const p = await resolveProvenance(f.env, f.alphaSrc);
    if (!p.ok) throw new Error(`resolveProvenance failed: ${msg(p.error)}`);
    if (p.value.remote === null) throw new Error('expected a non-null remote');
    const clamped = clampStoreNs(p.value.remote);
    expect(clamped.ns).toBe(p.value.ns);
    expect(clamped.name).toBe(p.value.name);
  });
});
