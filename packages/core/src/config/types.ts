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
  scope?: Scope;
  path?: string;
  registry?: { default?: string };
}

export const CONFIG_KEYS = ['tool', 'scope', 'path', 'registry.default'] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];

export interface ConfigNotice {
  readonly code: 'legacy-project-config';
  readonly path: string;
  readonly migrationPending: true;
  readonly migrationPhase: 2;
}

export interface EffectiveConfig {
  value: Config;
  sources: Partial<Record<ConfigKey, ConfigLayer>>;
  layers: Record<ConfigLayer, Config>;
  paths: Partial<Record<ConfigFileLayer, string>>;
  notices?: readonly ConfigNotice[];
}
