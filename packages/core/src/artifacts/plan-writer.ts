import { basename, dirname, join } from 'node:path';
import type { FileWritePort } from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';
import type { ArtifactCoordinatorPorts } from './coordinator-types.ts';

export interface PlanWriteRequest {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly force: boolean;
  readonly signal?: AbortSignal;
}

export interface PlanWriteReceipt {
  readonly path: string;
  readonly disposition: 'created' | 'replaced';
  readonly mode: '0600';
}

export interface PlanWriterError {
  readonly code: 'plan-writer';
  readonly reason: 'exists' | 'invalid-target' | 'permission-denied' | 'cancelled' | 'write-failed';
  readonly message: string;
  readonly exitClass: 'usage' | 'permission' | 'cancelled' | 'failure';
}

export type PlanWriterPorts = Pick<
  ArtifactCoordinatorPorts,
  | 'observe'
  | 'writeBytesExclusive'
  | 'fsyncFile'
  | 'fsyncDirectory'
  | 'linkFileNoReplace'
  | 'removeFile'
  | 'nextId'
> &
  Pick<FileWritePort, 'rename'>;

const ownCode = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null) return null;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string'
    ? descriptor.value
    : null;
};

const writerError = (error: unknown): PlanWriterError => {
  const code = ownCode(error);
  if (code === 'EEXIST') {
    return {
      code: 'plan-writer',
      reason: 'exists',
      message: 'saved plan output already exists; use --force to replace this exact path',
      exitClass: 'usage',
    };
  }
  if (
    code === 'EACCES' ||
    code === 'EPERM' ||
    code === 'permission-denied' ||
    code === 'permission'
  ) {
    return {
      code: 'plan-writer',
      reason: 'permission-denied',
      message: 'saved plan output is not writable',
      exitClass: 'permission',
    };
  }
  const name =
    typeof error === 'object' && error !== null
      ? Object.getOwnPropertyDescriptor(error, 'name')
      : undefined;
  if (
    code === 'cancelled' ||
    code === 'ABORT_ERR' ||
    (name !== undefined && 'value' in name && name.value === 'AbortError')
  ) {
    return {
      code: 'plan-writer',
      reason: 'cancelled',
      message: 'saved plan output was cancelled',
      exitClass: 'cancelled',
    };
  }
  return {
    code: 'plan-writer',
    reason: 'write-failed',
    message: 'saved plan output could not be written atomically',
    exitClass: 'failure',
  };
};

const throwIfCancelled = (signal: AbortSignal | undefined): void => {
  if (!signal?.aborted) return;
  throw Object.assign(new Error('saved plan output was cancelled'), {
    code: 'cancelled',
    name: 'AbortError',
  });
};

export const writeSavedPlan = async (
  ports: PlanWriterPorts,
  request: PlanWriteRequest,
): Promise<Result<PlanWriteReceipt, PlanWriterError>> => {
  let observed: Awaited<ReturnType<PlanWriterPorts['observe']>>;
  try {
    throwIfCancelled(request.signal);
    observed = await ports.observe(request.path);
    throwIfCancelled(request.signal);
  } catch (error) {
    return err(writerError(error));
  }
  if (!request.force && observed.kind !== 'absent') {
    return err({
      code: 'plan-writer',
      reason: 'exists',
      message: 'saved plan output already exists; use --force to replace this exact path',
      exitClass: 'usage',
    });
  }
  if (request.force && observed.kind !== 'absent' && observed.kind !== 'file') {
    return err({
      code: 'plan-writer',
      reason: 'invalid-target',
      message: 'saved plan output must be absent or a regular file',
      exitClass: 'usage',
    });
  }

  const parent = dirname(request.path);
  const token = ports.nextId('artifact-operation');
  const stage = join(parent, `.${basename(request.path)}.skillsmith-plan-${token}`);
  const backup = join(parent, `.${basename(request.path)}.skillsmith-plan-${token}.backup`);
  const replacing = request.force && observed.kind === 'file';
  let stagePresent = false;
  let backupPresent = false;
  let published = false;
  let retainBackup = false;
  try {
    await ports.writeBytesExclusive(stage, new Uint8Array(request.bytes), 0o600);
    stagePresent = true;
    throwIfCancelled(request.signal);
    await ports.fsyncFile(stage);
    throwIfCancelled(request.signal);
    if (replacing) {
      await ports.linkFileNoReplace(request.path, backup);
      backupPresent = true;
      throwIfCancelled(request.signal);
      await ports.fsyncFile(backup);
      throwIfCancelled(request.signal);
      await ports.fsyncDirectory(parent);
      throwIfCancelled(request.signal);
      await ports.rename(stage, request.path);
      stagePresent = false;
      published = true;
      throwIfCancelled(request.signal);
    } else {
      await ports.linkFileNoReplace(stage, request.path);
      published = true;
      throwIfCancelled(request.signal);
    }
    await ports.fsyncFile(request.path);
    throwIfCancelled(request.signal);
    await ports.fsyncDirectory(parent);
    throwIfCancelled(request.signal);
    if (stagePresent) {
      await ports.removeFile(stage);
      stagePresent = false;
    }
    if (backupPresent) {
      await ports.removeFile(backup);
      backupPresent = false;
    }
    return ok({
      path: request.path,
      disposition: replacing ? 'replaced' : 'created',
      mode: '0600',
    });
  } catch (error) {
    if (replacing && backupPresent) {
      try {
        await ports.rename(backup, request.path);
        backupPresent = false;
        published = false;
        await ports.fsyncFile(request.path);
        await ports.fsyncDirectory(parent);
      } catch {
        // Retain the backup for manual recovery if the exact rollback itself is unavailable.
        retainBackup = true;
      }
    } else if (!replacing && published) {
      try {
        await ports.removeFile(request.path);
        published = false;
        await ports.fsyncDirectory(parent);
      } catch {
        // The primary writer failure remains authoritative.
      }
    }
    return err(writerError(error));
  } finally {
    if (stagePresent) {
      try {
        await ports.removeFile(stage);
      } catch {
        // A bounded staging cleanup failure cannot hide the primary writer result.
      }
    }
    if (backupPresent && !retainBackup) {
      try {
        await ports.removeFile(backup);
      } catch {
        // A retained recovery copy is safer than hiding the primary writer result.
      }
    }
  }
};
