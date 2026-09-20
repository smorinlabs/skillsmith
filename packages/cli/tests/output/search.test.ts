import { describe, expect, test } from 'bun:test';
import { parseSkillsShResponse } from '../../../core/src/search/skills-sh.ts';
import {
  encodedSearch,
  searchPayload,
  searchRequest,
} from '../../../core/tests/fixtures/search.ts';
import { renderSearchHuman } from '../../src/output/search-human.ts';
import { renderSearchJson } from '../../src/output/search-json.ts';

describe('search presentation', () => {
  test('escapes terminal text while retaining raw identifiers in owned JSON', () => {
    const parsed = parseSkillsShResponse(
      encodedSearch({
        ...searchPayload,
        skills: searchPayload.skills.map((hit) => ({ ...hit, name: '\u001b[31mred\n\u202ename' })),
      }),
      searchRequest,
    );
    if (!parsed.ok) throw new Error('fixture failed');
    const human = renderSearchHuman(parsed.value);
    expect(human).not.toContain('\u001b');
    expect(human).not.toContain('\u202e');
    expect(human).toContain('Verification: not checked');
    expect(human).not.toContain('install --skill');
    expect(JSON.parse(renderSearchJson(parsed.value)).results[0].name).toBe(
      '\u001b[31mred\n\u202ename',
    );
  });
  test('selection shows one entry and empty search has a distinct success message', () => {
    const parsed = parseSkillsShResponse(encodedSearch(), searchRequest);
    if (!parsed.ok) throw new Error('fixture failed');
    const text = renderSearchHuman(parsed.value, parsed.value.results[1]?.catalogId ?? null);
    expect(text).toContain('popular');
    expect(text).not.toContain('different-name');
    expect(renderSearchHuman({ ...parsed.value, returned: 0, results: [] })).toContain(
      'No matching skills',
    );
  });
});
