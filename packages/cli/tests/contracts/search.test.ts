import { describe, expect, test } from 'bun:test';
import type { SearchRequest } from '@skillsmith/core';
import { parseSkillsShResponse } from '../../../core/src/search/skills-sh.ts';
import { encodedSearch, searchRequest } from '../../../core/tests/fixtures/search.ts';
import { resolveCompletionRequest } from '../../src/completion/transport.ts';
import { isCliBoundaryExit } from '../../src/output/error-boundary.ts';
import { buildProgram } from '../../src/program.ts';

const fixture = parseSkillsShResponse(encodedSearch(), searchRequest);
if (!fixture.ok) throw new Error('invalid fixture');
const run = async (argv: string[], error = false) => {
  const calls: SearchRequest[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exits: number[] = [];
  const program = buildProgram(undefined, {
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
    search: {
      provider: {
        search: async (request) => {
          calls.push(request);
          return error
            ? { ok: false, error: { code: 'search-timeout', message: 'deadline expired' } }
            : {
                ok: true,
                value: {
                  ...fixture.value,
                  query: request.query,
                  owner: request.owner,
                  limit: request.limit,
                },
              };
        },
      },
    },
  });
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    if (!isCliBoundaryExit(error)) throw error;
  }
  return { calls, stdout: stdout.join(''), stderr: stderr.join(''), code: exits.at(-1) };
};

describe('SEARCH-CLI-01 search surface', () => {
  test('search and find dispatch with joined words and override literal defaults', async () => {
    for (const name of ['search', 'find']) {
      const result = await run([
        name,
        'react',
        'native',
        '--owner',
        'expo',
        '--timeout=4m',
        '--max-response-size',
        '20MB',
        '--json',
      ]);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.calls).toEqual([
        {
          ...searchRequest,
          query: 'react native',
          owner: 'expo',
          timeoutMs: 240_000,
          maxResponseBytes: 20_000_000,
        },
      ]);
      expect(JSON.parse(result.stdout)).toMatchObject({
        kind: 'skillsmith.search',
        schemaVersion: 1,
        query: 'react native',
      });
      expect(result.stdout).not.toContain('installHint');
    }
  });
  test('invalid combinations and repeated options fail before provider access', async () => {
    const cases = [
      [],
      [''],
      [' '],
      ['r'],
      ['react', '--unknown'],
      ['react', '--timeout', '0m'],
      ['react', '--limit', '21'],
      ['react', '--owner', '../owner'],
      ['react', '--max-response-size', '1.5MB'],
      ['react', '--timeout', '1m', '--timeout=2m'],
      ['react', '--owner=a', '--owner=b'],
      ['react', '--limit=1', '--limit=2'],
      ['react', '--max-response-size=1MB', '--max-response-size=2MB'],
      ['react', '--interactive'],
      ['react', '--interactive', '--no-prompt'],
      ['react', '--interactive', '--quiet'],
    ];
    for (const args of cases) {
      const result = await run(['search', ...args, '--json']);
      expect(result.code, args.join(' ')).toBe(2);
      expect(result.calls).toEqual([]);
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 1,
        kind: 'error',
        exitCode: 2,
      });
      expect(result.stderr).toBe('');
    }
  });
  test('option terminator, quiet JSON, and provider failures preserve shared output policy', async () => {
    const literal = await run(['search', '--json', '--', '--react']);
    expect(literal.calls[0]?.query).toBe('--react');
    expect(literal.code).toBe(0);
    const quiet = await run(['--quiet', 'search', 'react', '--json']);
    expect(JSON.parse(quiet.stdout).kind).toBe('skillsmith.search');
    const human = await run(['search', 'react', '--quiet']);
    expect(human.stdout).toBe('');
    const error = await run(['search', 'react', '--json'], true);
    expect(error.code).toBe(5);
    expect(error.stderr).toBe('');
    expect(JSON.parse(error.stdout)).toEqual({
      schemaVersion: 1,
      kind: 'error',
      code: 'search-timeout',
      message: 'deadline expired',
      exitCode: 5,
    });
  });
  test('help and query completion do not call any effect capability', async () => {
    const program = buildProgram();
    const search = program.commands.find((command) => command.name() === 'search');
    expect(search?.helpInformation()).toContain('10,000,000');
    expect(search?.helpInformation()).toContain('2m');
    const forbidden = new Proxy(
      {},
      {
        get() {
          throw new Error('completion must not perform I/O');
        },
      },
    );
    const completion = await resolveCompletionRequest(['search', 'react'], {
      cwd: '/fixture',
      monotonicMilliseconds: () => 0,
      ports: forbidden as never,
    });
    expect(completion).toBe(':4\n');
    expect(
      program.commands
        .find((command) => command.name() === 'install')
        ?.options.some((option) => option.long === '--skill'),
    ).toBe(true);
  });
});
