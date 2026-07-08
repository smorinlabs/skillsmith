import { type SkillSmithError, flipRefusedError } from '../errors.ts';
import { type Result, err, ok } from '../result.ts';
import type { SourceSpec } from './types.ts';

type Selector = SourceSpec['selector'];

const SHORT_SHA_RE = /^[0-9a-f]{7,39}$/;
const SCP_RE = /^([^/\s]+)@([^/:\s]+):(.*)$/s;
const ALLOWED_SCHEMES = ['https', 'http', 'ssh', 'git'];

const ONE_PART_MSG = "one-part names are reserved for a future registry; use 'owner/repo[/<name>]'";
const AMBIGUOUS_SUBGROUP_MSG =
  "ambiguous subgroup path — use '<host>/group/sub/repo//path/to/skill' or a trailing '//' for a whole-repo scan";
const DOT_PREFIX_MSG = 'dot-prefixed skills are invisible to placement detection';

const stripDotGit = (s: string): string => (s.endsWith('.git') ? s.slice(0, -4) : s);

const isLocalPath = (body: string): boolean =>
  body === '.' ||
  body === '..' ||
  body.startsWith('/') ||
  body.startsWith('./') ||
  body.startsWith('../') ||
  body.startsWith('~');

const stripUserinfo = (authority: string): string => {
  const at = authority.lastIndexOf('@');
  return at === -1 ? authority : authority.slice(at + 1);
};

// The last '@' before the last '/' — reject unless it's a URL/scp authority ('@' isn't the
// ref separator there, but a legitimate userinfo/scp marker).
const embeddedAtReject = (raw: string, atIdx: number): SkillSmithError => {
  const afterAt = raw.slice(atIdx + 1);
  const relSlash = afterAt.indexOf('/');
  const end = relSlash === -1 ? raw.length : atIdx + 1 + relSlash;
  const refToken = raw.slice(atIdx + 1, end);
  const rebuilt = `${raw.slice(0, atIdx)}${raw.slice(end)}@${refToken}`;
  return flipRefusedError(`place '@${refToken}' after the skill path: '${rebuilt}'`);
};

const splitRef = (raw: string): Result<{ body: string; ref: string | null }, SkillSmithError> => {
  const lastSlash = raw.lastIndexOf('/');
  const lastAt = raw.lastIndexOf('@');

  if (lastAt > lastSlash) {
    return ok({ body: raw.slice(0, lastAt), ref: raw.slice(lastAt + 1) });
  }
  if (lastAt === -1) {
    return ok({ body: raw, ref: null });
  }

  // '@' is present but not after the last '/' — legitimate only as URL userinfo or scp authority.
  const schemeIdx = raw.indexOf('://');
  if (schemeIdx !== -1) {
    const authorityEnd = raw.indexOf('/', schemeIdx + 3);
    const boundary = authorityEnd === -1 ? raw.length : authorityEnd;
    if (lastAt < boundary) return ok({ body: raw, ref: null });
  }
  if (SCP_RE.test(raw)) {
    return ok({ body: raw, ref: null });
  }
  return err(embeddedAtReject(raw, lastAt));
};

const buildSelector = (skillPathRaw: string | null): Result<Selector, SkillSmithError> => {
  if (skillPathRaw === null || skillPathRaw === '') return ok({ kind: 'whole-repo' });

  const segments = skillPathRaw.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      return err(flipRefusedError(`invalid skill path segment '${seg}'`));
    }
  }

  const final = segments[segments.length - 1] ?? '';
  if (final.startsWith('.')) return err(flipRefusedError(DOT_PREFIX_MSG));

  return ok({ kind: 'path', path: segments.join('/') });
};

// Shared repo-path / selector / cloneUrl derivation for URL and scp forms: both are an
// authority (host, possibly with userinfo already stripped) followed by a path that may carry
// an optional `//skillpath` marker.
const buildFromAuthorityPath = (
  raw: string,
  body: string,
  ref: string | null,
  host: string,
  pathPortion: string,
  pathAbsStart: number,
  leadingSlash: boolean,
): Result<SourceSpec, SkillSmithError> => {
  const dsIdx = pathPortion.indexOf('//');

  let repoRaw: string;
  let skillPathRaw: string | null;
  let cloneUrl: string;

  if (dsIdx === -1) {
    repoRaw = leadingSlash ? pathPortion.slice(1) : pathPortion;
    skillPathRaw = null;
    cloneUrl = body;
  } else {
    repoRaw = leadingSlash ? pathPortion.slice(1, dsIdx) : pathPortion.slice(0, dsIdx);
    skillPathRaw = pathPortion.slice(dsIdx + 2);
    cloneUrl = body.slice(0, pathAbsStart + dsIdx);
  }

  const selectorResult = buildSelector(skillPathRaw);
  if (!selectorResult.ok) return selectorResult;

  return ok({
    raw,
    host,
    repoPath: stripDotGit(repoRaw),
    cloneUrl,
    selector: selectorResult.value,
    ref,
  });
};

const parseUrlForm = (
  raw: string,
  body: string,
  ref: string | null,
): Result<SourceSpec, SkillSmithError> => {
  const schemeIdx = body.indexOf('://');
  const scheme = body.slice(0, schemeIdx);
  if (!ALLOWED_SCHEMES.includes(scheme)) {
    return err(
      flipRefusedError(`unsupported URL scheme '${scheme}' — use https, http, ssh, or git`),
    );
  }

  const afterScheme = schemeIdx + 3;
  const pathStart = body.indexOf('/', afterScheme);
  const authority = pathStart === -1 ? body.slice(afterScheme) : body.slice(afterScheme, pathStart);
  const pathPortion = pathStart === -1 ? '' : body.slice(pathStart);
  const pathAbsStart = pathStart === -1 ? body.length : pathStart;

  return buildFromAuthorityPath(
    raw,
    body,
    ref,
    stripUserinfo(authority),
    pathPortion,
    pathAbsStart,
    true,
  );
};

const parseScpForm = (
  raw: string,
  body: string,
  ref: string | null,
  match: RegExpMatchArray,
): Result<SourceSpec, SkillSmithError> => {
  const host = match[2] ?? '';
  const pathPortion = match[3] ?? '';
  const pathAbsStart = body.length - pathPortion.length;

  return buildFromAuthorityPath(raw, body, ref, host, pathPortion, pathAbsStart, false);
};

const parseSugarOrHostExplicit = (
  raw: string,
  body: string,
  ref: string | null,
): Result<SourceSpec, SkillSmithError> => {
  const dsIdx = body.indexOf('//');
  let base: string;
  let skillPathRaw: string | null;

  if (dsIdx === -1) {
    base = body.endsWith('/') ? body.slice(0, -1) : body;
    skillPathRaw = null;
  } else {
    base = body.slice(0, dsIdx);
    skillPathRaw = body.slice(dsIdx + 2);
  }

  const segments = base.split('/');
  const first = segments[0] ?? '';
  const isHostExplicit = first.includes('.') || first.includes(':');
  const host = isHostExplicit ? first : 'github.com';
  const rest = isHostExplicit ? segments.slice(1) : segments;

  let repoSegments: string[];
  let nameSelector: string | null = null;

  if (dsIdx !== -1) {
    // With `//`, ALL segments after the host are the repo path (any depth).
    repoSegments = rest;
  } else if (!isHostExplicit && rest.length === 1) {
    return err(flipRefusedError(ONE_PART_MSG));
  } else if (rest.length === 2) {
    repoSegments = rest;
  } else if (rest.length === 3) {
    repoSegments = rest.slice(0, 2);
    nameSelector = rest[2] ?? '';
  } else {
    return err(flipRefusedError(AMBIGUOUS_SUBGROUP_MSG));
  }

  if (nameSelector?.startsWith('.')) {
    return err(flipRefusedError(DOT_PREFIX_MSG));
  }

  const repoPath = stripDotGit(repoSegments.join('/'));
  const cloneUrl = `https://${host}/${repoPath}.git`;

  if (nameSelector !== null) {
    return ok({
      raw,
      host,
      repoPath,
      cloneUrl,
      selector: { kind: 'name', name: nameSelector },
      ref,
    });
  }

  const selectorResult = buildSelector(skillPathRaw);
  if (!selectorResult.ok) return selectorResult;

  return ok({ raw, host, repoPath, cloneUrl, selector: selectorResult.value, ref });
};

export const parseSource = (raw: string): Result<SourceSpec, SkillSmithError> => {
  const splitResult = splitRef(raw);
  if (!splitResult.ok) return splitResult;
  const { body, ref } = splitResult.value;

  if (ref !== null && SHORT_SHA_RE.test(ref)) {
    return err(
      flipRefusedError(
        'short SHAs cannot be resolved remotely; use a full 40-hex SHA, a tag, or a branch',
      ),
    );
  }

  if (body.includes('://')) {
    return parseUrlForm(raw, body, ref);
  }

  const scpMatch = body.match(SCP_RE);
  if (scpMatch) {
    return parseScpForm(raw, body, ref, scpMatch);
  }

  if (isLocalPath(body)) {
    return err(
      flipRefusedError(
        `install acquires remote sources only — '${raw}' is a local path. For a local checkout use 'skillsmith dev <skill> --source <path>' then 'skillsmith promote <skill>'`,
      ),
    );
  }

  return parseSugarOrHostExplicit(raw, body, ref);
};
