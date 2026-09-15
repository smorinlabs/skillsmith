import { describe, expect, test } from 'bun:test';
import type { ModeResult, ToolVerdict, VerifyReport } from '@skillsmith/core';
import { renderVerifyHuman } from '../../src/output/verify-human.ts';

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
  target: { path: '/Users/alice/dev/my-plugin', kind: 'plugin' },
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

describe('renderVerifyHuman', () => {
  test('partial verification renders diagnostics and never says no tools ran', () => {
    const r = report();
    r.summary = { ...r.summary, verdict: 'inconclusive', verified: [], skipped: ['codex'] };
    r.tools = [
      tool({
        tool: 'codex',
        verdict: 'inconclusive',
        modes: [
          mode(),
          mode({
            mode: 'deep',
            status: 'error',
            verdict: null,
            skipReason: 'exec-error',
            findings: [
              {
                checkId: 'codex.deep-probe',
                normalizedSeverity: 'info',
                toolSeverity: null,
                message: 'phase=local-loader; exit=1',
                file: null,
                subject: 'plugin',
              },
            ],
          }),
        ],
      }),
    ];
    const out = renderVerifyHuman(r, 4);
    expect(out).toContain('verification incomplete');
    expect(out).toContain('phase=local-loader; exit=1');
    expect(out).not.toContain('no tools ran');
  });

  test('header: static-only mode joins tools with ", "', () => {
    const out = renderVerifyHuman(report(), 0);
    expect(out).toContain(
      'Verifying /Users/alice/dev/my-plugin  (mode: static · tools: claude-code, codex)',
    );
  });

  test('header: deep mode joins modes with ", "', () => {
    const out = renderVerifyHuman(
      report({
        requested: {
          tools: ['claude-code'],
          modes: ['static', 'deep'],
          strict: false,
          explicitTools: false,
        },
      }),
      0,
    );
    expect(out).toContain('mode: static, deep · tools: claude-code');
  });

  test('per-tool line contains "<tool> <toolVersion>" and "verdict: <verdict>"', () => {
    const out = renderVerifyHuman(
      report({ tools: [tool({ tool: 'claude-code', toolVersion: '2.1.202', verdict: 'fail' })] }),
      1,
    );
    expect(out).toContain('claude-code 2.1.202');
    expect(out).toContain('verdict: fail');
  });

  test('per-mode line uses ✓ for covered and — for not covered', () => {
    const out = renderVerifyHuman(
      report({
        tools: [
          tool({
            modes: [mode({ coverage: { manifest: true, skills: false } })],
          }),
        ],
      }),
      0,
    );
    expect(out).toContain('manifest ✓');
    expect(out).toContain('skills —');
  });

  test('claude-code deep mode renders "skills ✓ (presence)"', () => {
    const out = renderVerifyHuman(
      report({
        tools: [
          tool({
            tool: 'claude-code',
            modes: [mode({ mode: 'deep', coverage: { manifest: false, skills: true } })],
          }),
        ],
      }),
      0,
    );
    expect(out).toContain('skills ✓ (presence)');
  });

  test('a ran mode with zero findings renders "(no findings)"', () => {
    const out = renderVerifyHuman(report(), 0);
    expect(out).toContain('(no findings)');
  });

  test('finding renders marker, checkId, file, and indented message', () => {
    const out = renderVerifyHuman(
      report({
        tools: [
          tool({
            modes: [
              mode({
                findings: [
                  {
                    checkId: 'claude.frontmatter',
                    toolSeverity: 'error',
                    normalizedSeverity: 'error',
                    message:
                      'YAML frontmatter failed to parse: YAML Parse error: Unexpected character.',
                    file: 'skills/bad-yaml/SKILL.md',
                    subject: 'skill',
                  },
                  {
                    checkId: 'claude.description',
                    toolSeverity: 'warning',
                    normalizedSeverity: 'warning',
                    message: 'No description in frontmatter.',
                    file: 'skills/bad-nodesc/SKILL.md',
                    subject: 'skill',
                  },
                  {
                    checkId: 'codex.static-coverage',
                    toolSeverity: null,
                    normalizedSeverity: 'info',
                    message:
                      'codex static checked the manifest only; run --deep for skill validation',
                    file: null,
                    subject: 'plugin',
                  },
                ],
              }),
            ],
          }),
        ],
      }),
      1,
    );
    expect(out).toContain('✘ claude.frontmatter');
    expect(out).toContain('skills/bad-yaml/SKILL.md');
    expect(out).toContain(
      'YAML frontmatter failed to parse: YAML Parse error: Unexpected character.',
    );
    expect(out).toContain('⚠ claude.description');
    expect(out).toContain('ℹ codex.static-coverage');
    expect(out).not.toContain('ℹ codex.static-coverage   ');
  });

  test('not-installed tool renders "<tool>  not installed (skipped)"', () => {
    const out = renderVerifyHuman(
      report({
        tools: [
          tool({ tool: 'claude-code' }),
          tool({
            tool: 'codex',
            available: false,
            toolVersion: null,
            skipReason: 'not-installed',
            verdict: 'inconclusive',
            modes: [],
          }),
        ],
      }),
      0,
    );
    expect(out).toContain('codex  not installed (skipped)');
  });

  test('summary line with failures present: pluralized counts, exit code', () => {
    const out = renderVerifyHuman(
      report({
        summary: {
          verdict: 'fail',
          verified: ['codex'],
          failed: ['claude-code'],
          skipped: [],
          counts: { error: 1, warning: 1, info: 1 },
        },
      }),
      1,
    );
    expect(out).toContain('1 tool failed, 1 passed.  (1 error, 1 warning, 1 notice)  Exit code: 1');
  });

  test('summary line with multiple failures pluralizes "tools"', () => {
    const out = renderVerifyHuman(
      report({
        summary: {
          verdict: 'fail',
          verified: [],
          failed: ['claude-code', 'codex'],
          skipped: [],
          counts: { error: 2, warning: 0, info: 0 },
        },
      }),
      1,
    );
    expect(out).toContain(
      '2 tools failed, 0 passed.  (2 errors, 0 warnings, 0 notices)  Exit code: 1',
    );
  });

  test('summary line with no failures: verified list joined, exit code', () => {
    const out = renderVerifyHuman(
      report({
        summary: {
          verdict: 'pass',
          verified: ['claude-code'],
          failed: [],
          skipped: [],
          counts: { error: 0, warning: 0, info: 0 },
        },
      }),
      0,
    );
    expect(out).toContain('verified: claude-code.  Exit code: 0');
  });

  test('summary line with every tool skipped (none installed): explicit could-not-verify line', () => {
    const out = renderVerifyHuman(
      report({
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
        summary: {
          verdict: 'inconclusive',
          verified: [],
          failed: [],
          skipped: ['claude-code', 'codex'],
          counts: { error: 0, warning: 0, info: 0 },
        },
      }),
      3,
    );
    expect(out).not.toContain('verified: .');
    expect(out).toContain(
      'verified: none — no tools ran (claude-code: not installed, codex: not installed)  Exit code: 3',
    );
  });
});
