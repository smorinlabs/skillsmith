import type { ScanEnv } from '../../src/env/types.ts';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { runtimePortsFromScanEnv } from '../../src/ports/compatibility.ts';
import type { RuntimePorts } from '../../src/ports/types.ts';

let sequence = 0;

const nextFixtureId = (purpose: string): string => {
  sequence += 1;
  return purpose === 'acquisition-transaction' || purpose === 'placement-transaction'
    ? sequence.toString(16).padStart(8, '0').slice(-8)
    : `${purpose}-${sequence}`;
};

/** Explicit compatibility projection for tests whose fixtures still exercise the public 1.x facade. */
export const runtimePorts = (env: ScanEnv): RuntimePorts => ({
  ...runtimePortsFromScanEnv(env, {
    clock: {
      wallNowIso: () => '2026-07-12T00:00:00.000Z',
      epochMilliseconds: () => 0,
      monotonicMilliseconds: () => 0,
    },
    id: { nextId: nextFixtureId },
    readFileMetadata: async (path) => {
      try {
        const value = await lstat(path);
        return {
          kind: value.isSymbolicLink()
            ? 'symlink'
            : value.isDirectory()
              ? 'dir'
              : value.isFile()
                ? 'file'
                : 'other',
          mode: value.mode & 0o7777,
          identity: `${value.dev}:${value.ino}`,
          linkCount: value.nlink,
          uid: value.uid,
          gid: value.gid,
        };
      } catch {
        const kind = await env.pathKind(path);
        return kind === 'absent'
          ? { kind, mode: null, identity: null, linkCount: 0, uid: null, gid: null }
          : { kind, mode: null, identity: path };
      }
    },
    setFileMode: (path, mode) => chmod(path, mode),
    privateState: {
      effectiveUserIdentity: () => ({
        uid: process.geteuid?.() ?? process.getuid?.() ?? null,
        gid: process.getegid?.() ?? process.getgid?.() ?? null,
      }),
      makeDirExclusive: async (path, mode) => {
        await mkdir(path, { recursive: false, mode });
      },
      writeTextFileExclusive: async (path, text, mode) => {
        const handle = await open(path, 'wx', mode);
        try {
          await handle.writeFile(text, 'utf8');
        } finally {
          await handle.close();
        }
      },
    },
  }),
  xdg: { ...env.xdg, cache: tmpdir() },
  readText: async (path) => {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return env.readText(path);
    }
  },
  makeDir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  writeTextFile: async (path, text) => {
    await writeFile(path, text, 'utf8');
  },
  makeSymlink: async (target, linkPath) => {
    await symlink(target, linkPath);
  },
  rename,
  copyTree: async (from, to) => {
    await cp(from, to, { recursive: true });
  },
  removeTree: async (path) => {
    await rm(path, { recursive: true, force: true });
  },
  fsyncFile: async (path) => {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  fsyncDir: async () => {},
  git: {
    findRepositoryRoot: async () => null,
    inspectWorktree: async ({ repositoryRoot }) => ({
      repositoryRoot,
      headSha: '',
      remoteUrl: null,
      dirtySummary: null,
    }),
    resolveRemoteRef: async () => null,
    initializeFetch: async () => {},
    fetchRef: async () => ({ sha: '' }),
    listTree: async () => [],
    readBlob: async () => new Uint8Array(),
    materializeTree: async () => '',
  },
  http: { request: async () => ({ status: 200, ok: true }) },
});
