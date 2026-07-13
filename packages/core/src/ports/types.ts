import type { Config } from '../config/types.ts';
import type { ExecOptions, ExecResult, PathKind, Platform, XdgDirs } from '../env/types.ts';
import type { JournalPhase } from '../place/types.ts';

export interface PlatformPaths {
  readonly homeDir: string;
  readonly executableSearchPath: readonly string[];
  readonly platform: Platform;
  readonly xdg: Readonly<XdgDirs>;
  /** Optional hermetic override; production defaults to /etc/skillsmith/config.toml. */
  readonly systemConfigPath?: string;
}

export interface FileMetadata {
  /** `other` covers FIFOs, sockets, block/character devices, and unknown special nodes. */
  readonly kind: PathKind | 'other';
  /** Permission bits only (setuid/setgid/sticky plus rwx), never the file-type bits. */
  readonly mode: number | null;
  /** Stable identity for change detection; null when the path is absent. */
  readonly identity: string | null;
}

/** Focused metadata capability used only by lossless editors and transaction planners. */
export interface FileMetadataReadPort {
  readFileMetadata(path: string): Promise<FileMetadata>;
}

/** Focused permission capability used only when staging a replacement file. */
export interface FileModeWritePort {
  setFileMode(path: string, mode: number): Promise<void>;
}

export interface FileReadPort {
  fileExists(path: string): Promise<boolean>;
  pathKind(path: string): Promise<PathKind>;
  realpath(path: string): Promise<string>;
  listDir(path: string): Promise<readonly string[]>;
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  readLink(path: string): Promise<string>;
  isExecutable(path: string): Promise<boolean>;
  modifiedAt(path: string): Promise<number | null>;
}

export interface FileWritePort {
  makeDir(path: string): Promise<void>;
  writeTextFile(path: string, text: string): Promise<void>;
  makeSymlink(target: string, linkPath: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  copyTree(from: string, to: string): Promise<void>;
  removeTree(path: string): Promise<void>;
  fsyncFile(path: string): Promise<void>;
  fsyncDir(path: string): Promise<void>;
}

export interface LockPort {
  withFileLock<T>(path: string, operation: () => Promise<T>): Promise<T>;
}

export interface PathAccessPort {
  assertWritableDirectory(path: string): Promise<void>;
}

export interface ProcessPort {
  exec(command: string, args: readonly string[], options?: ExecOptions): Promise<ExecResult>;
  runVersion(
    binaryPath: string,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<string | 'unknown'>;
}

export interface GitRequest {
  readonly repositoryRoot: string;
  readonly signal?: AbortSignal;
}

export interface GitFindRepositoryRootRequest {
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export interface GitWorktreeInspection {
  readonly repositoryRoot: string;
  readonly headSha: string;
  readonly remoteUrl: string | null;
  readonly dirtySummary: string | null;
}

export interface GitResolveRemoteRefRequest {
  readonly remoteUrl: string;
  readonly ref: string | null;
  readonly signal?: AbortSignal;
}

export interface GitInitializeFetchRequest extends GitRequest {
  readonly remoteUrl: string;
}

export interface GitFetchRefRequest extends GitRequest {
  readonly ref: string | null;
}

export interface GitFetchRefResult {
  readonly sha: string;
}

export interface GitTreeRequest extends GitRequest {
  readonly ref: string;
}

export interface GitTreeEntry {
  readonly path: string;
  readonly kind: 'blob' | 'tree';
}

export interface GitBlobRequest extends GitRequest {
  readonly ref: string;
  readonly path: string;
}

export interface GitMaterializeTreeRequest extends GitTreeRequest {
  readonly path: string;
}

export interface GitPort {
  findRepositoryRoot(request: GitFindRepositoryRootRequest): Promise<string | null>;
  inspectWorktree(request: GitRequest): Promise<GitWorktreeInspection>;
  resolveRemoteRef(request: GitResolveRemoteRefRequest): Promise<string | null>;
  initializeFetch(request: GitInitializeFetchRequest): Promise<void>;
  fetchRef(request: GitFetchRefRequest): Promise<GitFetchRefResult>;
  listTree(request: GitTreeRequest): Promise<readonly GitTreeEntry[]>;
  readBlob(request: GitBlobRequest): Promise<Uint8Array>;
  materializeTree(request: GitMaterializeTreeRequest): Promise<string>;
}

export interface HttpRequest {
  readonly url: string;
  readonly method: 'HEAD';
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface HttpResponse {
  readonly status: number;
  readonly ok: boolean;
}

export interface HttpPort {
  request(request: HttpRequest): Promise<HttpResponse>;
}

export interface ClockPort {
  wallNowIso(): string;
  epochMilliseconds(): number;
  monotonicMilliseconds(): number;
}

export interface IdPort {
  nextId(purpose: string): string;
}

export interface RuntimePorts
  extends PlatformPaths,
    FileReadPort,
    FileWritePort,
    FileMetadataReadPort,
    FileModeWritePort,
    LockPort,
    PathAccessPort,
    ProcessPort,
    ClockPort,
    IdPort {
  readonly git: GitPort;
  readonly http: HttpPort;
}

export interface ResolvedRuntimeConfiguration {
  readonly configLayer: Readonly<Config>;
  readonly explicitConfigPath: string | undefined;
  readonly skillsmithHome: string | undefined;
  readonly claudeConfigDir: string | undefined;
  readonly claudePolicySkillsDisabled: boolean;
  readonly claudeManagedSettingsPath: string | undefined;
  readonly codexHome: string | undefined;
  readonly kiloExternalSkillsDisabled: boolean;
  readonly opencodeConfigDir: string | undefined;
  readonly opencodeClaudeSkillsDisabled: boolean;
  readonly forceColor: boolean;
  readonly noColor: boolean;
  readonly journalPause: JournalPhase | undefined;
}

export type InventoryReadPorts = PlatformPaths & FileReadPort;
export type DetectionPorts = InventoryReadPorts & Pick<ProcessPort, 'runVersion'>;
export type GitReadPorts = InventoryReadPorts & { readonly git: GitPort };
