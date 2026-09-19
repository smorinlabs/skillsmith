import type { BuiltInToolId } from '../agents/registry.ts';
import type { ArtifactDigest } from '../artifacts/hash.ts';
import type { NormalizedManifestDeclaration } from '../artifacts/types.ts';

export type UpdateMode = 'check' | 'dry-run' | 'execute';
export type UpdateSelectionSource = 'bounded-default' | 'explicit-all' | 'explicit-targets';
export type UpdateRefKind = 'default' | 'branch' | 'tag' | 'sha';
export type UpdateTransition = 'preserve' | 'track' | 'pin';
export type UpdateCandidateOutcome = 'current' | 'available' | 'skipped-fixed' | 'failed';

export interface UpdateApplicationRequestV1 {
  readonly targets: readonly string[];
  readonly all: boolean;
  readonly file: string | null;
  readonly lockfile: string | null;
  readonly tools: readonly string[];
  readonly check: boolean;
  readonly dryRun: boolean;
  readonly ref: string | null;
  readonly pin: boolean;
  readonly strict: boolean;
  readonly yes: boolean;
  readonly continueOnError: boolean;
}

export interface UpdateSelectedDeclarationV1 {
  readonly declaration: NormalizedManifestDeclaration;
  readonly tools: readonly BuiltInToolId[];
}

export interface UpdateSelectionV1 {
  readonly selectionSource: UpdateSelectionSource;
  readonly requestedTargets: readonly string[];
  readonly requestedTools: readonly string[];
  readonly selectedNames: readonly string[];
  readonly unmatchedTargets: readonly string[];
  readonly filteredNames: readonly string[];
  readonly declarations: readonly UpdateSelectedDeclarationV1[];
}

export interface UpdateRemoteRefInspectionV1 {
  readonly kind: UpdateRefKind;
  readonly requestedRef: string | null;
  readonly resolvedSha: string;
}

export interface UpdateCandidateV1 {
  readonly name: string;
  readonly tools: readonly BuiltInToolId[];
  readonly currentRequestedRef: string | null;
  readonly currentResolvedSha: string;
  readonly requestedRef: string | null;
  readonly refKind: UpdateRefKind;
  readonly resolvedSha: string;
  readonly proposedRequestedRef: string | null;
  readonly contentHash: ArtifactDigest | null;
  readonly transition: UpdateTransition;
  readonly outcome: UpdateCandidateOutcome;
  readonly reason: string | null;
}
