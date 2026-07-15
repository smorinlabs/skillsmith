import { describe, expect, test } from 'bun:test';
import { isAbsolute } from 'node:path';
import pkg from '../../core/package.json' with { type: 'json' };
import { hermeticGitEnv } from '../../core/tests/fixtures/git-env.ts';
import { CLI_ENTRYPOINT } from './fixtures/cli.ts';

const run = async (args: string[]): Promise<{ stdout: string; stderr: string; code: number }> => {
  const proc = Bun.spawn(['bun', 'run', CLI_ENTRYPOINT, ...args], {
    env: hermeticGitEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, code };
};

const exitCodeLines = (help: string): readonly string[] => {
  const block = help.match(/\nEXIT CODES\n(?<rows>(?: {2}.+\n?)+)$/)?.groups?.rows;
  if (block === undefined) throw new Error('generated help has no EXIT CODES block');
  return block
    .trim()
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '));
};

describe('skillsmith help routing', () => {
  test('CLI entrypoint is independent of the test process cwd', async () => {
    expect(isAbsolute(CLI_ENTRYPOINT)).toBe(true);
    expect(await Bun.file(CLI_ENTRYPOINT).exists()).toBe(true);
  });

  test('`skillsmith` (no args) prints top-level help, exit 0', async () => {
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('skillsmith');
    expect(r.stdout.toLowerCase()).toContain('usage');
  });

  test('`skillsmith --version` prints a version, exit 0', async () => {
    const r = await run(['--version']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(pkg.version);
  });

  test('context-free generated help advertises only observable exit behavior', async () => {
    const cases = [
      { args: ['--help'], exits: ['0 top-level help page emitted'] },
      { args: ['config', '--help'], exits: ['0 configuration help page emitted'] },
      { args: ['version', '--help'], exits: ['0 version emitted'] },
      {
        args: ['completion', '--help'],
        exits: ['0 completion script emitted', '2 required shell is missing or unsupported'],
      },
      { args: ['help', '--help'], exits: ['0 help page emitted', '2 unknown command or topic'] },
    ] as const;

    for (const fixture of cases) {
      const result = await run([...fixture.args]);
      expect(result.code, fixture.args.join(' ')).toBe(0);
      expect(result.stderr, fixture.args.join(' ')).toBe('');
      expect(exitCodeLines(result.stdout), fixture.args.join(' ')).toEqual(fixture.exits);
    }
  });

  test('`skillsmith help exit-codes` prints topic page, exit 0', async () => {
    const r = await run(['help', 'exit-codes']);
    expect(r.code).toBe(0);
    expect(r.stdout.toLowerCase()).toContain('exit');
  });

  test('`skillsmith help bogus-topic` exits 2', async () => {
    const r = await run(['help', 'bogus-topic']);
    expect(r.code).toBe(2);
  });

  test('agents JSON spelling and alias both return current valid JSON, exit 0', async () => {
    for (const args of [
      ['agents', '--format', 'json'],
      ['agents', '--json'],
    ]) {
      const r = await run(args);
      expect(r.code, args.join(' ')).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.schemaVersion, args.join(' ')).toBe(2);
      expect(parsed.kind, args.join(' ')).toBe('skillsmith.agents');
      expect(Array.isArray(parsed.detections), args.join(' ')).toBeTrue();
    }
  });

  test('install help preserves source grammar, option guidance, real examples, and exit meanings', async () => {
    const r = await run(['install', '--help']);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('owner/repo[/name], owner/repo//path');
    expect(r.stdout).toContain('--continue-on-error');
    expect(r.stdout).toContain('Keep going after per-source failures');
    expect(r.stdout).toContain('--ref <git-ref>');
    expect(r.stdout).toContain('Tag, branch, or full SHA');
    expect(r.stdout).toContain(
      '$ skillsmith install acme/agent-tools/review@v1.2.0 --project --pin',
    );
    expect(r.stdout).toContain('5    source, repository, revision, or skill is unresolvable');
    expect(r.stdout).not.toContain('See skillsmith help exit-codes.');
  });

  test('generated help stays descriptive across discover, maintain, and develop groups', async () => {
    const [list, check, dev] = await Promise.all([
      run(['list', '--help']),
      run(['check', '--help']),
      run(['dev', '--help']),
    ]);
    for (const result of [list, check, dev]) {
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('PRIMARY QUESTION');
      expect(result.stdout).toContain('EXAMPLES');
      expect(result.stdout).toContain('EXIT CODES');
      expect(result.stdout).not.toContain('See skillsmith help exit-codes.');
    }

    expect(list.stdout).toContain('[glob...]');
    expect(list.stdout).toContain('Glob filters for installed skill names');
    expect(list.stdout).toContain('--duplicates');
    expect(list.stdout).toContain('Show only cross-scope duplicates');
    expect(list.stdout).toContain('$ skillsmith list "review-*" --tool codex --long');

    expect(check.stdout).toContain('--report-only');
    expect(check.stdout).toContain('Report errors without failing the process');
    expect(check.stdout).toContain('1    one or more error findings exist');

    expect(dev.stdout).toContain('--source <path>');
    expect(dev.stdout).toContain('Create or adopt a placement from this development source');
    expect(dev.stdout).toContain('$ skillsmith dev --rollback factor-scan');
    expect(dev.stdout).toContain('5    recorded development source no longer exists');
  });
});
