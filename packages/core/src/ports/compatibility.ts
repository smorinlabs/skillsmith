import type { ScanEnv } from '../env/types.ts';
import type { ExecResult } from '../env/types.ts';
import { isPortError, portError } from './errors.ts';
import type { ClockPort, IdPort, PathAccessPort, RuntimePorts } from './types.ts';

/** The capability surface that can be projected from the public 1.x ScanEnv contract. */
export type LegacyRuntimePorts = Omit<RuntimePorts, 'git' | 'http'>;

export interface LegacyRuntimePortSupplements {
  readonly clock: ClockPort;
  readonly id: IdPort;
  readonly pathAccess?: PathAccessPort;
  readonly readFileMetadata?: RuntimePorts['readFileMetadata'];
  readonly setFileMode?: RuntimePorts['setFileMode'];
}

export type RuntimePortsFromScanEnv = (
  env: ScanEnv,
  supplements: LegacyRuntimePortSupplements,
) => LegacyRuntimePorts;

export type ScanEnvFromRuntimePorts = (ports: LegacyRuntimePorts) => ScanEnv;

const bind = <Arguments extends readonly unknown[], Result>(
  operation: (...args: Arguments) => Result,
  receiver: object,
): ((...args: Arguments) => Result) => operation.bind(receiver);

export const runtimePortsFromScanEnv = (
  env: ScanEnv,
  supplements: LegacyRuntimePortSupplements,
): LegacyRuntimePorts => ({
  homeDir: env.homeDir,
  executableSearchPath: env.path,
  platform: env.platform,
  xdg: env.xdg,
  fileExists: bind(env.fileExists, env),
  pathKind: bind(env.pathKind, env),
  realpath: bind(env.realpath, env),
  listDir: bind(env.listDir, env),
  readText: bind(env.readText, env),
  readBytes: bind(env.readBytes, env),
  readLink: bind(env.readLink, env),
  isExecutable: bind(env.isExecutable, env),
  modifiedAt: bind(env.modifiedAt, env),
  readFileMetadata:
    supplements.readFileMetadata ??
    (async (path) => {
      const kind = await env.pathKind(path);
      return {
        kind,
        mode: null,
        identity: kind === 'absent' ? null : path,
      };
    }),
  makeDir: bind(env.makeDir, env),
  writeTextFile: bind(env.writeTextFile, env),
  makeSymlink: bind(env.makeSymlink, env),
  rename: bind(env.rename, env),
  copyTree: bind(env.copyTree, env),
  removeTree: bind(env.removeTree, env),
  fsyncFile: bind(env.fsyncFile, env),
  fsyncDir: bind(env.fsyncDir, env),
  setFileMode:
    supplements.setFileMode ??
    (async (path) => {
      throw portError({
        capability: 'file-write',
        operation: 'setFileMode',
        code: 'unavailable',
        message: 'file mode writes are unavailable through the ScanEnv compatibility facade',
        context: { path },
      });
    }),
  withFileLock: bind(env.withFileLock, env),
  exec: bind(env.exec, env),
  runVersion: bind(env.runVersion, env),
  wallNowIso: bind(supplements.clock.wallNowIso, supplements.clock),
  epochMilliseconds: bind(supplements.clock.epochMilliseconds, supplements.clock),
  monotonicMilliseconds: bind(supplements.clock.monotonicMilliseconds, supplements.clock),
  nextId: bind(supplements.id.nextId, supplements.id),
  assertWritableDirectory:
    supplements.pathAccess?.assertWritableDirectory.bind(supplements.pathAccess) ??
    (async (path) => {
      throw portError({
        capability: 'path-access',
        operation: 'assertWritableDirectory',
        code: 'unavailable',
        message: 'path access probe is unavailable through the ScanEnv compatibility facade',
        context: { path },
      });
    }),
});

/** @deprecated ScanEnv is retained as a 1.x facade over capability-scoped adapters. */
export const scanEnvFromRuntimePorts = (ports: LegacyRuntimePorts): ScanEnv => ({
  homeDir: ports.homeDir,
  path: ports.executableSearchPath,
  platform: ports.platform,
  xdg: ports.xdg,
  fileExists: async (path) => ports.fileExists(path).catch(() => false),
  pathKind: async (path) => ports.pathKind(path).catch(() => 'absent'),
  realpath: bind(ports.realpath, ports),
  listDir: async (path) => ports.listDir(path).catch(() => []),
  readText: bind(ports.readText, ports),
  readBytes: bind(ports.readBytes, ports),
  readLink: bind(ports.readLink, ports),
  isExecutable: bind(ports.isExecutable, ports),
  modifiedAt: bind(ports.modifiedAt, ports),
  makeDir: bind(ports.makeDir, ports),
  writeTextFile: bind(ports.writeTextFile, ports),
  makeSymlink: bind(ports.makeSymlink, ports),
  rename: bind(ports.rename, ports),
  copyTree: bind(ports.copyTree, ports),
  removeTree: bind(ports.removeTree, ports),
  fsyncFile: bind(ports.fsyncFile, ports),
  fsyncDir: bind(ports.fsyncDir, ports),
  withFileLock: bind(ports.withFileLock, ports),
  runVersion: bind(ports.runVersion, ports),
  exec: async (command, args, options): Promise<ExecResult> => {
    try {
      return await ports.exec(command, args, options);
    } catch (error) {
      return {
        code: -1,
        stdout: '',
        stderr: isPortError(error) ? error.message : 'process operation failed',
        timedOut: false,
      };
    }
  },
});
