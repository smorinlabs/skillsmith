import type { InstallRecord } from '../agents/types.ts';
import type { CanonicalSourceIdentity } from '../artifacts/types.ts';
import type { SkillSmithError } from '../errors.ts';
import type { FlipTool, JournalPhase } from '../place/types.ts';
import type {
  ClockPort,
  DetectionPorts,
  FileReadPort,
  FileWritePort,
  GitPort,
  IdPort,
  LockPort,
  PlatformPaths,
  ProcessPort,
  ResolvedRuntimeConfiguration,
} from '../ports/types.ts';
import type { Result } from '../result.ts';

export type AcquisitionPorts = PlatformPaths &
  FileReadPort &
  FileWritePort &
  LockPort &
  ProcessPort &
  ClockPort &
  IdPort & { readonly git: GitPort };

export interface SourceSpec {
  readonly identity: CanonicalSourceIdentity;
  readonly canonicalSource: string;
  readonly canonicalInvocation: string;
  readonly originSource: string;
  readonly cloneUrl: string;
  readonly selector:
    | { readonly kind: 'whole-repo' }
    | { readonly kind: 'name'; readonly name: string }
    | { readonly kind: 'path'; readonly path: string };
  readonly ref: string | null;
}

export interface CandidateSkill {
  path: string; // repo-relative git tree path of the skill dir; '' = repo root
  name: string; // basename(path); for path '' the caller substitutes the repo's final segment
}

export type Selection =
  | { kind: 'chosen'; skill: CandidateSkill }
  | { kind: 'ambiguous'; candidates: CandidateSkill[] } // caller: exit-2 refusal + JSON candidates
  | { kind: 'none'; searched: number }; // caller: exit-5 source-unresolvable

export type InstallScope = 'user' | 'project';
export type InstallAction =
  | 'installed'
  | 'updated'
  | 'repaired'
  | 'noop'
  | 'skipped'
  | 'refused'
  | 'failed';

export interface InstallOptions {
  sources: readonly string[];
  tools?: readonly FlipTool[]; // explicit --tool list; undefined = all DETECTED tools
  scope?: InstallScope; // undefined = project inside a git work tree, else user
  ref?: string; // --ref; only valid with exactly one source
  pin?: boolean;
  direct?: boolean;
  force?: boolean;
  strict?: boolean;
  noVerify?: boolean;
  deep?: boolean; // CLI guarantees deep && noVerify never reach core
  continueOnError?: boolean;
  dryRun?: boolean;
  cwd: string;
  configuration: ResolvedRuntimeConfiguration;
  testPauseAt?: JournalPhase; // wired only by the CLI under SKILLSMITH_E2E=1
  signal?: AbortSignal;
}

export interface InstallResult {
  source: string; // the literal argument this result belongs to
  skill: string | null; // null for source-level failures (resolution 4)
  tool: FlipTool | null; // null for source-level failures
  scope: InstallScope;
  placementPath: string | null;
  action: InstallAction;
  reason: string | null; // human cause for skipped/refused/failed; notices otherwise
  placement: 'symlink' | 'copy' | null;
  store: { path: string; rev: string; gitSha: string; reused: boolean } | null;
  origin: {
    host: string;
    repo: string;
    skillPath: string;
    refRequested: string | null;
    refResolved: string;
    pin: boolean;
  } | null;
  verify: {
    gate: 'passed' | 'warned' | 'failed' | 'skipped' | 'inconclusive';
    verdict: 'pass' | 'warn' | 'fail' | 'inconclusive' | null;
    mode: 'static' | 'static+deep' | null;
  } | null; // mode actually run for THIS tool
  candidates: string[] | null; // `<repoPath>//<path>` re-run lines on R2/R3 ambiguity
  error?: SkillSmithError; // CORE-ONLY: drives the CLI exit code; NOT rendered in JSON
  readonly requestIndex?: number; // CORE-ONLY: duplicate-safe human grouping; omitted from public v1
}

export interface InstallReport {
  dryRun: boolean;
  requested: {
    sources: string[];
    tools: FlipTool[];
    explicitTools: boolean;
    scope: InstallScope;
    explicitScope: boolean;
    ref: string | null;
    pin: boolean;
    direct: boolean;
    force: boolean;
    verify: 'static' | 'skipped';
    deep: boolean;
  };
  results: InstallResult[];
  summary: {
    installed: number;
    updated: number;
    repaired: number;
    noop: number;
    skipped: number;
    refused: number;
    failed: number;
  };
}

export interface InstallDeps {
  verify: typeof import('../verify/run.ts').verifyPlugin;
  detect: (
    env: DetectionPorts,
    tool: FlipTool,
    signal?: AbortSignal,
  ) => Promise<Result<InstallRecord[], SkillSmithError>>; // injectable: tests fake detection
  now?: () => string;
  newTxId?: () => string; // 8-hex
  pick?: (candidates: readonly CandidateSkill[]) => Promise<CandidateSkill | null>;
  readonly transport?: InstallSourceTransport;
}

export interface InstallSourceTransport {
  readonly resolveRef: typeof import('./fetch.ts').resolveRefViaLsRemote;
  readonly fetchRepo: typeof import('./fetch.ts').fetchRepo;
  readonly listSkills: typeof import('./fetch.ts').lsTreeSkills;
  readonly materializeSkill: typeof import('./fetch.ts').sparseCheckoutSkill;
}

export type UninstallAction = 'removed' | 'noop' | 'refused' | 'failed';

export interface UninstallOptions {
  targets: readonly string[]; // skill names (leaf dir names) or placement paths
  tools?: readonly FlipTool[]; // restrict; undefined = every tool where the skill is found
  scope?: InstallScope; // restrict to one scope
  allScopes?: boolean; // user scope AND the current project's scope
  force?: boolean;
  dryRun?: boolean;
  cwd: string;
  configuration: ResolvedRuntimeConfiguration;
  testPauseAt?: JournalPhase;
  signal?: AbortSignal;
}

export interface UninstallResult {
  skill: string;
  tool: FlipTool | null; // null only when a target matched nothing anywhere
  scope: InstallScope | null;
  placementPath: string | null;
  action: UninstallAction;
  reason: string | null;
  before: {
    mode: 'dev' | 'pinned';
    placement: 'symlink' | 'copy' | null;
    storePath: string | null;
    symlinkTarget: string | null;
  } | null;
  storeRetained: string | null; // surviving store path — "where did my bytes go"
  backupKept: string | null; // path of a preserved unreproducible copy
  error?: SkillSmithError; // CORE-ONLY, as install
}

export interface UninstallReport {
  dryRun: boolean;
  requested: {
    targets: string[];
    tools: FlipTool[];
    explicitTools: boolean;
    scope: InstallScope | null;
    allScopes: boolean;
    force: boolean;
  };
  results: UninstallResult[];
  summary: { removed: number; noop: number; refused: number; failed: number };
}

export interface UninstallDeps {
  now?: () => string;
  newTxId?: () => string;
}
