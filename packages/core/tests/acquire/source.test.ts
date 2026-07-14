import { describe, expect, test } from 'bun:test';
import { parseSource } from '../../src/acquire/source.ts';
import type { SourceSpec } from '../../src/acquire/types.ts';

const FULL_SHA = 'a'.repeat(40);

const unwrap = (input: string, overrideRef?: string): SourceSpec => {
  const result = parseSource(input, overrideRef === undefined ? {} : { overrideRef });
  expect(result.ok, input).toBeTrue();
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
};

const reject = (input: string, overrideRef?: string): void => {
  const result = parseSource(input, overrideRef === undefined ? {} : { overrideRef });
  expect(result.ok, input).toBeFalse();
  if (!result.ok) {
    expect(result.error.code, input).toBe('flip-refused');
    expect(JSON.stringify(result.error), input).not.toContain('P17_SECRET_CANARY');
  }
};

describe('parseSource — canonical acquisition boundary', () => {
  test('formats shorthand/name/path/ref DTOs without retaining the raw spelling', () => {
    expect(unwrap('owner/repo')).toEqual({
      identity: { host: 'github.com', repository: 'owner/repo', path: null },
      canonicalSource: 'github.com/owner/repo',
      canonicalInvocation: 'github.com/owner/repo',
      originSource: 'github.com/owner/repo',
      cloneUrl: 'https://github.com/owner/repo.git',
      selector: { kind: 'whole-repo' },
      ref: null,
    });
    expect(unwrap('owner/repo/review@main')).toMatchObject({
      canonicalSource: 'github.com/owner/repo',
      canonicalInvocation: 'github.com/owner/repo/review@main',
      originSource: 'github.com/owner/repo',
      selector: { kind: 'name', name: 'review' },
      ref: 'main',
    });
    expect(unwrap('gitlab.example/acme/platform/tools//skills/review')).toMatchObject({
      identity: {
        host: 'gitlab.example',
        repository: 'acme/platform/tools',
        path: 'skills/review',
      },
      canonicalSource: 'gitlab.example/acme/platform/tools//skills/review',
      canonicalInvocation: 'gitlab.example/acme/platform/tools//skills/review',
      originSource: 'gitlab.example/acme/platform/tools//skills/review',
      cloneUrl: 'https://gitlab.example/acme/platform/tools.git',
      selector: { kind: 'path', path: 'skills/review' },
    });
    const spec = unwrap('owner/repo//skills/review', 'release/2026-07');
    expect(spec.canonicalInvocation).toBe('github.com/owner/repo//skills/review@release/2026-07');
    expect(spec).not.toHaveProperty('raw');
    expect(spec).not.toHaveProperty('host');
    expect(spec).not.toHaveProperty('repoPath');
    expect(Object.isFrozen(spec)).toBeTrue();
    expect(Object.isFrozen(spec.selector)).toBeTrue();
  });

  test('preserves only accepted ephemeral transport metadata', () => {
    expect(unwrap('https://gitlab.example/acme/tools.git//skills/review@main')).toMatchObject({
      cloneUrl: 'https://gitlab.example/acme/tools.git',
      canonicalInvocation: 'gitlab.example/acme/tools//skills/review@main',
    });
    expect(unwrap('ssh://git@gitlab.example/acme/tools.git//skills/review')).toMatchObject({
      cloneUrl: 'ssh://git@gitlab.example/acme/tools.git',
      canonicalSource: 'gitlab.example/acme/tools//skills/review',
    });
    expect(unwrap('git@gitlab.example:acme/tools.git//skills/review@main')).toMatchObject({
      cloneUrl: 'git@gitlab.example:acme/tools.git',
      canonicalInvocation: 'gitlab.example/acme/tools//skills/review@main',
    });
  });

  test('rejects hostile transports, foreign paths, traversal, malformed refs, and conflicts', () => {
    for (const input of [
      'https://user@example.com/acme/repo',
      'https://user:pass@example.com/acme/repo',
      'https://example.com/acme/repo?mode=raw',
      'https://example.com/acme/repo#readme',
      'https://example.com/acme%2Frepo',
      'http://example.com/acme/repo',
      'git://example.com/acme/repo',
      'file:///tmp/acme/repo',
      'ssh://deploy@example.com/acme/repo',
      'ssh://git@example.com:2222/acme/repo',
      'deploy@example.com:acme/repo',
      'git@example.com:2222/acme/repo',
      'https://example..com/acme/repo',
      'https://example.com/acme/../repo',
      'https://example.com/acme/./repo',
      'https://example.com:/acme/repo',
      'https://example.com:443/acme/repo',
      'ssh://git@example.com:/acme/repo',
      'ssh://git@example.com:22/acme/repo',
      'example.com/acme/repo//skills/../review',
      'example.com/acme/repo//skills//review',
      '/tmp/acme/repo',
      'C:\\acme\\repo',
      '\\\\server\\share\\repo',
      'owner/repo@bad ref',
      'owner/repo@token=P17_SECRET_CANARY',
    ]) {
      reject(input);
    }
    for (const encodedRef of [
      '%74oken=P17_SECRET_CANARY',
      't%6fken=P17_SECRET_CANARY',
      '%70assword=P17_SECRET_CANARY',
      '%2574oken=P17_SECRET_CANARY',
      '%2525252574oken=P17_SECRET_CANARY',
    ]) {
      reject('owner/repo', encodedRef);
    }
    reject('owner/repo@main', 'release');
  });

  test('keeps the signed short-SHA resolution error', () => {
    const result = parseSource('owner/repo@8c1d2e3');
    expect(result.ok).toBeFalse();
    if (!result.ok) expect(result.error.code).toBe('source-unresolvable');
    expect(unwrap(`owner/repo@${FULL_SHA}`).ref).toBe(FULL_SHA);
  });
});
