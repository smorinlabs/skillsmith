import { type Result, err, ok } from '../result.ts';
import type { CanonicalSourceIdentity, ManifestScope, ManifestStateError } from './types.ts';

const SECRET_SAFE_MESSAGES = {
  name: 'manifest declaration name is invalid',
  ref: 'manifest requested ref is invalid',
  source: 'manifest source identity is invalid',
  registry: 'manifest registry identity is invalid',
  path: 'manifest portable path is invalid',
} as const;

const stateError = (field: string, message: string): Result<never, ManifestStateError> =>
  err({ code: 'manifest-state', exitCode: 3, field, message });

const hasControlOrWhitespace = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x20 || codePoint === 0x7f || /\s/u.test(character)) return true;
  }
  return false;
};

const validIdentitySegment = (segment: string): boolean =>
  segment.length > 0 &&
  segment !== '.' &&
  segment !== '..' &&
  !hasControlOrWhitespace(segment) &&
  !/[\\/:?#@]/u.test(segment) &&
  !/%[0-9a-f]{2}/iu.test(segment);

const validateHost = (host: string): string | null => {
  if (
    host.length === 0 ||
    hasControlOrWhitespace(host) ||
    host.startsWith('.') ||
    host.endsWith('.') ||
    host.includes('..') ||
    !/^[A-Za-z0-9.-]+$/u.test(host)
  ) {
    return null;
  }
  return host.toLowerCase();
};

const splitRawUrl = (
  value: string,
  scheme: 'https' | 'ssh',
): Readonly<{ authority: string; path: string }> | null => {
  const prefix = `${scheme}://`;
  if (value.slice(0, prefix.length).toLowerCase() !== prefix) return null;
  const remainder = value.slice(prefix.length);
  const slash = remainder.indexOf('/');
  const authority = slash < 0 ? remainder : remainder.slice(0, slash);
  if (authority.length === 0) return null;
  return { authority, path: slash < 0 ? '' : remainder.slice(slash + 1) };
};

export const validateManifestName = (
  value: string,
  field = 'skills.name',
): Result<string, ManifestStateError> => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) || value.endsWith('.')) {
    return stateError(field, SECRET_SAFE_MESSAGES.name);
  }
  return ok(value);
};

export const validateRequestedRef = (
  value: string,
  field = 'skills.ref',
): Result<string, ManifestStateError> => {
  const byteLength = new TextEncoder().encode(value).byteLength;
  const components = value.split('/');
  if (
    byteLength < 1 ||
    byteLength > 255 ||
    value.startsWith('-') ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.endsWith('.') ||
    value === '@' ||
    hasControlOrWhitespace(value) ||
    value.includes('..') ||
    value.includes('@{') ||
    value.includes('//') ||
    /[~^:?*[\\]/u.test(value) ||
    components.some(
      (component) =>
        component.length === 0 || component.startsWith('.') || component.endsWith('.lock'),
    )
  ) {
    return stateError(field, SECRET_SAFE_MESSAGES.ref);
  }
  return ok(value);
};

const validateSourcePath = (value: string): string | null => {
  if (
    value.length === 0 ||
    value.startsWith('/') ||
    value.includes('//') ||
    value.includes('\\') ||
    hasControlOrWhitespace(value) ||
    /[?:#]/u.test(value)
  ) {
    return null;
  }
  const segments = value.split('/');
  if (segments.some((segment) => !validIdentitySegment(segment))) return null;
  return segments.join('/');
};

interface RepositoryParts {
  readonly repository: string;
  readonly path: string | null;
}

const parseRepositoryAndPath = (value: string): RepositoryParts | null => {
  const marker = value.indexOf('//');
  const repositoryInput = marker < 0 ? value : value.slice(0, marker);
  const pathInput = marker < 0 ? null : value.slice(marker + 2);
  const repositorySegments = repositoryInput.split('/');
  if (
    repositorySegments.length < 2 ||
    repositorySegments.some((segment) => !validIdentitySegment(segment))
  ) {
    return null;
  }
  const lastIndex = repositorySegments.length - 1;
  const last = repositorySegments[lastIndex];
  if (last === undefined) return null;
  repositorySegments[lastIndex] = last.endsWith('.git') ? last.slice(0, -4) : last;
  if (!validIdentitySegment(repositorySegments[lastIndex] ?? '')) return null;
  const path = pathInput === null ? null : validateSourcePath(pathInput);
  if (pathInput !== null && path === null) return null;
  return { repository: repositorySegments.join('/'), path };
};

const sourceFailure = (field: string): Result<never, ManifestStateError> =>
  stateError(field, SECRET_SAFE_MESSAGES.source);

/** Normalize a manifest acquisition identity without retaining its transport spelling. */
export const normalizeSourceIdentity = (
  value: string,
  field = 'skills.source',
): Result<CanonicalSourceIdentity, ManifestStateError> => {
  if (
    value.length === 0 ||
    hasControlOrWhitespace(value) ||
    /%[0-9a-f]{2}/iu.test(value) ||
    value.includes('?') ||
    value.includes('#') ||
    value.includes('\\')
  ) {
    return sourceFailure(field);
  }

  let host: string | null = null;
  let repositoryInput: string | null = null;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/u.exec(value)?.[1]?.toLowerCase();

  if (scheme !== undefined) {
    if (scheme !== 'https' && scheme !== 'ssh') return sourceFailure(field);
    const rawUrl = splitRawUrl(value, scheme);
    if (rawUrl === null || rawUrl.path.length === 0) return sourceFailure(field);
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return sourceFailure(field);
    }
    if (
      url.protocol !== `${scheme}:` ||
      url.host.length === 0 ||
      url.port.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0 ||
      url.password.length > 0 ||
      (scheme === 'https' && url.username.length > 0) ||
      (scheme === 'ssh' && url.username !== '' && url.username !== 'git')
    ) {
      return sourceFailure(field);
    }
    host = validateHost(url.hostname);
    repositoryInput = rawUrl.path;
  } else {
    const scp = /^([^@/:]+)@([^/:]+):(.+)$/u.exec(value);
    if (scp !== null) {
      if (scp[1] !== 'git') return sourceFailure(field);
      host = validateHost(scp[2] ?? '');
      repositoryInput = scp[3] ?? null;
    } else {
      const marker = value.indexOf('//');
      const beforePath = marker < 0 ? value : value.slice(0, marker);
      const pathSuffix = marker < 0 ? '' : value.slice(marker);
      const segments = beforePath.split('/');
      const first = segments[0] ?? '';
      if (first.includes('.')) {
        host = validateHost(first);
        repositoryInput = `${segments.slice(1).join('/')}${pathSuffix}`;
      } else {
        host = 'github.com';
        repositoryInput = value;
      }
    }
  }

  if (host === null || repositoryInput === null) return sourceFailure(field);
  const parts = parseRepositoryAndPath(repositoryInput);
  if (parts === null) return sourceFailure(field);
  return ok(
    Object.freeze({
      host,
      repository: parts.repository,
      path: parts.path,
    }),
  );
};

const registryFailure = (field: string): Result<never, ManifestStateError> =>
  stateError(field, SECRET_SAFE_MESSAGES.registry);

/** Normalize canonical registry tokens, or exact legacy HTTPS registry URLs during migration. */
export const normalizeRegistryIdentity = (
  value: string,
  options: Readonly<{ legacy?: boolean }> = {},
  field = 'registry.default',
): Result<string, ManifestStateError> => {
  let token = value;
  if (options.legacy === true) {
    if (hasControlOrWhitespace(value) || /%[0-9a-f]{2}/iu.test(value)) {
      return registryFailure(field);
    }
    const rawUrl = splitRawUrl(value, 'https');
    if (rawUrl === null) return registryFailure(field);
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return registryFailure(field);
    }
    if (
      url.protocol !== 'https:' ||
      url.host.length === 0 ||
      url.port.length > 0 ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      return registryFailure(field);
    }
    token = `${url.hostname}${rawUrl.path.length === 0 ? '' : `/${rawUrl.path}`}`;
  }

  if (
    token.length === 0 ||
    hasControlOrWhitespace(token) ||
    token.includes('://') ||
    /[@?#:\\]/u.test(token) ||
    /%[0-9a-f]{2}/iu.test(token) ||
    token.startsWith('/') ||
    token.endsWith('/') ||
    token.includes('//')
  ) {
    return registryFailure(field);
  }
  const segments = token.split('/');
  const normalizedHost = validateHost(segments[0] ?? '');
  if (
    normalizedHost === null ||
    segments.slice(1).some((segment) => !validIdentitySegment(segment))
  ) {
    return registryFailure(field);
  }
  return ok([normalizedHost, ...segments.slice(1)].join('/'));
};

const RESERVED_PORTABLE_PATHS = [
  '.skillsmith/store',
  '.skillsmith/ledger',
  '.skillsmith/dev',
] as const;

export const normalizePortablePath = (
  value: string,
  scope: ManifestScope,
  field = 'path',
): Result<string, ManifestStateError> => {
  const expectedPrefix = scope === 'project' ? './' : '~/';
  if (
    !value.startsWith(expectedPrefix) ||
    value.length === expectedPrefix.length ||
    value.includes('\\') ||
    value.includes('//') ||
    hasControlOrWhitespace(value)
  ) {
    return stateError(field, SECRET_SAFE_MESSAGES.path);
  }
  const relative = value.slice(2);
  const segments = relative.split('/');
  const lowered = relative.toLowerCase();
  if (
    /^[A-Za-z]:/u.test(relative) ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..') ||
    lowered === 'placements.json' ||
    lowered === '.skillsmith/placements.json' ||
    RESERVED_PORTABLE_PATHS.some(
      (reserved) => lowered === reserved || lowered.startsWith(`${reserved}/`),
    )
  ) {
    return stateError(field, SECRET_SAFE_MESSAGES.path);
  }
  return ok(value);
};
