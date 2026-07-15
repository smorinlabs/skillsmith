import type { SupportedTool } from '../agents/types.ts';
import type { Scope } from '../config/types.ts';
import type { EnabledState, Frontmatter, Origin, SkillEntry } from '../skills/types.ts';

export type InventoryMode = 'dev' | 'pinned' | 'unmanaged';
export type InventoryPlacement = 'symlink' | 'copy' | 'unknown';
export type InventoryVerification = 'passed' | 'warned' | 'skipped' | 'unrecorded';

export interface InventoryMember {
  readonly scope: Scope;
  readonly path: string;
}

export type InventoryVisibility =
  | Readonly<{
      state: 'unique';
      winner: null;
      members: readonly InventoryMember[];
    }>
  | Readonly<{
      state: 'winner';
      winner: string;
      members: readonly InventoryMember[];
    }>
  | Readonly<{
      state: 'shadowed';
      winner: string;
      members: readonly InventoryMember[];
    }>
  | Readonly<{
      state: 'duplicate';
      winner: null;
      members: readonly InventoryMember[];
    }>;

export interface InventoryCollisionGroup {
  readonly tool: SupportedTool;
  readonly name: string;
  readonly winner: string | null;
  readonly members: readonly InventoryMember[];
}

export type InventoryFilterValue = string | boolean | readonly string[] | null;

export interface InventorySelection {
  readonly source: 'bounded-default';
  readonly tools: readonly SupportedTool[];
  readonly scopes: readonly Scope[];
  readonly filters: Readonly<Record<string, InventoryFilterValue>>;
  readonly outcome: 'selected' | 'filter-noop';
}

export interface SkillInventoryEntry extends Readonly<SkillEntry> {
  readonly mode: InventoryMode;
  readonly placement: InventoryPlacement;
  readonly source: string | null;
  readonly revision: string | null;
  readonly store: string | null;
  readonly verification: InventoryVerification;
  readonly description: string | null;
  readonly visibility: InventoryVisibility;
}

export interface SkillInventory {
  readonly selection: InventorySelection;
  readonly entries: readonly SkillInventoryEntry[];
  readonly collisionGroups: readonly InventoryCollisionGroup[];
}

export interface CommandInventoryEntry {
  readonly name: string;
  readonly tool: SupportedTool;
  readonly scope: 'user' | 'project';
  readonly path: string;
  readonly realpath: string;
  readonly root: string;
  readonly frontmatter: Frontmatter | null;
  readonly origin: Origin;
  readonly enabled: EnabledState;
  readonly description: string | null;
}

export interface CommandInventory {
  readonly selection: InventorySelection;
  readonly entries: readonly CommandInventoryEntry[];
}
