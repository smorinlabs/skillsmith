import { describe, expect, test } from 'bun:test';
import type { CurrentInstallReport } from '@skillsmith/core';
import { parseSource } from '../../../core/src/acquire/source.ts';
import { hermeticGitEnv } from '../../../core/tests/fixtures/git-env.ts';
import { resolveCompletionRequest } from '../../src/completion/transport.ts';
import { isCliBoundaryExit } from '../../src/output/error-boundary.ts';
import { buildProgram } from '../../src/program.ts';
import { renderInstallCandidateHints } from '../../src/runtime/current-renderers.ts';

const run = async (argv: string[]) => {
  let contexts = 0;
  let options: Record<string, unknown> = {};
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exits: number[] = [];
  const program = buildProgram(undefined, {
    createContext: async (command) => {
      contexts++;
      options = command.opts();
      throw new Error('fixture context reached');
    },
    runtimePorts: {
      stdout: {
        write: (s) => {
          stdout.push(s);
        },
      },
      stderr: {
        write: (s) => {
          stderr.push(s);
        },
      },
      exit: (code) => {
        exits.push(code);
      },
    },
  });
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    if (!isCliBoundaryExit(error)) throw error;
  }
  return {
    contexts,
    options,
    code: exits.at(-1),
    stdout: stdout.join(''),
    stderr: stderr.join(''),
  };
};

const retryArguments = (command: string): string[] => {
  // Execute only a local argument-printing function under the emitted shell command.
  const proc = Bun.spawnSync(
    ['/bin/sh', '-c', `skillsmith() { printf '%s\\n' "$@"; }; ${command}`],
    { env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' },
  );
  expect(proc.exitCode).toBe(0);
  expect(new TextDecoder().decode(proc.stderr)).toBe('');
  return new TextDecoder().decode(proc.stdout).trimEnd().split('\n');
};

describe('INSTALL-CLI-01 repository selector', () => {
  test.each(
    [
      ['install', 'acme/repo', '--skill', 'review'],
      ['i', 'acme/repo', '--skill=review'],
      ['install', '--skill', 'Code Review', 'acme/repo', '--skills-match-frontmatter'],
      ['i', 'acme/repo', '--skill=Code Review', '--skills-match-frontmatter'],
      ['install', '--skill=review', '--', 'acme/repo'],
      ['i', '--skill', 'review', '--', 'acme/repo'],
      ['install', 'acme/repo', '--skill=review', '--ref=feature/review'],
      ['i', 'acme/repo//', '--skill', 'review', '--ref', 'feature/review'],
      ['install', 'ssh://git@gitlab.example/group/sub/repo.git', '--skill=review'],
      ['i', 'git@gitlab.example:group/sub/repo.git', '--skill', 'review'],
    ].map((argv) => [argv]),
  )('literal argv reaches context only after a valid selector', async (argv) => {
    const result = await run(argv);
    expect(result.contexts).toBe(1);
    expect(result.options.skill).toBe(
      argv.some((value) => value.endsWith('Code Review')) ? 'Code Review' : 'review',
    );
    expect(result.options.skillsMatchFrontmatter).toBe(argv.includes('--skills-match-frontmatter'));
  });
  test.each(
    [
      ['acme/repo', '--skill'],
      ['acme/repo', '--skill', '--no-verify'],
      ['acme/repo', '--skill', '--no-save'],
      ['acme/repo', '--skill', '--skills-match-frontmatter'],
      ['acme/repo', '--skill', '-review'],
      ['acme/repo', '--skill=-review'],
      ['acme/repo', '--skill=--no-verify'],
      ['acme/repo', '--skill', ''],
      ['acme/repo', '--skill='],
      ['acme/repo', '--skill', ' review'],
      ['acme/repo@main', '--skill=review', '--ref', 'other'],
      ['acme/repo', '--skill=review', '--ref', 'bad ref'],
      ['acme/repo', '--skill=review', '--ref='],
      ['acme/repo', '--skills-match-frontmatter'],
      ['acme/repo', '--skill=review', '--skill=other'],
      ['acme/repo', '--skill=review', '--skills-match-frontmatter', '--skills-match-frontmatter'],
      ['acme/repo', '--skill=review', '--skills-match-frontmatter=false'],
      ['acme/repo', '--skill=review', '--skills-match-frontmatter=true'],
      ['acme/repo', '--skill=review', '--skills-match-frontmatter', 'true'],
      ['acme/repo', 'acme/other', '--skill=review'],
      ['acme/repo/review', '--skill=review'],
      ['acme/repo//skills/review', '--skill=review'],
      ['ssh://git@gitlab.example/group/sub/repo.git//skills/review', '--skill=review'],
      ['git@gitlab.example:group/sub/repo.git//skills/review', '--skill=review'],
    ].map((args) => [args]),
  )('invalid selector exits 2 before a poisoned context factory', async (args) => {
    for (const command of ['install', 'i']) {
      for (const json of [false, true]) {
        const result = await run([command, ...args, ...(json ? ['--json'] : [])]);
        expect(result.code, [command, ...args].join(' ')).toBe(2);
        expect(result.contexts).toBe(0);
        if (json) {
          expect(JSON.parse(result.stdout)).toMatchObject({ kind: 'error', exitCode: 2 });
          expect(result.stderr).toBe('');
        } else {
          expect(result.stdout).toBe('');
          expect(result.stderr).toContain('error:');
        }
      }
    }
  });
  test('inline and override short-SHA failures retain exit 5 before context creation', async () => {
    for (const args of [
      ['acme/repo@abcdef1'],
      ['acme/repo', '--ref', 'abcdef1'],
      ['acme/repo', '--ref=abcdef1'],
    ]) {
      const result = await run(['install', ...args, '--skill=review', '--json']);
      expect(result.code).toBe(5);
      expect(result.contexts).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ code: 'source-unresolvable', exitCode: 5 });
    }
  });
  test('usage output follows literal JSON flags only before the terminator', async () => {
    for (const [args, json] of [
      [['--skill', '--json'], true],
      [['--skill=--json'], false],
      [['--json', '--skill', '--'], true],
      [['--skill', '--', '--json'], false],
      [['--skill=review', '--', '--json'], false],
    ] as const) {
      const result = await run(['install', 'acme/repo', ...args]);
      expect(result.contexts).toBe(0);
      expect(result.code).toBe(2);
      if (json) {
        expect(JSON.parse(result.stdout)).toMatchObject({ kind: 'error', exitCode: 2 });
        expect(result.stderr).toBe('');
      } else {
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('error:');
      }
    }
  });
  test('help and remote-name completion do not create a context or access ports', async () => {
    const help = await run(['install', '--help']);
    expect(help.contexts).toBe(0);
    expect(help.stdout).toContain('--skills-match-frontmatter');
    expect(help.stdout).toContain('--skill <name>');
    const ports = new Proxy(
      {},
      {
        get() {
          throw new Error('completion performed I/O');
        },
      },
    );
    for (const argv of [
      ['install', 'acme/repo', '--skill', ''],
      ['install', 'acme/repo', '--skill='],
      ['i', 'acme/repo', '--skill', 'rev'],
      ['i', 'acme/repo', '--skill=rev'],
    ]) {
      expect(
        await resolveCompletionRequest(argv, {
          cwd: '/fixture',
          monotonicMilliseconds: () => 0,
          ports: ports as never,
        }),
      ).toBe(':4\n');
    }
  });
  test('retry hints preserve host, SSH transport, slash-bearing refs, and root meaning', () => {
    for (const cloneUrl of [
      'https://gitlab.example/group/sub/repo.git',
      'ssh://git@gitlab.example/group/sub/repo.git',
      'git@gitlab.example:group/sub/repo.git',
    ]) {
      for (const ref of [null, 'feature/review']) {
        const item = {
          candidateSource: {
            cloneUrl,
            ref,
            candidates: [
              { path: 'skills/review', source: `${cloneUrl}//skills/review` },
              { path: '', source: null },
            ],
          },
        } as unknown as CurrentInstallReport['results'][number];
        const rendered = renderInstallCandidateHints(item);
        expect(rendered).toContain('Repository root (SKILL.md)');
        expect(rendered).not.toContain(`${cloneUrl}//'`);
        const command = rendered.split('\n')[0]?.trim();
        if (!command) throw new Error('missing retry');
        const args = retryArguments(command);
        expect(args).toEqual([
          'install',
          `${cloneUrl}//skills/review`,
          ...(ref === null ? [] : ['--ref', ref]),
        ]);
        if (args[1] === undefined) throw new Error('missing retry source');
        const parsed = parseSource(args[1], args[3] === undefined ? {} : { overrideRef: args[3] });
        expect(parsed).toMatchObject({
          ok: true,
          value: { cloneUrl, ref, selector: { kind: 'path', path: 'skills/review' } },
        });
      }
    }
  });
});

test('the emitted retry command round-trips shell quoting, and unrepresentable locations stay informational', () => {
  const cloneUrl = 'https://gitlab.example/group/sub/repo.git';
  const path = "team's/review";
  const ref = "feature/review's";
  const item = {
    candidateSource: {
      cloneUrl,
      ref,
      candidates: [
        { path, source: `${cloneUrl}//${path}` },
        { path: 'tëam/review', source: null },
      ],
    },
  } as unknown as CurrentInstallReport['results'][number];
  const output = renderInstallCandidateHints(item);
  const command = output.split('\n')[0]?.trim();
  if (!command) throw new Error('missing retry');
  const args = retryArguments(command);
  expect(args).toEqual(['install', `${cloneUrl}//${path}`, '--ref', ref]);
  if (args[1] === undefined || args[3] === undefined) throw new Error('incomplete command');
  expect(parseSource(args[1], { overrideRef: args[3] })).toMatchObject({
    ok: true,
    value: { cloneUrl, ref, selector: { kind: 'path', path } },
  });
  expect(output).toContain('"tëam/review": exact-path retry unavailable');
  expect(output.split('\n')[1]).not.toContain('skillsmith install');
});
