import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TOOL_OPERATIONS, VERIFIED_AGAINST, VERSION, toolRegistry } from '@skillsmith/core';
import {
  type RuntimeOutcome,
  createCliRuntimeAdapter,
} from '../../../packages/cli/src/runtime/adapter.ts';
import type { CliRuntimeIo, RenderedCommandOutput } from '../../../packages/cli/src/runtime/io.ts';
import { resolveColorMode } from '../../../packages/cli/src/util/color.ts';
import { observationFromLegacyLogger } from '../../../packages/core/src/observation/logger-compat.ts';

const ROOT = resolve(import.meta.dir, '..', '..', '..');
const ESCAPE = '\u001B';
const ANSI_SEQUENCE = new RegExp(`${ESCAPE}\\[[0-?]*[ -/]*[@-~]`, 'gu');
const CAPABILITY_START = '<!-- skillsmith-capability-matrix:start -->';
const CAPABILITY_END = '<!-- skillsmith-capability-matrix:end -->';

type PresentationPolicy = Readonly<{
  stdoutColor: 'on' | 'off';
  stderrColor: 'on' | 'off';
}>;

type PresentationModule = Readonly<{
  resolvePresentationPolicy?: (
    input: Readonly<{
      format: 'human' | 'json';
      color: 'auto' | 'always' | 'never';
      noColor: boolean;
      stdoutIsTTY: boolean;
      stderrIsTTY: boolean;
      env: Readonly<Record<string, string | undefined>>;
    }>,
  ) => PresentationPolicy;
  presentHumanOutput?: (
    output: RenderedCommandOutput,
    policy: PresentationPolicy,
    reportKind: string,
  ) => RenderedCommandOutput;
}>;

const presentationModule = async (): Promise<PresentationModule> =>
  (await import('../../../packages/cli/src/runtime/presentation.ts')) as PresentationModule;

const withoutColorEnvironment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !['NO_COLOR', 'FORCE_COLOR', 'CLICOLOR', 'CLICOLOR_FORCE', 'TERM'].includes(entry[0]),
    ),
  );

const runCli = (
  args: readonly string[],
  env: Readonly<Record<string, string>> = withoutColorEnvironment(),
) => {
  const child = Bun.spawnSync(['bun', 'run', 'packages/cli/src/index.ts', ...args], {
    cwd: ROOT,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  };
};

const successOutcome = (
  diagnostics: RuntimeOutcome['diagnostics'] = [],
  deprecations: RuntimeOutcome['deprecations'] = [],
): RuntimeOutcome => ({
  report: { value: true },
  diagnostics,
  exitClass: 'success',
  mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
  deprecations,
});

const silentObservation = () =>
  ({
    context: {},
    emitter: { begin: () => null, complete: () => {}, emit: () => {} },
  }) as never;

const memoryIo = (stdoutIsTTY = false, stderrIsTTY = false) => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exits: number[] = [];
  const io = {
    stdout: { isTTY: stdoutIsTTY, write: (value: string) => stdout.push(value) },
    stderr: { isTTY: stderrIsTTY, write: (value: string) => stderr.push(value) },
    exit: (code: number) => exits.push(code),
  } as unknown as CliRuntimeIo;
  return { stdout, stderr, exits, io };
};

const markerBlock = (source: string, start: string, end: string): string => {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end);
  expect(startIndex, start).toBeGreaterThanOrEqual(0);
  expect(endIndex, end).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex + end.length);
};

describe('EWP-P6-TS03', () => {
  test('family 1: resolves JSON and each stdout/stderr TTY color policy without pipe contamination', async () => {
    expect(
      resolveColorMode({ color: 'always', noColor: false, isTTY: false, env: {} }),
      'P0-01 makes a non-TTY destination absolute even for --color always',
    ).toBe('off');
    expect(
      resolveColorMode({
        color: 'auto',
        noColor: false,
        isTTY: false,
        env: { FORCE_COLOR: '1' },
      }),
    ).toBe('off');
    expect(
      resolveColorMode({
        color: 'auto',
        noColor: false,
        isTTY: false,
        env: { CLICOLOR_FORCE: '1' },
      }),
    ).toBe('off');

    const presentation = await presentationModule();
    expect(typeof presentation.resolvePresentationPolicy).toBe('function');
    const resolvePolicy = presentation.resolvePresentationPolicy;
    if (resolvePolicy === undefined) throw new Error('resolvePresentationPolicy is absent');

    const human = resolvePolicy({
      format: 'human',
      color: 'always',
      noColor: false,
      stdoutIsTTY: false,
      stderrIsTTY: true,
      env: {},
    });
    expect(human).toEqual({ stdoutColor: 'off', stderrColor: 'on' });

    for (const input of [
      { format: 'json' as const, color: 'always' as const, noColor: false, env: {} },
      { format: 'human' as const, color: 'auto' as const, noColor: true, env: {} },
      {
        format: 'human' as const,
        color: 'always' as const,
        noColor: false,
        env: { NO_COLOR: '1' },
      },
      {
        format: 'human' as const,
        color: 'never' as const,
        noColor: false,
        env: {},
      },
    ]) {
      expect(
        resolvePolicy({ ...input, stdoutIsTTY: true, stderrIsTTY: true }),
        JSON.stringify(input),
      ).toEqual({ stdoutColor: 'off', stderrColor: 'off' });
    }

    expect(
      resolvePolicy({
        format: 'human',
        color: 'auto',
        noColor: false,
        stdoutIsTTY: true,
        stderrIsTTY: true,
        env: { TERM: 'xterm-256color' },
      }),
    ).toEqual({ stdoutColor: 'on', stderrColor: 'on' });
  });

  test('family 2: applies lossless semantic Chalk styling on a real TTY and never colors observation lines', async () => {
    if (process.platform !== 'linux')
      throw new Error('EWP-P6-TS03 current-host PTY characterization requires Linux');
    const env = { ...withoutColorEnvironment(), TERM: 'xterm-256color' };
    const tty = Bun.spawnSync(
      ['script', '-qefc', 'bun run packages/cli/src/index.ts --color auto --help', '/dev/null'],
      { cwd: ROOT, env, stdout: 'pipe', stderr: 'pipe' },
    );
    expect(tty.exitCode).toBe(0);
    expect(tty.stderr.toString()).toBe('');
    expect(tty.stdout.toString(), 'human help on an eligible TTY must be styled').toContain(ESCAPE);

    const eagerVersion = Bun.spawnSync(
      ['script', '-qefc', 'bun run packages/cli/src/index.ts --color auto version', '/dev/null'],
      { cwd: ROOT, env, stdout: 'pipe', stderr: 'pipe' },
    );
    expect(eagerVersion.exitCode).toBe(0);
    expect(eagerVersion.stderr.toString()).toBe('');
    expect(eagerVersion.stdout.toString()).toContain(ESCAPE);
    expect(eagerVersion.stdout.toString().replace(ANSI_SEQUENCE, '').replaceAll('\r', '')).toBe(
      `${VERSION}\n`,
    );

    for (const args of [
      ['--color', 'always', '--help'],
      ['--color', 'always', 'version'],
    ]) {
      const piped = runCli(args, env);
      expect(piped.exitCode, args.join(' ')).toBe(0);
      expect(`${piped.stdout}${piped.stderr}`, args.join(' ')).not.toContain(ESCAPE);
    }

    const presentation = await presentationModule();
    expect(typeof presentation.presentHumanOutput).toBe('function');
    const present = presentation.presentHumanOutput;
    if (present === undefined) throw new Error('presentHumanOutput is absent');
    const plain = {
      stdout: '# Tools detected\n0.7.0\n',
      stderr: 'warning: review this\n',
    };
    const styled = present(plain, { stdoutColor: 'on', stderrColor: 'on' }, 'agents');
    expect(`${styled.stdout}${styled.stderr}`).toContain(ESCAPE);
    expect(styled.stdout?.replace(ANSI_SEQUENCE, '')).toBe(plain.stdout);
    expect(styled.stderr?.replace(ANSI_SEQUENCE, '')).toBe(plain.stderr);
    expect(
      present(
        { stderr: 'trace: operation.completed operation=op-1\n' },
        { stdoutColor: 'on', stderrColor: 'on' },
        'fixture',
      ).stderr,
    ).toBe('trace: operation.completed operation=op-1\n');

    const runtimeMemory = memoryIo(true, true);
    const runtime = createCliRuntimeAdapter({
      applications: {
        fixture: async () =>
          successOutcome([{ severity: 'warning', code: 'careful', message: 'review this' }]),
      },
      renderers: {
        fixture: {
          human: () => ({ stdout: '# Result\n', stderr: 'warning: review this\n' }),
          json: () => '{"kind":"fixture"}\n',
        },
      },
      io: runtimeMemory.io,
    });
    await runtime.execute({
      application: 'fixture',
      reportKind: 'fixture',
      request: {},
      context: {},
      observation: silentObservation(),
      format: 'human',
      presentation: { stdoutColor: 'on', stderrColor: 'on' },
    });
    expect(runtimeMemory.stdout.join('')).toContain(ESCAPE);
    expect(runtimeMemory.stderr.join('')).toContain(ESCAPE);
    expect(runtimeMemory.stdout.join('').replace(ANSI_SEQUENCE, '')).toBe('# Result\n');
    expect(runtimeMemory.stderr.join('').replace(ANSI_SEQUENCE, '')).toBe('warning: review this\n');
  });

  test('family 3: preserves signed warning, deprecation, failure, cancellation, and JSON quiet semantics', async () => {
    const cases = [
      {
        name: 'warning',
        outcome: successOutcome([
          { severity: 'warning' as const, code: 'careful', message: 'review this' },
        ]),
        rendered: { stdout: 'report\n', stderr: 'warning: review this\n' },
        expectedExit: 0,
        expectedStderr: 'warning: review this\n',
      },
      {
        name: 'deprecation',
        outcome: successOutcome(
          [],
          [
            {
              code: 'old-flag',
              message: 'old flag',
              replacement: '--new-flag',
              removalVersion: '2.0.0',
            },
          ],
        ),
        rendered: { stdout: 'report\n', stderr: 'warning: old flag\n' },
        expectedExit: 0,
        expectedStderr: 'warning: old flag\n',
      },
      {
        name: 'failure',
        outcome: {
          ...successOutcome(),
          exitClass: 'failure' as const,
          diagnostics: [{ severity: 'error' as const, code: 'failed', message: 'failed' }],
        },
        rendered: { stdout: 'failure report\n', stderr: 'error: failed\n' },
        expectedExit: 1,
        expectedStderr: 'error: failed\n',
      },
      {
        name: 'cancelled',
        outcome: {
          ...successOutcome(),
          exitClass: 'cancelled' as const,
          diagnostics: [{ severity: 'error' as const, code: 'cancelled', message: 'cancelled' }],
        },
        rendered: { stdout: 'cancelled report\n', stderr: 'error: cancelled\n' },
        expectedExit: 130,
        expectedStderr: 'error: cancelled\n',
      },
    ];

    for (const fixture of cases) {
      const memory = memoryIo();
      const runtime = createCliRuntimeAdapter({
        applications: { fixture: async () => fixture.outcome },
        renderers: {
          fixture: {
            human: () => fixture.rendered,
            json: () => '{"kind":"fixture"}\n',
          },
        },
        io: memory.io,
      });
      const result = await runtime.execute({
        application: 'fixture',
        reportKind: 'fixture',
        request: {},
        context: {},
        observation: silentObservation(),
        format: 'human',
        quiet: true,
      });
      expect(result.exitCode, fixture.name).toBe(fixture.expectedExit);
      expect(memory.stdout, fixture.name).toEqual([]);
      expect(memory.stderr.join(''), fixture.name).toBe(fixture.expectedStderr);
    }

    const json = memoryIo(true, true);
    const runtime = createCliRuntimeAdapter({
      applications: { fixture: async () => successOutcome() },
      renderers: {
        fixture: {
          human: () => 'human\n',
          json: () => '{"schemaVersion":1,"kind":"fixture"}\n',
        },
      },
      io: json.io,
    });
    await runtime.execute({
      application: 'fixture',
      reportKind: 'fixture',
      request: {},
      context: {},
      observation: silentObservation(),
      format: 'json',
      quiet: true,
    });
    expect(json.stderr).toEqual([]);
    expect(json.stdout).toEqual(['{"schemaVersion":1,"kind":"fixture"}\n']);
    expect(JSON.parse(json.stdout.join(''))).toEqual({ schemaVersion: 1, kind: 'fixture' });
    expect(json.stdout.join('')).not.toContain(ESCAPE);

    const realJson = runCli(
      ['agents', '--capabilities', '--format', 'json', '--color', 'always', '--quiet'],
      withoutColorEnvironment(),
    );
    expect(realJson.exitCode).toBe(0);
    expect(realJson.stderr).toBe('');
    expect(realJson.stdout).not.toContain(ESCAPE);
    expect(JSON.parse(realJson.stdout)).toMatchObject({
      schemaVersion: 2,
      kind: 'skillsmith.agents',
    });
  });

  test('family 4: removes global color mutation and routes preflight plus final entrypoint failures through presentation', async () => {
    const [preflight, environment, index, errorBoundary] = await Promise.all([
      readFile(resolve(ROOT, 'packages/cli/src/runtime/preflight.ts'), 'utf8'),
      readFile(resolve(ROOT, 'packages/cli/src/runtime/environment.ts'), 'utf8').catch(() => null),
      readFile(resolve(ROOT, 'packages/cli/src/index.ts'), 'utf8'),
      readFile(resolve(ROOT, 'packages/cli/src/output/error-boundary.ts'), 'utf8'),
    ]);
    expect(preflight).not.toContain('applyRuntimeColorMode');
    expect(environment, 'the process.env mutation module must be deleted').toBeNull();
    expect(index).toContain("from './runtime/presentation.ts'");
    expect(index).toMatch(/present\w*Human|write\w*Presented/);
    expect(errorBoundary).toContain('../runtime/presentation.ts');

    const usage = runCli(['--color', 'always', '--definitely-unknown'], {
      ...withoutColorEnvironment(),
      TERM: 'xterm-256color',
    });
    expect(usage.exitCode).toBe(2);
    expect(usage.stdout).toBe('');
    expect(usage.stderr).toStartWith('error: ');
    expect(usage.stderr).not.toContain(ESCAPE);

    const ttyUsage = Bun.spawnSync(
      [
        'script',
        '-qefc',
        'bun run packages/cli/src/index.ts --color always --definitely-unknown',
        '/dev/null',
      ],
      {
        cwd: ROOT,
        env: { ...withoutColorEnvironment(), TERM: 'xterm-256color' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    expect(ttyUsage.exitCode).toBe(2);
    expect(ttyUsage.stderr.toString()).toBe('');
    expect(ttyUsage.stdout.toString()).toContain(ESCAPE);
    expect(ttyUsage.stdout.toString().replace(ANSI_SEQUENCE, '')).toContain(
      "error: unknown option '--definitely-unknown'",
    );
  });

  test('family 5: keeps explicit 1.x Logger compatibility while native fallback is typed no-op observation', async () => {
    const calls: string[] = [];
    const legacy = observationFromLegacyLogger(
      {
        debug: (message) => calls.push(`debug:${message}`),
        info: (message) => calls.push(`info:${message}`),
        warn: (message) => calls.push(`warn:${message}`),
      },
      'detect',
      ['codex'],
    );
    const span = legacy.emitter.begin(legacy.context, {
      kind: 'tool.detection.started',
      toolId: 'codex',
    });
    legacy.emitter.complete(span, {
      outcome: 'success',
      errorCode: null,
      resultCount: 1,
    });
    expect(calls).toEqual(['debug:detecting codex']);

    const paths = [
      'packages/core/src/scan/index.ts',
      'packages/core/src/scan/list-skills.ts',
      'packages/core/src/scan/list-commands.ts',
      'packages/core/src/doctor/checks/cross-scope-duplicate.ts',
    ];
    const sources = await Promise.all(paths.map((path) => readFile(resolve(ROOT, path), 'utf8')));
    for (const [index, source] of sources.entries()) {
      expect(source, paths[index]).not.toContain('noopLogger');
      expect(source, paths[index]).toContain('resolveObservationBundle');
    }
    const compatibility = await readFile(
      resolve(ROOT, 'packages/core/src/observation/logger-compat.ts'),
      'utf8',
    );
    expect(compatibility).toContain('noopObserver');
    expect(compatibility).toContain('export const resolveObservationBundle');
    expect(compatibility).toContain('observationFromLegacyLogger');
  });

  test('family 6: closes direct dependencies and bounds a runnable current-host native binary', async () => {
    const [packageSource, lockfile, presentation] = await Promise.all([
      readFile(resolve(ROOT, 'packages/cli/package.json'), 'utf8'),
      readFile(resolve(ROOT, 'bun.lock'), 'utf8'),
      readFile(resolve(ROOT, 'packages/cli/src/runtime/presentation.ts'), 'utf8'),
    ]);
    const packageJson = JSON.parse(packageSource) as {
      readonly dependencies: Readonly<Record<string, string>>;
    };
    expect(packageJson.dependencies.chalk).toBe('5.6.2');
    expect(packageJson.dependencies).not.toHaveProperty('consola');
    expect(packageJson.dependencies).not.toHaveProperty('zod');
    expect(presentation).toContain("from 'chalk'");

    const cliWorkspaceStart = lockfile.indexOf('"packages/cli":');
    const coreWorkspaceStart = lockfile.indexOf('"packages/core":');
    expect(cliWorkspaceStart).toBeGreaterThanOrEqual(0);
    expect(coreWorkspaceStart).toBeGreaterThan(cliWorkspaceStart);
    const cliWorkspace = lockfile.slice(cliWorkspaceStart, coreWorkspaceStart);
    expect(cliWorkspace).toContain('"chalk": "5.6.2"');
    expect(cliWorkspace).not.toContain('"consola"');
    expect(cliWorkspace).not.toContain('"zod"');

    const temporary = await mkdtemp(join(tmpdir(), 'skillsmith-p6-ts03-'));
    try {
      const binary = resolve(temporary, 'skillsmith');
      const build = Bun.spawnSync(
        [
          'bun',
          'build',
          '--compile',
          '--bytecode',
          'packages/cli/src/index.ts',
          '--outfile',
          binary,
        ],
        { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' },
      );
      expect(build.exitCode, build.stderr.toString()).toBe(0);
      const metadata = await stat(binary);
      expect(metadata.size).toBeLessThanOrEqual(128 * 1024 * 1024);
      const version = Bun.spawnSync([binary, 'version'], { stdout: 'pipe', stderr: 'pipe' });
      expect(version.exitCode).toBe(0);
      expect(version.stdout.toString()).toBe(`${VERSION}\n`);
      expect(version.stderr.toString()).toBe('');
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test('family 7: generates exact capability/version docs and truthful source install/upgrade guidance', async () => {
    const [readme, cliReadme, generator] = await Promise.all([
      readFile(resolve(ROOT, 'README.md'), 'utf8'),
      readFile(resolve(ROOT, 'packages/cli/README.md'), 'utf8'),
      import('../../../scripts/generate-command-reference.ts') as Promise<Record<string, unknown>>,
    ]);
    const block = markerBlock(readme, CAPABILITY_START, CAPABILITY_END);
    expect(typeof generator.renderReadmeCapabilityMatrix).toBe('function');
    expect(typeof generator.validateReadmeCapabilityMatrix).toBe('function');
    expect(typeof generator.checkCommandReference).toBe('function');
    const render = generator.renderReadmeCapabilityMatrix as () => string;
    const validate = generator.validateReadmeCapabilityMatrix as (value: string) => string[];
    const check = generator.checkCommandReference as () => Promise<readonly string[]>;
    expect(block).toBe(render());
    expect(validate(block)).toEqual([]);
    expect(validate(`${CAPABILITY_START}\n${CAPABILITY_START}\n${CAPABILITY_END}`)).not.toEqual([]);
    expect(await check()).toEqual([]);

    expect(toolRegistry.adapters).toHaveLength(4);
    for (const adapter of toolRegistry.adapters) {
      expect(block).toContain(`\`${adapter.descriptor.id}\``);
      expect(block).toContain(`capability v${adapter.descriptor.capabilityVersion}`);
    }
    expect(TOOL_OPERATIONS).toHaveLength(16);
    for (const operation of TOOL_OPERATIONS) expect(block, operation).toContain(`\`${operation}\``);
    expect(block).toContain(`Skillsmith ${VERSION}`);
    for (const [tool, version] of Object.entries(VERIFIED_AGAINST)) {
      expect(block, tool).toContain(version);
    }

    expect(readme).toContain('## Upgrade');
    expect(readme).toContain('git pull --ff-only');
    expect(readme).toContain('bun install --frozen-lockfile');
    expect(readme).toContain('Source checkout');
    for (const unavailable of ['Homebrew', 'npm/Bun global', 'native release assets']) {
      expect(readme, unavailable).toContain(unavailable);
    }
    expect(readme).toMatch(/not (?:yet )?published/iu);
    for (const document of [readme, cliReadme]) {
      expect(document).toContain('eligible TTY');
      expect(document).toContain('never through a pipe');
    }
  });
});
