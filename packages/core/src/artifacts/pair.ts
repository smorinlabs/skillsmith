import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import type { ProjectContext } from '../context/types.ts';
import type { FileReadPort } from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';

export type ArtifactPairErrorCode =
  | 'artifact-file-required'
  | 'artifact-lockfile-requires-file'
  | 'artifact-pair-collision'
  | 'artifact-selector-escape'
  | 'artifact-selector-invalid'
  | 'artifact-selector-nonportable'
  | 'artifact-selector-unresolvable';

export interface ArtifactPairError {
  readonly code: ArtifactPairErrorCode;
  readonly exitClass: 'usage' | 'state';
  readonly message: string;
  readonly paths?: readonly string[];
}

export interface PairPath {
  readonly token: string | null;
  readonly path: string;
  readonly portability: 'portable' | 'machine-bound';
  readonly portableToken: string | null;
}

export interface ResolvedArtifactPair {
  readonly file: PairPath;
  readonly lockfile: PairPath;
  readonly lockfileSource: 'explicit' | 'sibling';
}

export interface ResolveArtifactPairOptions {
  readonly discoveredFile?: string | null;
  readonly file?: string;
  readonly lockfile?: string;
}

export type ArtifactPairPorts = Pick<FileReadPort, 'pathKind' | 'realpath'>;

interface ResolvedSelector {
  readonly token: string | null;
  readonly path: string;
  readonly relativeOverride: boolean;
  readonly portability: 'portable' | 'machine-bound';
  readonly portableToken: string | null;
}

const usageError = (
  code: ArtifactPairErrorCode,
  message: string,
  paths?: readonly string[],
): ArtifactPairError =>
  Object.freeze({
    code,
    exitClass: 'usage' as const,
    message,
    ...(paths === undefined ? {} : { paths: Object.freeze([...paths]) }),
  });

const stateError = (
  code: ArtifactPairErrorCode,
  message: string,
  paths?: readonly string[],
): ArtifactPairError =>
  Object.freeze({
    code,
    exitClass: 'state' as const,
    message,
    ...(paths === undefined ? {} : { paths: Object.freeze([...paths]) }),
  });

const hasWindowsAbsoluteForm = (token: string): boolean =>
  /^[A-Za-z]:[\\/]/u.test(token) || /^(?:\\\\|\/\/)/u.test(token);

const isContainedBy = (root: string, target: string): boolean => {
  const displacement = relative(root, target);
  return (
    displacement === '' ||
    (!displacement.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
      displacement !== '..' &&
      !isAbsolute(displacement))
  );
};

const portableRelativeToken = (root: string, path: string): string => {
  const token = relative(root, path).replaceAll('\\', '/');
  return token === '' ? '.' : token.startsWith('.') ? token : `./${token}`;
};

const resolveSelector = (
  context: ProjectContext,
  token: string | null,
  discoveredPath?: string,
): Result<ResolvedSelector, ArtifactPairError> => {
  const source = token ?? discoveredPath;
  if (source === undefined || source.length === 0 || source.includes('\0')) {
    return err(
      usageError('artifact-selector-invalid', 'artifact file selector is empty or invalid'),
    );
  }

  if (token !== null && hasWindowsAbsoluteForm(token) && !isAbsolute(token)) {
    return err(
      usageError(
        'artifact-selector-nonportable',
        `artifact selector uses a foreign absolute-path form: ${token}`,
        [token],
      ),
    );
  }

  const relativeOverride = token !== null && !isAbsolute(token);
  const path = resolve(context.effectiveCwd, source);
  if (relativeOverride) {
    if (context.projectRoot === null || !isContainedBy(context.projectRoot, path)) {
      return err(
        usageError(
          'artifact-selector-escape',
          `relative artifact selector escapes the stable project root: ${token}`,
          [path],
        ),
      );
    }
    return ok({
      token,
      path,
      relativeOverride,
      portability: 'portable',
      portableToken: portableRelativeToken(context.projectRoot, path),
    });
  }

  return ok({
    token,
    path,
    relativeOverride,
    portability: 'machine-bound',
    portableToken: null,
  });
};

const siblingLockPath = (file: string): string => {
  const parts = parse(file);
  return join(parts.dir, `${parts.name}.lock`);
};

const freezePairPath = (selector: ResolvedSelector): PairPath =>
  Object.freeze({
    token: selector.token,
    path: selector.path,
    portability: selector.portability,
    portableToken: selector.portableToken,
  });

/**
 * Resolve one invocation-scoped manifest/lock pair without Git access or artifact-content IO.
 */
export const resolveArtifactPair = async (
  ports: ArtifactPairPorts,
  context: ProjectContext,
  options: ResolveArtifactPairOptions,
): Promise<Result<ResolvedArtifactPair, ArtifactPairError>> => {
  if (options.lockfile !== undefined && options.file === undefined) {
    return err(
      usageError(
        'artifact-lockfile-requires-file',
        '--lockfile requires an explicit --file selector',
      ),
    );
  }

  if (options.file === undefined && options.discoveredFile == null) {
    return err(usageError('artifact-file-required', 'no artifact manifest was selected'));
  }

  const file = resolveSelector(
    context,
    options.file ?? null,
    options.file === undefined ? (options.discoveredFile ?? undefined) : undefined,
  );
  if (!file.ok) return file;

  let lockfile: Result<ResolvedSelector, ArtifactPairError>;
  let lockfileSource: ResolvedArtifactPair['lockfileSource'];
  if (options.lockfile !== undefined) {
    lockfile = resolveSelector(context, options.lockfile);
    lockfileSource = 'explicit';
  } else {
    const path = siblingLockPath(file.value.path);
    lockfile = ok({
      token: null,
      path,
      relativeOverride: file.value.relativeOverride,
      portability: file.value.portability,
      portableToken:
        file.value.portability === 'portable' && context.projectRoot !== null
          ? portableRelativeToken(context.projectRoot, path)
          : null,
    });
    lockfileSource = 'sibling';
  }
  if (!lockfile.ok) return lockfile;

  if (file.value.path === lockfile.value.path) {
    return err(
      usageError(
        'artifact-pair-collision',
        'artifact manifest and lockfile resolve to the same path',
        [file.value.path, lockfile.value.path],
      ),
    );
  }

  const selectors = [file.value, lockfile.value] as const;
  const canonicalPaths: string[] = [];
  for (const selector of selectors) {
    try {
      const kind = await ports.pathKind(selector.path);
      const canonical = kind === 'absent' ? selector.path : await ports.realpath(selector.path);
      canonicalPaths.push(canonical);
      if (
        selector.relativeOverride &&
        (context.projectRoot === null || !isContainedBy(context.projectRoot, canonical))
      ) {
        return err(
          usageError(
            'artifact-selector-escape',
            `artifact selector resolves outside the stable project root: ${selector.token}`,
            [selector.path, canonical],
          ),
        );
      }
    } catch (cause) {
      return err(
        stateError(
          'artifact-selector-unresolvable',
          `cannot resolve artifact selector '${selector.path}': ${cause instanceof Error ? cause.message : String(cause)}`,
          [selector.path],
        ),
      );
    }
  }

  if (canonicalPaths[0] === canonicalPaths[1]) {
    return err(
      usageError(
        'artifact-pair-collision',
        'artifact manifest and lockfile identify the same filesystem object',
        canonicalPaths,
      ),
    );
  }

  return ok(
    Object.freeze({
      file: freezePairPath(file.value),
      lockfile: freezePairPath(lockfile.value),
      lockfileSource,
    }),
  );
};
