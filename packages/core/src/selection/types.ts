import type { SupportedTool } from '../agents/types.ts';
import type { Scope } from '../config/types.ts';

export const SELECTION_CAPABILITIES = [
  'read',
  'install',
  'uninstall',
  'dev',
  'promote',
  'undo',
] as const;

export type SelectionCapability = (typeof SELECTION_CAPABILITIES)[number];
export type SelectionSource = 'explicit-targets' | 'explicit-all' | 'bounded-default';
export type SelectionOutcome = 'selected' | 'filter-noop';

/** Raw parser-independent selection input. Validation narrows every string enum before use. */
export interface SelectionRequest {
  readonly targets: readonly string[];
  readonly all: boolean;
  readonly tools?: readonly string[];
  readonly scopes?: readonly string[];
  readonly capability?: string;
}

/** Command policy. Known values outside these sets are capability errors, not invalid enums. */
export interface SelectionPolicy<ToolId extends string = SupportedTool> {
  readonly requiresSelection: boolean;
  readonly allowBoundedDefault: boolean;
  readonly allowAbsentCreate: boolean;
  readonly allowedTools: readonly ToolId[];
  readonly allowedScopes: readonly Scope[];
  readonly allowedCapabilities: readonly SelectionCapability[];
}

export interface ValidatedSelectionRequest<ToolId extends string = SupportedTool> {
  readonly targets: readonly string[];
  readonly all: boolean;
  readonly tools: readonly ToolId[];
  readonly scopes: readonly Scope[];
  readonly capability?: SelectionCapability;
  /** Carried from policy so resolution cannot accidentally widen absent candidates. */
  readonly allowAbsentCreate: boolean;
  readonly selectionSource: SelectionSource;
}

/** Minimal structural contract shared by placement, history, and later artifact selectors. */
export interface SelectionCandidate<ToolId extends string = SupportedTool> {
  readonly name: string;
  readonly tool: ToolId;
  readonly scope: Scope;
  readonly path: string;
  readonly capabilities: readonly SelectionCapability[];
  /** Missing means an existing target, preserving compatibility with current candidate DTOs. */
  readonly exists?: boolean;
}

export interface TargetSelection<C extends SelectionCandidate<string> = SelectionCandidate> {
  readonly selected: readonly C[];
  readonly selectionSource: SelectionSource;
  readonly outcome: SelectionOutcome;
  readonly reason?: string;
}

export interface SelectionUsageError {
  readonly code: 'usage';
  readonly exitCode: 2;
  readonly message: string;
}

export interface SelectionInvalidEnumError {
  readonly code: 'invalid-enum';
  readonly exitCode: 2;
  readonly field: 'tool' | 'scope' | 'capability';
  readonly value: string;
  readonly message: string;
}

export interface SelectionCapabilityError {
  readonly code: 'capability';
  readonly exitCode: 4;
  readonly field: 'tool' | 'scope' | 'capability';
  readonly value: string;
  readonly message: string;
}

export interface SelectionUnmatchedError {
  readonly code: 'unmatched';
  readonly exitCode: 2;
  readonly targets: readonly string[];
  readonly message: string;
}

export interface SelectionAmbiguousError<
  C extends SelectionCandidate<string> = SelectionCandidate,
> {
  readonly code: 'ambiguous';
  readonly exitCode: 2;
  readonly target: string;
  readonly targets: readonly string[];
  readonly candidates: readonly C[];
  readonly message: string;
}

export type SelectionValidationError =
  | SelectionUsageError
  | SelectionInvalidEnumError
  | SelectionCapabilityError;

export type TargetSelectionError<C extends SelectionCandidate<string> = SelectionCandidate> =
  | SelectionUnmatchedError
  | SelectionAmbiguousError<C>;
