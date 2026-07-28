export interface CompiledWildcardTarget {
  readonly matches: (candidate: string) => boolean;
}

const NUL_SENTINEL = '\0';
const BACKSLASH_SENTINEL = '\u0001';
const ESCAPED_GLOB_SYNTAX = '[]{}!,';

const NEVER_MATCH: CompiledWildcardTarget = Object.freeze({ matches: () => false });

const containsReservedSentinel = (value: string): boolean =>
  value.includes(NUL_SENTINEL) || value.includes(BACKSLASH_SENTINEL);

const lineTerminatorMarker = (character: string): string | null => {
  switch (character) {
    case '\n':
      return '/n/';
    case '\r':
      return '/r/';
    case '\u2028':
      return '/8/';
    case '\u2029':
      return '/9/';
    default:
      return null;
  }
};

const encodeCandidate = (candidate: string): string | null => {
  if (containsReservedSentinel(candidate)) return null;
  let encoded = '';
  for (const character of candidate) {
    if (character === '/') encoded += NUL_SENTINEL;
    else if (character === '\\') encoded += BACKSLASH_SENTINEL;
    else encoded += lineTerminatorMarker(character) ?? character;
  }
  return encoded;
};

const encodeWildcardTarget = (target: string): string | null => {
  if (containsReservedSentinel(target)) return null;
  let encoded = '';
  let previousWasStar = false;
  for (const character of target) {
    if (character === '*') {
      if (!previousWasStar) encoded += character;
      previousWasStar = true;
      continue;
    }
    previousWasStar = false;
    if (character === '?') encoded += character;
    else if (character === '/') encoded += NUL_SENTINEL;
    else if (character === '\\') encoded += BACKSLASH_SENTINEL;
    else {
      const marker = lineTerminatorMarker(character);
      if (marker !== null) encoded += marker;
      else if (ESCAPED_GLOB_SYNTAX.includes(character)) encoded += `\\${character}`;
      else encoded += character;
    }
  }
  return encoded;
};

/**
 * Compile the public target language (`*` and `?` only) into Bun's native whole-string matcher.
 * Reserved sentinel input and matcher failures always fail closed.
 */
export const compileWildcardTarget = (target: string): CompiledWildcardTarget => {
  if (containsReservedSentinel(target)) return NEVER_MATCH;
  if (!target.includes('*') && !target.includes('?')) {
    return Object.freeze({
      matches: (candidate: string): boolean =>
        !containsReservedSentinel(candidate) && candidate === target,
    });
  }

  const encodedTarget = encodeWildcardTarget(target);
  if (encodedTarget === null) return NEVER_MATCH;
  try {
    const glob = new Bun.Glob(encodedTarget);
    return Object.freeze({
      matches: (candidate: string): boolean => {
        const encodedCandidate = encodeCandidate(candidate);
        if (encodedCandidate === null) return false;
        try {
          return glob.match(encodedCandidate);
        } catch {
          return false;
        }
      },
    });
  } catch {
    return NEVER_MATCH;
  }
};
