import { describe, expect, test } from 'bun:test';
import {
  extractVersionToken,
  modeVerdictFor,
  summarize,
  toolVerdictFor,
  worstOutcome,
} from '../../src/verify/normalize.ts';
import type {
  ModeResult,
  NormalizedSeverity,
  ToolVerdict,
  VerifyFinding,
} from '../../src/verify/types.ts';

const finding = (normalizedSeverity: NormalizedSeverity): VerifyFinding => ({
  checkId: 'claude.frontmatter',
  toolSeverity: null,
  normalizedSeverity,
  message: 'msg',
  file: null,
  subject: 'skill',
});

const mode = (opts: Partial<ModeResult> & { mode: ModeResult['mode'] }): ModeResult => ({
  status: 'ran',
  skipReason: null,
  coverage: { manifest: true, skills: true },
  verdict: 'pass',
  command: 'fake',
  findings: [],
  ...opts,
});

const toolVerdict = (opts: Partial<ToolVerdict> & { tool: ToolVerdict['tool'] }): ToolVerdict => ({
  available: true,
  toolVersion: '9.9.9',
  versionDrift: false,
  skipReason: null,
  verdict: 'pass',
  modes: [],
  ...opts,
});

describe('worstOutcome', () => {
  test('fail beats warn and pass', () => {
    expect(worstOutcome(['pass', 'warn', 'fail'])).toBe('fail');
  });
  test('warn beats pass', () => {
    expect(worstOutcome(['pass', 'warn'])).toBe('warn');
  });
  test('pass alone is pass', () => {
    expect(worstOutcome(['pass'])).toBe('pass');
  });
});

describe('modeVerdictFor', () => {
  test('any error finding -> fail', () => {
    expect(modeVerdictFor([finding('error'), finding('info')], false)).toBe('fail');
  });
  test('warnings only -> warn (non-strict)', () => {
    expect(modeVerdictFor([finding('warning')], false)).toBe('warn');
  });
  test('warnings only + strict -> fail', () => {
    expect(modeVerdictFor([finding('warning')], true)).toBe('fail');
  });
  test('info only -> pass', () => {
    expect(modeVerdictFor([finding('info')], false)).toBe('pass');
  });
  test('empty -> pass', () => {
    expect(modeVerdictFor([], false)).toBe('pass');
  });
});

describe('toolVerdictFor', () => {
  test('worst of ran mode verdicts', () => {
    const modes: ModeResult[] = [
      mode({ mode: 'static', verdict: 'warn' }),
      mode({ mode: 'deep', verdict: 'fail' }),
    ];
    expect(toolVerdictFor(modes)).toBe('fail');
  });

  test('all modes skipped/error -> inconclusive', () => {
    const modes: ModeResult[] = [
      mode({ mode: 'static', status: 'skipped', skipReason: 'not-installed', verdict: null }),
      mode({ mode: 'deep', status: 'error', skipReason: 'exec-error', verdict: null }),
    ];
    expect(toolVerdictFor(modes)).toBe('inconclusive');
  });
});

describe('summarize', () => {
  test('partitions verified/failed/skipped and totals counts', () => {
    const passTool = toolVerdict({
      tool: 'claude-code',
      verdict: 'pass',
      modes: [mode({ mode: 'static', verdict: 'pass', findings: [finding('info')] })],
    });
    const failTool = toolVerdict({
      tool: 'codex',
      verdict: 'fail',
      modes: [
        mode({
          mode: 'static',
          verdict: 'fail',
          findings: [finding('error'), finding('warning')],
        }),
      ],
    });
    const summary = summarize([passTool, failTool]);
    expect(summary.verified).toEqual(['claude-code']);
    expect(summary.failed).toEqual(['codex']);
    expect(summary.skipped).toEqual([]);
    expect(summary.counts).toEqual({ error: 1, warning: 1, info: 1 });
    expect(summary.verdict).toBe('fail');
  });

  test('warn tool is verified, not failed', () => {
    const warnTool = toolVerdict({
      tool: 'claude-code',
      verdict: 'warn',
      modes: [mode({ mode: 'static', verdict: 'warn', findings: [finding('warning')] })],
    });
    const summary = summarize([warnTool]);
    expect(summary.verified).toEqual(['claude-code']);
    expect(summary.failed).toEqual([]);
    expect(summary.verdict).toBe('warn');
  });

  test('inconclusive tool is skipped, not counted toward verdict', () => {
    const absent = toolVerdict({
      tool: 'codex',
      available: false,
      toolVersion: null,
      skipReason: 'not-installed',
      verdict: 'inconclusive',
      modes: [],
    });
    const summary = summarize([absent]);
    expect(summary.verified).toEqual([]);
    expect(summary.failed).toEqual([]);
    expect(summary.skipped).toEqual(['codex']);
    expect(summary.verdict).toBe('inconclusive');
  });

  test('verdict is worst across tools that produced a verdict', () => {
    const passTool = toolVerdict({ tool: 'claude-code', verdict: 'pass', modes: [] });
    const warnTool = toolVerdict({ tool: 'codex', verdict: 'warn', modes: [] });
    const summary = summarize([passTool, warnTool]);
    expect(summary.verdict).toBe('warn');
  });
});

describe('extractVersionToken', () => {
  test('extracts from a parenthesized suffix', () => {
    expect(extractVersionToken('2.1.202 (Claude Code)')).toBe('2.1.202');
  });
  test('extracts from a prefixed string', () => {
    expect(extractVersionToken('codex-cli 0.142.5')).toBe('0.142.5');
  });
  test('returns null when no version token present', () => {
    expect(extractVersionToken('unknown')).toBeNull();
  });
});
