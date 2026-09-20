import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TOOL_OPERATIONS, VERIFIED_AGAINST, VERSION, toolRegistry } from '@skillsmith/core';
import { buildProgram } from '../../../packages/cli/src/program.ts';
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
  snapshotColorEnvironment?: (
    env: Readonly<Record<string, string | undefined>>,
  ) => Readonly<Record<string, string | undefined>>;
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

type ErrorBoundaryModule = Readonly<{
  emitFinalCliError?: (
    error: unknown,
    argv: readonly string[],
    io: CliRuntimeIo,
  ) => Readonly<{ code: string; message: string; exitCode: number }>;
}>;

const errorBoundaryModule = async (): Promise<ErrorBoundaryModule> =>
  (await import('../../../packages/cli/src/output/error-boundary.ts')) as ErrorBoundaryModule;

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

const hasUnsafeHumanControl = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      (codePoint >= 0 && codePoint <= 8) ||
      (codePoint >= 11 && codePoint <= 31) ||
      (codePoint >= 127 && codePoint <= 159)
    );
  });

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
    expect(index).not.toContain("from './runtime/presentation.ts'");
    expect(index).toContain('emitFinalCliError');
    expect(errorBoundary).toContain('../runtime/presentation.ts');
    expect(errorBoundary).toContain('emitFinalCliError');

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

    expect(toolRegistry.adapters).toHaveLength(5);
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

  test('family 8: sanitizes every human destination before styling and snapshots only color environment keys', async () => {
    const presentation = await presentationModule();
    expect(typeof presentation.presentHumanOutput).toBe('function');
    const present = presentation.presentHumanOutput;
    if (present === undefined) throw new Error('presentHumanOutput is absent');

    const raw = {
      stdout: `${ESCAPE}[35m# Result${ESCAPE}[0m\u0000\u0007\tready\n`,
      stderr: `${ESCAPE}[31merror:${ESCAPE}[0m bad\u0000\u0007\n`,
    };
    const canonical = {
      stdout: '# Result\tready\n',
      stderr: 'error: bad\n',
    };
    for (const policy of [
      { stdoutColor: 'off' as const, stderrColor: 'off' as const },
      { stdoutColor: 'on' as const, stderrColor: 'on' as const },
      { stdoutColor: 'off' as const, stderrColor: 'on' as const },
      { stdoutColor: 'on' as const, stderrColor: 'off' as const },
    ]) {
      const output = present(raw, policy, 'fixture');
      expect(output.stdout?.replace(ANSI_SEQUENCE, ''), JSON.stringify(policy)).toBe(
        canonical.stdout,
      );
      expect(output.stderr?.replace(ANSI_SEQUENCE, ''), JSON.stringify(policy)).toBe(
        canonical.stderr,
      );
      expect(
        hasUnsafeHumanControl(output.stdout?.replace(ANSI_SEQUENCE, '') ?? ''),
        JSON.stringify(policy),
      ).toBeFalse();
      expect(
        hasUnsafeHumanControl(output.stderr?.replace(ANSI_SEQUENCE, '') ?? ''),
        JSON.stringify(policy),
      ).toBeFalse();
      expect(output.stdout?.includes(ESCAPE), JSON.stringify(policy)).toBe(
        policy.stdoutColor === 'on',
      );
      expect(output.stderr?.includes(ESCAPE), JSON.stringify(policy)).toBe(
        policy.stderrColor === 'on',
      );
    }

    expect(typeof presentation.snapshotColorEnvironment).toBe('function');
    const snapshotEnvironment = presentation.snapshotColorEnvironment;
    if (snapshotEnvironment === undefined) throw new Error('snapshotColorEnvironment is absent');
    const source: Record<string, string | undefined> = {
      NO_COLOR: '1',
      CLICOLOR: '0',
      TERM: 'xterm-256color',
      FORCE_COLOR: 'false',
      CLICOLOR_FORCE: '0',
      SECRET_SHOULD_NOT_ESCAPE: 'private',
    };
    const snapshot = snapshotEnvironment(source);
    expect(Object.keys(snapshot).sort()).toEqual(
      ['NO_COLOR', 'CLICOLOR', 'TERM', 'FORCE_COLOR', 'CLICOLOR_FORCE'].sort(),
    );
    expect(snapshot).toEqual({
      NO_COLOR: '1',
      CLICOLOR: '0',
      TERM: 'xterm-256color',
      FORCE_COLOR: 'false',
      CLICOLOR_FORCE: '0',
    });
    expect(Object.isFrozen(snapshot)).toBeTrue();
    source.NO_COLOR = 'changed';
    expect(snapshot.NO_COLOR).toBe('1');
  });

  test('family 9: Commander help, usage, JSON usage, and preflight use injected exit without terminating the host', async () => {
    const originalExit = process.exit;
    const globalExits: Array<number | undefined> = [];
    process.exit = ((code?: number): never => {
      globalExits.push(code);
      throw new Error(`unexpected global process.exit(${String(code)})`);
    }) as typeof process.exit;

    try {
      const cases = [
        { name: 'help', args: ['--help'], expectedExit: 0, stream: 'stdout' as const },
        {
          name: 'human usage',
          args: ['--definitely-unknown'],
          expectedExit: 2,
          stream: 'stderr' as const,
        },
        {
          name: 'JSON usage',
          args: ['--json', '--definitely-unknown'],
          expectedExit: 2,
          stream: 'stdout' as const,
        },
        {
          name: 'root preflight',
          args: ['version', '--quiet', '--verbose'],
          expectedExit: 2,
          stream: 'stderr' as const,
        },
      ];
      for (const fixture of cases) {
        const memory = memoryIo(true, true);
        const program = buildProgram(undefined, { runtimePorts: memory.io });
        await expect(
          program.parseAsync(fixture.args, { from: 'user' }),
          fixture.name,
        ).resolves.toBe(program);
        expect(memory.exits, fixture.name).toEqual([fixture.expectedExit]);
        if (fixture.stream === 'stdout') {
          expect(memory.stdout.join(''), fixture.name).not.toBe('');
          expect(memory.stderr, fixture.name).toEqual([]);
        } else {
          expect(memory.stderr.join(''), fixture.name).not.toBe('');
          expect(memory.stdout, fixture.name).toEqual([]);
        }
      }
    } finally {
      process.exit = originalExit;
    }
    expect(globalExits).toEqual([]);
  });

  test('family 10: dynamically exercises injected final rejected-main emission for human and JSON errors', async () => {
    const boundary = await errorBoundaryModule();
    expect(typeof boundary.emitFinalCliError).toBe('function');
    const emitFinalError = boundary.emitFinalCliError;
    if (emitFinalError === undefined) throw new Error('emitFinalCliError is absent');

    const hostile = {
      code: 'fixture',
      message: `${ESCAPE}[31mbad${ESCAPE}[0m\u0000\u0007 failure`,
    };
    const colorEnvironmentKeys = [
      'NO_COLOR',
      'CLICOLOR',
      'TERM',
      'FORCE_COLOR',
      'CLICOLOR_FORCE',
    ] as const;
    const originalColorEnvironment = Object.fromEntries(
      colorEnvironmentKeys.map((key) => [key, process.env[key]]),
    );
    const canonicalHuman = 'error: bad failure\n';
    const stylingSequence = new RegExp(`${ESCAPE}\\[[0-9;]*m`, 'gu');
    const normalizeHumanDiagnostic = (value: string): string => value.replace(stylingSequence, '');
    const exactHumanDiagnostic = (value: string): boolean =>
      normalizeHumanDiagnostic(value) === canonicalHuman;

    try {
      for (const profile of [
        { name: 'eligible TTY', noColor: undefined, expectsStyle: true },
        { name: 'NO_COLOR disabled TTY', noColor: '1', expectsStyle: false },
      ]) {
        for (const key of colorEnvironmentKeys) Reflect.deleteProperty(process.env, key);
        process.env.TERM = 'xterm-256color';
        if (profile.noColor !== undefined) process.env.NO_COLOR = profile.noColor;

        const human = memoryIo(false, true);
        const humanError = emitFinalError(hostile, ['--color', 'always'], human.io);
        const humanOutput = human.stderr.join('');
        const normalizedHuman = normalizeHumanDiagnostic(humanOutput);
        expect(humanError, profile.name).toEqual({
          code: 'fixture',
          message: 'bad failure',
          exitCode: 1,
        });
        expect(human.stdout, profile.name).toEqual([]);
        expect(exactHumanDiagnostic(humanOutput), profile.name).toBeTrue();
        expect(normalizedHuman, profile.name).toBe(canonicalHuman);
        expect(hasUnsafeHumanControl(normalizedHuman), profile.name).toBeFalse();
        expect(hasUnsafeHumanControl(`${normalizedHuman}\u0000\u0007`), profile.name).toBeTrue();
        expect(
          [humanOutput, 'error: bad failure (wrong)\n', 'error: bad failure\nextra\n'].map(
            exactHumanDiagnostic,
          ),
          profile.name,
        ).toEqual([true, false, false]);
        const unsafeHumanDiagnostics = [
          `${ESCAPE}[2J${canonicalHuman}`,
          `${ESCAPE}[2H${canonicalHuman}`,
          `${ESCAPE}[?25l${canonicalHuman}`,
        ];
        expect(
          unsafeHumanDiagnostics.map((value) => [
            exactHumanDiagnostic(value),
            hasUnsafeHumanControl(normalizeHumanDiagnostic(value)),
          ]),
          profile.name,
        ).toEqual([
          [false, true],
          [false, true],
          [false, true],
        ]);
        expect(humanOutput.includes(ESCAPE), profile.name).toBe(profile.expectsStyle);

        const json = memoryIo(true, true);
        const jsonError = emitFinalError(hostile, ['--json', '--color', 'always'], json.io);
        expect(jsonError, profile.name).toEqual(humanError);
        expect(json.stderr, profile.name).toEqual([]);
        expect(json.stdout, profile.name).toHaveLength(1);
        expect(json.stdout.join(''), profile.name).not.toContain(ESCAPE);
        expect(JSON.parse(json.stdout.join('')), profile.name).toEqual({
          schemaVersion: 1,
          kind: 'error',
          code: 'fixture',
          message: 'bad failure',
          exitCode: 1,
        });
      }
    } finally {
      for (const key of colorEnvironmentKeys) {
        const value = originalColorEnvironment[key];
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
  });

  test('family 11: omitted argv uses the exact process invocation for JSON and no-color errors', async () => {
    const originalArgv = process.argv;
    const originalExecArgv = process.execArgv;
    const electronDescriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron');
    const defaultAppDescriptor = Object.getOwnPropertyDescriptor(process, 'defaultApp');
    const colorEnvironmentKeys = [
      'NO_COLOR',
      'CLICOLOR',
      'TERM',
      'FORCE_COLOR',
      'CLICOLOR_FORCE',
    ] as const;
    const originalColorEnvironment = Object.fromEntries(
      colorEnvironmentKeys.map((key) => [key, process.env[key]]),
    );

    try {
      process.execArgv = [];
      Reflect.deleteProperty(process.versions, 'electron');
      Reflect.deleteProperty(process, 'defaultApp');
      for (const key of colorEnvironmentKeys) Reflect.deleteProperty(process.env, key);
      process.env.TERM = 'xterm-256color';

      process.argv = ['bun', 'skillsmith', 'agents', '--format', 'json', '--definitely-unknown'];
      const json = memoryIo(true, true);
      const jsonProgram = buildProgram(undefined, { runtimePorts: json.io });
      await expect(jsonProgram.parseAsync()).resolves.toBe(jsonProgram);

      process.argv = ['bun', 'skillsmith', '--no-color', '--definitely-unknown'];
      const noColor = memoryIo(true, true);
      const noColorProgram = buildProgram(undefined, { runtimePorts: noColor.io });
      await expect(noColorProgram.parseAsync()).resolves.toBe(noColorProgram);

      const jsonDocument = json.stdout.length === 0 ? null : JSON.parse(json.stdout.join(''));
      expect({
        jsonCode: jsonDocument?.code ?? null,
        jsonExits: json.exits,
        jsonStderr: json.stderr,
        noColorExits: noColor.exits,
        noColorStdout: noColor.stdout,
        noColorHasAnsi: noColor.stderr.join('').includes(ESCAPE),
      }).toEqual({
        jsonCode: 'commander.unknownOption',
        jsonExits: [2],
        jsonStderr: [],
        noColorExits: [2],
        noColorStdout: [],
        noColorHasAnsi: false,
      });
    } finally {
      process.argv = originalArgv;
      process.execArgv = originalExecArgv;
      if (electronDescriptor === undefined) Reflect.deleteProperty(process.versions, 'electron');
      else Object.defineProperty(process.versions, 'electron', electronDescriptor);
      if (defaultAppDescriptor === undefined) Reflect.deleteProperty(process, 'defaultApp');
      else Object.defineProperty(process, 'defaultApp', defaultAppDescriptor);
      for (const key of colorEnvironmentKeys) {
        const value = originalColorEnvironment[key];
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
  });

  test('family 12: user, node, packaged Electron, default-app Electron, and eval slicing match Commander', async () => {
    const processWithElectron = process as NodeJS.Process & { defaultApp?: boolean };
    const originalArgv = process.argv;
    const originalExecArgv = process.execArgv;
    const electronDescriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron');
    const defaultAppDescriptor = Object.getOwnPropertyDescriptor(process, 'defaultApp');

    const classify = async (
      argv: readonly string[] | undefined,
      from?: 'node' | 'electron' | 'user',
    ): Promise<Readonly<{ stream: 'json' | 'human' | 'none'; exits: readonly number[] }>> => {
      const memory = memoryIo(true, true);
      const program = buildProgram(undefined, { runtimePorts: memory.io });
      if (argv === undefined) await program.parseAsync();
      else await program.parseAsync(argv, from === undefined ? undefined : { from });
      return {
        stream: memory.stdout.length > 0 ? 'json' : memory.stderr.length > 0 ? 'human' : 'none',
        exits: memory.exits,
      };
    };

    try {
      process.execArgv = [];
      Reflect.deleteProperty(process.versions, 'electron');
      processWithElectron.defaultApp = false;
      const results = [
        await classify(['--json', '--definitely-unknown'], 'user'),
        await classify(['bun', '--json', '--definitely-unknown'], 'node'),
        await classify(['electron', '--json', '--definitely-unknown'], 'electron'),
      ];

      processWithElectron.defaultApp = true;
      results.push(await classify(['electron', '--json', '--definitely-unknown'], 'electron'));

      Reflect.deleteProperty(process, 'defaultApp');
      process.execArgv = ['--eval'];
      process.argv = ['bun', '--json', '--definitely-unknown'];
      results.push(await classify(undefined));

      expect(results).toEqual([
        { stream: 'json', exits: [2] },
        { stream: 'human', exits: [2] },
        { stream: 'json', exits: [2] },
        { stream: 'human', exits: [2] },
        { stream: 'json', exits: [2] },
      ]);
    } finally {
      process.argv = originalArgv;
      process.execArgv = originalExecArgv;
      if (electronDescriptor === undefined) Reflect.deleteProperty(process.versions, 'electron');
      else Object.defineProperty(process.versions, 'electron', electronDescriptor);
      if (defaultAppDescriptor === undefined) Reflect.deleteProperty(process, 'defaultApp');
      else Object.defineProperty(process, 'defaultApp', defaultAppDescriptor);
    }
  });

  test('family 13: repeated mixed user and node parses replace invocation state on one program', async () => {
    const colorEnvironmentKeys = [
      'NO_COLOR',
      'CLICOLOR',
      'TERM',
      'FORCE_COLOR',
      'CLICOLOR_FORCE',
    ] as const;
    const originalColorEnvironment = Object.fromEntries(
      colorEnvironmentKeys.map((key) => [key, process.env[key]]),
    );
    const canonicalHuman = "error: unknown option '--definitely-unknown'\n";
    const stylingSequence = new RegExp(`${ESCAPE}\\[[0-9;]*m`, 'gu');
    const normalizeHumanDiagnostic = (value: string): string => value.replace(stylingSequence, '');
    const exactHumanDiagnostic = (value: string): boolean =>
      normalizeHumanDiagnostic(value) === canonicalHuman;
    const canonicalJson = {
      schemaVersion: 1,
      kind: 'error',
      code: 'commander.unknownOption',
      message: "unknown option '--definitely-unknown'",
      exitCode: 2,
    };

    try {
      for (const profile of [
        { name: 'eligible TTY', noColor: undefined, expectsStyle: true },
        { name: 'NO_COLOR disabled TTY', noColor: '1', expectsStyle: false },
      ]) {
        for (const key of colorEnvironmentKeys) Reflect.deleteProperty(process.env, key);
        process.env.TERM = 'xterm-256color';
        if (profile.noColor !== undefined) process.env.NO_COLOR = profile.noColor;

        const memory = memoryIo(true, true);
        const program = buildProgram(undefined, { runtimePorts: memory.io });
        await program.parseAsync(['--json', '--definitely-unknown'], { from: 'user' });
        await program.parseAsync(['bun', '--json', '--definitely-unknown'], { from: 'node' });
        await program.parseAsync(['--format=json', '--definitely-unknown'], { from: 'user' });
        await program.parseAsync(['bun', '--format=json', '--definitely-unknown'], {
          from: 'node',
        });

        expect(memory.exits, profile.name).toEqual([2, 2, 2, 2]);
        expect(memory.stdout, profile.name).toHaveLength(2);
        expect(memory.stderr, profile.name).toHaveLength(2);
        expect(
          memory.stdout.map((document) => JSON.parse(document)),
          profile.name,
        ).toEqual([
          { ...canonicalJson, message: "unknown option '--json'" },
          { ...canonicalJson, message: "unknown option '--format=json'" },
        ]);
        for (const document of memory.stdout) expect(document, profile.name).not.toContain(ESCAPE);

        const normalizedErrors = memory.stderr.map(normalizeHumanDiagnostic);
        expect(normalizedErrors, profile.name).toEqual([canonicalHuman, canonicalHuman]);
        for (const error of normalizedErrors) {
          expect(hasUnsafeHumanControl(error), profile.name).toBeFalse();
          expect(hasUnsafeHumanControl(`${error}\u0000\u0007`), profile.name).toBeTrue();
        }
        expect(
          [
            memory.stderr[0] ?? '',
            "error: unknown option '--wrong'\n",
            "error: unknown option '--definitely-unknown'\nextra\n",
          ].map(exactHumanDiagnostic),
          profile.name,
        ).toEqual([true, false, false]);
        const unsafeHumanDiagnostics = [
          `${ESCAPE}[2J${canonicalHuman}`,
          `${ESCAPE}[2H${canonicalHuman}`,
          `${ESCAPE}[?25l${canonicalHuman}`,
        ];
        expect(
          unsafeHumanDiagnostics.map((value) => [
            exactHumanDiagnostic(value),
            hasUnsafeHumanControl(normalizeHumanDiagnostic(value)),
          ]),
          profile.name,
        ).toEqual([
          [false, true],
          [false, true],
          [false, true],
        ]);
        for (const error of memory.stderr) {
          expect(error.includes(ESCAPE), profile.name).toBe(profile.expectsStyle);
        }
      }
    } finally {
      for (const key of colorEnvironmentKeys) {
        const value = originalColorEnvironment[key];
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
  });

  test('family 14: error-format detection stops at the Commander option terminator', async () => {
    const human = memoryIo(true, true);
    const humanProgram = buildProgram(undefined, { runtimePorts: human.io });
    await humanProgram.parseAsync(['agents', '--', '--json'], { from: 'user' });

    const json = memoryIo(true, true);
    const jsonProgram = buildProgram(undefined, { runtimePorts: json.io });
    await jsonProgram.parseAsync(['--json', 'agents', '--', '--format', 'human'], { from: 'user' });

    expect({
      humanExits: human.exits,
      humanStdout: human.stdout,
      humanStderr: human.stderr.length,
      jsonExits: json.exits,
      jsonStdout: json.stdout.length,
      jsonStderr: json.stderr,
    }).toEqual({
      humanExits: [2],
      humanStdout: [],
      humanStderr: 1,
      jsonExits: [2],
      jsonStdout: 1,
      jsonStderr: [],
    });
  });
});
