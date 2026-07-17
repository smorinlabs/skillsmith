import type {
  AgentsReport,
  ArtifactDigest,
  CommandsReport,
  CurrentInstallReport,
  CurrentUninstallReport,
  Deprecation,
  DoctorRunResult,
  FlipReport,
  LedgerModel,
  ListReport,
  Result,
} from '@skillsmith/core';
import type { ArtifactCodec, ArtifactCodecError, WireCodec } from '@skillsmith/core/contracts';
import type { LedgerV1Dto } from '@skillsmith/core/contracts/v1';

type ToolId = 'claude-code' | 'codex';
type EntryOrigin =
  | { kind: 'standalone' }
  | {
      kind: 'plugin';
      pluginId: string;
      pluginVersion: string;
      pluginScope: 'user' | 'project' | 'managed' | 'local';
    }
  | { kind: 'policy' };
type EntryFrontmatter = {
  name?: string | undefined;
  description?: string | undefined;
  version?: string | undefined;
} | null;

export interface FlipV2Dto {
  schemaVersion: 2;
  kind: 'skillsmith.flip';
  op: 'promote' | 'dev' | 'rollback';
  dryRun: boolean;
  requested: { targets: string[]; all: boolean; tools: ToolId[]; explicitTools: boolean };
  results: Array<{
    skill: string;
    tool: ToolId | null;
    placementPath: string | null;
    action:
      | 'flipped'
      | 'updated'
      | 'noop'
      | 'skipped'
      | 'refused'
      | 'failed'
      | 'rolled-back'
      | 'created'
      | 'adopted';
    reason: string | null;
    before: {
      mode: 'dev' | 'pinned';
      symlinkTarget?: string | undefined;
      storePath?: string | null | undefined;
    } | null;
    after: {
      mode: 'dev' | 'pinned';
      symlinkTarget?: string | undefined;
      storePath?: string | null | undefined;
    } | null;
    store: {
      path: string;
      rev: string;
      gitSha: string | null;
      dirty: boolean;
      reused: boolean;
    } | null;
    verify: {
      gate: 'passed' | 'warned' | 'failed' | 'skipped' | 'inconclusive';
      verdict: 'pass' | 'warn' | 'fail' | 'inconclusive' | null;
    } | null;
  }>;
  summary: {
    flipped: number;
    updated: number;
    noop: number;
    skipped: number;
    refused: number;
    failed: number;
    rolledBack: number;
    created: number;
    adopted: number;
  };
}

type LifecycleLocationV2Dto =
  | { kind: 'portable'; token: string }
  | { kind: 'machine-bound'; path: string };

type LifecycleResourceIdentityV2Dto =
  | { kind: 'manifest-bytes'; location: LifecycleLocationV2Dto }
  | { kind: 'lock'; location: LifecycleLocationV2Dto }
  | { kind: 'ledger'; projectRoot: LifecycleLocationV2Dto | null }
  | { kind: 'ledger-schema'; projectRoot: LifecycleLocationV2Dto | null }
  | {
      kind: 'live';
      skill: string;
      tool: ToolId;
      scope: 'user' | 'project';
      projectRoot: LifecycleLocationV2Dto | null;
      location: LifecycleLocationV2Dto;
    }
  | { kind: 'store'; contentHash: string }
  | { kind: 'project-context'; root: LifecycleLocationV2Dto };

type LifecycleForceV2Dto =
  | {
      requested: boolean;
      applied: false;
      conflictType: null;
      target: null;
      normalBehavior: null;
      forcedBehavior: null;
      backup: null;
    }
  | {
      requested: true;
      applied: boolean;
      conflictType: 'unmanaged-target' | 'modified-managed-target' | 'destination-exists';
      target: LifecycleResourceIdentityV2Dto;
      normalBehavior: 'refuse';
      forcedBehavior: 'backup-and-replace';
      backup: 'required';
    }
  | {
      requested: true;
      applied: boolean;
      conflictType: 'source-changed';
      target: LifecycleResourceIdentityV2Dto;
      normalBehavior: 'refuse';
      forcedBehavior: 'replace';
      backup: 'none';
    };

type LifecycleArtifactPairV2Dto = {
  manifestPath: string;
  lockPath: string;
  lockSource: 'sibling' | 'explicit';
} | null;

type LifecycleArtifactSelectionV2Dto =
  | {
      outcome: 'selected';
      selectedBy:
        | 'explicit-file'
        | 'selected-project-owner'
        | 'project-root-owner'
        | 'user-owner'
        | 'new-project'
        | 'new-user'
        | 'legacy-project-migration';
    }
  | { outcome: 'none'; reason: 'no-save' | 'no-owner' | 'pre-resolution-failure' }
  | {
      outcome: 'refused';
      reason: 'ambiguous-owner' | 'split-owner' | 'invalid-candidate' | 'nonportable-path';
      candidates: string[];
    };

type LifecycleArtifactEffectV2Dto = {
  groupId: string | null;
  skill: string | null;
  manifestAction: 'create' | 'update' | 'remove-declaration' | 'retain' | 'keep' | 'not-write';
  lockAction: 'create' | 'update' | 'remove-entry' | 'retain' | 'keep' | 'not-write';
  migration: 'none' | 'planned' | 'applied' | 'failed' | 'rolled-back';
  outcome:
    | 'planned'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'rolled-back'
    | 'skipped-after-failure'
    | 'not-run';
  reason: string | null;
};

type LifecycleDriftV2Dto = {
  status: 'in-sync' | 'desired-without-live' | 'live-without-desired' | 'not-evaluated';
  futureApply:
    | 'none'
    | 'restore-live'
    | 'replace-live'
    | 'prune-may-remove-live'
    | 'depends-on-selected-manifest';
  reason: string | null;
};

type LifecycleExecutionOutcomeV2Dto =
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'rolled-back'
  | 'skipped-after-failure'
  | null;

type LifecycleDesiredStateSummaryV2Dto = {
  changed: number;
  unchanged: number;
  retained: number;
  notWritten: number;
  failed: number;
};

export interface InstallV2Dto {
  schemaVersion: 2;
  kind: 'skillsmith.install';
  dryRun: boolean;
  saveMode: 'desired-state' | 'live-only';
  artifactPair: LifecycleArtifactPairV2Dto;
  artifactSelection: LifecycleArtifactSelectionV2Dto;
  artifactEffects: LifecycleArtifactEffectV2Dto[];
  requested: {
    sources: string[];
    tools: ToolId[];
    explicitTools: boolean;
    scope: 'user' | 'project';
    explicitScope: boolean;
    ref: string | null;
    pin: boolean;
    direct: boolean;
    force: boolean;
    verify: 'static' | 'skipped';
    deep: boolean;
    batchPolicy: 'fail-fast' | 'continue-on-error';
    path: string | null;
  };
  results: Array<{
    source: string;
    skill: string | null;
    tool: ToolId | null;
    scope: 'user' | 'project';
    placementPath: string | null;
    action: 'installed' | 'updated' | 'repaired' | 'noop' | 'skipped' | 'refused' | 'failed';
    reason: string | null;
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
    } | null;
    candidates: string[] | null;
    requestIndex: number;
    groupId: string | null;
    pairId: string | null;
    executionOutcome: LifecycleExecutionOutcomeV2Dto;
    drift: LifecycleDriftV2Dto;
    force: LifecycleForceV2Dto;
  }>;
  summary: {
    installed: number;
    updated: number;
    repaired: number;
    noop: number;
    skipped: number;
    refused: number;
    failed: number;
    desiredState: LifecycleDesiredStateSummaryV2Dto;
  };
}

export interface UninstallV2Dto {
  schemaVersion: 2;
  kind: 'skillsmith.uninstall';
  dryRun: boolean;
  saveMode: 'desired-state' | 'live-only';
  artifactPair: LifecycleArtifactPairV2Dto;
  artifactSelection: LifecycleArtifactSelectionV2Dto;
  artifactEffects: LifecycleArtifactEffectV2Dto[];
  requested: {
    targets: string[];
    tools: ToolId[];
    explicitTools: boolean;
    scope: 'user' | 'project' | null;
    allScopes: boolean;
    force: boolean;
    batchPolicy: 'fail-fast' | 'continue-on-error';
  };
  results: Array<{
    skill: string;
    tool: ToolId | null;
    scope: 'user' | 'project' | null;
    placementPath: string | null;
    action: 'removed' | 'noop' | 'skipped' | 'refused' | 'failed';
    reason: string | null;
    before: {
      mode: 'dev' | 'pinned';
      placement: 'symlink' | 'copy' | null;
      storePath: string | null;
      symlinkTarget: string | null;
    } | null;
    storeRetained: string | null;
    backupKept: string | null;
    requestIndex: number;
    groupId: string | null;
    pairId: string | null;
    executionOutcome: LifecycleExecutionOutcomeV2Dto;
    drift: LifecycleDriftV2Dto;
    force: LifecycleForceV2Dto;
  }>;
  summary: {
    removed: number;
    noop: number;
    refused: number;
    failed: number;
    desiredState: LifecycleDesiredStateSummaryV2Dto;
  };
}

export interface ListV2Dto {
  schemaVersion: 2;
  experimental: true;
  skills: Array<{
    name: string;
    path: string;
    realpath: string;
    tool: string;
    scope: string;
    root: string;
    frontmatter: EntryFrontmatter;
    origin: EntryOrigin;
    enabled: 'on' | 'off' | 'unset';
  }>;
}

type CapabilityOperation =
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

export interface AgentsV2Dto {
  schemaVersion: 2;
  kind: 'skillsmith.agents';
  detections: Array<{
    tool: string;
    installations: Array<{
      path: string;
      version: string;
      installMethod:
        | 'brew'
        | 'npm-global'
        | 'bun-global'
        | 'native-installer'
        | 'app-bundle'
        | 'unknown';
    }>;
  }>;
  capabilities: {
    schemaVersion: 1;
    kind: 'skillsmith.capabilities';
    tools: Array<{
      id: string;
      order: number;
      capabilityVersion: number;
      operations: Record<
        CapabilityOperation,
        {
          supported: boolean;
          scopes: Array<'user' | 'project' | 'system' | 'managed' | 'custom' | 'artifact'>;
          remediation: string | null;
        }
      >;
    }>;
  };
}

export interface CommandsV2Dto {
  schemaVersion: 2;
  kind: 'skillsmith.commands';
  selection: {
    source: 'bounded-default';
    tools: string[];
    scopes: Array<'user' | 'project'>;
    filters: {
      names: string[];
      enabled: 'enabled-only' | 'disabled-only' | 'unconfigured-only' | null;
    };
    outcome: 'selected' | 'filter-noop';
  };
  summary: { total: number };
  entries: Array<{
    name: string;
    tool: string;
    scope: 'user' | 'project';
    path: string;
    realpath: string;
    root: string;
    frontmatter: EntryFrontmatter;
    origin: EntryOrigin;
    enabled: 'on' | 'off' | 'unset';
    description: string | null;
  }>;
}

export interface FindingV2Dto {
  findingId: `finding:v1:${string}`;
  checkId: string;
  severity: 'error' | 'warning' | 'info';
  title: string;
  message: string;
  remediation?: string | undefined;
  tool?: string | undefined;
  scope?: string | undefined;
  path?: string | undefined;
  operation?: string | undefined;
  reason?: string | undefined;
  scopeInUse?: boolean | undefined;
}

export type DoctorRepairArtifactSummaryV1Dto =
  | {
      state: 'absent';
      schemaVersion: null;
      byteRevision: null;
      semanticRevision: null;
    }
  | {
      state: 'present';
      schemaVersion: number | null;
      byteRevision: `sha256:${string}`;
      semanticRevision: `sha256:${string}` | null;
    };

export interface DoctorRepairOperationV1Dto {
  operationId: `operation:v1:${string}`;
  kind: 'migrate-ledger' | 'migrate-project-config' | 'write-lock';
  artifact: 'ledger' | 'manifest' | 'lock';
  path: string;
  before: DoctorRepairArtifactSummaryV1Dto;
  after: DoctorRepairArtifactSummaryV1Dto;
  findingIds: Array<`finding:v1:${string}`>;
}

export interface DoctorRepairResultV1Dto {
  operationId: `operation:v1:${string}`;
  outcome: 'changed' | 'unchanged' | 'failed';
  error: null | { code: string; message: string; remediation: string };
}

export interface HealthV2Dto {
  schemaVersion: 2;
  experimental: true;
  findings: FindingV2Dto[];
  counts: { ok: number; warning: number; error: number };
  repair: {
    mode: 'not-requested' | 'preview' | 'execute';
    operations: DoctorRepairOperationV1Dto[];
    results: DoctorRepairResultV1Dto[];
  };
  mutation: {
    kind: 'none' | 'preview' | 'applied';
    planned: number;
    changed: number;
    unchanged: number;
    failed: number;
  };
  deprecations?: Deprecation[] | undefined;
}

export type LedgerV2Dto = Readonly<{
  readonly schemaVersion: 2;
  readonly kind: 'skillsmith.placements';
}> &
  LedgerModel;

export interface LedgerMigrationV1ToV2 {
  readonly kind: 'ledger-v1-to-v2';
  readonly fromSchemaVersion: 1;
  readonly toSchemaVersion: 2;
  readonly sourceByteRevision: ArtifactDigest;
  readonly sourceSemanticRevision: ArtifactDigest;
  readonly targetSemanticRevision: ArtifactDigest;
  readonly targetByteRevision: ArtifactDigest;
  readonly targetCanonicalSource: string;
  readonly preservedLegacyJournals: readonly Readonly<{
    readonly scope:
      | Readonly<{ readonly kind: 'user' }>
      | Readonly<{ readonly kind: 'project'; readonly root: string }>;
    readonly skill: string;
    readonly tool: ToolId;
    readonly txId: string;
  }>[];
}

export declare const flipV2Codec: WireCodec<'flip', 2, FlipV2Dto>;
export declare const toFlipV2Dto: (report: FlipReport) => FlipV2Dto;
export declare const agentsV2Codec: WireCodec<'agents', 2, AgentsV2Dto>;
export declare const toAgentsV2Dto: (report: AgentsReport) => AgentsV2Dto;
export declare const commandsV2Codec: WireCodec<'commands', 2, CommandsV2Dto>;
export declare const toCommandsV2Dto: (report: CommandsReport) => CommandsV2Dto;
export declare const listV2Codec: WireCodec<'list', 2, ListV2Dto>;
export declare const toListV2Dto: (report: ListReport) => ListV2Dto;
export declare const healthV2Codec: WireCodec<'health', 2, HealthV2Dto>;
export declare const toHealthV2Dto: (
  report: DoctorRunResult,
  deprecations?: readonly Deprecation[],
) => HealthV2Dto;
export declare const installV2Codec: WireCodec<'install', 2, InstallV2Dto>;
export declare const uninstallV2Codec: WireCodec<'uninstall', 2, UninstallV2Dto>;
export declare const toInstallV2Dto: (report: CurrentInstallReport) => InstallV2Dto;
export declare const toUninstallV2Dto: (report: CurrentUninstallReport) => UninstallV2Dto;
export declare const ledgerV2Codec: ArtifactCodec<'ledger', 2, LedgerV2Dto, LedgerModel>;
export declare const toLedgerV2Dto: (model: LedgerModel) => Result<LedgerV2Dto, ArtifactCodecError>;
export declare const fromLedgerV2Dto: (dto: LedgerV2Dto) => Result<LedgerModel, ArtifactCodecError>;
export declare const migrateLedgerV1DtoToV2Dto: (
  dto: LedgerV1Dto,
) => Result<LedgerV2Dto, ArtifactCodecError>;
