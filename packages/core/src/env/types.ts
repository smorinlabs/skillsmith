export type Platform = 'darwin' | 'linux' | 'win32';

export type PathKind = 'file' | 'dir' | 'symlink' | 'absent';

export interface XdgDirs {
  config: string;
  data: string;
  cache: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>; // merged over process.env, e.g. { CODEX_HOME: '<tmp>' }
  unsetEnv?: readonly string[]; // removed after env merge; callers cannot reintroduce these keys
  timeoutMs?: number;
  input?: string;
  // Bounded JSON-lines exchange: await each request's response before sending the next message.
  jsonRpc?: readonly { id?: number; method: string; params?: unknown }[];
  signal?: AbortSignal;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  protocolError?: string;
}

export interface ScanEnv {
  homeDir: string;
  path: readonly string[];
  platform: Platform;
  xdg: XdgDirs;
  fileExists(p: string): Promise<boolean>;
  realpath(p: string): Promise<string>;
  listDir(p: string): Promise<readonly string[]>;
  readText(p: string): Promise<string>;
  runVersion(
    binaryPath: string,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<string | 'unknown'>;
  exec(cmd: string, args: readonly string[], opts?: ExecOptions): Promise<ExecResult>;
  pathKind(p: string): Promise<PathKind>;
  isExecutable(p: string): Promise<boolean>;
  readBytes(p: string): Promise<Uint8Array>;
  readLink(p: string): Promise<string>;
  makeSymlink(target: string, linkPath: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  copyTree(from: string, to: string): Promise<void>;
  removeTree(p: string): Promise<void>;
  makeDir(p: string): Promise<void>;
  writeTextFile(p: string, text: string): Promise<void>;
  fsyncFile(p: string): Promise<void>;
  fsyncDir(p: string): Promise<void>;
  withFileLock<T>(p: string, fn: () => Promise<T>): Promise<T>;
  modifiedAt(p: string): Promise<number | null>; // lstat mtimeMs; null when absent (ENOENT)
}
