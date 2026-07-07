import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultScanEnv } from '../../src/env/default.ts';
import type { ScanEnv } from '../../src/env/types.ts';
import type { SkillSmithError } from '../../src/errors.ts';
import { contentHashOf } from '../../src/place/store.ts';

const msg = (e: SkillSmithError): string => ('message' in e ? e.message : e.code);

const expectHash = async (env: ScanEnv, dir: string): Promise<string> => {
  const r = await contentHashOf(env, dir);
  if (!r.ok) throw new Error(`contentHashOf failed: ${msg(r.error)}`);
  return r.value;
};

describe('contentHashOf', () => {
  let env: ScanEnv;
  let base: string;

  beforeEach(async () => {
    env = await defaultScanEnv();
    base = await mkdtemp(join(tmpdir(), 'skillsmith-hash-'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test('(a) is stable across two computations', async () => {
    const d = join(base, 'skill');
    await mkdir(d, { recursive: true });
    await writeFile(join(d, 'SKILL.md'), 'hello\n');
    const h1 = await expectHash(env, d);
    const h2 = await expectHash(env, d);
    expect(h1).toBe(h2);
  });

  test('(b) is independent of directory-entry creation order', async () => {
    const d1 = join(base, 's1');
    await mkdir(join(d1, 'sub'), { recursive: true });
    await writeFile(join(d1, 'a.md'), 'A');
    await writeFile(join(d1, 'b.md'), 'B');
    await writeFile(join(d1, 'sub', 'c.md'), 'C');

    const d2 = join(base, 's2');
    await mkdir(join(d2, 'sub'), { recursive: true });
    // reversed creation order
    await writeFile(join(d2, 'sub', 'c.md'), 'C');
    await writeFile(join(d2, 'b.md'), 'B');
    await writeFile(join(d2, 'a.md'), 'A');

    expect(await expectHash(env, d1)).toBe(await expectHash(env, d2));
  });

  test('(c) flipping a file exec bit changes the hash', async () => {
    const d = join(base, 'skill');
    await mkdir(join(d, 'bin'), { recursive: true });
    await writeFile(join(d, 'bin', 'run.sh'), '#!/bin/sh\n');
    const before = await expectHash(env, d);
    await chmod(join(d, 'bin', 'run.sh'), 0o755);
    const after = await expectHash(env, d);
    expect(after).not.toBe(before);
  });

  test('(d) changing a symlink target changes the hash', async () => {
    const d = join(base, 'skill');
    await mkdir(d, { recursive: true });
    await writeFile(join(d, 'SKILL.md'), 'x');
    await writeFile(join(d, 'other.md'), 'y');
    await symlink('SKILL.md', join(d, 'link.md'));
    const before = await expectHash(env, d);
    await rm(join(d, 'link.md'));
    await symlink('other.md', join(d, 'link.md'));
    const after = await expectHash(env, d);
    expect(after).not.toBe(before);
  });

  test('(e) a symlink is recorded as an L record and NOT followed', async () => {
    // link points outside the hashed dir; changing the target's *content* (not its
    // path string) must leave the hash unchanged.
    const outside = join(base, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'file'), 'v1');

    const d = join(base, 'skill');
    await mkdir(d, { recursive: true });
    await symlink('../outside/file', join(d, 'link'));

    const before = await expectHash(env, d);
    await writeFile(join(outside, 'file'), 'v2-different-content');
    const after = await expectHash(env, d);
    expect(after).toBe(before);
  });

  test('(f) a byte change in any file changes the hash', async () => {
    const d = join(base, 'skill');
    await mkdir(d, { recursive: true });
    await writeFile(join(d, 'SKILL.md'), 'content-1');
    const before = await expectHash(env, d);
    await writeFile(join(d, 'SKILL.md'), 'content-2');
    const after = await expectHash(env, d);
    expect(after).not.toBe(before);
  });

  test('(g) format matches sha256:<64hex>', async () => {
    const d = join(base, 'skill');
    await mkdir(d, { recursive: true });
    await writeFile(join(d, 'SKILL.md'), 'z');
    const h = await expectHash(env, d);
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
