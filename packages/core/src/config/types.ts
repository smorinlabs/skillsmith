import type { SupportedTool } from '../agents/types.ts';

export const SCOPES = ['system', 'user', 'project', 'managed'] as const;

export type Scope = (typeof SCOPES)[number];

export type ConfigLayer =
  | 'defaults'
  | 'system'
  | 'user'
  | 'project'
  | 'explicit-file'
  | 'env'
  | 'cli';

export type ConfigFileLayer = 'system' | 'user' | 'project' | 'explicit-file';

export interface Config {
  tool?: SupportedTool;
  /** Canonical manifest defaults. A singleton is projected through `tool` for v1 compatibility. */
  tools?: readonly SupportedTool[];
  scope?: Scope;
  path?: string;
  registry?: { default?: string };
}

export const CONFIG_KEYS = ['tool', 'scope', 'path', 'registry.default'] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];

export type ConfigDocumentShape =
  | 'canonical'
  | 'legacy'
  | 'mixed'
  | 'empty'
  | 'malformed'
  | 'unknown'
  | 'future';

export interface ParsedConfigDocument {
  readonly config: Config;
  readonly shape: 'canonical' | 'legacy';
  readonly migrationPending: boolean;
  readonly source: string;
}

export interface LegacyConfigNotice {
  readonly code: 'legacy-project-config';
  readonly path: string;
  readonly migrationPending: true;
  readonly migrationPhase: 2;
}

export interface PluralToolsNotice {
  readonly code: 'plural-tool-selection';
  readonly path?: string;
  readonly tools: readonly SupportedTool[];
  readonly source: ConfigLayer;
  readonly disposition: 'effective' | 'shadowed';
}

export type ConfigNotice = LegacyConfigNotice | PluralToolsNotice;

export interface EffectiveToolSelection {
  readonly tools: readonly SupportedTool[];
  readonly source: ConfigLayer;
  readonly cardinality: 'scalar' | 'plural';
}

export interface EffectiveConfig {
  value: Config;
  sources: Partial<Record<ConfigKey, ConfigLayer>>;
  layers: Record<ConfigLayer, Config>;
  paths: Partial<Record<ConfigFileLayer, string>>;
  toolSelection?: EffectiveToolSelection;
  notices?: readonly ConfigNotice[];
}
