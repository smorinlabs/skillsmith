import { join, relative } from 'node:path';
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
): Promise<Result<ReadonlyArray<readonly [string, string, string]> | null, SkillSmithError>> => {
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
  const records: Array<readonly [string, string, string]> = [];
  for (const [scope, scopeMap] of Object.entries(activation)) {
    if (!isStringMap(scopeMap)) continue;
    for (const [skillPath, state] of Object.entries(scopeMap))
      records.push([scope, skillPath, state]);
  }
  // Project records nest two levels deep under the plural `projects` key by
  // realpath'd workspace (`projects["<abs-ws>"][".agents/skills/<n>/SKILL.md"]`).
  // They flatten after the scope maps so the real format wins on conflicts.
  const projects = activation.projects;
  if (typeof projects === 'object' && projects !== null && !Array.isArray(projects)) {
    for (const [workspace, docs] of Object.entries(projects)) {
      if (!isStringMap(docs)) continue;
      for (const [rel, state] of Object.entries(docs)) {
        records.push(['project', join(workspace, rel), state]);
      }
    }
  }
  return ok(records);
};

const normalizeSeparators = (value: string): string => value.replaceAll('\\', '/');

const expandRecordKey = (env: InventoryReadPorts, key: string): string =>
  normalizeSeparators(key)
    .replaceAll('$CONFIG_DIR', normalizeSeparators(join(env.xdg.config, 'muse')))
    .replaceAll('$HOME', normalizeSeparators(env.homeDir));

const AGENTS_SKILLS_SUFFIX = '/.agents/skills';

// Nested `projects` records key the realpath'd workspace, while the scan root
// may still carry symlinks (macOS `/tmp` versus `/private/tmp`), so project
// entries resolve their document through the real workspace root.
const projectDocument = async (
  env: InventoryReadPorts,
  settingsPath: string,
  entry: SkillEntry,
): Promise<string | null> => {
  const root = normalizeSeparators(entry.root);
  if (!root.endsWith(AGENTS_SKILLS_SUFFIX)) return null;
  const workspace = root.slice(0, -AGENTS_SKILLS_SUFFIX.length);
  if (workspace.length === 0) return null;
  const resolved = await env
    .realpath(workspace)
    .catch((failure: unknown) => rethrowInventoryReadFailure(failure, settingsPath));
  const relSkill = normalizeSeparators(relative(entry.root, entry.path));
  if (relSkill === '' || relSkill === '.' || relSkill.startsWith('../')) return null;
  return normalizeSeparators(join(resolved, '.agents', 'skills', relSkill, 'SKILL.md'));
};

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

  // Records stay scoped: the same document may be inventoried under two scopes at
  // once (a repository rooted at $HOME shares the user compatibility root), so a
  // flattened lookup would let JSON property order decide between contradictory
  // records. Each entry reads only its own scope map and otherwise keeps the
  // on default.
  const byScope = new Map<string, Map<string, string>>();
  for (const [scope, skillPath, state] of read.value) {
    let byDocument = byScope.get(scope);
    if (!byDocument) {
      byDocument = new Map<string, string>();
      byScope.set(scope, byDocument);
    }
    byDocument.set(expandRecordKey(env, skillPath), state);
  }
  for (const entry of entries) {
    throwIfInventoryCancelled(signal);
    const raw = normalizeSeparators(join(entry.path, 'SKILL.md'));
    const table = byScope.get(entry.scope);
    // Project entries consult the nested record first and fall back to the
    // flat scope map, which keeps keys written against the unscanned path.
    const nested =
      entry.scope === 'project' ? await projectDocument(env, settingsPath, entry) : null;
    const state = (nested === null ? undefined : table?.get(nested)) ?? table?.get(raw);
    // Only `on`/`off` map onto the inventory flag. Third states such as
    // `user-invocable-only` (settings- or frontmatter-driven) keep the default.
    if (state === 'off') entry.enabled = 'off';
    else if (state === 'on') entry.enabled = 'on';
  }
};
