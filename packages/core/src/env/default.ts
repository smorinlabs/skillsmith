import {
  cp,
  realpath as fsRealpath,
  rename as fsRename,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, platform as osPlatform } from 'node:os';
import { delimiter, join } from 'node:path';
import lockfile from 'proper-lockfile';
import { execCommand, runVersionCommand } from './exec.ts';
import type { PathKind, Platform, ScanEnv, XdgDirs } from './types.ts';

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

const fsyncPath = async (p: string): Promise<void> => {
  const handle = await open(p, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

export const defaultScanEnv = async (): Promise<ScanEnv> => {
  const home = homedir();
  const path = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
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
        return false;
      }
    },
    realpath: async (p) => fsRealpath(p),
    listDir: async (p) => {
      try {
        return await readdir(p);
      } catch {
        return [];
      }
    },
    readText: async (p) => readFile(p, 'utf8'),
    runVersion: async (binaryPath, args, signal) => runVersionCommand(binaryPath, args, signal),
    exec: async (cmd, args, opts) => execCommand(cmd, args, opts),
    pathKind: async (p): Promise<PathKind> => {
      try {
        const s = await lstat(p);
        if (s.isSymbolicLink()) return 'symlink';
        if (s.isDirectory()) return 'dir';
        return 'file';
      } catch {
        return 'absent';
      }
    },
    isExecutable: async (p) => {
      const s = await stat(p);
      return (s.mode & 0o100) !== 0;
    },
    readBytes: async (p) => readFile(p),
    readLink: async (p) => readlink(p),
    makeSymlink: async (target, linkPath) => {
      await symlink(target, linkPath);
    },
    rename: async (from, to) => {
      await fsRename(from, to);
    },
    copyTree: async (from, to) => {
      await cp(from, to, { recursive: true, verbatimSymlinks: true });
    },
    removeTree: async (p) => {
      await rm(p, { recursive: true, force: true });
    },
    makeDir: async (p) => {
      await mkdir(p, { recursive: true });
    },
    writeTextFile: async (p, text) => {
      await writeFile(p, text, 'utf8');
    },
    fsyncFile: async (p) => fsyncPath(p),
    fsyncDir: async (p) => fsyncPath(p),
    withFileLock: async (p, fn) => {
      const release = await lockfile.lock(p, {
        stale: 30_000,
        update: 5_000,
        retries: { retries: 5, factor: 2, minTimeout: 100, maxTimeout: 2_000 },
      });
      try {
        return await fn();
      } finally {
        await release().catch(() => {});
      }
    },
    modifiedAt: async (p) => {
      try {
        const st = await lstat(p);
        return st.mtimeMs;
      } catch (e) {
        if (
          e &&
          typeof e === 'object' &&
          'code' in e &&
          (e as { code?: unknown }).code === 'ENOENT'
        ) {
          return null;
        }
        throw e;
      }
    },
  };
};
