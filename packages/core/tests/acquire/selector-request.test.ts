import { describe, expect, test } from 'bun:test';
import { runInstall } from '../../src/acquire/run.ts';
import {
  isUsableSkillLookupName,
  validateInstallSelectorRequest,
} from '../../src/acquire/selector-request.ts';
import type { AcquisitionPorts, InstallOptions } from '../../src/acquire/types.ts';

describe('install selector preflight', () => {
  test.each(['review', 'Code Review', '@scope/name', 'résumé', '漢字', '😀'.repeat(256)])(
    'accepts a complete name: %s',
    (name) => {
      expect(isUsableSkillLookupName(name)).toBe(true);
      expect(validateInstallSelectorRequest({ sources: ['acme/repo'], skill: name })).toEqual({
        ok: true,
        value: { name, mode: 'directory-first' },
      });
    },
  );
  test.each([
    '',
    ' review',
    'review ',
    '-review',
    '--no-verify',
    'a\nb',
    'a\tb',
    'a\u0000b',
    'a\u200Bb',
    'a\u2028b',
    'a\u2029b',
    '\uD800',
    '😀'.repeat(257),
    'x'.repeat(257),
  ])('rejects an unusable name', (name) => {
    expect(isUsableSkillLookupName(name)).toBe(false);
    expect(validateInstallSelectorRequest({ sources: ['acme/repo'], skill: name }).ok).toBe(false);
  });
  test.each(
    [[], ['acme/repo', 'acme/other'], ['acme/repo/review'], ['acme/repo//skills/review']].map(
      (sources) => [sources],
    ),
  )('rejects conflicting source grammar', (sources) => {
    expect(validateInstallSelectorRequest({ sources, skill: 'review' })).toMatchObject({
      ok: false,
      error: { code: 'invalid-argument' },
    });
  });
  test('boolean override has no value and requires a name', () => {
    expect(
      validateInstallSelectorRequest({ sources: ['acme/repo'], skillsMatchFrontmatter: true }).ok,
    ).toBe(false);
    expect(
      validateInstallSelectorRequest({
        sources: ['acme/repo'],
        skill: 'review',
        skillsMatchFrontmatter: 'false',
      }).ok,
    ).toBe(false);
    expect(
      validateInstallSelectorRequest({
        sources: ['acme/repo'],
        skill: 'review',
        skillsMatchFrontmatter: true,
      }),
    ).toEqual({ ok: true, value: { name: 'review', mode: 'frontmatter' } });
    expect(validateInstallSelectorRequest({ sources: ['acme/repo/review'] })).toEqual({
      ok: true,
      value: undefined,
    });
  });
  test('validates effective refs without changing existing source failure classes', () => {
    for (const [source, ref, code] of [
      ['acme/repo@main', 'other', 'flip-refused'],
      ['acme/repo', 'bad ref', 'flip-refused'],
      ['acme/repo', '', 'flip-refused'],
      ['acme/repo', 42, 'invalid-argument'],
      ['acme/repo@abcdef1', undefined, 'source-unresolvable'],
      ['acme/repo', 'abcdef1', 'source-unresolvable'],
    ] as const) {
      expect(
        validateInstallSelectorRequest({ sources: [source], skill: 'review', ref }),
      ).toMatchObject({ ok: false, error: { code } });
    }
    expect(
      validateInstallSelectorRequest({
        sources: ['git@gitlab.example:group/sub/repo.git'],
        skill: 'review',
        ref: 'feature/review',
      }),
    ).toEqual({ ok: true, value: { name: 'review', mode: 'directory-first' } });
  });
  test('direct core calls refuse before reading any port', async () => {
    const ports = new Proxy(
      {},
      {
        get() {
          throw new Error('selector preflight touched a port');
        },
      },
    ) as AcquisitionPorts;
    for (const [request, code] of [
      [{ sources: ['acme/repo/review'], skill: 'review' }, 'invalid-argument'],
      [{ sources: ['acme/repo'], skill: '-review' }, 'invalid-argument'],
      [{ sources: ['acme/repo'], skillsMatchFrontmatter: true }, 'invalid-argument'],
      [{ sources: ['acme/repo@main'], skill: 'review', ref: 'other' }, 'flip-refused'],
      [{ sources: ['acme/repo'], skill: 'review', ref: 'bad ref' }, 'flip-refused'],
      [{ sources: ['acme/repo'], skill: 'review', ref: 'abcdef1' }, 'source-unresolvable'],
    ] as const) {
      const result = await runInstall(ports, request as unknown as InstallOptions);
      expect(result).toMatchObject({ ok: false, error: { code } });
    }
  });
});
