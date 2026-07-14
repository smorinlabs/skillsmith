import type {
  ArtifactCoordinatorPorts,
  ArtifactFileRevision,
  ArtifactMutationError,
} from '../artifacts/coordinator-types.ts';
import { updateCoordinatedHumanFile } from '../artifacts/coordinator.ts';
import { artifactMutationError } from '../artifacts/file-state.ts';
import { createNodeArtifactCoordinatorPorts } from '../artifacts/node-coordinator.ts';
import {
  type SkillSmithError,
  configError,
  invalidArgumentError,
  permissionDeniedError,
} from '../errors.ts';
import { isPortError } from '../ports/errors.ts';
import type { PlatformPaths } from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';
import { containsSensitiveMaterial } from '../safety/redaction.ts';
import { createConfigSource, editConfigSource } from './human-edit.ts';
import { getConfigPath } from './paths.ts';
import type { Config, ConfigKey, Scope } from './types.ts';

export interface SaveConfigOpts {
  readonly scope: Scope;
  readonly patch?: Partial<Config>;
  readonly delete?: readonly ConfigKey[];
  readonly cwd?: string;
  /** Explicit selected destination. Required for nested desired-state ownership. */
  readonly file?: string;
}

export interface SaveConfigResult {
  readonly file: string;
  readonly changed: boolean;
  readonly unchanged: boolean;
  readonly operation?: 'migrate-project-config';
}

type SaveConfigPorts = PlatformPaths;

type SaveConfig = (
  ports: SaveConfigPorts,
  opts: SaveConfigOpts,
) => Promise<Result<SaveConfigResult, SkillSmithError>>;

const nodeCode = (error: unknown): string | null =>
  error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;

const coordinationInitializationError = (error: unknown, file: string): SkillSmithError => {
  const permission =
    nodeCode(error) === 'EACCES' ||
    nodeCode(error) === 'EPERM' ||
    (isPortError(error) && error.code === 'permission');
  return permission
    ? permissionDeniedError('artifact coordination initialization was denied', file)
    : configError('artifact coordination initialization failed', { file });
};

const saveConfigWithCoordinator = async (
  ports: SaveConfigPorts,
  opts: SaveConfigOpts,
  coordinator: ArtifactCoordinatorPorts,
): Promise<Result<SaveConfigResult, SkillSmithError>> => {
  const file = opts.file ?? getConfigPath(ports, opts.scope, opts.cwd);
  let operation: 'migrate-project-config' | undefined;
  const coordinated = await updateCoordinatedHumanFile(coordinator, {
    path: file,
    edit: (current: ArtifactFileRevision) => {
      let edited: ReturnType<typeof createConfigSource>;
      if (current.state === 'absent') {
        edited = createConfigSource(opts);
      } else {
        let source: string;
        try {
          source = new TextDecoder('utf-8', { fatal: true }).decode(current.bytes);
        } catch {
          return err(artifactMutationError('invalid-utf8', { role: 'manifest' }));
        }
        edited = editConfigSource(source, opts);
      }
      if (!edited.ok) {
        const unsafe = edited.error.code === 'invalid-argument';
        const manualPatch =
          'message' in edited.error && typeof edited.error.message === 'string'
            ? edited.error.message
            : undefined;
        return err(
          artifactMutationError(unsafe ? 'unsafe-human-edit' : 'invalid-manifest', {
            role: 'manifest',
            ...(manualPatch === undefined ? {} : { manualPatch }),
          }),
        );
      }
      operation = edited.value.operation;
      if (edited.value.changed && containsSensitiveMaterial(edited.value.source)) {
        return err(
          artifactMutationError('unsafe-human-edit', {
            role: 'manifest',
            manualPatch:
              'candidate config contains sensitive material; apply a validated value locally',
          }),
        );
      }
      return ok(
        Object.freeze({
          bytes: new TextEncoder().encode(edited.value.source),
          changed: edited.value.changed,
          mode: current.state === 'file' ? current.mode : 0o600,
        }),
      );
    },
  });
  if (!coordinated.ok) {
    const failure: ArtifactMutationError = coordinated.error;
    if (failure.reason === 'permission-denied') {
      return err(permissionDeniedError(failure.message, file));
    }
    if (failure.reason === 'invalid-request' || failure.reason === 'unsafe-human-edit') {
      const detail = failure.manualPatch === undefined ? '' : `\n${failure.manualPatch}`;
      return err(invalidArgumentError(`${failure.message}${detail}`));
    }
    return err(configError(failure.message, { file }));
  }
  const changed = coordinated.value.outcome !== 'unchanged';
  return ok({
    file,
    changed,
    unchanged: !changed,
    ...(changed && operation !== undefined ? { operation } : {}),
  });
};

export const saveConfig: SaveConfig = async (
  ports: SaveConfigPorts,
  opts: SaveConfigOpts,
  injectedCoordinator: ArtifactCoordinatorPorts | undefined = undefined,
): Promise<Result<SaveConfigResult, SkillSmithError>> => {
  const file = opts.file ?? getConfigPath(ports, opts.scope, opts.cwd);
  let coordinator = injectedCoordinator;
  if (coordinator === undefined) {
    try {
      coordinator = await createNodeArtifactCoordinatorPorts();
    } catch (error) {
      return err(coordinationInitializationError(error, file));
    }
  }
  return saveConfigWithCoordinator(ports, opts, coordinator);
};
