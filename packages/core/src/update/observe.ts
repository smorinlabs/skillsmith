import { join } from 'node:path';
import { defaultInstallSourceTransport } from '../acquire/resolve.ts';
import { resolveRemoteSource } from '../acquire/resolve.ts';
import { parseSource } from '../acquire/source.ts';
import type { AcquisitionPorts, InstallSourceTransport } from '../acquire/types.ts';
import { hashManifestSemantics } from '../artifacts/hash.ts';
import type { PortableLockSkillV1, PortableLockV1 } from '../artifacts/lock.ts';
import { serializePortableLock } from '../artifacts/lock.ts';
import { editManifestBytes } from '../artifacts/manifest-edit.ts';
import { normalizeManifestDocument, readManifestSource } from '../artifacts/manifest.ts';
import { hashSourceContentV1, projectSourceContent } from '../artifacts/source-content.ts';
import type { NormalizedManifestV1 } from '../artifacts/types.ts';
import { errorMessage, safeErrorCode, sourceUnresolvableError } from '../errors.ts';
import { resolveDataDir, storeRootOf } from '../place/paths.ts';
import type { LedgerFile } from '../place/types.ts';
import type { OperationDigest } from '../planning/types.ts';
import type { ResolvedRuntimeConfiguration } from '../ports/types.ts';
import type { ReconcilePreparedSourceV1 } from '../reconcile/apply-execution.ts';
import { type Result, err, ok } from '../result.ts';
import type { PreparedUpdateArtifactsV1 } from './artifacts.ts';
import { deriveUpdateCandidateV1 } from './candidates.ts';
import type {
  UpdateApplicationRequestV1,
  UpdateCandidateV1,
  UpdateRemoteRefInspectionV1,
  UpdateSelectedDeclarationV1,
} from './types.ts';

const EMPTY_LEDGER: LedgerFile = Object.freeze({
  schemaVersion: 1,
  kind: 'skillsmith.placements',
  updatedAt: '1970-01-01T00:00:00.000Z',
  skills: Object.freeze({}),
});

export interface UpdateObservedSelectionV1 {
  readonly selected: UpdateSelectedDeclarationV1;
  readonly currentLock: PortableLockSkillV1;
  readonly currentInspection: UpdateRemoteRefInspectionV1;
  readonly proposedInspection: UpdateRemoteRefInspectionV1;
  readonly candidate: UpdateCandidateV1;
  readonly source: ReconcilePreparedSourceV1 | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
}

export interface UpdateArtifactTransitionV1 {
  readonly skill: string;
  readonly manifestBeforeBytes: Uint8Array;
  readonly manifestAfterBytes: Uint8Array;
  readonly manifestBefore: NormalizedManifestV1;
  readonly manifestAfter: NormalizedManifestV1;
  readonly manifestEdit: Readonly<{
    readonly edits: readonly [
      Readonly<{
        readonly kind: 'set-skill-field';
        readonly name: string;
        readonly field: 'ref';
        readonly value: string;
      }>,
    ];
  }> | null;
  readonly lockBefore: PortableLockV1;
  readonly lockAfter: PortableLockV1;
  readonly lockAfterSource: string;
}

export interface PreparedUpdateObservationV1 {
  readonly selections: readonly UpdateObservedSelectionV1[];
  readonly transitions: readonly UpdateArtifactTransitionV1[];
  readonly manifest: NormalizedManifestV1;
  readonly manifestBytes: Uint8Array;
  readonly lock: PortableLockV1;
  readonly lockBytes: Uint8Array;
  cleanup(): Promise<void>;
}

export interface PrepareUpdateObservationRequestV1 {
  readonly artifacts: PreparedUpdateArtifactsV1;
  readonly request: UpdateApplicationRequestV1;
  readonly selections: readonly Readonly<{
    readonly selected: UpdateSelectedDeclarationV1;
    readonly currentInspection: UpdateRemoteRefInspectionV1;
    readonly proposedInspection: UpdateRemoteRefInspectionV1;
  }>[];
}

export interface PrepareUpdateObservationRuntimeV1 {
  readonly ports: AcquisitionPorts;
  readonly configuration: ResolvedRuntimeConfiguration;
  readonly signal?: AbortSignal;
}

export interface PrepareUpdateObservationErrorV1 {
  readonly code: string;
  readonly message: string;
  readonly exitClass: 'state' | 'source' | 'permission' | 'failure' | 'cancelled';
}

const failure = (
  code: string,
  message: string,
  exitClass: PrepareUpdateObservationErrorV1['exitClass'],
): PrepareUpdateObservationErrorV1 => Object.freeze({ code, message, exitClass });

const cleanupFailure = (error: unknown): PrepareUpdateObservationErrorV1 => {
  const code = safeErrorCode(error);
  const permission =
    code === 'permission' || code === 'permission-denied' || code === 'EACCES' || code === 'EPERM';
  return failure(
    'update-source-cleanup',
    permission
      ? 'temporary update source state could not be removed because permission was denied'
      : 'temporary update source state could not be removed',
    permission ? 'permission' : 'failure',
  );
};

const sourceTransportBoundTo = (expectedSha: string): InstallSourceTransport => ({
  ...defaultInstallSourceTransport,
  resolveRef: async () => ({ ok: true, value: expectedSha }),
  fetchRepo: async (ports, options) => {
    const fetched = await defaultInstallSourceTransport.fetchRepo(ports, options);
    if (!fetched.ok || fetched.value.sha === expectedSha) return fetched;
    return err(
      sourceUnresolvableError(
        'remote ref advanced after inspection; refusing to materialize unapproved source bytes',
      ),
    );
  },
});

const normalizedManifest = (
  bytes: Uint8Array,
): Result<NormalizedManifestV1, PrepareUpdateObservationErrorV1> => {
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return err(failure('update-manifest-invalid', 'updated manifest is not valid UTF-8', 'state'));
  }
  const document = readManifestSource(source);
  if (!document.ok) return err(failure('update-manifest-invalid', document.error.message, 'state'));
  const manifest = normalizeManifestDocument(document.value);
  return manifest.ok
    ? ok(manifest.value)
    : err(failure('update-manifest-invalid', manifest.error.message, 'state'));
};

const lockWith = (
  current: PortableLockV1,
  manifest: NormalizedManifestV1,
  replacement: PortableLockSkillV1,
): PortableLockV1 =>
  Object.freeze({
    version: 1,
    hashSchemaVersion: 1,
    manifestHash: hashManifestSemantics(manifest),
    skills: Object.freeze(
      current.skills.map((entry) => (entry.name === replacement.name ? replacement : entry)),
    ),
  });

const cleanupAll = async (
  ports: AcquisitionPorts,
  directories: ReadonlySet<string>,
): Promise<unknown | null> => {
  let first: unknown | null = null;
  for (const directory of directories) {
    try {
      await ports.removeTree(directory);
    } catch (error) {
      first ??= error;
    }
  }
  return first;
};

/** Prepare exact update bytes once and retain their cleanup authority for the caller. */
export const prepareUpdateObservationV1 = async (
  input: PrepareUpdateObservationRequestV1,
  runtime: PrepareUpdateObservationRuntimeV1,
): Promise<Result<PreparedUpdateObservationV1, PrepareUpdateObservationErrorV1>> => {
  const cleanupDirectories = new Set<string>();
  const selections: UpdateObservedSelectionV1[] = [];
  const transitions: UpdateArtifactTransitionV1[] = [];
  let manifestBytes = new Uint8Array(input.artifacts.manifestBytes);
  let manifest = input.artifacts.manifest;
  let lock = input.artifacts.lock;

  const fail = async (
    error: PrepareUpdateObservationErrorV1,
  ): Promise<Result<PreparedUpdateObservationV1, PrepareUpdateObservationErrorV1>> => {
    const cleanupError = await cleanupAll(runtime.ports, cleanupDirectories);
    return err(
      cleanupError === null || error.exitClass === 'cancelled'
        ? error
        : cleanupFailure(cleanupError),
    );
  };

  for (const inspection of input.selections) {
    if (runtime.signal?.aborted) {
      return fail(failure('update-cancelled', 'update preparation was cancelled', 'cancelled'));
    }
    const currentLock = lock.skills.find(
      ({ name }) => name === inspection.selected.declaration.name,
    );
    if (currentLock === undefined) {
      return fail(failure('update-lock-entry', 'selected lock entry is missing', 'state'));
    }
    const policyCandidate = deriveUpdateCandidateV1({
      selected: inspection.selected,
      currentLock,
      inspection: inspection.proposedInspection,
      explicitRef: input.request.ref,
      pin: input.request.pin,
    });
    const rejectCandidate = async (
      error: PrepareUpdateObservationErrorV1,
      cleanupDirectory: string | null = null,
    ): Promise<Result<PreparedUpdateObservationV1, PrepareUpdateObservationErrorV1> | null> => {
      if (!input.request.continueOnError) return fail(error);
      if (cleanupDirectory !== null) {
        cleanupDirectories.delete(cleanupDirectory);
        const cleanupError = await cleanupAll(runtime.ports, new Set([cleanupDirectory]));
        if (cleanupError !== null) {
          return fail(cleanupFailure(cleanupError));
        }
      }
      selections.push(
        Object.freeze({
          ...inspection,
          currentLock,
          candidate: Object.freeze({
            ...policyCandidate,
            contentHash: null,
            outcome: 'failed' as const,
            reason: error.message,
          }),
          source: null,
          failure: Object.freeze({ code: error.code, message: error.message }),
        }),
      );
      return null;
    };
    if (policyCandidate.outcome === 'skipped-fixed') {
      selections.push(
        Object.freeze({
          ...inspection,
          currentLock,
          candidate: policyCandidate,
          source: null,
          failure: null,
        }),
      );
      continue;
    }

    const parsed = parseSource(currentLock.source, {
      ...(policyCandidate.requestedRef === null
        ? {}
        : { overrideRef: policyCandidate.requestedRef }),
    });
    if (!parsed.ok) {
      const rejected = await rejectCandidate(
        failure('update-source-invalid', errorMessage(parsed.error), 'source'),
      );
      if (rejected !== null) return rejected;
      continue;
    }
    const resolved = await resolveRemoteSource({
      ports: runtime.ports,
      source: parsed.value,
      transport: sourceTransportBoundTo(inspection.proposedInspection.resolvedSha),
      ledger: EMPTY_LEDGER,
      scopeKey: null,
      storeRoot: storeRootOf(resolveDataDir(runtime.ports, runtime.configuration)),
      ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
      createFetchDirectory: () =>
        join(
          runtime.ports.homeDir,
          `.skillsmith-update-fetch-${runtime.ports.nextId('update-source-resolution')}`,
        ),
    });
    if (resolved.cleanupDirectory !== null) cleanupDirectories.add(resolved.cleanupDirectory);
    if (resolved.kind !== 'resolved') {
      const message =
        resolved.kind === 'source-failure'
          ? errorMessage(resolved.error)
          : `selected declaration '${inspection.selected.declaration.name}' could not be materialized exactly`;
      const rejected = await rejectCandidate(
        failure('update-source-resolution', message, 'source'),
        resolved.cleanupDirectory,
      );
      if (rejected !== null) return rejected;
      continue;
    }
    const materialization = resolved.materialization;
    const actualPath = materialization.skillPath.length === 0 ? '.' : materialization.skillPath;
    if (
      materialization.sha !== inspection.proposedInspection.resolvedSha ||
      materialization.skillName !== inspection.selected.declaration.name ||
      (inspection.selected.declaration.source.path !== null &&
        actualPath !== inspection.selected.declaration.source.path)
    ) {
      const rejected = await rejectCandidate(
        failure(
          'update-source-mismatch',
          'materialized source identity did not match the inspected declaration',
          'state',
        ),
        resolved.cleanupDirectory,
      );
      if (rejected !== null) return rejected;
      continue;
    }
    const projection = await projectSourceContent(runtime.ports, materialization.materializedDir);
    if (!projection.ok) {
      const rejected = await rejectCandidate(
        failure('update-source-content', projection.error.message, 'state'),
        resolved.cleanupDirectory,
      );
      if (rejected !== null) return rejected;
      continue;
    }
    const hashed = hashSourceContentV1(projection.value);
    if (!hashed.ok) {
      const rejected = await rejectCandidate(
        failure('update-source-content', hashed.error.message, 'state'),
        resolved.cleanupDirectory,
      );
      if (rejected !== null) return rejected;
      continue;
    }
    const contentHash = hashed.value as OperationDigest;
    const manifestBeforeBytes = new Uint8Array(manifestBytes);
    const manifestBefore = manifest;
    const manifestEdit: UpdateArtifactTransitionV1['manifestEdit'] =
      policyCandidate.proposedRequestedRef !== inspection.selected.declaration.ref &&
      policyCandidate.proposedRequestedRef !== null
        ? Object.freeze({
            edits: Object.freeze([
              Object.freeze({
                kind: 'set-skill-field' as const,
                name: inspection.selected.declaration.name,
                field: 'ref' as const,
                value: policyCandidate.proposedRequestedRef,
              }),
            ] as const),
          })
        : null;
    if (manifestEdit !== null) {
      const edited = editManifestBytes(manifestBytes, manifestEdit);
      if (!edited.ok) {
        const rejected = await rejectCandidate(
          failure('update-manifest-edit', edited.error.message, 'state'),
          resolved.cleanupDirectory,
        );
        if (rejected !== null) return rejected;
        continue;
      }
      const editedBytes = new Uint8Array(edited.value.bytes);
      const parsedManifest = normalizedManifest(editedBytes);
      if (!parsedManifest.ok) {
        const rejected = await rejectCandidate(parsedManifest.error, resolved.cleanupDirectory);
        if (rejected !== null) return rejected;
        continue;
      }
      manifestBytes = editedBytes;
      manifest = parsedManifest.value;
    }
    const replacement: PortableLockSkillV1 = Object.freeze({
      name: currentLock.name,
      source: currentLock.source,
      requestedRef: policyCandidate.proposedRequestedRef,
      resolvedSha: inspection.proposedInspection.resolvedSha,
      sourcePath: actualPath,
      contentHash: hashed.value,
    });
    const lockBefore = lock;
    const nextLock = lockWith(lock, manifest, replacement);
    const serialized = serializePortableLock(nextLock);
    if (!serialized.ok) {
      const rejected = await rejectCandidate(
        failure('update-lock-build', serialized.error.message, 'state'),
        resolved.cleanupDirectory,
      );
      if (rejected !== null) return rejected;
      continue;
    }
    lock = nextLock;
    const candidate: UpdateCandidateV1 = Object.freeze({
      ...policyCandidate,
      contentHash: hashed.value,
      outcome:
        policyCandidate.outcome === 'available' || currentLock.contentHash !== hashed.value
          ? 'available'
          : 'current',
    });
    const source: ReconcilePreparedSourceV1 = Object.freeze({
      source: Object.freeze({
        kind: 'portable',
        identity: Object.freeze({ ...inspection.selected.declaration.source }),
        requestedRef: policyCandidate.proposedRequestedRef,
        resolvedSha: inspection.proposedInspection.resolvedSha,
        sourcePath: actualPath,
        contentHash,
      }),
      skillName: materialization.skillName,
      materializedDir: materialization.materializedDir,
      cleanupDirectory: resolved.cleanupDirectory,
    });
    selections.push(
      Object.freeze({
        ...inspection,
        currentLock,
        candidate,
        source,
        failure: null,
      }),
    );
    transitions.push(
      Object.freeze({
        skill: inspection.selected.declaration.name,
        manifestBeforeBytes,
        manifestAfterBytes: new Uint8Array(manifestBytes),
        manifestBefore,
        manifestAfter: manifest,
        manifestEdit,
        lockBefore,
        lockAfter: lock,
        lockAfterSource: serialized.value,
      }),
    );
  }

  const lockSource = serializePortableLock(lock);
  if (!lockSource.ok) return fail(failure('update-lock-build', lockSource.error.message, 'state'));
  let cleaned = false;
  return ok(
    Object.freeze({
      selections: Object.freeze(selections),
      transitions: Object.freeze(transitions),
      manifest,
      manifestBytes: new Uint8Array(manifestBytes),
      lock,
      lockBytes: new TextEncoder().encode(lockSource.value),
      cleanup: async () => {
        if (cleaned) return;
        cleaned = true;
        const cleanupError = await cleanupAll(runtime.ports, cleanupDirectories);
        if (cleanupError !== null) throw cleanupError;
      },
    }),
  );
};
