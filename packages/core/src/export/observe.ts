import { dirname, resolve } from 'node:path';
import type { BuiltInToolId } from '../agents/registry.ts';
import type { CurrentApplicationContext } from '../application/types.ts';
import type { ArtifactDigest } from '../artifacts/hash.ts';
import type { LedgerModel, LedgerPairV1Dto } from '../artifacts/ledger-types.ts';
import type { PortableLockV1 } from '../artifacts/lock.ts';
import type { ResolvedArtifactPair } from '../artifacts/pair.ts';
import {
  type ArtifactReadResult,
  readLedgerArtifact,
  readLockArtifact,
  readManifestArtifact,
} from '../artifacts/repository.ts';
import type { NormalizedManifestV1 } from '../artifacts/types.ts';
import type { ProjectContext } from '../context/types.ts';
import { safeErrorCode } from '../errors.ts';
import { projectSkillInventory } from '../inventory/index.ts';
import { inventoryRootOrdinalOf, tagInventoryRootOrdinal } from '../inventory/types.ts';
import type { SkillInventory, SkillInventoryEntry } from '../inventory/types.ts';
import { ledgerPathOf, resolveDataDir } from '../place/paths.ts';
import { contentHashOf } from '../place/store.ts';
import type { GitWorktreeInspection } from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';
import { observeSkillPlacements } from '../scan/list-skills.ts';
import type { SkillEntry } from '../skills/types.ts';
import type { ExportFailure, ExportRequest } from './types.ts';

export interface ExportEntryObservation {
  readonly entry: SkillInventoryEntry;
  readonly ledgerPair: LedgerPairV1Dto | null;
  readonly liveContentHash: ArtifactDigest | null;
  readonly git: GitWorktreeInspection | null;
  readonly defaultLocation: boolean;
}

export interface ExportObservation {
  readonly project: ProjectContext;
  readonly sourceProjectRoot: string | null;
  readonly homeDir: string;
  readonly request: ExportRequest;
  readonly pair: ResolvedArtifactPair | null;
  readonly inventory: SkillInventory;
  readonly entries: readonly ExportEntryObservation[];
  readonly ledger: ArtifactReadResult<LedgerModel>;
  readonly ledgerPath: string;
  readonly manifest: ArtifactReadResult<NormalizedManifestV1> | null;
  readonly lock: ArtifactReadResult<PortableLockV1> | null;
}

const failure = (
  code: string,
  message: string,
  exitClass: ExportFailure['exitClass'],
): Result<never, ExportFailure> => err(Object.freeze({ code, message, exitClass }));

const repositoryFailure = (
  role: 'manifest' | 'lock' | 'ledger',
  error: Readonly<{ readonly reason: string }>,
): Result<never, ExportFailure> =>
  failure(
    `export-${role}-state`,
    `${role} state is unavailable or invalid`,
    error.reason === 'permission-denied' ? 'permission' : 'state',
  );

const pairFor = (
  ledger: LedgerModel | null,
  entry: Pick<SkillEntry, 'name' | 'tool' | 'scope' | 'path'>,
  sourceProjectRoot: string | null,
): LedgerPairV1Dto | null => {
  if (ledger === null) return null;
  const skills =
    entry.scope === 'user'
      ? ledger.skills
      : entry.scope === 'project' && sourceProjectRoot !== null
        ? ledger.projects[sourceProjectRoot]?.skills
        : undefined;
  const pair = skills?.[entry.name]?.tools[entry.tool];
  return pair !== undefined && pair.placementPath === entry.path ? pair : null;
};

const sourceForPair = (pair: LedgerPairV1Dto): string | null =>
  pair.mode === 'dev'
    ? (pair.dev?.remote ?? pair.dev?.resolvedPath ?? pair.dev?.sourcePath ?? null)
    : (pair.origin?.source ?? pair.pinned?.storePath ?? null);

const enrichEntry = async (
  context: CurrentApplicationContext,
  entry: SkillEntry,
  ledger: LedgerModel | null,
  sourceProjectRoot: string | null,
): Promise<SkillEntry & Partial<SkillInventoryEntry>> => {
  const pair = pairFor(ledger, entry, sourceProjectRoot);
  const kind = await context.ports.pathKind(entry.path);
  const placement = kind === 'symlink' ? 'symlink' : kind === 'dir' ? 'copy' : 'unknown';
  const value = {
    ...entry,
    mode: pair?.mode ?? 'unmanaged',
    placement,
    source: pair === null ? null : sourceForPair(pair),
    revision: pair?.origin?.refResolved ?? pair?.pinned?.gitSha ?? pair?.pinned?.rev ?? null,
    store: pair?.pinned?.storePath ?? null,
    verification: pair?.pinned?.verify ?? 'unrecorded',
    description: entry.frontmatter?.description ?? null,
  } as const;
  return tagInventoryRootOrdinal(value, inventoryRootOrdinalOf(entry));
};

const selectedLedgerSkills = (
  ledger: LedgerModel | null,
  request: ExportRequest,
  sourceProjectRoot: string | null,
) =>
  ledger === null
    ? null
    : request.scope === 'user'
      ? ledger.skills
      : request.scope === 'project' && sourceProjectRoot !== null
        ? (ledger.projects[sourceProjectRoot]?.skills ?? null)
        : null;

const addLedgerOnlyPlacements = async (
  context: CurrentApplicationContext,
  entries: SkillEntry[],
  ledger: LedgerModel | null,
  request: ExportRequest,
  sourceProjectRoot: string | null,
): Promise<ReadonlySet<string>> => {
  const synthetic = new Set<string>();
  const skills = selectedLedgerSkills(ledger, request, sourceProjectRoot);
  if (skills === null) return synthetic;
  const selectedTools = new Set<string>(request.tools);
  const existing = new Set(entries.map((entry) => `${entry.tool}\0${entry.path}`));
  for (const name of Object.keys(skills).sort()) {
    const record = skills[name];
    if (record === undefined) continue;
    for (const tool of request.tools) {
      const pair = record.tools[tool];
      if (pair === undefined || !selectedTools.has(tool)) continue;
      const key = `${tool}\0${pair.placementPath}`;
      if (existing.has(key)) continue;
      const kind = await context.ports.pathKind(pair.placementPath);
      if (kind !== 'dir' && kind !== 'symlink') continue;
      const realpath = await context.ports.realpath(pair.placementPath);
      entries.push(
        tagInventoryRootOrdinal(
          {
            name,
            tool: tool as BuiltInToolId,
            scope: request.scope as 'user' | 'project',
            path: pair.placementPath,
            realpath,
            root: dirname(pair.placementPath),
            frontmatter: null,
            origin: { kind: 'standalone' as const },
            enabled: 'on' as const,
          },
          Number.MAX_SAFE_INTEGER,
        ),
      );
      existing.add(key);
      synthetic.add(key);
    }
  }
  return synthetic;
};

const entryFacts = async (
  context: CurrentApplicationContext,
  inventory: SkillInventory,
  ledger: LedgerModel | null,
  sourceProjectRoot: string | null,
  synthetic: ReadonlySet<string>,
): Promise<readonly ExportEntryObservation[]> => {
  const hashes = new Map<string, Promise<ArtifactDigest | null>>();
  const inspections = new Map<string, Promise<GitWorktreeInspection | null>>();
  const hashAt = (path: string): Promise<ArtifactDigest | null> => {
    const cached = hashes.get(path);
    if (cached !== undefined) return cached;
    const pending = contentHashOf(context.ports, path).then((result) => {
      if (result.ok) return result.value as ArtifactDigest;
      const code = safeErrorCode(result.error);
      if (
        context.signal?.aborted ||
        code === 'cancelled' ||
        code === 'EACCES' ||
        code === 'EPERM' ||
        code === 'permission-denied'
      ) {
        throw result.error;
      }
      return null;
    });
    hashes.set(path, pending);
    return pending;
  };
  const inspect = (repositoryRoot: string): Promise<GitWorktreeInspection | null> => {
    const key = resolve(repositoryRoot);
    const cached = inspections.get(key);
    if (cached !== undefined) return cached;
    const pending = context.ports.git
      .inspectWorktree({
        repositoryRoot,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      })
      .catch((error) => {
        const code = safeErrorCode(error);
        if (
          context.signal?.aborted ||
          code === 'cancelled' ||
          code === 'EACCES' ||
          code === 'EPERM' ||
          code === 'permission-denied'
        ) {
          throw error;
        }
        return null;
      });
    inspections.set(key, pending);
    return pending;
  };

  return Object.freeze(
    await Promise.all(
      inventory.entries.map(async (entry): Promise<ExportEntryObservation> => {
        const ledgerPair = pairFor(ledger, entry, sourceProjectRoot);
        const eligible =
          (entry.scope === 'user' || entry.scope === 'project') &&
          entry.visibility.state !== 'duplicate' &&
          entry.visibility.state !== 'shadowed' &&
          ledgerPair !== null;
        const liveContentHash = eligible ? await hashAt(entry.realpath) : null;
        const repositoryRoot =
          eligible && ledgerPair.mode === 'dev' ? ledgerPair.dev?.repoRoot : null;
        const git = repositoryRoot == null ? null : await inspect(repositoryRoot);
        return Object.freeze({
          entry,
          ledgerPair,
          liveContentHash,
          git,
          defaultLocation:
            !synthetic.has(`${entry.tool}\0${entry.path}`) && dirname(entry.path) === entry.root,
        });
      }),
    ),
  );
};

export const observeExport = async (
  context: CurrentApplicationContext,
  project: ProjectContext,
  request: ExportRequest,
  pair: ResolvedArtifactPair | null,
): Promise<Result<ExportObservation, ExportFailure>> => {
  try {
    const sourceProjectRoot =
      request.scope === 'project' ? (project.projectRoot ?? project.effectiveCwd) : null;
    const ledgerPath = ledgerPathOf(resolveDataDir(context.ports, context.configuration));
    const [ledgerRead, placementsRead, manifestRead, lockRead] = await Promise.all([
      readLedgerArtifact(context.ports, ledgerPath),
      observeSkillPlacements(context.ports, {
        tools: request.tools,
        scopes: [request.scope],
        cwd: sourceProjectRoot ?? project.effectiveCwd,
        configuration: context.configuration,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        observation: context.observation,
      }),
      pair === null ? Promise.resolve(null) : readManifestArtifact(context.ports, pair.file.path),
      pair === null ? Promise.resolve(null) : readLockArtifact(context.ports, pair.lockfile.path),
    ]);
    if (!ledgerRead.ok) return repositoryFailure('ledger', ledgerRead.error);
    if (!placementsRead.ok) {
      return failure(
        'export-inventory',
        'selected live inventory could not be read',
        placementsRead.error.code === 'permission-denied' ? 'permission' : 'state',
      );
    }
    if (manifestRead !== null && !manifestRead.ok) {
      return repositoryFailure('manifest', manifestRead.error);
    }
    if (lockRead !== null && !lockRead.ok) return repositoryFailure('lock', lockRead.error);

    const ledger = ledgerRead.value.state === 'present' ? ledgerRead.value.model : null;
    const raw = [...placementsRead.value];
    const synthetic = await addLedgerOnlyPlacements(
      context,
      raw,
      ledger,
      request,
      sourceProjectRoot,
    );
    const enriched = await Promise.all(
      raw.map((entry) => enrichEntry(context, entry, ledger, sourceProjectRoot)),
    );
    const inventory = projectSkillInventory(enriched, {
      tools: request.tools,
      scopes: [request.scope],
    });
    if (!inventory.ok) return failure('export-inventory', 'selected inventory is invalid', 'state');
    const entries = await entryFacts(
      context,
      inventory.value,
      ledger,
      sourceProjectRoot,
      synthetic,
    );

    return ok(
      Object.freeze({
        project,
        sourceProjectRoot,
        homeDir: context.ports.homeDir,
        request,
        pair,
        inventory: inventory.value,
        entries,
        ledger: ledgerRead.value,
        ledgerPath,
        manifest: manifestRead?.value ?? null,
        lock: lockRead?.value ?? null,
      }),
    );
  } catch (error) {
    if (context.signal?.aborted || safeErrorCode(error) === 'cancelled') {
      return failure('export-cancelled', 'export was cancelled', 'cancelled');
    }
    const code = safeErrorCode(error);
    if (code === 'EACCES' || code === 'EPERM' || code === 'permission-denied') {
      return failure('export-permission', 'export observation permission was denied', 'permission');
    }
    return failure('export-observation', 'export observation failed', 'failure');
  }
};
