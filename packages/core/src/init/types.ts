import type { BuiltInToolId } from '../agents/registry.ts';
import type { ArtifactDigest } from '../artifacts/hash.ts';
import type { InitManifestOperationInput, InitManifestSkeletonInput } from '../artifacts/init.ts';
import type { ManifestScope, ManifestShape } from '../artifacts/types.ts';
import type { BoundedForceEffect, OperationId, OperationPlan } from '../planning/types.ts';

export type InitToolSource = 'explicit' | 'config' | 'detected' | 'none';
export type InitSelectedBy = 'explicit-file' | 'project' | 'user';

export interface InitRequest {
  readonly tools: readonly BuiltInToolId[];
  readonly explicitTools: boolean;
  readonly toolSource: InitToolSource;
  readonly scope: ManifestScope | null;
  readonly explicitScope: boolean;
  readonly file: string | null;
  readonly force: boolean;
}

export interface InitDefaults {
  readonly tools: readonly BuiltInToolId[] | null;
  readonly scope: ManifestScope | null;
  readonly path: string | null;
  readonly registryDefault: string | null;
}

export interface InitArtifactSelection {
  readonly outcome: 'selected';
  readonly selectedBy: InitSelectedBy;
  readonly manifestPath: string;
  readonly lockPath: string;
  readonly lockSource: 'sibling';
}

export type InitResultBefore =
  | Readonly<{ state: 'absent'; shape: null; byteHash: null; semanticHash: null }>
  | Readonly<{
      state: 'present';
      shape: Exclude<ManifestShape, 'future'>;
      byteHash: ArtifactDigest;
      semanticHash: ArtifactDigest | null;
    }>;

export interface InitResultAfter {
  readonly state: 'canonical';
  readonly byteHash: ArtifactDigest;
  readonly semanticHash: ArtifactDigest;
}

export type InitResult =
  | Readonly<{
      action: 'create-manifest' | 'replace-manifest' | 'migrate-project-config';
      operationId: OperationId;
      before: InitResultBefore;
      after: InitResultAfter;
    }>
  | Readonly<{
      action: 'noop';
      operationId: null;
      before: Extract<InitResultBefore, { state: 'present' }>;
      after: null;
    }>;

export interface InitEffect {
  readonly role: 'manifest' | 'lock' | 'live' | 'ledger';
  readonly action: 'create' | 'replace' | 'migrate' | 'unchanged' | 'not-written';
  readonly operationId: OperationId | null;
  readonly outcome: 'planned' | 'succeeded' | 'not-run';
}

export interface InitReport {
  readonly schemaVersion: 1;
  readonly kind: 'skillsmith.init';
  readonly reportVersion: 1;
  readonly dryRun: boolean;
  readonly requested: InitRequest;
  readonly defaults: InitDefaults;
  readonly artifactSelection: InitArtifactSelection;
  readonly result: InitResult;
  readonly force: BoundedForceEffect;
  readonly effects: readonly [InitEffect, InitEffect, InitEffect, InitEffect];
  readonly summary: Readonly<{ changed: 0 | 1; unchanged: 0 | 1 }>;
}

export interface InitFailure {
  readonly code: string;
  readonly message: string;
  readonly exitClass: 'failure' | 'usage' | 'state' | 'capability' | 'permission' | 'cancelled';
}

export type InitObservedManifest =
  | Readonly<{ state: 'absent' }>
  | Readonly<{
      state: 'file';
      bytes: Uint8Array;
      resourceDigest: ArtifactDigest;
      mode: number;
    }>;

export interface PreparedInitPlan {
  readonly request: InitRequest;
  readonly dryRun: boolean;
  readonly defaults: InitDefaults;
  readonly selection: InitArtifactSelection;
  readonly skeleton: InitManifestSkeletonInput;
  readonly classification: InitManifestOperationInput;
  readonly observed: InitObservedManifest;
  readonly plan: OperationPlan<'init'>;
  readonly result: InitResult;
}
