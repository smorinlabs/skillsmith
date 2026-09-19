import { join } from 'node:path';
import { z } from 'zod';
import { type SkillSmithError, configError, errorMessage } from '../../errors.ts';
import { rethrowInventoryReadFailure, throwIfInventoryCancelled } from '../../inventory-control.ts';
import type { InventoryReadPorts } from '../../ports/types.ts';
import { type Result, err, ok } from '../../result.ts';
import type { SkillEntry } from '../../skills/types.ts';
import type { StandaloneActivationResolver } from '../adapter-types.ts';

const SettingsSchema = z
  .object({
    skills: z
      .object({ activation: z.record(z.unknown()).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const isStringMap = (value: unknown): value is Record<string, string> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((entry) => typeof entry === 'string');

const readActivationRecords = async (
  env: InventoryReadPorts,
  path: string,
  signal?: AbortSignal,
): Promise<Result<ReadonlyArray<readonly [string, string]> | null, SkillSmithError>> => {
  throwIfInventoryCancelled(signal);
  const exists = await env
    .fileExists(path)
    .catch((failure: unknown) => rethrowInventoryReadFailure(failure, path));
  throwIfInventoryCancelled(signal);
  if (!exists) return ok(null);

  const text = await env.readText(path).catch((failure: unknown) => {
    throwIfInventoryCancelled(signal);
    return rethrowInventoryReadFailure(failure, path);
  });
  throwIfInventoryCancelled(signal);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (failure) {
    return err(configError(`muse settings parse error: ${errorMessage(failure)}`, { file: path }));
  }

  const validated = SettingsSchema.safeParse(parsed);
  if (!validated.success) {
    return err(
      configError(
        `muse settings schema error: ${validated.error.issues[0]?.message ?? 'invalid'}`,
        { file: path },
      ),
    );
  }
  const activation = validated.data.skills?.activation ?? {};
  const records: Array<readonly [string, string]> = [];
  for (const scopeMap of Object.values(activation)) {
    if (!isStringMap(scopeMap)) continue;
    for (const [skillPath, state] of Object.entries(scopeMap)) records.push([skillPath, state]);
  }
  return ok(records);
};

const normalizeSeparators = (value: string): string => value.replaceAll('\\', '/');

const expandRecordKey = (env: InventoryReadPorts, key: string): string =>
  normalizeSeparators(key)
    .replaceAll('$CONFIG_DIR', normalizeSeparators(join(env.xdg.config, 'muse')))
    .replaceAll('$HOME', normalizeSeparators(env.homeDir));

export const resolveStandaloneActivation: StandaloneActivationResolver = async (
  env,
  entries: SkillEntry[],
  signal,
) => {
  throwIfInventoryCancelled(signal);
  if (entries.length === 0) return;
  const settingsPath = join(env.xdg.config, 'muse', 'settings.json');
  const read = await readActivationRecords(env, settingsPath, signal);
  throwIfInventoryCancelled(signal);
  if (!read.ok) throw read.error;
  if (read.value === null) return;

  const byDocument = new Map<string, string>();
  for (const [skillPath, state] of read.value) {
    byDocument.set(expandRecordKey(env, skillPath), state);
  }
  for (const entry of entries) {
    const document = normalizeSeparators(join(entry.path, 'SKILL.md'));
    const state = byDocument.get(document);
    if (state === 'off') entry.enabled = 'off';
    else if (state === 'on') entry.enabled = 'on';
  }
};
