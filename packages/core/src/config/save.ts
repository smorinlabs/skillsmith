import { dirname } from 'node:path';
import { stringify as stringifyToml } from 'smol-toml';
import { type SkillSmithError, configError, errorMessage } from '../errors.ts';
import type {
  FileReadPort,
  FileWritePort,
  IdPort,
  LockPort,
  PlatformPaths,
} from '../ports/types.ts';
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

type SaveConfigPorts = PlatformPaths &
  Pick<FileReadPort, 'pathKind' | 'readText'> &
  Pick<FileWritePort, 'makeDir' | 'writeTextFile' | 'rename'> &
  LockPort &
  IdPort;

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
  ports: SaveConfigPorts,
  opts: SaveConfigOpts,
): Promise<Result<{ file: string }, SkillSmithError>> => {
  const file = getConfigPath(ports, opts.scope, opts.cwd);
  try {
    await ports.makeDir(dirname(file));
  } catch (e) {
    return err(configError(`cannot create directory for ${file}: ${errorMessage(e)}`, { file }));
  }

  try {
    return await ports.withFileLock(file, async () => {
      try {
        let existing: Config = {};
        const text = (await ports.pathKind(file)) === 'absent' ? '' : await ports.readText(file);
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
        const tmp = `${file}.tmp.${ports.nextId('config-save')}`;
        await ports.writeTextFile(tmp, serialized);
        await ports.rename(tmp, file);
        return ok({ file });
      } catch (e) {
        return err(configError(`save failed: ${errorMessage(e)}`, { file }));
      }
    });
  } catch (e) {
    return err(configError(`lock failed: ${errorMessage(e)}`, { file }));
  }
};
