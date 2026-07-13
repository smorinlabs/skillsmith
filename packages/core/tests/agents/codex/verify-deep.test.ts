import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCodexExecStderr, verifyCodex } from '../../../src/agents/codex/verify.ts';
import type { ExecResult, ScanEnv } from '../../../src/env/types.ts';
import type { VerifyPorts } from '../../../src/verify/types.ts';
import { runtimePorts } from '../../fixtures/runtime-ports.ts';

const FIXTURES = join(import.meta.dir, '..', '..', 'fixtures', 'verify');
const DUMMY = join(FIXTURES, 'dummytest');

const ADDED_PLUGIN = 'Added plugin `dummytest` ...';
const LIST_JSON =
  '{"installed":[{"name":"dummytest","version":"0.1.0","installed":true,"enabled":true,"source":"skillsmith-mkt"}],"available":[]}';

// The exact live-observed deep stderr: three per-skill load failures fire at session start,
// then the isolated (unauthenticated) session tail is a 401 + exit 1. Healthy path.
const CANNED_DEEP_STDERR = [
  'ERROR codex_core::session::session: failed to load skill /proj/.agents/skills/bad-yaml/SKILL.md: invalid YAML: found unexpected end of stream at line 3 column 23',
  'ERROR codex_core::session::session: failed to load skill /proj/.agents/skills/bad-noframe/SKILL.md: missing YAML frontmatter delimited by ---',
  'ERROR codex_core::session::session: failed to load skill /proj/.agents/skills/bad-nodesc/SKILL.md: missing field `description`',
  'ERROR codex_api: 401 Unauthorized',
].join('\n');

// fileExists must resolve real fixture paths (deep staging copies the real skills), but must
// NOT fall through to the real disk for detect()'s well-known-bin-dir probes.
const fileExistsFake = (p: string): boolean => {
  if (p === '/fake/codex') return true;
  if (p.startsWith(FIXTURES)) return existsSync(p);
  return false;
};

const scanEnvFixture = (): ScanEnv => ({
  homeDir: '/h',
  path: [],
  platform: 'linux',
  xdg: { config: '/h/.config', data: '/h/.local/share', cache: '/h/.cache' },
  fileExists: async (p) => fileExistsFake(p),
  realpath: async (p) => p,
  listDir: async (p) => readdir(p),
  readText: async (p) => readFile(p, 'utf8'),
  runVersion: async () => 'unknown',
  exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
  pathKind: async () => 'absent' as const,
  isExecutable: async () => false,
  readBytes: async () => new Uint8Array(),
  readLink: async () => '',
  makeSymlink: async () => {},
  rename: async () => {},
  copyTree: async () => {},
  removeTree: async () => {},
  makeDir: async () => {},
  writeTextFile: async () => {},
  fsyncFile: async () => {},
  fsyncDir: async () => {},
  modifiedAt: async () => null,
  withFileLock: (_p, fn) => fn(),
});

const fakeInstalled = (overrides: Partial<ScanEnv> = {}): VerifyPorts =>
  runtimePorts({
    ...scanEnvFixture(),
    path: ['/fake'],
    runVersion: async () => '0.142.5 (Codex CLI)',
    ...overrides,
  });

// Static happy-path exec sequence (Task 5), used by the combined static+deep run.
const staticHappyPath = (_cmd: string, args: readonly string[]): ExecResult | null => {
  if (args[0] !== 'plugin') return null;
  const step = args[1];
  if (step === 'marketplace') return { code: 0, stdout: '', stderr: '', timedOut: false };
  if (step === 'add') return { code: 0, stdout: ADDED_PLUGIN, stderr: '', timedOut: false };
  if (step === 'list') return { code: 0, stdout: LIST_JSON, stderr: '', timedOut: false };
  throw new Error(`unexpected plugin exec call: ${args.join(' ')}`);
};

describe('parseCodexExecStderr', () => {
  test('canned block, projDir /proj -> exactly 3 skill-load errors; 401 line ignored', () => {
    const findings = parseCodexExecStderr(CANNED_DEEP_STDERR, '/proj');
    expect(findings).toHaveLength(3);
    expect(findings.map((f) => f.message)).toEqual([
      'invalid YAML: found unexpected end of stream at line 3 column 23',
      'missing YAML frontmatter delimited by ---',
      'missing field `description`',
    ]);
    // Staged paths (relative to the throwaway deep-mode project) are mapped back to the
    // plugin-relative form the verified target actually has, not the temp staging layout.
    expect(findings.map((f) => f.file)).toEqual([
      'skills/bad-yaml/SKILL.md',
      'skills/bad-noframe/SKILL.md',
      'skills/bad-nodesc/SKILL.md',
    ]);
    for (const f of findings) {
      expect(f.checkId).toBe('codex.skill-load');
      expect(f.toolSeverity).toBe('error');
      expect(f.normalizedSeverity).toBe('error');
      expect(f.subject).toBe('skill');
    }
    expect(findings[0]?.raw).toBe(
      'ERROR codex_core::session::session: failed to load skill /proj/.agents/skills/bad-yaml/SKILL.md: invalid YAML: found unexpected end of stream at line 3 column 23',
    );
  });

  test('clean stderr (only the 401 tail) -> no findings', () => {
    expect(parseCodexExecStderr('ERROR codex_api: 401 Unauthorized', '/proj')).toEqual([]);
  });

  test('targetKind "skill" (bare-skill wrap) -> collapses to the original bare SKILL.md', () => {
    const stderr =
      'ERROR codex_core::session::session: failed to load skill /proj/.agents/skills/my-skill/SKILL.md: missing field `description`';
    const findings = parseCodexExecStderr(stderr, '/proj', 'skill');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe('SKILL.md');
  });
});

describe('verifyCodex deep mode', () => {
  test('static+deep: deep ran despite exit 1, 3 skill-load findings, tool verdict fail', async () => {
    let deepArgs: readonly string[] | undefined;
    let deepEnv: Record<string, string> | undefined;
    let proj: string | undefined;
    let home: string | undefined;
    let goodSkillStaged = false;

    const scanEnv = fakeInstalled({
      exec: async (_cmd, args, opts): Promise<ExecResult> => {
        const staticResult = staticHappyPath(_cmd, args);
        if (staticResult) return staticResult;
        // deep exec: args[0] === 'exec'
        deepArgs = args;
        deepEnv = opts?.env;
        proj = args[2]; // the value after '-C'
        home = opts?.env?.CODEX_HOME;
        goodSkillStaged = existsSync(
          join(proj as string, '.agents', 'skills', 'good-skill', 'SKILL.md'),
        );
        // Real codex reports the actual temp project path, not a fixed literal — substitute
        // it in so the prefix-stripping in parseCodexExecStderr exercises for real here.
        return {
          code: 1,
          stdout: '',
          stderr: CANNED_DEEP_STDERR.replaceAll('/proj', proj as string),
          timedOut: false,
        };
      },
    });

    const r = await verifyCodex(scanEnv, {
      path: DUMMY,
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
    expect(deep?.verdict).toBe('fail');
    expect(deep?.findings).toHaveLength(3);
    for (const f of deep?.findings ?? []) {
      expect(f.checkId).toBe('codex.skill-load');
      expect(f.normalizedSeverity).toBe('error');
    }
    // Findings report target-relative paths (the target's real `skills/<n>/` layout),
    // not the throwaway `.agents/skills/<n>/` staging path used for the deep exec.
    expect((deep?.findings ?? []).map((f) => f.file)).toEqual([
      'skills/bad-yaml/SKILL.md',
      'skills/bad-noframe/SKILL.md',
      'skills/bad-nodesc/SKILL.md',
    ]);

    // Tool verdict is the worst of static pass / deep fail.
    expect(r.value.verdict).toBe('fail');

    // The deep call ran under an isolated, non-empty CODEX_HOME with the frozen args.
    expect(deepEnv?.CODEX_HOME).toBeTruthy();
    expect(deepArgs).toEqual([
      'exec',
      '-C',
      proj as string,
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      'ok',
    ]);
    expect(deep?.command).toBe(
      'codex exec -C <proj> --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "ok"',
    );

    // The real fixture skill was staged into the throwaway project before the exec.
    expect(goodSkillStaged).toBe(true);

    // Both temp dirs were removed in finally.
    expect(existsSync(proj as string)).toBe(false);
    expect(existsSync(home as string)).toBe(false);
  });

  test('clean skills + only the 401 tail (exit 1) -> ran, pass, no findings', async () => {
    const scanEnv = fakeInstalled({
      exec: async (_cmd, args): Promise<ExecResult> => {
        if (args[0] !== 'exec') throw new Error(`unexpected exec call: ${args.join(' ')}`);
        return {
          code: 1,
          stdout: '',
          stderr: 'ERROR codex_api: 401 Unauthorized',
          timedOut: false,
        };
      },
    });

    const r = await verifyCodex(scanEnv, { path: DUMMY, modes: ['deep'], strict: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const mode = r.value.modes[0];
    expect(mode?.status).toBe('ran');
    expect(mode?.skipReason).toBeNull();
    expect(mode?.verdict).toBe('pass');
    expect(mode?.findings).toEqual([]);
    expect(mode?.coverage).toEqual({ manifest: false, skills: true });
  });

  test('unrecognized non-zero (no load evidence, no 401) -> error, exec-error, verdict null', async () => {
    const scanEnv = fakeInstalled({
      exec: async (_cmd, args): Promise<ExecResult> => {
        if (args[0] !== 'exec') throw new Error(`unexpected exec call: ${args.join(' ')}`);
        return { code: 1, stdout: '', stderr: 'panic: something', timedOut: false };
      },
    });

    const r = await verifyCodex(scanEnv, { path: DUMMY, modes: ['deep'], strict: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const mode = r.value.modes[0];
    expect(mode?.status).toBe('error');
    expect(mode?.skipReason).toBe('exec-error');
    expect(mode?.verdict).toBeNull();
    expect(mode?.findings).toEqual([]);
  });

  test('timedOut on the deep call -> error, skipReason timeout, verdict null', async () => {
    const scanEnv = fakeInstalled({
      exec: async (_cmd, args): Promise<ExecResult> => {
        if (args[0] !== 'exec') throw new Error(`unexpected exec call: ${args.join(' ')}`);
        return { code: 124, stdout: '', stderr: '', timedOut: true };
      },
    });

    const r = await verifyCodex(scanEnv, { path: DUMMY, modes: ['deep'], strict: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const mode = r.value.modes[0];
    expect(mode?.status).toBe('error');
    expect(mode?.skipReason).toBe('timeout');
    expect(mode?.verdict).toBeNull();
  });

  test('temp proj/home dirs are removed after the deep run', async () => {
    let proj: string | undefined;
    let home: string | undefined;
    const scanEnv = fakeInstalled({
      exec: async (_cmd, args, opts): Promise<ExecResult> => {
        if (args[0] !== 'exec') throw new Error(`unexpected exec call: ${args.join(' ')}`);
        proj = args[2];
        home = opts?.env?.CODEX_HOME;
        return {
          code: 1,
          stdout: '',
          stderr: 'ERROR codex_api: 401 Unauthorized',
          timedOut: false,
        };
      },
    });

    const r = await verifyCodex(scanEnv, { path: DUMMY, modes: ['deep'], strict: false });
    expect(r.ok).toBe(true);
    expect(typeof proj).toBe('string');
    expect(typeof home).toBe('string');
    expect(existsSync(proj as string)).toBe(false);
    expect(existsSync(home as string)).toBe(false);
  });
});
