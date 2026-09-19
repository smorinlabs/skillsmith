import type { InstallRecord } from '../agents/types.ts';
import type { ArtifactCoordinatorPorts } from '../artifacts/coordinator-types.ts';
import type { CanonicalSourceIdentity } from '../artifacts/types.ts';
import type { SkillSmithError } from '../errors.ts';
import type { FlipTool, JournalPhase, PlacementPorts } from '../place/types.ts';
import type { InstallAction, UninstallAction } from '../planning/legacy-action.ts';
import type {
  BoundedForceEffect,
  OperationExecutionResult,
  OperationPlan,
} from '../planning/types.ts';
import type { OperationExecutionOutcome } from '../planning/vocabulary.ts';
import type { DetectionPorts, ResolvedRuntimeConfiguration } from '../ports/types.ts';
import type { Result } from '../result.ts';

export type { InstallAction, UninstallAction } from '../planning/legacy-action.ts';

export type AcquisitionPorts = PlacementPorts;

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

export type AcquisitionSaveMode = 'desired-state' | 'live-only';

export interface AcquisitionArtifactPair {
  readonly manifestPath: string;
  readonly lockPath: string;
  readonly lockSource: 'sibling' | 'explicit';
}

export type AcquisitionArtifactSelection =
  | Readonly<{
      outcome: 'selected';
      selectedBy:
        | 'explicit-file'
        | 'selected-project-owner'
        | 'project-root-owner'
        | 'user-owner'
        | 'new-project'
        | 'new-user'
        | 'legacy-project-migration';
    }>
  | Readonly<{
      outcome: 'none';
      reason: 'no-save' | 'no-owner' | 'pre-resolution-failure';
    }>
  | Readonly<{
      outcome: 'refused';
      reason: 'ambiguous-owner' | 'split-owner' | 'invalid-candidate' | 'nonportable-path';
      candidates: string[];
    }>;

export interface AcquisitionArtifactEffect {
  readonly groupId: string | null;
  readonly skill: string | null;
  readonly manifestAction:
    | 'create'
    | 'update'
    | 'remove-declaration'
    | 'retain'
    | 'keep'
    | 'not-write';
  readonly lockAction: 'create' | 'update' | 'remove-entry' | 'retain' | 'keep' | 'not-write';
  readonly migration: 'none' | 'planned' | 'applied' | 'failed' | 'rolled-back';
  readonly outcome: OperationExecutionOutcome | 'planned' | 'not-run';
  readonly reason: string | null;
}

export interface AcquisitionDrift {
  readonly status: 'in-sync' | 'desired-without-live' | 'live-without-desired' | 'not-evaluated';
  readonly futureApply:
    | 'none'
    | 'restore-live'
    | 'replace-live'
    | 'prune-may-remove-live'
    | 'depends-on-selected-manifest';
  readonly reason: string | null;
}

export interface AcquisitionDesiredStateSummary {
  readonly changed: number;
  readonly unchanged: number;
  readonly retained: number;
  readonly notWritten: number;
  readonly failed: number;
}

interface CurrentAcquisitionPlacementFacts {
  readonly requestIndex: number;
  readonly groupId: string | null;
  readonly pairId: string | null;
  readonly executionOutcome: OperationExecutionOutcome | null;
  readonly drift: AcquisitionDrift;
  readonly force: BoundedForceEffect<FlipTool>;
}

interface CurrentAcquisitionReportFacts {
  readonly reportVersion: 2;
  readonly saveMode: AcquisitionSaveMode;
  readonly artifactPair: AcquisitionArtifactPair | null;
  readonly artifactSelection: AcquisitionArtifactSelection;
  readonly artifactEffects: AcquisitionArtifactEffect[];
}

export interface InstallOptions {
  sources: readonly string[];
  tools?: readonly FlipTool[]; // explicit --tool list; undefined = all DETECTED tools
  scope?: InstallScope; // undefined = project inside a git work tree, else user
  ref?: string; // --ref; only valid with exactly one source
  file?: string;
  lockfile?: string;
  noSave?: boolean;
  path?: string;
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
  readonly reportVersion?: 1;
  readonly dryRun: boolean;
  readonly requested: {
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
  readonly results: InstallResult[];
  readonly summary: {
    installed: number;
    updated: number;
    repaired: number;
    noop: number;
    skipped: number;
    refused: number;
    failed: number;
  };
}

export type CurrentInstallResult = Omit<InstallResult, 'requestIndex'> &
  CurrentAcquisitionPlacementFacts;

export type CurrentInstallReport = Omit<
  InstallReport,
  'reportVersion' | 'requested' | 'results' | 'summary'
> &
  CurrentAcquisitionReportFacts &
  Readonly<{
    requested: InstallReport['requested'] &
      Readonly<{
        batchPolicy: 'fail-fast' | 'continue-on-error';
        path: string | null;
      }>;
    results: CurrentInstallResult[];
    summary: InstallReport['summary'] & Readonly<{ desiredState: AcquisitionDesiredStateSummary }>;
  }>;

export interface PlannedInstallReport extends CurrentInstallReport {
  readonly plan: OperationPlan<'install'>;
  readonly executionResults: readonly OperationExecutionResult[];
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
  /** Source-internal execution authority supplied by application composition. */
  readonly artifactCoordinator?: ArtifactCoordinatorPorts;
  readonly transport?: InstallSourceTransport;
  /** Test/embedding observation seam; called after exact bindings exist and before any binding runs. */
  readonly observePreparedPlan?: (plan: OperationPlan<'install'>) => void;
}

export interface InstallSourceTransport {
  readonly resolveRef: typeof import('./fetch.ts').resolveRefViaLsRemote;
  readonly fetchRepo: typeof import('./fetch.ts').fetchRepo;
  readonly listSkills: typeof import('./fetch.ts').lsTreeSkills;
  readonly materializeSkill: typeof import('./fetch.ts').sparseCheckoutSkill;
}

export interface UninstallOptions {
  targets: readonly string[]; // skill names (leaf dir names) or placement paths
  tools?: readonly FlipTool[]; // restrict; undefined = every tool where the skill is found
  scope?: InstallScope; // restrict to one scope
  allScopes?: boolean; // user scope AND the current project's scope
  file?: string;
  lockfile?: string;
  noSave?: boolean;
  continueOnError?: boolean;
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
  readonly reportVersion?: 1;
  readonly dryRun: boolean;
  readonly requested: {
    targets: string[];
    tools: FlipTool[];
    explicitTools: boolean;
    scope: InstallScope | null;
    allScopes: boolean;
    force: boolean;
  };
  readonly results: UninstallResult[];
  readonly summary: { removed: number; noop: number; refused: number; failed: number };
}

export type CurrentUninstallAction = UninstallAction | 'skipped';

export type CurrentUninstallResult = Omit<UninstallResult, 'action'> &
  CurrentAcquisitionPlacementFacts &
  Readonly<{ action: CurrentUninstallAction }>;

export type CurrentUninstallReport = Omit<
  UninstallReport,
  'reportVersion' | 'requested' | 'results' | 'summary'
> &
  CurrentAcquisitionReportFacts &
  Readonly<{
    requested: UninstallReport['requested'] &
      Readonly<{ batchPolicy: 'fail-fast' | 'continue-on-error' }>;
    results: CurrentUninstallResult[];
    summary: UninstallReport['summary'] &
      Readonly<{ desiredState: AcquisitionDesiredStateSummary }>;
  }>;

export interface PlannedUninstallReport extends CurrentUninstallReport {
  readonly plan: OperationPlan<'uninstall'>;
  readonly executionResults: readonly OperationExecutionResult[];
}

export interface UninstallDeps {
  now?: () => string;
  newTxId?: () => string;
  /** Source-internal execution authority supplied by application composition. */
  readonly artifactCoordinator?: ArtifactCoordinatorPorts;
  /** Test/embedding observation seam; called after exact bindings exist and before any binding runs. */
  readonly observePreparedPlan?: (plan: OperationPlan<'uninstall'>) => void;
}
