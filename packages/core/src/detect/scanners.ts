import { join } from 'node:path';
import type { DetectionPorts } from '../ports/types.ts';
import type { InstallMethod } from './types.ts';

export const wellKnownBinDirs = (env: DetectionPorts): readonly string[] => {
  const home = env.homeDir;
  // $PATH first, in order, so detection finds the binary the user actually runs; the
  // fixed Homebrew dirs are fallbacks for GUI/launchd contexts with a minimal $PATH.
  const common = [
    ...env.executableSearchPath,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.local', 'bin'),
    join(home, '.npm', 'bin'),
    join(home, '.bun', 'install', 'global', 'node_modules', '.bin'),
  ];
  return Array.from(new Set(common));
};

// Homebrew's documented default prefixes: Apple Silicon macOS, Intel macOS, Linux
// (https://docs.brew.sh/Installation, https://docs.brew.sh/Support-Tiers#custom-prefixes).
// A custom prefix (`--path` / `HOMEBREW_PREFIX`) is not recognisable from a path alone.
const homebrewPrefixes = ['/opt/homebrew', '/usr/local', '/home/linuxbrew/.linuxbrew'];

export const classifyInstallMethod = (absPath: string): InstallMethod => {
  // `absPath` is the resolved target. Order matters:
  // 1. Homebrew's Cellar and Caskroom are Homebrew-owned, even when a formula is itself a
  //    node package (Cellar/<formula>/<ver>/libexec/lib/node_modules/...).
  // 2. Any other lib/node_modules target is an npm global (Homebrew's or a version
  //    manager's node), checked before the generic Homebrew-prefix brew rule.
  const brewPrefix = homebrewPrefixes.find((prefix) => absPath.startsWith(`${prefix}/`));
  if (brewPrefix !== undefined) {
    const rest = absPath.slice(brewPrefix.length);
    if (rest.startsWith('/Cellar/') || rest.startsWith('/Caskroom/')) return 'brew';
  }
  if (absPath.includes('/lib/node_modules/')) return 'npm-global';
  if (brewPrefix !== undefined) return 'brew';
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
