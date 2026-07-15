import type {
  AgentsReport,
  ArtifactDigest,
  CommandsReport,
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
export declare const ledgerV2Codec: ArtifactCodec<'ledger', 2, LedgerV2Dto, LedgerModel>;
export declare const toLedgerV2Dto: (model: LedgerModel) => Result<LedgerV2Dto, ArtifactCodecError>;
export declare const fromLedgerV2Dto: (dto: LedgerV2Dto) => Result<LedgerModel, ArtifactCodecError>;
export declare const migrateLedgerV1DtoToV2Dto: (
  dto: LedgerV1Dto,
) => Result<LedgerV2Dto, ArtifactCodecError>;
