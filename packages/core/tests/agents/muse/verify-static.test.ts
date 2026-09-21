import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseMuseValidateOutput, verifyMuse } from '../../../src/agents/muse/verify.ts';
import type { ExecResult, ScanEnv } from '../../../src/env/types.ts';
import type { VerifyPorts } from '../../../src/verify/types.ts';
import { runtimePorts } from '../../fixtures/runtime-ports.ts';

const FIXTURES = join(import.meta.dir, '..', '..', 'fixtures', 'verify');
const PINNED_VERSION = 'Muse Code 1.3.0 (1.3.0-R3401.1)';

const VALID_CLEAN = (id: string): string =>
  JSON.stringify({
    valid: true,
    id,
    source_path: `/src/${id}`,
    files: [{ relative_path: 'SKILL.md', sha256: 'sha256:00', bytes: 10 }],
    diagnostics: [],
    compatibility: {
      profile: 'agent-skills-common-subset',
      result: 'compatible',
      known_fields: ['description', 'name'],
      unknown_fields: [],
      unsupported_fields: [],
      allowed_tools: [],
    },
  });

const WARN_DIAGNOSTIC = {
  code: 'unsupported-skill-field',
  severity: 'warning',
  message: '`allowed-tools` is recorded as advisory metadata but is not enforced',
  path: '/src/warn-skill/SKILL.md',
};

const VALID_WARN = JSON.stringify({
  valid: true,
  id: 'warn-skill',
  source_path: '/src/warn-skill',
  files: [],
  diagnostics: [WARN_DIAGNOSTIC],
  compatibility: {
    profile: 'agent-skills-common-subset',
    result: 'compatible',
    known_fields: ['allowed-tools', 'description', 'name'],
    unknown_fields: ['version'],
    unsupported_fields: [],
    allowed_tools: ['Grep', 'Read'],
  },
});

const ENVELOPE = (code: string, message: string): string =>
  JSON.stringify({ error: { code, message, details: { path: '/src/x' } } });

// fileExists must resolve real fixture paths (skill enumeration reads the real
// target), but must NOT fall through to the real disk for detect()'s
// well-known-bin-dir probes.
const fileExistsFake = (p: string): boolean => {
  if (p === '/fake/muse') return true;
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
  readText: async () => '',
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
    runVersion: async () => PINNED_VERSION,
    ...overrides,
  });

describe('parseMuseValidateOutput', () => {
  test('valid:true without diagnostics -> no findings', () => {
    expect(
      parseMuseValidateOutput(VALID_CLEAN('good-skill'), 'skills/good-skill/SKILL.md'),
    ).toEqual({ findings: [] });
  });

  test('warning diagnostic + unknown field -> warning and info findings', () => {
    const parsed = parseMuseValidateOutput(VALID_WARN, 'skills/warn-skill/SKILL.md');
    expect(parsed).toEqual({
      findings: [
        {
          checkId: 'muse.unsupported-skill-field',
          toolSeverity: 'unsupported-skill-field',
          normalizedSeverity: 'warning',
          message: WARN_DIAGNOSTIC.message,
          file: 'skills/warn-skill/SKILL.md',
          subject: 'skill',
          raw: JSON.stringify(WARN_DIAGNOSTIC),
        },
        {
          checkId: 'muse.unknown-fields',
          toolSeverity: null,
          normalizedSeverity: 'info',
          message: 'unknown frontmatter fields (tolerated by muse): version',
          file: 'skills/warn-skill/SKILL.md',
          subject: 'skill',
        },
      ],
    });
  });

  test('unsupported fields -> warning finding', () => {
    const parsed = parseMuseValidateOutput(
      JSON.stringify({
        valid: true,
        id: 'x',
        diagnostics: [],
        compatibility: { unknown_fields: [], unsupported_fields: ['future-flag'] },
      }),
      'SKILL.md',
    );
    expect(parsed).toEqual({
      findings: [
        {
          checkId: 'muse.unsupported-fields',
          toolSeverity: null,
          normalizedSeverity: 'warning',
          message: 'unsupported frontmatter fields: future-flag',
          file: 'SKILL.md',
          subject: 'skill',
        },
      ],
    });
  });

  test('error envelope -> muse.<code> error finding with verbatim message', () => {
    const parsed = parseMuseValidateOutput(
      ENVELOPE('invalid-skill-package', 'SKILL.md must start with YAML frontmatter'),
      'skills/bad-noframe/SKILL.md',
    );
    expect(parsed).toEqual({
      findings: [
        {
          checkId: 'muse.invalid-skill-package',
          toolSeverity: 'invalid-skill-package',
          normalizedSeverity: 'error',
          message: 'SKILL.md must start with YAML frontmatter',
          file: 'skills/bad-noframe/SKILL.md',
          subject: 'skill',
        },
      ],
    });
  });

  test('garbage and non-record JSON -> execError', () => {
    expect(parseMuseValidateOutput('not json{{{', 'SKILL.md')).toEqual({ execError: true });
    expect(parseMuseValidateOutput('[1,2]', 'SKILL.md')).toEqual({ execError: true });
    expect(parseMuseValidateOutput('{}', 'SKILL.md')).toEqual({ execError: true });
  });

  test('valid:false -> muse.invalid error plus mapped diagnostics', () => {
    const parsed = parseMuseValidateOutput(
      JSON.stringify({ valid: false, diagnostics: [WARN_DIAGNOSTIC] }),
      'SKILL.md',
    );
    if (!('findings' in parsed)) throw new Error('expected findings');
    expect(parsed.findings[0]).toMatchObject({
      checkId: 'muse.invalid',
      normalizedSeverity: 'error',
    });
    expect(parsed.findings).toHaveLength(2);
  });
});

describe('verifyMuse static mode', () => {
  test('dummytest: one validate call per skill, isolated env, failures collected, home cleaned', async () => {
    const calls: { args: readonly string[]; env?: Record<string, string> }[] = [];
    const scanEnv = fakeInstalled({
      exec: async (_cmd, args, opts): Promise<ExecResult> => {
        calls.push({ args, ...(opts?.env !== undefined ? { env: opts.env } : {}) });
        const skill = basename(args[2] ?? '');
        if (skill === 'good-skill') {
          return { code: 0, stdout: VALID_CLEAN(skill), stderr: '', timedOut: false };
        }
        return {
          code: 1,
          stdout: ENVELOPE('invalid-skill-package', `bad skill: ${skill}`),
          stderr: `bad skill: ${skill}`,
          timedOut: false,
        };
      },
    });

    const r = await verifyMuse(scanEnv, {
      path: join(FIXTURES, 'dummytest'),
      modes: ['static'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const mode = r.value.modes[0];
    expect(mode?.status).toBe('ran');
    expect(mode?.skipReason).toBeNull();
    expect(mode?.coverage).toEqual({ manifest: false, skills: true });
    expect(mode?.verdict).toBe('fail');
    expect(mode?.command).toBe('muse skills validate 4 skill dir(s) --json');
    expect(mode?.findings.map((f) => f.file).sort()).toEqual([
      'skills/bad-nodesc/SKILL.md',
      'skills/bad-noframe/SKILL.md',
      'skills/bad-yaml/SKILL.md',
    ]);
    for (const finding of mode?.findings ?? []) {
      expect(finding.checkId).toBe('muse.invalid-skill-package');
      expect(finding.normalizedSeverity).toBe('error');
    }

    expect(calls).toHaveLength(4);
    const home = calls[0]?.env?.HOME;
    expect(typeof home).toBe('string');
    expect(home).toContain('muse-home');
    for (const call of calls) {
      expect(call.args.slice(0, 2)).toEqual(['skills', 'validate']);
      expect(call.args[3]).toBe('--json');
      expect(call.env?.MUSE_NO_AUTO_UPDATE).toBe('1');
      expect(call.env?.HOME).toBe(home);
      expect(call.env?.XDG_CONFIG_HOME).toBe(join(home as string, '.config'));
      expect(call.env?.XDG_DATA_HOME).toBe(join(home as string, '.local', 'share'));
      expect(call.env?.XDG_CACHE_HOME).toBe(join(home as string, '.cache'));
      expect(call.env?.XDG_STATE_HOME).toBe(join(home as string, '.local', 'state'));
    }
    expect(existsSync(home as string)).toBe(false);
  });

  test('warnings-only skill: warn by default, fail under strict', async () => {
    const run = async (strict: boolean) => {
      const scanEnv = fakeInstalled({
        exec: async (): Promise<ExecResult> => ({
          code: 0,
          stdout: VALID_WARN,
          stderr: '',
          timedOut: false,
        }),
      });
      return verifyMuse(scanEnv, {
        path: join(FIXTURES, 'muse-warn'),
        modes: ['static'],
        strict,
      });
    };
    const loose = await run(false);
    const strict = await run(true);
    expect(loose.ok && loose.value.modes[0]?.verdict).toBe('warn');
    expect(strict.ok && strict.value.modes[0]?.verdict).toBe('fail');
    expect(loose.ok && loose.value.modes[0]?.coverage).toEqual({ manifest: false, skills: true });
  });

  test('target without skills (claude-noname) -> pass, no-skills info, zero exec calls', async () => {
    let execCalls = 0;
    const scanEnv = fakeInstalled({
      exec: async (): Promise<ExecResult> => {
        execCalls++;
        return { code: 0, stdout: '', stderr: '', timedOut: false };
      },
    });
    const r = await verifyMuse(scanEnv, {
      path: join(FIXTURES, 'claude-noname'),
      modes: ['static'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.modes[0]).toEqual({
      mode: 'static',
      status: 'ran',
      skipReason: null,
      coverage: { manifest: false, skills: false },
      verdict: 'pass',
      command: '(skipped: no skills to validate)',
      findings: [
        {
          checkId: 'muse.no-skills',
          toolSeverity: null,
          normalizedSeverity: 'info',
          message: 'no skills found; muse skill validation not applicable',
          file: null,
          subject: 'skill',
        },
      ],
    });
    expect(execCalls).toBe(0);
  });

  test('kind skill collapses finding files to the bare SKILL.md', async () => {
    const scanEnv = fakeInstalled({
      exec: async (): Promise<ExecResult> => ({
        code: 0,
        stdout: VALID_WARN,
        stderr: '',
        timedOut: false,
      }),
    });
    const r = await verifyMuse(scanEnv, {
      path: join(FIXTURES, 'muse-warn'),
      modes: ['static'],
      strict: false,
      kind: 'skill',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.modes[0]?.findings.map((f) => f.file)).toEqual(['SKILL.md', 'SKILL.md']);
  });

  test('timedOut -> status error, skipReason timeout', async () => {
    const scanEnv = fakeInstalled({
      exec: async (): Promise<ExecResult> => ({
        code: 124,
        stdout: '',
        stderr: '',
        timedOut: true,
      }),
    });
    const r = await verifyMuse(scanEnv, {
      path: join(FIXTURES, 'muse-warn'),
      modes: ['static'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const mode = r.value.modes[0];
    expect(mode?.status).toBe('error');
    expect(mode?.skipReason).toBe('timeout');
    expect(mode?.verdict).toBeNull();
  });

  test('garbage stdout -> status error, skipReason exec-error', async () => {
    const scanEnv = fakeInstalled({
      exec: async (): Promise<ExecResult> => ({
        code: 0,
        stdout: 'not json{{{',
        stderr: '',
        timedOut: false,
      }),
    });
    const r = await verifyMuse(scanEnv, {
      path: join(FIXTURES, 'muse-warn'),
      modes: ['static'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const mode = r.value.modes[0];
    expect(mode?.status).toBe('error');
    expect(mode?.skipReason).toBe('exec-error');
    expect(mode?.verdict).toBeNull();
  });

  test('detect finds nothing -> available false, not-installed, modes []', async () => {
    const scanEnv = runtimePorts(scanEnvFixture());
    const r = await verifyMuse(scanEnv, {
      path: join(FIXTURES, 'dummytest'),
      modes: ['static'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      tool: 'muse',
      available: false,
      toolVersion: null,
      versionDrift: false,
      skipReason: 'not-installed',
      verdict: 'inconclusive',
      modes: [],
    });
  });

  test('version drift: 1.4.0 differs from verified 1.3.0 -> versionDrift true + info finding appended', async () => {
    const scanEnv = fakeInstalled({
      runVersion: async () => 'Muse Code 1.4.0 (1.4.0-R9999.1)',
      exec: async (): Promise<ExecResult> => ({
        code: 0,
        stdout: VALID_CLEAN('warn-skill'),
        stderr: '',
        timedOut: false,
      }),
    });
    const r = await verifyMuse(scanEnv, {
      path: join(FIXTURES, 'muse-warn'),
      modes: ['static'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.toolVersion).toBe('1.4.0');
    expect(r.value.versionDrift).toBe(true);
    expect(r.value.modes[0]?.findings).toEqual([
      {
        checkId: 'muse.version-drift',
        toolSeverity: null,
        normalizedSeverity: 'info',
        message: 'muse 1.4.0 differs from verified 1.3.0; parsing may be less reliable',
        file: null,
        subject: 'plugin',
      },
    ]);
  });
});
