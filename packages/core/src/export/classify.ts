import type { BuiltInToolId } from '../agents/registry.ts';
import type { CurrentApplicationContext } from '../application/types.ts';
import { normalizeSourceIdentity } from '../artifacts/identity.ts';
import type { LedgerModel, LedgerPairV1Dto } from '../artifacts/ledger-types.ts';
import type { SkillInventoryEntry } from '../inventory/types.ts';
import { contentHashOf } from '../place/store.ts';
import { type Result, err, ok } from '../result.ts';
import type { ExportObservation } from './observe.ts';
import type {
  ExportFailure,
  ExportResult,
  ExportSkipReason,
  PortableExportCandidate,
} from './types.ts';

const SHA1 = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;

const sourceText = (source: PortableExportCandidate['source']): string =>
  `${source.host}/${source.repository}${source.path === null ? '' : `//${source.path}`}`;

const pairFor = (
  ledger: LedgerModel,
  entry: SkillInventoryEntry,
  projectRoot: string | null,
): LedgerPairV1Dto | null => {
  const skills =
    entry.scope === 'user'
      ? ledger.skills
      : entry.scope === 'project' && projectRoot !== null
        ? ledger.projects[projectRoot]?.skills
        : undefined;
  const pair = skills?.[entry.name]?.tools[entry.tool];
  return pair !== undefined && pair.placementPath === entry.path ? pair : null;
};

const skipped = (entry: SkillInventoryEntry, reason: ExportSkipReason): ExportResult =>
  Object.freeze({
    name: entry.name,
    tools: Object.freeze([entry.tool as BuiltInToolId]),
    scope: entry.scope,
    classification: reason,
    action: 'skipped',
    reason,
  });

const contentHash = async (
  context: CurrentApplicationContext,
  path: string,
): Promise<string | null> => {
  const hashed = await contentHashOf(context.ports, path);
  return hashed.ok ? hashed.value : null;
};

const portableManaged = async (
  context: CurrentApplicationContext,
  entry: SkillInventoryEntry,
  pair: LedgerPairV1Dto,
): Promise<PortableExportCandidate | ExportSkipReason> => {
  const origin = pair.origin;
  const pinned = pair.pinned;
  if (
    pair.mode !== 'pinned' ||
    origin === undefined ||
    pinned == null ||
    pair.journal != null ||
    !SHA1.test(origin.refResolved) ||
    !DIGEST.test(pinned.contentHash)
  ) {
    return pair.journal == null ? 'incomplete-provenance' : 'pending-journal';
  }
  const normalized = normalizeSourceIdentity(origin.source);
  if (!normalized.ok) return 'invalid-source';
  const liveHash = await contentHash(context, entry.realpath);
  if (liveHash === null) return 'invalid-content';
  if (liveHash !== pinned.contentHash) return 'live-content-mismatch';
  const source = Object.freeze(normalized.value);
  return Object.freeze({
    name: entry.name,
    tools: Object.freeze([entry.tool as BuiltInToolId]),
    scope: entry.scope as 'user' | 'project',
    source,
    sourceText: sourceText(source),
    requestedRef: origin.refRequested,
    resolvedSha: origin.refResolved,
    sourcePath: origin.skillPath,
    contentHash: pinned.contentHash as PortableExportCandidate['contentHash'],
    placement: pinned.placement ?? (entry.placement === 'copy' ? 'copy' : 'symlink'),
    path: null,
    classification: 'portable-managed',
  });
};

const portableDev = async (
  context: CurrentApplicationContext,
  entry: SkillInventoryEntry,
  pair: LedgerPairV1Dto,
): Promise<PortableExportCandidate | ExportSkipReason> => {
  const dev = pair.dev;
  if (
    pair.mode !== 'dev' ||
    dev === null ||
    pair.journal != null ||
    dev.repoRoot === null ||
    dev.sourceRelPath === null ||
    dev.remote === null
  ) {
    return pair.journal == null ? 'non-git-dev' : 'pending-journal';
  }
  let inspected: Awaited<ReturnType<CurrentApplicationContext['ports']['git']['inspectWorktree']>>;
  try {
    inspected = await context.ports.git.inspectWorktree({
      repositoryRoot: dev.repoRoot,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
  } catch {
    return 'non-git-dev';
  }
  if (inspected.dirtySummary !== null) return 'dirty-git';
  if (!SHA1.test(inspected.headSha) || inspected.remoteUrl === null) return 'incomplete-provenance';
  const normalized = normalizeSourceIdentity(`${inspected.remoteUrl}//${dev.sourceRelPath}`);
  if (!normalized.ok) return 'invalid-source';
  const liveHash = await contentHash(context, entry.realpath);
  if (liveHash === null) return 'invalid-content';
  const source = Object.freeze(normalized.value);
  return Object.freeze({
    name: entry.name,
    tools: Object.freeze([entry.tool as BuiltInToolId]),
    scope: entry.scope as 'user' | 'project',
    source,
    sourceText: sourceText(source),
    requestedRef: inspected.headSha,
    resolvedSha: inspected.headSha,
    sourcePath: dev.sourceRelPath,
    contentHash: liveHash as PortableExportCandidate['contentHash'],
    placement: entry.placement === 'copy' ? 'copy' : 'symlink',
    path: null,
    classification: 'portable-dev',
  });
};

export interface ClassifiedExport {
  readonly portable: readonly PortableExportCandidate[];
  readonly results: readonly ExportResult[];
}

export const classifyExport = async (
  context: CurrentApplicationContext,
  observation: ExportObservation,
): Promise<Result<ClassifiedExport, ExportFailure>> => {
  if (
    observation.ledger.state === 'present' &&
    Object.keys(observation.ledger.model.transactions).length > 0
  ) {
    return err(
      Object.freeze({
        code: 'export-pending-ledger-transaction',
        message: 'placements ledger has a pending transaction',
        exitClass: 'state' as const,
      }),
    );
  }

  const portable: PortableExportCandidate[] = [];
  const results: ExportResult[] = [];
  for (const entry of observation.inventory.entries) {
    if (entry.scope !== 'user' && entry.scope !== 'project') {
      results.push(skipped(entry, 'unsupported-scope'));
      continue;
    }
    if (entry.visibility.state === 'duplicate' || entry.visibility.state === 'shadowed') {
      results.push(skipped(entry, 'ambiguous'));
      continue;
    }
    if (observation.ledger.state !== 'present') {
      results.push(skipped(entry, 'stale-ledger'));
      continue;
    }
    const pair = pairFor(observation.ledger.model, entry, observation.project.projectRoot);
    if (pair === null) {
      results.push(skipped(entry, entry.mode === 'unmanaged' ? 'unmanaged' : 'stale-ledger'));
      continue;
    }
    const candidate =
      pair.mode === 'pinned'
        ? await portableManaged(context, entry, pair)
        : await portableDev(context, entry, pair);
    if (typeof candidate === 'string') {
      results.push(skipped(entry, candidate));
      continue;
    }
    portable.push(candidate);
    results.push(Object.freeze({ ...candidate, action: 'add', reason: null }));
  }
  return ok(Object.freeze({ portable: Object.freeze(portable), results: Object.freeze(results) }));
};
