import {
  type ArtifactDiscoveryPorts,
  selectReadableArtifactContext,
} from '../artifacts/discovery.ts';
import { correlatePortableLock, readPortableLockSource } from '../artifacts/lock.ts';
import { normalizeManifestDocument, readManifestSource } from '../artifacts/manifest.ts';
import {
  type ArtifactPairPorts,
  type ResolvedArtifactPair,
  resolveArtifactPair,
} from '../artifacts/pair.ts';
import type { NormalizedManifestV1 } from '../artifacts/types.ts';
import type { ProjectContext } from '../context/types.ts';
import { safeErrorCode } from '../errors.ts';
import type { FileReadPort } from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';

export interface UpdateArtifactErrorV1 {
  readonly code: string;
  readonly exitClass: 'usage' | 'state' | 'permission';
  readonly message: string;
}

export interface PreparedUpdateArtifactsV1 {
  readonly pair: ResolvedArtifactPair;
  readonly selectionSource: 'explicit' | 'discovered-project' | 'project-default' | 'user-default';
  readonly manifestBytes: Uint8Array;
  readonly manifest: NormalizedManifestV1;
  readonly lockBytes: Uint8Array;
  readonly lock: import('../artifacts/lock.ts').PortableLockV1;
}

const stateError = (code: string, message: string): UpdateArtifactErrorV1 =>
  Object.freeze({ code, exitClass: 'state' as const, message });

const isPermission = (error: unknown): boolean => {
  const code = safeErrorCode(error);
  return (
    code === 'permission' || code === 'permission-denied' || code === 'EACCES' || code === 'EPERM'
  );
};

type UpdateArtifactPortsV1 = ArtifactDiscoveryPorts &
  ArtifactPairPorts &
  Pick<FileReadPort, 'readBytes'>;

/** Select and validate exactly one existing, coherent portable manifest/lock pair. */
export const prepareUpdateArtifactsV1 = async (
  ports: UpdateArtifactPortsV1,
  project: ProjectContext,
  request: Readonly<{ readonly file: string | null; readonly lockfile: string | null }>,
): Promise<Result<PreparedUpdateArtifactsV1, UpdateArtifactErrorV1>> => {
  const readable = selectReadableArtifactContext(ports, project, {
    ...(request.file === null ? {} : { explicitFile: request.file }),
    scope: null,
  });
  if (readable.state !== 'selected') {
    return err(stateError('update-artifact-unselected', 'no portable manifest was selected'));
  }
  const pair = await resolveArtifactPair(ports, project, {
    discoveredFile: readable.file,
    ...(request.file === null ? {} : { file: request.file }),
    ...(request.lockfile === null ? {} : { lockfile: request.lockfile }),
  });
  if (!pair.ok) return err(Object.freeze({ ...pair.error }));
  let manifestBytes: Uint8Array;
  let lockBytes: Uint8Array;
  try {
    [manifestBytes, lockBytes] = await Promise.all([
      ports.readBytes(pair.value.file.path),
      ports.readBytes(pair.value.lockfile.path),
    ]);
  } catch (error) {
    if (isPermission(error)) {
      return err(
        Object.freeze({
          code: 'update-artifact-permission',
          exitClass: 'permission' as const,
          message: 'selected manifest or lockfile could not be read because permission was denied',
        }),
      );
    }
    return err(
      stateError('update-artifact-unreadable', 'selected manifest or lockfile could not be read'),
    );
  }
  let manifestSource: string;
  try {
    manifestSource = new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes);
  } catch {
    return err(stateError('update-manifest-invalid', 'portable manifest is not valid UTF-8'));
  }
  const document = readManifestSource(manifestSource);
  if (!document.ok) return err(stateError('update-manifest-invalid', document.error.message));
  const manifest = normalizeManifestDocument(document.value);
  if (!manifest.ok) return err(stateError('update-manifest-invalid', manifest.error.message));
  const lock = readPortableLockSource(lockBytes);
  if (!lock.ok) return err(stateError('update-lock-invalid', lock.error.message));
  const relationship = correlatePortableLock(manifest.value, lock.value);
  if (relationship.state !== 'current') {
    return err(
      stateError(
        'update-artifact-incoherent',
        `portable manifest/lock pair is ${relationship.state}`,
      ),
    );
  }
  return ok(
    Object.freeze({
      pair: pair.value,
      selectionSource: readable.source,
      manifestBytes: new Uint8Array(manifestBytes),
      manifest: manifest.value,
      lockBytes: new Uint8Array(lockBytes),
      lock: lock.value,
    }),
  );
};
