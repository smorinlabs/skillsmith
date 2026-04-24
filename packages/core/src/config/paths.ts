import { dirname, join } from 'node:path';
import type { ScanEnv } from '../env/types.ts';
import type { Scope } from './types.ts';

export const getConfigPath = (env: ScanEnv, scope: Scope, cwd?: string): string => {
  switch (scope) {
    case 'system':
      return '/etc/skillsmith/config.toml';
    case 'user':
      return join(env.xdg.config, 'skillsmith', 'config.toml');
    case 'project':
      return join(cwd ?? process.cwd(), 'skillsmith.toml');
  }
};

export const findProjectConfig = async (env: ScanEnv, cwd: string): Promise<string | null> => {
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
