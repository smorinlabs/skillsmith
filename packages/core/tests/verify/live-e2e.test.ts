import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { verifyClaudeCode } from '../../src/agents/claude-code/verify.ts';
import { verifyCodex } from '../../src/agents/codex/verify.ts';
import { verifyMuse } from '../../src/agents/muse/verify.ts';
import { defaultRuntimePorts as defaultScanEnv } from '../../src/ports/default.ts';
import { verifyPlugin } from '../../src/verify/run.ts';
import type { ModeResult } from '../../src/verify/types.ts';

// Env-gated live e2e against the real `claude` / `codex` / `muse` CLIs. CI never sets
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
const MUSE_WARN = join(FIXTURES, 'muse-warn');

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

describe.skipIf(!E2E)('verify live e2e (real claude/codex/muse CLIs)', () => {
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

    test('static: claude-noname — missing-name manifest error retains a verified diagnostic', async () => {
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
      expect(mode.verdict).toBe('fail');
      expect(manifestFinding).toMatchObject({
        checkId: 'claude.name',
        subject: 'manifest',
        file: '.claude-plugin/plugin.json',
        toolSeverity: 'error',
        normalizedSeverity: 'error',
      });
      expect(['Invalid input', 'Invalid input: expected string, received undefined']).toContain(
        manifestFinding?.message ?? '',
      );
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

  describe.skipIf(!Bun.which('muse'))('muse', () => {
    test('static: dummytest — fail verdict; two invalid-skill-package errors + yaml-leniency info', async () => {
      const env = await defaultScanEnv();
      const r = await verifyMuse(env, { path: DUMMYTEST, modes: ['static'], strict: false });
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      const mode = requireRan(r.value.modes[0], 'muse static dummytest');
      expect(mode.verdict).toBe('fail');

      const errors = mode.findings.filter((f) => f.checkId === 'muse.invalid-skill-package');
      expect(errors).toHaveLength(2);
      const messages = errors.map((f) => f.message);
      expect(messages.some((m) => m.includes('must include description'))).toBe(true);
      expect(messages.some((m) => m.includes('must start with YAML frontmatter'))).toBe(true);
      for (const skill of ['bad-nodesc', 'bad-noframe']) {
        expect(errors.some((f) => f.file === `skills/${skill}/SKILL.md`)).toBe(true);
      }

      // muse tolerates bad YAML (valid:true in the tool JSON) but reports the
      // unknown frontmatter field: an info notice, never an error.
      const yamlErrors = mode.findings.filter(
        (f) => f.file === 'skills/bad-yaml/SKILL.md' && f.normalizedSeverity === 'error',
      );
      expect(yamlErrors).toHaveLength(0);
      const yamlNotice = mode.findings.find(
        (f) => f.checkId === 'muse.unknown-fields' && f.file === 'skills/bad-yaml/SKILL.md',
      );
      expect(yamlNotice?.message).toContain('tags');
    }, 120_000);

    test('static: muse-warn — warn verdict; advisory allowed-tools warning + version info', async () => {
      const env = await defaultScanEnv();
      const r = await verifyMuse(env, { path: MUSE_WARN, modes: ['static'], strict: false });
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      const mode = requireRan(r.value.modes[0], 'muse static muse-warn');
      expect(mode.verdict).toBe('warn');

      const warning = mode.findings.find((f) => f.checkId === 'muse.unsupported-skill-field');
      expect(warning?.normalizedSeverity).toBe('warning');
      expect(warning?.message).toContain('allowed-tools');

      const info = mode.findings.find((f) => f.checkId === 'muse.unknown-fields');
      expect(info?.normalizedSeverity).toBe('info');
      expect(info?.message).toContain('version');
    }, 120_000);

    test('deep: dummytest — fail verdict; each bad skill reported once per staged scope', async () => {
      const env = await defaultScanEnv();
      const r = await verifyMuse(env, { path: DUMMYTEST, modes: ['deep'], strict: false });
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      const mode = requireRan(r.value.modes[0], 'muse deep dummytest');
      expect(mode.skipReason).toBeNull();
      expect(mode.verdict).toBe('fail');

      // Deep stages the target twice (user-scope and project-scope loader legs)
      // and each leg reports its own diagnostics: 2 bad skills × 2 legs.
      const errors = mode.findings.filter((f) => f.checkId === 'muse.invalid-skill-package');
      expect(errors).toHaveLength(4);
      const files = new Set(errors.map((f) => f.file));
      expect(files).toEqual(new Set(['skills/bad-nodesc/SKILL.md', 'skills/bad-noframe/SKILL.md']));
      const messages = errors.map((f) => f.message);
      expect(messages.some((m) => m.includes('must include description'))).toBe(true);
      expect(messages.some((m) => m.includes('must start with YAML frontmatter'))).toBe(true);

      // Findings must report target-relative paths (skills/<n>/SKILL.md under
      // DUMMYTEST), not the throwaway staging paths used for the deep execs.
      expect(errors.every((f) => f.file?.startsWith('.agents/') !== true)).toBe(true);
      expect(errors.every((f) => f.file?.startsWith('.config/') !== true)).toBe(true);
      expect(errors.every((f) => (f.file?.includes('muse-home') ?? false) !== true)).toBe(true);
    }, 120_000);
  });
});
