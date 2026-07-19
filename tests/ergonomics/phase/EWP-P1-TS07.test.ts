import { describe, expect, test } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { walk } from '../../../packages/cli/src/completion/walk.ts';
import { canonicalizeCommanderTree } from '../../../packages/cli/src/contracts/commander-surface.ts';
import { buildProgram } from '../../../packages/cli/src/program.ts';
import type { RuntimeOutcome } from '../../../packages/cli/src/runtime/adapter.ts';
import { createCommandFromSpec } from '../../../packages/cli/src/runtime/command-spec.ts';
import { createCurrentRendererRegistry } from '../../../packages/cli/src/runtime/current-renderers.ts';
import type { CommandSpec } from '../../../packages/cli/src/spec/types.ts';
import { CLI_ENTRYPOINT } from '../../../packages/cli/tests/fixtures/cli.ts';
import { hermeticGitEnv } from '../../../packages/core/tests/fixtures/git-env.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const COMMANDS_ROOT = join(ROOT, 'packages/cli/src/commands');
const PROGRAM = join(ROOT, 'packages/cli/src/program.ts');
const CLI_INDEX = join(ROOT, 'packages/cli/src/index.ts');
const CORE_INDEX = join(ROOT, 'packages/core/src/index.ts');

const SPEC_MODULES = [
  'packages/cli/src/spec/index.ts',
  'packages/cli/src/specs/current.ts',
  'packages/cli/src/specs/index.ts',
  'packages/cli/src/runtime/command-spec.ts',
] as const;

const APPLICATION_MODULES = [
  'packages/core/src/application/current-services.ts',
  'packages/core/src/application/services.ts',
  'packages/core/src/application/index.ts',
] as const;

type UnknownRecord = Record<string, unknown>;

const record = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readMaybe = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
};

const importFirst = async (
  candidates: readonly string[],
): Promise<{ readonly path: string; readonly module: UnknownRecord } | null> => {
  for (const candidate of candidates) {
    const path = join(ROOT, candidate);
    if ((await readMaybe(path)) === null) continue;
    try {
      const loaded = (await import(`${pathToFileURL(path).href}?ewp-p1-ts07`)) as UnknownRecord;
      return { path: candidate, module: loaded };
    } catch {
      // A source-level failure below is more useful than making this contract impossible to load.
    }
  }
  return null;
};

const typescriptFiles = async (root: string): Promise<readonly string[]> => {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return typescriptFiles(path);
      return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
    }),
  );
  return nested.flat().sort();
};

const exportedSpecArray = (module: UnknownRecord): readonly UnknownRecord[] => {
  const named = module.CURRENT_COMMAND_SPECS;
  if (Array.isArray(named) && named.length > 0 && named.every(record)) return named;
  const candidates = Object.values(module).filter(
    (value): value is readonly UnknownRecord[] =>
      Array.isArray(value) && value.length > 0 && value.every(record),
  );
  return candidates.sort((a, b) => b.length - a.length)[0] ?? [];
};

const specChildren = (spec: UnknownRecord): readonly UnknownRecord[] => {
  for (const key of ['children', 'subcommands', 'commands'] as const) {
    const value = spec[key];
    if (Array.isArray(value) && value.every(record)) return value;
  }
  return [];
};

const specName = (spec: UnknownRecord): string | null => {
  for (const key of ['name', 'command', 'path'] as const) {
    if (typeof spec[key] === 'string') return spec[key];
  }
  return null;
};

const flattenSpecPaths = (
  specs: readonly UnknownRecord[],
  parent = 'skillsmith',
): ReadonlyMap<string, UnknownRecord> => {
  const paths = new Map<string, UnknownRecord>();
  for (const spec of specs) {
    const raw = specName(spec);
    if (raw === null) continue;
    const path = raw === 'skillsmith' || raw.startsWith('skillsmith ') ? raw : `${parent} ${raw}`;
    paths.set(path, spec);
    const children = specChildren(spec);
    if (children.length > 0) {
      for (const [childPath, child] of flattenSpecPaths(children, path))
        paths.set(childPath, child);
    }
  }
  return paths;
};

const applicationRef = (spec: UnknownRecord): unknown =>
  spec.application ?? spec.applicationService ?? spec.service ?? spec.execute;

const runCli = async (args: readonly string[]) => {
  const child = Bun.spawn(['bun', CLI_ENTRYPOINT, ...args], {
    cwd: ROOT,
    env: hermeticGitEnv({ CI: '1', NO_COLOR: '1' }),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await child.exited;
  return {
    exitCode,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
};

describe('EWP-P1-TS07', () => {
  test('the live current-command graph is closed by declarative specs and application services', async () => {
    const loaded = await importFirst(SPEC_MODULES);
    expect(
      loaded,
      `missing a declarative current-command registry; checked ${SPEC_MODULES.join(', ')}`,
    ).not.toBeNull();
    if (loaded === null) return;

    const specs = exportedSpecArray(loaded.module);
    expect(
      specs.length,
      `${loaded.path} must export one non-empty current CommandSpec registry`,
    ).toBeGreaterThan(0);

    const specPaths = new Map(
      [...flattenSpecPaths(specs)].filter(([path]) => path !== 'skillsmith'),
    );
    const livePaths = canonicalizeCommanderTree(buildProgram())
      .map((command) => command.path)
      .filter((path) => path !== 'skillsmith');
    expect([...specPaths.keys()].sort()).toEqual([...livePaths].sort());

    const loadedApplications = await importFirst(APPLICATION_MODULES);
    expect(loadedApplications).not.toBeNull();
    const applicationRegistry = loadedApplications?.module.CURRENT_APPLICATION_SERVICES;
    expect(
      record(applicationRegistry),
      'public core must export the exact current application-service registry',
    ).toBeTrue();

    for (const path of livePaths) {
      const spec = specPaths.get(path);
      expect(spec, `${path} has no declarative CommandSpec`).toBeDefined();
      if (spec === undefined) continue;
      expect(typeof spec.group, `${path} must declare its five-group membership`).toBe('string');
      expect(typeof spec.primaryQuestion, `${path} must declare its primary question`).toBe(
        'string',
      );
      expect(
        Array.isArray(spec.arguments),
        `${path} must declare arguments, even when empty`,
      ).toBeTrue();
      expect(
        Array.isArray(spec.options),
        `${path} must declare options, even when empty`,
      ).toBeTrue();
      expect(
        Array.isArray(spec.examples),
        `${path} must declare examples, even when empty`,
      ).toBeTrue();

      const children = specChildren(spec);
      if (children.length === 0) {
        const service = applicationRef(spec);
        expect(
          typeof service === 'function' || typeof service === 'string',
          `${path} must close on one application-service entry point`,
        ).toBeTrue();
      }
      const service = applicationRef(spec);
      expect(typeof service, `${path} application reference must be a registry key`).toBe('string');
      if (typeof service === 'string' && record(applicationRegistry)) {
        expect(
          typeof applicationRegistry[service],
          `${path} application '${service}' is not registered`,
        ).toBe('function');
      }
    }
    if (record(applicationRegistry)) {
      const referenced = [
        ...new Set(
          specs.map(applicationRef).filter((value): value is string => typeof value === 'string'),
        ),
      ].sort();
      expect(Object.keys(applicationRegistry).sort()).toEqual(referenced);
    }
  });

  test('command modules no longer own process, environment, parser, renderer, error, or prompt policy', async () => {
    const forbidden = [
      ['direct process access', /\bprocess\.(?:exit|stdout|stderr|stdin|env|cwd)\b/],
      ['default environment construction', /\bdefaultScanEnv\b/],
      ['Commander declarations', /from ['"]commander['"]|\bnew (?:Command|Option|Argument)\b/],
      [
        'renderer or error-boundary selection',
        /from ['"][^'"]*\/output\/|\b(?:renderCliError|failCliError|withCliErrorBoundary)\b/,
      ],
      ['terminal prompt construction', /from ['"]@clack\/prompts['"]/],
    ] as const;
    const findings: string[] = [];
    for (const path of await typescriptFiles(COMMANDS_ROOT)) {
      const source = await readFile(path, 'utf8');
      for (const [label, pattern] of forbidden) {
        if (pattern.test(source)) findings.push(`${relative(ROOT, path)}: ${label}`);
      }
    }
    expect(findings).toEqual([]);

    const program = await readFile(PROGRAM, 'utf8');
    expect(program).not.toMatch(/\bdefaultScanEnv\b|\bprocess\.(?:exit|stdout|stderr|stdin)\b/);
    expect(program).not.toMatch(/\.command\(['"]version['"]\)/);
    expect(program).not.toMatch(/runtime\/current\/|commands\//);

    const cliIndex = await readFile(CLI_INDEX, 'utf8');
    expect(cliIndex).not.toMatch(/\.outputHelp\(/);

    const relocated = await typescriptFiles(join(ROOT, 'packages/cli/src/runtime/current')).catch(
      () => [],
    );
    expect(
      relocated,
      'legacy command runtimes must not be relocated under runtime/current',
    ).toEqual([]);
  });

  test('the public core boundary owns CommandOutcome and all semantic failure classes', async () => {
    const typeSources = await Promise.all(
      [
        'packages/core/src/application/types.ts',
        'packages/core/src/application/index.ts',
        ...APPLICATION_MODULES,
      ].map(async (path) => (await readMaybe(join(ROOT, path))) ?? ''),
    );
    const applicationSource = typeSources.join('\n');
    expect(applicationSource).toMatch(/(?:interface|type)\s+CommandOutcome\b/);
    for (const field of ['report', 'diagnostics', 'exitClass', 'mutation', 'deprecations']) {
      expect(applicationSource, `CommandOutcome is missing '${field}'`).toMatch(
        new RegExp(`\\b${field}\\s*[?:]`),
      );
    }
    for (const exitClass of [
      'success',
      'failure',
      'usage',
      'state',
      'capability',
      'source',
      'permission',
      'drift',
      'cancelled',
    ]) {
      expect(applicationSource, `public application exit class '${exitClass}' is absent`).toContain(
        exitClass,
      );
    }
    expect(applicationSource).toMatch(/(?:interface|type)\s+InteractionPort\b/);
    expect(applicationSource).not.toMatch(/\b(?:0|1|2|3|4|5|6|7|130)\s*\|/);

    const coreIndex = await readFile(CORE_INDEX, 'utf8');
    expect(coreIndex).toMatch(/\.\/application\//);
  });

  test('version is the zero-discovery service canary and preserves command/global parity', async () => {
    const [command, global] = await Promise.all([runCli(['version']), runCli(['--version'])]);
    expect(command).toEqual(global);
    expect(command.exitCode).toBe(0);
    expect(command.stderr).toBe('');
    expect(command.stdout).toMatch(/^\d+\.\d+\.\d+[^\n]*\n$/);

    const loadedSpecs = await importFirst(SPEC_MODULES);
    expect(loadedSpecs).not.toBeNull();
    if (loadedSpecs === null) return;
    const version = flattenSpecPaths(exportedSpecArray(loadedSpecs.module)).get(
      'skillsmith version',
    );
    expect(version, 'version must be present in the shared current spec registry').toBeDefined();
    if (version === undefined) return;
    expect(applicationRef(version), 'version must use an application service').toBeDefined();

    const loadedApplications = await importFirst(APPLICATION_MODULES);
    expect(
      loadedApplications,
      `missing public current application services; checked ${APPLICATION_MODULES.join(', ')}`,
    ).not.toBeNull();
    if (loadedApplications === null) return;
    expect(
      Object.entries(loadedApplications.module).some(
        ([name, value]) => /version/i.test(name) && typeof value === 'function',
      ),
      `${loadedApplications.path} must export the zero-discovery version application service`,
    ).toBeTrue();
  });

  test('global --version short-circuits every command position through the shared runtime', async () => {
    const invocations = [
      ['agents', '--version'],
      ['--version', 'agents'],
      ['doctor', '--version'],
      ['install', '--version'],
      ['install', '-V'],
    ] as const;
    const contexts: unknown[] = [];
    const commandCalls: string[] = [];

    for (const invocation of invocations) {
      const writes = { stdout: [] as string[], stderr: [] as string[], exits: [] as number[] };
      const program = buildProgram(undefined, {
        applications: {
          version: async (_request, context) => {
            contexts.push(context);
            return {
              report: { version: '1.2.3-runtime-canary' },
              diagnostics: [],
              exitClass: 'success',
              mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
              deprecations: [],
            };
          },
          agents: async () => {
            commandCalls.push('agents');
            throw new Error('agents discovery must not run for --version');
          },
          doctor: async () => {
            commandCalls.push('doctor');
            throw new Error('doctor discovery must not run for --version');
          },
          install: async () => {
            commandCalls.push('install');
            throw new Error('install validation and discovery must not run for --version');
          },
        },
        renderers: {
          version: {
            human: (outcome) => `${(outcome.report as { version: string }).version}\n`,
            json: (outcome) => `${JSON.stringify(outcome.report)}\n`,
          },
        },
        runtimePorts: {
          stdout: { write: (value) => writes.stdout.push(value) },
          stderr: { write: (value) => writes.stderr.push(value) },
          exit: (code) => writes.exits.push(code),
        },
      });

      await program.parseAsync(['node', 'skillsmith', ...invocation]);
      expect(writes).toEqual({
        stdout: ['1.2.3-runtime-canary\n'],
        stderr: [],
        exits: [0],
      });
    }

    expect(commandCalls).toEqual([]);
    expect(contexts).toHaveLength(invocations.length);
    for (const context of contexts) {
      expect(record(context)).toBeTrue();
      const observation = record(context) ? context.observation : undefined;
      expect(record(observation)).toBeTrue();
      if (!record(observation)) continue;
      expect(Object.keys(observation).sort()).toEqual(['context', 'emitter']);
      expect(record(observation.context)).toBeTrue();
      expect(record(observation.emitter)).toBeTrue();
      if (record(observation.context)) {
        expect(observation.context.command).toBe('skillsmith version');
        expect(observation.context.workflow).toBe('version');
      }
    }

    for (const invocation of [
      ['--version', '-qv'],
      ['--version', '--quiet', '--debug'],
    ] as const) {
      const conflict = await runCli(invocation);
      expect(conflict.exitCode).toBe(2);
      expect(conflict.stdout).toBe('');
      expect(conflict.stderr).toMatch(/^error: /);
    }
  });

  test('eager version parsing respects value-taking short options inside clusters', async () => {
    const calls: string[] = [];
    const writes: string[] = [];
    const program = buildProgram(undefined, {
      applications: {
        version: async () => {
          calls.push('version');
          throw new Error('the V after -C is a directory value, not the version flag');
        },
        install: async () => {
          calls.push('install');
          return {
            report: { invoked: true },
            diagnostics: [],
            exitClass: 'success',
            mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
            deprecations: [],
          };
        },
      },
      renderers: {
        install: { human: () => 'install-ran\n', json: () => '{"install":true}' },
      },
      runtimePorts: {
        stdout: { write: (value) => writes.push(value) },
        stderr: { write: (value) => writes.push(value) },
        exit: () => {},
      },
    });

    await program.parseAsync(['node', 'skillsmith', '-qCV', 'install', 'source']);
    expect(calls).toEqual(['install']);
    expect(writes).toEqual([]);
  });

  test('eager version parsing respects value-taking options from attached extension specs', async () => {
    const fixture: CommandSpec = {
      name: 'fixture-value',
      path: 'skillsmith fixture-value',
      aliases: [],
      group: 'maintain',
      primaryQuestion: 'Does extension option parsing retain authority?',
      description: 'Exercise attached short values that resemble the version flag.',
      arguments: [],
      options: [
        {
          flags: '-m, --mode <mode>',
          long: '--mode',
          short: '-m',
          attributeName: 'mode',
          valueShape: 'required',
          knownValues: [],
          allowedValues: [],
          repeatable: false,
          negated: false,
          flagDefault: undefined,
          parsedDefault: undefined,
          description: 'Fixture mode',
        },
        {
          flags: '-o, --optional [value]',
          long: '--optional',
          short: '-o',
          attributeName: 'optional',
          valueShape: 'optional',
          knownValues: [],
          allowedValues: [],
          repeatable: false,
          negated: false,
          flagDefault: undefined,
          parsedDefault: undefined,
          description: 'Optional fixture value',
        },
      ],
      examples: [],
      capability: 'read',
      reportKind: 'fixture-value',
      application: 'help',
    };
    const calls: string[] = [];
    const writes: string[] = [];
    const program = buildProgram(undefined, {
      additionalSpecs: [fixture],
      applications: {
        version: async (request) => {
          const options = record(request) && record(request.options) ? request.options : {};
          calls.push(`eager-version:${String(options.verbose)}`);
          return {
            report: {},
            diagnostics: [],
            exitClass: 'success',
            mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
            deprecations: [],
          };
        },
        help: async (request) => {
          const options = record(request) && record(request.options) ? request.options : {};
          calls.push(`fixture:${String(options.mode)}`);
          return {
            report: {},
            diagnostics: [],
            exitClass: 'success',
            mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
            deprecations: [],
          };
        },
      },
      renderers: {
        'fixture-value': { human: () => 'fixture-ran\n', json: () => '{}' },
        version: { human: () => 'version-ran\n', json: () => '{}' },
      },
      runtimePorts: {
        stdout: { write: (value) => writes.push(value) },
        stderr: { write: (value) => writes.push(value) },
        exit: () => {},
      },
    });

    await program.parseAsync(['node', 'skillsmith', 'fixture-value', '-mV']);
    expect(calls).toEqual(['fixture:V']);
    expect(writes).toEqual(['fixture-ran\n']);

    calls.length = 0;
    writes.length = 0;
    await program.parseAsync(['node', 'skillsmith', 'fixture-value', '-o', '-v', '-V']);
    expect(calls).toEqual(['eager-version:1']);
    expect(writes.at(-1)).toBe('version-ran\n');
  });

  test('unrelated command option shapes cannot shield the eager version flags', async () => {
    const foreign: CommandSpec = {
      name: 'foreign-value',
      path: 'skillsmith foreign-value',
      aliases: [],
      group: 'maintain',
      primaryQuestion: 'Can an unrelated extension borrow eager parsing authority?',
      description: 'Exercise option value ownership outside the active command.',
      arguments: [],
      options: [
        {
          flags: '-x, --payload <value>',
          long: '--payload',
          short: '-x',
          attributeName: 'payload',
          valueShape: 'required',
          knownValues: [],
          allowedValues: [],
          repeatable: false,
          negated: false,
          flagDefault: undefined,
          parsedDefault: undefined,
          description: 'Foreign payload',
        },
      ],
      examples: [],
      capability: 'read',
      reportKind: 'foreign-value',
      application: 'help',
    };
    const invocations = [
      ['agents', '--ref', '--version'],
      ['agents', '--file', '--version'],
      ['agents', '-s', '-V'],
      ['agents', '--payload', '--version'],
      ['agents', '-x', '-V'],
    ] as const;

    for (const invocation of invocations) {
      const calls: string[] = [];
      const writes: string[] = [];
      const program = buildProgram(undefined, {
        additionalSpecs: [foreign],
        applications: {
          version: async () => {
            calls.push('version');
            return {
              report: {},
              diagnostics: [],
              exitClass: 'success',
              mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
              deprecations: [],
            };
          },
          agents: async () => {
            calls.push('agents');
            throw new Error('the unrelated option must not suppress eager version handling');
          },
        },
        renderers: {
          version: { human: () => 'version-ran\n', json: () => '{}' },
        },
        runtimePorts: {
          stdout: { write: (value) => writes.push(value) },
          stderr: { write: (value) => writes.push(value) },
          exit: () => {},
        },
      });

      await program.parseAsync(['node', 'skillsmith', ...invocation]);
      expect(calls, invocation.join(' ')).toEqual(['version']);
      expect(writes, invocation.join(' ')).toEqual(['version-ran\n']);
    }
  });

  test('active command and root values retain Commander eager shielding semantics', async () => {
    const fixture: CommandSpec = {
      name: 'scoped-values',
      path: 'skillsmith scoped-values',
      aliases: [],
      group: 'maintain',
      primaryQuestion: 'Do active option values retain parsing authority?',
      description: 'Exercise required and optional values in the active command scope.',
      arguments: [],
      options: [
        {
          flags: '-m, --mode <value>',
          long: '--mode',
          short: '-m',
          attributeName: 'mode',
          valueShape: 'required',
          knownValues: [],
          allowedValues: [],
          repeatable: false,
          negated: false,
          flagDefault: undefined,
          parsedDefault: undefined,
          description: 'Required active value',
        },
        {
          flags: '-o, --optional [value]',
          long: '--optional',
          short: '-o',
          attributeName: 'optional',
          valueShape: 'optional',
          knownValues: [],
          allowedValues: [],
          repeatable: false,
          negated: false,
          flagDefault: undefined,
          parsedDefault: undefined,
          description: 'Optional active value',
        },
      ],
      examples: [],
      capability: 'read',
      reportKind: 'scoped-values',
      application: 'help',
    };
    const run = async (invocation: readonly string[]): Promise<readonly string[]> => {
      const calls: string[] = [];
      const program = buildProgram(undefined, {
        additionalSpecs: [fixture],
        applications: {
          rootHelp: async (request) => {
            calls.push(`root:${String(request.options.config)}`);
            return {
              report: {},
              diagnostics: [],
              exitClass: 'success',
              mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
              deprecations: [],
            };
          },
          help: async (request) => {
            calls.push(
              `active:${String(request.options.mode)}:${String(request.options.optional)}`,
            );
            return {
              report: {},
              diagnostics: [],
              exitClass: 'success',
              mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
              deprecations: [],
            };
          },
          version: async () => {
            calls.push('version');
            return {
              report: {},
              diagnostics: [],
              exitClass: 'success',
              mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
              deprecations: [],
            };
          },
        },
        renderers: {
          rootHelp: { human: () => '', json: () => '{}' },
          'scoped-values': { human: () => '', json: () => '{}' },
          version: { human: () => '', json: () => '{}' },
        },
        runtimePorts: {
          stdout: { write: () => {} },
          stderr: { write: () => {} },
          exit: () => {},
        },
      });
      await program.parseAsync(['node', 'skillsmith', ...invocation]);
      return calls;
    };

    expect(await run(['--config', '-V'])).toEqual(['root:-V']);
    expect(await run(['--config', '--version'])).toEqual(['root:--version']);
    expect(await run(['scoped-values', '-mV'])).toEqual(['active:V:undefined']);
    expect(await run(['scoped-values', '-oV'])).toEqual(['active:undefined:V']);
    expect(await run(['scoped-values', '-o', '-V'])).toEqual(['version']);

    for (const versionFlag of ['-V', '--version'] as const) {
      const missingRequiredValue = await runCli(['doctor', '--file', versionFlag]);
      expect(missingRequiredValue.exitCode).toBe(2);
      expect(missingRequiredValue.stdout).toBe('');
      expect(missingRequiredValue.stderr).toMatch(/argument missing/);
    }
  });

  test('attached specs cannot change eager parsing by redefining an option value shape', () => {
    const fixture = (
      name: string,
      flags: string,
      long: string,
      short: string | null,
      valueShape: 'boolean' | 'required' | 'optional',
    ): CommandSpec => ({
      name,
      path: `skillsmith ${name}`,
      aliases: [],
      group: 'maintain',
      primaryQuestion: 'Does extension parsing remain isolated?',
      description: 'Exercise option spelling shape ownership.',
      arguments: [],
      options: [
        {
          flags,
          long,
          short,
          attributeName: 'mode',
          valueShape,
          knownValues: [],
          allowedValues: [],
          repeatable: false,
          negated: false,
          flagDefault: undefined,
          parsedDefault: undefined,
          description: 'Fixture mode',
        },
      ],
      examples: [],
      capability: 'read',
      reportKind: name,
      application: 'help',
    });

    expect(() =>
      buildProgram(undefined, {
        additionalSpecs: [
          fixture('required-long', '--mode <value>', '--mode', null, 'required'),
          fixture('optional-long', '--mode [value]', '--mode', null, 'optional'),
        ],
      }),
    ).toThrow('Option spelling --mode has conflicting value shapes: required and optional');
    expect(() =>
      buildProgram(undefined, {
        additionalSpecs: [
          fixture('boolean-short', '-m, --first', '--first', '-m', 'boolean'),
          fixture('required-short', '-m, --second <value>', '--second', '-m', 'required'),
        ],
      }),
    ).toThrow('Option spelling -m has conflicting value shapes: boolean and required');
    expect(() =>
      buildProgram(undefined, {
        additionalSpecs: [
          fixture('root-collision', '--config [value]', '--config', null, 'optional'),
        ],
      }),
    ).toThrow('Option spelling --config has conflicting value shapes: required and optional');
  });

  test('one fixture spec drives parser, help, completion, docs inventory, and execution', async () => {
    const fixture: CommandSpec = {
      name: 'fixture',
      path: 'skillsmith fixture',
      aliases: ['fx'],
      group: 'maintain',
      primaryQuestion: 'Does one declaration drive every CLI artifact?',
      description: 'Exercise the generic command-spec boundary.',
      arguments: [
        {
          name: 'item',
          required: true,
          variadic: false,
          choices: [],
          defaultValue: undefined,
          description: 'Fixture item to execute',
        },
      ],
      options: [
        {
          flags: '--mode <mode>',
          long: '--mode',
          short: null,
          attributeName: 'mode',
          valueShape: 'required',
          knownValues: ['fast', 'safe'],
          allowedValues: ['fast', 'safe'],
          parserValues: ['fast', 'safe'],
          repeatable: false,
          negated: false,
          flagDefault: 'fast',
          parsedDefault: 'fast',
          description: 'Fixture execution mode',
        },
        {
          flags: '--tag <tag>',
          long: '--tag',
          short: null,
          attributeName: 'tag',
          valueShape: 'required',
          knownValues: [],
          allowedValues: [],
          repeatable: true,
          negated: false,
          flagDefault: [],
          parsedDefault: [],
          description: 'Repeatable fixture tag',
        },
        {
          flags: '--json',
          long: '--json',
          short: null,
          attributeName: 'json',
          valueShape: 'boolean',
          knownValues: [],
          allowedValues: [],
          repeatable: false,
          negated: false,
          flagDefault: false,
          parsedDefault: false,
          description: 'Emit the fixture JSON report',
        },
      ],
      examples: ['skillsmith fixture sample --mode safe'],
      capability: 'read',
      reportKind: 'fixture-renderer',
      application: 'fixture',
    };
    const writes = { stdout: [] as string[], stderr: [] as string[], exits: [] as number[] };
    const application = async (request: unknown) => ({
      report: request,
      diagnostics: [],
      exitClass: 'success' as const,
      mutation: { kind: 'none' as const, planned: 0, changed: 0, unchanged: 0, failed: 0 },
      deprecations: [],
    });
    const program = buildProgram(undefined, {
      additionalSpecs: [fixture],
      applications: { fixture: application },
      renderers: {
        'fixture-renderer': {
          human: () => 'fixture-human\n',
          json: () => '{"kind":"fixture"}\n',
        },
      },
      runtimePorts: {
        stdout: { write: (value: string) => writes.stdout.push(value) },
        stderr: { write: (value: string) => writes.stderr.push(value) },
        exit: (code: number) => writes.exits.push(code),
      },
    });
    const command = program.commands.find((candidate) => candidate.name() === 'fixture');
    expect(
      command,
      'buildProgram must accept an additional CommandSpec through the shared path',
    ).toBeDefined();
    if (command === undefined) return;
    expect(command.aliases()).toContain('fx');
    expect(command.helpInformation()).toContain(fixture.primaryQuestion);
    expect(command.helpInformation()).toContain(fixture.examples[0]);

    const completion = walk(program)[0]?.subcommands.find((node) => node.name === 'fixture');
    expect(completion).toBeDefined();
    expect(completion?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(['--mode', '--tag', '--json']),
    );

    const loaded = await importFirst(SPEC_MODULES);
    expect(loaded).not.toBeNull();
    if (loaded === null) return;
    const inventory = Object.entries(loaded.module).find(
      ([name, value]) => /(?:inventory|document)/i.test(name) && typeof value === 'function',
    )?.[1] as ((specs: readonly unknown[]) => unknown) | undefined;
    expect(
      inventory,
      `${loaded.path} must export a docs/inventory projection from CommandSpec`,
    ).toBeFunction();
    if (inventory === undefined) return;
    expect(JSON.stringify(inventory([fixture]))).toContain(fixture.primaryQuestion);

    await program.parseAsync(['node', 'skillsmith', 'fixture', 'sample', '--mode', 'safe']);
    expect(writes.stdout.join('')).toBe('fixture-human\n');
    expect(writes.stderr.join('')).toBe('');
    expect(writes.exits.at(-1) ?? 0).toBe(0);
  });

  test('CommandSpec closes no-argument, fixed, optional, and variadic parser arity', async () => {
    const fixture = (name: string, arguments_: CommandSpec['arguments']): CommandSpec => ({
      name,
      path: `skillsmith ${name}`,
      aliases: [],
      group: 'maintain',
      primaryQuestion: 'Does the declared argument list close parser arity?',
      description: 'Exercise generic CommandSpec argument closure.',
      arguments: arguments_,
      options: [],
      examples: [],
      capability: 'read',
      reportKind: name,
      application: 'help',
    });
    const argument = (
      name: string,
      required: boolean,
      variadic = false,
    ): CommandSpec['arguments'][number] => ({
      name,
      required,
      variadic,
      choices: [],
      defaultValue: undefined,
      description: `${name} fixture argument`,
    });
    const configured = (spec: CommandSpec) =>
      createCommandFromSpec(spec)
        .exitOverride()
        .configureOutput({ writeErr: () => {}, writeOut: () => {} });

    let noArgumentDispatches = 0;
    const noArguments = configured(fixture('no-arguments', []));
    noArguments.action(() => noArgumentDispatches++);
    await expect(
      noArguments.parseAsync(['node', 'no-arguments', 'unexpected']),
    ).rejects.toMatchObject({ code: 'commander.excessArguments' });
    expect(noArgumentDispatches).toBe(0);

    const fixedCalls: unknown[][] = [];
    const fixed = configured(
      fixture('fixed', [argument('required', true), argument('optional', false)]),
    );
    fixed.action((...values) => fixedCalls.push(values.slice(0, -2)));
    await fixed.parseAsync(['node', 'fixed', 'one']);
    await fixed.parseAsync(['node', 'fixed', 'one', 'two']);
    await expect(fixed.parseAsync(['node', 'fixed', 'one', 'two', 'three'])).rejects.toMatchObject({
      code: 'commander.excessArguments',
    });
    expect(fixedCalls).toHaveLength(2);

    const variadicCalls: unknown[][] = [];
    const variadic = configured(fixture('variadic', [argument('items', true, true)]));
    variadic.action((...values) => variadicCalls.push(values.slice(0, -2)));
    await variadic.parseAsync(['node', 'variadic', 'one', 'two', 'three']);
    expect(variadicCalls).toHaveLength(1);
  });

  test('a current command resolves injected application and renderer registries through runtime IO', async () => {
    const writes = { stdout: [] as string[], stderr: [] as string[], exits: [] as number[] };
    let calls = 0;
    const program = buildProgram(undefined, {
      applications: {
        agents: async () => {
          calls++;
          return {
            report: { injected: true },
            diagnostics: [],
            exitClass: 'success',
            mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
            deprecations: [],
          };
        },
      },
      renderers: {
        agents: {
          human: () => 'injected-agents\n',
          json: () => '{"injected":true}\n',
        },
      },
      runtimePorts: {
        stdout: { write: (value) => writes.stdout.push(value) },
        stderr: { write: (value) => writes.stderr.push(value) },
        exit: (code) => writes.exits.push(code),
      },
    });
    await program.parseAsync(['node', 'skillsmith', 'agents']);
    expect(calls).toBe(1);
    expect(writes.stdout).toEqual(['injected-agents\n']);
    expect(writes.stderr).toEqual([]);
    expect(writes.exits).toEqual([0]);
  });

  test('bare root resolves its declared help application through shared runtime IO', async () => {
    const writes = { stdout: [] as string[], stderr: [] as string[], exits: [] as number[] };
    let calls = 0;
    let receivedContext: unknown;
    const program = buildProgram(undefined, {
      applications: {
        rootHelp: async (_request, context) => {
          calls++;
          receivedContext = context;
          return {
            report: { injected: true },
            diagnostics: [],
            exitClass: 'success',
            mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
            deprecations: [],
          };
        },
      },
      renderers: {
        rootHelp: {
          human: () => 'injected-root-help\n',
          json: () => '{"injected":true}\n',
        },
      },
      runtimePorts: {
        stdout: { write: (value) => writes.stdout.push(value) },
        stderr: { write: (value) => writes.stderr.push(value) },
        exit: (code) => writes.exits.push(code),
      },
    });

    await program.parseAsync(['node', 'skillsmith']);
    expect(calls).toBe(1);
    expect(record(receivedContext)).toBeTrue();
    expect(record(receivedContext) ? Object.keys(receivedContext) : []).toEqual(['observation']);
    const observation = record(receivedContext) ? receivedContext.observation : undefined;
    expect(record(observation)).toBeTrue();
    expect(record(observation) ? observation.context : null).toMatchObject({
      command: 'skillsmith',
      workflow: 'rootHelp',
    });
    expect(writes).toEqual({ stdout: ['injected-root-help\n'], stderr: [], exits: [0] });
  });

  test('lifecycle renderers preserve partial reports and item diagnostics on semantic failure', () => {
    const program = buildProgram();
    const renderer = createCurrentRendererRegistry(program).dev;
    expect(renderer).toBeDefined();
    if (renderer === undefined) return;
    const outcome = {
      report: {
        command: 'dev',
        value: {
          op: 'dev',
          dryRun: false,
          requested: { targets: ['example'], all: false, tools: ['codex'], explicitTools: true },
          plan: {
            domain: 'skillsmith.operation-plan',
            schemaVersion: 1,
            command: 'dev',
            selection: {
              source: 'explicit-targets',
              outcome: 'selected',
              targets: ['example'],
              all: false,
              tools: ['codex'],
              scopes: ['user'],
              groupIds: [],
            },
            batchPolicy: 'fail-fast',
            operations: [],
            checks: [],
            diagnostics: [],
          },
          executionResults: [],
          results: [
            {
              skill: 'example',
              tool: 'codex',
              scope: 'user',
              action: 'refused',
              placementPath: null,
              reason: 'no prior state',
              before: null,
              after: null,
              store: null,
              verify: null,
              error: { code: 'flip-refused', message: 'no prior state' },
            },
          ],
          summary: {
            flipped: 0,
            updated: 0,
            noop: 0,
            skipped: 0,
            refused: 1,
            failed: 0,
            rolledBack: 0,
            created: 0,
            adopted: 0,
          },
        },
      },
      diagnostics: [
        { code: 'skillsmith.flip-refused', severity: 'error', message: 'no prior state' },
      ],
      exitClass: 'usage',
      mutation: { kind: 'none', planned: 1, changed: 0, unchanged: 0, failed: 1 },
      deprecations: [],
    } as unknown as RuntimeOutcome;

    const human = renderer.human(outcome);
    const json = renderer.json(outcome);
    const jsonStdout = typeof json === 'string' ? json : (json.stdout ?? '');
    expect(human).toMatchObject({
      stdout: expect.stringContaining('1 refused.  Exit code: 2'),
      stderr: 'error: example (codex): no prior state\n',
    });
    expect(json).toMatchObject({
      stdout: expect.stringContaining('"refused"'),
      stderr: 'error: example (codex): no prior state\n',
    });
    expect(jsonStdout.endsWith('\n')).toBeFalse();
  });

  test('spawned current commands preserve representative human, JSON, and usage-error parity', async () => {
    const [human, json, usage] = await Promise.all([
      runCli(['agents', '--tool', 'ghost']),
      runCli(['agents', '--tool', 'ghost', '--format', 'json']),
      runCli(['verify']),
    ]);
    expect(human).toEqual({
      exitCode: 2,
      stdout: '',
      stderr: "error: unknown tool 'ghost'\n",
    });
    expect(json.exitCode).toBe(2);
    expect(json.stderr).toBe('');
    expect(JSON.parse(json.stdout)).toEqual({
      schemaVersion: 1,
      kind: 'error',
      code: 'invalid-enum',
      message: "unknown tool 'ghost'",
      exitCode: 2,
    });
    expect(usage.exitCode).toBe(2);
    expect(usage.stdout).toBe('');
    expect(usage.stderr).toMatch(/^error: /);
  });

  test('the runtime has one cancellation and noninteractive interaction policy', async () => {
    const runtimeSources = await Promise.all(
      [
        'packages/cli/src/runtime/adapter.ts',
        'packages/cli/src/runtime/interaction.ts',
        'packages/cli/src/runtime/ports.ts',
      ].map(async (path) => (await readMaybe(join(ROOT, path))) ?? ''),
    );
    const runtime = runtimeSources.join('\n');
    expect(runtime).toMatch(/InteractionPort|interaction/);
    expect(runtime).toMatch(/noninteractive|noPrompt|no-prompt/i);
    expect(runtime).toContain('cancelled');
    expect(runtime).toContain('130');
    expect(runtime).toMatch(/isTTY|stdin|stderr/);
    expect(runtime).toMatch(/from ['"]@skillsmith\/core['"]/);
    expect(runtime).not.toMatch(/interface InteractionPort\b/);

    const commandSources = await Promise.all(
      (await typescriptFiles(COMMANDS_ROOT)).map((path) => readFile(path, 'utf8')),
    );
    expect(commandSources.join('\n')).not.toMatch(/@clack\/prompts|\.isTTY|\b130\b/);
  });
});
