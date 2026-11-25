import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseAntigravityValidateOutput,
  verifyAntigravity,
} from '../../../src/agents/antigravity/verify.ts';
import type { ExecResult, ScanEnv } from '../../../src/env/types.ts';
import type { VerifyPorts } from '../../../src/verify/types.ts';
import { runtimePorts } from '../../fixtures/runtime-ports.ts';

const FIXTURES = join(import.meta.dir, '..', '..', 'fixtures', 'verify');
const PINNED_VERSION = '1.5.16';

const VALIDATE_DOC = (findings: unknown[] = [], skills = 1): string =>
  JSON.stringify({
    dir: '/tmp/plugin',
    manifest: '.antigravity-plugin/plugin.json',
    name: 'fixture',
    agentPluginsSpec: false,
    components: { agents: 0, hooks: 0, mcpServers: 0, rules: 0, sidecars: 0, skills },
    findings,
  });

const NO_LOGO_NOTE = {
  severity: 'note',
  file: '.antigravity-plugin/plugin.json',
  message: 'no logo: the plugin shows a generic icon.',
};

const fileExistsFake = (p: string): boolean => {
  if (p === '/fake/agy') return true;
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
  exec: async () => ({ code: 0, stdout: VALIDATE_DOC(), stderr: '', timedOut: false }),
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

const fakeInstalled = (overrides: Partial<ScanEnv> = {}): VerifyPorts => {
  const base = runtimePorts({
    ...scanEnvFixture(),
    path: ['/fake'],
    runVersion: async () => PINNED_VERSION,
    ...overrides,
  });
  return {
    ...base,
    ...(overrides.removeTree
      ? {
          removeTree: async (p) => {
            await overrides.removeTree?.(p);
            await base.removeTree(p);
          },
        }
      : {}),
  };
};

describe('parseAntigravityValidateOutput', () => {
  test('maps error, warning, and note findings for native plugins', () => {
    const parsed = parseAntigravityValidateOutput(
      VALIDATE_DOC([
        {
          severity: 'error',
          file: 'skills/bad-yaml/SKILL.md',
          message: "the frontmatter isn't valid YAML: unexpected EOF",
        },
        {
          severity: 'warning',
          file: 'skills/bad-nodesc/SKILL.md',
          message: 'no description: the model uses it to decide when to load the skill',
        },
        NO_LOGO_NOTE,
      ]),
    );
    expect(parsed).toEqual({
      findings: [
        {
          checkId: 'antigravity.frontmatter',
          toolSeverity: 'error',
          normalizedSeverity: 'error',
          message: "the frontmatter isn't valid YAML: unexpected EOF",
          file: 'skills/bad-yaml/SKILL.md',
          subject: 'skill',
          raw: JSON.stringify({
            severity: 'error',
            file: 'skills/bad-yaml/SKILL.md',
            message: "the frontmatter isn't valid YAML: unexpected EOF",
          }),
        },
        {
          checkId: 'antigravity.description',
          toolSeverity: 'warning',
          normalizedSeverity: 'warning',
          message: 'no description: the model uses it to decide when to load the skill',
          file: 'skills/bad-nodesc/SKILL.md',
          subject: 'skill',
          raw: JSON.stringify({
            severity: 'warning',
            file: 'skills/bad-nodesc/SKILL.md',
            message: 'no description: the model uses it to decide when to load the skill',
          }),
        },
        {
          checkId: 'antigravity.manifest',
          toolSeverity: 'note',
          normalizedSeverity: 'info',
          message: 'no logo: the plugin shows a generic icon.',
          file: '.antigravity-plugin/plugin.json',
          subject: 'manifest',
          raw: JSON.stringify(NO_LOGO_NOTE),
        },
      ],
    });
  });

  test('filters synthetic manifest notes and collapses bare-skill file paths', () => {
    const parsed = parseAntigravityValidateOutput(
      VALIDATE_DOC([
        {
          severity: 'warning',
          file: 'skills/warn-skill/SKILL.md',
          message: 'name "other" doesn\'t match its folder "warn-skill"',
        },
        NO_LOGO_NOTE,
      ]),
      { kind: 'skill', syntheticManifest: true },
    );
    if ('execError' in parsed) throw new Error('expected findings');
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]).toMatchObject({
      checkId: 'antigravity.name-mismatch',
      normalizedSeverity: 'warning',
      file: 'SKILL.md',
      subject: 'skill',
    });
  });

  test('rejects malformed or non-object JSON as execError', () => {
    expect(parseAntigravityValidateOutput('not json')).toEqual({ execError: true });
    expect(parseAntigravityValidateOutput('[]')).toEqual({ execError: true });
    expect(parseAntigravityValidateOutput('{"findings":"bad"}')).toEqual({ execError: true });
  });
});

describe('verifyAntigravity static mode', () => {
  test('returns inconclusive / not-installed when agy is absent', async () => {
    const env = runtimePorts({ ...scanEnvFixture(), fileExists: async () => false });
    const r = await verifyAntigravity(env, {
      path: join(FIXTURES, 'dummytest'),
      modes: ['static'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      tool: 'antigravity',
      available: false,
      toolVersion: null,
      versionDrift: false,
      skipReason: 'not-installed',
      verdict: 'inconclusive',
      modes: [],
    });
  });

  test('wraps non-Antigravity plugin skills into an ephemeral wrapper and cleans up', async () => {
    let execArgs: readonly string[] = [];
    const removed: string[] = [];
    const env = fakeInstalled({
      exec: async (_bin, args): Promise<ExecResult> => {
        execArgs = args;
        return {
          code: 0,
          stdout: VALIDATE_DOC([NO_LOGO_NOTE], 4),
          stderr: '',
          timedOut: false,
        };
      },
      removeTree: async (p) => {
        removed.push(p);
      },
    });
    const r = await verifyAntigravity(env, {
      path: join(FIXTURES, 'dummytest'),
      modes: ['static'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(execArgs.slice(0, 3)).toEqual(['plugin', 'validate', '--json']);
    expect(execArgs[3]).toContain('agy-wrapper');
    expect(r.value.verdict).toBe('pass');
    expect(r.value.modes[0]?.coverage).toEqual({ manifest: false, skills: true });
    expect(r.value.modes[0]?.findings).toEqual([]);
    expect(removed).toHaveLength(2);
  });

  test('skips cleanly when neither Antigravity manifest nor skills exist', async () => {
    let execCalled = false;
    const env = fakeInstalled({
      exec: async () => {
        execCalled = true;
        return { code: 0, stdout: '', stderr: '', timedOut: false };
      },
    });
    const r = await verifyAntigravity(env, {
      path: join(FIXTURES, 'codex-badplug'),
      modes: ['static'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(execCalled).toBe(false);
    expect(r.value.verdict).toBe('pass');
    expect(r.value.modes[0]?.findings[0]?.checkId).toBe('antigravity.no-manifest');
  });

  test('strict escalates warnings to fail and passes --strict to agy', async () => {
    let execArgs: readonly string[] = [];
    const env = fakeInstalled({
      exec: async (_bin, args) => {
        execArgs = args;
        return {
          code: 1,
          stdout: VALIDATE_DOC([
            {
              severity: 'warning',
              file: 'skills/warn-skill/SKILL.md',
              message: 'name "mismatched-name" doesn\'t match its folder "warn-skill"',
            },
          ]),
          stderr: '',
          timedOut: false,
        };
      },
    });
    const r = await verifyAntigravity(env, {
      path: join(FIXTURES, 'antigravity-warn'),
      modes: ['static'],
      strict: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(execArgs).toContain('--strict');
    expect(r.value.verdict).toBe('fail');
  });

  test('reports timeout and exec-error cleanly and flags version drift', async () => {
    const timedOutEnv = fakeInstalled({
      runVersion: async () => '9.9.9',
      exec: async () => ({ code: -1, stdout: '', stderr: '', timedOut: true }),
    });
    const r1 = await verifyAntigravity(timedOutEnv, {
      path: join(FIXTURES, 'dummytest'),
      modes: ['static'],
      strict: false,
    });
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.value.versionDrift).toBe(true);
      expect(r1.value.modes[0]?.skipReason).toBe('timeout');
    }

    const crashEnv = fakeInstalled({
      runVersion: async () => '9.9.9',
      exec: async () => ({ code: 2, stdout: VALIDATE_DOC(), stderr: 'boom', timedOut: false }),
    });
    const r2 = await verifyAntigravity(crashEnv, {
      path: join(FIXTURES, 'dummytest'),
      modes: ['static'],
      strict: false,
    });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value.modes[0]?.skipReason).toBe('exec-error');
  });
});
