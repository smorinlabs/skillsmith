import { dirname } from 'node:path';
import {
  type SkillSmithError,
  configError,
  errorMessage,
  permissionDeniedError,
} from '../errors.ts';
import { isPortError } from '../ports/errors.ts';
import type {
  FileMetadata,
  FileModeWritePort,
  FileReadPort,
  FileWritePort,
  IdPort,
  LockPort,
  PlatformPaths,
} from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';
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

type SaveConfigPorts = PlatformPaths &
  Pick<FileReadPort, 'readText'> & {
    readFileMetadata(
      path: string,
    ): Promise<
      | FileMetadata
      | { readonly kind: string; readonly mode: number | null; readonly identity: string | null }
    >;
  } & Pick<
    FileWritePort,
    'makeDir' | 'writeTextFile' | 'rename' | 'removeTree' | 'fsyncFile' | 'fsyncDir'
  > &
  FileModeWritePort &
  LockPort &
  IdPort;

const nodeCode = (error: unknown): string | null =>
  error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;

const saveError = (error: unknown, file: string, operation: string): SkillSmithError => {
  const permission =
    nodeCode(error) === 'EACCES' ||
    nodeCode(error) === 'EPERM' ||
    (isPortError(error) && error.code === 'permission');
  return permission
    ? permissionDeniedError(`${operation} denied for ${file}`, file)
    : configError(`${operation} failed for ${file}: ${errorMessage(error)}`, { file });
};

const editAt = async (
  ports: SaveConfigPorts,
  file: string,
  opts: SaveConfigOpts,
): Promise<
  Result<
    {
      readonly source: string;
      readonly mode: number | null;
      readonly changed: boolean;
      readonly operation?: 'migrate-project-config';
      readonly existed: boolean;
      readonly originalSource: string | null;
    },
    SkillSmithError
  >
> => {
  let metadata: Awaited<ReturnType<SaveConfigPorts['readFileMetadata']>>;
  try {
    metadata = await ports.readFileMetadata(file);
  } catch (error) {
    return err(saveError(error, file, 'config metadata read'));
  }
  if (metadata.kind !== 'absent' && metadata.kind !== 'file') {
    return err(configError(`config destination must be a regular file: ${file}`, { file }));
  }
  if (metadata.kind === 'absent') {
    const created = createConfigSource(opts);
    return created.ok
      ? ok({
          source: created.value.source,
          mode: null,
          changed: created.value.changed,
          ...(created.value.operation === undefined ? {} : { operation: created.value.operation }),
          existed: false,
          originalSource: null,
        })
      : created;
  }
  let source: string;
  try {
    source = await ports.readText(file);
  } catch (error) {
    return err(saveError(error, file, 'config read'));
  }
  const edited = editConfigSource(source, opts);
  return edited.ok
    ? ok({
        source: edited.value.source,
        mode: metadata.mode,
        changed: edited.value.changed,
        ...(edited.value.operation === undefined ? {} : { operation: edited.value.operation }),
        existed: true,
        originalSource: source,
      })
    : edited;
};

const restoreAfterDirectoryFlushFailure = async (
  ports: SaveConfigPorts,
  file: string,
  temporary: string,
  current: {
    readonly existed: boolean;
    readonly originalSource: string | null;
    readonly mode: number | null;
  },
): Promise<{ readonly restored: boolean; readonly error: unknown | null }> => {
  let restored = false;
  try {
    if (!current.existed) {
      await ports.removeTree(file);
      restored = true;
    } else {
      // This is bounded in-process compensation, not crash recovery: reconstruct the exact bytes
      // already read under the coordination lock and atomically replace the unflushed edit.
      await ports.writeTextFile(temporary, current.originalSource ?? '');
      if (current.mode !== null) await ports.setFileMode(temporary, current.mode);
      await ports.fsyncFile(temporary);
      await ports.rename(temporary, file);
      restored = true;
    }
    await ports.fsyncDir(dirname(file));
    return { restored: true, error: null };
  } catch (error) {
    await ports.removeTree(temporary).catch(() => {});
    return { restored, error };
  }
};

export const saveConfig = async (
  ports: SaveConfigPorts,
  opts: SaveConfigOpts,
): Promise<Result<SaveConfigResult, SkillSmithError>> => {
  const file = opts.file ?? getConfigPath(ports, opts.scope, opts.cwd);
  const initial = await editAt(ports, file, opts);
  if (!initial.ok) return initial;
  if (!initial.value.changed) {
    return ok({ file, changed: false, unchanged: true });
  }

  if (!initial.value.existed) {
    try {
      await ports.makeDir(dirname(file));
    } catch (error) {
      return err(saveError(error, file, 'config directory creation'));
    }
  }

  try {
    return await ports.withFileLock(file, async () => {
      const current = await editAt(ports, file, opts);
      if (!current.ok) return current;
      if (!current.value.changed) return ok({ file, changed: false, unchanged: true });

      const temporary = `${file}.tmp.${ports.nextId('config-save')}`;
      let staged = false;
      try {
        // A write may create/truncate the staging path before rejecting. Mark it for cleanup first.
        staged = true;
        await ports.writeTextFile(temporary, current.value.source);
        if (current.value.mode !== null) await ports.setFileMode(temporary, current.value.mode);
        await ports.fsyncFile(temporary);
        await ports.rename(temporary, file);
        staged = false;
        try {
          await ports.fsyncDir(dirname(file));
        } catch (error) {
          const rollback = await restoreAfterDirectoryFlushFailure(
            ports,
            file,
            temporary,
            current.value,
          );
          if (!rollback.restored) {
            return err(
              configError(
                `config replacement failed for ${file}; rollback could not be confirmed`,
                { file },
              ),
            );
          }
          return err(saveError(error, file, 'config directory flush'));
        }
        return ok({
          file,
          changed: true,
          unchanged: false,
          ...(current.value.operation === undefined ? {} : { operation: current.value.operation }),
        });
      } catch (error) {
        if (staged) await ports.removeTree(temporary).catch(() => {});
        return err(saveError(error, file, 'config replacement'));
      }
    });
  } catch (error) {
    return err(saveError(error, file, 'config coordination lock'));
  }
};
