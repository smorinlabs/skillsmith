import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CURRENT_COMMAND_SPECS } from '../packages/cli/src/spec/index.ts';
import {
  PUBLIC_COMMAND_ORDER,
  assertPublicCommandRoster,
  parseHelpCommands,
} from './release-gates';

const ROOT = resolve(import.meta.dir, '..');
const source = (path: string): Promise<string> => readFile(resolve(ROOT, path), 'utf8');

// The registry is the authority: every top-level public command, in help order.
const registryRoster = (): string[] =>
  CURRENT_COMMAND_SPECS.filter((spec) => spec.path.split(' ').length === 2)
    .toSorted((left, right) => left.helpOrder - right.helpOrder)
    .map((spec) => spec.path.split(' ')[1] ?? '');

const helpText = (): string => {
  const result = Bun.spawnSync([process.execPath, 'packages/cli/src/index.ts', 'help'], {
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: '1', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    timeout: 60_000,
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString();
};

describe('release command roster', () => {
  test('PUBLIC_COMMAND_ORDER is the registry roster in help order', () => {
    expect([...PUBLIC_COMMAND_ORDER]).toEqual(registryRoster());
  });

  test('the CLI help lists exactly PUBLIC_COMMAND_ORDER', () => {
    const help = helpText();
    expect(parseHelpCommands(help)).toEqual(registryRoster());
    expect(() => assertPublicCommandRoster(help)).not.toThrow();
  });

  test('a missing, extra, or reordered command fails the roster assertion', () => {
    const help = helpText();
    const lines = help.split('\n');
    const first = lines.findIndex((line) => /^ {2}search\|/u.test(line));
    expect(first).toBeGreaterThanOrEqual(0);
    const without = lines.filter((_, index) => index !== first).join('\n');
    expect(() => assertPublicCommandRoster(without)).toThrow(/command roster/u);
    const extra = [...lines.slice(0, first), '  extra [options]', ...lines.slice(first)].join('\n');
    expect(() => assertPublicCommandRoster(extra)).toThrow(/command roster/u);
    const swapped = [...lines];
    [swapped[first], swapped[first + 1]] = [swapped[first + 1] ?? '', swapped[first] ?? ''];
    expect(() => assertPublicCommandRoster(swapped.join('\n'))).toThrow(/command roster/u);
  });

  test('native candidate lanes check the roster before publication', async () => {
    const releaseCheck = await source('scripts/release-check.ts');
    const runBinary = releaseCheck.slice(
      releaseCheck.indexOf('async function runBinary('),
      releaseCheck.indexOf('async function directLifecycle('),
    );
    expect(runBinary).toContain("['help']");
    expect(runBinary).toContain('assertPublicCommandRoster(');
  });

  test('release.yml reads the roster artifact instead of hardcoding commands', async () => {
    const workflow = await source('.github/workflows/release.yml');
    expect(workflow).not.toMatch(/printf '%s\\n' agents/u);
    expect(workflow).not.toMatch(/commands='\["agents"/u);
    expect(workflow).not.toMatch(/uniq \| wc -l \| tr -d ' '\)" = '\d+'/u);
    expect(workflow).toContain('public-command-roster.json');
  });
});
