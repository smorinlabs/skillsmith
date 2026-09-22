import { describe, expect, test } from 'bun:test';
import matter from 'gray-matter';
import { parseSkillFrontmatter } from '../../src/skills/frontmatter.ts';

describe('parseSkillFrontmatter', () => {
  test.each(['javascript', 'JS', ' JavaScript ', 'coffee', 'unknown'])(
    'refuses the %s engine without evaluating a synthetic expression',
    (tag) => {
      const marker = '__skillsmithFrontmatterFixture';
      const globals = globalThis as unknown as Record<string, unknown>;
      delete globals[marker];
      try {
        for (const prefix of ['', '\uFEFF']) {
          const result = parseSkillFrontmatter(
            `${prefix}---${tag}\r\n({name:(globalThis.${marker}=true,'fixture')})\r\n---\r\n`,
          );
          expect(result).toMatchObject({ ok: false, error: { code: 'skill-parse-error' } });
          expect(globals[marker]).toBeUndefined();
        }
        expect(parseSkillFrontmatter(`---${tag}\n\n---\n`).ok).toBe(false);
      } finally {
        delete globals[marker];
      }
    },
  );

  test.each(['', 'yaml', 'YML', ' yaml '])('preserves the %s YAML header', (tag) => {
    expect(parseSkillFrontmatter(`\uFEFF---${tag}\r\nname: fixture\r\n---\r\n`)).toEqual({
      ok: true,
      value: { name: 'fixture' },
    });
  });

  test('preserves JSON, scalar metadata, and existing closing-delimiter behavior', () => {
    expect(parseSkillFrontmatter('---json\n{"name":"fixture"}\n---\n')).toEqual({
      ok: true,
      value: { name: 'fixture' },
    });
    for (const body of ['null', '42', '[]'])
      expect(parseSkillFrontmatter(`---json\n${body}\n---\n`)).toEqual({ ok: true, value: {} });
    for (const tail of ['', '---suffix\nbody'])
      expect(parseSkillFrontmatter(`---\nname: fixture\n${tail}`)).toEqual({
        ok: true,
        value: { name: 'fixture' },
      });
  });

  test.each(['---\nname: [\n---\n', '---json\n{"name":\n---\n'])(
    'a malformed document remains an excerpt-free error on repeated reads',
    (source) => {
      for (let i = 0; i < 2; i++) {
        const result = parseSkillFrontmatter(source, 'fixture/SKILL.md');
        expect(result).toEqual({
          ok: false,
          error: {
            code: 'skill-parse-error',
            file: 'fixture/SKILL.md',
            message: 'invalid skill frontmatter',
          },
        });
      }
    },
  );

  test('ignores the library global parse cache', () => {
    const source = '---\nname: cache-control\n---\n';
    const cache = (matter as typeof matter & { cache: Record<string, unknown> }).cache;
    cache[source] = { data: { name: 'wrong-cache-value' }, content: '', orig: source };
    try {
      expect(parseSkillFrontmatter(source)).toEqual({ ok: true, value: { name: 'cache-control' } });
    } finally {
      delete cache[source];
    }
  });

  test('returns empty frontmatter for a body-only file', () => {
    const r = parseSkillFrontmatter('# Hello\n\nno frontmatter here');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({});
  });

  test('parses name, description, version', () => {
    const r = parseSkillFrontmatter(
      '---\nname: grep\ndescription: search files\nversion: 1.2.3\n---\n\n# body',
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe('grep');
      expect(r.value.description).toBe('search files');
      expect(r.value.version).toBe('1.2.3');
    }
  });

  test('ignores unknown frontmatter keys', () => {
    const r = parseSkillFrontmatter('---\nname: grep\nbogus: true\n---\n');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe('grep');
  });

  test('ignores non-string values for known fields (type-mismatch is silent)', () => {
    const r = parseSkillFrontmatter('---\nname: 123\ndescription:\n  - not-a-string\n---\n');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBeUndefined();
      expect(r.value.description).toBeUndefined();
    }
  });
});

test('repeated byte-order marks cannot expose executable engines after validation', () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const marker = '__skillsmithRepeatedBomFixture';
  try {
    for (const count of [0, 1, 2, 3, 4]) {
      delete globals[marker];
      const source = `${'\uFEFF'.repeat(count)}---javascript\n({name:(globalThis.${marker}=true,'fixture')})\n---\n`;
      const result = parseSkillFrontmatter(source);
      expect(globals[marker]).toBeUndefined();
      expect(result.ok ? result.value.name : undefined).toBeUndefined();
    }
  } finally {
    delete globals[marker];
  }
});
