import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { BuiltInToolId } from '../agents/registry.ts';
import {
  normalizePortablePath,
  normalizeSourceIdentity,
  validateManifestName,
  validateRequestedRef,
} from '../artifacts/identity.ts';
import type { LedgerModel, LedgerPairV1Dto } from '../artifacts/ledger-types.ts';
import type { SkillInventoryEntry } from '../inventory/types.ts';
import { type Result, err, ok } from '../result.ts';
import { containsSensitiveMaterial } from '../safety/redaction.ts';
import type { ExportEntryObservation, ExportObservation } from './observe.ts';
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

const skipped = (entry: SkillInventoryEntry, reason: ExportSkipReason): ExportResult =>
  Object.freeze({
    name: validateManifestName(entry.name, 'export.result.name').ok ? entry.name : 'invalid-name',
    tools: Object.freeze([entry.tool as BuiltInToolId]),
    scope: entry.scope,
    classification: reason,
    action: 'skipped',
    reason,
  });

const sameSource = (
  left: PortableExportCandidate['source'],
  right: PortableExportCandidate['source'],
): boolean =>
  left.host === right.host && left.repository === right.repository && left.path === right.path;

const containedBy = (root: string, target: string): boolean => {
  const displacement = relative(root, target);
  return (
    displacement === '' ||
    (!displacement.startsWith(`..${sep}`) && displacement !== '..' && !isAbsolute(displacement))
  );
};

const portablePlacementPath = (
  observation: ExportObservation,
  fact: ExportEntryObservation,
): string | null | ExportSkipReason => {
  if (fact.defaultLocation) return null;
  if (fact.entry.scope !== 'user' && fact.entry.scope !== 'project') return 'invalid-path';
  const scope = fact.entry.scope;
  const root = dirname(fact.entry.path);
  const base = scope === 'user' ? observation.homeDir : observation.sourceProjectRoot;
  if (base === null || !containedBy(resolve(base), resolve(root))) return 'invalid-path';
  const displacement = relative(resolve(base), resolve(root)).replaceAll('\\', '/');
  if (displacement.length === 0) return 'invalid-path';
  const token = `${scope === 'project' ? './' : '~/'}${displacement}`;
  const normalized = normalizePortablePath(token, scope, 'export.path');
  return normalized.ok && !containsSensitiveMaterial(normalized.value)
    ? normalized.value
    : 'invalid-path';
};

const candidateStringsAreSafe = (candidate: PortableExportCandidate): boolean =>
  [
    candidate.name,
    candidate.source.host,
    candidate.source.repository,
    candidate.source.path ?? '',
    candidate.sourceText,
    candidate.requestedRef ?? '',
    candidate.resolvedSha,
    candidate.sourcePath,
    candidate.contentHash,
    candidate.path ?? '',
  ].every((value) => !containsSensitiveMaterial(value));

const portableManaged = (
  observation: ExportObservation,
  fact: ExportEntryObservation,
  pair: LedgerPairV1Dto,
): PortableExportCandidate | ExportSkipReason => {
  const { entry } = fact;
  const origin = pair.origin;
  const pinned = pair.pinned;
  if (
    !validateManifestName(entry.name, 'export.candidate.name').ok ||
    (origin?.refRequested !== null &&
      origin?.refRequested !== undefined &&
      !validateRequestedRef(origin.refRequested, 'export.candidate.ref').ok)
  ) {
    return 'invalid-source';
  }
  if (
    pair.mode !== 'pinned' ||
    origin === undefined ||
    pinned == null ||
    pair.journal != null ||
    pinned.dirty ||
    !SHA1.test(origin.refResolved) ||
    !DIGEST.test(pinned.contentHash) ||
    (pinned.gitSha !== null && pinned.gitSha !== origin.refResolved) ||
    entry.placement === 'unknown' ||
    (pinned.placement !== undefined && pinned.placement !== entry.placement) ||
    (entry.placement === 'symlink' && resolve(entry.realpath) !== resolve(pinned.storePath))
  ) {
    return pair.journal == null ? 'incomplete-provenance' : 'pending-journal';
  }
  const normalized = normalizeSourceIdentity(origin.source);
  if (
    !normalized.ok ||
    normalized.value.host !== origin.host ||
    normalized.value.repository !== origin.repo ||
    (normalized.value.path ?? '.') !== origin.skillPath
  ) {
    return 'invalid-source';
  }
  if (fact.liveContentHash === null) return 'invalid-content';
  if (fact.liveContentHash !== pinned.contentHash) return 'live-content-mismatch';
  const path = portablePlacementPath(observation, fact);
  if (typeof path === 'string' && path === 'invalid-path') return path;
  const source = Object.freeze(normalized.value);
  const candidate = Object.freeze({
    name: entry.name,
    tools: Object.freeze([entry.tool as BuiltInToolId]),
    scope: entry.scope as 'user' | 'project',
    source,
    sourceText: sourceText(source),
    requestedRef: origin.refRequested,
    resolvedSha: origin.refResolved,
    sourcePath: origin.skillPath,
    contentHash: pinned.contentHash as PortableExportCandidate['contentHash'],
    placement: entry.placement,
    path,
    classification: 'portable-managed' as const,
  });
  return candidateStringsAreSafe(candidate) ? candidate : 'invalid-source';
};

const portableDev = (
  observation: ExportObservation,
  fact: ExportEntryObservation,
  pair: LedgerPairV1Dto,
): PortableExportCandidate | ExportSkipReason => {
  const { entry } = fact;
  const dev = pair.dev;
  if (!validateManifestName(entry.name, 'export.candidate.name').ok) return 'invalid-source';
  if (
    pair.mode !== 'dev' ||
    dev === null ||
    pair.journal != null ||
    dev.repoRoot === null ||
    dev.sourceRelPath === null ||
    dev.remote === null ||
    entry.placement === 'unknown'
  ) {
    return pair.journal == null ? 'non-git-dev' : 'pending-journal';
  }
  const inspected = fact.git;
  if (inspected === null) return 'non-git-dev';
  if (inspected.dirtySummary !== null) return 'dirty-git';
  if (
    !SHA1.test(inspected.headSha) ||
    inspected.remoteUrl === null ||
    resolve(inspected.repositoryRoot) !== resolve(dev.repoRoot) ||
    resolve(dev.resolvedPath) !== resolve(entry.realpath)
  ) {
    return 'incomplete-provenance';
  }
  const normalized = normalizeSourceIdentity(`${inspected.remoteUrl}//${dev.sourceRelPath}`);
  const recorded = normalizeSourceIdentity(`${dev.remote}//${dev.sourceRelPath}`);
  if (!normalized.ok || !recorded.ok || !sameSource(normalized.value, recorded.value)) {
    return 'invalid-source';
  }
  const sourceRelative = relative(resolve(dev.repoRoot), resolve(entry.realpath)).replaceAll(
    '\\',
    '/',
  );
  if (sourceRelative !== dev.sourceRelPath) return 'incomplete-provenance';
  if (fact.liveContentHash === null) return 'invalid-content';
  const path = portablePlacementPath(observation, fact);
  if (typeof path === 'string' && path === 'invalid-path') return path;
  const source = Object.freeze(normalized.value);
  const candidate = Object.freeze({
    name: entry.name,
    tools: Object.freeze([entry.tool as BuiltInToolId]),
    scope: entry.scope as 'user' | 'project',
    source,
    sourceText: sourceText(source),
    requestedRef: inspected.headSha,
    resolvedSha: inspected.headSha,
    sourcePath: dev.sourceRelPath,
    contentHash: fact.liveContentHash,
    placement: entry.placement,
    path,
    classification: 'portable-dev' as const,
  });
  return candidateStringsAreSafe(candidate) ? candidate : 'invalid-source';
};

const hasPendingLegacyJournal = (ledger: LedgerModel): boolean => {
  const collections = [
    ledger.skills,
    ...Object.values(ledger.projects).map(({ skills }) => skills),
  ];
  return collections.some((skills) =>
    Object.values(skills).some(({ tools }) =>
      Object.values(tools).some((pair) => pair?.journal != null),
    ),
  );
};

export interface ClassifiedExport {
  readonly portable: readonly PortableExportCandidate[];
  readonly results: readonly ExportResult[];
}

export const classifyExport = (
  observation: ExportObservation,
): Result<ClassifiedExport, ExportFailure> => {
  if (
    observation.ledger.state === 'present' &&
    (Object.keys(observation.ledger.model.transactions).length > 0 ||
      hasPendingLegacyJournal(observation.ledger.model))
  ) {
    return err(
      Object.freeze({
        code: 'export-pending-ledger-transaction',
        message: 'placements ledger has pending recovery state',
        exitClass: 'state' as const,
      }),
    );
  }

  const portable: PortableExportCandidate[] = [];
  const results: ExportResult[] = [];
  for (const fact of observation.entries) {
    const { entry } = fact;
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
    const pair = fact.ledgerPair;
    if (pair === null) {
      results.push(skipped(entry, entry.mode === 'unmanaged' ? 'unmanaged' : 'stale-ledger'));
      continue;
    }
    const candidate =
      pair.mode === 'pinned'
        ? portableManaged(observation, fact, pair)
        : portableDev(observation, fact, pair);
    if (typeof candidate === 'string') {
      results.push(skipped(entry, candidate));
      continue;
    }
    portable.push(candidate);
    results.push(Object.freeze({ ...candidate, action: 'add', reason: null }));
  }
  return ok(Object.freeze({ portable: Object.freeze(portable), results: Object.freeze(results) }));
};
