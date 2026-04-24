import { describe, expect, test } from 'bun:test';
import { parseSkillFrontmatter } from '../../src/skills/frontmatter.ts';

describe('parseSkillFrontmatter', () => {
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

  test('returns err for malformed YAML', () => {
    const r = parseSkillFrontmatter('---\nname: [unclosed\n---\n');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('skill-parse-error');
  });
});
