import { describe, expect, test } from 'bun:test';
import { searchV1Codec, toSearchV1Dto } from '../../src/contracts/v1/search.ts';
import { parseSkillsShResponse } from '../../src/search/skills-sh.ts';
import { encodedSearch, searchRequest } from '../fixtures/search.ts';

const parsed = parseSkillsShResponse(encodedSearch(), searchRequest);
if (!parsed.ok) throw new Error('invalid fixture');
const dto = toSearchV1Dto(parsed.value);

describe('search@1', () => {
  test('owns stable fields, order, and terminal framing', () => {
    const result = searchV1Codec.encode(dto);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.endsWith('\n')).toBe(true);
    expect(searchV1Codec.decode(result.value)).toEqual({ ok: true, value: dto });
    expect(dto).not.toHaveProperty('installHint');
    expect(dto.results[0]).not.toHaveProperty('installHint');
    expect(searchV1Codec.descriptor).toMatchObject({
      id: 'search',
      version: 1,
      wireKind: 'skillsmith.search',
      unknownFields: 'reject-recursive',
    });
  });
  test('rejects recursive additions and inconsistent counts/identity', () => {
    for (const bad of [
      { ...dto, extra: true },
      { ...dto, results: [{ ...dto.results[0], installed: true }] },
      { ...dto, returned: 0 },
      { ...dto, limit: 1 },
      { ...dto, results: [dto.results[0], dto.results[0]] },
      { ...dto, schemaVersion: 2 },
      { ...dto, kind: 'other' },
    ])
      expect(searchV1Codec.validate(bad).ok).toBe(false);
  });
});
