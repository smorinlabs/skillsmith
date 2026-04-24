import type { SupportedTool } from '../agents/types.ts';

export type Scope = 'system' | 'user' | 'project';

export type ConfigLayer = 'defaults' | 'system' | 'user' | 'project' | 'explicit-file' | 'env';

export interface Config {
  tool?: SupportedTool;
  scope?: Scope;
  path?: string;
  registry?: { default?: string };
}

export type ConfigKey = 'tool' | 'scope' | 'path' | 'registry.default';

export const CONFIG_KEYS: readonly ConfigKey[] = ['tool', 'scope', 'path', 'registry.default'];

export interface EffectiveConfig {
  value: Config;
  sources: Partial<Record<ConfigKey, ConfigLayer>>;
  layers: Record<ConfigLayer, Config>;
}
