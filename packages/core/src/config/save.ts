import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import lockfile from 'proper-lockfile';
import { stringify as stringifyToml } from 'smol-toml';
import type { ScanEnv } from '../env/types.ts';
import { type SkillSmithError, configError, errorMessage } from '../errors.ts';
import { type Result, err, ok } from '../result.ts';
import { CONFIG_ACCESSORS } from './accessors.ts';
import { getConfigPath } from './paths.ts';
import { parseConfig } from './schema.ts';
import type { Config, ConfigKey, Scope } from './types.ts';

export interface SaveConfigOpts {
  scope: Scope;
  patch?: Partial<Config>;
  delete?: readonly ConfigKey[];
  cwd?: string;
}

const stripUndefined = (c: Config): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  if (c.tool !== undefined) out.tool = c.tool;
  if (c.scope !== undefined) out.scope = c.scope;
  if (c.path !== undefined) out.path = c.path;
  if (c.registry) {
    const r: Record<string, unknown> = {};
    if (c.registry.default !== undefined) r.default = c.registry.default;
    if (Object.keys(r).length > 0) out.registry = r;
  }
  return out;
};

export const saveConfig = async (
  env: ScanEnv,
  opts: SaveConfigOpts,
): Promise<Result<{ file: string }, SkillSmithError>> => {
  const file = getConfigPath(env, opts.scope, opts.cwd);
  try {
    await mkdir(dirname(file), { recursive: true });
  } catch (e) {
    return err(configError(`cannot create directory for ${file}: ${errorMessage(e)}`, { file }));
  }

  try {
    await writeFile(file, '', { flag: 'ax' });
  } catch {
    // ignore EEXIST; proper-lockfile needs the target to exist before locking
  }

  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(file, {
      stale: 10_000,
      retries: { retries: 5, factor: 1, minTimeout: 10, maxTimeout: 100 },
    });
  } catch (e) {
    return err(configError(`lock failed: ${errorMessage(e)}`, { file }));
  }

  try {
    let existing: Config = {};
    const text = await readFile(file, 'utf8');
    if (text.trim().length > 0) {
      const parsed = parseConfig(text);
      if (!parsed.ok) {
        const base = parsed.error;
        if (base.code !== 'config-error') return err(base);
        return err({ ...base, file });
      }
      existing = parsed.value;
    }

    const merged: Config = { ...existing, ...(opts.patch ?? {}) };
    if (opts.patch?.registry) {
      merged.registry = { ...(existing.registry ?? {}), ...opts.patch.registry };
    }
    for (const key of opts.delete ?? []) CONFIG_ACCESSORS[key].del(merged);

    const serialized = stringifyToml(stripUndefined(merged));
    const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
    await writeFile(tmp, serialized);
    await rename(tmp, file);
    return ok({ file });
  } catch (e) {
    return err(configError(`save failed: ${errorMessage(e)}`, { file }));
  } finally {
    if (release) await release().catch(() => {});
  }
};
