import type { ExecutableOperationKind } from '../planning/vocabulary.ts';
import type { ArtifactDigest } from './hash.ts';

export type PlanIdV1 = string;
export type PlanCodeV1 = string;
export type PlanDigestV1 = ArtifactDigest;
export type PlanToolV1 = 'claude-code' | 'codex' | 'kilo-code' | 'opencode';
export type PlanScopeV1 = 'user' | 'project';
export type PlanSelectionSourceV1 = 'explicit-targets' | 'explicit-all' | 'bounded-default';

export type PlanLocationV1 =
  | { kind: 'portable'; token: string }
  | { kind: 'machine-bound'; path: string };

export type PlanSourceV1 =
  | {
      kind: 'portable';
      identity: { host: string; repository: string; path: string | null };
      requestedRef: string | null;
      resolvedSha: string;
      sourcePath: string;
      contentHash: PlanDigestV1;
    }
  | { kind: 'local-dev'; path: string; contentHash: PlanDigestV1 };

export interface ManifestSnapshotV1 {
  version: 1;
  defaults: null | {
    tools: PlanToolV1[] | null;
    scope: PlanScopeV1 | null;
    path: string | null;
  };
  registry: null | { default: string | null };
  skills: {
    name: string;
    source: { host: string; repository: string; path: string | null };
    ref: string | null;
    tools: PlanToolV1[];
    scope: PlanScopeV1;
    placement: 'symlink' | 'copy';
    path: string | null;
  }[];
}

export interface LockSnapshotV1 {
  version: 1;
  hashSchemaVersion: 1;
  manifestHash: PlanDigestV1;
  skills: {
    name: string;
    source: string;
    requestedRef: string | null;
    resolvedSha: string;
    sourcePath: string;
    contentHash: PlanDigestV1;
  }[];
}

export type ResourceIdentityV1 =
  | { kind: 'manifest-bytes'; location: PlanLocationV1 }
  | { kind: 'lock'; location: PlanLocationV1 }
  | { kind: 'ledger'; projectRoot: PlanLocationV1 | null }
  | { kind: 'ledger-schema'; projectRoot: PlanLocationV1 | null }
  | {
      kind: 'live';
      skill: string;
      tool: PlanToolV1;
      scope: PlanScopeV1;
      projectRoot: PlanLocationV1 | null;
      location: PlanLocationV1;
    }
  | { kind: 'store'; contentHash: PlanDigestV1 }
  | { kind: 'project-context'; root: PlanLocationV1 };

export type PlanImageV1 =
  | { kind: 'absent'; resource: ResourceIdentityV1 }
  | {
      kind: 'placement';
      resource: Extract<ResourceIdentityV1, { kind: 'live' }>;
      classification: 'dev' | 'pinned' | 'store-linked' | 'unmanaged';
      representation: 'symlink' | 'copy' | 'other';
      linkTarget: PlanLocationV1 | null;
      dangling: boolean;
      source: PlanSourceV1 | null;
      contentHash: PlanDigestV1 | null;
    }
  | {
      kind: 'manifest';
      location: PlanLocationV1;
      shape: 'canonical' | 'legacy';
      version: 1;
      byteHash: PlanDigestV1;
      semanticHash: PlanDigestV1;
      value: ManifestSnapshotV1;
    }
  | {
      kind: 'lock';
      location: PlanLocationV1;
      version: 1;
      canonicalHash: PlanDigestV1;
      value: LockSnapshotV1;
    }
  | {
      kind: 'ledger';
      projectRoot: PlanLocationV1 | null;
      schemaVersion: 1 | 2;
      byteHash: PlanDigestV1;
      semanticHash: PlanDigestV1;
    };

export interface HashFactV1 {
  domain:
    | 'manifest-semantic'
    | 'manifest-bytes'
    | 'lock-canonical'
    | 'source-content'
    | 'resource'
    | 'selection-set'
    | 'capability';
  hashSchemaVersion: 1;
  digest: PlanDigestV1;
}

export type RepositoryRevisionV1 =
  | { kind: 'artifact-bytes'; digest: PlanDigestV1 }
  | { kind: 'resource'; digest: PlanDigestV1 };

export interface ResourcePreconditionV1 {
  preconditionId: PlanIdV1;
  resource: ResourceIdentityV1;
  expectedState: 'absent' | 'present';
  expectedHash: HashFactV1;
  expectedRevision: RepositoryRevisionV1 | null;
}

export interface SelectionPreconditionMemberV1 {
  resource: ResourceIdentityV1;
  resourceHash: HashFactV1;
}

export interface SelectionPreconditionV1 {
  preconditionId: PlanIdV1;
  domain: 'selection-set';
  hashSchemaVersion: 1;
  expectedHash: PlanDigestV1;
  selectionSource: PlanSelectionSourceV1;
  skills: string[];
  tools: PlanToolV1[];
  scopes: PlanScopeV1[];
  members: SelectionPreconditionMemberV1[];
}

export type PlanToolOperationV1 =
  | 'detect'
  | 'inventory-skills'
  | 'inventory-commands'
  | 'diagnostics'
  | 'install'
  | 'uninstall'
  | 'dev'
  | 'promote'
  | 'undo'
  | 'verify-static'
  | 'verify-deep'
  | 'plan'
  | 'apply'
  | 'sync'
  | 'update'
  | 'adapt';

export interface CapabilityPreconditionV1 {
  preconditionId: PlanIdV1;
  domain: 'capability';
  hashSchemaVersion: 1;
  expectedHash: PlanDigestV1;
  tool: PlanToolV1;
  operation: PlanToolOperationV1;
  capabilityVersion: number;
  supported: true;
  scopes: ('user' | 'project' | 'system' | 'managed' | 'custom' | 'artifact')[];
}

export interface MutationFlagsV1 {
  live: boolean;
  manifest: boolean;
  lock: boolean;
  ledger: boolean;
}

export type ReversibilityV1 =
  | { kind: 'none'; retentionResourceIds: [] }
  | {
      kind: 'reversible' | 'conditional';
      retentionResourceIds: [PlanIdV1, ...PlanIdV1[]];
    };

export interface PlanReasonV1 {
  code: PlanCodeV1;
  message: string;
}

export type ConflictV1 =
  | null
  | {
      class: 'unmanaged-target' | 'modified-managed-target' | 'destination-exists';
      normal: 'refuse';
      forced: 'backup-and-replace';
      target: ResourceIdentityV1;
      backup: 'required';
    }
  | {
      class: 'source-changed';
      normal: 'refuse';
      forced: 'replace';
      target: ResourceIdentityV1;
      backup: 'none';
    };

export type PlanOperationKindV1 = ExecutableOperationKind;

export interface PlanOperationV1 {
  operationId: PlanIdV1;
  groupId: PlanIdV1;
  pairId: PlanIdV1 | null;
  kind: PlanOperationKindV1;
  dependsOn: PlanIdV1[];
  skill: string | null;
  source: PlanSourceV1 | null;
  tool: PlanToolV1 | null;
  scope: PlanScopeV1 | null;
  before: PlanImageV1;
  after: PlanImageV1;
  reason: PlanReasonV1;
  selectionSource: PlanSelectionSourceV1;
  preconditionIds: PlanIdV1[];
  requiredCheckIds: PlanIdV1[];
  reversibility: ReversibilityV1;
  mutates: MutationFlagsV1;
  conflict: ConflictV1;
}

export type PlanOperationIntentV1 = Pick<
  PlanOperationV1,
  | 'operationId'
  | 'groupId'
  | 'pairId'
  | 'kind'
  | 'skill'
  | 'source'
  | 'tool'
  | 'scope'
  | 'before'
  | 'after'
  | 'mutates'
  | 'reversibility'
  | 'conflict'
>;

export interface CheckCommonV1 {
  checkId: PlanIdV1;
  blocking: true;
  operationIds: [PlanIdV1, ...PlanIdV1[]];
}

export type PlanCheckV1 =
  | (CheckCommonV1 & {
      kind: 'source-resolution';
      source: Extract<PlanSourceV1, { kind: 'portable' }>;
    })
  | (CheckCommonV1 & { kind: 'capability'; capabilityPreconditionId: PlanIdV1 })
  | (CheckCommonV1 & {
      kind: 'content-integrity';
      source: PlanSourceV1;
      expectedContentHash: PlanDigestV1;
    })
  | (CheckCommonV1 & {
      kind: 'verification';
      tool: PlanToolV1;
      mode: 'static' | 'static+deep';
      expectedContentHash: PlanDigestV1;
    })
  | (CheckCommonV1 & {
      kind: 'precondition-validation';
      preconditionIds: [PlanIdV1, ...PlanIdV1[]];
    });

export type RefusalClassV1 = 'usage' | 'state' | 'capability' | 'source' | 'permission';

export interface AffectedV1 {
  skill: string | null;
  source: PlanSourceV1 | null;
  tool: PlanToolV1 | null;
  scope: PlanScopeV1 | null;
  path: PlanLocationV1 | null;
}

export interface CorrelationV1 {
  groupId: PlanIdV1 | null;
  pairId: PlanIdV1 | null;
  operationId: PlanIdV1 | null;
}

export interface PlanDiagnosticV1 {
  diagnosticId: PlanIdV1;
  kind: 'noop' | 'skip' | 'refuse' | 'conflict' | 'warning';
  severity: 'info' | 'warning' | 'error';
  refusalClass: RefusalClassV1 | null;
  affected: AffectedV1;
  correlation: CorrelationV1;
  reason: PlanReasonV1;
  selectionSource: PlanSelectionSourceV1;
}

export interface MachineReasonV1 {
  code:
    | 'absolute-artifact-selector'
    | 'local-project-root'
    | 'local-dev-source'
    | 'absolute-live-placement'
    | 'custom-absolute-target';
  message: string;
  path: string;
  preconditionIds: [PlanIdV1, ...PlanIdV1[]];
}

export type PortabilityV1 =
  | { kind: 'portable'; reasons: [] }
  | { kind: 'machine-bound'; reasons: [MachineReasonV1, ...MachineReasonV1[]] };

export interface SavedPlanV1Dto {
  schemaVersion: 1;
  kind: 'skillsmith.plan';
  skillsmithVersion: string;
  executorSchemaVersion: 1;
  hashSchemaVersion: 1;
  portability: PortabilityV1;
  artifactPair: {
    manifest: PlanLocationV1;
    lock: PlanLocationV1;
    lockSource: 'explicit' | 'sibling';
  };
  manifestSemanticHash: PlanDigestV1;
  lockCanonicalHash: PlanDigestV1 | null;
  options: { prune: boolean; locked: boolean };
  selection: {
    selectionSource: PlanSelectionSourceV1;
    skills: string[];
    tools: PlanToolV1[];
    scopes: PlanScopeV1[];
  };
  operations: PlanOperationV1[];
  checks: PlanCheckV1[];
  diagnostics: PlanDiagnosticV1[];
  resourcePreconditions: ResourcePreconditionV1[];
  selectionPreconditions: SelectionPreconditionV1[];
  capabilityPreconditions: CapabilityPreconditionV1[];
}

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export type SavedPlanV1 = DeepReadonly<SavedPlanV1Dto>;
