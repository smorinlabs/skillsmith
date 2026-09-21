import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermeticGitEnv, runGit } from '../git-env.ts';

/** An owned local bare repository. All parser-facing URLs map here; network protocols are disabled. */
export const buildSelectorRemote = async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillsmith-selector-remote-'));
  try {
    const work = join(root, 'work');
    const bare = join(root, 'catalog.git');
    const cwd = join(root, 'project');
    const home = join(root, 'home');
    const bin = join(root, 'bin');
    const config = join(root, 'config');
    const data = join(root, 'data');
    const cache = join(root, 'cache');
    for (const dir of [work, cwd, home, bin, config, data, cache])
      await mkdir(dir, { recursive: true });
    const put = async (path: string, name: string, body = 'initial payload') => {
      await mkdir(join(work, path), { recursive: true });
      await writeFile(
        join(work, path, 'SKILL.md'),
        `---\nname: ${name}\ndescription: Hermetic selector fixture.\n---\n\n${body}\n`,
      );
    };
    await put('', 'Root Ability');
    await put('skills/catalog', 'Nested Catalog');
    await put('skills/review', 'Code Review');
    await put('skills/security-review', 'review');
    await put('groups/a/duplicate', 'Shared Ability');
    await put('groups/b/duplicate', 'SHARED ABILITY');
    await put('.hidden/skills/hidden', 'Code Review');
    runGit(work, ['init', '-q', '-b', 'main']);
    const commit = () => {
      runGit(work, ['add', '-A']);
      runGit(work, [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@skillsmith.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'selector fixture',
      ]);
      return runGit(work, ['rev-parse', 'HEAD']).trim();
    };
    const sha = commit();
    runGit(root, ['clone', '-q', '--bare', work, bare]);
    runGit(bare, ['config', 'uploadpack.allowFilter', 'true']);
    runGit(bare, ['config', 'uploadpack.allowReachableSHA1InWant', 'true']);
    const source = 'https://selector.fixture.invalid/acme/catalog.git';
    const gitConfig = join(root, 'gitconfig');
    await writeFile(
      gitConfig,
      `[url "file://${bare}"]\n\tinsteadOf = ${source}\n[url "file://${bare}"]\n\tinsteadOf = https://selector.fixture.invalid/acme/catalog\n[core]\n\thooksPath = /dev/null\n[protocol "file"]\n\tallow = always\n`,
    );
    await writeFile(join(bin, 'claude'), '#!/bin/sh\necho "2.1.1 (Claude Code)"\n');
    await chmod(join(bin, 'claude'), 0o755);
    const env = hermeticGitEnv(
      {
        HOME: home,
        XDG_CONFIG_HOME: config,
        XDG_DATA_HOME: data,
        XDG_CACHE_HOME: cache,
        SKILLSMITH_HOME: join(data, 'skillsmith'),
        PATH: `${bin}:/usr/bin:/bin`,
        GIT_ALLOW_PROTOCOL: 'file',
        GIT_TERMINAL_PROMPT: '0',
      },
      { globalConfigPath: gitConfig },
    );
    return {
      root,
      work,
      bare,
      cwd,
      home,
      sha,
      source,
      env,
      put,
      commit,
      publish: () => runGit(work, ['push', '-q', `file://${bare}`, 'main:main']),
      manifest: join(cwd, 'skillsmith.toml'),
      lock: join(cwd, 'skillsmith.lock'),
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
};
export type SelectorRemote = Awaited<ReturnType<typeof buildSelectorRemote>>;
