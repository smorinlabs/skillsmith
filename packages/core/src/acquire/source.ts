import {
  normalizeSourceIdentity,
  validateManifestName,
  validateRequestedRef,
} from '../artifacts/identity.ts';
import { type SkillSmithError, flipRefusedError, sourceUnresolvableError } from '../errors.ts';
import { type Result, err, ok } from '../result.ts';
import { containsSensitiveMaterial } from '../safety/redaction.ts';
import type { SourceSpec } from './types.ts';

type Selector = SourceSpec['selector'];

const SHORT_SHA_RE = /^[0-9a-f]{7,39}$/u;
const SCP_RE = /^([^@/:]+)@([^/:]+):(.+)$/u;
const PERCENT_ESCAPE = /%[0-9a-f]{2}/iu;
const ONE_PART_MSG = "one-part names are reserved for a future registry; use 'owner/repo[/<name>]'";
const AMBIGUOUS_SUBGROUP_MSG =
  "ambiguous subgroup path — use '<host>/group/sub/repo//path/to/skill' or a trailing '//' for a whole-repo scan";
const INVALID_SOURCE_MSG = 'install source is invalid';
const INVALID_REF_MSG = 'install requested ref is invalid';
const INLINE_OVERRIDE_MSG = 'inline source ref conflicts with override ref';

const hasControlOrWhitespace = (input: string): boolean => {
  for (const character of input) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x20 || codePoint === 0x7f || /\s/u.test(character)) return true;
  }
  return false;
};

export interface ParseSourceOptions {
  readonly overrideRef?: string;
}

const refused = (message = INVALID_SOURCE_MSG): Result<never, SkillSmithError> =>
  err(flipRefusedError(message));

const splitInlineRef = (
  input: string,
): Result<Readonly<{ body: string; inlineRef: string | null }>, SkillSmithError> => {
  const lastAt = input.lastIndexOf('@');
  if (lastAt < 0) return ok({ body: input, inlineRef: null });

  const schemeIndex = input.indexOf('://');
  if (schemeIndex >= 0) {
    const authorityEndRaw = input.indexOf('/', schemeIndex + 3);
    const authorityEnd = authorityEndRaw < 0 ? input.length : authorityEndRaw;
    if (lastAt < authorityEnd) return ok({ body: input, inlineRef: null });
  } else {
    const firstAt = input.indexOf('@');
    const colon = input.indexOf(':', firstAt + 1);
    if (firstAt >= 0 && colon > firstAt && lastAt === firstAt) {
      return ok({ body: input, inlineRef: null });
    }
  }

  const lastSlash = input.lastIndexOf('/');
  if (lastAt < lastSlash) return refused();
  return ok({ body: input.slice(0, lastAt), inlineRef: input.slice(lastAt + 1) });
};

const selectorForPath = (path: string | null): Result<Selector, SkillSmithError> => {
  if (path === null || path === '') return ok(Object.freeze({ kind: 'whole-repo' as const }));
  const segments = path.split('/');
  if (
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('\\') ||
    hasControlOrWhitespace(path) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    return refused();
  }
  return ok(Object.freeze({ kind: 'path' as const, path }));
};

interface SplitRepository {
  readonly repository: string;
  readonly selector: Selector;
  readonly hadDotGit: boolean;
}

const splitRepository = (input: string): Result<SplitRepository, SkillSmithError> => {
  const marker = input.indexOf('//');
  const repositoryRaw = marker < 0 ? input : input.slice(0, marker);
  const selectorRaw = marker < 0 ? null : input.slice(marker + 2);
  const hadDotGit = repositoryRaw.endsWith('.git');
  const repository = hadDotGit ? repositoryRaw.slice(0, -4) : repositoryRaw;
  const selector = selectorForPath(selectorRaw);
  if (!selector.ok) return selector;
  return ok({ repository, selector: selector.value, hadDotGit });
};

interface ParsedProjection {
  readonly host: string;
  readonly repository: string;
  readonly selector: Selector;
  readonly cloneUrl: string;
}

const parseUrl = (body: string): Result<ParsedProjection, SkillSmithError> => {
  if (body.includes('?') || body.includes('#') || PERCENT_ESCAPE.test(body)) return refused();
  const raw = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]*)(?:\/(.*))?$/u.exec(body);
  if (raw === null) return refused();
  const rawScheme = (raw[1] ?? '').toLowerCase();
  const rawAuthority = raw[2] ?? '';
  const rawPath = raw[3] ?? '';
  const rawHost =
    rawScheme === 'ssh' && rawAuthority.startsWith('git@') ? rawAuthority.slice(4) : rawAuthority;
  if (
    rawAuthority.length === 0 ||
    rawHost.length === 0 ||
    rawHost.includes(':') ||
    rawPath.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    return refused();
  }
  let url: URL;
  try {
    url = new URL(body);
  } catch {
    return refused();
  }
  const scheme = url.protocol.toLowerCase();
  if (scheme !== 'https:' && scheme !== 'ssh:') return refused();
  if (
    url.hostname.length === 0 ||
    url.port.length > 0 ||
    url.password.length > 0 ||
    (scheme === 'https:' && url.username.length > 0) ||
    (scheme === 'ssh:' && url.username !== 'git')
  ) {
    return refused();
  }
  const path = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;
  if (path.length === 0) return refused();
  const split = splitRepository(path);
  if (!split.ok) return split;
  const cloneUrl = `${scheme}//${scheme === 'ssh:' ? 'git@' : ''}${url.hostname.toLowerCase()}/${split.value.repository}${split.value.hadDotGit ? '.git' : ''}`;
  return ok({
    host: url.hostname.toLowerCase(),
    repository: split.value.repository,
    selector: split.value.selector,
    cloneUrl,
  });
};

const parseScp = (match: RegExpMatchArray): Result<ParsedProjection, SkillSmithError> => {
  if (match[1] !== 'git') return refused();
  const host = match[2] ?? '';
  const path = match[3] ?? '';
  if (/^\d+\//u.test(path)) return refused();
  const split = splitRepository(path);
  if (!split.ok) return split;
  return ok({
    host: host.toLowerCase(),
    repository: split.value.repository,
    selector: split.value.selector,
    cloneUrl: `git@${host.toLowerCase()}:${split.value.repository}${split.value.hadDotGit ? '.git' : ''}`,
  });
};

const parseShorthand = (body: string): Result<ParsedProjection, SkillSmithError> => {
  const marker = body.indexOf('//');
  const base = marker < 0 ? body : body.slice(0, marker);
  const selectorRaw = marker < 0 ? null : body.slice(marker + 2);
  const segments = base.split('/');
  const first = segments[0] ?? '';
  const explicitHost = first.includes('.');
  const host = explicitHost ? first.toLowerCase() : 'github.com';
  const rest = explicitHost ? segments.slice(1) : segments;
  if (first.includes(':') || rest.some((segment) => segment.length === 0)) return refused();

  let repositorySegments: readonly string[];
  let selector: Selector;
  if (marker >= 0) {
    repositorySegments = rest;
    const built = selectorForPath(selectorRaw);
    if (!built.ok) return built;
    selector = built.value;
  } else if (!explicitHost && rest.length === 1) {
    return refused(ONE_PART_MSG);
  } else if (rest.length === 2) {
    repositorySegments = rest;
    selector = Object.freeze({ kind: 'whole-repo' as const });
  } else if (rest.length === 3) {
    repositorySegments = rest.slice(0, 2);
    const name = rest[2] ?? '';
    if (!validateManifestName(name, 'install.selector').ok) return refused();
    selector = Object.freeze({ kind: 'name' as const, name });
  } else {
    return refused(AMBIGUOUS_SUBGROUP_MSG);
  }

  const rawRepository = repositorySegments.join('/');
  const repository = rawRepository.endsWith('.git') ? rawRepository.slice(0, -4) : rawRepository;
  return ok({
    host,
    repository,
    selector,
    cloneUrl: `https://${host}/${repository}.git`,
  });
};

const buildSpec = (
  projection: ParsedProjection,
  ref: string | null,
): Result<SourceSpec, SkillSmithError> => {
  const pathSuffix = projection.selector.kind === 'path' ? `//${projection.selector.path}` : '';
  const normalized = normalizeSourceIdentity(
    `https://${projection.host}/${projection.repository}${pathSuffix}`,
    'install.source',
  );
  if (!normalized.ok) return refused();
  if (
    normalized.value.host !== projection.host ||
    normalized.value.repository !== projection.repository ||
    normalized.value.path !==
      (projection.selector.kind === 'path' ? projection.selector.path : null)
  ) {
    return refused();
  }

  const canonicalSource = `${normalized.value.host}/${normalized.value.repository}${pathSuffix}`;
  const selectorSuffix = projection.selector.kind === 'name' ? `/${projection.selector.name}` : '';
  const canonicalInvocation = `${canonicalSource}${selectorSuffix}${ref === null ? '' : `@${ref}`}`;
  const checked = [
    projection.host,
    projection.repository,
    projection.cloneUrl,
    canonicalSource,
    canonicalInvocation,
    ...(projection.selector.kind === 'whole-repo'
      ? []
      : [
          projection.selector.kind === 'name' ? projection.selector.name : projection.selector.path,
        ]),
    ...(ref === null ? [] : [ref]),
  ];
  if (checked.some(containsSensitiveMaterial)) return refused();

  return ok(
    Object.freeze({
      identity: normalized.value,
      canonicalSource,
      canonicalInvocation,
      originSource: canonicalSource,
      cloneUrl: projection.cloneUrl,
      selector: projection.selector,
      ref,
    }),
  );
};

/** The sole acquisition parse/build boundary for inline and override refs. */
export const parseSource = (
  input: string,
  options: ParseSourceOptions = {},
): Result<SourceSpec, SkillSmithError> => {
  if (
    input.length === 0 ||
    hasControlOrWhitespace(input) ||
    input.includes('\\') ||
    PERCENT_ESCAPE.test(input)
  ) {
    return refused();
  }
  const split = splitInlineRef(input);
  if (!split.ok) return split;
  const { body, inlineRef } = split.value;
  if (inlineRef !== null && options.overrideRef !== undefined) return refused(INLINE_OVERRIDE_MSG);
  const ref = inlineRef ?? options.overrideRef ?? null;
  if (ref !== null) {
    if (
      PERCENT_ESCAPE.test(ref) ||
      containsSensitiveMaterial(ref) ||
      !validateRequestedRef(ref, 'install.ref').ok
    ) {
      return refused(INVALID_REF_MSG);
    }
    if (SHORT_SHA_RE.test(ref)) {
      return err(
        sourceUnresolvableError(
          'short SHAs cannot be resolved remotely; use a full 40-hex SHA, a tag, or a branch',
        ),
      );
    }
  }

  let projection: Result<ParsedProjection, SkillSmithError>;
  if (body.includes('://')) projection = parseUrl(body);
  else {
    const scp = body.match(SCP_RE);
    projection = scp === null ? parseShorthand(body) : parseScp(scp);
  }
  if (!projection.ok) return projection;
  return buildSpec(projection.value, ref);
};

/** Preserve transport and exact path only when the existing public grammar can round-trip them. */
export const exactSourceRetry = (source: SourceSpec, path: string): string | null => {
  if (path === '') return null;
  const operand = `${source.cloneUrl}//${path}`;
  const parsed = parseSource(operand, source.ref === null ? {} : { overrideRef: source.ref });
  return parsed.ok &&
    parsed.value.cloneUrl === source.cloneUrl &&
    parsed.value.ref === source.ref &&
    parsed.value.identity.host === source.identity.host &&
    parsed.value.identity.repository === source.identity.repository &&
    parsed.value.selector.kind === 'path' &&
    parsed.value.selector.path === path
    ? operand
    : null;
};
