import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillSmithError } from '@skillsmith/core';
import {
  type ExitCode,
  exitCodeForError,
  selectExitCode,
} from '../../../packages/cli/src/util/exit-codes.ts';
import { installSignalHandler } from '../../../packages/cli/src/util/signals.ts';
import { CLI_ENTRYPOINT } from '../../../packages/cli/tests/fixtures/cli.ts';
import { hermeticGitEnv } from '../../../packages/core/tests/fixtures/git-env.ts';

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCli = async (
  args: readonly string[],
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<CliResult> => {
  const proc = Bun.spawn(['bun', CLI_ENTRYPOINT, ...args], {
    cwd,
    env: hermeticGitEnv(env),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;
  return {
    exitCode,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
};

describe('EWP-P1-TS06', () => {
  afterEach(() => {
    process.exitCode = 0;
  });

  test('the centralized selector covers the complete 0-7/130 taxonomy', () => {
    const codes = [0, 1, 2, 3, 4, 5, 6, 7, 130] as const satisfies readonly ExitCode[];
    expect(selectExitCode([])).toBe(0);
    for (const code of codes) expect(selectExitCode([code])).toBe(code);
  });

  test('actual errors beat drift and cancellation beats every completed outcome', () => {
    // Phase 1 centralizes the taxonomy; command surfaces that can produce drift exit 7 remain
    // downstream obligations. This locks the selector behavior they must eventually delegate to.
    expect(selectExitCode([7, 1])).toBe(1);
    expect(selectExitCode([6, 7])).toBe(6);
    expect(selectExitCode([7, 3, 130, 1])).toBe(130);
  });

  test('precedence within actual errors is deterministic numeric maximum for every permutation', () => {
    for (const codes of [
      [1, 2, 3, 4, 5, 6],
      [6, 5, 4, 3, 2, 1],
      [3, 1, 6, 2, 5, 4],
      [2, 6, 1, 5, 3, 4],
    ] as const) {
      expect(selectExitCode(codes)).toBe(6);
    }
  });

  test('current error classes map into the shared semantic selector', () => {
    const errors: readonly SkillSmithError[] = [
      { code: 'generic', message: 'execution' },
      { code: 'flip-refused', message: 'usage' },
      { code: 'ledger-error', message: 'state' },
      { code: 'tool-unavailable', message: 'capability' },
      { code: 'source-unresolvable', message: 'source' },
      { code: 'permission-denied', message: 'filesystem' },
    ];
    expect(errors.map(exitCodeForError)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(selectExitCode([7, ...errors.map(exitCodeForError)])).not.toBe(7);
  });

  test('current command adapters preserve success, usage, and state exits in both output modes', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'skillsmith-p1-exits-'));
    const home = join(sandbox, 'home');
    const config = join(sandbox, 'config');
    const data = join(sandbox, 'data');
    const cache = join(sandbox, 'cache');
    await Promise.all([home, config, data, cache].map((path) => mkdir(path, { recursive: true })));
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: data,
      XDG_CACHE_HOME: cache,
      SKILLSMITH_HOME: join(data, 'skillsmith'),
      CODEX_HOME: join(home, '.codex'),
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CI: '1',
      NO_COLOR: '1',
    };

    try {
      const version = await runCli(['version'], sandbox, env);
      expect(version.exitCode).toBe(0);
      expect(version.stdout.trim()).not.toBe('');
      expect(version.stderr).toBe('');

      const completion = await runCli(['completion', 'bash'], sandbox, env);
      expect(completion.exitCode).toBe(0);
      expect(completion.stdout).toContain('skillsmith');
      expect(completion.stderr).toBe('');

      const missingPath = join(sandbox, 'missing-plugin');
      const invalidHuman = await runCli(['verify', missingPath, '--static'], sandbox, env);
      expect(invalidHuman.exitCode).toBe(2);
      expect(invalidHuman.stdout).toBe('');
      expect(invalidHuman.stderr).toContain('is not a plugin or skill directory');
      expect(invalidHuman.stderr.trimEnd().split('\n')).toHaveLength(1);

      const invalidJson = await runCli(['verify', missingPath, '--static', '--json'], sandbox, env);
      expect(invalidJson.exitCode).toBe(2);
      expect(invalidJson.stderr).toBe('');
      expect(JSON.parse(invalidJson.stdout)).toMatchObject({
        schemaVersion: 1,
        kind: 'error',
        code: 'commander.invalidArgument',
        exitCode: 2,
      });

      const configDir = join(config, 'skillsmith');
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, 'config.toml'), 'garbage = nope bar\n');
      const malformedConfig = await runCli(['config', 'list', '--json'], sandbox, env);
      expect(malformedConfig.exitCode).toBe(3);
      expect(malformedConfig.stderr).toBe('');
      expect(JSON.parse(malformedConfig.stdout)).toMatchObject({
        schemaVersion: 1,
        kind: 'error',
        code: 'config-error',
        exitCode: 3,
      });
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  }, 15_000);

  test('current acquire and flip adapters delegate precedence to the shared selector', async () => {
    for (const file of ['acquire-exit.ts', 'flip-exit.ts']) {
      const source = await Bun.file(
        join(import.meta.dir, '../../../packages/cli/src/util', file),
      ).text();
      expect(source).toContain('selectExitCode(');
      expect(source).not.toContain('Math.max');
    }
  });

  test('all handled user cancellation normalizes to exit 130', () => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const controller = new AbortController();
      const handle = installSignalHandler(controller);
      try {
        process.emit(signal);
        expect(controller.signal.aborted).toBeTrue();
        expect(handle.exitCode()).toBe(130);
        expect(process.exitCode).toBe(130);
      } finally {
        handle.uninstall();
        process.exitCode = 0;
      }
    }
  });

  test('the first cancellation remains stable when another handled signal follows', () => {
    const controller = new AbortController();
    const handle = installSignalHandler(controller);
    try {
      process.emit('SIGINT');
      expect(handle.exitCode()).toBe(130);
      process.emit('SIGTERM');
      expect(handle.exitCode()).toBe(130);
      expect(process.exitCode).toBe(130);
    } finally {
      handle.uninstall();
    }
  });
});
