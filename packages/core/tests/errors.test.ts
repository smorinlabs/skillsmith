import { describe, expect, test } from 'bun:test';
import {
  flipFailedError,
  flipRefusedError,
  genericError,
  ledgerError,
  permissionDeniedError,
  placementNotFoundError,
  skillParseError,
  sourceUnresolvableError,
  unknownToolError,
} from '../src/errors.ts';

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
  test('placementNotFoundError carries message', () => {
    const e = placementNotFoundError('no placement');
    expect(e.code).toBe('placement-not-found');
    if (e.code === 'placement-not-found') {
      expect(e.message).toBe('no placement');
    }
  });
  test('sourceUnresolvableError carries message', () => {
    const e = sourceUnresolvableError('dangling target');
    expect(e.code).toBe('source-unresolvable');
    if (e.code === 'source-unresolvable') {
      expect(e.message).toBe('dangling target');
    }
  });
  test('ledgerError carries message and optional file', () => {
    const e = ledgerError('corrupt', '/data/placements.json');
    expect(e.code).toBe('ledger-error');
    if (e.code === 'ledger-error') {
      expect(e.message).toBe('corrupt');
      expect(e.file).toBe('/data/placements.json');
    }
  });
  test('ledgerError omits file when not given', () => {
    const e = ledgerError('corrupt');
    expect(e.code).toBe('ledger-error');
    if (e.code === 'ledger-error') {
      expect(e.file).toBeUndefined();
    }
  });
  test('permissionDeniedError carries message and optional path', () => {
    const e = permissionDeniedError('denied', '/h/.claude/skills/alpha');
    expect(e.code).toBe('permission-denied');
    if (e.code === 'permission-denied') {
      expect(e.message).toBe('denied');
      expect(e.path).toBe('/h/.claude/skills/alpha');
    }
  });
  test('flipRefusedError carries message', () => {
    const e = flipRefusedError('dirty tree');
    expect(e.code).toBe('flip-refused');
    if (e.code === 'flip-refused') {
      expect(e.message).toBe('dirty tree');
    }
  });
  test('flipFailedError carries message', () => {
    const e = flipFailedError('rename failed');
    expect(e.code).toBe('flip-failed');
    if (e.code === 'flip-failed') {
      expect(e.message).toBe('rename failed');
    }
  });
});
