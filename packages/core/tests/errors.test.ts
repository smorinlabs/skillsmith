import { describe, expect, test } from 'bun:test';
import { genericError, unknownToolError } from '../src/errors.ts';

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
});
