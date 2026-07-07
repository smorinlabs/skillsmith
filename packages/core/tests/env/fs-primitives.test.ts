import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultScanEnv } from '../../src/env/default.ts';
import type { ScanEnv } from '../../src/env/types.ts';

describe('defaultScanEnv fs primitives', () => {
  let dir = '';
  let env: ScanEnv;

  const setup = async (): Promise<void> => {
    dir = await mkdtemp(join(tmpdir(), 'skillsmith-fs-'));
    env = await defaultScanEnv();
  };

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = '';
  });

  describe('pathKind', () => {
    test('regular file -> "file"', async () => {
      await setup();
      const p = join(dir, 'f.txt');
      await writeFile(p, 'hi');
      expect(await env.pathKind(p)).toBe('file');
    });

    test('directory -> "dir"', async () => {
      await setup();
      const p = join(dir, 'sub');
      await mkdir(p);
      expect(await env.pathKind(p)).toBe('dir');
    });

    test('symlink -> "symlink"', async () => {
      await setup();
      const target = join(dir, 'target.txt');
      await writeFile(target, 'hi');
      const link = join(dir, 'link.txt');
      await symlink(target, link);
      expect(await env.pathKind(link)).toBe('symlink');
    });

    test('missing path -> "absent"', async () => {
      await setup();
      expect(await env.pathKind(join(dir, 'nope'))).toBe('absent');
    });

    test('dangling symlink -> "symlink", never "absent"', async () => {
      await setup();
      const link = join(dir, 'dangler');
      await symlink(join(dir, 'does-not-exist'), link);
      expect(await env.pathKind(link)).toBe('symlink');
    });
  });

  describe('isExecutable', () => {
    test('owner-exec bit set -> true', async () => {
      await setup();
      const p = join(dir, 'run.sh');
      await writeFile(p, '#!/bin/sh\n');
      await chmod(p, 0o755);
      expect(await env.isExecutable(p)).toBe(true);
    });

    test('owner-exec bit unset -> false', async () => {
      await setup();
      const p = join(dir, 'plain.txt');
      await writeFile(p, 'hi');
      await chmod(p, 0o644);
      expect(await env.isExecutable(p)).toBe(false);
    });
  });

  test('readLink returns the literal relative target, not a resolution', async () => {
    await setup();
    await mkdir(join(dir, 'nested'));
    await writeFile(join(dir, 'nested', 'SKILL.md'), 'x');
    const link = join(dir, 'nested', 'link.md');
    await symlink('SKILL.md', link);
    expect(await env.readLink(link)).toBe('SKILL.md');
  });

  test('makeSymlink + readLink round-trip', async () => {
    await setup();
    const link = join(dir, 'roundtrip');
    await env.makeSymlink('some/relative/target', link);
    expect(await env.readLink(link)).toBe('some/relative/target');
  });

  test('rename moves a file', async () => {
    await setup();
    const from = join(dir, 'a.txt');
    const to = join(dir, 'b.txt');
    await writeFile(from, 'content');
    await env.rename(from, to);
    expect(await env.pathKind(from)).toBe('absent');
    expect(await env.pathKind(to)).toBe('file');
  });

  test('copyTree preserves a relative symlink verbatim and the exec bit', async () => {
    await setup();
    const src = join(dir, 'src');
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'SKILL.md'), 'x');
    await symlink('SKILL.md', join(src, 'link.md'));
    await writeFile(join(src, 'run.sh'), '#!/bin/sh\n');
    await chmod(join(src, 'run.sh'), 0o755);

    const dst = join(dir, 'dst');
    await env.copyTree(src, dst);

    expect(await env.pathKind(join(dst, 'link.md'))).toBe('symlink');
    expect(await env.readLink(join(dst, 'link.md'))).toBe('SKILL.md');
    expect(await env.isExecutable(join(dst, 'run.sh'))).toBe(true);
  });

  test('removeTree on an absent path resolves', async () => {
    await setup();
    await expect(env.removeTree(join(dir, 'nope'))).resolves.toBeUndefined();
  });

  test('makeDir is recursive', async () => {
    await setup();
    const nested = join(dir, 'a', 'b', 'c');
    await env.makeDir(nested);
    expect(await env.pathKind(nested)).toBe('dir');
  });

  test('writeTextFile / readBytes round-trip bytes', async () => {
    await setup();
    const p = join(dir, 'bytes.txt');
    await env.writeTextFile(p, 'hello é');
    const bytes = await env.readBytes(p);
    expect(new TextDecoder().decode(bytes)).toBe('hello é');
  });

  test('fsyncFile resolves on a real file', async () => {
    await setup();
    const p = join(dir, 'sync.txt');
    await writeFile(p, 'x');
    await expect(env.fsyncFile(p)).resolves.toBeUndefined();
  });

  test('fsyncDir resolves on a real directory', async () => {
    await setup();
    await expect(env.fsyncDir(dir)).resolves.toBeUndefined();
  });

  describe('withFileLock', () => {
    test('runs fn and releases; a second sequential call on the same path succeeds', async () => {
      await setup();
      const target = join(dir, 'lock-target');
      await writeFile(target, '');

      const r1 = await env.withFileLock(target, async () => 'first');
      expect(r1).toBe('first');

      const r2 = await env.withFileLock(target, async () => 'second');
      expect(r2).toBe('second');
    });

    test('two concurrent calls on the same path never interleave', async () => {
      await setup();
      const target = join(dir, 'lock-target-concurrent');
      await writeFile(target, '');

      let counter = 0;
      let maxObserved = 0;

      const worker = (): Promise<void> =>
        env.withFileLock(target, async () => {
          counter += 1;
          maxObserved = Math.max(maxObserved, counter);
          await new Promise((resolve) => setTimeout(resolve, 50));
          counter -= 1;
        });

      await Promise.all([worker(), worker()]);
      expect(maxObserved).toBe(1);
    });
  });
});
