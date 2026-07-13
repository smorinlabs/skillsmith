import { describe, expect, test } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { walk } from '../../../packages/cli/src/completion/walk.ts';
import { canonicalizeCommanderTree } from '../../../packages/cli/src/contracts/commander-surface.ts';
import { buildProgram } from '../../../packages/cli/src/program.ts';
import { CLI_ENTRYPOINT } from '../../../packages/cli/tests/fixtures/cli.ts';
import { hermeticGitEnv } from '../../../packages/core/tests/fixtures/git-env.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const COMMANDS_ROOT = join(ROOT, 'packages/cli/src/commands');
const PROGRAM = join(ROOT, 'packages/cli/src/program.ts');
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
    const path = raw.startsWith('skillsmith ') ? raw : `${parent} ${raw}`;
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

    const specPaths = flattenSpecPaths(specs);
    const livePaths = canonicalizeCommanderTree(buildProgram())
      .map((command) => command.path)
      .filter((path) => path !== 'skillsmith');
    expect([...specPaths.keys()].sort()).toEqual([...livePaths].sort());

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

  test('one fixture spec drives parser, help, completion, docs inventory, and execution', async () => {
    const fixture = {
      name: 'fixture',
      aliases: ['fx'],
      group: 'maintain',
      primaryQuestion: 'Does one declaration drive every CLI artifact?',
      description: 'Exercise the generic command-spec boundary.',
      arguments: [{ name: 'item', required: true, variadic: false }],
      options: [
        {
          flags: '--mode <mode>',
          choices: ['fast', 'safe'],
          defaultValue: 'fast',
          repeatable: false,
          negated: false,
        },
        {
          flags: '--tag <tag>',
          choices: [],
          defaultValue: [],
          repeatable: true,
          negated: false,
        },
        {
          flags: '--json',
          choices: [],
          defaultValue: false,
          repeatable: false,
          negated: false,
        },
      ],
      examples: ['skillsmith fixture sample --mode safe'],
      capability: 'read',
      reportKind: 'fixture',
      application: 'fixture',
    } as const;
    const writes = { stdout: [] as string[], stderr: [] as string[], exits: [] as number[] };
    const application = async (request: unknown) => ({
      ok: true as const,
      value: {
        report: request,
        diagnostics: [],
        exitClass: 'success' as const,
        mutation: { changed: false, attempted: 0, completed: 0 },
        deprecations: [],
      },
    });
    const program = (
      buildProgram as unknown as (...args: unknown[]) => ReturnType<typeof buildProgram>
    )(undefined, {
      additionalSpecs: [fixture],
      applications: { fixture: application },
      renderers: {
        fixture: {
          human: () => 'fixture-human\n',
          json: () => '{"kind":"fixture"}\n',
        },
      },
      runtimePorts: {
        stdout: { write: (value: string) => writes.stdout.push(value) },
        stderr: { write: (value: string) => writes.stderr.push(value) },
        exit: (code: number) => writes.exits.push(code),
        interaction: {
          choose: async () => ({ kind: 'unavailable' as const }),
          confirm: async () => ({ kind: 'unavailable' as const }),
        },
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

    const completion = walk(program).find((node) => node.name === 'fixture');
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

    const commandSources = await Promise.all(
      (await typescriptFiles(COMMANDS_ROOT)).map((path) => readFile(path, 'utf8')),
    );
    expect(commandSources.join('\n')).not.toMatch(/@clack\/prompts|\.isTTY|\b130\b/);
  });
});
