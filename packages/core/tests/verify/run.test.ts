import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultScanEnv } from '../../src/env/default.ts';
import { ok } from '../../src/result.ts';
import { resolveTarget, runVerify, verifyPlugin } from '../../src/verify/run.ts';
import type { ToolVerifier, VerifyOutcome, VerifyTool } from '../../src/verify/types.ts';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'verify');

const pathExists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

const okChecker =
  (tool: VerifyTool, verdict: VerifyOutcome): ToolVerifier =>
  async (_env, opts) =>
    ok({
      tool,
      available: true,
      toolVersion: '9.9.9',
      versionDrift: true,
      skipReason: null,
      verdict,
      modes: opts.modes.map((mode) => ({
        mode,
        status: 'ran' as const,
        skipReason: null,
        coverage: { manifest: true, skills: true },
        verdict,
        command: `${tool} fake`,
        findings: [],
      })),
    });

const absentChecker =
  (tool: VerifyTool): ToolVerifier =>
  async () =>
    ok({
      tool,
      available: false,
      toolVersion: null,
      versionDrift: false,
      skipReason: 'not-installed' as const,
      verdict: 'inconclusive' as const,
      modes: [],
    });

describe('resolveTarget', () => {
  test('plugin dir resolves as-is with a no-op cleanup', async () => {
    const env = await defaultScanEnv();
    const path = join(FIXTURES, 'dummytest');
    const r = await resolveTarget(env, path);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('plugin');
    expect(r.value.path).toBe(path);
    await r.value.cleanup();
    expect(await pathExists(join(path, '.claude-plugin', 'plugin.json'))).toBe(true);
  });

  test('bare skill dir gets wrapped into an ephemeral plugin', async () => {
    const env = await defaultScanEnv();
    const path = join(FIXTURES, 'bare-skill');
    const r = await resolveTarget(env, path);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('skill');
    expect(r.value.path).not.toBe(path);

    const claude = JSON.parse(
      await readFile(join(r.value.path, '.claude-plugin', 'plugin.json'), 'utf8'),
    );
    expect(claude.name).toBe('bare-skill');
    expect(await pathExists(join(r.value.path, '.codex-plugin', 'plugin.json'))).toBe(true);

    const wrapped = await readFile(join(r.value.path, 'skills', 'bare-skill', 'SKILL.md'), 'utf8');
    const original = await readFile(join(path, 'SKILL.md'), 'utf8');
    expect(wrapped).toBe(original);

    const wrapperPath = r.value.path;
    await r.value.cleanup();
    expect(await pathExists(wrapperPath)).toBe(false);
  });

  test('errs on an empty directory that is neither a plugin nor a bare skill', async () => {
    const env = await defaultScanEnv();
    const empty = await mkdtemp(join(tmpdir(), 'skillsmith-verify-test-empty-'));
    try {
      const r = await resolveTarget(env, empty);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('invalid-argument');
      if (!r.ok && r.error.code === 'invalid-argument') {
        expect(r.error.message).toContain('is not a plugin or skill directory');
      }
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  test('errs on a nonexistent path', async () => {
    const env = await defaultScanEnv();
    const r = await resolveTarget(env, join(FIXTURES, 'does-not-exist-xyz'));
    expect(r.ok).toBe(false);
  });
});

describe('runVerify', () => {
  test('dummytest with two passing fake checkers, default opts', async () => {
    const env = await defaultScanEnv();
    const r = await runVerify(
      env,
      { path: join(FIXTURES, 'dummytest') },
      { 'claude-code': okChecker('claude-code', 'pass'), codex: okChecker('codex', 'pass') },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.schemaVersion).toBe(1);
    expect(r.value.target.kind).toBe('plugin');
    expect(r.value.requested).toEqual({
      tools: ['claude-code', 'codex'],
      modes: ['static'],
      strict: false,
      explicitTools: false,
    });
    expect(r.value.verifiedAgainst).toEqual({ 'claude-code': '2.1.202', codex: '0.142.5' });
    expect(r.value.summary.verdict).toBe('pass');
    expect(r.value.tools.length).toBe(2);
  });

  test('deep mode requests both static and deep for every tool', async () => {
    const env = await defaultScanEnv();
    const r = await runVerify(
      env,
      { path: join(FIXTURES, 'dummytest'), deep: true },
      { 'claude-code': okChecker('claude-code', 'pass'), codex: okChecker('codex', 'pass') },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.requested.modes).toEqual(['static', 'deep']);
    for (const t of r.value.tools) {
      expect(t.modes.map((m) => m.mode)).toEqual(['static', 'deep']);
    }
  });

  test('explicit tools filters to just that tool', async () => {
    const env = await defaultScanEnv();
    const r = await runVerify(
      env,
      { path: join(FIXTURES, 'dummytest'), tools: ['codex'] },
      { 'claude-code': okChecker('claude-code', 'pass'), codex: okChecker('codex', 'pass') },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.requested.explicitTools).toBe(true);
    expect(r.value.tools.length).toBe(1);
  });

  test('one failing checker + one absent tool rolls up correctly', async () => {
    const env = await defaultScanEnv();
    const r = await runVerify(
      env,
      { path: join(FIXTURES, 'dummytest') },
      { 'claude-code': okChecker('claude-code', 'fail'), codex: absentChecker('codex') },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.summary).toEqual({
      verdict: 'fail',
      verified: [],
      failed: ['claude-code'],
      skipped: ['codex'],
      counts: { error: 0, warning: 0, info: 0 },
    });
  });

  test('bare-skill target: cleanup runs, target.kind is skill, target.path is the original input', async () => {
    const env = await defaultScanEnv();
    const path = join(FIXTURES, 'bare-skill');
    let wrapperPath: string | undefined;
    const spyChecker =
      (tool: VerifyTool): ToolVerifier =>
      async (_env, opts) => {
        wrapperPath = opts.path;
        return ok({
          tool,
          available: true,
          toolVersion: '9.9.9',
          versionDrift: false,
          skipReason: null,
          verdict: 'pass' as const,
          modes: opts.modes.map((mode) => ({
            mode,
            status: 'ran' as const,
            skipReason: null,
            coverage: { manifest: true, skills: true },
            verdict: 'pass' as const,
            command: `${tool} fake`,
            findings: [],
          })),
        });
      };
    const r = await runVerify(
      env,
      { path, tools: ['claude-code'] },
      { 'claude-code': spyChecker('claude-code'), codex: spyChecker('codex') },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.target.kind).toBe('skill');
    expect(r.value.target.path).toBe(path);
    expect(wrapperPath).toBeDefined();
    expect(wrapperPath).not.toBe(path);
    if (wrapperPath) expect(await pathExists(wrapperPath)).toBe(false);
  });

  test('pre-aborted signal errs with a message containing "aborted"', async () => {
    const env = await defaultScanEnv();
    const controller = new AbortController();
    controller.abort();
    const r = await runVerify(
      env,
      { path: join(FIXTURES, 'dummytest'), signal: controller.signal },
      { 'claude-code': okChecker('claude-code', 'pass'), codex: okChecker('codex', 'pass') },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('generic');
    if (!r.ok && r.error.code === 'generic') expect(r.error.message).toContain('aborted');
  });
});

describe('verifyPlugin', () => {
  test('with neither tool on PATH, both are not-installed and summary is inconclusive', async () => {
    const base = await defaultScanEnv();
    // `path: []` alone isn't enough — wellKnownBinDirs always probes fixed OS/home
    // locations too, so also hide the two tool binaries there regardless of what's
    // actually installed on the machine running this test.
    const env = {
      ...base,
      path: [] as string[],
      fileExists: async (p: string) =>
        p.endsWith('/claude') || p.endsWith('/codex') ? false : base.fileExists(p),
    };
    const r = await verifyPlugin(env, { path: join(FIXTURES, 'dummytest') });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.tools).toHaveLength(2);
    for (const t of r.value.tools) {
      expect(t.available).toBe(false);
      expect(t.skipReason).toBe('not-installed');
    }
    expect(r.value.summary.verdict).toBe('inconclusive');
    expect(r.value.summary.skipped).toEqual(['claude-code', 'codex']);
  });
});
