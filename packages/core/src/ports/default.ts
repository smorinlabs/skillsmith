import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  cp,
  realpath as fsRealpath,
  rename as fsRename,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  readdir,
  readlink,
  rm,
  rmdir,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, platform as osPlatform } from 'node:os';
import { delimiter, join } from 'node:path';
import lockfile from 'proper-lockfile';
import type { PathKind, Platform, XdgDirs } from '../env/types.ts';
import { isPortError, toPortError } from './errors.ts';
import { type BinaryProcessPort, createGitPort } from './git.ts';
import { createHttpPort } from './http.ts';
import type {
  BoundedFileReadPort,
  ClockPort,
  EffectiveUserPort,
  ExclusiveCreatePort,
  FileMetadataReadPort,
  FileModeWritePort,
  FileReadPort,
  FileWritePort,
  IdPort,
  LockPort,
  PathAccessPort,
  ProcessPort,
  RuntimePorts,
} from './types.ts';

const DEFAULT_VERSION_TIMEOUT_MS = 2_000;
const LOCK_RETRY_DELAYS_MS = Object.freeze([100, 200, 400, 800, 1_600] as const);

/** Focused real clock authority for zero-discovery command observation. */
export const defaultClockPort: ClockPort = Object.freeze({
  wallNowIso: () => new Date().toISOString(),
  epochMilliseconds: () => Date.now(),
  monotonicMilliseconds: () => performance.now(),
});

/** Focused real ID authority for zero-discovery command observation. */
export const defaultIdPort: IdPort = Object.freeze({
  nextId: (purpose: string) =>
    purpose === 'acquisition-transaction' || purpose === 'placement-transaction'
      ? randomBytes(4).toString('hex')
      : `${purpose}-${randomBytes(8).toString('hex')}`,
});

const resolvePlatform = (): Platform => {
  const value = osPlatform();
  return value === 'darwin' || value === 'linux' || value === 'win32' ? value : 'linux';
};

const resolveXdg = (home: string): XdgDirs => ({
  config: process.env.XDG_CONFIG_HOME ?? join(home, '.config'),
  data: process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'),
  cache: process.env.XDG_CACHE_HOME ?? join(home, '.cache'),
});

const nodeCode = (error: unknown): string | null =>
  error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;

const fileOperation = async <T>(
  capability: 'file-read' | 'file-write',
  operation: string,
  context: Readonly<Record<string, string>>,
  run: () => Promise<T>,
): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    throw toPortError(error, { capability, operation, context });
  }
};

const fsyncPath = (path: string): Promise<void> =>
  fileOperation('file-write', 'fsync', { path }, async () => {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  });

const createFileReadPort = (): FileReadPort & FileMetadataReadPort & BoundedFileReadPort => ({
  fileExists: async (path) => {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if (nodeCode(error) === 'ENOENT') return false;
      throw toPortError(error, {
        capability: 'file-read',
        operation: 'fileExists',
        context: { path },
      });
    }
  },
  pathKind: async (path): Promise<PathKind> => {
    try {
      const value = await lstat(path);
      if (value.isSymbolicLink()) return 'symlink';
      if (value.isDirectory()) return 'dir';
      return 'file';
    } catch (error) {
      if (nodeCode(error) === 'ENOENT') return 'absent';
      throw toPortError(error, {
        capability: 'file-read',
        operation: 'pathKind',
        context: { path },
      });
    }
  },
  realpath: (path) =>
    fileOperation('file-read', 'realpath', { path }, async () => fsRealpath(path)),
  listDir: async (path) => {
    try {
      return await readdir(path);
    } catch (error) {
      if (nodeCode(error) === 'ENOENT') return [];
      throw toPortError(error, {
        capability: 'file-read',
        operation: 'listDir',
        context: { path },
      });
    }
  },
  listDirBounded: async (path, maxEntries) => {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) {
      throw new RangeError('maxEntries must be a non-negative safe integer');
    }
    try {
      const directory = await opendir(path);
      const entries: string[] = [];
      try {
        while (true) {
          const entry = await directory.read();
          if (entry === null) break;
          if (entries.length >= maxEntries) {
            throw new RangeError('bounded directory entry limit exceeded');
          }
          entries.push(entry.name);
        }
      } finally {
        try {
          await directory.close();
        } catch {}
      }
      return entries;
    } catch (error) {
      if (nodeCode(error) === 'ENOENT') return [];
      throw toPortError(error, {
        capability: 'file-read',
        operation: 'listDirBounded',
        context: { path, maxEntries: String(maxEntries) },
      });
    }
  },
  readText: (path) =>
    fileOperation('file-read', 'readText', { path }, async () => readFile(path, 'utf8')),
  readBytes: (path) =>
    fileOperation('file-read', 'readBytes', { path }, async () => readFile(path)),
  readFileSnapshotNoFollow: (path, maxBytes) =>
    fileOperation('file-read', 'readFileSnapshotNoFollow', { path }, async () => {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
        throw new RangeError('maxBytes must be a non-negative safe integer');
      }
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile() || before.size < 0n || before.size > BigInt(maxBytes)) {
          throw new Error('bounded file snapshot metadata is unsafe');
        }
        const buffer = new Uint8Array(maxBytes + 1);
        let offset = 0;
        while (offset < buffer.byteLength) {
          const { bytesRead } = await handle.read(
            buffer,
            offset,
            buffer.byteLength - offset,
            offset,
          );
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        if (offset > maxBytes) throw new Error('bounded file snapshot byte limit exceeded');
        const after = await handle.stat({ bigint: true });
        if (
          !after.isFile() ||
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs ||
          after.size !== BigInt(offset)
        ) {
          throw new Error('bounded file snapshot changed while reading');
        }
        return {
          bytes: buffer.slice(0, offset),
          metadata: {
            kind: 'file',
            mode: Number(after.mode & 0o7777n),
            identity: `${after.dev}:${after.ino}`,
            linkCount: Number(after.nlink),
            uid: Number(after.uid),
            gid: Number(after.gid),
            sizeBytes: offset,
          },
        };
      } finally {
        await handle.close();
      }
    }),
  readLink: (path) => fileOperation('file-read', 'readLink', { path }, async () => readlink(path)),
  isExecutable: (path) =>
    fileOperation('file-read', 'isExecutable', { path }, async () => {
      const value = await stat(path);
      return (value.mode & 0o100) !== 0;
    }),
  modifiedAt: async (path) => {
    try {
      return (await lstat(path)).mtimeMs;
    } catch (error) {
      if (nodeCode(error) === 'ENOENT') return null;
      throw toPortError(error, {
        capability: 'file-read',
        operation: 'modifiedAt',
        context: { path },
      });
    }
  },
  readFileMetadata: async (path) => {
    try {
      const value = await lstat(path);
      const kind = value.isSymbolicLink()
        ? 'symlink'
        : value.isDirectory()
          ? 'dir'
          : value.isFile()
            ? 'file'
            : 'other';
      return {
        kind,
        mode: value.mode & 0o7777,
        identity: `${value.dev}:${value.ino}`,
        linkCount: value.nlink,
        uid: value.uid,
        gid: value.gid,
        sizeBytes: value.isFile() ? value.size : null,
      };
    } catch (error) {
      if (nodeCode(error) === 'ENOENT')
        return {
          kind: 'absent',
          mode: null,
          identity: null,
          linkCount: 0,
          uid: null,
          gid: null,
        };
      throw toPortError(error, {
        capability: 'file-read',
        operation: 'readFileMetadata',
        context: { path },
      });
    }
  },
});

const createFileWritePort = (): FileWritePort & FileModeWritePort => ({
  makeDir: (path) =>
    fileOperation('file-write', 'makeDir', { path }, async () => {
      await mkdir(path, { recursive: true });
    }),
  writeTextFile: (path, text) =>
    fileOperation('file-write', 'writeTextFile', { path }, async () => {
      await writeFile(path, text, 'utf8');
    }),
  makeSymlink: (target, linkPath) =>
    fileOperation('file-write', 'makeSymlink', { target, linkPath }, async () => {
      await symlink(target, linkPath);
    }),
  rename: (from, to) =>
    fileOperation('file-write', 'rename', { from, to }, async () => {
      await fsRename(from, to);
    }),
  copyTree: (from, to) =>
    fileOperation('file-write', 'copyTree', { from, to }, async () => {
      await cp(from, to, { recursive: true, verbatimSymlinks: true });
    }),
  removeTree: (path) =>
    fileOperation('file-write', 'removeTree', { path }, async () => {
      await rm(path, { recursive: true, force: true });
    }),
  removeEmptyDirectory: (path) =>
    fileOperation('file-write', 'removeEmptyDirectory', { path }, async () => {
      await rmdir(path);
    }),
  fsyncFile: (path) => fsyncPath(path),
  fsyncDir: (path) => fsyncPath(path),
  setFileMode: (path, mode) =>
    fileOperation('file-write', 'setFileMode', { path, mode: mode.toString(8) }, async () => {
      await chmod(path, mode);
    }),
});

const createPrivateStatePort = (): EffectiveUserPort & ExclusiveCreatePort => ({
  effectiveUserIdentity: () => ({
    uid: process.geteuid?.() ?? process.getuid?.() ?? null,
    gid: process.getegid?.() ?? process.getgid?.() ?? null,
  }),
  makeDirExclusive: (path, mode) =>
    fileOperation('file-write', 'makeDirExclusive', { path, mode: mode.toString(8) }, async () => {
      await mkdir(path, { recursive: false, mode });
    }),
  writeTextFileExclusive: (path, text, mode) =>
    fileOperation(
      'file-write',
      'writeTextFileExclusive',
      { path, mode: mode.toString(8) },
      async () => {
        const handle = await open(path, 'wx', mode);
        try {
          await handle.writeFile(text, 'utf8');
        } finally {
          await handle.close();
        }
      },
    ),
});

const cancelledLockError = (path: string) =>
  toPortError(
    { code: 'ABORT_ERR' },
    {
      capability: 'lock',
      operation: 'withFileLock',
      code: 'cancelled',
      message: 'lock acquisition was cancelled',
      context: { path },
    },
  );

const waitForLockRetry = (
  milliseconds: number,
  path: string,
  signal: AbortSignal | undefined,
): Promise<void> => {
  if (signal?.aborted) return Promise.reject(cancelledLockError(path));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(cancelledLockError(path));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

const createLockPort = (): LockPort => ({
  withFileLock: async (path, operation, options = {}) => {
    const { signal } = options;
    if (signal?.aborted) throw cancelledLockError(path);

    let release: (() => Promise<void>) | undefined;
    for (let attempt = 0; attempt <= LOCK_RETRY_DELAYS_MS.length; attempt += 1) {
      if (signal?.aborted) throw cancelledLockError(path);
      try {
        release = await lockfile.lock(path, {
          realpath: false,
          stale: 30_000,
          update: 5_000,
          retries: 0,
        });
        break;
      } catch (error) {
        if (signal?.aborted) throw cancelledLockError(path);
        const delay = LOCK_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) {
          throw toPortError(error, {
            capability: 'lock',
            operation: 'withFileLock',
            context: { path },
          });
        }
        await waitForLockRetry(delay, path, signal);
      }
    }
    if (release === undefined) {
      throw toPortError(new Error('lock acquisition exhausted'), {
        capability: 'lock',
        operation: 'withFileLock',
        context: { path },
      });
    }
    try {
      if (signal?.aborted) throw cancelledLockError(path);
      return await operation();
    } finally {
      await release().catch(() => {});
    }
  },
});

const createPathAccessPort = (): PathAccessPort => ({
  assertWritableDirectory: async (path) => {
    const uid = process.getuid?.() ?? null;
    try {
      await access(path, constants.W_OK | constants.X_OK);
    } catch (error) {
      throw toPortError(error, {
        capability: 'path-access',
        operation: 'assertWritableDirectory',
        context: { path, uid },
      });
    }
  },
});

const createProcessPorts = (): {
  readonly processPort: ProcessPort;
  readonly binaryProcessPort: BinaryProcessPort;
} => {
  const binaryExec: BinaryProcessPort['exec'] = async (command, args, options = {}) => {
    if (options.signal?.aborted) {
      throw toPortError(
        { code: 'ABORT_ERR' },
        {
          capability: 'process',
          operation: 'exec',
          code: 'cancelled',
          message: 'process operation was cancelled',
          context: { command },
        },
      );
    }
    const childEnvironment: Record<string, string | undefined> = {
      ...process.env,
      ...options.env,
    };
    for (const name of options.unsetEnv ?? []) delete childEnvironment[name];
    let timedOut = false;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeAbort: (() => void) | undefined;
    try {
      const child = Bun.spawn([command, ...args], {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        env: childEnvironment,
        stdin: options.input !== undefined ? new TextEncoder().encode(options.input) : undefined,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (cancelled) return;
          timedOut = true;
          child.kill();
        }, options.timeoutMs);
      }
      const abort = () => {
        if (timedOut) return;
        cancelled = true;
        child.kill();
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      removeAbort = () => options.signal?.removeEventListener('abort', abort);
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).arrayBuffer().catch(() => new ArrayBuffer(0)),
        new Response(child.stderr).text().catch(() => ''),
      ]);
      if (cancelled) {
        throw toPortError(
          { code: 'ABORT_ERR' },
          {
            capability: 'process',
            operation: 'exec',
            code: 'cancelled',
            message: 'process operation was cancelled',
            context: { command },
          },
        );
      }
      return { code, stdout: new Uint8Array(stdout), stderr, timedOut };
    } catch (error) {
      if (isPortError(error)) throw error;
      throw toPortError(error, {
        capability: 'process',
        operation: 'exec',
        context: { command },
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      removeAbort?.();
    }
  };

  const binaryProcessPort: BinaryProcessPort = { exec: binaryExec };
  const exec: ProcessPort['exec'] = async (command, args, options) => {
    const result = await binaryExec(command, args, options);
    return { ...result, stdout: new TextDecoder().decode(result.stdout) };
  };
  const processPort: ProcessPort = {
    exec,
    runVersion: async (binaryPath, args, signal) => {
      try {
        const result = await exec(binaryPath, args, {
          timeoutMs: DEFAULT_VERSION_TIMEOUT_MS,
          ...(signal ? { signal } : {}),
        });
        if (result.code !== 0 || result.timedOut) return 'unknown';
        return result.stdout.trim().split('\n')[0]?.trim() || 'unknown';
      } catch {
        return 'unknown';
      }
    },
  };
  return { processPort, binaryProcessPort };
};

export const defaultRuntimePorts = async (): Promise<RuntimePorts & BoundedFileReadPort> => {
  const homeDir = homedir();
  const { processPort, binaryProcessPort } = createProcessPorts();
  return {
    homeDir,
    executableSearchPath: (process.env.PATH ?? '').split(delimiter).filter(Boolean),
    platform: resolvePlatform(),
    xdg: resolveXdg(homeDir),
    ...createFileReadPort(),
    ...createFileWritePort(),
    ...createPrivateStatePort(),
    ...createLockPort(),
    ...createPathAccessPort(),
    ...processPort,
    ...defaultClockPort,
    ...defaultIdPort,
    git: createGitPort(processPort, binaryProcessPort),
    http: createHttpPort(),
  };
};
