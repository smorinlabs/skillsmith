import { SUPPORTED_TOOLS } from '../agents/registry.ts';
import { hashManifestSemantics } from '../artifacts/hash.ts';
import {
  type PortableLockV1,
  correlatePortableLock,
  serializePortableLock,
} from '../artifacts/lock.ts';
import { type ManifestEdit, editManifestBytes } from '../artifacts/manifest-edit.ts';
import { artifactContractRegistry } from '../artifacts/registry.ts';
import type { NormalizedManifestDeclaration, NormalizedManifestV1 } from '../artifacts/types.ts';
import { type Result, err, ok } from '../result.ts';
import type { ExportObservation } from './observe.ts';
import type { ExportFailure, ExportResult, PortableExportCandidate } from './types.ts';

const compareTools = (left: string, right: string): number =>
  SUPPORTED_TOOLS.indexOf(left as (typeof SUPPORTED_TOOLS)[number]) -
  SUPPORTED_TOOLS.indexOf(right as (typeof SUPPORTED_TOOLS)[number]);

const sameSource = (
  left: PortableExportCandidate['source'],
  right: PortableExportCandidate['source'],
): boolean =>
  left.host === right.host && left.repository === right.repository && left.path === right.path;

const sameCandidate = (left: PortableExportCandidate, right: PortableExportCandidate): boolean =>
  left.name === right.name &&
  left.scope === right.scope &&
  sameSource(left.source, right.source) &&
  left.requestedRef === right.requestedRef &&
  left.resolvedSha === right.resolvedSha &&
  left.sourcePath === right.sourcePath &&
  left.contentHash === right.contentHash &&
  left.placement === right.placement &&
  left.path === right.path;

const sourceText = (source: PortableExportCandidate['source']): string =>
  `${source.host}/${source.repository}${source.path === null ? '' : `//${source.path}`}`;

const declarationOf = (candidate: PortableExportCandidate): NormalizedManifestDeclaration =>
  Object.freeze({
    name: candidate.name,
    source: Object.freeze({ ...candidate.source }),
    ref: candidate.requestedRef,
    tools: Object.freeze([...candidate.tools].sort(compareTools)),
    scope: candidate.scope,
    placement: candidate.placement,
    path: candidate.path,
  });

const lockEntryOf = (candidate: PortableExportCandidate) =>
  Object.freeze({
    name: candidate.name,
    source: candidate.sourceText,
    requestedRef: candidate.requestedRef,
    resolvedSha: candidate.resolvedSha,
    sourcePath: candidate.sourcePath,
    contentHash: candidate.contentHash,
  });

const failure = (
  code: string,
  message: string,
  exitClass: ExportFailure['exitClass'],
  conflicts: readonly ExportResult[] = [],
) =>
  err<ExportFailure>(
    Object.freeze({
      code,
      message,
      exitClass,
      ...(conflicts.length === 0 ? {} : { conflicts: Object.freeze(conflicts) }),
    }),
  );

const conflictResult = (
  candidate: PortableExportCandidate,
  reason: Extract<ExportResult, { action: 'conflict' }>['reason'],
): Extract<ExportResult, { action: 'conflict' }> =>
  Object.freeze({
    name: candidate.name,
    tools: Object.freeze([...candidate.tools]),
    scope: candidate.scope,
    classification: 'conflict',
    action: 'conflict',
    reason,
  });

export const mergePortableCandidates = (
  candidates: readonly PortableExportCandidate[],
  force = false,
): Result<readonly PortableExportCandidate[], ExportFailure> => {
  const groups = new Map<string, PortableExportCandidate[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.name);
    if (group === undefined) groups.set(candidate.name, [candidate]);
    else group.push(candidate);
  }
  const merged: PortableExportCandidate[] = [];
  for (const [name, group] of groups) {
    const first = group[0] as PortableExportCandidate;
    const flattenedTools = group.flatMap((candidate) => candidate.tools);
    if (new Set(flattenedTools).size !== flattenedTools.length) {
      return failure(
        'export-duplicate-selected-placement',
        `portable candidates contain a duplicate selected placement for ${name}`,
        'usage',
        group.map((candidate) => conflictResult(candidate, 'duplicate-selected-placement')),
      );
    }
    const tools = [...new Set(group.flatMap((candidate) => candidate.tools))].sort(compareTools);
    const incompatible = group.some((candidate) => !sameCandidate(first, candidate));
    if (incompatible && !force) {
      return failure(
        'export-selected-conflict',
        `portable candidates conflict for ${name}`,
        'usage',
        group.map((candidate) => conflictResult(candidate, 'selected-candidate-conflict')),
      );
    }
    const authoritative = incompatible
      ? [...group].sort((left, right) => compareTools(left.tools[0] ?? '', right.tools[0] ?? ''))[0]
      : first;
    if (authoritative === undefined) {
      return failure(
        'export-selected-conflict',
        `portable candidates conflict for ${name}`,
        'usage',
      );
    }
    if (authoritative.path !== null && tools.length > 1) {
      return failure(
        'export-custom-path-conflict',
        `custom-path declaration cannot merge tools for ${name}`,
        'usage',
        group.map((candidate) => conflictResult(candidate, 'custom-path-conflict')),
      );
    }
    merged.push(Object.freeze({ ...authoritative, tools: Object.freeze(tools) }));
  }
  return ok(Object.freeze(merged.sort((left, right) => left.name.localeCompare(right.name))));
};

const sameDeclaration = (
  declaration: NormalizedManifestDeclaration,
  candidate: PortableExportCandidate,
): boolean =>
  sameSource(declaration.source, candidate.source) &&
  declaration.ref === candidate.requestedRef &&
  declaration.scope === candidate.scope &&
  declaration.placement === candidate.placement &&
  declaration.path === candidate.path;

const sameDeclarationExceptRef = (
  declaration: NormalizedManifestDeclaration,
  candidate: PortableExportCandidate,
): boolean =>
  sameSource(declaration.source, candidate.source) &&
  declaration.scope === candidate.scope &&
  declaration.placement === candidate.placement &&
  declaration.path === candidate.path;

const preserveRequestedRefs = (
  manifest: NormalizedManifestV1,
  candidates: readonly PortableExportCandidate[],
): readonly PortableExportCandidate[] =>
  Object.freeze(
    candidates.map((candidate) => {
      const existing = manifest.skills.find(({ name }) => name === candidate.name);
      return existing !== undefined && sameDeclarationExceptRef(existing, candidate)
        ? Object.freeze({ ...candidate, requestedRef: existing.ref })
        : candidate;
    }),
  );

const candidateEdits = (
  manifest: NormalizedManifestV1,
  candidates: readonly PortableExportCandidate[],
  force: boolean,
): Result<readonly ManifestEdit[], ExportFailure> => {
  const edits: ManifestEdit[] = [];
  for (const candidate of candidates) {
    const existing = manifest.skills.find((declaration) => declaration.name === candidate.name);
    if (existing === undefined) {
      edits.push({ kind: 'add-skill', declaration: declarationOf(candidate) });
      continue;
    }
    const allExistingSelected = existing.tools.every((tool) => candidate.tools.includes(tool));
    if (!sameDeclaration(existing, candidate)) {
      if (!force || !allExistingSelected) {
        return failure(
          'export-existing-conflict',
          `existing declaration conflicts for ${candidate.name}`,
          'usage',
          [conflictResult(candidate, 'existing-declaration-conflict')],
        );
      }
      edits.push(
        {
          kind: 'set-skill-field',
          name: candidate.name,
          field: 'source',
          value: sourceText(candidate.source),
        },
        ...(candidate.requestedRef === null
          ? ([{ kind: 'unset-skill-field', name: candidate.name, field: 'ref' }] as const)
          : ([
              {
                kind: 'set-skill-field',
                name: candidate.name,
                field: 'ref',
                value: candidate.requestedRef,
              },
            ] as const)),
        { kind: 'set-skill-field', name: candidate.name, field: 'scope', value: candidate.scope },
        {
          kind: 'set-skill-field',
          name: candidate.name,
          field: 'placement',
          value: candidate.placement,
        },
        ...(candidate.path === null
          ? ([{ kind: 'unset-skill-field', name: candidate.name, field: 'path' }] as const)
          : ([
              {
                kind: 'set-skill-field',
                name: candidate.name,
                field: 'path',
                value: candidate.path,
              },
            ] as const)),
      );
    }
    const tools = [...new Set([...existing.tools, ...candidate.tools])].sort(compareTools);
    const resultingPath = sameDeclaration(existing, candidate) ? existing.path : candidate.path;
    if (resultingPath !== null && tools.length > 1) {
      return failure(
        'export-custom-path-conflict',
        `custom-path declaration cannot merge tools for ${candidate.name}`,
        'usage',
        [conflictResult(candidate, 'custom-path-conflict')],
      );
    }
    if (tools.join('\0') !== existing.tools.join('\0')) {
      edits.push({
        kind: 'set-skill-field',
        name: candidate.name,
        field: 'tools',
        value: tools,
      });
    }
  }
  return ok(Object.freeze(edits));
};

export interface PreparedExportArtifacts {
  readonly candidates: readonly PortableExportCandidate[];
  readonly candidateActions: Readonly<Record<string, 'add' | 'merge' | 'refresh' | 'unchanged'>>;
  readonly manifestEdits: readonly ManifestEdit[];
  readonly manifest: NormalizedManifestV1;
  readonly manifestBytes: Uint8Array;
  readonly manifestChanged: boolean;
  readonly manifestAction: 'create' | 'migrate' | 'update' | 'unchanged';
  readonly lock: PortableLockV1;
  readonly lockBytes: Uint8Array;
  readonly lockChanged: boolean;
  readonly lockAction: 'create' | 'refresh' | 'unchanged';
}

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((value, index) => right[index] === value);

export const prepareExportArtifacts = (
  observation: ExportObservation,
  rawCandidates: readonly PortableExportCandidate[],
): Result<PreparedExportArtifacts, ExportFailure> => {
  const merged = mergePortableCandidates(rawCandidates, observation.request.force);
  if (!merged.ok) return merged;
  if (merged.value.length === 0) {
    return failure('export-no-portable', 'no portable candidates survived', 'failure');
  }
  const manifestCodec = artifactContractRegistry.get('manifest', 1);
  if (manifestCodec === undefined) {
    return failure('export-manifest-codec', 'manifest codec is unavailable', 'failure');
  }

  const beforeManifest =
    observation.manifest?.state === 'present'
      ? observation.manifest.model
      : Object.freeze({ version: 1 as const, skills: Object.freeze([]) });
  if (
    observation.lock?.state === 'present' &&
    (observation.manifest?.state !== 'present' ||
      correlatePortableLock(beforeManifest, observation.lock.model).state !== 'current')
  ) {
    return failure('export-invalid-lock', 'existing portable lock is not current', 'state');
  }
  const candidates = preserveRequestedRefs(beforeManifest, merged.value);
  const edits = candidateEdits(beforeManifest, candidates, observation.request.force);
  if (!edits.ok) return edits;
  const migrationEdit: readonly ManifestEdit[] =
    observation.manifest?.state === 'present' && observation.manifest.sourceVersion === 'legacy'
      ? [{ kind: 'migrate-legacy' }]
      : [];
  const allEdits = Object.freeze([...migrationEdit, ...edits.value]);

  let manifest: NormalizedManifestV1;
  let manifestBytes: Uint8Array;
  let manifestChanged: boolean;
  if (observation.manifest?.state === 'present') {
    if (allEdits.length === 0) {
      manifest = observation.manifest.model;
      manifestBytes = new TextEncoder().encode(observation.manifest.source);
      manifestChanged = false;
    } else {
      const edited = editManifestBytes(new TextEncoder().encode(observation.manifest.source), {
        edits: allEdits,
      });
      if (!edited.ok) {
        return failure('export-manifest-edit', edited.error.message, 'state');
      }
      const decoded = manifestCodec.decode(edited.value.bytes);
      if (!decoded.ok)
        return failure('export-manifest-edit', 'edited manifest is invalid', 'state');
      manifest = decoded.value.model as NormalizedManifestV1;
      manifestBytes = edited.value.bytes;
      manifestChanged = edited.value.changed || edited.value.migrated;
    }
  } else {
    manifest = Object.freeze({
      version: 1 as const,
      skills: Object.freeze(candidates.map(declarationOf)),
    });
    const encoded = manifestCodec.encode(manifest);
    if (!encoded.ok)
      return failure('export-manifest-encode', 'manifest encoding failed', 'failure');
    manifestBytes = encoded.value;
    manifestChanged = true;
  }

  const candidateByName = new Map(candidates.map((candidate) => [candidate.name, candidate]));
  const existingLockByName = new Map(
    observation.lock?.state === 'present'
      ? observation.lock.model.skills.map((entry) => [entry.name, entry] as const)
      : [],
  );
  const lockSkills = [] as PortableLockV1['skills'][number][];
  for (const declaration of manifest.skills) {
    const candidate = candidateByName.get(declaration.name);
    if (candidate !== undefined) {
      lockSkills.push(lockEntryOf(candidate));
      continue;
    }
    const retained = existingLockByName.get(declaration.name);
    if (retained === undefined) {
      return failure(
        'export-incomplete-lock',
        `exact lock facts are unavailable for ${declaration.name}`,
        'state',
      );
    }
    lockSkills.push(retained);
  }
  lockSkills.sort((left, right) => left.name.localeCompare(right.name));
  const lock: PortableLockV1 = Object.freeze({
    version: 1,
    hashSchemaVersion: 1,
    manifestHash: hashManifestSemantics(manifest),
    skills: Object.freeze(lockSkills),
  });
  const serializedLock = serializePortableLock(lock);
  if (!serializedLock.ok) return failure('export-lock-encode', 'lock encoding failed', 'failure');
  const lockBytes = new TextEncoder().encode(serializedLock.value);
  const beforeLockBytes =
    observation.lock?.state === 'present'
      ? new TextEncoder().encode(observation.lock.source)
      : new Uint8Array();
  const lockChanged =
    observation.lock?.state !== 'present' || !equalBytes(beforeLockBytes, lockBytes);
  const candidateActions = Object.freeze(
    Object.fromEntries(
      candidates.map((candidate) => {
        const existing = beforeManifest.skills.find(({ name }) => name === candidate.name);
        if (existing === undefined) return [candidate.name, 'add'] as const;
        const tools = [...new Set([...existing.tools, ...candidate.tools])].sort(compareTools);
        if (
          !sameDeclaration(existing, candidate) ||
          tools.join('\0') !== existing.tools.join('\0')
        ) {
          return [candidate.name, 'merge'] as const;
        }
        const prior = existingLockByName.get(candidate.name);
        return [
          candidate.name,
          prior === undefined ||
          prior.source !== candidate.sourceText ||
          prior.requestedRef !== candidate.requestedRef ||
          prior.resolvedSha !== candidate.resolvedSha ||
          prior.sourcePath !== candidate.sourcePath ||
          prior.contentHash !== candidate.contentHash
            ? 'refresh'
            : 'unchanged',
        ] as const;
      }),
    ),
  );

  return ok(
    Object.freeze({
      candidates,
      candidateActions,
      manifestEdits: edits.value,
      manifest,
      manifestBytes,
      manifestChanged,
      manifestAction:
        observation.manifest?.state !== 'present'
          ? 'create'
          : observation.manifest.sourceVersion === 'legacy'
            ? 'migrate'
            : manifestChanged
              ? 'update'
              : 'unchanged',
      lock,
      lockBytes,
      lockChanged,
      lockAction:
        observation.lock?.state !== 'present' ? 'create' : lockChanged ? 'refresh' : 'unchanged',
    }),
  );
};
