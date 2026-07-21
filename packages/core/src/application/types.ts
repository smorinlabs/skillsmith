import type { ArtifactCoordinatorPorts } from '../artifacts/coordinator-types.ts';
import type { EffectiveConfig } from '../config/types.ts';
import type { ProjectContext } from '../context/types.ts';
import type { SyncReportV1Dto } from '../contracts/v1/sync.ts';
import type { SkillSmithError } from '../errors.ts';
import type { ObservationBundle } from '../observation/index.ts';
import type { ResolvedRuntimeConfiguration, RuntimePorts } from '../ports/types.ts';
import type { Result } from '../result.ts';

/** Semantic exit classes. Numeric CLI exit codes remain presentation policy. */
export const COMMAND_EXIT_CLASSES = [
  'success',
  'failure',
  'usage',
  'state',
  'capability',
  'source',
  'permission',
  'drift',
  'cancelled',
] as const;

export type CommandExitClass = (typeof COMMAND_EXIT_CLASSES)[number];

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export type DiagnosticDetail = string | number | boolean | null;

/** Structured application diagnostic; renderers decide streams, color, and final wording. */
export interface Diagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly remediation?: string;
  readonly details?: Readonly<Record<string, DiagnosticDetail>>;
}

export interface MutationSummary {
  readonly kind: 'none' | 'preview' | 'applied';
  readonly planned: number;
  readonly changed: number;
  readonly unchanged: number;
  readonly failed: number;
}

export const NO_MUTATION: MutationSummary = Object.freeze({
  kind: 'none',
  planned: 0,
  changed: 0,
  unchanged: 0,
  failed: 0,
});

export interface Deprecation {
  readonly spelling: string;
  readonly replacement: string;
  readonly removalVersion: string;
  readonly message: string;
}

export interface CommandOutcome<TReport> {
  readonly report: TReport;
  readonly diagnostics: readonly Diagnostic[];
  readonly exitClass: CommandExitClass;
  readonly mutation: MutationSummary;
  readonly deprecations: readonly Deprecation[];
}

export interface InteractionChoice<TValue> {
  readonly value: TValue;
  readonly label: string;
  readonly hint?: string;
}

export interface InteractionRequest<TValue> {
  readonly id: string;
  readonly message: string;
  readonly choices: readonly InteractionChoice<TValue>[];
}

/** Exact immutable operation order presented before an apply confirmation. */
export interface ExactApprovalPreviewRequest {
  readonly kind: 'exact-operation-preview';
  readonly command: 'apply';
  readonly operationIds: readonly string[];
}

/** Exact immutable sync group and operation order presented before execution. */
export interface ExactSyncApprovalPreviewRequest {
  readonly kind: 'exact-sync-preview';
  readonly command: 'sync';
  readonly groupIds: readonly string[];
  readonly operationIds: readonly string[];
}

/** Structured confirmation facts; adapters own presentation and interactive defaults. */
export interface InteractionConfirmationRequest {
  readonly id: string;
  readonly message: string;
  readonly preview?: ExactApprovalPreviewRequest | ExactSyncApprovalPreviewRequest;
}

/** Parser-normalized sync request; endpoint resolution and I/O remain behind SyncApplicationPort. */
export interface SyncApplicationRequest {
  readonly from: string;
  readonly to: string;
  readonly skills: readonly string[];
  readonly tools: readonly string[];
  readonly force: boolean;
  readonly delete: boolean;
  readonly save: boolean;
  readonly file: string | null;
  readonly lockfile: string | null;
  readonly dryRun: boolean;
  readonly yes: boolean;
  readonly continueOnError: boolean;
}

/** Opaque preparation token. The application only reads immutable approval/report facts. */
export interface PreparedSyncApplication {
  readonly report: SyncReportV1Dto;
}

/** Narrow adapter seam for the concurrently implemented sync domain. */
export interface SyncApplicationPort {
  prepare(
    request: Readonly<SyncApplicationRequest>,
    context: CurrentApplicationContext,
  ): Promise<Result<PreparedSyncApplication, SkillSmithError>>;
  execute(
    prepared: PreparedSyncApplication,
    context: CurrentApplicationContext,
  ): Promise<Result<SyncReportV1Dto, SkillSmithError>>;
}

export type InteractionResolution<TValue> =
  | { readonly status: 'resolved'; readonly value: TValue }
  | { readonly status: 'refused'; readonly reason: string }
  | { readonly status: 'cancelled' };

/**
 * User choice and confirmation stay outside domain code. The CLI supplies a port whose behavior
 * already reflects TTY, JSON, --yes, --no-prompt, and noninteractive policy.
 */
export interface InteractionPort {
  readonly mode: 'interactive' | 'noninteractive';
  choose<TValue>(request: InteractionRequest<TValue>): Promise<InteractionResolution<TValue>>;
  confirm(request: InteractionConfirmationRequest): Promise<InteractionResolution<boolean>>;
}

/** Capability-scoped composition context for application services migrated by G1-04. */
export interface ApplicationContext {
  readonly observation: ObservationBundle;
  readonly ports: RuntimePorts;
  readonly artifactCoordinator: ArtifactCoordinatorPorts;
  readonly configuration: ResolvedRuntimeConfiguration;
  readonly interaction: InteractionPort;
  readonly invocationCwd: string;
  readonly globalOptions: {
    readonly cd?: string;
    readonly config?: string;
  };
  readonly projectContext?: ProjectContext;
  readonly effectiveConfig?: EffectiveConfig;
  readonly signal?: AbortSignal;
  /** Additive composition seam; only the sync application reads it. */
  readonly sync?: SyncApplicationPort;
}

/** @deprecated Transitional name retained for the 1.x application-service registry. */
export type CurrentApplicationContext = ApplicationContext;

/** Parser-normalized request shared by the declarative CLI adapter and current services. */
export interface CurrentCommandRequest {
  readonly arguments: readonly unknown[];
  readonly options: Readonly<Record<string, unknown>>;
}

export type ApplicationService<
  TRequest,
  TReport,
  TContext extends CurrentApplicationContext = CurrentApplicationContext,
> = (request: Readonly<TRequest>, context: TContext) => Promise<CommandOutcome<TReport>>;
