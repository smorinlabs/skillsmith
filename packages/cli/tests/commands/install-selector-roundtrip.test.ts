import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { lstat, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readPortableLockSource } from '../../../core/src/artifacts/lock.ts';
import {
  type SelectorRemote,
  buildSelectorRemote,
} from '../../../core/tests/fixtures/acquire/selector-remote.ts';
import { hermeticGitEnv } from '../../../core/tests/fixtures/git-env.ts';
import { InstallJsonSchema } from '../../src/output/install-json.ts';
const CLI_ENTRYPOINT = join(import.meta.dir, '..', 'fixtures', 'selector-cli.ts');

setDefaultTimeout(120_000);
const cli = async (f: SelectorRemote, args: string[], expected = 0) => {
  const child = Bun.spawn([process.execPath, CLI_ENTRYPOINT, '--no-prompt', ...args], {
    cwd: f.cwd,
    env: hermeticGitEnv(f.env, { globalConfigPath: join(f.root, 'gitconfig') }),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, stdout, stderr }, args.join(' ')).toMatchObject({ code: expected });
  return { code, stdout, stderr };
};
const installArgs = (f: SelectorRemote) => [
  'install',
  f.source,
  '--tool',
  'claude-code',
  '--scope',
  'project',
  '--direct',
  '--no-verify',
  '--json',
];
const lock = async (f: SelectorRemote) => {
  const result = readPortableLockSource(await readFile(f.lock));
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

describe('repository selector real CLI and saved-state roundtrips', () => {
  test('directory precedence, forced metadata, no picker, legacy paths, and destination coexist', async () => {
    const f = await buildSelectorRemote();
    try {
      for (const [name, forced, path, installed] of [
        ['review', false, 'skills/review', 'review'],
        ['review', true, 'skills/security-review', 'security-review'],
        ['CODE REVIEW', false, 'skills/review', 'review'],
      ] as const) {
        const result = await cli(f, [
          ...installArgs(f),
          '--skill',
          name,
          ...(forced ? ['--skills-match-frontmatter'] : []),
          '--dry-run',
          '--no-save',
          '--path',
          join(f.cwd, 'custom'),
        ]);
        const report = InstallJsonSchema.parse(JSON.parse(result.stdout));
        expect(report.results[0]).toMatchObject({
          skill: installed,
          origin: { skillPath: path, refResolved: f.sha },
        });
        expect(report.requested.path).toBe(join(f.cwd, 'custom'));
        expect(report.results[0]).not.toHaveProperty('candidateSource');
        expect(report.requested).not.toHaveProperty('skill');
      }
      for (const name of ['duplicate', 'Shared Ability']) {
        const result = await cli(
          f,
          [...installArgs(f), '--skill', name, '--dry-run', '--no-save'],
          2,
        );
        const refused = InstallJsonSchema.parse(JSON.parse(result.stdout)).results[0];
        expect(refused?.action).toBe('refused');
        expect(refused).not.toHaveProperty('candidateSource');
        expect(result.stdout).toContain(
          name === 'duplicate' ? 'by directory name' : 'by frontmatter name',
        );
      }
      const missing = await cli(
        f,
        [
          ...installArgs(f),
          '--skill',
          'security-review',
          '--skills-match-frontmatter',
          '--dry-run',
          '--no-save',
        ],
        5,
      );
      expect(missing.stdout).toContain('matched no skills by frontmatter name');
      const exact = await cli(f, [
        ...installArgs(f).map((a) => (a === f.source ? `${f.source}//skills/review` : a)),
        '--dry-run',
        '--no-save',
      ]);
      expect(InstallJsonSchema.parse(JSON.parse(exact.stdout)).results[0]?.origin?.skillPath).toBe(
        'skills/review',
      );
    } finally {
      await f.cleanup();
    }
  });

  test.each([
    ['nested', 'Code Review', 'review', 'skills/review'],
    ['root', 'Root Ability', 'catalog', '.'],
  ] as const)(
    '%s selection persists an exact path across plan, saved apply, and moving updates',
    async (_label, lookup, installed, sourcePath) => {
      const f = await buildSelectorRemote();
      try {
        const initial = await cli(f, [
          ...installArgs(f),
          '--skill',
          lookup,
          '--skills-match-frontmatter',
          '--file',
          f.manifest,
          '--ref',
          'main',
        ]);
        const report = InstallJsonSchema.parse(JSON.parse(initial.stdout));
        expect(report.results[0]).toMatchObject({
          skill: installed,
          origin: { skillPath: sourcePath === '.' ? '' : sourcePath, refResolved: f.sha },
        });
        const before = await lock(f);
        expect(before.skills[0]).toMatchObject({
          name: installed,
          source: `selector.fixture.invalid/acme/catalog${sourcePath === '.' ? '' : `//${sourcePath}`}`,
          requestedRef: 'main',
          sourcePath,
          resolvedSha: f.sha,
        });
        const manifest = await readFile(f.manifest, 'utf8');
        expect(manifest).not.toContain(lookup);
        expect(manifest).not.toContain('skills-match-frontmatter');
        // Simulate a fresh manifest checkout: no live placement, ledger, lock, or source cache.
        const live = join(f.cwd, '.claude', 'skills', installed);
        await rm(live, { recursive: true, force: true });
        const saved = join(f.cwd, 'repair.plan');
        await rm(join(f.root, 'data', 'skillsmith'), { recursive: true, force: true });
        await rm(f.lock);
        await cli(f, ['plan', '--file', f.manifest, '--out', saved, '--json']);
        // The saved plan must also apply without the source cache populated by planning.
        await rm(join(f.root, 'data', 'skillsmith'), { recursive: true, force: true });
        await cli(f, ['apply', '--plan', saved, '--json']);
        expect(await readFile(join(live, 'SKILL.md'), 'utf8')).toContain(lookup);
        await expect(lstat(join(live, '.git'))).rejects.toHaveProperty('code', 'ENOENT');
        if (sourcePath === '.') {
          expect(await readFile(join(live, 'skills', 'catalog', 'SKILL.md'), 'utf8')).toContain(
            'Nested Catalog',
          );
        }
        expect((await lock(f)).skills[0]).toEqual(before.skills[0]);
        await cli(f, ['plan', '--file', f.manifest, '--check', '--json']);
        // The original lookup moves to a competitor while the selected path changes its metadata.
        await f.put(
          sourcePath === '.' ? '' : sourcePath,
          'Changed Declaration',
          'updated selected payload',
        );
        await f.put('skills/competitor', lookup, 'wrong competitor payload');
        const next = f.commit();
        f.publish();
        await cli(f, ['update', installed, '--file', f.manifest, '--yes', '--json']);
        const after = await lock(f);
        expect(after.skills[0]).toMatchObject({ name: installed, sourcePath, resolvedSha: next });
        expect(after.skills[0]?.contentHash).not.toBe(before.skills[0]?.contentHash);
        expect(await readFile(join(live, 'SKILL.md'), 'utf8')).toContain(
          'updated selected payload',
        );
        expect(await readFile(f.manifest, 'utf8')).toBe(manifest);
        await cli(f, ['plan', '--file', f.manifest, '--check', '--json']);
        // Deleting the selected SKILL.md must refuse; the competitor must never replace it.
        await rm(join(f.work, sourcePath === '.' ? '' : sourcePath, 'SKILL.md'));
        f.commit();
        f.publish();
        const lockedBytes = await readFile(f.lock, 'utf8');
        await cli(f, ['update', installed, '--file', f.manifest, '--yes', '--json'], 5);
        expect(await readFile(f.lock, 'utf8')).toBe(lockedBytes);
        expect(await readFile(join(live, 'SKILL.md'), 'utf8')).toContain(
          'updated selected payload',
        );
        // A fresh plan must fail the missing exact path even when the matching name survives.
        await rm(live, { recursive: true, force: true });
        await rm(join(f.root, 'data', 'skillsmith'), { recursive: true, force: true });
        await rm(f.lock);
        await cli(f, ['plan', '--file', f.manifest, '--json'], 5);
        expect(await Bun.file(f.lock).exists()).toBe(false);
        expect(await Bun.file(join(live, 'SKILL.md')).exists()).toBe(false);
      } finally {
        await f.cleanup();
      }
    },
  );
});
