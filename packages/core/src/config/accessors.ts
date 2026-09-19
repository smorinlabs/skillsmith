import type { Config, ConfigKey } from './types.ts';

interface Accessor<T> {
  get(c: Config): T | undefined;
  set(c: Config, v: T): void;
  del(c: Config): void;
  patch(v: T): Partial<Config>;
}

const stringAccessor = <K extends 'tool' | 'scope' | 'path'>(
  key: K,
): Accessor<NonNullable<Config[K]>> => ({
  get: (c) => c[key] as NonNullable<Config[K]> | undefined,
  set: (c, v) => {
    (c as Record<string, unknown>)[key] = v;
  },
  del: (c) => {
    Reflect.deleteProperty(c, key);
  },
  patch: (v) => ({ [key]: v }) as Partial<Config>,
});

export const CONFIG_ACCESSORS: { [K in ConfigKey]: Accessor<string> } = {
  tool: stringAccessor('tool'),
  scope: stringAccessor('scope'),
  path: stringAccessor('path'),
  'registry.default': {
    get: (c) => c.registry?.default,
    set: (c, v) => {
      c.registry = { ...(c.registry ?? {}), default: v };
    },
    del: (c) => {
      if (c.registry) Reflect.deleteProperty(c.registry, 'default');
    },
    patch: (v) => ({ registry: { default: v } }),
  },
};

export const getConfigValue = (c: Config, key: ConfigKey): string | undefined =>
  CONFIG_ACCESSORS[key].get(c);

export const getConfigTools = (
  config: Config,
): readonly NonNullable<Config['tool']>[] | undefined =>
  config.tools ?? (config.tool === undefined ? undefined : [config.tool]);

export const setConfigTools = (
  config: Config,
  tools: readonly NonNullable<Config['tool']>[],
): void => {
  Reflect.deleteProperty(config, 'tool');
  Reflect.deleteProperty(config, 'tools');
  const singleton = tools.length === 1 ? tools[0] : undefined;
  if (singleton !== undefined) config.tool = singleton;
  else if (tools.length > 1) config.tools = Object.freeze([...tools]);
};
