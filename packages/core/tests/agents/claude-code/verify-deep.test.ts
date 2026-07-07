import { describe, expect, test } from 'bun:test';
import { parseClaudeInit, verifyClaudeCode } from '../../../src/agents/claude-code/verify.ts';
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

// The exact live-observed stream-json tail: init fires locally, then the isolated
// session exits 1 with an authentication_failed assistant event. Healthy path.
const CANNED_DEEP_BLOCK = [
  '{"type":"system","subtype":"init","plugins":[{"name":"dummytest","path":"/work/dummytest","source":"plugin-dir"}],"skills":["dummytest:good-skill"],"slash_commands":[]}',
  '{"type":"assistant","error":"authentication_failed","message":{"content":[{"type":"text","text":"Not logged in · Please run /login"}]}}',
  '{"type":"result","is_error":true}',
].join('\n');

// The Task-3 static block for the `plugin validate` call: one error + two warnings.
// Real output shape: the marker sits alone on a "Found N error(s)/warning(s):" summary
// line; the check/message follows on an indented "  ❯ <checkId>: <message>" line.
const STATIC_BLOCK = [
  'Validating skill: /work/dummytest/skills/bad-yaml/SKILL.md',
  '',
  '✘ Found 1 error:',
  '',
  '  ❯ frontmatter: YAML frontmatter failed to parse: YAML Parse error: Unexpected character.',
  '',
  'Validating skill: /work/dummytest/skills/bad-noframe/SKILL.md',
  '',
  '⚠ Found 1 warning:',
  '',
  '  ❯ frontmatter: No frontmatter block found. Add YAML frontmatter between --- delimiters ...',
  '',
  'Validating skill: /work/dummytest/skills/bad-nodesc/SKILL.md',
  '',
  '⚠ Found 1 warning:',
  '',
  '  ❯ description: No description in frontmatter. ...',
  '',
  '✘ Validation failed',
].join('\n');

describe('parseClaudeInit', () => {
  test('canned block -> first init event plugins + skills', () => {
    expect(parseClaudeInit(CANNED_DEEP_BLOCK)).toEqual({
      plugins: ['dummytest'],
      skills: ['dummytest:good-skill'],
    });
  });

  test('output with no init line -> null', () => {
    const noInit = [
      '{"type":"assistant","error":"authentication_failed"}',
      '{"type":"result","is_error":true}',
    ].join('\n');
    expect(parseClaudeInit(noInit)).toBeNull();
  });

  test('tolerates non-JSON junk lines interleaved', () => {
    const withJunk = [
      'warning: some human-readable stderr leaked into the stream',
      '',
      'not json at all {',
      CANNED_DEEP_BLOCK,
    ].join('\n');
    expect(parseClaudeInit(withJunk)).toEqual({
      plugins: ['dummytest'],
      skills: ['dummytest:good-skill'],
    });
  });
});

describe('verifyClaudeCode deep mode', () => {
  const fakeInstalled = (overrides: Partial<ScanEnv> = {}): ScanEnv => ({
    ...env(),
    path: ['/fake'],
    fileExists: async (p) => p === '/fake/claude',
    realpath: async (p) => p,
    runVersion: async () => '2.1.202 (Claude Code)',
    ...overrides,
  });

  test('static+deep: deep ran despite exit 1, 3 presence warnings, tool verdict fail', async () => {
    let capturedDeepArgs: readonly string[] | undefined;
    let capturedDeepEnv: Record<string, string> | undefined;

    const scanEnv = fakeInstalled({
      fileExists: async (p) => p === '/fake/claude' || p.endsWith('/SKILL.md'),
      listDir: async (p) =>
        p === '/work/dummytest/skills'
          ? ['good-skill', 'bad-yaml', 'bad-noframe', 'bad-nodesc']
          : [],
      readText: async () => '{"name":"dummytest","version":"0.1.0"}',
      exec: async (_cmd, args, opts) => {
        if (args[0] === 'plugin') {
          return { code: 1, stdout: STATIC_BLOCK, stderr: '', timedOut: false };
        }
        capturedDeepArgs = args;
        capturedDeepEnv = opts?.env;
        return { code: 1, stdout: CANNED_DEEP_BLOCK, stderr: '', timedOut: false };
      },
    });

    const r = await verifyClaudeCode(scanEnv, {
      path: '/work/dummytest',
      modes: ['static', 'deep'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.value.modes).toHaveLength(2);
    expect(r.value.modes[0]?.mode).toBe('static');
    expect(r.value.modes[1]?.mode).toBe('deep');

    const deep = r.value.modes[1];
    expect(deep?.status).toBe('ran');
    expect(deep?.skipReason).toBeNull();
    expect(deep?.coverage).toEqual({ manifest: false, skills: true });
    expect(deep?.verdict).toBe('warn');
    expect(deep?.findings).toHaveLength(3);
    for (const f of deep?.findings ?? []) {
      expect(f.checkId).toBe('claude.load-presence');
      expect(f.toolSeverity).toBeNull();
      expect(f.normalizedSeverity).toBe('warning');
      expect(f.subject).toBe('skill');
    }
    // good-skill loaded -> not reported; the three broken fixtures are the gaps.
    expect((deep?.findings ?? []).map((f) => f.file)).toEqual([
      'skills/bad-yaml/SKILL.md',
      'skills/bad-noframe/SKILL.md',
      'skills/bad-nodesc/SKILL.md',
    ]);

    // Tool verdict is the worst of static fail / deep warn.
    expect(r.value.verdict).toBe('fail');

    // The deep call ran under an isolated, non-empty CLAUDE_CONFIG_DIR.
    expect(capturedDeepEnv?.CLAUDE_CONFIG_DIR).toBeTruthy();
    expect(capturedDeepArgs).toEqual([
      '--print',
      '--verbose',
      '--output-format',
      'stream-json',
      '--setting-sources',
      '',
      '--plugin-dir',
      '/work/dummytest',
      'ok',
    ]);
  });

  test('reported deep command string redacts temp path to <tmp>', async () => {
    const scanEnv = fakeInstalled({
      fileExists: async (p) => p === '/fake/claude' || p.endsWith('/SKILL.md'),
      listDir: async () => ['good-skill'],
      readText: async () => '{"name":"dummytest"}',
      exec: async (_cmd, args) => {
        if (args[0] === 'plugin') return { code: 0, stdout: '', stderr: '', timedOut: false };
        return { code: 1, stdout: CANNED_DEEP_BLOCK, stderr: '', timedOut: false };
      },
    });
    const r = await verifyClaudeCode(scanEnv, {
      path: '/work/dummytest',
      modes: ['deep'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.modes[0]?.command).toBe(
      'CLAUDE_CONFIG_DIR=<tmp> claude --print --verbose --output-format stream-json ' +
        '--setting-sources "" --plugin-dir /work/dummytest "ok"',
    );
  });

  test('no init line + exit 1 -> status error, skipReason exec-error, verdict null', async () => {
    const scanEnv = fakeInstalled({
      exec: async (_cmd, args) => {
        if (args[0] === 'plugin') return { code: 0, stdout: '', stderr: '', timedOut: false };
        return { code: 1, stdout: 'segfault: no stream-json here', stderr: '', timedOut: false };
      },
    });
    const r = await verifyClaudeCode(scanEnv, {
      path: '/work/dummytest',
      modes: ['deep'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.modes[0]?.status).toBe('error');
    expect(r.value.modes[0]?.skipReason).toBe('exec-error');
    expect(r.value.modes[0]?.verdict).toBeNull();
    expect(r.value.modes[0]?.findings).toEqual([]);
  });

  test('timedOut on the deep call -> status error, skipReason timeout', async () => {
    const scanEnv = fakeInstalled({
      exec: async (_cmd, args) => {
        if (args[0] === 'plugin') return { code: 0, stdout: '', stderr: '', timedOut: false };
        return { code: 124, stdout: '', stderr: '', timedOut: true };
      },
    });
    const r = await verifyClaudeCode(scanEnv, {
      path: '/work/dummytest',
      modes: ['deep'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.modes[0]?.status).toBe('error');
    expect(r.value.modes[0]?.skipReason).toBe('timeout');
    expect(r.value.modes[0]?.verdict).toBeNull();
  });

  test('all expected skills present in init.skills -> verdict pass, findings []', async () => {
    const allLoaded =
      '{"type":"system","subtype":"init","plugins":[{"name":"dummytest"}],' +
      '"skills":["dummytest:good-skill","dummytest:bad-yaml","dummytest:bad-noframe",' +
      '"dummytest:bad-nodesc"],"slash_commands":[]}';
    const scanEnv = fakeInstalled({
      fileExists: async (p) => p === '/fake/claude' || p.endsWith('/SKILL.md'),
      listDir: async (p) =>
        p === '/work/dummytest/skills'
          ? ['good-skill', 'bad-yaml', 'bad-noframe', 'bad-nodesc']
          : [],
      readText: async () => '{"name":"dummytest"}',
      exec: async (_cmd, args) => {
        if (args[0] === 'plugin') return { code: 0, stdout: '', stderr: '', timedOut: false };
        return { code: 1, stdout: allLoaded, stderr: '', timedOut: false };
      },
    });
    const r = await verifyClaudeCode(scanEnv, {
      path: '/work/dummytest',
      modes: ['deep'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.modes[0]?.status).toBe('ran');
    expect(r.value.modes[0]?.verdict).toBe('pass');
    expect(r.value.modes[0]?.findings).toEqual([]);
  });

  test('presence gaps become fail under --strict', async () => {
    const scanEnv = fakeInstalled({
      fileExists: async (p) => p === '/fake/claude' || p.endsWith('/SKILL.md'),
      listDir: async () => ['bad-yaml'],
      readText: async () => '{"name":"dummytest"}',
      exec: async (_cmd, args) => {
        if (args[0] === 'plugin') return { code: 0, stdout: '', stderr: '', timedOut: false };
        return { code: 1, stdout: CANNED_DEEP_BLOCK, stderr: '', timedOut: false };
      },
    });
    const r = await verifyClaudeCode(scanEnv, {
      path: '/work/dummytest',
      modes: ['deep'],
      strict: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.modes[0]?.findings).toHaveLength(1);
    expect(r.value.modes[0]?.verdict).toBe('fail');
  });

  test('unreadable plugin.json -> pluginName null, every expected skill reported missing', async () => {
    const scanEnv = fakeInstalled({
      fileExists: async (p) => p === '/fake/claude' || p.endsWith('/SKILL.md'),
      listDir: async () => ['good-skill'],
      readText: async () => {
        throw new Error('ENOENT');
      },
      exec: async (_cmd, args) => {
        if (args[0] === 'plugin') return { code: 0, stdout: '', stderr: '', timedOut: false };
        return { code: 1, stdout: CANNED_DEEP_BLOCK, stderr: '', timedOut: false };
      },
    });
    const r = await verifyClaudeCode(scanEnv, {
      path: '/work/dummytest',
      modes: ['deep'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // good-skill loaded as 'dummytest:good-skill' but pluginName is null, so
    // 'null:good-skill' never matches -> reported missing.
    expect(r.value.modes[0]?.findings).toHaveLength(1);
    expect(r.value.modes[0]?.findings[0]?.file).toBe('skills/good-skill/SKILL.md');
  });
});
