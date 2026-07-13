import type { EffectiveConfig } from '../config/types.ts';
import type { ProjectContext } from '../context/types.ts';
import type { ScanEnv } from '../env/types.ts';
import type { ResolvedRuntimeConfiguration, RuntimePorts } from '../ports/types.ts';

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
  confirm(request: {
    readonly id: string;
    readonly message: string;
  }): Promise<InteractionResolution<boolean>>;
}

/** Capability-scoped composition context for application services migrated by G1-04. */
export interface ApplicationContext {
  readonly ports: RuntimePorts;
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
}

/**
 * Transitional Phase-1 composition context.
 *
 * G1-03 may use the existing ScanEnv aggregate only to migrate current behavior without creating a
 * second set of real adapters. G1-04 replaces service dependencies with capability-scoped ports;
 * ScanEnv remains a 1.x compatibility facade rather than the type for new application services.
 */
export interface CurrentApplicationContext {
  readonly env: ScanEnv;
  readonly interaction: InteractionPort;
  readonly invocationCwd: string;
  readonly envVars: Readonly<Record<string, string | undefined>>;
  readonly globalOptions: {
    readonly cd?: string;
    readonly config?: string;
  };
  readonly projectContext?: ProjectContext;
  readonly effectiveConfig?: EffectiveConfig;
  readonly signal?: AbortSignal;
}

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
