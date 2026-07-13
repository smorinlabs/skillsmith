import { type Result, err, resolveExplicitArtifactPairLexically } from '@skillsmith/core';

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

/** Resolve explicit artifact selectors without reading, parsing, or writing either artifact. */
export const resolveArtifactPair = (
  options: ResolveArtifactPairOptions,
): Result<ResolvedArtifactPair, ArtifactPairUsageError> => {
  const resolved = resolveExplicitArtifactPairLexically(options);
  return resolved.ok
    ? resolved
    : err({
        code: 'usage',
        exitCode: 2,
        message:
          resolved.error.code === 'artifact-lockfile-requires-file'
            ? '--lockfile requires --file'
            : resolved.error.message,
      });
};
