import { afterEach, describe, expect, test } from 'bun:test';
import {
  normalizeCliError,
  renderCliError,
} from '../../../packages/cli/src/output/error-boundary.ts';
import { buildProgram } from '../../../packages/cli/src/program.ts';
import {
  NON_MUTATING_MODE_POLICIES,
  validateNonMutatingMode,
} from '../../../packages/cli/src/util/non-mutating-mode.ts';
import { installSignalHandler } from '../../../packages/cli/src/util/signals.ts';

describe('EWP-WF15', () => {
  afterEach(() => {
    process.exitCode = 0;
  });

  test('the Phase-1 slice declares shared non-mutating policy coverage for current commands', () => {
    const liveCommands = new Set(buildProgram().commands.map((command) => command.name()));
    for (const commandName of ['install', 'uninstall', 'dev', 'promote', 'check'] as const) {
      expect(liveCommands.has(commandName)).toBeTrue();
      expect(Object.hasOwn(NON_MUTATING_MODE_POLICIES, commandName)).toBeTrue();
    }
  });

  test('preview approval conflicts while no-prompt remains a valid noninteractive assertion', () => {
    for (const commandName of ['install', 'uninstall', 'dev', 'promote'] as const) {
      const conflict = validateNonMutatingMode(commandName, {
        dryRun: true,
        yes: true,
        prompt: false,
      });
      expect(conflict.ok).toBeFalse();
      if (conflict.ok) throw new Error(`${commandName} unexpectedly approved a preview`);
      expect(conflict.exitCode).toBe(2);

      expect(validateNonMutatingMode(commandName, { dryRun: true, prompt: false })).toEqual({
        ok: true,
      });
    }
  });

  test('human errors are one sanitized diagnostic line', () => {
    const source = Object.assign(new Error('outer failure\nforged output'), {
      cause: new Error('nested implementation detail'),
    });
    const normalized = normalizeCliError(source);
    const rendered = renderCliError(normalized, 'human');
    expect(rendered).toBe('error: outer failure forged output\n');
    expect(rendered.split('\n')).toHaveLength(2);
    expect(rendered).not.toContain('nested implementation detail');
    expect(rendered).not.toContain('stack');
  });

  test('JSON errors are one newline-terminated v1 value without cause or stack leakage', () => {
    const normalized = normalizeCliError(
      Object.assign(new Error('cannot write'), {
        code: 'permission-denied',
        cause: new Error('private nested cause'),
      }),
    );
    const rendered = renderCliError(normalized, 'json');
    expect(rendered.endsWith('\n')).toBeTrue();
    expect(rendered.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(rendered)).toEqual({
      schemaVersion: 1,
      kind: 'error',
      code: 'permission-denied',
      message: 'cannot write',
      exitCode: 6,
    });
    expect(rendered).not.toContain('private nested cause');
    expect(rendered).not.toContain('stack');
  });

  test('usage errors and cancellation retain the shared exit contract', () => {
    const usage = normalizeCliError({
      code: 'commander.unknownOption',
      message: "unknown option '--ghost'",
    });
    expect(usage.exitCode).toBe(2);

    const controller = new AbortController();
    const handle = installSignalHandler(controller);
    try {
      process.emit('SIGINT');
      expect(controller.signal.aborted).toBeTrue();
      expect(handle.exitCode()).toBe(130);
    } finally {
      handle.uninstall();
    }
  });
});
