import { describe, expect, test } from 'bun:test';
import {
  parseClaudeValidateOutput,
  verifyClaudeCode,
} from '../../../src/agents/claude-code/verify.ts';
import type { ScanEnv } from '../../../src/env/types.ts';

const env = (): ScanEnv => ({
  homeDir: '/h',
  path: [],
  platform: 'linux',
  xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
  fileExists: async () => false,
  realpath: async (p) => p,
  listDir: async () => [],
  readText: async () => '',
  runVersion: async () => 'unknown',
  exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
});

const MIXED_SKILL_BLOCK = [
  'Validating skill: /work/dummytest/skills/bad-yaml/SKILL.md',
  '✘ frontmatter: YAML frontmatter failed to parse: YAML Parse error: Unexpected character.',
  '  At runtime this skill loads with empty metadata (all frontmatter fields silently dropped).',
  'Validating skill: /work/dummytest/skills/bad-noframe/SKILL.md',
  '⚠ frontmatter: No frontmatter block found. Add YAML frontmatter between --- delimiters ...',
  'Validating skill: /work/dummytest/skills/bad-nodesc/SKILL.md',
  '⚠ description: No description in frontmatter. ...',
  '✘ Validation failed',
].join('\n');

const BROKEN_MANIFEST_LINES = [
  "✘ json: Invalid JSON syntax: JSON Parse error: Expected '}'",
  '✘ name: Invalid input: expected string, received undefined',
].join('\n');

describe('parseClaudeValidateOutput', () => {
  test('mixed-skill block yields exactly 3 findings, summary line produces none', () => {
    const findings = parseClaudeValidateOutput(MIXED_SKILL_BLOCK, '/work/dummytest');
    expect(findings).toHaveLength(3);

    expect(findings[0]).toEqual({
      checkId: 'claude.frontmatter',
      toolSeverity: 'error',
      normalizedSeverity: 'error',
      message: 'YAML frontmatter failed to parse: YAML Parse error: Unexpected character.',
      file: 'skills/bad-yaml/SKILL.md',
      subject: 'skill',
      raw: '✘ frontmatter: YAML frontmatter failed to parse: YAML Parse error: Unexpected character.',
    });

    expect(findings[1]).toEqual({
      checkId: 'claude.frontmatter',
      toolSeverity: 'warning',
      normalizedSeverity: 'warning',
      message: 'No frontmatter block found. Add YAML frontmatter between --- delimiters ...',
      file: 'skills/bad-noframe/SKILL.md',
      subject: 'skill',
      raw: '⚠ frontmatter: No frontmatter block found. Add YAML frontmatter between --- delimiters ...',
    });

    expect(findings[2]).toEqual({
      checkId: 'claude.description',
      toolSeverity: 'warning',
      normalizedSeverity: 'warning',
      message: 'No description in frontmatter. ...',
      file: 'skills/bad-nodesc/SKILL.md',
      subject: 'skill',
      raw: '⚠ description: No description in frontmatter. ...',
    });

    // The bare "✘ Validation failed" summary line must not produce a 4th finding.
    expect(findings.every((f) => f.checkId !== 'claude.Validation')).toBe(true);
  });

  test('manifest check tokens (json, name) resolve to subject manifest', () => {
    const findings = parseClaudeValidateOutput(BROKEN_MANIFEST_LINES, '/work/claude-badjson');
    expect(findings).toHaveLength(2);

    expect(findings[0]).toEqual({
      checkId: 'claude.json',
      toolSeverity: 'error',
      normalizedSeverity: 'error',
      message: "Invalid JSON syntax: JSON Parse error: Expected '}'",
      file: '.claude-plugin/plugin.json',
      subject: 'manifest',
      raw: "✘ json: Invalid JSON syntax: JSON Parse error: Expected '}'",
    });

    expect(findings[1]).toEqual({
      checkId: 'claude.name',
      toolSeverity: 'error',
      normalizedSeverity: 'error',
      message: 'Invalid input: expected string, received undefined',
      file: '.claude-plugin/plugin.json',
      subject: 'manifest',
      raw: '✘ name: Invalid input: expected string, received undefined',
    });
  });

  test('no findings before any "Validating skill:" line means file: null', () => {
    const findings = parseClaudeValidateOutput('✘ frontmatter: oops', '/work/dummytest');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBeNull();
    expect(findings[0]?.subject).toBe('skill');
  });
});

describe('verifyClaudeCode', () => {
  const fakeInstalled = (overrides: Partial<ScanEnv> = {}): ScanEnv => ({
    ...env(),
    path: ['/fake'],
    fileExists: async (p) => p === '/fake/claude',
    realpath: async (p) => p,
    runVersion: async () => '2.1.201 (Claude Code)',
    ...overrides,
  });

  test('mixed-skill block (exit 1) -> ran, verdict fail, coverage true/true', async () => {
    const scanEnv = fakeInstalled({
      exec: async () => ({ code: 1, stdout: MIXED_SKILL_BLOCK, stderr: '', timedOut: false }),
    });
    const r = await verifyClaudeCode(scanEnv, {
      path: '/work/dummytest',
      modes: ['static'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.available).toBe(true);
    expect(r.value.toolVersion).toBe('2.1.201');
    expect(r.value.versionDrift).toBe(false);
    expect(r.value.modes).toHaveLength(1);
    const mode = r.value.modes[0];
    expect(mode?.status).toBe('ran');
    expect(mode?.verdict).toBe('fail');
    expect(mode?.coverage).toEqual({ manifest: true, skills: true });
    expect(mode?.findings).toHaveLength(3);
  });

  test('warnings only + strict:true -> mode verdict fail; strict adds --strict to exec args', async () => {
    const warningsOnly = [
      'Validating skill: /work/dummytest/skills/bad-noframe/SKILL.md',
      '⚠ frontmatter: No frontmatter block found. Add YAML frontmatter between --- delimiters ...',
    ].join('\n');
    let capturedArgs: readonly string[] | undefined;
    const scanEnv = fakeInstalled({
      exec: async (_cmd, args) => {
        capturedArgs = args;
        return { code: 0, stdout: warningsOnly, stderr: '', timedOut: false };
      },
    });
    const r = await verifyClaudeCode(scanEnv, {
      path: '/work/dummytest',
      modes: ['static'],
      strict: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.modes[0]?.verdict).toBe('fail');
    expect(capturedArgs).toContain('--strict');
  });

  test('exit 0, empty output -> ran, verdict pass, findings []', async () => {
    const scanEnv = fakeInstalled({
      exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
    });
    const r = await verifyClaudeCode(scanEnv, {
      path: '/work/dummytest',
      modes: ['static'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.modes[0]?.status).toBe('ran');
    expect(r.value.modes[0]?.verdict).toBe('pass');
    expect(r.value.modes[0]?.findings).toEqual([]);
  });

  test('timedOut:true -> status error, skipReason timeout, verdict null', async () => {
    const scanEnv = fakeInstalled({
      exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: true }),
    });
    const r = await verifyClaudeCode(scanEnv, {
      path: '/work/dummytest',
      modes: ['static'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.modes[0]?.status).toBe('error');
    expect(r.value.modes[0]?.skipReason).toBe('timeout');
    expect(r.value.modes[0]?.verdict).toBeNull();
  });

  test('exit 2 with garbage output -> status error, skipReason exec-error', async () => {
    const scanEnv = fakeInstalled({
      exec: async () => ({ code: 2, stdout: 'segfault', stderr: '', timedOut: false }),
    });
    const r = await verifyClaudeCode(scanEnv, {
      path: '/work/dummytest',
      modes: ['static'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.modes[0]?.status).toBe('error');
    expect(r.value.modes[0]?.skipReason).toBe('exec-error');
  });

  test('detect finds nothing (empty path) -> available false, not-installed, modes []', async () => {
    const scanEnv = env(); // path: [], fileExists always false
    const r = await verifyClaudeCode(scanEnv, {
      path: '/work/dummytest',
      modes: ['static'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      tool: 'claude-code',
      available: false,
      toolVersion: null,
      versionDrift: false,
      skipReason: 'not-installed',
      verdict: 'inconclusive',
      modes: [],
    });
  });

  test('version drift: 2.3.0 differs from verified 2.1.201 -> versionDrift true + info finding appended', async () => {
    const scanEnv = fakeInstalled({
      runVersion: async () => '2.3.0 (Claude Code)',
      exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
    });
    const r = await verifyClaudeCode(scanEnv, {
      path: '/work/dummytest',
      modes: ['static'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.toolVersion).toBe('2.3.0');
    expect(r.value.versionDrift).toBe(true);
    const findings = r.value.modes[0]?.findings ?? [];
    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual({
      checkId: 'claude.version-drift',
      toolSeverity: null,
      normalizedSeverity: 'info',
      message: 'claude 2.3.0 differs from verified 2.1.201; parsing may be less reliable',
      file: null,
      subject: 'plugin',
    });
  });

  test('exit 1 with bare ✘ marker only (no per-check findings) -> status error, skipReason exec-error', async () => {
    const bareMarkerOnly = '✘ Validation failed';
    const scanEnv = fakeInstalled({
      exec: async () => ({ code: 1, stdout: bareMarkerOnly, stderr: '', timedOut: false }),
    });
    const r = await verifyClaudeCode(scanEnv, {
      path: '/work/dummytest',
      modes: ['static'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.modes[0]?.status).toBe('error');
    expect(r.value.modes[0]?.skipReason).toBe('exec-error');
    expect(r.value.modes[0]?.verdict).toBeNull();
  });

  test("'deep' requested alone produces no ModeResult yet", async () => {
    const scanEnv = fakeInstalled({
      exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
    });
    const r = await verifyClaudeCode(scanEnv, {
      path: '/work/dummytest',
      modes: ['deep'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.modes).toEqual([]);
  });
});
