import { join } from 'node:path';
import { z } from 'zod';
import { type SkillSmithError, configError, errorMessage } from '../errors.ts';
import { rethrowInventoryReadFailure, throwIfInventoryCancelled } from '../inventory-control.ts';
import type { InventoryReadPorts, PlatformPaths } from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';
import type { PluginInstallation } from './types.ts';

const InstallationEntrySchema = z.object({
  scope: z.enum(['managed', 'user', 'project', 'local']),
  installPath: z.string(),
  version: z.string(),
  projectPath: z.string().optional(),
});

const FileSchema = z.object({
  version: z.number().optional(),
  plugins: z.record(z.array(InstallationEntrySchema)),
});

export const getInstalledPluginsPath = (env: Pick<PlatformPaths, 'homeDir'>): string =>
  join(env.homeDir, '.claude', 'plugins', 'installed_plugins.json');

export const readInstalledPlugins = async (
  env: InventoryReadPorts,
  signal?: AbortSignal,
): Promise<Result<PluginInstallation[], SkillSmithError>> => {
  const path = getInstalledPluginsPath(env);
  throwIfInventoryCancelled(signal);
  const exists = await env
    .fileExists(path)
    .catch((failure: unknown) => rethrowInventoryReadFailure(failure, path));
  throwIfInventoryCancelled(signal);
  if (!exists) return ok([]);

  throwIfInventoryCancelled(signal);
  const text = await env.readText(path).catch((failure: unknown) => {
    throwIfInventoryCancelled(signal);
    return rethrowInventoryReadFailure(failure, path);
  });
  throwIfInventoryCancelled(signal);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return err(
      configError(`installed_plugins.json parse error: ${errorMessage(e)}`, { file: path }),
    );
  }

  const validated = FileSchema.safeParse(parsed);
  if (!validated.success) {
    return err(
      configError(
        `installed_plugins.json schema error: ${validated.error.issues[0]?.message ?? 'invalid'}`,
        { file: path },
      ),
    );
  }

  const out: PluginInstallation[] = [];
  for (const [id, entries] of Object.entries(validated.data.plugins)) {
    throwIfInventoryCancelled(signal);
    for (const e of entries) {
      throwIfInventoryCancelled(signal);
      out.push({
        id,
        scope: e.scope,
        installPath: e.installPath,
        version: e.version,
        ...(e.projectPath !== undefined ? { projectPath: e.projectPath } : {}),
      });
    }
  }
  throwIfInventoryCancelled(signal);
  return ok(out);
};
