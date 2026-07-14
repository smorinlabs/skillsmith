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
