import type { InstallRecord } from '../agents/types.ts';
import type { ScanEnv } from '../env/types.ts';
import type { SkillSmithError } from '../errors.ts';
import type { FlipTool, JournalPhase } from '../place/types.ts';
import type { Result } from '../result.ts';

export interface SourceSpec {
  raw: string; // the literal user argument, ref suffix included
  host: string; // 'github.com' for sugar; the host segment (may carry ':port') or URL/scp authority host
  repoPath: string; // UNCLAMPED '/'-joined repo path ('acme/platform/tools'); trailing '.git' stripped
  cloneUrl: string; // sugar/host-explicit: `https://<host>/<repoPath>.git`; URL/scp forms: verbatim minus `//path` and `@ref`
  selector:
    | { kind: 'whole-repo' }
    | { kind: 'name'; name: string }
    | { kind: 'path'; path: string }; // normalized: no leading/trailing '/', no empty/'.'/'..' segments
  ref: string | null; // the `@ref` as given; null = HEAD (remote default branch)
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
  envVars: Record<string, string | undefined>;
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
    env: ScanEnv,
    tool: FlipTool,
    signal?: AbortSignal,
  ) => Promise<Result<InstallRecord[], SkillSmithError>>; // injectable: tests fake detection
  now: () => string;
  newTxId: () => string; // 8-hex
  pick?: (candidates: readonly CandidateSkill[]) => Promise<CandidateSkill | null>;
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
  envVars: Record<string, string | undefined>;
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
  now: () => string;
  newTxId: () => string;
}
