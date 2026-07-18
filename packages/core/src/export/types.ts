import type { BuiltInToolId } from '../agents/registry.ts';
import type { ArtifactDigest } from '../artifacts/hash.ts';
import type {
  CanonicalSourceIdentity,
  ManifestPlacement,
  ManifestScope,
} from '../artifacts/types.ts';

export type ExportSourceScope = ManifestScope | 'system' | 'managed';

export type ExportSkipReason =
  | 'ambiguous'
  | 'dirty-git'
  | 'incomplete-provenance'
  | 'invalid-content'
  | 'invalid-path'
  | 'invalid-source'
  | 'live-content-mismatch'
  | 'non-git-dev'
  | 'pending-journal'
  | 'stale-ledger'
  | 'unmanaged'
  | 'unsupported-scope';

export interface PortableExportCandidate {
  readonly name: string;
  readonly tools: readonly BuiltInToolId[];
  readonly scope: ManifestScope;
  readonly source: CanonicalSourceIdentity;
  readonly sourceText: string;
  readonly requestedRef: string | null;
  readonly resolvedSha: string;
  readonly sourcePath: string;
  readonly contentHash: ArtifactDigest;
  readonly placement: ManifestPlacement;
  readonly path: string | null;
  readonly classification: 'portable-managed' | 'portable-dev';
}

export type ExportResult =
  | (PortableExportCandidate &
      Readonly<{
        readonly action: 'add' | 'merge' | 'refresh' | 'unchanged';
        readonly reason: null;
      }>)
  | Readonly<{
      readonly name: string;
      readonly tools: readonly BuiltInToolId[];
      readonly scope: ExportSourceScope;
      readonly classification: ExportSkipReason;
      readonly action: 'skipped';
      readonly reason: ExportSkipReason;
    }>
  | Readonly<{
      readonly name: string;
      readonly tools: readonly BuiltInToolId[];
      readonly scope: ExportSourceScope;
      readonly classification: 'conflict';
      readonly action: 'conflict';
      readonly reason:
        | 'custom-path-conflict'
        | 'duplicate-selected-placement'
        | 'existing-declaration-conflict'
        | 'selected-candidate-conflict';
    }>;

export interface ExportEffect {
  readonly role: 'ledger' | 'manifest' | 'lock';
  readonly action: 'create' | 'migrate' | 'update' | 'refresh' | 'unchanged' | 'not-written';
  readonly operationId: string | null;
  readonly outcome: 'planned' | 'succeeded' | 'failed' | 'cancelled' | 'not-run';
}

export interface ExportReport {
  readonly schemaVersion: 1;
  readonly kind: 'skillsmith.export';
  readonly reportVersion: 1;
  readonly dryRun: boolean;
  readonly requested: Readonly<{
    readonly tools: readonly BuiltInToolId[];
    readonly explicitTools: boolean;
    readonly scope: ExportSourceScope;
    readonly explicitScope: boolean;
    readonly strict: boolean;
    readonly force: boolean;
  }>;
  readonly artifactSelection:
    | Readonly<{
        readonly outcome: 'selected';
        readonly selectedBy: 'explicit-file' | 'project' | 'user';
        readonly manifestPath: string;
        readonly lockPath: string;
        readonly lockSource: 'sibling' | 'explicit';
      }>
    | Readonly<{
        readonly outcome: 'none';
        readonly reason: 'no-portable-candidates' | 'filter-noop';
      }>
    | Readonly<{ readonly outcome: 'refused'; readonly reason: string }>;
  readonly results: readonly ExportResult[];
  readonly effects: readonly ExportEffect[];
  readonly summary: Readonly<{
    readonly observed: number;
    readonly portable: number;
    readonly skipped: number;
    readonly conflicts: number;
    readonly changed: number;
    readonly unchanged: number;
  }>;
}

export interface ExportRequest {
  readonly tools: readonly BuiltInToolId[];
  readonly explicitTools: boolean;
  readonly scope: ExportSourceScope;
  readonly explicitScope: boolean;
  readonly file?: string;
  readonly lockfile?: string;
  readonly strict: boolean;
  readonly force: boolean;
  readonly dryRun: boolean;
}

export interface ExportFailure {
  readonly code: string;
  readonly message: string;
  readonly exitClass: 'failure' | 'usage' | 'state' | 'capability' | 'permission' | 'cancelled';
  readonly effects?: readonly ExportEffect[];
  readonly conflicts?: readonly ExportResult[];
}
