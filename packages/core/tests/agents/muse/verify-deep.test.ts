import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { analyzeMuseList, verifyMuse } from '../../../src/agents/muse/verify.ts';
import type { ExecResult, ScanEnv } from '../../../src/env/types.ts';
import type { VerifyPorts } from '../../../src/verify/types.ts';
import { runtimePorts } from '../../fixtures/runtime-ports.ts';

const FIXTURES = join(import.meta.dir, '..', '..', 'fixtures', 'verify');
const PINNED_VERSION = 'Muse Code 1.3.0 (1.3.0-R3401.1)';
const HOME = '/tmp/ux';
const CONFIG = `${HOME}/.config/muse`;

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

const userEntry = (
  name: string,
  activation = 'on',
  id: string = name,
): Record<string, unknown> => ({
  id,
  name,
  display_name: name,
  description: `${name} desc`,
  short_description: `${name} desc`,
  scope: 'user',
  source: { type: 'user' },
  path: `$CONFIG_DIR/skills/${name}/SKILL.md`,
  activation,
  diagnostics: [],
  provenance: null,
  context_cost: { estimated_tokens: 10 },
});

const projectEntry = (
  name: string,
  activation = 'on',
  id: string = name,
): Record<string, unknown> => ({
  ...userEntry(name, activation, id),
  scope: 'project',
  path: `.agents/skills/${name}/SKILL.md`,
});

const expected = (names: string[], kind: 'plugin' | 'skill' = 'plugin') =>
  names.map((name) => ({
    doc: `${CONFIG}/skills/${name}/SKILL.md`,
    rel: `.agents/skills/${name}/SKILL.md`,
    file: kind === 'skill' ? 'SKILL.md' : `skills/${name}/SKILL.md`,
  }));

const LOADER = { scope: 'user' as const, home: HOME, privatePaths: [HOME] as const };

describe('analyzeMuseList', () => {
  test('user happy path: $VAR docs match, on counts enabled', () => {
    const doc = JSON.stringify({ skills: [userEntry('a'), userEntry('b')], diagnostics: [] });
    expect(analyzeMuseList(doc, expected(['a', 'b']), LOADER)).toEqual({
      findings: [],
      complete: true,
    });
  });

  test('user-invocable-only counts enabled; off yields a disabled warning', () => {
    const doc = JSON.stringify({
      skills: [userEntry('a', 'user-invocable-only'), userEntry('b', 'off')],
      diagnostics: [],
    });
    const analyzed = analyzeMuseList(doc, expected(['a', 'b']), LOADER);
    if ('error' in analyzed) throw new Error('expected analysis');
    expect(analyzed.complete).toBe(false);
    expect(analyzed.findings).toEqual([
      {
        checkId: 'muse.skill-presence',
        toolSeverity: null,
        normalizedSeverity: 'warning',
        message: 'expected skill was returned disabled',
        file: 'skills/b/SKILL.md',
        subject: 'skill',
      },
    ]);
  });

  test('missing and duplicate entries yield presence warnings', () => {
    const doc = JSON.stringify({ skills: [userEntry('a'), userEntry('a')], diagnostics: [] });
    const analyzed = analyzeMuseList(doc, expected(['a', 'ghost']), LOADER);
    if ('error' in analyzed) throw new Error('expected analysis');
    expect(analyzed.complete).toBe(false);
    expect(analyzed.findings.map((f) => f.message)).toEqual([
      'loader returned ambiguous target entries',
      'expected skill was not returned by the loader',
    ]);
  });

  test('diagnostics join by (scope, document); temp paths redacted', () => {
    const diagnostic = {
      code: 'invalid-skill-package',
      message: `skill file at ${HOME}/x is malformed: boom`,
      scope: 'user',
      path: '$CONFIG_DIR/skills/a/SKILL.md',
    };
    const doc = JSON.stringify({ skills: [], diagnostics: [diagnostic] });
    const analyzed = analyzeMuseList(doc, expected(['a']), LOADER);
    if ('error' in analyzed) throw new Error('expected analysis');
    expect(analyzed.findings).toEqual([
      {
        checkId: 'muse.invalid-skill-package',
        toolSeverity: 'invalid-skill-package',
        normalizedSeverity: 'error',
        message: 'skill file at <tmp>/x is malformed: boom',
        file: 'skills/a/SKILL.md',
        subject: 'skill',
        raw: JSON.stringify(diagnostic).replaceAll(HOME, '<tmp>'),
      },
    ]);
  });

  test('shared frontmatter id across documents: valid lists, broken diagnoses', () => {
    const doc = JSON.stringify({
      skills: [userEntry('a', 'on', 'same')],
      diagnostics: [
        {
          code: 'invalid-skill-package',
          message: 'malformed',
          scope: 'user',
          path: '$CONFIG_DIR/skills/b/SKILL.md',
        },
      ],
    });
    const analyzed = analyzeMuseList(doc, expected(['a', 'b']), LOADER);
    if ('error' in analyzed) throw new Error('expected analysis');
    expect(analyzed.findings).toHaveLength(1);
    expect(analyzed.findings[0]).toMatchObject({
      checkId: 'muse.invalid-skill-package',
      file: 'skills/b/SKILL.md',
    });
  });

  test('cross-scope diagnostics and entries are ignored', () => {
    const doc = JSON.stringify({
      skills: [projectEntry('a')],
      diagnostics: [
        {
          code: 'invalid-skill-package',
          message: 'elsewhere',
          scope: 'project',
          path: '.agents/skills/a/SKILL.md',
        },
      ],
    });
    const analyzed = analyzeMuseList(doc, expected(['a']), LOADER);
    if ('error' in analyzed) throw new Error('expected analysis');
    expect(analyzed.complete).toBe(false);
    expect(analyzed.findings.map((f) => f.message)).toEqual([
      'expected skill was not returned by the loader',
    ]);
  });

  test('project scope matches workspace-relative documents', () => {
    const doc = JSON.stringify({ skills: [projectEntry('a')], diagnostics: [] });
    const analyzed = analyzeMuseList(doc, expected(['a']), {
      scope: 'project',
      home: HOME,
      privatePaths: [HOME],
    });
    expect(analyzed).toEqual({ findings: [], complete: true });
  });

  test('malformed documents -> error', () => {
    const targets = expected(['a']);
    expect(analyzeMuseList('nope{{{', targets, LOADER)).toEqual({
      error: 'malformed skills list JSON',
    });
    expect(analyzeMuseList('{}', targets, LOADER)).toEqual({
      error: 'missing skills list entries',
    });
    expect(analyzeMuseList(JSON.stringify({ skills: [{}] }), targets, LOADER)).toEqual({
      error: 'invalid skills list entries',
    });
    expect(
      analyzeMuseList(JSON.stringify({ skills: [], diagnostics: [{}] }), targets, LOADER),
    ).toEqual({ error: 'invalid skills list diagnostics' });
    expect(
      analyzeMuseList(
        JSON.stringify({
          skills: [],
          diagnostics: [{ code: 'project-skills-untrusted', message: 'm', path: 'p', scope: 'p' }],
        }),
        targets,
        LOADER,
      ),
    ).toEqual({ error: 'project skills reported untrusted despite --trust-workspace' });
  });
});

describe('verifyMuse deep mode', () => {
  const listsFor = (
    proj: string,
    home: string,
    names: string[],
    broken: string[] = [],
  ): { user: string; project: string } => {
    void proj;
    void home;
    const good = names.filter((name) => !broken.includes(name));
    const diagnostics = broken.map((name) => ({
      code: 'invalid-skill-package',
      message: `skill file at ${home}/x is malformed: bad ${name}`,
      scope: 'user',
      path: `$CONFIG_DIR/skills/${name}/SKILL.md`,
    }));
    return {
      user: JSON.stringify({ skills: good.map((name) => userEntry(name)), diagnostics }),
      project: JSON.stringify({
        skills: names.map((name) => projectEntry(name)),
        diagnostics: [],
      }),
    };
  };

  test('dummytest happy path: both scopes verify, staging proven, cleanup removes temp dirs', async () => {
    const calls: { args: readonly string[]; env?: Record<string, string> }[] = [];
    let stagedOk = false;
    const scanEnv = fakeInstalled({
      exec: async (_cmd, args, opts): Promise<ExecResult> => {
        calls.push({ args, ...(opts?.env !== undefined ? { env: opts.env } : {}) });
        const workspace = args[5] ?? '';
        const home = opts?.env?.HOME ?? '';
        const names = ['bad-nodesc', 'bad-noframe', 'bad-yaml', 'good-skill'];
        stagedOk =
          names.every((name) =>
            existsSync(join(workspace, '.agents', 'skills', name, 'SKILL.md')),
          ) &&
          names.every((name) =>
            existsSync(join(home, '.config', 'muse', 'skills', name, 'SKILL.md')),
          );
        const source = args[3];
        const docs = listsFor(workspace, home, names);
        return {
          code: 0,
          stdout: source === 'user' ? docs.user : docs.project,
          stderr: '',
          timedOut: false,
        };
      },
    });

    const r = await verifyMuse(scanEnv, {
      path: join(FIXTURES, 'dummytest'),
      modes: ['deep'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const mode = r.value.modes[0];
    expect(mode?.status).toBe('ran');
    expect(mode?.verdict).toBe('pass');
    expect(mode?.coverage).toEqual({ manifest: false, skills: true });
    expect(mode?.findings).toEqual([]);
    expect(mode?.command).toBe(
      'muse skills list --source user --json && muse skills list --source project --workspace <proj> --trust-workspace --json',
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toEqual(['skills', 'list', '--source', 'user', '--json']);
    expect(calls[1]?.args.slice(0, 5)).toEqual([
      'skills',
      'list',
      '--source',
      'project',
      '--workspace',
    ]);
    expect(calls[1]?.args.slice(6)).toEqual(['--trust-workspace', '--json']);
    const proj = calls[1]?.args[5] as string;
    const home = calls[0]?.env?.HOME as string;
    expect(proj).toContain('muse-project');
    expect(home).toContain('muse-home');
    for (const call of calls) {
      expect(call.env?.MUSE_NO_AUTO_UPDATE).toBe('1');
      expect(call.env?.HOME).toBe(home);
    }
    expect(stagedOk).toBe(true);
    expect(existsSync(proj)).toBe(false);
    expect(existsSync(home)).toBe(false);
  });

  test('broken staged skill -> fail with file-mapped loader error', async () => {
    const scanEnv = fakeInstalled({
      exec: async (_cmd, args, opts): Promise<ExecResult> => {
        const home = opts?.env?.HOME ?? '';
        const docs = listsFor(
          '',
          home,
          ['bad-nodesc', 'bad-noframe', 'bad-yaml', 'good-skill'],
          ['bad-yaml'],
        );
        return {
          code: 0,
          stdout: args[3] === 'user' ? docs.user : docs.project,
          stderr: '',
          timedOut: false,
        };
      },
    });
    const r = await verifyMuse(scanEnv, {
      path: join(FIXTURES, 'dummytest'),
      modes: ['deep'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const mode = r.value.modes[0];
    expect(mode?.status).toBe('ran');
    expect(mode?.verdict).toBe('fail');
    expect(mode?.coverage).toEqual({ manifest: false, skills: true });
    expect(mode?.findings).toHaveLength(1);
    expect(mode?.findings[0]).toMatchObject({
      checkId: 'muse.invalid-skill-package',
      normalizedSeverity: 'error',
      file: 'skills/bad-yaml/SKILL.md',
      subject: 'skill',
    });
    expect(mode?.findings[0]?.message).not.toContain('/tmp/');
  });

  test('omitted without diagnostic -> exec-error incomplete', async () => {
    const scanEnv = fakeInstalled({
      exec: async (): Promise<ExecResult> => ({
        code: 0,
        stdout: JSON.stringify({ skills: [], diagnostics: [] }),
        stderr: '',
        timedOut: false,
      }),
    });
    const r = await verifyMuse(scanEnv, {
      path: join(FIXTURES, 'dummytest'),
      modes: ['deep'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const mode = r.value.modes[0];
    expect(mode?.status).toBe('error');
    expect(mode?.skipReason).toBe('exec-error');
    expect(mode?.verdict).toBeNull();
    expect(mode?.findings.at(-1)?.message).toBe(
      'local loader did not verify every expected enabled target',
    );
  });

  test('malformed settings (exit 1, empty stdout) -> exec-error', async () => {
    const scanEnv = fakeInstalled({
      exec: async (): Promise<ExecResult> => ({
        code: 1,
        stdout: '',
        stderr: 'malformed settings file at <tmp>/settings.json: bad',
        timedOut: false,
      }),
    });
    const r = await verifyMuse(scanEnv, {
      path: join(FIXTURES, 'dummytest'),
      modes: ['deep'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const mode = r.value.modes[0];
    expect(mode?.status).toBe('error');
    expect(mode?.skipReason).toBe('exec-error');
  });

  test('validated rejection survives a failed leg -> ran fail, not exec-error', async () => {
    const scanEnv = fakeInstalled({
      exec: async (_cmd, args, opts): Promise<ExecResult> => {
        const home = opts?.env?.HOME ?? '';
        if (args[3] === 'user') {
          return { code: 1, stdout: 'garbage{{{', stderr: 'boom', timedOut: false };
        }
        const docs = listsFor(
          '',
          home,
          ['bad-nodesc', 'bad-noframe', 'bad-yaml', 'good-skill'],
          [],
        );
        void docs;
        return {
          code: 0,
          stdout: JSON.stringify({
            skills: [
              projectEntry('bad-nodesc'),
              projectEntry('bad-noframe'),
              projectEntry('good-skill'),
            ],
            diagnostics: [
              {
                code: 'invalid-skill-package',
                message: 'malformed: bad-yaml',
                scope: 'project',
                path: '.agents/skills/bad-yaml/SKILL.md',
              },
            ],
          }),
          stderr: '',
          timedOut: false,
        };
      },
    });
    const r = await verifyMuse(scanEnv, {
      path: join(FIXTURES, 'dummytest'),
      modes: ['deep'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const mode = r.value.modes[0];
    expect(mode?.status).toBe('ran');
    expect(mode?.verdict).toBe('fail');
    expect(mode?.findings.some((f) => f.checkId === 'muse.invalid-skill-package')).toBe(true);
    expect(mode?.findings.some((f) => f.checkId === 'muse.deep-probe')).toBe(true);
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
      path: join(FIXTURES, 'dummytest'),
      modes: ['deep'],
      strict: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const mode = r.value.modes[0];
    expect(mode?.status).toBe('error');
    expect(mode?.skipReason).toBe('timeout');
    expect(mode?.verdict).toBeNull();
  });

  test('kind skill collapses finding files to the bare SKILL.md', async () => {
    const scanEnv = fakeInstalled({
      exec: async (_cmd, args, opts): Promise<ExecResult> => {
        const home = opts?.env?.HOME ?? '';
        const docs = listsFor(
          '',
          home,
          ['bad-nodesc', 'bad-noframe', 'bad-yaml', 'good-skill'],
          ['bad-yaml'],
        );
        return {
          code: 0,
          stdout: args[3] === 'user' ? docs.user : docs.project,
          stderr: '',
          timedOut: false,
        };
      },
    });
    const r = await verifyMuse(scanEnv, {
      path: join(FIXTURES, 'dummytest'),
      modes: ['deep'],
      strict: false,
      kind: 'skill',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.modes[0]?.findings.map((f) => f.file)).toEqual(['SKILL.md']);
  });

  test('detect finds nothing -> available false, not-installed, modes []', async () => {
    const scanEnv = runtimePorts(scanEnvFixture());
    const r = await verifyMuse(scanEnv, {
      path: join(FIXTURES, 'dummytest'),
      modes: ['deep'],
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
});
