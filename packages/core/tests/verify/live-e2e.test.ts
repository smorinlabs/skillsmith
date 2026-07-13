import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { verifyClaudeCode } from '../../src/agents/claude-code/verify.ts';
import { verifyCodex } from '../../src/agents/codex/verify.ts';
import { defaultRuntimePorts as defaultScanEnv } from '../../src/ports/default.ts';
import { verifyPlugin } from '../../src/verify/run.ts';
import type { ModeResult } from '../../src/verify/types.ts';

// Env-gated live e2e against the real `claude` / `codex` CLIs. CI never sets
// SKILLSMITH_E2E and its runners don't have the tool CLIs installed, so this whole
// suite reports as skipped and `bun run check` stays green. On a workstation with the
// CLIs installed, run: `SKILLSMITH_E2E=1 bun test packages/core/tests/verify/live-e2e.test.ts`
//
// This suite is also the drift canary: when a new tool version changes an error
// string, these tests fail while the canned unit tests (verify-static/verify-deep)
// stay green — that's the signal to update VERIFIED_AGAINST (verify/types.ts) and the
// research doc together.
const E2E = process.env.SKILLSMITH_E2E === '1';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'verify');
const DUMMYTEST = join(FIXTURES, 'dummytest');
const CLAUDE_BADJSON = join(FIXTURES, 'claude-badjson');
const CLAUDE_NONAME = join(FIXTURES, 'claude-noname');
const CODEX_BADPLUG = join(FIXTURES, 'codex-badplug');
const BARE_SKILL = join(FIXTURES, 'bare-skill');

/**
 * Fails loudly with the full mode payload (status/skipReason/command/findings) rather
 * than a bare assertion mismatch — on a broken live environment this is the difference
 * between "expected 'ran', got 'error'" and knowing *why* (e.g. skipReason: 'exec-error'
 * plus the raw stderr excerpt embedded in a synthesized finding upstream).
 */
const requireRan = (mode: ModeResult | undefined, label: string): ModeResult => {
  if (!mode || mode.status !== 'ran') {
    throw new Error(`${label}: expected mode status 'ran'\n${JSON.stringify(mode, null, 2)}`);
  }
  return mode;
};

describe.skipIf(!E2E)('verify live e2e (real claude/codex CLIs)', () => {
  describe.skipIf(!Bun.which('claude'))('claude-code', () => {
    test('static: dummytest — fail verdict; frontmatter error + two frontmatter/description warnings', async () => {
      const env = await defaultScanEnv();
      const r = await verifyClaudeCode(env, {
        path: DUMMYTEST,
        modes: ['static'],
        strict: false,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      const mode = requireRan(r.value.modes[0], 'claude static dummytest');
      expect(mode.verdict).toBe('fail');

      const badYaml = mode.findings.find((f) => f.file === 'skills/bad-yaml/SKILL.md');
      expect(badYaml?.normalizedSeverity).toBe('error');
      expect(badYaml?.message).toContain('YAML frontmatter failed to parse');

      const badNoframe = mode.findings.find((f) => f.file === 'skills/bad-noframe/SKILL.md');
      expect(badNoframe?.message).toContain('No frontmatter block found');

      const badNodesc = mode.findings.find((f) => f.file === 'skills/bad-nodesc/SKILL.md');
      expect(badNodesc?.message).toContain('No description in frontmatter');
    }, 120_000);

    test('static: claude-badjson — manifest error contains "Invalid JSON syntax"', async () => {
      const env = await defaultScanEnv();
      const r = await verifyClaudeCode(env, {
        path: CLAUDE_BADJSON,
        modes: ['static'],
        strict: false,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      const mode = requireRan(r.value.modes[0], 'claude static claude-badjson');
      const manifestFinding = mode.findings.find((f) => f.subject === 'manifest');
      expect(manifestFinding?.message).toContain('Invalid JSON syntax');
    }, 120_000);

    test('static: claude-noname — manifest error contains "expected string, received undefined"', async () => {
      const env = await defaultScanEnv();
      const r = await verifyClaudeCode(env, {
        path: CLAUDE_NONAME,
        modes: ['static'],
        strict: false,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      const mode = requireRan(r.value.modes[0], 'claude static claude-noname');
      const manifestFinding = mode.findings.find((f) => f.subject === 'manifest');
      expect(manifestFinding?.message).toContain('expected string, received undefined');
    }, 120_000);

    test('deep: dummytest — ran despite the auth-failed tail; presence warnings for the three broken skills only', async () => {
      const env = await defaultScanEnv();
      const r = await verifyClaudeCode(env, { path: DUMMYTEST, modes: ['deep'], strict: false });
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      const mode = requireRan(r.value.modes[0], 'claude deep dummytest');
      expect(mode.skipReason).toBeNull();

      const goodSkillFinding = mode.findings.find((f) => f.file === 'skills/good-skill/SKILL.md');
      expect(goodSkillFinding).toBeUndefined();

      for (const skill of ['bad-yaml', 'bad-noframe', 'bad-nodesc']) {
        const finding = mode.findings.find((f) => f.file === `skills/${skill}/SKILL.md`);
        expect(finding).toBeDefined();
        expect(finding?.checkId).toBe('claude.load-presence');
        expect(finding?.normalizedSeverity).toBe('warning');
      }
    }, 120_000);

    test('static: bare-skill (wrapped) — pass verdict, no spurious claude.author warning', async () => {
      const env = await defaultScanEnv();
      const r = await verifyPlugin(env, {
        path: BARE_SKILL,
        tools: ['claude-code'],
        strict: false,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      const claudeVerdict = r.value.tools.find((t) => t.tool === 'claude-code');
      const mode = requireRan(claudeVerdict?.modes[0], 'claude static bare-skill');
      expect(mode.verdict).toBe('pass');
      expect(mode.findings.some((f) => f.checkId === 'claude.author')).toBe(false);
    }, 120_000);
  });

  describe.skipIf(!Bun.which('codex'))('codex', () => {
    test('static: dummytest — ran/pass with the codex.static-coverage info notice', async () => {
      const env = await defaultScanEnv();
      const r = await verifyCodex(env, { path: DUMMYTEST, modes: ['static'], strict: false });
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      const mode = requireRan(r.value.modes[0], 'codex static dummytest');
      expect(mode.verdict).toBe('pass');
      const notice = mode.findings.find((f) => f.checkId === 'codex.static-coverage');
      expect(notice).toBeDefined();
    }, 120_000);

    test('static: codex-badplug — error finding referencing "failed to parse plugin.json"', async () => {
      const env = await defaultScanEnv();
      const r = await verifyCodex(env, {
        path: CODEX_BADPLUG,
        modes: ['static'],
        strict: false,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      const mode = requireRan(r.value.modes[0], 'codex static codex-badplug');
      const finding = mode.findings.find((f) => f.checkId === 'codex.manifest');
      expect(finding).toBeDefined();
      // The parser strips the "failed to parse plugin.json: " marker out of `message`
      // (only the underlying reason remains there) but preserves the full tool line
      // verbatim in `raw` — check both so this isn't coupled to which field carries it.
      const haystack = `${finding?.raw ?? ''} ${finding?.message ?? ''}`;
      expect(haystack).toContain('failed to parse plugin.json');
    }, 120_000);

    test('deep: dummytest — ran despite the unauthenticated 401 tail; exactly 3 skill-load errors', async () => {
      const env = await defaultScanEnv();
      const r = await verifyCodex(env, { path: DUMMYTEST, modes: ['deep'], strict: false });
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      const mode = requireRan(r.value.modes[0], 'codex deep dummytest');
      expect(mode.skipReason).toBeNull();

      const errors = mode.findings.filter((f) => f.checkId === 'codex.skill-load');
      expect(errors).toHaveLength(3);
      const messages = errors.map((f) => f.message);
      expect(messages.some((m) => m.includes('invalid YAML'))).toBe(true);
      expect(messages.some((m) => m.includes('missing YAML frontmatter'))).toBe(true);
      expect(messages.some((m) => m.includes('missing field `description`'))).toBe(true);

      // Findings must report target-relative paths (skills/<n>/SKILL.md under DUMMYTEST),
      // not the throwaway `.agents/skills/<n>/SKILL.md` staging path used for the deep exec.
      for (const skill of ['bad-yaml', 'bad-noframe', 'bad-nodesc']) {
        expect(errors.some((f) => f.file === `skills/${skill}/SKILL.md`)).toBe(true);
      }
      expect(errors.every((f) => f.file?.startsWith('.agents/') !== true)).toBe(true);
    }, 120_000);
  });
});
