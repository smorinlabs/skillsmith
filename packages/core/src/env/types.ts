export type Platform = 'darwin' | 'linux' | 'win32';

export interface XdgDirs {
  config: string;
  data: string;
  cache: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>; // merged over process.env, e.g. { CODEX_HOME: '<tmp>' }
  timeoutMs?: number;
  input?: string;
  signal?: AbortSignal;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
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
}
