import type { ArtifactDigest, FlipReport, LedgerModel, ListReport, Result } from '@skillsmith/core';
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
    readonly tool: 'claude-code' | 'codex';
    readonly txId: string;
  }>[];
}

export declare const flipV2Codec: WireCodec<'flip', 2, FlipV2Dto>;
export declare const toFlipV2Dto: (report: FlipReport) => FlipV2Dto;
export declare const listV2Codec: WireCodec<'list', 2, ListV2Dto>;
export declare const toListV2Dto: (report: ListReport) => ListV2Dto;
export declare const ledgerV2Codec: ArtifactCodec<'ledger', 2, LedgerV2Dto, LedgerModel>;
export declare const toLedgerV2Dto: (model: LedgerModel) => Result<LedgerV2Dto, ArtifactCodecError>;
export declare const fromLedgerV2Dto: (dto: LedgerV2Dto) => Result<LedgerModel, ArtifactCodecError>;
export declare const migrateLedgerV1DtoToV2Dto: (
  dto: LedgerV1Dto,
) => Result<LedgerV2Dto, ArtifactCodecError>;
