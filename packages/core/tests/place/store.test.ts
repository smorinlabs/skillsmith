import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SkillSmithError } from '../../src/errors.ts';
import { storeRootOf } from '../../src/place/paths.ts';
import {
  contentHashOf,
  resolveProvenance,
  snapshotToStore,
  sweepStaging,
} from '../../src/place/store.ts';
import type { Provenance } from '../../src/place/types.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../fixtures/place/fleet.ts';

const msg = (e: SkillSmithError): string => ('message' in e ? e.message : e.code);

const okProvenance = async (f: FixtureFleet, dir: string): Promise<Provenance> => {
  const r = await resolveProvenance(f.env, dir);
  if (!r.ok) throw new Error(`resolveProvenance failed: ${msg(r.error)}`);
  return r.value;
};

describe('resolveProvenance', () => {
  let f: FixtureFleet;
  beforeEach(async () => {
    f = await buildFixtureFleet();
  });
  afterEach(async () => {
    await destroyFixtureFleet(f);
  });

  test('clean git tree → git-clean with parsed remote and relpath', async () => {
    const p = await okProvenance(f, f.alphaSrc);
    expect(p.kind).toBe('git-clean');
    expect(p.remote).toBe('smorinlabs/fixture-harness');
    expect(p.ns).toBe('smorinlabs');
    expect(p.name).toBe('fixture-harness');
    expect(p.gitSha).toBe(f.headSha);
    expect(p.sourceRelPath).toBe('plugins/fh/skills/alpha');
    expect(p.dirtySummary).toBeNull();
  });

  test('dirty git tree → git-dirty with dirtySummary mentioning SKILL.md', async () => {
    await f.makeCheckoutDirty();
    const p = await okProvenance(f, f.alphaSrc);
    expect(p.kind).toBe('git-dirty');
    expect(p.gitSha).toBe(f.headSha);
    expect(p.dirtySummary).toContain('SKILL.md');
  });

  test('non-git source → non-git with local ns', async () => {
    const p = await okProvenance(f, f.gammaSrc);
    expect(p.kind).toBe('non-git');
    expect(p.ns).toBe('local');
    expect(p.name).toBe('gamma');
    expect(p.gitSha).toBeNull();
    expect(p.repoRoot).toBeNull();
    expect(p.remote).toBeNull();
    expect(p.sourceRelPath).toBeNull();
  });

  test('git tree without origin remote → local ns, repo basename name', async () => {
    const copyRoot = join(f.base, 'noremote');
    await f.env.copyTree(f.checkout, copyRoot);
    const rm = await f.env.exec('git', ['-C', copyRoot, 'remote', 'remove', 'origin']);
    expect(rm.code).toBe(0);
    const skillDir = join(copyRoot, 'plugins', 'fh', 'skills', 'alpha');
    const p = await okProvenance(f, skillDir);
    expect(p.kind).toBe('git-clean');
    expect(p.remote).toBeNull();
    expect(p.ns).toBe('local');
    expect(p.name).toBe('noremote');
  });
});

describe('snapshotToStore', () => {
  let f: FixtureFleet;
  let storeRoot: string;
  beforeEach(async () => {
    f = await buildFixtureFleet();
    storeRoot = storeRootOf(f.data);
  });
  afterEach(async () => {
    await destroyFixtureFleet(f);
  });

  test('clean → store/<owner>/<repo>@<sha12>/<skill>, faithful copy', async () => {
    const prov = await okProvenance(f, f.alphaSrc);
    const r = await snapshotToStore(f.env, {
      sourceDir: f.alphaSrc,
      skill: 'alpha',
      storeRoot,
      provenance: prov,
      txId: 'aabbccdd',
    });
    if (!r.ok) throw new Error(`snapshot failed: ${msg(r.error)}`);
    const sha12 = f.headSha.slice(0, 12);
    expect(r.value.reused).toBe(false);
    expect(r.value.rev).toBe(sha12);
    expect(r.value.storePath).toBe(
      join(storeRoot, 'smorinlabs', `fixture-harness@${sha12}`, 'alpha'),
    );
    expect(await f.env.pathKind(r.value.storePath)).toBe('dir');
    // no staging residue (txId dir swept; .staging left empty)
    expect((await f.env.listDir(join(storeRoot, '.staging'))).length).toBe(0);
    // staged content hash equals source hash
    const srcHash = await contentHashOf(f.env, f.alphaSrc);
    const storeHash = await contentHashOf(f.env, r.value.storePath);
    if (!srcHash.ok || !storeHash.ok) throw new Error('hash failed');
    expect(storeHash.value).toBe(srcHash.value);
    expect(r.value.contentHash).toBe(srcHash.value);
    // exec bit preserved
    expect(await f.env.isExecutable(join(r.value.storePath, 'bin', 'run.sh'))).toBe(true);
    // relative symlink preserved
    expect(await f.env.pathKind(join(r.value.storePath, 'link.md'))).toBe('symlink');
    expect(await f.env.readLink(join(r.value.storePath, 'link.md'))).toBe('SKILL.md');
  });

  test('dirty → @dirty-<hash12>', async () => {
    await f.makeCheckoutDirty();
    const prov = await okProvenance(f, f.alphaSrc);
    const r = await snapshotToStore(f.env, {
      sourceDir: f.alphaSrc,
      skill: 'alpha',
      storeRoot,
      provenance: prov,
      txId: 'aabbccde',
    });
    if (!r.ok) throw new Error(`snapshot failed: ${msg(r.error)}`);
    expect(r.value.rev).toMatch(/^dirty-[0-9a-f]{12}$/);
    expect(r.value.storePath).toMatch(
      /\/store\/smorinlabs\/fixture-harness@dirty-[0-9a-f]{12}\/alpha$/,
    );
  });

  test('non-git → store/local/<name>@content-<hash12>/<skill>', async () => {
    const prov = await okProvenance(f, f.gammaSrc);
    const r = await snapshotToStore(f.env, {
      sourceDir: f.gammaSrc,
      skill: 'gamma',
      storeRoot,
      provenance: prov,
      txId: 'aabbccdf',
    });
    if (!r.ok) throw new Error(`snapshot failed: ${msg(r.error)}`);
    expect(r.value.rev).toMatch(/^content-[0-9a-f]{12}$/);
    expect(r.value.storePath).toMatch(/\/store\/local\/gamma@content-[0-9a-f]{12}\/gamma$/);
  });

  test('idempotent: second call with unchanged source → reused, no staging residue', async () => {
    const prov = await okProvenance(f, f.alphaSrc);
    const opts = {
      sourceDir: f.alphaSrc,
      skill: 'alpha',
      storeRoot,
      provenance: prov,
      txId: 'aabbcc11',
    };
    const first = await snapshotToStore(f.env, opts);
    if (!first.ok) throw new Error(msg(first.error));
    const second = await snapshotToStore(f.env, { ...opts, txId: 'aabbcc22' });
    if (!second.ok) throw new Error(msg(second.error));
    expect(second.value.reused).toBe(true);
    expect(second.value.storePath).toBe(first.value.storePath);
    expect((await f.env.listDir(join(storeRoot, '.staging'))).length).toBe(0);
  });

  test('integrity: tampered store entry → flip-failed error mentioning integrity', async () => {
    const prov = await okProvenance(f, f.alphaSrc);
    const opts = {
      sourceDir: f.alphaSrc,
      skill: 'alpha',
      storeRoot,
      provenance: prov,
      txId: 'aabbcc33',
    };
    const first = await snapshotToStore(f.env, opts);
    if (!first.ok) throw new Error(msg(first.error));
    // tamper with a file inside the (immutable) store entry
    await appendFile(join(first.value.storePath, 'SKILL.md'), '\ntampered\n');
    const again = await snapshotToStore(f.env, { ...opts, txId: 'aabbcc44' });
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.error.code).toBe('flip-failed');
      expect(msg(again.error)).toContain('integrity');
    }
  });
});

describe('sweepStaging', () => {
  let f: FixtureFleet;
  beforeEach(async () => {
    f = await buildFixtureFleet();
  });
  afterEach(async () => {
    await destroyFixtureFleet(f);
  });

  test('removes a planted orphan staging txId dir', async () => {
    const storeRoot = storeRootOf(f.data);
    const orphan = join(storeRoot, '.staging', 'deadbeef');
    await mkdir(orphan, { recursive: true });
    expect(await f.env.pathKind(orphan)).toBe('dir');
    await sweepStaging(f.env, storeRoot);
    expect(await f.env.pathKind(orphan)).toBe('absent');
  });
});
