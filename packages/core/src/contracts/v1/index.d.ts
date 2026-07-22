import type {
  AgentsReport,
  ArtifactDigest,
  CheckRunResult,
  CommandsReport,
  ConfigGetReport,
  ConfigListReport,
  ConfigSetReport,
  ConfigUnsetReport,
  Deprecation,
  ExportReport,
  InitReport,
  InstallReport,
  LedgerModel,
  LogicalJournalV1,
  ManifestScope,
  ManifestTool,
  NormalizedManifestDeclaration,
  NormalizedManifestV1,
  PortableLockV1,
  Result,
  SavedPlanV1,
  StatusReport,
  SupportedTool,
  ToolRegistry,
  UninstallReport,
  VerifyReport,
} from '@skillsmith/core';
import type { ArtifactCodec, ArtifactCodecError, WireCodec } from '@skillsmith/core/contracts';

type ToolId = 'claude-code' | 'codex';
type ConfigToolId = ToolId | 'kilo-code' | 'opencode';
type Scope = 'user' | 'project';
type ConfigScope = 'system' | Scope | 'managed';
type ConfigLayer = 'defaults' | 'system' | 'user' | 'project' | 'explicit-file' | 'env' | 'cli';
type PluginScope = 'user' | 'project' | 'managed' | 'local';
type EntryOrigin =
  | { kind: 'standalone' }
  | { kind: 'plugin'; pluginId: string; pluginVersion: string; pluginScope: PluginScope }
  | { kind: 'policy' };
type EntryFrontmatter = {
  name?: string | undefined;
  description?: string | undefined;
  version?: string | undefined;
} | null;
type CapabilityScope = ConfigScope | 'custom' | 'artifact';
type ToolOperation =
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

export interface AgentsV1Dto {
  schemaVersion: 1;
  experimental: true;
  tools: Record<
    string,
    Array<{
      path: string;
      version: string;
      installMethod:
        | 'brew'
        | 'npm-global'
        | 'bun-global'
        | 'native-installer'
        | 'app-bundle'
        | 'unknown';
    }>
  >;
}

export interface HealthV1Dto {
  schemaVersion: 1;
  experimental: true;
  findings: Array<{
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
  }>;
  counts: { ok: number; warning: number; error: number };
  deprecations?:
    | Array<{
        spelling: string;
        replacement: string;
        removalVersion: string;
        message: string;
      }>
    | undefined;
}

export interface CommandsV1Dto {
  schemaVersion: 1;
  experimental: true;
  commands: Array<{
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

interface ConfigV1Dto {
  tool?: ConfigToolId | undefined;
  tools?: readonly ConfigToolId[] | undefined;
  scope?: ConfigScope | undefined;
  path?: string | undefined;
  registry?: { default?: string | undefined } | undefined;
}

type ConfigNoticeV1Dto =
  | {
      code: 'legacy-project-config';
      path: string;
      migrationPending: true;
      migrationPhase: 2;
    }
  | {
      code: 'plural-tool-selection';
      path?: string | undefined;
      tools: readonly ConfigToolId[];
      source: ConfigLayer;
      disposition: 'effective' | 'shadowed';
    };

export interface ConfigGetV1Dto {
  key: string;
  value: string | null;
  source?: ConfigLayer | undefined;
  notices?: readonly ConfigNoticeV1Dto[] | undefined;
}

export type ConfigListV1Dto =
  | {
      tool?: ConfigToolId | undefined;
      tools?: readonly ConfigToolId[] | undefined;
      scope?: ConfigScope | undefined;
      path?: string | undefined;
      registry?: { default?: string | undefined } | undefined;
      notices?: readonly ConfigNoticeV1Dto[] | undefined;
    }
  | {
      effective: ConfigV1Dto;
      sources: {
        tool?: ConfigLayer | undefined;
        scope?: ConfigLayer | undefined;
        path?: ConfigLayer | undefined;
        'registry.default'?: ConfigLayer | undefined;
      };
      layers: Record<ConfigLayer, ConfigV1Dto>;
      notices?: readonly ConfigNoticeV1Dto[] | undefined;
    };

export interface ConfigSetV1Dto {
  key: string;
  value: string;
  scope: 'system' | 'user' | 'project';
  file: string | null;
  operation?: 'migrate-project-config' | undefined;
}

export interface ConfigUnsetV1Dto {
  key: string;
  scope: 'system' | 'user' | 'project';
  file: string | null;
  operation?: 'migrate-project-config' | undefined;
}

export interface InstallV1Dto {
  schemaVersion: 1;
  kind: 'skillsmith.install';
  dryRun: boolean;
  requested: {
    sources: string[];
    tools: ToolId[];
    explicitTools: boolean;
    scope: Scope;
    explicitScope: boolean;
    ref: string | null;
    pin: boolean;
    direct: boolean;
    force: boolean;
    verify: 'static' | 'skipped';
    deep: boolean;
  };
  results: Array<{
    source: string;
    skill: string | null;
    tool: ToolId | null;
    scope: Scope;
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
  }>;
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

export interface UninstallV1Dto {
  schemaVersion: 1;
  kind: 'skillsmith.uninstall';
  dryRun: boolean;
  requested: {
    targets: string[];
    tools: ToolId[];
    explicitTools: boolean;
    scope: Scope | null;
    allScopes: boolean;
    force: boolean;
  };
  results: Array<{
    skill: string;
    tool: ToolId | null;
    scope: Scope | null;
    placementPath: string | null;
    action: 'removed' | 'noop' | 'refused' | 'failed';
    reason: string | null;
    before: {
      mode: 'dev' | 'pinned';
      placement: 'symlink' | 'copy' | null;
      storePath: string | null;
      symlinkTarget: string | null;
    } | null;
    storeRetained: string | null;
    backupKept: string | null;
  }>;
  summary: { removed: number; noop: number; refused: number; failed: number };
}

type VerifyMode = 'static' | 'deep';
type VerifyVerdict = 'pass' | 'warn' | 'fail' | 'inconclusive';
type VerifySkipReason = 'not-installed' | 'timeout' | 'exec-error';
type VerifyFindingV1Dto = {
  checkId: string;
  toolSeverity: string | null;
  normalizedSeverity: 'error' | 'warning' | 'info';
  message: string;
  file: string | null;
  subject: 'skill' | 'manifest' | 'marketplace' | 'plugin';
  raw?: string | undefined;
};

export interface VerifyV1Dto {
  schemaVersion: 1;
  kind: 'skillsmith.verify';
  target: { path: string; kind: 'plugin' | 'skill' };
  requested: { tools: string[]; modes: VerifyMode[]; strict: boolean; explicitTools: boolean };
  verifiedAgainst: Record<string, string>;
  summary: {
    verdict: VerifyVerdict;
    verified: string[];
    failed: string[];
    skipped: string[];
    counts: { error: number; warning: number; info: number };
  };
  tools: Array<{
    tool: string;
    available: boolean;
    toolVersion: string | null;
    versionDrift: boolean;
    skipReason: VerifySkipReason | null;
    verdict: VerifyVerdict;
    modes: Array<{
      mode: VerifyMode;
      status: 'ran' | 'skipped' | 'error';
      skipReason: VerifySkipReason | null;
      coverage: { manifest: boolean; skills: boolean };
      verdict: 'pass' | 'warn' | 'fail' | null;
      command: string;
      findings: VerifyFindingV1Dto[];
    }>;
  }>;
}

export interface ErrorV1Dto {
  schemaVersion: 1;
  kind: 'error';
  code: string;
  message: string;
  exitCode: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 130;
}

export interface CapabilitySnapshotV1Dto {
  schemaVersion: 1;
  kind: 'skillsmith.capabilities';
  tools: Array<{
    id: string;
    order: number;
    capabilityVersion: number;
    operations: Record<
      ToolOperation,
      { supported: boolean; scopes: CapabilityScope[]; remediation: string | null }
    >;
  }>;
}

export interface StatusV1Dto {
  schemaVersion: 1;
  kind: 'skillsmith.status';
  selection: DeepMutable<StatusReport['selection']>;
  context: DeepMutable<StatusReport['context']>;
  artifacts: DeepMutable<StatusReport['artifacts']>;
  ledger: DeepMutable<StatusReport['ledger']>;
  journals: DeepMutable<StatusReport['journals']>;
  facts: DeepMutable<StatusReport['facts']>;
  entries: DeepMutable<StatusReport['entries']>;
  summary: DeepMutable<StatusReport['summary']>;
}

export declare const agentsV1Codec: WireCodec<'agents', 1, AgentsV1Dto>;
export declare const toAgentsV1Dto: (report: AgentsReport) => AgentsV1Dto;
export declare const healthV1Codec: WireCodec<'health', 1, HealthV1Dto>;
export declare const toHealthV1Dto: (
  result: CheckRunResult,
  deprecations?: readonly Deprecation[],
) => HealthV1Dto;
export declare const commandsV1Codec: WireCodec<'commands', 1, CommandsV1Dto>;
export declare const toCommandsV1Dto: (report: CommandsReport) => CommandsV1Dto;
export declare const configGetV1Codec: WireCodec<'config-get', 1, ConfigGetV1Dto>;
export declare const toConfigGetV1Dto: (report: ConfigGetReport) => ConfigGetV1Dto;
export declare const configListV1Codec: WireCodec<'config-list', 1, ConfigListV1Dto>;
export declare const toConfigListV1Dto: (report: ConfigListReport) => ConfigListV1Dto;
export declare const configSetV1Codec: WireCodec<'config-set', 1, ConfigSetV1Dto>;
export declare const toConfigSetV1Dto: (report: ConfigSetReport) => ConfigSetV1Dto;
export declare const configUnsetV1Codec: WireCodec<'config-unset', 1, ConfigUnsetV1Dto>;
export declare const toConfigUnsetV1Dto: (report: ConfigUnsetReport) => ConfigUnsetV1Dto;
export declare const installV1Codec: WireCodec<'install', 1, InstallV1Dto>;
export declare const toInstallV1Dto: (report: InstallReport) => InstallV1Dto;
export declare const uninstallV1Codec: WireCodec<'uninstall', 1, UninstallV1Dto>;
export declare const toUninstallV1Dto: (report: UninstallReport) => UninstallV1Dto;
export declare const verifyV1Codec: WireCodec<'verify', 1, VerifyV1Dto>;
export declare const createVerifyV1Codec: (
  registry: Pick<ToolRegistry, 'toolsFor'>,
) => WireCodec<'verify', 1, VerifyV1Dto>;
export declare const toVerifyV1Dto: (report: VerifyReport<string>) => VerifyV1Dto;
export declare const statusV1Codec: WireCodec<'status', 1, StatusV1Dto>;
export declare const toStatusV1Dto: (report: StatusReport) => StatusV1Dto;
export declare const errorV1Codec: WireCodec<'error', 1, ErrorV1Dto>;
export declare const toErrorV1Dto: (source: {
  readonly code: string;
  readonly message: string;
  readonly exitCode: ErrorV1Dto['exitCode'];
}) => ErrorV1Dto;
export declare const capabilitySnapshotV1Codec: WireCodec<
  'capability-snapshot',
  1,
  CapabilitySnapshotV1Dto
>;
export declare const toCapabilitySnapshotV1Dto: (
  source: Pick<ToolRegistry, 'adapters'>,
) => CapabilitySnapshotV1Dto;

export interface ExportV1Dto {
  schemaVersion: 1;
  kind: 'skillsmith.export';
  reportVersion: 1;
  dryRun: boolean;
  requested: {
    tools: ConfigToolId[];
    explicitTools: boolean;
    scope: ConfigScope;
    explicitScope: boolean;
    strict: boolean;
    force: boolean;
  };
  artifactSelection:
    | {
        outcome: 'selected';
        selectedBy: 'explicit-file' | 'project' | 'user';
        manifestPath: string;
        lockPath: string;
        lockSource: 'sibling' | 'explicit';
      }
    | { outcome: 'none'; reason: 'no-portable-candidates' | 'filter-noop' }
    | { outcome: 'refused'; reason: string };
  results: Array<
    | {
        name: string;
        tools: ConfigToolId[];
        scope: Scope;
        source: { host: string; repository: string; path: string | null };
        sourceText: string;
        requestedRef: string | null;
        resolvedSha: string;
        sourcePath: string;
        contentHash: string;
        placement: 'symlink' | 'copy';
        path: string | null;
        classification: 'portable-managed' | 'portable-dev';
        action: 'add' | 'merge' | 'refresh' | 'unchanged';
        reason: null;
      }
    | {
        name: string;
        tools: ConfigToolId[];
        scope: ConfigScope;
        classification:
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
        action: 'skipped';
        reason:
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
      }
    | {
        name: string;
        tools: ConfigToolId[];
        scope: ConfigScope;
        classification: 'conflict';
        action: 'conflict';
        reason:
          | 'custom-path-conflict'
          | 'duplicate-selected-placement'
          | 'existing-declaration-conflict'
          | 'selected-candidate-conflict';
      }
  >;
  effects: Array<{
    role: 'ledger' | 'manifest' | 'lock';
    action: 'create' | 'migrate' | 'update' | 'refresh' | 'unchanged' | 'not-written';
    operationId: string | null;
    outcome: 'planned' | 'succeeded' | 'failed' | 'cancelled' | 'not-run';
  }>;
  summary: {
    observed: number;
    portable: number;
    skipped: number;
    conflicts: number;
    changed: number;
    unchanged: number;
  };
}
export declare const exportV1Codec: WireCodec<'export', 1, ExportV1Dto>;
export declare const toExportV1Dto: (report: ExportReport) => ExportV1Dto;

type InitAbsentBeforeV1Dto = {
  state: 'absent';
  shape: null;
  byteHash: null;
  semanticHash: null;
};
type InitCanonicalBeforeV1Dto = {
  state: 'present';
  shape: 'canonical';
  byteHash: string;
  semanticHash: string;
};
type InitReplaceBeforeV1Dto =
  | {
      state: 'present';
      shape: 'canonical';
      byteHash: string;
      semanticHash: string | null;
    }
  | {
      state: 'present';
      shape: 'mixed' | 'empty' | 'malformed' | 'unknown';
      byteHash: string;
      semanticHash: null;
    };
type InitLegacyBeforeV1Dto = {
  state: 'present';
  shape: 'legacy';
  byteHash: string;
  semanticHash: string;
};
type InitAfterV1Dto = {
  state: 'canonical';
  byteHash: string;
  semanticHash: string;
};
type InitResultV1Dto =
  | {
      action: 'create-manifest';
      operationId: string;
      before: InitAbsentBeforeV1Dto;
      after: InitAfterV1Dto;
    }
  | {
      action: 'replace-manifest';
      operationId: string;
      before: InitReplaceBeforeV1Dto;
      after: InitAfterV1Dto;
    }
  | {
      action: 'migrate-project-config';
      operationId: string;
      before: InitLegacyBeforeV1Dto;
      after: InitAfterV1Dto;
    }
  | {
      action: 'noop';
      operationId: null;
      before: InitCanonicalBeforeV1Dto;
      after: null;
    };
type InitResourceV1Dto = {
  kind: 'manifest-bytes';
  location: { kind: 'machine-bound'; path: string };
};
type InitForceV1Dto =
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
      conflictType: 'destination-exists';
      target: InitResourceV1Dto;
      normalBehavior: 'refuse';
      forcedBehavior: 'backup-and-replace';
      backup: 'required';
    };

export interface InitV1Dto {
  schemaVersion: 1;
  kind: 'skillsmith.init';
  reportVersion: 1;
  dryRun: boolean;
  requested: {
    tools: ToolId[];
    explicitTools: boolean;
    toolSource: 'explicit' | 'config' | 'detected' | 'none';
    scope: Scope | null;
    explicitScope: boolean;
    file: string | null;
    force: boolean;
  };
  defaults: {
    tools: ToolId[] | null;
    scope: Scope | null;
    path: string | null;
    registryDefault: string | null;
  };
  artifactSelection: {
    outcome: 'selected';
    selectedBy: 'explicit-file' | 'project' | 'user';
    manifestPath: string;
    lockPath: string;
    lockSource: 'sibling';
  };
  result: InitResultV1Dto;
  force: InitForceV1Dto;
  effects: [
    {
      role: 'manifest';
      action: 'create' | 'replace' | 'migrate' | 'unchanged';
      operationId: string | null;
      outcome: 'planned' | 'succeeded' | 'not-run';
    },
    { role: 'lock'; action: 'not-written'; operationId: null; outcome: 'not-run' },
    { role: 'live'; action: 'not-written'; operationId: null; outcome: 'not-run' },
    { role: 'ledger'; action: 'not-written'; operationId: null; outcome: 'not-run' },
  ];
  summary: { changed: 0 | 1; unchanged: 0 | 1 };
}
export declare const initV1Codec: WireCodec<'init', 1, InitV1Dto>;
export declare const toInitV1Dto: (report: InitReport) => InitV1Dto;

type PlanLocationV1Dto =
  | { kind: 'portable'; token: string }
  | { kind: 'machine-bound'; path: string };
type PlanSourceV1Dto =
  | {
      kind: 'portable';
      identity: { host: string; repository: string; path: string | null };
      requestedRef: string | null;
      resolvedSha: string;
      sourcePath: string;
      contentHash: string;
    }
  | { kind: 'local-dev'; path: string; contentHash: string };
type PlanLiveResourceV1Dto = {
  kind: 'live';
  skill: string;
  tool: SupportedTool;
  scope: 'user' | 'project';
  projectRoot: PlanLocationV1Dto | null;
  location: PlanLocationV1Dto;
};
type PlanResourceV1Dto =
  | { kind: 'manifest-bytes'; location: PlanLocationV1Dto }
  | { kind: 'lock'; location: PlanLocationV1Dto }
  | { kind: 'ledger'; projectRoot: PlanLocationV1Dto | null }
  | { kind: 'ledger-schema'; projectRoot: PlanLocationV1Dto | null }
  | PlanLiveResourceV1Dto
  | { kind: 'store'; contentHash: string }
  | { kind: 'project-context'; root: PlanLocationV1Dto };
type PlanImageV1Dto =
  | { kind: 'absent'; resource: PlanResourceV1Dto }
  | {
      kind: 'placement';
      resource: PlanLiveResourceV1Dto;
      classification: 'dev' | 'pinned' | 'store-linked' | 'unmanaged';
      representation: 'symlink' | 'copy' | 'other';
      linkTarget: PlanLocationV1Dto | null;
      dangling: boolean;
      source: PlanSourceV1Dto | null;
      contentHash: string | null;
    }
  | {
      kind: 'manifest';
      location: PlanLocationV1Dto;
      shape: 'canonical' | 'legacy';
      version: 1;
      byteHash: string;
      semanticHash: string;
      value: {
        version: 1;
        defaults: {
          tools: SupportedTool[] | null;
          scope: 'user' | 'project' | null;
          path: string | null;
        } | null;
        registry: { default: string | null } | null;
        skills: Array<{
          name: string;
          source: { host: string; repository: string; path: string | null };
          ref: string | null;
          tools: SupportedTool[];
          scope: 'user' | 'project';
          placement: 'symlink' | 'copy';
          path: string | null;
        }>;
      };
    }
  | {
      kind: 'lock';
      location: PlanLocationV1Dto;
      version: 1;
      canonicalHash: string;
      value: {
        version: 1;
        hashSchemaVersion: 1;
        manifestHash: string;
        skills: Array<{
          name: string;
          source: string;
          requestedRef: string | null;
          resolvedSha: string;
          sourcePath: string;
          contentHash: string;
        }>;
      };
    }
  | {
      kind: 'ledger';
      projectRoot: PlanLocationV1Dto | null;
      schemaVersion: 1 | 2;
      byteHash: string;
      semanticHash: string;
    };

export type PlanOperationV1Dto = {
  operationId: string;
  groupId: string;
  pairId: string | null;
  kind:
    | 'install'
    | 'update'
    | 'remove'
    | 'link-dev'
    | 'promote'
    | 'move-scope'
    | 'adapt'
    | 'repair'
    | 'write-manifest'
    | 'write-lock'
    | 'migrate-project-config'
    | 'migrate-ledger';
  dependsOn: string[];
  skill: string | null;
  source: PlanSourceV1Dto | null;
  tool: SupportedTool | null;
  scope: 'user' | 'project' | null;
  before: PlanImageV1Dto;
  after: PlanImageV1Dto;
  reason: { code: string; message: string };
  selectionSource: 'explicit-targets' | 'explicit-all' | 'bounded-default';
  preconditionIds: string[];
  requiredCheckIds: string[];
  reversibility:
    | { kind: 'none'; retentionResourceIds: [] }
    | {
        kind: 'reversible' | 'conditional';
        retentionResourceIds: [string, ...string[]];
      };
  mutates: { live: boolean; manifest: boolean; lock: boolean; ledger: boolean };
  conflict:
    | null
    | {
        class: 'unmanaged-target' | 'modified-managed-target' | 'destination-exists';
        normal: 'refuse';
        forced: 'backup-and-replace';
        target: PlanResourceV1Dto;
        backup: 'required';
      }
    | {
        class: 'source-changed';
        normal: 'refuse';
        forced: 'replace';
        target: PlanResourceV1Dto;
        backup: 'none';
      };
};
export type PlanCheckV1Dto =
  | {
      checkId: string;
      blocking: true;
      operationIds: [string, ...string[]];
      kind: 'source-resolution';
      source: Extract<PlanSourceV1Dto, { kind: 'portable' }>;
    }
  | {
      checkId: string;
      blocking: true;
      operationIds: [string, ...string[]];
      kind: 'capability';
      capabilityPreconditionId: string;
    }
  | {
      checkId: string;
      blocking: true;
      operationIds: [string, ...string[]];
      kind: 'content-integrity';
      source: PlanSourceV1Dto;
      expectedContentHash: string;
    }
  | {
      checkId: string;
      blocking: true;
      operationIds: [string, ...string[]];
      kind: 'verification';
      tool: SupportedTool;
      mode: 'static' | 'static+deep';
      expectedContentHash: string;
    }
  | {
      checkId: string;
      blocking: true;
      operationIds: [string, ...string[]];
      kind: 'precondition-validation';
      preconditionIds: [string, ...string[]];
    };
export interface PlanDiagnosticV1Dto {
  diagnosticId: string;
  kind: 'noop' | 'skip' | 'refuse' | 'conflict' | 'warning';
  severity: 'info' | 'warning' | 'error';
  refusalClass: 'usage' | 'state' | 'capability' | 'source' | 'permission' | null;
  affected: {
    skill: string | null;
    source:
      | {
          kind: 'portable';
          identity: { host: string; repository: string; path: string | null };
          requestedRef: string | null;
          resolvedSha: string;
          sourcePath: string;
          contentHash: string;
        }
      | { kind: 'local-dev'; path: string; contentHash: string }
      | null;
    tool: SupportedTool | null;
    scope: 'user' | 'project' | null;
    path: { kind: 'portable'; token: string } | { kind: 'machine-bound'; path: string } | null;
  };
  correlation: { groupId: string | null; pairId: string | null; operationId: string | null };
  reason: { code: string; message: string };
  selectionSource: 'explicit-targets' | 'explicit-all' | 'bounded-default';
}

export interface PlanV1Dto {
  schemaVersion: 1;
  kind: 'skillsmith.plan-report';
  command: 'plan';
  state: 'ready' | 'refused';
  artifactPair: {
    manifestPath: string;
    lockPath: string;
    lockSource: 'explicit' | 'sibling';
    selectionSource: 'explicit' | 'discovered-project' | 'project-default' | 'user-default';
  };
  project: {
    effectiveCwd: string;
    root: string | null;
    identity: string | null;
  };
  options: { locked: boolean; prune: boolean; check: boolean };
  selection: {
    selectionSource: 'explicit-targets' | 'explicit-all' | 'bounded-default';
    selectionOutcome: 'selected' | 'filter-noop';
    requestedTools: SupportedTool[];
    requestedScope: 'user' | 'project' | null;
    skills: string[];
    tools: SupportedTool[];
    scopes: ('user' | 'project')[];
  };
  operations: PlanOperationV1Dto[];
  checks: PlanCheckV1Dto[];
  diagnostics: PlanDiagnosticV1Dto[];
  summary: {
    operations: number;
    checks: number;
    diagnostics: number;
    drift: number;
    refusals: number;
    operationKinds: Record<
      | 'install'
      | 'update'
      | 'remove'
      | 'link-dev'
      | 'promote'
      | 'move-scope'
      | 'adapt'
      | 'repair'
      | 'write-manifest'
      | 'write-lock'
      | 'migrate-project-config'
      | 'migrate-ledger',
      number
    >;
    checkKinds: Record<
      | 'source-resolution'
      | 'capability'
      | 'content-integrity'
      | 'verification'
      | 'precondition-validation',
      number
    >;
    diagnosticKinds: Record<'noop' | 'skip' | 'refuse' | 'conflict' | 'warning', number>;
  };
  savedOutput: {
    path: string;
    disposition: 'created' | 'replaced';
    mode: '0600';
    portability: 'portable' | 'machine-bound';
  } | null;
}

export declare const planV1Codec: WireCodec<'plan-report', 1, PlanV1Dto>;

type DeepMutable<T> = T extends Readonly<ArtifactDigest>
  ? ArtifactDigest
  : T extends string | number | boolean | bigint | symbol | null | undefined
    ? T
    : T extends (...args: never[]) => unknown
      ? T
      : T extends readonly unknown[]
        ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
        : T extends object
          ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
          : T;

type SavedPlanV1Dto = DeepMutable<SavedPlanV1>;
type MutableJournalV1 = DeepMutable<LogicalJournalV1>;
type JournalV1Dto = Omit<MutableJournalV1, 'actual'> & {
  actual: {
    before: readonly MutableJournalV1['actual']['before'][number][];
    after: readonly MutableJournalV1['actual']['after'][number][];
    retained: readonly MutableJournalV1['actual']['retained'][number][];
  };
};

interface LedgerDevV1Dto {
  readonly sourcePath: string;
  readonly resolvedPath: string;
  readonly repoRoot: string | null;
  readonly sourceRelPath: string | null;
  readonly remote: string | null;
  readonly recordedAt: string;
}

interface LedgerPinnedV1Dto {
  readonly storePath: string;
  readonly rev: string;
  readonly gitSha: string | null;
  readonly dirty: boolean;
  readonly contentHash: string;
  readonly snapshotAt: string;
  readonly verify: 'passed' | 'warned' | 'skipped';
  readonly placement?: 'symlink' | 'copy';
}

interface LedgerOriginV1Dto {
  readonly source: string;
  readonly host: string;
  readonly repo: string;
  readonly skillPath: string;
  readonly refRequested: string | null;
  readonly refResolved: string;
  readonly pin: boolean;
  readonly installedAt: string;
}

type LegacyPairBeforeV1Dto =
  | Readonly<{ mode: 'dev'; symlinkTarget: string; liveKind?: 'symlink' | 'dir' }>
  | Readonly<{
      mode: 'pinned';
      storePath: string | null;
      contentHash: string | null;
      liveKind?: 'symlink' | 'dir';
      symlinkTarget?: string;
    }>
  | Readonly<{ mode: 'absent' }>;

interface LegacyPairJournalV1Dto {
  readonly op: 'promote' | 'dev' | 'rollback' | 'install' | 'uninstall';
  readonly txId: string;
  readonly phase: 'prepared' | 'staged' | 'backed-up' | 'live' | 'committed';
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly before: LegacyPairBeforeV1Dto;
  readonly stagingPath: string;
  readonly backupPath: string;
}

interface LedgerPairV1Dto {
  readonly placementPath: string;
  readonly mode: 'dev' | 'pinned';
  readonly dev: LedgerDevV1Dto | null;
  readonly pinned?: LedgerPinnedV1Dto | null;
  readonly origin?: LedgerOriginV1Dto;
  readonly journal?: LegacyPairJournalV1Dto | null;
}

type LedgerSkillsV1Dto = Readonly<
  Record<
    string,
    Readonly<{
      readonly tools: Readonly<Partial<Record<'claude-code' | 'codex', LedgerPairV1Dto>>>;
    }>
  >
>;

interface LedgerV1Dto {
  readonly schemaVersion: 1;
  readonly kind: 'skillsmith.placements';
  readonly updatedAt: string;
  readonly skills: LedgerSkillsV1Dto;
  readonly projects?: Readonly<Record<string, Readonly<{ readonly skills: LedgerSkillsV1Dto }>>>;
}

export interface ManifestV1Dto {
  readonly version: 1;
  readonly defaults?: Readonly<{
    readonly tools?: readonly ManifestTool[];
    readonly scope?: ManifestScope;
    readonly path?: string;
  }>;
  readonly registry?: Readonly<{ readonly default?: string }>;
  readonly skills?: readonly NormalizedManifestDeclaration[];
}

export type LockV1Dto = PortableLockV1;
export type { JournalV1Dto, LedgerV1Dto, SavedPlanV1Dto };

export declare const manifestV1Codec: ArtifactCodec<
  'manifest',
  1,
  ManifestV1Dto,
  NormalizedManifestV1
>;
export declare const toManifestV1Dto: (
  model: NormalizedManifestV1,
) => Result<ManifestV1Dto, ArtifactCodecError>;
export declare const fromManifestV1Dto: (
  dto: ManifestV1Dto,
) => Result<NormalizedManifestV1, ArtifactCodecError>;
export declare const lockV1Codec: ArtifactCodec<'lock', 1, LockV1Dto, PortableLockV1>;
export declare const toLockV1Dto: (model: PortableLockV1) => Result<LockV1Dto, ArtifactCodecError>;
export declare const fromLockV1Dto: (dto: LockV1Dto) => Result<PortableLockV1, ArtifactCodecError>;
export declare const savedPlanV1Codec: ArtifactCodec<'plan', 1, SavedPlanV1Dto, SavedPlanV1>;
export declare const toSavedPlanV1Dto: (
  model: SavedPlanV1,
) => Result<SavedPlanV1Dto, ArtifactCodecError>;
export declare const fromSavedPlanV1Dto: (
  dto: SavedPlanV1Dto,
) => Result<SavedPlanV1, ArtifactCodecError>;
export declare const journalV1Codec: ArtifactCodec<'journal', 1, JournalV1Dto, LogicalJournalV1>;
export declare const toJournalV1Dto: (
  model: LogicalJournalV1,
) => Result<JournalV1Dto, ArtifactCodecError>;
export declare const fromJournalV1Dto: (
  dto: JournalV1Dto,
) => Result<LogicalJournalV1, ArtifactCodecError>;
export declare const ledgerV1Codec: ArtifactCodec<'ledger', 1, LedgerV1Dto, LedgerModel>;
export declare const toLedgerV1Dto: (model: LedgerModel) => Result<LedgerV1Dto, ArtifactCodecError>;
export declare const fromLedgerV1Dto: (dto: LedgerV1Dto) => Result<LedgerModel, ArtifactCodecError>;

export type ApplyModeV1 =
  | 'fresh-execute'
  | 'fresh-dry-run'
  | 'fresh-check'
  | 'saved-execute'
  | 'saved-dry-run'
  | 'saved-check';

export interface ApplyOperationResultV1Dto {
  readonly operationId: string;
  readonly outcome: 'succeeded' | 'failed' | 'cancelled' | 'rolled-back' | 'skipped';
  readonly reason: string | null;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly remediation: string;
  } | null;
}

export interface ApplyReportV1Dto {
  readonly schemaVersion: 1;
  readonly kind: 'skillsmith.apply-report';
  readonly command: 'apply';
  readonly mode: ApplyModeV1;
  readonly state: 'ready' | 'refused' | 'completed' | 'partial';
  readonly artifactPair: PlanV1Dto['artifactPair'] | null;
  readonly savedPlan: {
    readonly path: string;
    readonly portability: 'portable' | 'machine-bound';
    readonly executorSchemaVersion: 1;
    readonly hashSchemaVersion: 1;
  } | null;
  readonly project: PlanV1Dto['project'];
  readonly options: {
    readonly locked: boolean;
    readonly prune: boolean;
    readonly check: boolean;
    readonly dryRun: boolean;
    readonly continueOnError: boolean;
  };
  readonly selection: PlanV1Dto['selection'];
  readonly operations: PlanOperationV1Dto[];
  readonly checks: PlanCheckV1Dto[];
  readonly diagnostics: PlanDiagnosticV1Dto[];
  readonly approval: {
    readonly required: boolean;
    readonly outcome:
      | 'not-required'
      | 'pending'
      | 'approved'
      | 'refused'
      | 'cancelled'
      | 'prior-authorization';
  };
  readonly validation: {
    readonly outcome: 'not-run' | 'valid' | 'stale' | 'incompatible';
    readonly replanned: false;
  };
  readonly results: ApplyOperationResultV1Dto[];
  readonly summary: PlanV1Dto['summary'] & {
    readonly succeeded: number;
    readonly failed: number;
    readonly cancelled: number;
    readonly rolledBack: number;
    readonly skipped: number;
  };
}

export declare const applyV1Codec: WireCodec<'apply-report', 1, ApplyReportV1Dto>;

export interface SyncEndpointV1Dto {
  readonly kind: 'user' | 'project' | 'system' | 'managed' | 'path';
  readonly scope: 'user' | 'project' | 'system' | 'managed';
  readonly selectedInput: string;
  readonly projectRoot: string | null;
}

export interface SyncSelectionV1Dto {
  readonly selectionSource: 'bounded-default' | 'explicit-targets';
  readonly selectionOutcome: 'selected' | 'filter-noop';
  readonly targets: readonly string[];
  readonly skills: readonly string[];
  readonly tools: readonly SupportedTool[];
  readonly groupIds: readonly string[];
  readonly sourceMembers: number;
  readonly destinationMembers: number;
}

export interface SyncPairResultV1Dto {
  readonly tool: SupportedTool;
  readonly source: { readonly scope: SyncEndpointV1Dto['scope']; readonly present: boolean };
  readonly destination: { readonly scope: SyncEndpointV1Dto['scope']; readonly present: boolean };
  readonly action: 'install' | 'update' | 'remove' | 'noop' | 'refuse';
  readonly outcome: 'planned' | 'succeeded' | 'failed' | 'cancelled' | 'skipped' | 'not-run';
  readonly skipReason: string | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
  readonly force: {
    readonly requested: boolean;
    readonly used: boolean;
    readonly conflictType:
      | 'unmanaged-target'
      | 'modified-managed-target'
      | 'destination-exists'
      | 'source-changed'
      | null;
    readonly destination: string | null;
    readonly normal: 'apply' | 'refuse';
    readonly forced: 'not-applicable' | 'backup-and-replace' | 'replace';
    readonly required: boolean;
    readonly outcome: 'not-required' | 'planned' | 'succeeded' | 'failed' | 'cancelled' | 'not-run';
  };
  readonly drift: { readonly artifact: boolean; readonly live: boolean };
}

export interface SyncGroupResultV1Dto {
  readonly groupId: string;
  readonly skill: string;
  readonly pairs: readonly SyncPairResultV1Dto[];
}

export interface SyncEffectV1Dto {
  readonly role: 'manifest' | 'lock' | 'ledger' | 'store' | 'live' | 'backup';
  readonly action: string;
  readonly operationId: string | null;
  readonly groupId: string;
  readonly outcome: 'planned' | 'succeeded' | 'failed' | 'cancelled' | 'not-run';
}

export interface SyncSummaryV1Dto {
  readonly groups: number;
  readonly pairs: number;
  readonly planned: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly skipped: number;
  readonly notRun: number;
  readonly changed: number;
  readonly unchanged: number;
  readonly effects: number;
  readonly drift: number;
  readonly refusals: number;
}

export interface SyncReportV1Dto {
  readonly schemaVersion: 1;
  readonly kind: 'skillsmith.sync';
  readonly command: 'sync';
  readonly mode: 'dry-run' | 'execute';
  readonly state: 'ready' | 'refused' | 'completed' | 'partial';
  readonly endpoints: { readonly from: SyncEndpointV1Dto; readonly to: SyncEndpointV1Dto };
  readonly artifactPair: null | {
    readonly manifestPath: string;
    readonly lockPath: string;
    readonly lockSource: 'sibling' | 'explicit';
    readonly selectionSource: 'explicit' | 'destination-project' | 'destination-user';
  };
  readonly options: {
    readonly force: boolean;
    readonly delete: boolean;
    readonly save: boolean;
    readonly dryRun: boolean;
    readonly continueOnError: boolean;
  };
  readonly selection: SyncSelectionV1Dto;
  readonly operations: readonly PlanOperationV1Dto[];
  readonly checks: readonly PlanCheckV1Dto[];
  readonly diagnostics: readonly PlanDiagnosticV1Dto[];
  readonly approval: {
    readonly required: boolean;
    readonly outcome: 'not-required' | 'pending' | 'approved' | 'refused' | 'cancelled';
  };
  readonly groups: readonly SyncGroupResultV1Dto[];
  readonly effects: readonly SyncEffectV1Dto[];
  readonly summary: SyncSummaryV1Dto;
}

export declare const syncV1Codec: WireCodec<'sync', 1, SyncReportV1Dto>;

export interface UpdateSelectionV1Dto {
  readonly selectionSource: 'bounded-default' | 'explicit-targets' | 'explicit-all';
  readonly selectionOutcome: 'selected' | 'filter-noop';
  readonly targets: readonly string[];
  readonly skills: readonly string[];
  readonly tools: readonly SupportedTool[];
  readonly groupIds: readonly string[];
}

export interface UpdateSourceFactV1Dto {
  readonly requestedRef: string | null;
  readonly kind: 'default' | 'branch' | 'tag' | 'sha';
  readonly resolvedSha: string;
  readonly contentHash: string;
}

export interface UpdateCandidateV1Dto {
  readonly groupId: string;
  readonly skill: string;
  readonly current: UpdateSourceFactV1Dto;
  readonly proposed: UpdateSourceFactV1Dto | null;
  readonly transition: 'preserve' | 'track' | 'pin';
  readonly outcome: 'current' | 'available' | 'skipped-fixed' | 'failed';
  readonly failure: { readonly code: string; readonly message: string } | null;
}

export interface UpdateVerificationV1Dto {
  readonly tool: SupportedTool;
  readonly mode: 'static' | 'static+deep';
  readonly gate: 'pending' | 'passed' | 'warned' | 'failed' | 'inconclusive' | 'skipped';
}

export interface UpdateGroupResultV1Dto {
  readonly groupId: string;
  readonly skill: string;
  readonly tools: readonly SupportedTool[];
  readonly verification: readonly UpdateVerificationV1Dto[];
  readonly action: 'update' | 'noop' | 'skip' | 'refuse';
  readonly outcome: 'planned' | 'succeeded' | 'failed' | 'cancelled' | 'skipped' | 'not-run';
  readonly skipReason: string | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
  readonly drift: { readonly artifact: boolean; readonly live: boolean };
}

export interface UpdateEffectV1Dto {
  readonly role: 'manifest' | 'lock' | 'store' | 'ledger' | 'live' | 'backup';
  readonly action: string;
  readonly operationId: string | null;
  readonly groupId: string;
  readonly outcome: 'planned' | 'succeeded' | 'failed' | 'cancelled' | 'not-run';
}

export interface UpdateSummaryV1Dto {
  readonly groups: number;
  readonly candidates: number;
  readonly current: number;
  readonly available: number;
  readonly skippedFixed: number;
  readonly candidateFailed: number;
  readonly planned: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly skipped: number;
  readonly notRun: number;
  readonly effects: number;
  readonly artifactDrift: number;
  readonly liveDrift: number;
  readonly refusals: number;
}

export interface UpdateReportV1Dto {
  readonly schemaVersion: 1;
  readonly kind: 'skillsmith.update';
  readonly command: 'update';
  readonly mode: 'check' | 'dry-run' | 'execute';
  readonly state: 'current' | 'changes-available' | 'ready' | 'refused' | 'completed' | 'partial';
  readonly artifactPair: {
    readonly manifestPath: string;
    readonly lockPath: string;
    readonly lockSource: 'sibling' | 'explicit';
    readonly selectionSource:
      | 'explicit'
      | 'discovered-project'
      | 'project-default'
      | 'user-default';
  };
  readonly options: {
    readonly all: boolean;
    readonly ref: string | null;
    readonly pin: boolean;
    readonly strict: boolean;
    readonly continueOnError: boolean;
  };
  readonly selection: UpdateSelectionV1Dto;
  readonly candidates: readonly UpdateCandidateV1Dto[];
  readonly operations: readonly PlanOperationV1Dto[];
  readonly checks: readonly PlanCheckV1Dto[];
  readonly diagnostics: readonly PlanDiagnosticV1Dto[];
  readonly approval: {
    readonly required: boolean;
    readonly outcome: 'not-required' | 'pending' | 'approved' | 'refused' | 'cancelled';
  };
  readonly groups: readonly UpdateGroupResultV1Dto[];
  readonly effects: readonly UpdateEffectV1Dto[];
  readonly summary: UpdateSummaryV1Dto;
}

export declare const updateV1Codec: WireCodec<'update', 1, UpdateReportV1Dto>;
