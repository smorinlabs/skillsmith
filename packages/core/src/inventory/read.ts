import { Glob } from 'bun';
import type { InventoryIdentitySurface } from '../agents/adapter-types.ts';
import { toolRegistry } from '../agents/registry.ts';
import type { SupportedTool } from '../agents/types.ts';
import type { LedgerModel, LedgerPairV1Dto } from '../artifacts/ledger-types.ts';
import { readLedgerArtifact } from '../artifacts/repository.ts';
import type { CommandEntry } from '../commands/types.ts';
import type { Scope } from '../config/types.ts';
import {
  type SkillSmithError,
  configError,
  ledgerError,
  permissionDeniedError,
} from '../errors.ts';
import { ledgerPathOf, resolveDataDir } from '../place/paths.ts';
import type { InventoryReadPorts } from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';
import { type ListCommandsOpts, observeCommandPlacements } from '../scan/list-commands.ts';
import { type ListSkillsOpts, observeSkillPlacements } from '../scan/list-skills.ts';
import type { Frontmatter, Origin, SkillEntry } from '../skills/types.ts';
import { throwIfInventoryCancelled } from './cancellation.ts';
import {
  inventoryCollisionKey,
  inventoryPlacementKey,
  resolveInventoryWinner,
} from './collisions.ts';
import {
  canonicalInventoryScopes,
  canonicalInventoryTools,
  compareCommandInventoryEntries,
  compareInventoryText,
  compareSkillInventoryEntries,
} from './order.ts';
import type {
  CommandInventory,
  CommandInventoryEntry,
  InventoryCollisionGroup,
  InventoryFilterValue,
  InventoryMember,
  InventoryMode,
  InventoryPlacement,
  InventorySelection,
  InventoryVerification,
  InventoryVisibility,
  SkillInventory,
  SkillInventoryEntry,
} from './types.ts';

export interface ReadSkillInventoryOptions extends ListSkillsOpts {
  modeFilter?: InventoryMode;
  sourceGlob?: string;
  revisionGlob?: string;
  descriptionGlob?: string;
  verificationFilter?: 'verified' | 'unverified';
}

export type ReadCommandInventoryOptions = ListCommandsOpts;

export interface ProjectSkillInventoryOptions {
  readonly tools?: readonly SupportedTool[];
  readonly scopes?: readonly Scope[];
  readonly globs?: readonly string[];
  readonly duplicatesOnly?: boolean;
  readonly enabledFilter?: 'enabled-only' | 'disabled-only' | 'unconfigured-only';
  readonly modeFilter?: InventoryMode;
  readonly sourceGlob?: string;
  readonly revisionGlob?: string;
  readonly descriptionGlob?: string;
  readonly verificationFilter?: 'verified' | 'unverified';
  readonly filters?: Readonly<Record<string, InventoryFilterValue>>;
}

const deepFreeze = <T>(value: T, seen = new Set<object>()): T => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
};

const cloneFrontmatter = (value: Frontmatter | null): Frontmatter | null =>
  value === null ? null : { ...value };

const cloneOrigin = (origin: Origin): Origin => {
  if (origin.kind === 'plugin') return { ...origin };
  return { kind: origin.kind };
};

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== 'object') return value;
  const record = value as Readonly<Record<string, unknown>>;
  return Object.fromEntries(
    Object.keys(record)
      .sort(compareInventoryText)
      .map((key) => [key, stableValue(record[key])]),
  );
};

const renderedSkillFacts = (entry: SkillEntry, runtimeName: string): string =>
  JSON.stringify(
    stableValue({
      name: runtimeName,
      tool: entry.tool,
      scope: entry.scope,
      path: entry.path,
      realpath: entry.realpath,
      root: entry.root,
      frontmatter: entry.frontmatter,
      origin: entry.origin,
      enabled: entry.enabled,
      mode: (entry as Partial<SkillInventoryEntry>).mode,
      placement: (entry as Partial<SkillInventoryEntry>).placement,
      source: (entry as Partial<SkillInventoryEntry>).source,
      revision: (entry as Partial<SkillInventoryEntry>).revision,
      store: (entry as Partial<SkillInventoryEntry>).store,
      verification: (entry as Partial<SkillInventoryEntry>).verification,
      description: (entry as Partial<SkillInventoryEntry>).description,
    }),
  );

const filterRecord = (options: ProjectSkillInventoryOptions): InventorySelection['filters'] => {
  if (options.filters !== undefined) {
    return deepFreeze(
      Object.fromEntries(
        Object.entries(options.filters).map(([key, value]) => [
          key,
          Array.isArray(value) ? [...value] : value,
        ]),
      ),
    );
  }
  return deepFreeze({
    globs: options.globs === undefined ? null : [...options.globs],
    duplicatesOnly: options.duplicatesOnly ?? false,
    enabledFilter: options.enabledFilter ?? null,
    modeFilter: options.modeFilter ?? null,
    sourceGlob: options.sourceGlob ?? null,
    revisionGlob: options.revisionGlob ?? null,
    descriptionGlob: options.descriptionGlob ?? null,
    verificationFilter: options.verificationFilter ?? null,
  });
};

const hasActiveFilters = (filters: InventorySelection['filters']): boolean =>
  Object.values(filters).some((value) =>
    Array.isArray(value) ? value.length > 0 : value !== null && value !== false,
  );

interface ProjectedSkill {
  readonly entry: SkillEntry;
  readonly name: string;
  readonly surface: InventoryIdentitySurface;
}

const projectIdentity = (entry: SkillEntry): ProjectedSkill => {
  const adapter = toolRegistry.get(entry.tool);
  const surface = deepFreeze({
    name: entry.name,
    scope: entry.scope,
    origin: cloneOrigin(entry.origin),
    rootOrdinal: 0,
    root: entry.root,
    path: entry.path,
    realpath: entry.realpath,
  });
  const name = adapter?.inventory.inventoryIdentity?.(surface) ?? entry.name;
  if (name.length === 0 || name.includes('\u0000')) {
    throw new Error(`invalid inventory identity for ${entry.tool}`);
  }
  return { entry, name, surface: deepFreeze({ ...surface, name }) };
};

const normalizedPlacements = (
  observations: readonly SkillEntry[],
): Result<readonly ProjectedSkill[], SkillSmithError> => {
  const byPlacement = new Map<string, { value: ProjectedSkill; facts: string }>();
  try {
    for (const observation of observations) {
      const projected = projectIdentity(observation);
      const key = inventoryPlacementKey(observation.tool, projected.surface);
      const facts = renderedSkillFacts(observation, projected.name);
      const retained = byPlacement.get(key);
      if (retained === undefined) {
        byPlacement.set(key, { value: projected, facts });
      } else if (retained.facts !== facts) {
        return err(
          configError(
            `conflicting inventory observations for ${observation.tool}:${projected.name} at ${observation.path}`,
          ),
        );
      }
    }
  } catch (cause) {
    return err(configError(cause instanceof Error ? cause.message : 'invalid inventory identity'));
  }
  return ok([...byPlacement.values()].map(({ value }) => value));
};

const compareProjectedSkills = (left: ProjectedSkill, right: ProjectedSkill): number =>
  compareSkillInventoryEntries(
    { ...left.entry, name: left.name },
    { ...right.entry, name: right.name },
  );

const memberOf = (projected: ProjectedSkill): InventoryMember =>
  deepFreeze({ scope: projected.entry.scope, path: projected.entry.path });

const baseSkillEntry = (
  projected: ProjectedSkill,
  visibility: InventoryVisibility,
): SkillInventoryEntry => {
  const supplied = projected.entry as Partial<SkillInventoryEntry>;
  const mode: InventoryMode =
    supplied.mode === 'dev' || supplied.mode === 'pinned' || supplied.mode === 'unmanaged'
      ? supplied.mode
      : 'unmanaged';
  const placement: InventoryPlacement =
    supplied.placement === 'symlink' ||
    supplied.placement === 'copy' ||
    supplied.placement === 'unknown'
      ? supplied.placement
      : 'unknown';
  const verification: InventoryVerification =
    supplied.verification === 'passed' ||
    supplied.verification === 'warned' ||
    supplied.verification === 'skipped' ||
    supplied.verification === 'unrecorded'
      ? supplied.verification
      : 'unrecorded';
  const nullableText = (value: unknown): string | null =>
    typeof value === 'string' ? value : null;
  return deepFreeze({
    name: projected.name,
    tool: projected.entry.tool,
    scope: projected.entry.scope,
    path: projected.entry.path,
    realpath: projected.entry.realpath,
    root: projected.entry.root,
    frontmatter: cloneFrontmatter(projected.entry.frontmatter),
    origin: cloneOrigin(projected.entry.origin),
    enabled: projected.entry.enabled,
    mode,
    placement,
    source: nullableText(supplied.source),
    revision: nullableText(supplied.revision),
    store: nullableText(supplied.store),
    verification,
    description:
      supplied.description === null || typeof supplied.description === 'string'
        ? supplied.description
        : (projected.entry.frontmatter?.description ?? null),
    visibility,
  });
};

const visibilityFor = (
  group: readonly ProjectedSkill[],
): Result<
  Readonly<{
    entries: readonly SkillInventoryEntry[];
    collision: InventoryCollisionGroup | null;
  }>,
  SkillSmithError
> => {
  const members = deepFreeze(group.map(memberOf));
  if (group.length === 1) {
    const visibility = deepFreeze({ state: 'unique', winner: null, members } as const);
    return ok(
      deepFreeze({
        entries: [baseSkillEntry(group[0] as ProjectedSkill, visibility)],
        collision: null,
      }),
    );
  }

  const first = group[0] as ProjectedSkill;
  const resolved = resolveInventoryWinner(
    first.entry.tool,
    first.name,
    deepFreeze(group.map((candidate) => candidate.surface)),
  );
  if (!resolved.ok) return resolved;
  const winner = resolved.value;
  const entries = group.map((candidate): SkillInventoryEntry => {
    const visibility: InventoryVisibility =
      winner === null
        ? deepFreeze({ state: 'duplicate', winner: null, members } as const)
        : candidate.entry.path === winner
          ? deepFreeze({ state: 'winner', winner, members } as const)
          : deepFreeze({ state: 'shadowed', winner, members } as const);
    return baseSkillEntry(candidate, visibility);
  });
  return ok(
    deepFreeze({
      entries,
      collision: {
        tool: first.entry.tool,
        name: first.name,
        winner,
        members,
      },
    }),
  );
};

const matchesOptionalGlob = (value: string | null, pattern: string | undefined): boolean =>
  pattern === undefined || (value !== null && new Glob(pattern).match(value));

const applySkillFilters = (
  entries: readonly SkillInventoryEntry[],
  options: ProjectSkillInventoryOptions,
): readonly SkillInventoryEntry[] => {
  const nameGlobs = options.globs?.map((pattern) => new Glob(pattern));
  return entries.filter((entry) => {
    if (nameGlobs !== undefined && !nameGlobs.some((glob) => glob.match(entry.name))) return false;
    if (options.duplicatesOnly && entry.visibility.state === 'unique') return false;
    if (options.enabledFilter === 'enabled-only' && entry.enabled !== 'on') return false;
    if (options.enabledFilter === 'disabled-only' && entry.enabled !== 'off') return false;
    if (options.enabledFilter === 'unconfigured-only' && entry.enabled !== 'unset') return false;
    if (options.modeFilter !== undefined && entry.mode !== options.modeFilter) return false;
    if (!matchesOptionalGlob(entry.source, options.sourceGlob)) return false;
    if (!matchesOptionalGlob(entry.revision, options.revisionGlob)) return false;
    if (!matchesOptionalGlob(entry.description, options.descriptionGlob)) return false;
    if (options.verificationFilter === 'verified' && entry.verification !== 'passed') return false;
    if (
      options.verificationFilter === 'unverified' &&
      !(['warned', 'skipped', 'unrecorded'] as const).includes(entry.verification as never)
    ) {
      return false;
    }
    return true;
  });
};

export const projectSkillInventory = (
  observations: readonly SkillEntry[],
  options: ProjectSkillInventoryOptions = {},
): Result<SkillInventory, SkillSmithError> => {
  const normalized = normalizedPlacements(observations);
  if (!normalized.ok) return normalized;
  const tools = canonicalInventoryTools(options.tools);
  const scopes = canonicalInventoryScopes(options.scopes);
  const toolSet = new Set(tools);
  const scopeSet = new Set(scopes);
  const sorted = normalized.value
    .filter((entry) => toolSet.has(entry.entry.tool) && scopeSet.has(entry.entry.scope))
    .sort(compareProjectedSkills);

  const groups = new Map<string, ProjectedSkill[]>();
  for (const entry of sorted) {
    const key = inventoryCollisionKey(entry.entry.tool, entry.name);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [entry]);
    else group.push(entry);
  }

  const entries: SkillInventoryEntry[] = [];
  const collisionGroups: InventoryCollisionGroup[] = [];
  for (const group of groups.values()) {
    const projected = visibilityFor(group);
    if (!projected.ok) return projected;
    entries.push(...projected.value.entries);
    if (projected.value.collision !== null) collisionGroups.push(projected.value.collision);
  }
  entries.sort(compareSkillInventoryEntries);
  const filters = filterRecord(options);
  let filtered: readonly SkillInventoryEntry[];
  try {
    filtered = applySkillFilters(entries, options);
  } catch {
    return err(configError('inventory filter pattern is invalid'));
  }
  const selection: InventorySelection = deepFreeze({
    source: 'bounded-default',
    tools,
    scopes,
    filters,
    outcome: hasActiveFilters(filters) && filtered.length === 0 ? 'filter-noop' : 'selected',
  });
  return ok(
    deepFreeze({
      selection,
      entries: [...filtered],
      collisionGroups,
    }),
  );
};

const placementOf = async (
  ports: InventoryReadPorts,
  path: string,
): Promise<InventoryPlacement> => {
  const kind = await ports.pathKind(path);
  if (kind === 'symlink') return 'symlink';
  if (kind === 'dir') return 'copy';
  return 'unknown';
};

const ledgerPairFor = (
  ledger: LedgerModel | null,
  entry: SkillEntry,
  runtimeName: string,
  projectRoot: string,
): LedgerPairV1Dto | null => {
  if (ledger === null || (entry.scope !== 'user' && entry.scope !== 'project')) return null;
  const skills = entry.scope === 'user' ? ledger.skills : ledger.projects[projectRoot]?.skills;
  const pair = skills?.[runtimeName]?.tools[entry.tool];
  return pair !== undefined && pair.placementPath === entry.path ? pair : null;
};

const sourceForPair = (pair: LedgerPairV1Dto): string | null => {
  if (pair.mode === 'dev') {
    return pair.dev?.remote ?? pair.dev?.resolvedPath ?? pair.dev?.sourcePath ?? null;
  }
  return (
    pair.origin?.source ??
    pair.dev?.remote ??
    pair.dev?.resolvedPath ??
    pair.dev?.sourcePath ??
    null
  );
};

const enrichObservedSkill = async (
  env: InventoryReadPorts,
  projected: ProjectedSkill,
  ledger: LedgerModel | null,
  projectRoot: string,
): Promise<SkillEntry & Partial<SkillInventoryEntry>> => {
  const pair = ledgerPairFor(ledger, projected.entry, projected.name, projectRoot);
  const placement = await placementOf(env, projected.entry.path);
  if (pair === null) {
    return {
      ...projected.entry,
      mode: 'unmanaged',
      placement,
      source: null,
      revision: null,
      store: null,
      verification: 'unrecorded',
      description: projected.entry.frontmatter?.description ?? null,
    };
  }
  if (pair.mode === 'dev') {
    return {
      ...projected.entry,
      mode: 'dev',
      placement,
      source: sourceForPair(pair),
      revision: null,
      store: null,
      verification: 'unrecorded',
      description: projected.entry.frontmatter?.description ?? null,
    };
  }
  return {
    ...projected.entry,
    mode: 'pinned',
    placement,
    source: sourceForPair(pair),
    revision: pair.origin?.refResolved ?? pair.pinned?.gitSha ?? pair.pinned?.rev ?? null,
    store: pair.pinned?.storePath ?? null,
    verification: pair.pinned?.verify ?? 'unrecorded',
    description: projected.entry.frontmatter?.description ?? null,
  };
};

export const readSkillInventory = async (
  env: InventoryReadPorts,
  options: ReadSkillInventoryOptions,
): Promise<Result<SkillInventory, SkillSmithError>> => {
  throwIfInventoryCancelled(options.signal);
  const ledgerPath = ledgerPathOf(resolveDataDir(env, options.configuration));
  const ledgerRead = await readLedgerArtifact(env, ledgerPath);
  throwIfInventoryCancelled(options.signal);
  if (!ledgerRead.ok) {
    return ledgerRead.error.exitCode === 6
      ? err(permissionDeniedError(ledgerRead.error.message, ledgerPath))
      : err(ledgerError(ledgerRead.error.message, ledgerPath));
  }
  const ledger = ledgerRead.value.state === 'present' ? ledgerRead.value.model : null;
  const observed = await observeSkillPlacements(env, options);
  if (!observed.ok) return observed;
  const normalized = normalizedPlacements(observed.value);
  if (!normalized.ok) return normalized;
  const enriched: Array<SkillEntry & Partial<SkillInventoryEntry>> = [];
  for (const observation of normalized.value) {
    throwIfInventoryCancelled(options.signal);
    enriched.push(await enrichObservedSkill(env, observation, ledger, options.cwd));
  }
  return projectSkillInventory(enriched, options);
};

const commandFacts = (entry: CommandEntry): string => JSON.stringify(stableValue(entry));

const commandFilters = (options: ReadCommandInventoryOptions): InventorySelection['filters'] =>
  deepFreeze({
    globs: options.globs === undefined ? null : [...options.globs],
    enabledFilter: options.enabledFilter ?? null,
  });

export const readCommandInventory = async (
  env: InventoryReadPorts,
  options: ReadCommandInventoryOptions,
): Promise<Result<CommandInventory, SkillSmithError>> => {
  throwIfInventoryCancelled(options.signal);
  const observed = await observeCommandPlacements(env, options);
  if (!observed.ok) return observed;
  const tools = canonicalInventoryTools(options.tools);
  const toolSet = new Set(tools);
  const scopes = canonicalInventoryScopes(options.scopes ?? ['user', 'project']).filter(
    (scope): scope is 'user' | 'project' => scope === 'user' || scope === 'project',
  );
  const scopeSet = new Set<Scope>(scopes);
  const byPlacement = new Map<string, { entry: CommandEntry; facts: string }>();
  for (const entry of observed.value) {
    const key = [entry.tool, entry.scope, entry.name, entry.path].join('\u0000');
    const facts = commandFacts(entry);
    const retained = byPlacement.get(key);
    if (retained === undefined) byPlacement.set(key, { entry, facts });
    else if (retained.facts !== facts) {
      return err(configError(`conflicting command inventory observations at ${entry.path}`));
    }
  }
  let globs: readonly Glob[] | undefined;
  try {
    globs = options.globs?.map((pattern) => new Glob(pattern));
  } catch {
    return err(configError('command inventory filter pattern is invalid'));
  }
  const entries = [...byPlacement.values()]
    .map(
      ({ entry }): CommandInventoryEntry =>
        deepFreeze({
          name: entry.name,
          tool: entry.tool,
          scope: entry.scope as 'user' | 'project',
          path: entry.path,
          realpath: entry.realpath,
          root: entry.root,
          frontmatter: cloneFrontmatter(entry.frontmatter),
          origin: cloneOrigin(entry.origin),
          enabled: entry.enabled,
          description: entry.frontmatter?.description ?? null,
        }),
    )
    .filter((entry) => toolSet.has(entry.tool) && scopeSet.has(entry.scope))
    .filter((entry) => globs === undefined || globs.some((glob) => glob.match(entry.name)))
    .filter(
      (entry) =>
        options.enabledFilter === undefined ||
        (options.enabledFilter === 'enabled-only' && entry.enabled === 'on') ||
        (options.enabledFilter === 'disabled-only' && entry.enabled === 'off') ||
        (options.enabledFilter === 'unconfigured-only' && entry.enabled === 'unset'),
    )
    .sort(compareCommandInventoryEntries);
  const filters = commandFilters(options);
  return ok(
    deepFreeze({
      selection: {
        source: 'bounded-default',
        tools,
        scopes,
        filters,
        outcome: hasActiveFilters(filters) && entries.length === 0 ? 'filter-noop' : 'selected',
      },
      entries,
    }),
  );
};
