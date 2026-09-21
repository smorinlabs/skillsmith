import { describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type {
  CommandExitClass,
  ModeResult,
  ToolAdapter,
  ToolVerdict,
  ToolVerifier,
  VerifyReport,
  VerifyTool,
} from '@skillsmith/core';
import * as core from '@skillsmith/core';
import { readOnlyFixtureAdapter } from '../../../../tests/ergonomics/fixtures/p1-ts09/read-only-adapter.ts';
import { writeFixtureAdapter } from '../../../../tests/ergonomics/fixtures/p1-ts09/write-adapter.ts';
import { verifyClaudeCode } from '../../../core/src/agents/claude-code/verify.ts';
import { verifyCodex } from '../../../core/src/agents/codex/verify.ts';
import { genericError } from '../../../core/src/errors.ts';
import { defaultRuntimePorts } from '../../../core/src/ports/default.ts';
import { err, ok } from '../../../core/src/result.ts';
import { modeVerdictFor } from '../../../core/src/verify/normalize.ts';
import { resolveTarget, runVerify } from '../../../core/src/verify/run.ts';
import { VERIFY_TOOLS } from '../../../core/src/verify/types.ts';
import { hermeticGitEnv } from '../../../core/tests/fixtures/git-env.ts';
import { verifyExitCode } from '../../src/commands/verify.ts';
import { renderVerifyHuman } from '../../src/output/verify-human.ts';
import * as verifyJson from '../../src/output/verify-json.ts';
import { exitCodeForClass } from '../../src/runtime/adapter.ts';
import { CLI_ENTRYPOINT } from '../fixtures/cli.ts';
import { createDetectionIsolation } from '../fixtures/detection.ts';

const FIXTURES = join(import.meta.dir, '..', '..', '..', 'core', 'tests', 'fixtures', 'verify');
const PLUGIN = join(FIXTURES, 'dummytest');

const mode = (overrides: Partial<ModeResult> = {}): ModeResult => ({
  mode: 'static',
  status: 'ran',
  skipReason: null,
  coverage: { manifest: true, skills: true },
  verdict: 'pass',
  command: 'fixture verify',
  findings: [],
  ...overrides,
});

const TOOL_VERSIONS: Record<VerifyTool, string> = {
  'claude-code': '2.1.202',
  codex: '0.142.5',
  muse: '1.3.0',
};

const tool = (id: VerifyTool, overrides: Partial<ToolVerdict> = {}): ToolVerdict => ({
  tool: id,
  available: true,
  toolVersion: TOOL_VERSIONS[id],
  versionDrift: false,
  skipReason: null,
  verdict: 'pass',
  modes: [mode()],
  ...overrides,
});

const report = (overrides: Partial<VerifyReport> = {}): VerifyReport => ({
  schemaVersion: 1,
  target: { path: '/tmp/fixture-plugin', kind: 'plugin' },
  requested: {
    tools: ['claude-code', 'codex'],
    modes: ['static'],
    strict: false,
    explicitTools: false,
  },
  verifiedAgainst: { 'claude-code': '2.1.202', codex: '0.142.5', muse: '1.3.0' },
  summary: {
    verdict: 'pass',
    verified: ['claude-code', 'codex'],
    failed: [],
    skipped: [],
    counts: { error: 0, warning: 0, info: 0 },
  },
  tools: [tool('claude-code'), tool('codex')],
  ...overrides,
});

const checker =
  (id: VerifyTool): ToolVerifier =>
  async (_env, options) =>
    ok(
      tool(id, {
        modes: options.modes.map((verifyMode) => mode({ mode: verifyMode })),
      }),
    );

const checkers = {
  'claude-code': checker('claude-code'),
  codex: checker('codex'),
  muse: checker('muse'),
};

const absentChecker =
  (id: VerifyTool): ToolVerifier =>
  async () =>
    ok({
      tool: id,
      available: false,
      toolVersion: null,
      versionDrift: false,
      skipReason: 'not-installed',
      verdict: 'inconclusive',
      modes: [],
    });

const staticOnlyChecker =
  (id: VerifyTool): ToolVerifier =>
  async () =>
    ok(tool(id, { modes: [mode()] }));

const fixtureRegistry = core.createToolRegistry([writeFixtureAdapter]);
const mixedFixtureRegistry = core.createToolRegistry([readOnlyFixtureAdapter, writeFixtureAdapter]);
type VerifyRegistry = typeof fixtureRegistry;

const makeFixtureTarget = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'skillsmith-p1-ts09-verify-'));
  await mkdir(join(root, '.fixture-plugin'));
  await writeFile(join(root, '.fixture-plugin', 'plugin.json'), '{"name":"fixture"}\n');
  return root;
};

const versionPorts = async (binaryName: 'claude' | 'codex', version: string, installed = true) => {
  const base = await defaultRuntimePorts();
  const binary = join('/fixture-bin', binaryName);
  return {
    ...base,
    homeDir: '/fixture-home',
    executableSearchPath: ['/fixture-bin'],
    xdg: { config: '/fixture-config', data: '/fixture-data', cache: '/fixture-cache' },
    fileExists: async (path: string) => {
      if (basename(path) === binaryName) return installed && path === binary;
      if (path === join(PLUGIN, '.codex-plugin', 'plugin.json')) return true;
      return base.fileExists(path);
    },
    realpath: async (path: string) => path,
    runVersion: async () => version,
    readText: async (path: string) =>
      path.endsWith('.codex-plugin/plugin.json') ? '{"name":"dummytest"}' : base.readText(path),
    exec: async (_command: string, args: readonly string[]) => {
      if (args[0] === 'plugin' && args[1] === 'list') {
        return {
          code: 0,
          stdout: '{"installed":[{"name":"dummytest"}]}',
          stderr: '',
          timedOut: false,
        };
      }
      if (binaryName === 'codex' && args[0] === 'plugin' && args[1] === 'add') {
        return { code: 0, stdout: 'Added plugin', stderr: '', timedOut: false };
      }
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    },
    makeDir: async () => {},
    writeTextFile: async () => {},
    copyTree: async () => {},
    removeTree: async () => {},
  };
};

describe('EWP-CMD-VERIFY-TS01', () => {
  test('preserves plugin, bare-skill, missing, invalid, wrapper bytes, and cleanup behavior', async () => {
    const env = await defaultRuntimePorts();
    const plugin = await resolveTarget(env, PLUGIN);
    expect(plugin).toMatchObject({ ok: true, value: { path: PLUGIN, kind: 'plugin' } });

    const barePath = join(FIXTURES, 'bare-skill');
    const bare = await resolveTarget(env, barePath);
    expect(bare.ok).toBeTrue();
    if (!bare.ok) return;
    const wrapped = await env.readText(join(bare.value.path, 'skills', 'bare-skill', 'SKILL.md'));
    expect(wrapped).toBe(await env.readText(join(barePath, 'SKILL.md')));
    const wrapperPath = bare.value.path;
    await bare.value.cleanup();
    expect(await env.fileExists(wrapperPath)).toBeFalse();

    const invalid = await mkdtemp(join(tmpdir(), 'skillsmith-p1-ts09-invalid-'));
    try {
      expect(await resolveTarget(env, invalid)).toMatchObject({
        ok: false,
        error: { code: 'invalid-argument' },
      });
      expect(await resolveTarget(env, join(invalid, 'missing'))).toMatchObject({
        ok: false,
        error: { code: 'invalid-argument' },
      });
    } finally {
      await rm(invalid, { recursive: true, force: true });
    }
  });

  test('derives target manifests from an injected registered verifier', async () => {
    const env = await defaultRuntimePorts();
    const target = await makeFixtureTarget();
    try {
      const resolved = await resolveTarget(env, target, fixtureRegistry);
      expect(resolved, 'fixture-only registered manifest must resolve as a plugin').toMatchObject({
        ok: true,
        value: { path: target, kind: 'plugin' },
      });
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  test('keeps injected target recognition isolated from production verifier manifests', async () => {
    const env = await defaultRuntimePorts();
    const target = await mkdtemp(join(tmpdir(), 'skillsmith-p1-ts09-production-only-'));
    await mkdir(join(target, '.claude-plugin'));
    await mkdir(join(target, '.codex-plugin'));
    await writeFile(join(target, '.claude-plugin', 'plugin.json'), '{"name":"claude-only"}\n');
    await writeFile(join(target, '.codex-plugin', 'plugin.json'), '{"name":"codex-only"}\n');
    try {
      expect(
        await resolveTarget(env, target, fixtureRegistry),
        'fixture-only registry must not recognize production-only manifests',
      ).toMatchObject({ ok: false, error: { code: 'invalid-argument' } });
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  test('generates registered bare-wrapper manifests and always removes the wrapper', async () => {
    const env = await defaultRuntimePorts();
    const bare = await mkdtemp(join(tmpdir(), 'skillsmith-p1-ts09-bare-'));
    await writeFile(join(bare, 'SKILL.md'), '---\nname: fixture\ndescription: fixture\n---\n');
    let wrapper: string | undefined;
    try {
      const resolved = await resolveTarget(env, bare, fixtureRegistry);
      expect(resolved.ok).toBeTrue();
      if (!resolved.ok) return;
      wrapper = resolved.value.path;
      try {
        expect(
          await env.fileExists(join(wrapper, '.fixture-plugin', 'plugin.json')),
          'wrapper manifest derives from fixture verification bundle',
        ).toBeTrue();
        expect(
          (await env.listDir(wrapper))
            .filter((entry) => entry.startsWith('.') && entry.endsWith('-plugin'))
            .sort(),
          'wrapper contains exactly the injected registry manifest directory',
        ).toEqual(['.fixture-plugin']);
        expect(await env.fileExists(join(wrapper, '.claude-plugin', 'plugin.json'))).toBeFalse();
        expect(await env.fileExists(join(wrapper, '.codex-plugin', 'plugin.json'))).toBeFalse();
      } finally {
        await resolved.value.cleanup();
      }
      expect(await env.fileExists(wrapper)).toBeFalse();
    } finally {
      if (wrapper) await env.removeTree(wrapper).catch(() => {});
      await rm(bare, { recursive: true, force: true });
    }
  });

  test('best-effort removes a partial wrapper without masking the original wrap error', async () => {
    const base = await defaultRuntimePorts();
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-p1-ts09-partial-wrapper-'));
    const bare = join(root, 'bare');
    const cache = join(root, 'cache');
    const wrapper = join(cache, 'skillsmith', 'verify', 'partial-wrapper');
    const cleanupAttempts: string[] = [];
    await mkdir(bare);
    await writeFile(join(bare, 'SKILL.md'), '---\nname: fixture\ndescription: fixture\n---\n');
    const env = {
      ...base,
      xdg: { ...base.xdg, cache },
      nextId: () => 'partial-wrapper',
      copyTree: async () => {
        throw new Error('fixture copy failed');
      },
      removeTree: async (path: string) => {
        cleanupAttempts.push(path);
        await base.removeTree(path);
        throw new Error('fixture cleanup failed');
      },
    };
    try {
      const resolved = await resolveTarget(env, bare, fixtureRegistry);
      expect(resolved).toMatchObject({ ok: false, error: { code: 'generic' } });
      if (!resolved.ok && resolved.error.code === 'generic') {
        expect(resolved.error.message).toContain('fixture copy failed');
        expect(resolved.error.message).not.toContain('fixture cleanup failed');
      }
      expect(cleanupAttempts).toEqual([wrapper]);
      expect(await base.fileExists(wrapper)).toBeFalse();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('runVerify finally removes a registered bare wrapper on verifier error or throw', async () => {
    const env = await defaultRuntimePorts();
    for (const behavior of ['result-error', 'throw'] as const) {
      const bare = await mkdtemp(join(tmpdir(), `skillsmith-p1-ts09-finally-${behavior}-`));
      await writeFile(join(bare, 'SKILL.md'), '---\nname: fixture\ndescription: fixture\n---\n');
      let wrapper: string | undefined;
      const failingAdapter = {
        ...writeFixtureAdapter,
        verification: {
          ...writeFixtureAdapter.verification,
          verify: async (_ports, options) => {
            wrapper = options.path;
            if (behavior === 'throw') throw new Error('fixture verifier threw');
            return err(genericError('fixture verifier returned an error'));
          },
        },
      } satisfies ToolAdapter<'fixture-write'>;
      const failingRegistry = core.createToolRegistry([failingAdapter]);
      let result: { ok: boolean } | undefined;
      let thrown: unknown;
      try {
        result = await runVerify(env, { path: bare, tools: ['fixture-write'] }, failingRegistry);
      } catch (error) {
        thrown = error;
      } finally {
        await rm(bare, { recursive: true, force: true });
      }
      expect(wrapper, 'registered failing verifier must receive the wrapper path').toBeDefined();
      if (wrapper) expect(await env.fileExists(wrapper)).toBeFalse();
      if (behavior === 'result-error') {
        expect(thrown).toBeUndefined();
        expect(result).toMatchObject({ ok: false });
      } else {
        expect(thrown).toBeInstanceOf(Error);
      }
    }
  });
});

describe('EWP-CMD-VERIFY-TS02', () => {
  test('preserves auto/explicit selection, absence policy, and static-plus-deep ordering', async () => {
    const env = await defaultRuntimePorts();
    const deep = await runVerify(env, { path: PLUGIN, deep: true }, checkers);
    expect(deep.ok).toBeTrue();
    if (!deep.ok) return;
    expect(deep.value.requested).toMatchObject({
      tools: ['claude-code', 'codex', 'muse'],
      modes: ['static', 'deep'],
      explicitTools: false,
    });
    expect(deep.value.tools.map((entry) => entry.modes.map((entryMode) => entryMode.mode))).toEqual(
      [
        ['static', 'deep'],
        ['static', 'deep'],
        ['static', 'deep'],
      ],
    );

    const explicit = await runVerify(env, { path: PLUGIN, tools: ['codex'] }, checkers);
    expect(explicit).toMatchObject({
      ok: true,
      value: { requested: { tools: ['codex'], explicitTools: true } },
    });

    const autoAbsent = await runVerify(
      env,
      { path: PLUGIN },
      {
        'claude-code': checker('claude-code'),
        codex: absentChecker('codex'),
        muse: checker('muse'),
      },
    );
    expect(autoAbsent.ok).toBeTrue();
    if (autoAbsent.ok) expect(verifyExitCode(autoAbsent.value)).toBe(0);

    const explicitAbsent = await runVerify(
      env,
      { path: PLUGIN, tools: ['codex'] },
      {
        'claude-code': checker('claude-code'),
        codex: absentChecker('codex'),
        muse: checker('muse'),
      },
    );
    expect(explicitAbsent.ok).toBeTrue();
    if (explicitAbsent.ok) expect(verifyExitCode(explicitAbsent.value)).toBe(4);

    const noneRan = await runVerify(
      env,
      { path: PLUGIN },
      {
        'claude-code': absentChecker('claude-code'),
        codex: absentChecker('codex'),
        muse: absentChecker('muse'),
      },
    );
    expect(noneRan.ok).toBeTrue();
    if (noneRan.ok) expect(verifyExitCode(noneRan.value)).toBe(4);

    const deepGap = await runVerify(
      env,
      { path: PLUGIN, deep: true },
      {
        'claude-code': staticOnlyChecker('claude-code'),
        codex: staticOnlyChecker('codex'),
        muse: staticOnlyChecker('muse'),
      },
    );
    expect(deepGap.ok).toBeTrue();
    if (deepGap.ok) expect(verifyExitCode(deepGap.value)).toBe(4);
  });

  test('dispatches a registered fixture verifier and treats read-only tools as capability gaps', async () => {
    const env = await defaultRuntimePorts();
    const target = await makeFixtureTarget();
    let thrown: unknown;
    let result: Awaited<ReturnType<typeof runVerify<'fixture-write'>>> | undefined;
    try {
      result = await runVerify(
        env,
        { path: target, tools: ['fixture-write'], deep: true },
        fixtureRegistry,
      );
    } catch (error) {
      thrown = error;
    } finally {
      await rm(target, { recursive: true, force: true });
    }
    expect(thrown, 'runVerify must dispatch through the injected registry').toBeUndefined();
    expect(result).toMatchObject({
      ok: true,
      value: {
        requested: { tools: ['fixture-write'], modes: ['static', 'deep'] },
        verifiedAgainst: { 'fixture-write': '1.0.0' },
      },
    });

    const verifyPolicy = {
      requiresSelection: false,
      allowBoundedDefault: true,
      allowAbsentCreate: false,
      allowedTools: VERIFY_TOOLS,
      allowedScopes: ['user', 'project', 'system', 'managed'],
      allowedCapabilities: ['read'],
    } as const;
    expect(
      core.validateSelectionRequest(
        { targets: [], all: false, tools: ['kilo-code'] },
        verifyPolicy,
      ),
    ).toMatchObject({ ok: false, error: { code: 'capability', exitCode: 4 } });
    expect(
      core.validateSelectionRequest({ targets: [], all: false, tools: ['unknown'] }, verifyPolicy),
    ).toMatchObject({ ok: false, error: { code: 'invalid-enum', exitCode: 2 } });
  });

  test('auto-selects only verification-capable IDs from a mixed custom registry', async () => {
    const env = await defaultRuntimePorts();
    const target = await makeFixtureTarget();
    try {
      const result = await runVerify(env, { path: target }, mixedFixtureRegistry);
      expect(result).toMatchObject({
        ok: true,
        value: {
          requested: { tools: ['fixture-write'] },
          verifiedAgainst: { 'fixture-write': '1.0.0' },
          tools: [{ tool: 'fixture-write' }],
        },
      });
      if (result.ok) {
        expect('fixture-read' in result.value.verifiedAgainst).toBeFalse();
      }
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });
});

describe('EWP-CMD-VERIFY-TS03', () => {
  test('preserves strict severity and the shared 0/1/2/4/130 exit taxonomy', () => {
    expect(
      modeVerdictFor(
        [
          {
            checkId: 'fixture.warning',
            toolSeverity: 'warning',
            normalizedSeverity: 'warning',
            message: 'warning',
            file: null,
            subject: 'plugin',
          },
        ],
        true,
      ),
    ).toBe('fail');
    const failing = report({
      summary: {
        verdict: 'fail',
        verified: [],
        failed: ['claude-code'],
        skipped: ['codex'],
        counts: { error: 1, warning: 0, info: 0 },
      },
      tools: [
        tool('claude-code', { verdict: 'fail', modes: [mode({ verdict: 'fail' })] }),
        tool('codex', {
          available: false,
          toolVersion: null,
          skipReason: 'not-installed',
          verdict: 'inconclusive',
          modes: [],
        }),
      ],
    });
    expect(verifyExitCode(failing), 'failure 1 outranks capability gap 4').toBe(1);
    const classes: CommandExitClass[] = ['success', 'failure', 'usage', 'capability', 'cancelled'];
    expect(classes.map(exitCodeForClass)).toEqual([0, 1, 2, 4, 130]);
  });

  test('cancels an in-flight verifier through the shared signal path with exit 130', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-p1-ts09-cancel-'));
    const bin = join(root, 'bin');
    const plugin = join(root, 'plugin');
    await mkdir(bin);
    await mkdir(join(plugin, '.claude-plugin'), { recursive: true });
    await writeFile(join(plugin, '.claude-plugin', 'plugin.json'), '{"name":"cancel"}\n');
    const claude = join(bin, 'claude');
    const marker = join(root, 'verifier-started');
    await writeFile(
      claude,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.202"; exit 0; fi\n: > "$SKILLSMITH_TEST_MARKER"\nwhile :; do :; done\n',
    );
    await chmod(claude, 0o755);
    try {
      const isolation = await createDetectionIsolation(root, {
        HOME: root,
        PATH: `${bin}:/bin:/usr/bin`,
      });
      const child = Bun.spawn(
        [
          process.execPath,
          '--preload',
          isolation.preload,
          CLI_ENTRYPOINT,
          'verify',
          plugin,
          '--tool',
          'claude-code',
          '--json',
        ],
        {
          env: hermeticGitEnv({
            HOME: root,
            PATH: `${bin}:/bin:/usr/bin`,
            SKILLSMITH_TEST_MARKER: marker,
            NO_COLOR: '1',
            CI: '1',
          }),
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      for (let attempt = 0; attempt < 1_000 && !(await Bun.file(marker).exists()); attempt++) {
        await Bun.sleep(10);
      }
      expect(await Bun.file(marker).exists()).toBeTrue();
      child.kill('SIGINT');
      const exit = await child.exited;
      expect(exit).toBe(130);
      expect(JSON.parse(await new Response(child.stdout).text())).toEqual({
        schemaVersion: 1,
        kind: 'error',
        code: 'cancelled',
        message: 'verification was cancelled',
        exitCode: 130,
      });
      expect(await new Response(child.stderr).text()).toBe('');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('uses one exported core verify-exit policy owner from application through CLI', async () => {
    const planned = core as typeof core & {
      verifyExitClass?: (value: VerifyReport) => CommandExitClass;
    };
    expect(typeof planned.verifyExitClass, 'core verifyExitClass must own report policy').toBe(
      'function',
    );
    if (!planned.verifyExitClass) return;
    for (const value of [report(), report({ summary: { ...report().summary, verdict: 'fail' } })]) {
      const legacy = verifyExitCode(value);
      const shared = exitCodeForClass(planned.verifyExitClass(value));
      expect([legacy, shared]).toEqual([legacy, legacy]);
    }
    const source = await Bun.file(
      join(import.meta.dir, '..', '..', 'src', 'commands', 'verify.ts'),
    ).text();
    expect(source).toContain('verifyExitClass');
    expect(source).not.toMatch(/summary\.verdict|requested\.modes|mode\.status/);
  });
});

describe('EWP-CMD-VERIFY-TS04', () => {
  test('executes exact, drift, unknown, and not-installed versions through both real verifiers', async () => {
    for (const fixture of [
      {
        name: 'claude' as const,
        exact: '2.1.202',
        drift: '2.1.203',
        verify: verifyClaudeCode,
      },
      { name: 'codex' as const, exact: '0.142.5', drift: '0.142.6', verify: verifyCodex },
    ]) {
      const exact = await fixture.verify(await versionPorts(fixture.name, fixture.exact), {
        path: PLUGIN,
        modes: ['static'],
        strict: false,
      });
      const drift = await fixture.verify(await versionPorts(fixture.name, fixture.drift), {
        path: PLUGIN,
        modes: ['static'],
        strict: true,
      });
      const unknown = await fixture.verify(await versionPorts(fixture.name, 'development-build'), {
        path: PLUGIN,
        modes: ['static'],
        strict: true,
      });
      const absent = await fixture.verify(await versionPorts(fixture.name, fixture.exact, false), {
        path: PLUGIN,
        modes: ['static'],
        strict: false,
      });
      expect(exact).toMatchObject({
        ok: true,
        value: {
          available: true,
          toolVersion: fixture.exact,
          versionDrift: false,
          verdict: 'pass',
        },
      });
      expect(drift).toMatchObject({
        ok: true,
        value: {
          available: true,
          toolVersion: fixture.drift,
          versionDrift: true,
          verdict: 'pass',
        },
      });
      expect(unknown).toMatchObject({
        ok: true,
        value: { available: true, toolVersion: null, versionDrift: false, verdict: 'pass' },
      });
      expect(absent).toMatchObject({
        ok: true,
        value: {
          available: false,
          toolVersion: null,
          versionDrift: false,
          verdict: 'inconclusive',
          skipReason: 'not-installed',
        },
      });
      if (drift.ok) {
        expect(drift.value.modes.flatMap((entry) => entry.findings)).toContainEqual(
          expect.objectContaining({
            checkId: `${fixture.name}.version-drift`,
            normalizedSeverity: 'info',
          }),
        );
      }
    }
  });

  test('preserves human/JSON parity, exact v1 framing, global -C, and version drift facts', async () => {
    const value = report({
      tools: [tool('claude-code'), tool('codex', { toolVersion: '0.142.6', versionDrift: true })],
    });
    const human = renderVerifyHuman(value, 0);
    const json = JSON.parse(verifyJson.renderVerifyJson(value)) as Record<string, unknown>;
    expect(human).toContain(value.target.path);
    expect(json).toMatchObject({
      schemaVersion: 1,
      kind: 'skillsmith.verify',
      target: value.target,
      verifiedAgainst: value.verifiedAgainst,
    });
    expect(value.tools[0]).toMatchObject({ toolVersion: '2.1.202', versionDrift: false });
    expect(value.tools[1]).toMatchObject({
      toolVersion: '0.142.6',
      versionDrift: true,
      verdict: 'pass',
    });
    const versionMatrix = report({
      requested: {
        tools: ['claude-code', 'codex'],
        modes: ['static'],
        strict: false,
        explicitTools: false,
      },
      tools: [
        tool('claude-code', { toolVersion: null, versionDrift: false }),
        tool('codex', {
          available: false,
          toolVersion: null,
          versionDrift: false,
          skipReason: 'not-installed',
          verdict: 'inconclusive',
          modes: [],
        }),
      ],
    });
    const versionJson = JSON.parse(verifyJson.renderVerifyJson(versionMatrix)) as {
      tools: ToolVerdict[];
    };
    expect(versionJson.tools[0]).toMatchObject({
      available: true,
      toolVersion: null,
      versionDrift: false,
    });
    expect(versionJson.tools[1]).toMatchObject({
      available: false,
      toolVersion: null,
      skipReason: 'not-installed',
    });
    expect(renderVerifyHuman(versionMatrix, 0)).toContain('codex  not installed (skipped)');

    const golden = (await Bun.file(
      join(import.meta.dir, '..', 'fixtures', 'verify-report.golden.json'),
    ).json()) as Record<string, unknown>;
    const { kind: _kind, ...goldenReport } = golden;
    expect(
      JSON.parse(verifyJson.renderVerifyJson(goldenReport as unknown as VerifyReport)),
    ).toEqual(golden);

    const cwd = await mkdtemp(join(tmpdir(), 'skillsmith-p1-ts09-cwd-'));
    try {
      await mkdir(join(cwd, 'skill'));
      await writeFile(join(cwd, 'skill', 'SKILL.md'), '---\nname: skill\ndescription: test\n---\n');
      const isolation = await createDetectionIsolation(cwd, { HOME: cwd, PATH: '' });
      const child = Bun.spawn(
        [
          process.execPath,
          '--preload',
          isolation.preload,
          CLI_ENTRYPOINT,
          '-C',
          cwd,
          'verify',
          'skill',
          '--json',
        ],
        {
          // Detection also checks per-user well-known directories, independently of PATH.
          env: hermeticGitEnv({
            HOME: cwd,
            XDG_CONFIG_HOME: join(cwd, 'config'),
            XDG_DATA_HOME: join(cwd, 'data'),
            XDG_CACHE_HOME: join(cwd, 'cache'),
            CODEX_HOME: join(cwd, '.codex'),
            CLAUDE_CONFIG_DIR: join(cwd, '.claude'),
            PATH: '',
            NO_COLOR: '1',
            CI: '1',
          }),
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      expect(await child.exited).toBe(4);
      const output = JSON.parse(await new Response(child.stdout).text()) as {
        target: { path: string };
      };
      expect(output.target.path).toBe(join(cwd, 'skill'));
      expect(await new Response(child.stderr).text()).toBe('');
      const blocked = await readFile(isolation.trace, 'utf8');
      expect(blocked).toContain('/opt/homebrew/bin/codex');
      expect(blocked).toContain('/usr/local/bin/codex');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('derives checked versions and JSON tool choices from an injected registry', () => {
    const planned = verifyJson as typeof verifyJson & {
      createVerifyJsonSchema?: (registry: VerifyRegistry) => {
        parse(value: unknown): unknown;
      };
    };
    expect(
      typeof planned.createVerifyJsonSchema,
      'registry-derived verify JSON schema factory',
    ).toBe('function');
    if (!planned.createVerifyJsonSchema) return;
    const schema = planned.createVerifyJsonSchema(fixtureRegistry);
    const fixtureReport = {
      ...JSON.parse(verifyJson.renderVerifyJson(report())),
      requested: {
        tools: ['fixture-write'],
        modes: ['static', 'deep'],
        strict: false,
        explicitTools: true,
      },
      verifiedAgainst: { 'fixture-write': '1.0.0' },
      summary: {
        verdict: 'pass',
        verified: ['fixture-write'],
        failed: [],
        skipped: [],
        counts: { error: 0, warning: 0, info: 0 },
      },
      tools: [
        {
          ...tool('claude-code'),
          tool: 'fixture-write',
          toolVersion: '1.0.0',
          modes: [mode(), mode({ mode: 'deep' })],
        },
      ],
    };
    expect(() => schema.parse(fixtureReport)).not.toThrow();
    expect(() =>
      schema.parse({
        ...fixtureReport,
        requested: { ...fixtureReport.requested, tools: ['ghost'] },
      }),
    ).toThrow();
  });
});
