import { join, resolve } from 'node:path';
import type { Scope } from '../config/types.ts';
import type { ProjectContext } from '../context/types.ts';
import type { FileReadPort, PlatformPaths } from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';
import { normalizeManifestDocument, readManifestSource } from './manifest.ts';
import type { ManifestScope, ManifestShape } from './types.ts';

const MANIFEST_NAME = 'skillsmith.toml';
const USER_DIRECTORY = 'skillsmith';
const USER_CONFIG_NAME = 'config.toml';

export type ManifestCandidateRole = 'selected-project' | 'project-root' | 'user' | 'explicit';

export interface ManifestCandidate {
  readonly role: ManifestCandidateRole;
  readonly path: string;
  readonly existence: 'absent' | 'file';
  readonly shape: ManifestShape | null;
  readonly declaredNames: readonly string[];
}

export interface ArtifactDiscoverySnapshot {
  readonly projectContext: ProjectContext;
  readonly selectedProjectManifest: string | null;
  readonly projectRootManifest: string | null;
  readonly userManifest: string;
  readonly userConfig: string;
  readonly explicitConfigPath: string | null;
  readonly explicitArtifactPath: string | null;
  readonly candidates: readonly ManifestCandidate[];
}

export interface DiscoverArtifactOptions {
  readonly explicitConfig?: string;
  readonly explicitFile?: string;
  readonly explicitProjectScope?: boolean;
}

export type ReadableArtifactContext =
  | Readonly<{ readonly state: 'unselected'; readonly reason: 'live-only-scope' }>
  | Readonly<{
      readonly state: 'selected';
      readonly source: 'explicit' | 'discovered-project' | 'project-default' | 'user-default';
      readonly file: string;
    }>;

export interface SelectReadableArtifactContextRequest {
  readonly explicitFile?: string;
  readonly scope: Scope | null;
}

export interface ManifestDestinationRequest {
  readonly names: readonly string[];
  readonly scope: ManifestScope;
  readonly mode: 'save' | 'remove';
  readonly explicitFile?: string;
}

export interface ManifestDestination {
  readonly kind: 'existing' | 'new' | 'absent';
  readonly role: ManifestCandidateRole | null;
  readonly path: string | null;
  readonly names: readonly string[];
}

export type ArtifactDiscoveryErrorCode =
  | 'manifest-explicit-selector-mismatch'
  | 'manifest-candidate-invalid'
  | 'manifest-candidate-unreadable'
  | 'manifest-name-required'
  | 'manifest-owner-ambiguous'
  | 'manifest-owner-split'
  | 'manifest-project-root-unavailable';

export interface ArtifactDiscoveryError {
  readonly code: ArtifactDiscoveryErrorCode;
  readonly exitClass: 'usage' | 'state';
  readonly message: string;
  readonly paths?: readonly string[];
}

export type ArtifactDiscoveryPorts = Pick<FileReadPort, 'pathKind' | 'readText'> &
  Pick<PlatformPaths, 'xdg'>;

interface CandidateSummary {
  readonly existence: 'file';
  readonly shape: ManifestShape | null;
  readonly declaredNames: readonly string[];
}

const artifactError = (
  code: ArtifactDiscoveryErrorCode,
  exitClass: ArtifactDiscoveryError['exitClass'],
  message: string,
  paths?: readonly string[],
): ArtifactDiscoveryError =>
  Object.freeze({
    code,
    exitClass,
    message,
    ...(paths === undefined ? {} : { paths: Object.freeze([...paths]) }),
  });

const frozenContext = (context: ProjectContext): ProjectContext =>
  Object.freeze({
    invocationCwd: context.invocationCwd,
    effectiveCwd: context.effectiveCwd,
    projectRoot: context.projectRoot,
    projectIdentity: context.projectIdentity,
    projectKind: context.projectKind,
    discoveredConfigPath: context.discoveredConfigPath,
    explicitConfigPath: context.explicitConfigPath,
  });

const freezeCandidate = (
  role: ManifestCandidateRole,
  path: string,
  summary: CandidateSummary,
): ManifestCandidate =>
  Object.freeze({
    role,
    path,
    existence: summary.existence,
    shape: summary.shape,
    declaredNames: Object.freeze([...summary.declaredNames]),
  });

const uniquePaths = (paths: readonly string[]): readonly string[] =>
  Object.freeze([...new Set(paths)]);

/**
 * Select the one readable portable-artifact context for status. This is a total, content-free
 * decision: the application remains the sole artifact-pair resolver and repository reader.
 */
export const selectReadableArtifactContext = (
  paths: Pick<PlatformPaths, 'xdg'>,
  context: ProjectContext,
  request: Readonly<SelectReadableArtifactContextRequest>,
): ReadableArtifactContext => {
  if (request.explicitFile !== undefined) {
    return Object.freeze({
      state: 'selected' as const,
      source: 'explicit' as const,
      file: resolve(context.effectiveCwd, request.explicitFile),
    });
  }

  if (request.scope === 'system' || request.scope === 'managed') {
    return Object.freeze({ state: 'unselected' as const, reason: 'live-only-scope' as const });
  }

  if (request.scope === 'user') {
    return Object.freeze({
      state: 'selected' as const,
      source: 'user-default' as const,
      file: join(paths.xdg.config, USER_DIRECTORY, MANIFEST_NAME),
    });
  }

  if (context.discoveredConfigPath !== null) {
    return Object.freeze({
      state: 'selected' as const,
      source: 'discovered-project' as const,
      file: context.discoveredConfigPath,
    });
  }

  if (request.scope === 'project' || context.projectRoot !== null) {
    return Object.freeze({
      state: 'selected' as const,
      source: 'project-default' as const,
      file: join(context.projectRoot ?? context.effectiveCwd, MANIFEST_NAME),
    });
  }

  return Object.freeze({
    state: 'selected' as const,
    source: 'user-default' as const,
    file: join(paths.xdg.config, USER_DIRECTORY, MANIFEST_NAME),
  });
};

/**
 * Build the complete read-only artifact view for one already-resolved project context.
 * Every physical candidate path is read and parsed at most once, even when it has several roles.
 */
export const discoverArtifactSnapshot = async (
  ports: ArtifactDiscoveryPorts,
  context: ProjectContext,
  options: DiscoverArtifactOptions = {},
): Promise<Result<ArtifactDiscoverySnapshot, ArtifactDiscoveryError>> => {
  const explicitConfigPath =
    options.explicitConfig === undefined
      ? context.explicitConfigPath
      : resolve(context.effectiveCwd, options.explicitConfig);
  const explicitArtifactPath =
    options.explicitFile === undefined ? null : resolve(context.effectiveCwd, options.explicitFile);
  const selectedProjectManifest = context.discoveredConfigPath;
  const projectDestinationRoot =
    context.projectRoot ?? (options.explicitProjectScope === true ? context.effectiveCwd : null);
  const projectRootManifest =
    projectDestinationRoot === null ? null : join(projectDestinationRoot, MANIFEST_NAME);
  const userDirectory = join(ports.xdg.config, USER_DIRECTORY);
  const userManifest = join(userDirectory, MANIFEST_NAME);
  const userConfig = join(userDirectory, USER_CONFIG_NAME);

  const summaries = new Map<
    string,
    Promise<Result<CandidateSummary | null, ArtifactDiscoveryError>>
  >();
  const summarize = (
    path: string,
  ): Promise<Result<CandidateSummary | null, ArtifactDiscoveryError>> => {
    const cached = summaries.get(path);
    if (cached !== undefined) return cached;
    const pending = (async (): Promise<Result<CandidateSummary | null, ArtifactDiscoveryError>> => {
      let kind: Awaited<ReturnType<ArtifactDiscoveryPorts['pathKind']>>;
      try {
        kind = await ports.pathKind(path);
      } catch {
        return err(
          artifactError(
            'manifest-candidate-unreadable',
            'state',
            'cannot inspect manifest candidate',
            [path],
          ),
        );
      }
      if (kind === 'absent') return ok(null);
      if (kind !== 'file') {
        return ok({
          existence: 'file',
          shape: 'unknown',
          declaredNames: Object.freeze([]),
        });
      }

      let source: string;
      try {
        source = await ports.readText(path);
      } catch {
        return err(
          artifactError(
            'manifest-candidate-unreadable',
            'state',
            'cannot read manifest candidate',
            [path],
          ),
        );
      }
      const document = readManifestSource(source);
      if (!document.ok) {
        return ok({
          existence: 'file',
          shape: document.error.shape ?? 'malformed',
          declaredNames: Object.freeze([]),
        });
      }
      const normalized = normalizeManifestDocument(document.value);
      if (!normalized.ok) {
        return ok({
          existence: 'file',
          shape: null,
          declaredNames: document.value.declaredNames,
        });
      }
      return ok({
        existence: 'file',
        shape: document.value.shape,
        declaredNames: document.value.declaredNames,
      });
    })();
    summaries.set(path, pending);
    return pending;
  };

  const roles: Array<readonly [ManifestCandidateRole, string]> = [];
  if (selectedProjectManifest !== null) {
    roles.push(['selected-project', selectedProjectManifest]);
  }
  if (
    projectRootManifest !== null &&
    (selectedProjectManifest === null || projectRootManifest !== selectedProjectManifest)
  ) {
    roles.push(['project-root', projectRootManifest]);
  }
  roles.push(['user', userManifest]);
  if (explicitArtifactPath !== null) roles.push(['explicit', explicitArtifactPath]);

  const candidates: ManifestCandidate[] = [];
  for (const [role, path] of roles) {
    const summary = await summarize(path);
    if (!summary.ok) return summary;
    if (summary.value !== null) candidates.push(freezeCandidate(role, path, summary.value));
  }

  return ok(
    Object.freeze({
      projectContext: frozenContext(context),
      selectedProjectManifest,
      projectRootManifest,
      userManifest,
      userConfig,
      explicitConfigPath,
      explicitArtifactPath,
      candidates: Object.freeze(candidates),
    }),
  );
};

/** Select one mutation destination only after every automatic candidate is safe to inspect. */
export const selectManifestDestination = (
  snapshot: ArtifactDiscoverySnapshot,
  request: ManifestDestinationRequest,
): Result<ManifestDestination, ArtifactDiscoveryError> => {
  const names = Object.freeze([...new Set(request.names)]);
  if (names.length === 0 || names.some((name) => name.length === 0)) {
    return err(
      artifactError('manifest-name-required', 'usage', 'at least one declaration name is required'),
    );
  }

  if (snapshot.explicitArtifactPath !== null || request.explicitFile !== undefined) {
    const requestedPath =
      request.explicitFile === undefined
        ? snapshot.explicitArtifactPath
        : resolve(snapshot.projectContext.effectiveCwd, request.explicitFile);
    if (snapshot.explicitArtifactPath === null || requestedPath !== snapshot.explicitArtifactPath) {
      return err(
        artifactError(
          'manifest-explicit-selector-mismatch',
          'usage',
          'explicit manifest destination must match the preflighted artifact selector',
          requestedPath === null ? undefined : [requestedPath],
        ),
      );
    }
    const path = snapshot.explicitArtifactPath;
    const candidate = snapshot.candidates.find(
      (item) => item.role === 'explicit' && item.path === path && item.existence === 'file',
    );
    if (
      candidate !== undefined &&
      candidate.shape !== 'canonical' &&
      candidate.shape !== 'legacy'
    ) {
      return err(
        artifactError(
          'manifest-candidate-invalid',
          'state',
          `explicit manifest candidate is invalid: ${path}`,
          [path],
        ),
      );
    }
    if (candidate === undefined && request.mode === 'remove') {
      return ok(
        Object.freeze({
          kind: 'absent' as const,
          role: null,
          path: null,
          names,
        }),
      );
    }
    return ok(
      Object.freeze({
        kind: candidate === undefined ? ('new' as const) : ('existing' as const),
        role: 'explicit' as const,
        path,
        names,
      }),
    );
  }

  const automaticCandidates = snapshot.candidates.filter(
    (candidate) => candidate.role !== 'explicit',
  );
  const invalidCandidates = automaticCandidates.filter(
    (candidate) => candidate.shape !== 'canonical' && candidate.shape !== 'legacy',
  );
  if (invalidCandidates.length > 0) {
    const paths = uniquePaths(invalidCandidates.map((candidate) => candidate.path));
    return err(
      artifactError(
        'manifest-candidate-invalid',
        'state',
        `manifest ownership cannot be determined until invalid candidates are corrected: ${paths.join(', ')}`,
        paths,
      ),
    );
  }

  const ownersByName = new Map<string, ManifestCandidate>();
  for (const name of names) {
    const owners = automaticCandidates.filter((candidate) =>
      candidate.declaredNames.includes(name),
    );
    if (owners.length > 1) {
      const paths = uniquePaths(owners.map((candidate) => candidate.path));
      return err(
        artifactError(
          'manifest-owner-ambiguous',
          'usage',
          `declaration '${name}' has multiple manifest owners: ${paths.join(', ')}`,
          paths,
        ),
      );
    }
    if (owners[0] !== undefined) ownersByName.set(name, owners[0]);
  }

  const ownerPaths = uniquePaths([...ownersByName.values()].map((candidate) => candidate.path));
  if (ownerPaths.length > 1) {
    return err(
      artifactError(
        'manifest-owner-split',
        'usage',
        `one request cannot mutate declarations owned by different manifests: ${ownerPaths.join(', ')}`,
        ownerPaths,
      ),
    );
  }

  if (ownerPaths.length === 1) {
    const owner = [...ownersByName.values()].find((candidate) => candidate.path === ownerPaths[0]);
    if (owner !== undefined) {
      return ok(
        Object.freeze({
          kind: 'existing' as const,
          role: owner.role,
          path: owner.path,
          names,
        }),
      );
    }
  }

  if (request.mode === 'remove') {
    return ok(
      Object.freeze({
        kind: 'absent' as const,
        role: null,
        path: null,
        names,
      }),
    );
  }

  if (request.scope === 'user') {
    const existingUser = automaticCandidates.find(
      (candidate) => candidate.path === snapshot.userManifest,
    );
    return ok(
      Object.freeze({
        kind: existingUser === undefined ? ('new' as const) : ('existing' as const),
        role: existingUser?.role ?? ('user' as const),
        path: snapshot.userManifest,
        names,
      }),
    );
  }

  if (snapshot.projectRootManifest === null) {
    return err(
      artifactError(
        'manifest-project-root-unavailable',
        'state',
        'project manifest destination requires a project root or explicit project scope',
      ),
    );
  }
  const existingProjectRoot = automaticCandidates.find(
    (candidate) => candidate.path === snapshot.projectRootManifest,
  );
  return ok(
    Object.freeze({
      kind: existingProjectRoot === undefined ? ('new' as const) : ('existing' as const),
      role: existingProjectRoot?.role ?? ('project-root' as const),
      path: snapshot.projectRootManifest,
      names,
    }),
  );
};
