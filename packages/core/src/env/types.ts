export type Platform = 'darwin' | 'linux' | 'win32';

export interface XdgDirs {
  config: string;
  data: string;
  cache: string;
}

export interface ScanEnv {
  homeDir: string;
  path: readonly string[];
  platform: Platform;
  xdg: XdgDirs;
  fileExists(p: string): Promise<boolean>;
  realpath(p: string): Promise<string>;
  runVersion(
    binaryPath: string,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<string | 'unknown'>;
}
