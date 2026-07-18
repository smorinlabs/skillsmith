import { SUPPORTED_TOOLS } from '../agents/registry.ts';
import { hashManifestSemantics } from '../artifacts/hash.ts';
import { type PortableLockV1, serializePortableLock } from '../artifacts/lock.ts';
import { manifestV1Codec } from '../artifacts/manifest-codec.ts';
import { type ManifestEdit, editManifestBytes } from '../artifacts/manifest-edit.ts';
import type { NormalizedManifestDeclaration, NormalizedManifestV1 } from '../artifacts/types.ts';
import { type Result, err, ok } from '../result.ts';
import type { ExportObservation } from './observe.ts';
import type { ExportFailure, PortableExportCandidate } from './types.ts';

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

const failure = (code: string, message: string, exitClass: ExportFailure['exitClass']) =>
  err<ExportFailure>(Object.freeze({ code, message, exitClass }));

export const mergePortableCandidates = (
  candidates: readonly PortableExportCandidate[],
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
    if (group.some((candidate) => !sameCandidate(first, candidate))) {
      return failure(
        'export-selected-conflict',
        `portable candidates conflict for ${name}`,
        'usage',
      );
    }
    const tools = [...new Set(group.flatMap((candidate) => candidate.tools))].sort(compareTools);
    if (first.path !== null && tools.length > 1) {
      return failure(
        'export-custom-path-conflict',
        `custom-path declaration cannot merge tools for ${name}`,
        'usage',
      );
    }
    merged.push(Object.freeze({ ...first, tools: Object.freeze(tools) }));
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
    if (existing.path !== null && tools.length > 1) {
      return failure(
        'export-custom-path-conflict',
        `custom-path declaration cannot merge tools for ${candidate.name}`,
        'usage',
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
  const merged = mergePortableCandidates(rawCandidates);
  if (!merged.ok) return merged;
  if (merged.value.length === 0) {
    return failure('export-no-portable', 'no portable candidates survived', 'failure');
  }

  const beforeManifest =
    observation.manifest?.state === 'present'
      ? observation.manifest.model
      : Object.freeze({ version: 1 as const, skills: Object.freeze([]) });
  const edits = candidateEdits(beforeManifest, merged.value, observation.request.force);
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
      const decoded = manifestV1Codec.decode(edited.value.bytes);
      if (!decoded.ok)
        return failure('export-manifest-edit', 'edited manifest is invalid', 'state');
      manifest = decoded.value.model;
      manifestBytes = edited.value.bytes;
      manifestChanged = edited.value.changed || edited.value.migrated;
    }
  } else {
    manifest = Object.freeze({
      version: 1 as const,
      skills: Object.freeze(merged.value.map(declarationOf)),
    });
    const encoded = manifestV1Codec.encode(manifest);
    if (!encoded.ok)
      return failure('export-manifest-encode', 'manifest encoding failed', 'failure');
    manifestBytes = encoded.value;
    manifestChanged = true;
  }

  const candidateByName = new Map(merged.value.map((candidate) => [candidate.name, candidate]));
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

  return ok(
    Object.freeze({
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
