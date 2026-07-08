import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readlink, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fetchRepo,
  lsTreeSkills,
  resolveRefViaLsRemote,
  sparseCheckoutSkill,
  sweepFetchOrphans,
} from '../../src/acquire/fetch.ts';
import { defaultScanEnv } from '../../src/env/default.ts';
import type { ScanEnv } from '../../src/env/types.ts';
import {
  type RemoteFixture,
  buildRemoteFixture,
  destroyRemoteFixture,
} from '../fixtures/acquire/remote.ts';

let fixture: RemoteFixture;
let env: ScanEnv;
let scratch: string; // parent for per-test fetch dirs (git init creates each leaf)
let counter = 0;

const freshFetchDir = (): string => join(scratch, `ft-${counter++}`);

beforeAll(async () => {
  fixture = await buildRemoteFixture();
  env = await defaultScanEnv();
  scratch = await mkdtemp(join(tmpdir(), 'skillsmith-fetch-'));
});

afterAll(async () => {
  await destroyRemoteFixture(fixture);
  await rm(scratch, { recursive: true, force: true });
});

describe('fetchRepo', () => {
  test('HEAD fetch resolves multiHead and stays blobless (no checkout)', async () => {
    const fetchDir = freshFetchDir();
    const res = await fetchRepo(env, { cloneUrl: fixture.multiUrl, ref: null, fetchDir });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.sha).toBe(fixture.multiHead);
    // fetch never checks out — the skill file is absent, proving the clone is blobless.
    expect(existsSync(join(fetchDir, 'plugins/fh/skills/factor-scan/SKILL.md'))).toBe(false);
  });

  test('tag ref v1.0.0 resolves multiTagSha; a full-SHA ref fetches the same commit', async () => {
    const tagDir = freshFetchDir();
    const tagRes = await fetchRepo(env, {
      cloneUrl: fixture.multiUrl,
      ref: 'v1.0.0',
      fetchDir: tagDir,
    });
    expect(tagRes.ok).toBe(true);
    if (!tagRes.ok) return;
    expect(tagRes.value.sha).toBe(fixture.multiTagSha);

    const shaDir = freshFetchDir();
    const shaRes = await fetchRepo(env, {
      cloneUrl: fixture.multiUrl,
      ref: fixture.multiTagSha,
      fetchDir: shaDir,
    });
    expect(shaRes.ok).toBe(true);
    if (!shaRes.ok) return;
    expect(shaRes.value.sha).toBe(fixture.multiTagSha);
  });

  test('a bad ref maps to source-unresolvable with a git stderr fragment; nothing outside fetchDir', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'skillsmith-badref-'));
    const fetchDir = join(parent, 'ft');
    const res = await fetchRepo(env, { cloneUrl: fixture.multiUrl, ref: 'v9.9.9', fetchDir });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const e = res.error;
    expect(e.code).toBe('source-unresolvable');
    if (e.code !== 'source-unresolvable') return;
    expect(e.message).toContain('v9.9.9'); // git echoes the missing ref
    // git init created only the fetch dir; no store/ledger siblings appeared.
    expect(await readdir(parent)).toEqual(['ft']);
    await rm(parent, { recursive: true, force: true });
  });

  test('an unreachable URL fails source-unresolvable and identically on repeat (offline-deterministic)', async () => {
    const rand = Math.random().toString(36).slice(2);
    const badUrl = `file:///nonexistent/${rand}.git`;
    const r1 = await fetchRepo(env, { cloneUrl: badUrl, ref: null, fetchDir: freshFetchDir() });
    const r2 = await fetchRepo(env, { cloneUrl: badUrl, ref: null, fetchDir: freshFetchDir() });
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    if (r1.ok || r2.ok) return;
    const e1 = r1.error;
    const e2 = r2.error;
    expect(e1.code).toBe('source-unresolvable');
    expect(e2.code).toBe('source-unresolvable');
    if (e1.code !== 'source-unresolvable' || e2.code !== 'source-unresolvable') return;
    expect(e1.message).toBe(e2.message);
    expect(e1.message).toContain(rand); // the cloneUrl (with rand) is in the message prefix
  });
});

describe('lsTreeSkills', () => {
  test('the multi repo lists three skill dirs, excluding docs and the dot-prefixed subtree', async () => {
    const fetchDir = freshFetchDir();
    const fr = await fetchRepo(env, { cloneUrl: fixture.multiUrl, ref: null, fetchDir });
    expect(fr.ok).toBe(true);
    const res = await lsTreeSkills(env, fetchDir);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.candidates.map((c) => c.path).sort()).toEqual([
      'plugins/api/skills/review',
      'plugins/fh/skills/factor-scan',
      'plugins/web/skills/review',
    ]);
    expect(res.value.scanned).toBe(3);
    const nameOf = new Map(res.value.candidates.map((c) => [c.path, c.name]));
    expect(nameOf.get('plugins/api/skills/review')).toBe('review');
    expect(nameOf.get('plugins/fh/skills/factor-scan')).toBe('factor-scan');
  });

  test('the root repo lists a single candidate with an empty path', async () => {
    const fetchDir = freshFetchDir();
    await fetchRepo(env, { cloneUrl: fixture.rootUrl, ref: null, fetchDir });
    const res = await lsTreeSkills(env, fetchDir);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.candidates).toEqual([{ path: '', name: '' }]);
    expect(res.value.scanned).toBe(1);
  });
});

describe('sparseCheckoutSkill', () => {
  test('sparse checkout materializes exactly the chosen subtree', async () => {
    const fetchDir = freshFetchDir();
    await fetchRepo(env, { cloneUrl: fixture.multiUrl, ref: null, fetchDir });
    const res = await sparseCheckoutSkill(env, fetchDir, 'plugins/fh/skills/factor-scan');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const dir = res.value;
    expect(dir).toBe(join(fetchDir, 'plugins/fh/skills/factor-scan'));
    expect(existsSync(join(dir, 'SKILL.md'))).toBe(true);
    // exec bit preserved
    const runStat = await lstat(join(dir, 'bin', 'run.sh'));
    expect((runStat.mode & 0o100) !== 0).toBe(true);
    // symlink preserved with its literal target
    const linkStat = await lstat(join(dir, 'link.md'));
    expect(linkStat.isSymbolicLink()).toBe(true);
    expect(await readlink(join(dir, 'link.md'))).toBe('SKILL.md');
    // the sibling skill outside the cone is NOT materialized
    expect(existsSync(join(fetchDir, 'plugins/api/skills/review/SKILL.md'))).toBe(false);
  });

  test('a root skill checkout returns the fetch dir containing SKILL.md', async () => {
    const fetchDir = freshFetchDir();
    await fetchRepo(env, { cloneUrl: fixture.rootUrl, ref: null, fetchDir });
    const res = await sparseCheckoutSkill(env, fetchDir, '');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toBe(fetchDir);
    expect(existsSync(join(fetchDir, 'SKILL.md'))).toBe(true);
  });
});

describe('resolveRefViaLsRemote', () => {
  test('a full 40-hex ref is returned verbatim with zero exec calls', async () => {
    let execCount = 0;
    const countingEnv: ScanEnv = {
      ...env,
      exec: async (cmd, args, opts) => {
        execCount++;
        return env.exec(cmd, args, opts);
      },
    };
    const res = await resolveRefViaLsRemote(countingEnv, fixture.multiUrl, fixture.multiHead);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toBe(fixture.multiHead);
    expect(execCount).toBe(0);
  });

  test('a tag resolves to its commit SHA', async () => {
    const res = await resolveRefViaLsRemote(env, fixture.multiUrl, 'v1.0.0');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toBe(fixture.multiTagSha);
  });

  test('a null ref resolves HEAD to multiHead', async () => {
    const res = await resolveRefViaLsRemote(env, fixture.multiUrl, null);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toBe(fixture.multiHead);
  });

  test('an unknown ref resolves to ok(null)', async () => {
    const res = await resolveRefViaLsRemote(env, fixture.multiUrl, 'v9.9.9');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toBe(null);
  });

  test('an unreachable URL resolves to ok(null)', async () => {
    const badUrl = `file:///nonexistent/${Math.random().toString(36).slice(2)}.git`;
    const res = await resolveRefViaLsRemote(env, badUrl, null);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toBe(null);
  });
});

describe('sweepFetchOrphans', () => {
  test('removes .fetch entries older than 60 minutes and keeps fresh ones', async () => {
    const data = await mkdtemp(join(tmpdir(), 'skillsmith-sweep-'));
    const oldDir = join(data, '.fetch', 'old');
    const freshDir = join(data, '.fetch', 'fresh');
    await mkdir(oldDir, { recursive: true });
    await mkdir(freshDir, { recursive: true });
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(oldDir, twoHoursAgo, twoHoursAgo);

    await sweepFetchOrphans(env, data);

    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(freshDir)).toBe(true);
    await rm(data, { recursive: true, force: true });
  });

  test('an absent .fetch directory is a silent no-op', async () => {
    const data = await mkdtemp(join(tmpdir(), 'skillsmith-sweep-empty-'));
    await sweepFetchOrphans(env, data);
    expect(existsSync(join(data, '.fetch'))).toBe(false);
    await rm(data, { recursive: true, force: true });
  });
});
