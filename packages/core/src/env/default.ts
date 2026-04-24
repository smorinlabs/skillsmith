import { existsSync } from 'node:fs';
import { realpath as fsRealpath, stat } from 'node:fs/promises';
import { homedir, platform as osPlatform } from 'node:os';
import { join } from 'node:path';
import { runVersionCommand } from '../detect/exec.ts';
import type { Platform, ScanEnv, XdgDirs } from './types.ts';

const resolvePlatform = (): Platform => {
  const p = osPlatform();
  if (p === 'darwin' || p === 'linux' || p === 'win32') return p;
  return 'linux';
};

const resolveXdg = (home: string): XdgDirs => ({
  config: process.env.XDG_CONFIG_HOME ?? join(home, '.config'),
  data: process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'),
  cache: process.env.XDG_CACHE_HOME ?? join(home, '.cache'),
});

export const defaultScanEnv = async (): Promise<ScanEnv> => {
  const home = homedir();
  const path = (process.env.PATH ?? '').split(':').filter(Boolean);
  return {
    homeDir: home,
    path,
    platform: resolvePlatform(),
    xdg: resolveXdg(home),
    fileExists: async (p) => {
      try {
        await stat(p);
        return true;
      } catch {
        return existsSync(p);
      }
    },
    realpath: async (p) => fsRealpath(p),
    runVersion: async (binaryPath, args, signal) => runVersionCommand(binaryPath, args, signal),
  };
};
