import { join, parse, resolve } from 'node:path';
import { type Result, err, ok } from '@skillsmith/core';

export interface ResolveArtifactPairOptions {
  readonly effectiveCwd: string;
  readonly file?: string;
  readonly lockfile?: string;
}

export interface ResolvedArtifactPair {
  readonly file: string | null;
  readonly lockfile: string | null;
  readonly lockfileSource: 'explicit' | 'sibling' | null;
}

export interface ArtifactPairUsageError {
  readonly code: 'usage';
  readonly exitCode: 2;
  readonly message: string;
}

const siblingLockfile = (file: string): string => {
  const parsed = parse(file);
  return join(parsed.dir, `${parsed.name}.lock`);
};

/** Resolve explicit artifact selectors without reading, parsing, or writing either artifact. */
export const resolveArtifactPair = (
  options: ResolveArtifactPairOptions,
): Result<ResolvedArtifactPair, ArtifactPairUsageError> => {
  if (options.lockfile !== undefined && options.file === undefined) {
    return err({
      code: 'usage',
      exitCode: 2,
      message: '--lockfile requires --file',
    });
  }

  if (options.file === undefined) {
    return ok({ file: null, lockfile: null, lockfileSource: null });
  }

  const file = resolve(options.effectiveCwd, options.file);
  if (options.lockfile !== undefined) {
    return ok({
      file,
      lockfile: resolve(options.effectiveCwd, options.lockfile),
      lockfileSource: 'explicit',
    });
  }

  return ok({ file, lockfile: siblingLockfile(file), lockfileSource: 'sibling' });
};
