import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecOptions } from '../../src/env/types.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';
import { type BinaryProcessPort, createGitPort } from '../../src/ports/git.ts';
import { runGit } from '../fixtures/git-env.ts';

const SHA = 'a'.repeat(40);
const OID = 'b'.repeat(40);
const PATH = 'skills/review/SKILL.md';
const request = { repositoryRoot: '/fixture', ref: SHA, path: PATH, maxBytes: 3 };
const row = (size = 3, path = PATH, mode = '100644') => `${mode} blob ${OID} ${size}\t${path}\0`;
const fixture = (
  output = row(),
  bytes = new Uint8Array([1, 2, 3]),
  afterProbe?: () => void,
  afterRead?: () => void,
) => {
  const calls: { args: readonly string[]; options: ExecOptions | undefined }[] = [];
  let binaryCalls = 0;
  const binary: BinaryProcessPort = {
    exec: async (_command, args, options) => {
      binaryCalls++;
      calls.push({ args, options });
      afterRead?.();
      return { code: 0, stdout: bytes, stderr: '', timedOut: false };
    },
  };
  const git = createGitPort(
    {
      runVersion: async () => 'fixture',
      exec: async (_command, args, options) => {
        calls.push({ args, options });
        afterProbe?.();
        return { code: 0, stdout: output, stderr: '', timedOut: false };
      },
    },
    binary,
  );
  return { git, calls, binaryCalls: () => binaryCalls };
};

describe('bounded immutable Git blob reads', () => {
  test('probes the exact literal path and reads that object ID with replacement objects disabled', async () => {
    const f = fixture();
    expect(await f.git.readBlobBounded?.(request)).toEqual(new Uint8Array([1, 2, 3]));
    expect(f.calls.map((c) => c.args)).toEqual([
      [
        '--no-replace-objects',
        '--literal-pathspecs',
        '-C',
        '/fixture',
        'ls-tree',
        '-l',
        '-z',
        '--full-tree',
        SHA,
        '--',
        PATH,
      ],
      ['--no-replace-objects', '-C', '/fixture', 'cat-file', 'blob', '--', OID],
    ]);
    for (const call of f.calls)
      for (const key of [
        'GIT_LITERAL_PATHSPECS',
        'GIT_GLOB_PATHSPECS',
        'GIT_NOGLOB_PATHSPECS',
        'GIT_ICASE_PATHSPECS',
      ])
        expect(call.options?.env?.[key]).toBeUndefined();
  });
  test.each([
    '',
    row(4),
    row(3, 'other/SKILL.md'),
    row() + row(),
    row().slice(0, -1),
    row(3, PATH, '120000'),
    `160000 commit ${OID} -\t${PATH}\0`,
    `040000 tree ${OID} -\t${PATH}\0`,
    row().replace(OID, 'bad'),
    row().replace(' 3\t', ' 9007199254740992\t'),
  ])('rejects invalid or over-budget metadata before any payload read', async (output) => {
    const f = fixture(output);
    await expect(f.git.readBlobBounded?.(request)).rejects.toMatchObject({ code: 'invalid' });
    expect(f.binaryCalls()).toBe(0);
  });
  test.each([
    { ref: 'FETCH_HEAD' },
    { ref: SHA.toUpperCase() },
    { maxBytes: -1 },
    { maxBytes: 1.5 },
    { path: '../SKILL.md' },
    { path: '/SKILL.md' },
    { path: 'a\u0000b' },
  ])('invalid requests perform no process work', async (change) => {
    const f = fixture();
    await expect(f.git.readBlobBounded?.({ ...request, ...change })).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(f.calls).toEqual([]);
  });
  test('empty and executable files are accepted; mismatched lengths are not', async () => {
    expect(
      await fixture(row(0), new Uint8Array()).git.readBlobBounded?.({ ...request, maxBytes: 0 }),
    ).toEqual(new Uint8Array());
    expect(await fixture(row(3, PATH, '100755')).git.readBlobBounded?.(request)).toHaveLength(3);
    for (const bytes of [new Uint8Array(2), new Uint8Array(4)])
      await expect(fixture(row(), bytes).git.readBlobBounded?.(request)).rejects.toMatchObject({
        code: 'invalid',
      });
  });
  test.each(['before', 'between', 'after'])('preserves cancellation %s I/O', async (phase) => {
    const controller = new AbortController();
    if (phase === 'before') controller.abort();
    const f = fixture(
      row(),
      new Uint8Array([1, 2, 3]),
      phase === 'between' ? () => controller.abort() : undefined,
      phase === 'after' ? () => controller.abort() : undefined,
    );
    await expect(
      f.git.readBlobBounded?.({ ...request, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(f.binaryCalls()).toBe(phase === 'after' ? 1 : 0);
    if (phase === 'before') expect(f.calls).toEqual([]);
  });
  test.each([
    `100644 blob ${OID}\ta/SKILL.md`,
    `100644 blob ${OID}\ta/SKILL.md\0garbage\0`,
    '100644 blob bad\ta/SKILL.md\0',
    `100644 blob ${OID}\ta/SKILL.md\0`.repeat(2),
  ])('a malformed or partial tree never becomes a candidate inventory', async (output) => {
    await expect(
      fixture(output).git.listTree({ repositoryRoot: '/fixture', ref: SHA }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
  test('real Git reads literal paths and original blobs despite replacement refs and inherited pathspec settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-bounded-git-'));
    const inheritedKeys = [
      'GIT_LITERAL_PATHSPECS',
      'GIT_GLOB_PATHSPECS',
      'GIT_NOGLOB_PATHSPECS',
      'GIT_ICASE_PATHSPECS',
    ];
    const previous = Object.fromEntries(inheritedKeys.map((key) => [key, process.env[key]]));
    try {
      runGit(root, ['init', '-q', '-b', 'main']);
      await mkdir(join(root, 'skills', '[review]'), { recursive: true });
      const path = 'skills/[review]/SKILL.md';
      await writeFile(join(root, path), 'abc');
      await writeFile(join(root, 'replacement'), 'replacement content');
      await symlink('[review]/SKILL.md', join(root, 'skills', 'link'));
      runGit(root, ['add', '-A']);
      runGit(root, [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@skillsmith.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'fixture',
      ]);
      const sha = runGit(root, ['rev-parse', 'HEAD']).trim();
      const oid = runGit(root, ['rev-parse', `HEAD:${path}`]).trim();
      const replacement = runGit(root, ['rev-parse', 'HEAD:replacement']).trim();
      runGit(root, ['replace', oid, replacement]);
      expect(runGit(root, ['cat-file', 'blob', oid])).toBe('replacement content');
      for (const key of inheritedKeys) process.env[key] = '1';
      const ports = await defaultRuntimePorts();
      const bytes = await ports.git.readBlobBounded?.({
        repositoryRoot: root,
        ref: sha,
        path,
        maxBytes: 3,
      });
      expect(new TextDecoder().decode(bytes)).toBe('abc');
      await expect(
        ports.git.readBlobBounded?.({
          repositoryRoot: root,
          ref: sha,
          path: 'skills/link',
          maxBytes: 100,
        }),
      ).rejects.toMatchObject({ code: 'invalid' });
      await expect(
        ports.git.readBlobBounded?.({ repositoryRoot: root, ref: sha, path, maxBytes: 2 }),
      ).rejects.toMatchObject({ code: 'invalid' });
    } finally {
      for (const key of inheritedKeys)
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      await rm(root, { recursive: true, force: true });
    }
  });
});
