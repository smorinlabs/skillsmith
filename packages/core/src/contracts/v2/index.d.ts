import type { FlipReport, ListReport } from '@skillsmith/core';
import type { WireCodec } from '@skillsmith/core/contracts';

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

export declare const flipV2Codec: WireCodec<'flip', 2, FlipV2Dto>;
export declare const toFlipV2Dto: (report: FlipReport) => FlipV2Dto;
export declare const listV2Codec: WireCodec<'list', 2, ListV2Dto>;
export declare const toListV2Dto: (report: ListReport) => ListV2Dto;
