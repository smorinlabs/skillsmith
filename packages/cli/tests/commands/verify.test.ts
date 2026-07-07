import { describe, expect, test } from 'bun:test';
import type { ModeResult, ToolVerdict, VerifyReport } from '@skillsmith/core';
import { verifyExitCode } from '../../src/commands/verify.ts';

const mode = (overrides: Partial<ModeResult> = {}): ModeResult => ({
  mode: 'static',
  status: 'ran',
  skipReason: null,
  coverage: { manifest: true, skills: true },
  verdict: 'pass',
  command: 'fake',
  findings: [],
  ...overrides,
});

const tool = (overrides: Partial<ToolVerdict> = {}): ToolVerdict => ({
  tool: 'claude-code',
  available: true,
  toolVersion: '2.1.202',
  versionDrift: false,
  skipReason: null,
  verdict: 'pass',
  modes: [mode()],
  ...overrides,
});

const report = (overrides: Partial<VerifyReport> = {}): VerifyReport => ({
  schemaVersion: 1,
  target: { path: '/tmp/x', kind: 'plugin' },
  requested: {
    tools: ['claude-code', 'codex'],
    modes: ['static'],
    strict: false,
    explicitTools: false,
  },
  verifiedAgainst: { 'claude-code': '2.1.202', codex: '0.142.5' },
  summary: {
    verdict: 'pass',
    verified: ['claude-code', 'codex'],
    failed: [],
    skipped: [],
    counts: { error: 0, warning: 0, info: 0 },
  },
  tools: [tool({ tool: 'claude-code' }), tool({ tool: 'codex' })],
  ...overrides,
});

describe('verifyExitCode', () => {
  test('all ran modes pass -> 0', () => {
    expect(verifyExitCode(report())).toBe(0);
  });

  test('warn without strict (summary warn) -> 0', () => {
    const r = report({
      summary: {
        verdict: 'warn',
        verified: ['claude-code', 'codex'],
        failed: [],
        skipped: [],
        counts: { error: 0, warning: 1, info: 0 },
      },
    });
    expect(verifyExitCode(r)).toBe(0);
  });

  test('any tool fail (even with another tool skipped) -> 1 (1 outranks 4)', () => {
    const r = report({
      summary: {
        verdict: 'fail',
        verified: [],
        failed: ['claude-code'],
        skipped: ['codex'],
        counts: { error: 1, warning: 0, info: 0 },
      },
      tools: [
        tool({ tool: 'claude-code', verdict: 'fail', modes: [mode({ verdict: 'fail' })] }),
        tool({
          tool: 'codex',
          available: false,
          toolVersion: null,
          skipReason: 'not-installed',
          verdict: 'inconclusive',
          modes: [],
        }),
      ],
    });
    expect(verifyExitCode(r)).toBe(1);
  });

  test('nothing ran at all (all tools unavailable) -> 4', () => {
    const r = report({
      summary: {
        verdict: 'inconclusive',
        verified: [],
        failed: [],
        skipped: ['claude-code', 'codex'],
        counts: { error: 0, warning: 0, info: 0 },
      },
      tools: [
        tool({
          tool: 'claude-code',
          available: false,
          toolVersion: null,
          skipReason: 'not-installed',
          verdict: 'inconclusive',
          modes: [],
        }),
        tool({
          tool: 'codex',
          available: false,
          toolVersion: null,
          skipReason: 'not-installed',
          verdict: 'inconclusive',
          modes: [],
        }),
      ],
    });
    expect(verifyExitCode(r)).toBe(4);
  });

  test('explicitTools: true + any available: false tool -> 4', () => {
    const r = report({
      requested: { tools: ['codex'], modes: ['static'], strict: false, explicitTools: true },
      summary: {
        verdict: 'inconclusive',
        verified: [],
        failed: [],
        skipped: ['codex'],
        counts: { error: 0, warning: 0, info: 0 },
      },
      tools: [
        tool({
          tool: 'codex',
          available: false,
          toolVersion: null,
          skipReason: 'not-installed',
          verdict: 'inconclusive',
          modes: [],
        }),
      ],
    });
    expect(verifyExitCode(r)).toBe(4);
  });

  test('deep requested + an available tool whose deep mode errored (timeout) -> 4', () => {
    const r = report({
      requested: {
        tools: ['claude-code'],
        modes: ['static', 'deep'],
        strict: false,
        explicitTools: false,
      },
      tools: [
        tool({
          tool: 'claude-code',
          modes: [
            mode({ mode: 'static', status: 'ran', verdict: 'pass' }),
            mode({ mode: 'deep', status: 'error', skipReason: 'timeout', verdict: null }),
          ],
        }),
      ],
    });
    expect(verifyExitCode(r)).toBe(4);
  });

  test('same with skipReason: exec-error -> 4', () => {
    const r = report({
      requested: {
        tools: ['claude-code'],
        modes: ['static', 'deep'],
        strict: false,
        explicitTools: false,
      },
      tools: [
        tool({
          tool: 'claude-code',
          modes: [
            mode({ mode: 'static', status: 'ran', verdict: 'pass' }),
            mode({ mode: 'deep', status: 'error', skipReason: 'exec-error', verdict: null }),
          ],
        }),
      ],
    });
    expect(verifyExitCode(r)).toBe(4);
  });

  test('auto (non-explicit) tools, one absent, other passed -> 0 (silent skip)', () => {
    const r = report({
      requested: {
        tools: ['claude-code', 'codex'],
        modes: ['static'],
        strict: false,
        explicitTools: false,
      },
      summary: {
        verdict: 'pass',
        verified: ['claude-code'],
        failed: [],
        skipped: ['codex'],
        counts: { error: 0, warning: 0, info: 0 },
      },
      tools: [
        tool({ tool: 'claude-code', verdict: 'pass' }),
        tool({
          tool: 'codex',
          available: false,
          toolVersion: null,
          skipReason: 'not-installed',
          verdict: 'inconclusive',
          modes: [],
        }),
      ],
    });
    expect(verifyExitCode(r)).toBe(0);
  });

  test("deep requested and every available tool's deep ran -> 0", () => {
    const r = report({
      requested: {
        tools: ['claude-code', 'codex'],
        modes: ['static', 'deep'],
        strict: false,
        explicitTools: false,
      },
      tools: [
        tool({ tool: 'claude-code', modes: [mode({ mode: 'static' }), mode({ mode: 'deep' })] }),
        tool({ tool: 'codex', modes: [mode({ mode: 'static' }), mode({ mode: 'deep' })] }),
      ],
    });
    expect(verifyExitCode(r)).toBe(0);
  });
});
