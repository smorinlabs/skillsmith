import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hashGitPortableContent,
  hashLivePortableContent,
  observeExactGitPortableContent,
} from '../../src/export/portable-content.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';
import type { GitPort, GitTreeEntry, GitWorktreeInspection } from '../../src/ports/types.ts';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const encoder = new TextEncoder();

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'skillsmith-export-portable-content-'));
  await mkdir(join(root, 'bin'), { recursive: true });
  await writeFile(join(root, 'SKILL.md'), '# alpha\n');
  await writeFile(join(root, 'bin', 'run.sh'), '#!/bin/sh\nexit 0\n');
  await chmod(join(root, 'bin', 'run.sh'), 0o755);
  await symlink('SKILL.md', join(root, 'link.md'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const entries = (overrides: readonly GitTreeEntry[] = []): readonly GitTreeEntry[] =>
  overrides.length > 0
    ? overrides
    : [
        { path: 'skills/alpha/SKILL.md', kind: 'blob', mode: '100644' },
        { path: 'skills/alpha/bin/run.sh', kind: 'blob', mode: '100755' },
        { path: 'skills/alpha/link.md', kind: 'blob', mode: '120000' },
      ];

const blobs = new Map<string, Uint8Array>([
  ['skills/alpha/SKILL.md', encoder.encode('# alpha\n')],
  ['skills/alpha/bin/run.sh', encoder.encode('#!/bin/sh\nexit 0\n')],
  ['skills/alpha/link.md', encoder.encode('SKILL.md')],
]);

const gitWith = (
  base: GitPort,
  options: Readonly<{
    tree?: readonly GitTreeEntry[];
    inspections?: readonly GitWorktreeInspection[];
  }> = {},
): GitPort => {
  let inspectionIndex = 0;
  const inspections = options.inspections ?? [
    {
      repositoryRoot: '/repo',
      headSha: SHA,
      remoteUrl: 'https://fixture.invalid/acme/repo.git',
      dirtySummary: null,
    },
  ];
  return {
    ...base,
    listTree: async () => options.tree ?? entries(),
    readBlob: async ({ path }) => blobs.get(path) ?? new Uint8Array(),
    inspectWorktree: async () =>
      inspections[Math.min(inspectionIndex++, inspections.length - 1)] as GitWorktreeInspection,
  };
};

describe('portable export content authority', () => {
  test('projects exact Git file modes, bytes, symlink targets, and implied directories', async () => {
    const base = await defaultRuntimePorts();
    const git = gitWith(base.git);
    const [exact, live] = await Promise.all([
      hashGitPortableContent(git, {
        repositoryRoot: '/repo',
        ref: SHA,
        sourcePath: 'skills/alpha',
      }),
      hashLivePortableContent(base, root),
    ]);

    expect(exact).not.toBeNull();
    expect(exact).toBe(live);
  });

  test('rejects mode, byte, symlink, ignored/empty member, submodule, and unknown-mode drift', async () => {
    const base = await defaultRuntimePorts();
    const live = await hashLivePortableContent(base, root);
    const changedMode = await hashGitPortableContent(
      gitWith(base.git, {
        tree: entries().map((entry) =>
          entry.path.endsWith('run.sh') ? { ...entry, mode: '100644' } : entry,
        ),
      }),
      { repositoryRoot: '/repo', ref: SHA, sourcePath: 'skills/alpha' },
    );
    expect(changedMode).not.toBe(live);

    blobs.set('skills/alpha/link.md', encoder.encode('bin/run.sh'));
    const changedLink = await hashGitPortableContent(gitWith(base.git), {
      repositoryRoot: '/repo',
      ref: SHA,
      sourcePath: 'skills/alpha',
    });
    blobs.set('skills/alpha/link.md', encoder.encode('SKILL.md'));
    expect(changedLink).not.toBe(live);

    await mkdir(join(root, 'ignored-empty'));
    await writeFile(join(root, 'ignored.txt'), 'ignored\n');
    expect(await hashLivePortableContent(base, root)).not.toBe(live);

    expect(
      await hashGitPortableContent(
        gitWith(base.git, {
          tree: [
            ...entries(),
            { path: 'skills/alpha/vendor/submodule', kind: 'commit', mode: '160000' },
          ],
        }),
        { repositoryRoot: '/repo', ref: SHA, sourcePath: 'skills/alpha' },
      ),
    ).toBeNull();
    expect(
      await hashGitPortableContent(
        gitWith(base.git, {
          tree: entries().map((entry) =>
            entry.path.endsWith('run.sh') ? { ...entry, mode: '100600' } : entry,
          ),
        }),
        { repositoryRoot: '/repo', ref: SHA, sourcePath: 'skills/alpha' },
      ),
    ).toBeNull();
  });

  test('requires matching clean inspections around the exact live/object comparison', async () => {
    const base = await defaultRuntimePorts();
    const inspection = (headSha: string): GitWorktreeInspection => ({
      repositoryRoot: '/repo',
      headSha,
      remoteUrl: 'https://fixture.invalid/acme/repo.git',
      dirtySummary: null,
    });
    const stable = await observeExactGitPortableContent(
      { ...base, git: gitWith(base.git, { inspections: [inspection(SHA), inspection(SHA)] }) },
      { repositoryRoot: '/repo', liveRoot: root, sourcePath: 'skills/alpha' },
    );
    expect(stable.contentHash).not.toBeNull();

    const raced = await observeExactGitPortableContent(
      {
        ...base,
        git: gitWith(base.git, { inspections: [inspection(SHA), inspection(OTHER_SHA)] }),
      },
      { repositoryRoot: '/repo', liveRoot: root, sourcePath: 'skills/alpha' },
    );
    expect(raced.contentHash).toBeNull();
  });
});
