import type { ListReport } from '@skillsmith/core';
import type { WireCodec } from '@skillsmith/core/contracts';

type Scope = 'system' | 'user' | 'project' | 'managed';
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
type InventoryMember = { scope: Scope; path: string };

export interface ListV3Dto {
  schemaVersion: 3;
  kind: 'skillsmith.list';
  selection: {
    source: 'bounded-default';
    tools: string[];
    scopes: Scope[];
    filters: {
      names: string[];
      mode: 'dev' | 'pinned' | 'unmanaged' | null;
      source: string | null;
      revision: string | null;
      description: string | null;
      verification: 'verified' | 'unverified' | null;
      enabled: 'enabled-only' | 'disabled-only' | 'unconfigured-only' | null;
      duplicates: boolean;
    };
    outcome: 'selected' | 'filter-noop';
  };
  summary: { total: number; collisionGroups: number };
  entries: Array<{
    name: string;
    tool: string;
    scope: Scope;
    mode: 'dev' | 'pinned' | 'unmanaged';
    placement: 'symlink' | 'copy' | 'unknown';
    path: string;
    realpath: string;
    root: string;
    frontmatter: EntryFrontmatter;
    origin: EntryOrigin;
    enabled: 'on' | 'off' | 'unset';
    source: string | null;
    revision: string | null;
    store: string | null;
    verification: 'passed' | 'warned' | 'skipped' | 'unrecorded';
    description: string | null;
    visibility: {
      state: 'unique' | 'winner' | 'shadowed' | 'duplicate';
      winner: string | null;
      members: InventoryMember[];
    };
  }>;
  collisionGroups: Array<{
    tool: string;
    name: string;
    winner: string | null;
    members: InventoryMember[];
  }>;
}

export declare const listV3Codec: WireCodec<'list', 3, ListV3Dto>;
export declare const toListV3Dto: (report: ListReport) => ListV3Dto;
