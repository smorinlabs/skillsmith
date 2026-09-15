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

const NAMES = ['bad-nodesc', 'bad-noframe', 'bad-yaml', 'good-skill'];
const loaded = (proj: string) =>
  NAMES.map((name) => ({
    path: join(proj, '.agents', 'skills', name, 'SKILL.md'),
    enabled: true,
  }));
const reply = (proj: string, skills: unknown = loaded(proj), errors: unknown = []) =>
  `${JSON.stringify({ id: 1, result: {} })}\n${JSON.stringify({ id: 2, result: { data: [{ cwd: proj, skills, errors }] } })}\n`;

describe('verifyCodex deep mode', () => {
  const probe = async (
    respond: (proj: string) => Partial<ExecResult> = (proj) => ({ stdout: reply(proj) }),
    options: { kind?: 'plugin' | 'skill'; canonical?: boolean; combined?: boolean } = {},
  ) => {
    let stagedProject = '';
    let isolatedHome = '';
    let childEnvironment: Record<string, string> | undefined;
    const scanEnv = fakeInstalled({
      realpath: async (path) => (options.canonical ? `/canonical${path}` : path),
      exec: async (binary, args, opts): Promise<ExecResult> => {
        const staticResult = staticHappyPath(binary, args);
        if (staticResult) return staticResult;
        expect(args).toEqual(['app-server', '--listen', 'stdio://']);
        expect(opts?.jsonRpc?.map((message) => message.method)).toEqual([
          'initialize',
          'initialized',
          'skills/list',
        ]);
        const params = opts?.jsonRpc?.[2]?.params as { cwds: string[]; forceReload: boolean };
        expect(params.forceReload).toBe(true);
        expect(opts?.input).toBeUndefined();
        expect(opts?.unsetEnv).toContain('OPENAI_API_KEY');
        expect(opts?.env?.CODEX_HOME).toBeTruthy();
        expect(opts?.env?.HOME).toBe(opts?.env?.CODEX_HOME);
        childEnvironment = opts?.env;
        stagedProject = opts?.cwd ?? '';
        isolatedHome = opts?.env?.CODEX_HOME ?? '';
        expect(existsSync(join(stagedProject, '.agents', 'skills', 'good-skill', 'SKILL.md'))).toBe(
          true,
        );
        return {
          code: 0,
          stdout: '',
          stderr: '',
          timedOut: false,
          ...respond(params.cwds[0] ?? ''),
        };
      },
    });
    const result = await verifyCodex(scanEnv, {
      path: DUMMY,
      modes: options.combined ? ['static', 'deep'] : ['deep'],
      strict: false,
      ...(options.kind ? { kind: options.kind } : {}),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('verifier failed outside mode reporting');
    expect(childEnvironment?.CODEX_HOME).toBeTruthy();
    for (const key of [
      'HOME',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_CACHE_HOME',
      'XDG_STATE_HOME',
      'XDG_RUNTIME_DIR',
      'XDG_CONFIG_DIRS',
      'XDG_DATA_DIRS',
    ]) {
      expect(childEnvironment?.[key]).toBe(childEnvironment?.CODEX_HOME);
    }
    expect(existsSync(stagedProject)).toBe(false);
    expect(existsSync(isolatedHome)).toBe(false);
    const deep = result.value.modes.find((mode) => mode.mode === 'deep');
    if (!deep) throw new Error('missing deep result');
    expect(deep.command).not.toContain('exec -C');
    expect(deep.command).not.toContain(stagedProject);
    return { deep, tool: result.value };
  };

  test('all expected skills enabled -> pass without a model turn', async () => {
    const { deep, tool } = await probe(undefined, { combined: true });
    expect(deep.status).toBe('ran');
    expect(deep.verdict).toBe('pass');
    expect(deep.coverage).toEqual({ manifest: false, skills: true });
    expect(deep.findings).toEqual([]);
    expect(tool.verdict).toBe('pass');
  });

  test('canonical staged paths are used (macOS /private aliases)', async () => {
    expect((await probe(undefined, { canonical: true })).deep.verdict).toBe('pass');
  });

  test.each(['plugin', 'skill'] as const)(
    'structured target errors map to original %s paths',
    async (kind) => {
      const { deep, tool } = await probe(
        (proj) => ({
          stdout: reply(
            proj,
            [loaded(proj)[3]],
            NAMES.slice(0, 3).map((name) => ({
              path: join(proj, '.agents', 'skills', name, 'SKILL.md'),
              message: 'invalid skill',
            })),
          ),
        }),
        { kind, combined: true },
      );
      expect(deep.status).toBe('ran');
      expect(deep.verdict).toBe('fail');
      expect(tool.verdict).toBe('fail');
      expect(deep.findings.map((finding) => finding.file).sort()).toEqual(
        kind === 'skill'
          ? ['SKILL.md', 'SKILL.md', 'SKILL.md']
          : NAMES.slice(0, 3).map((name) => `skills/${name}/SKILL.md`),
      );
    },
  );

  test.each(['missing', 'disabled'] as const)(
    '%s target is incomplete, not a pass or invented invalid-artifact failure',
    async (condition) => {
      const { deep, tool } = await probe((proj) => ({
        stdout: reply(
          proj,
          loaded(proj).flatMap((skill, index) =>
            index === 0 ? (condition === 'missing' ? [] : [{ ...skill, enabled: false }]) : [skill],
          ),
        ),
      }));
      expect(deep.status).toBe('error');
      expect(deep.verdict).toBeNull();
      expect(deep.coverage.skills).toBe(false);
      expect(tool.verdict).toBe('inconclusive');
      expect(deep.findings.some((finding) => finding.file === 'skills/bad-nodesc/SKILL.md')).toBe(
        true,
      );
    },
  );

  test('unrelated discovery cannot satisfy missing targets', async () => {
    const { deep } = await probe((proj) => ({
      stdout: reply(proj, loaded('/unrelated/project')),
    }));
    expect(deep.status).toBe('error');
  });

  test('unrelated errors do not invalidate correctly loaded targets', async () => {
    const { deep } = await probe((proj) => ({
      stdout: reply(proj, loaded(proj), [{ path: '/unrelated/SKILL.md', message: 'invalid' }]),
    }));
    expect(deep.verdict).toBe('pass');
  });

  test('a proven invalid target outranks another missing target', async () => {
    const { deep } = await probe((proj) => ({
      stdout: reply(proj, [], [{ path: loaded(proj)[0]?.path, message: 'invalid' }]),
    }));
    expect(deep.verdict).toBe('fail');
  });

  test.each([
    'garbage',
    '{"id":2,"result":{"data":[]}}',
    '{"id":1,"result":{}}\n{"id":2,"result":{"data":[{"cwd":"wrong","skills":[],"errors":[]}]}}',
  ])('malformed/missing response is incomplete: %s', async (stdout) => {
    expect((await probe(() => ({ stdout }))).deep.status).toBe('error');
  });

  test.each([{ code: 1 }, { timedOut: true }, { protocolError: 'RPC error -32601' }])(
    'process/protocol errors preserve bounded sanitized diagnostics: %j',
    async (failure) => {
      const { deep, tool } = await probe(() => ({
        ...failure,
        stderr: `failure token=private-value Authorization: Bearer secret-value ${'x'.repeat(5000)}`,
      }));
      expect(deep.status).toBe('error');
      expect(deep.skipReason).toBe(failure.timedOut ? 'timeout' : 'exec-error');
      expect(tool.verdict).toBe('inconclusive');
      expect(deep.findings.length).toBeGreaterThan(0);
      const diagnostic = deep.findings.map((finding) => finding.message).join('\n');
      expect(diagnostic).not.toContain('private-value');
      expect(diagnostic).not.toContain('secret-value');
      expect(diagnostic.length).toBeLessThan(2500);
    },
  );
});
