import { describe, expect, test } from 'bun:test';
import { genericError, skillParseError, unknownToolError } from '../src/errors.ts';

describe('SkillSmithError', () => {
  test('genericError carries message and optional cause', () => {
    const e = genericError('boom', new Error('root'));
    expect(e.code).toBe('generic');
    if (e.code === 'generic') {
      expect(e.message).toBe('boom');
      expect((e.cause as Error).message).toBe('root');
    }
  });
  test('unknownToolError carries tool name', () => {
    const e = unknownToolError('foobar');
    expect(e.code).toBe('unknown-tool');
    if (e.code === 'unknown-tool') {
      expect(e.tool).toBe('foobar');
    }
  });
  test('skillParseError carries message and file', () => {
    const e = skillParseError('bad yaml', '/a/b/SKILL.md');
    expect(e.code).toBe('skill-parse-error');
    if (e.code === 'skill-parse-error') {
      expect(e.message).toBe('bad yaml');
      expect(e.file).toBe('/a/b/SKILL.md');
    }
  });
});
