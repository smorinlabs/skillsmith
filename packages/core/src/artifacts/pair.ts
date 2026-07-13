import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
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

export interface ResolveExplicitArtifactPairOptions {
  readonly effectiveCwd: string;
  readonly file?: string;
  readonly lockfile?: string;
}

export interface ResolvedExplicitArtifactPair {
  readonly file: string | null;
  readonly lockfile: string | null;
  readonly lockfileSource: 'explicit' | 'sibling' | null;
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

const hasControlCharacter = (token: string): boolean =>
  [...token].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });

const hasForeignWindowsForm = (token: string): boolean =>
  /^[A-Za-z]:/u.test(token) || /^(?:\\\\|\/\/)/u.test(token) || token.includes('\\');

const explicitSelectorError = (token: string): ArtifactPairError | null => {
  if (token.length === 0 || hasControlCharacter(token)) {
    return usageError('artifact-selector-invalid', 'artifact file selector is empty or invalid');
  }
  if (process.platform !== 'win32' && hasForeignWindowsForm(token)) {
    return usageError(
      'artifact-selector-nonportable',
      `artifact selector uses a foreign absolute-path form: ${token}`,
      [token],
    );
  }
  return null;
};

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
  preResolvedPath?: string,
): Result<ResolvedSelector, ArtifactPairError> => {
  const source = token ?? discoveredPath;
  if (source === undefined || source.length === 0 || hasControlCharacter(source)) {
    return err(
      usageError('artifact-selector-invalid', 'artifact file selector is empty or invalid'),
    );
  }

  if (token !== null) {
    const selectorError = explicitSelectorError(token);
    if (selectorError !== null) return err(selectorError);
  }

  const relativeOverride = token !== null && !isAbsolute(token);
  const path = preResolvedPath ?? resolve(context.effectiveCwd, source);
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

/**
 * Canonicalize an absent selector through its nearest existing ancestor. This closes the gap where
 * a lexically in-root destination is below a symlink whose real target is outside the project.
 */
const canonicalizeSelectorPath = async (
  ports: ArtifactPairPorts,
  path: string,
): Promise<string> => {
  const kind = await ports.pathKind(path);
  if (kind !== 'absent') return ports.realpath(path);

  const missingSegments: string[] = [];
  let cursor = path;
  while (true) {
    const parent = dirname(cursor);
    if (parent === cursor) return path;
    missingSegments.unshift(basename(cursor));
    cursor = parent;

    const ancestorKind = await ports.pathKind(cursor);
    if (ancestorKind !== 'absent') {
      const ancestor = await ports.realpath(cursor);
      return resolve(ancestor, ...missingSegments);
    }
  }
};

const siblingLockPath = (file: string): string => {
  const parts = parse(file);
  return join(parts.dir, `${parts.name}.lock`);
};

/** Resolve explicit CLI selectors without filesystem, Git, or project-context access. */
export const resolveExplicitArtifactPairLexically = (
  options: ResolveExplicitArtifactPairOptions,
): Result<ResolvedExplicitArtifactPair, ArtifactPairError> => {
  if (options.lockfile !== undefined && options.file === undefined) {
    return err(
      usageError(
        'artifact-lockfile-requires-file',
        '--lockfile requires an explicit --file selector',
      ),
    );
  }
  if (options.file === undefined) {
    return ok(Object.freeze({ file: null, lockfile: null, lockfileSource: null }));
  }

  const fileError = explicitSelectorError(options.file);
  if (fileError !== null) return err(fileError);
  const file = resolve(options.effectiveCwd, options.file);

  let lockfile: string;
  let lockfileSource: NonNullable<ResolvedExplicitArtifactPair['lockfileSource']>;
  if (options.lockfile === undefined) {
    lockfile = siblingLockPath(file);
    lockfileSource = 'sibling';
  } else {
    const lockfileError = explicitSelectorError(options.lockfile);
    if (lockfileError !== null) return err(lockfileError);
    lockfile = resolve(options.effectiveCwd, options.lockfile);
    lockfileSource = 'explicit';
  }

  if (file === lockfile) {
    return err(
      usageError(
        'artifact-pair-collision',
        'artifact manifest and lockfile resolve to the same path',
        [file, lockfile],
      ),
    );
  }

  return ok(Object.freeze({ file, lockfile, lockfileSource }));
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
  let explicitPair: ResolvedExplicitArtifactPair | null = null;
  if (options.file !== undefined || options.lockfile !== undefined) {
    const lexical = resolveExplicitArtifactPairLexically({
      effectiveCwd: context.effectiveCwd,
      ...(options.file === undefined ? {} : { file: options.file }),
      ...(options.lockfile === undefined ? {} : { lockfile: options.lockfile }),
    });
    if (!lexical.ok) return lexical;
    explicitPair = lexical.value;
  }

  if (options.file === undefined && options.discoveredFile == null) {
    return err(usageError('artifact-file-required', 'no artifact manifest was selected'));
  }

  const file = resolveSelector(
    context,
    options.file ?? null,
    options.file === undefined ? (options.discoveredFile ?? undefined) : undefined,
    explicitPair?.file ?? undefined,
  );
  if (!file.ok) return file;

  let lockfile: Result<ResolvedSelector, ArtifactPairError>;
  let lockfileSource: ResolvedArtifactPair['lockfileSource'];
  if (options.lockfile !== undefined) {
    lockfile = resolveSelector(
      context,
      options.lockfile,
      undefined,
      explicitPair?.lockfile ?? undefined,
    );
    lockfileSource = 'explicit';
  } else {
    const path = explicitPair?.lockfile ?? siblingLockPath(file.value.path);
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
      const canonical = await canonicalizeSelectorPath(ports, selector.path);
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
