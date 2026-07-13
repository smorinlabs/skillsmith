import { join } from 'node:path';
import type { DetectionPorts } from '../ports/types.ts';
import type { InstallMethod } from './types.ts';

export const wellKnownBinDirs = (env: DetectionPorts): readonly string[] => {
  const home = env.homeDir;
  const common = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...env.executableSearchPath,
    join(home, '.local', 'bin'),
    join(home, '.npm', 'bin'),
    join(home, '.bun', 'install', 'global', 'node_modules', '.bin'),
  ];
  return Array.from(new Set(common));
};

export const classifyInstallMethod = (absPath: string): InstallMethod => {
  if (absPath.startsWith('/opt/homebrew/') || absPath.startsWith('/usr/local/')) return 'brew';
  if (absPath.includes('/.bun/install/global/')) return 'bun-global';
  if (absPath.includes('/.npm/') || absPath.includes('node_modules/.bin/')) return 'npm-global';
  if (absPath.includes('.app/Contents/')) return 'app-bundle';
  return 'unknown';
};

export const findOnPath = async (env: DetectionPorts, binary: string): Promise<string[]> => {
  const dirs = wellKnownBinDirs(env);
  const candidates = await Promise.all(
    dirs.map(async (d) => {
      const p = join(d, binary);
      return (await env.fileExists(p)) ? p : null;
    }),
  );
  const hits = candidates.filter((p): p is string => p !== null);
  const resolved = await Promise.all(
    hits.map(async (p) => {
      try {
        return await env.realpath(p);
      } catch {
        return p;
      }
    }),
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < hits.length; i++) {
    const real = resolved[i] ?? hits[i];
    if (real === undefined) continue;
    if (seen.has(real)) continue;
    seen.add(real);
    const hit = hits[i];
    if (hit !== undefined) out.push(hit);
  }
  return out;
};
