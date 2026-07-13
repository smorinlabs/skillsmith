import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { FileReadPort, PlatformPaths } from '../ports/types.ts';
import type { Scope } from './types.ts';

export const getConfigPath = (
  env: Pick<PlatformPaths, 'xdg'>,
  scope: Scope,
  cwd?: string,
): string => {
  switch (scope) {
    case 'system':
      return '/etc/skillsmith/config.toml';
    case 'user':
      return join(env.xdg.config, 'skillsmith', 'config.toml');
    case 'project':
      if (cwd === undefined) throw new Error('project config path requires cwd');
      return join(cwd, 'skillsmith.toml');
    case 'managed':
      // SkillSmith config has no managed layer (managed is for skills/plugins).
      // Return an unwritable path so the caller fails fast if it tries to use it.
      return '/dev/null';
  }
};

export const findProjectConfig = async (
  env: Pick<FileReadPort, 'fileExists'>,
  cwd: string,
): Promise<string | null> => {
  let dir = cwd;
  while (true) {
    const candidate = join(dir, 'skillsmith.toml');
    if (await env.fileExists(candidate)) return candidate;
    const gitDir = join(dir, '.git');
    if (await env.fileExists(gitDir)) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

export const resolveExplicitFile = (input: {
  flag: string | undefined;
  env: string | undefined;
}): string | null => input.flag ?? input.env ?? null;

export const resolveConfigPath = (path: string | null, effectiveCwd: string): string | null =>
  path === null ? null : isAbsolute(path) ? resolve(path) : resolve(effectiveCwd, path);
