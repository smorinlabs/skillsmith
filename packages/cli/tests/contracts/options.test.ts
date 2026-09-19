import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createUpdateFleet,
  destroyUpdateFleet,
  runUpdateCli,
} from '../../../../tests/ergonomics/fixtures/p5-update/fleet.ts';
import {
  resolveTargetSelection,
  validateSelectionRequest,
} from '../../../core/src/selection/resolve.ts';
import type { SelectionPolicy, SelectionRequest } from '../../../core/src/selection/types.ts';
import { hermeticGitEnv } from '../../../core/tests/fixtures/git-env.ts';
import { parseCompletionGraph } from '../../src/completion/adapter.ts';
import {
  CLI_MIGRATION_PROVENANCE,
  assertClosedMigrationLedger,
  migrationLedger,
} from '../../src/contracts/cli-migration-ledger.ts';
import snapshot from '../../src/contracts/commander-surface-v0.7.0.json';
import {
  type CanonicalCommand,
  canonicalizeCommanderTree,
} from '../../src/contracts/commander-surface.ts';
import { buildProgram } from '../../src/program.ts';
import { normalizeCommandSpec } from '../../src/runtime/command-spec.ts';
import { CURRENT_COMMAND_SPECS } from '../../src/spec/index.ts';
import type { CommandSpec, CommandSpecInput } from '../../src/spec/types.ts';
import {
  NON_MUTATING_MODE_POLICIES,
  validateNonMutatingMode,
} from '../../src/util/non-mutating-mode.ts';
import { CLI_ENTRYPOINT } from '../fixtures/cli.ts';

const snapshotTree = async (root: string): Promise<readonly string[]> =>
  (await readdir(root, { recursive: true, encoding: 'utf8' })).sort();

const EMPTY_COMPLETION_PORTS = Object.freeze({
  listDirBounded: async (): Promise<readonly string[]> => [],
  pathKind: async () => 'dir' as const,
  readFileMetadata: async () => ({ kind: 'absent' as const, mode: null, identity: null }),
  readFileSnapshotNoFollow: async () => ({
    bytes: new Uint8Array(),
    metadata: { kind: 'file' as const, mode: 0o600, identity: 'empty', sizeBytes: 0 },
  }),
});

const runHermeticCli = async (
  args: readonly string[],
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<{ code: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn(['bun', CLI_ENTRYPOINT, ...args], {
    cwd,
    env: hermeticGitEnv(env),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  return {
    code,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
};

interface CommandSpecOptionContract {
  readonly flags: string;
  readonly long: string;
  readonly short: string | null;
  readonly attributeName: string;
  readonly valueShape: 'boolean' | 'required' | 'optional';
  readonly knownValues: readonly string[];
  readonly allowedValues: readonly string[];
  readonly repeatable: boolean;
  readonly negated: boolean;
  readonly flagDefault: unknown;
  readonly parsedDefault: unknown;
}

interface CommandSpecContract {
  readonly path: string;
  readonly aliases: readonly string[];
  readonly arguments: readonly {
    readonly name: string;
    readonly required: boolean;
    readonly variadic: boolean;
  }[];
  readonly options: readonly CommandSpecOptionContract[];
}

interface OptionInvocationError {
  readonly exitCode: 2;
  readonly message: string;
}

interface OptionContractApi {
  readonly CURRENT_COMMAND_SPECS: readonly CommandSpecContract[];
  readonly CURRENT_OPTION_RELATIONS: readonly {
    readonly id: string;
    readonly command: string;
    readonly kind:
      | 'conflicts'
      | 'requires'
      | 'distinct-values'
      | 'cardinality'
      | 'exclusive-group'
      | 'scope-consistency';
    readonly options?: readonly string[];
    readonly option?: string;
    readonly requiredOption?: string;
    readonly whenOption?: string;
    readonly subject?: 'positionals' | 'option-occurrences';
    readonly exact?: number;
    readonly maximum?: number;
    readonly description?: string;
    readonly label?: string;
    readonly scopeOption?: string;
    readonly sugars?: readonly { readonly option: string; readonly value: string }[];
  }[];
  validateCurrentCommandSpecs(): readonly string[];
  validateGlobalOptionPermutation(): readonly string[];
  validateCurrentOptionRelations(): readonly string[];
  validateOptionInvocation(
    command: string,
    args: readonly string[],
  ): { readonly ok: true } | { readonly ok: false; readonly error: OptionInvocationError };
}

const OPTION_CONTRACT_MODULE = '../../src/spec/index.ts';

const loadOptionContractApi = async (): Promise<
  | { readonly ok: true; readonly api: OptionContractApi }
  | { readonly ok: false; readonly message: string }
> => {
  try {
    const module = (await import(OPTION_CONTRACT_MODULE)) as Partial<OptionContractApi>;
    if (
      !Array.isArray(module.CURRENT_COMMAND_SPECS) ||
      !Array.isArray(module.CURRENT_OPTION_RELATIONS) ||
      typeof module.validateCurrentCommandSpecs !== 'function' ||
      typeof module.validateGlobalOptionPermutation !== 'function' ||
      typeof module.validateCurrentOptionRelations !== 'function' ||
      typeof module.validateOptionInvocation !== 'function'
    ) {
      return { ok: false, message: 'CommandSpec option-contract exports are incomplete' };
    }
    return { ok: true, api: module as OptionContractApi };
  } catch (error) {
    return {
      ok: false,
      message: `CommandSpec option-contract module is unavailable: ${String(error)}`,
    };
  }
};

const requireOptionContractApi = async (): Promise<OptionContractApi> => {
  const loaded = await loadOptionContractApi();
  expect(loaded.ok, loaded.ok ? undefined : loaded.message).toBeTrue();
  if (!loaded.ok) throw new Error(loaded.message);
  return loaded.api;
};

describe('EWP-OPT-TS01', () => {
  test('historical audit inputs retain their provenance hashes', async () => {
    for (const fixture of [
      CLI_MIGRATION_PROVENANCE.historicalSurface,
      CLI_MIGRATION_PROVENANCE.historicalLedger,
    ]) {
      const bytes = await Bun.file(fixture.path).arrayBuffer();
      expect(new Bun.CryptoHasher('sha256').update(bytes).digest('hex')).toBe(fixture.sha256);
      expect(fixture.immutable).toBeTrue();
    }
  });
  test('live Commander tree closes against evolving state without rewriting history', () => {
    const live = canonicalizeCommanderTree(buildProgram());
    expect(live).not.toEqual(snapshot as readonly CanonicalCommand[]);
    expect(
      live
        .find((command) => command.path === 'skillsmith')
        ?.options.some((option) => option.flags === '--config <file>'),
    ).toBeTrue();
    expect(
      (snapshot as readonly CanonicalCommand[])
        .find((command) => command.path === 'skillsmith')
        ?.options.some((option) => option.flags === '--config <file>'),
    ).toBeFalse();
    expect(() => assertClosedMigrationLedger(live, migrationLedger)).not.toThrow();
    expect(
      migrationLedger.target.find((row) => row.key === 'argument:skillsmith completion:<shell>')
        ?.argument,
    ).toEqual({
      required: true,
      variadic: false,
      choices: ['bash', 'fish', 'zsh'],
      defaultValue: 'unset',
      defaultSource: 'none',
    });
    expect(
      migrationLedger.target.find((row) => row.key === 'argument:skillsmith update:[skill...]')
        ?.argument,
    ).toEqual({
      required: false,
      variadic: true,
      choices: [],
      defaultValue: 'unset',
      defaultSource: 'none',
    });
    expect(
      migrationLedger.target.some((row) => row.key === 'argument:skillsmith update:<skill...>'),
    ).toBeFalse();
  });

  test('rejects missing live surfaces, duplicate mappings, unknown dispositions, and owner gaps', () => {
    const live = canonicalizeCommanderTree(buildProgram());
    expect(() => assertClosedMigrationLedger(live.slice(1), migrationLedger)).toThrow();
    const duplicate = structuredClone(migrationLedger);
    const firstCurrent = duplicate.current[0];
    if (!firstCurrent) throw new Error('fixture current ledger is empty');
    (duplicate.current as (typeof firstCurrent)[]).push({ ...firstCurrent });
    expect(() => assertClosedMigrationLedger(live, duplicate)).toThrow(/duplicates/);
    const unknown = structuredClone(migrationLedger);
    const firstUnknown = unknown.target[0];
    if (!firstUnknown) throw new Error('fixture target ledger is empty');
    firstUnknown.disposition = 'R' as never;
    expect(() => assertClosedMigrationLedger(live, unknown)).toThrow(/target registry/);
    const ownerless = structuredClone(migrationLedger);
    const firstOwnerless = ownerless.target[0];
    if (!firstOwnerless) throw new Error('fixture target ledger is empty');
    firstOwnerless.validationOwner = '';
    expect(() => assertClosedMigrationLedger(live, ownerless)).toThrow(/target registry|ownership/);
    const validDrift = structuredClone(migrationLedger);
    const firstDrift = validDrift.target[0];
    if (!firstDrift) throw new Error('fixture target ledger is empty');
    firstDrift.disposition = firstDrift.disposition === 'K' ? 'N' : 'K';
    expect(() => assertClosedMigrationLedger(live, validDrift)).toThrow(/target registry/);
    const removed = structuredClone(migrationLedger);
    (removed.target as (typeof removed.target)[number][]).pop();
    expect(() => assertClosedMigrationLedger(live, removed)).toThrow(/target registry/);
    for (const [key, wrong] of [
      ['option:skillsmith agents:--json', 'K'],
      ['argument:skillsmith dev:<target...>', 'K'],
      ['option:skillsmith:--no-prompt', 'N'],
    ] as const) {
      const mutated = structuredClone(migrationLedger);
      const entry = mutated.target.find((row) => row.key === key);
      if (!entry) throw new Error(`fixture target missing ${key}`);
      entry.disposition = wrong;
      expect(() => assertClosedMigrationLedger(live, mutated)).toThrow(/target registry/);
    }
    for (const field of ['disposition', 'phase'] as const) {
      const mutated = structuredClone(migrationLedger);
      const entry = mutated.current[0];
      if (!entry) throw new Error('fixture current ledger is empty');
      if (field === 'disposition') entry.disposition = entry.disposition === 'K' ? 'C' : 'K';
      else entry.phase = 'P17-NONSENSE';
      expect(() => assertClosedMigrationLedger(live, mutated)).toThrow(/current ledger metadata/);
    }
    for (const field of ['defaultSource', 'defaultValue', 'negated'] as const) {
      const mutated = structuredClone(migrationLedger);
      const entry = mutated.current.find((row) => row.option);
      if (!entry?.option) throw new Error('fixture current option is missing');
      if (field === 'defaultSource') entry.option.defaultSource = 'none';
      else if (field === 'defaultValue') entry.option.defaultValue = 'wrong';
      else entry.option.negated = !entry.option.negated;
      expect(() => assertClosedMigrationLedger(live, mutated)).toThrow(/current ledger metadata/);
    }
    const argumentMutations = [
      ['argument:skillsmith completion:<shell>', 'choices'],
      ['argument:skillsmith verify:<path>', 'required'],
      ['argument:skillsmith install:<source...>', 'variadic'],
      ['argument:skillsmith update:[skill...]', 'required'],
    ] as const;
    for (const [key, field] of argumentMutations) {
      const mutated = structuredClone(migrationLedger);
      const entry = mutated.target.find((row) => row.key === key);
      if (!entry?.argument) throw new Error(`fixture target argument missing: ${key}`);
      if (field === 'choices') entry.argument.choices = ['powershell'];
      else entry.argument[field] = !entry.argument[field];
      expect(() => assertClosedMigrationLedger(live, mutated)).toThrow(/target registry/);
    }
    const currentArgumentGhost = structuredClone(migrationLedger);
    const verifyPath = currentArgumentGhost.current.find(
      (row) => row.key === 'argument:skillsmith verify:path',
    );
    if (!verifyPath?.argument) throw new Error('current verify path argument metadata is missing');
    verifyPath.argument.choices = ['ghost'];
    expect(() =>
      assertClosedMigrationLedger(live, currentArgumentGhost, currentArgumentGhost.current),
    ).toThrow(/current argument metadata/);
  });

  test('an atomic Phase-1 current-state migration succeeds without rewriting history', () => {
    const live = structuredClone(canonicalizeCommanderTree(buildProgram()));
    const root = live.find((command) => command.path === 'skillsmith');
    if (!root) throw new Error('live root command missing');
    const options = root.options as (typeof root.options)[number][];
    const debug = options.findIndex((option) => option.long === '--debug');
    if (debug < 0) throw new Error('live debug option missing');
    options.splice(debug, 1);

    const migrated = structuredClone(migrationLedger);
    const current = migrated.current as (typeof migrated.current)[number][];
    const debugLedger = current.findIndex((entry) => entry.key === 'option:skillsmith:--debug');
    if (debugLedger < 0) throw new Error('current debug entry missing');
    current.splice(debugLedger, 1);
    const updatedAuthority = structuredClone(current);
    expect(() => assertClosedMigrationLedger(live, migrated, updatedAuthority)).not.toThrow();
    expect(() => assertClosedMigrationLedger(live, migrated, migrationLedger.current)).toThrow(
      /evolving current-state/,
    );
  });

  test('rejects same-key live option semantic drift against evolving current state', () => {
    const mutateOption = (
      path: string,
      long: string,
      mutate: (
        option: ReturnType<typeof canonicalizeCommanderTree>[number]['options'][number],
      ) => void,
    ): void => {
      const live = structuredClone(canonicalizeCommanderTree(buildProgram()));
      const option = live
        .find((command) => command.path === path)
        ?.options.find((candidate) => candidate.long === long);
      if (!option) throw new Error(`live option missing: ${path} ${long}`);
      mutate(option);
      expect(() => assertClosedMigrationLedger(live, migrationLedger)).toThrow(
        /current option metadata/,
      );
    };

    mutateOption('skillsmith verify', '--tool', (option) => {
      option.choices = ['ghost'];
    });
    mutateOption('skillsmith', '--debug', (option) => {
      option.defaultValue = true;
    });
    mutateOption('skillsmith', '--verbose', (option) => {
      option.repeatable = false;
    });
    mutateOption('skillsmith check', '--scope', (option) => {
      option.requiredValue = false;
      option.optionalValue = true;
    });
    mutateOption('skillsmith', '--no-prompt', (option) => {
      option.negated = false;
    });
  });
});

describe('EWP-OPT-TS02', () => {
  test('one declarative registry closes every current command path and alias', async () => {
    const api = await requireOptionContractApi();
    expect(api.validateCurrentCommandSpecs()).toEqual([]);
    expect(api.validateGlobalOptionPermutation()).toEqual([]);

    const live = canonicalizeCommanderTree(buildProgram());
    expect(api.CURRENT_COMMAND_SPECS.map((spec) => spec.path).sort()).toEqual(
      live.map((command) => command.path).sort(),
    );
    for (const command of live) {
      const spec = api.CURRENT_COMMAND_SPECS.find((candidate) => candidate.path === command.path);
      expect(spec, command.path).toBeDefined();
      expect([...(spec?.aliases ?? [])].sort(), command.path).toEqual([...command.aliases].sort());
    }
  });

  test('known enums, allowed capabilities, repetition, and semantic defaults stay distinct', async () => {
    const api = await requireOptionContractApi();
    const option = (path: string, long: string): CommandSpecOptionContract => {
      const value = api.CURRENT_COMMAND_SPECS.find((spec) => spec.path === path)?.options.find(
        (candidate) => candidate.long === long,
      );
      if (!value) throw new Error(`missing CommandSpec option ${path} ${long}`);
      return value;
    };

    expect(option('skillsmith', '--verbose')).toMatchObject({
      valueShape: 'boolean',
      repeatable: true,
      parsedDefault: 0,
    });
    expect(option('skillsmith', '--color')).toMatchObject({
      valueShape: 'required',
      knownValues: ['auto', 'always', 'never'],
      repeatable: false,
      parsedDefault: 'auto',
    });
    expect(option('skillsmith', '--no-prompt')).toMatchObject({
      attributeName: 'prompt',
      negated: true,
      flagDefault: false,
      parsedDefault: true,
    });
    expect(option('skillsmith install', '--no-verify')).toMatchObject({
      attributeName: 'verify',
      negated: true,
      flagDefault: false,
      parsedDefault: true,
    });
    expect(option('skillsmith list', '--tool')).toMatchObject({
      knownValues: ['claude-code', 'codex', 'kilo-code', 'opencode'],
      allowedValues: ['claude-code', 'codex', 'kilo-code', 'opencode'],
      repeatable: true,
    });
    expect(option('skillsmith commands', '--scope')).toMatchObject({
      knownValues: ['system', 'user', 'project', 'managed'],
      allowedValues: ['user', 'project'],
      repeatable: false,
    });
    expect(option('skillsmith status', '--tool')).toMatchObject({
      knownValues: ['claude-code', 'codex', 'kilo-code', 'opencode'],
      allowedValues: ['claude-code', 'codex', 'kilo-code', 'opencode'],
      repeatable: true,
    });
    expect(option('skillsmith status', '--scope')).toMatchObject({
      knownValues: ['system', 'user', 'project', 'managed'],
      allowedValues: ['system', 'user', 'project', 'managed'],
      repeatable: false,
    });
  });

  test('inherited negated globals are singular and parse in either command position', async () => {
    const program = buildProgram();
    const rootOptions = new Set(program.options.map((option) => option.long));
    expect(rootOptions.has('--no-color')).toBeTrue();
    expect(rootOptions.has('--no-prompt')).toBeTrue();
    for (const commandName of ['install', 'uninstall', 'dev', 'promote']) {
      const command = program.commands.find((candidate) => candidate.name() === commandName);
      expect(
        command?.options.some((option) => option.long === '--no-prompt'),
        commandName,
      ).toBeFalse();
    }

    const cwd = process.cwd();
    const env = { CI: '1', NO_COLOR: '1' };
    const before = await runHermeticCli(['--no-prompt', 'version'], cwd, env);
    const after = await runHermeticCli(['version', '--no-prompt'], cwd, env);
    expect(before).toMatchObject({ code: 0, stderr: '' });
    expect(after).toEqual(before);
    const noColor = await runHermeticCli(['--no-color', 'version'], cwd, env);
    expect(noColor).toMatchObject({ code: 0, stderr: '' });
  });

  test('current stable aliases and repeatable parser behavior remain exact', () => {
    const program = buildProgram();
    const aliases = Object.fromEntries(
      program.commands.map((command) => [command.name(), [...command.aliases()].sort()]),
    );
    expect(aliases).toMatchObject({
      list: ['ls'],
      install: ['i'],
      uninstall: ['remove', 'rm'],
      dev: ['demote'],
    });

    const install = program.commands.find((command) => command.name() === 'install');
    const verify = program.commands.find((command) => command.name() === 'verify');
    expect(install?.optsWithGlobals()).toMatchObject({ verify: true, prompt: true, tool: [] });
    expect(verify?.opts()).toMatchObject({ tool: [] });
  });
});

describe('EWP-OPT-TS03', () => {
  test('the relation registry is exhaustive and independently self-validating', async () => {
    const api = await requireOptionContractApi();
    expect(api.validateCurrentOptionRelations()).toEqual([]);
    const commands = new Set(api.CURRENT_OPTION_RELATIONS.map((relation) => relation.command));
    for (const command of [
      'skillsmith',
      'skillsmith list',
      'skillsmith commands',
      'skillsmith doctor',
      'skillsmith check',
      'skillsmith status',
      'skillsmith sync',
      'skillsmith verify',
      'skillsmith install',
      'skillsmith uninstall',
      'skillsmith dev',
      'skillsmith promote',
    ]) {
      expect(commands.has(command), `missing relations for ${command}`).toBeTrue();
    }
    expect(new Set(api.CURRENT_OPTION_RELATIONS.map((relation) => relation.id)).size).toBe(
      api.CURRENT_OPTION_RELATIONS.length,
    );
    for (const relation of api.CURRENT_OPTION_RELATIONS) {
      if (relation.kind === 'conflicts' || relation.kind === 'exclusive-group') {
        expect(relation.options?.length, relation.id).toBeGreaterThan(1);
      } else if (relation.kind === 'requires') {
        expect(relation.option, relation.id).toMatch(/^(?:--|\$command$)/);
        expect(relation.requiredOption, relation.id).toMatch(/^--/);
      } else if (relation.kind === 'distinct-values') {
        expect(relation.option, relation.id).toMatch(/^--/);
      } else if (relation.kind === 'scope-consistency') {
        expect(relation.scopeOption, relation.id).toBe('--scope');
        expect(relation.sugars?.length, relation.id).toBeGreaterThan(0);
      } else {
        expect(relation.whenOption, relation.id).toMatch(/^--/);
        expect(relation.subject, relation.id).toMatch(/positionals|option-occurrences/);
      }
    }
  });

  test('the generic validator is connected to the declarative relation records', async () => {
    const api = await requireOptionContractApi();
    const relations = api.CURRENT_OPTION_RELATIONS as {
      id: string;
      command: string;
      kind:
        | 'conflicts'
        | 'requires'
        | 'distinct-values'
        | 'cardinality'
        | 'exclusive-group'
        | 'scope-consistency';
    }[];
    const index = relations.findIndex(
      (relation) => relation.command === 'skillsmith verify' && relation.kind === 'conflicts',
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const removed = relations.splice(index, 1)[0];
    try {
      expect(api.validateCurrentOptionRelations()).toContain(
        'missing current option relations for skillsmith verify',
      );
      expect(api.validateOptionInvocation('skillsmith verify', ['--static', '--deep'])).toEqual({
        ok: true,
      });
    } finally {
      if (removed !== undefined) relations.splice(index, 0, removed);
    }
    expect(
      api.validateOptionInvocation('skillsmith verify', ['--static', '--deep']).ok,
    ).toBeFalse();
  });

  test('the required relation contract detects exact and nearby root relation deletions', async () => {
    const api = await requireOptionContractApi();
    const relations = api.CURRENT_OPTION_RELATIONS as {
      id: string;
      command: string;
      kind: string;
      options?: readonly string[];
    }[];
    for (const [left, right] of [
      ['--quiet', '--debug'],
      ['--quiet', '--verbose'],
    ] as const) {
      const index = relations.findIndex(
        (relation) =>
          relation.command === 'skillsmith' &&
          relation.kind === 'conflicts' &&
          relation.options?.includes(left) === true &&
          relation.options.includes(right),
      );
      expect(index, `${left}/${right} fixture`).toBeGreaterThanOrEqual(0);
      const removed = relations.splice(index, 1)[0];
      if (removed === undefined) throw new Error(`${left}/${right} relation fixture is missing`);
      try {
        expect(api.validateCurrentOptionRelations()).toContain(
          `missing required current option relation ${removed.id}`,
        );
        expect(api.validateOptionInvocation('skillsmith', [left, right])).toEqual({ ok: true });
      } finally {
        relations.splice(index, 0, removed);
      }
      expect(api.validateOptionInvocation('skillsmith', [left, right]).ok).toBeFalse();
    }
    expect(api.validateCurrentOptionRelations()).toEqual([]);
  });

  test('relation validation rejects unknown commands, operands, and incoherent cardinality', async () => {
    const api = await requireOptionContractApi();
    const relations =
      api.CURRENT_OPTION_RELATIONS as (typeof api.CURRENT_OPTION_RELATIONS)[number][];
    const baseline = relations.length;
    try {
      relations.push({
        id: 'mutation.unknown-command',
        command: 'skillsmith ghost',
        kind: 'conflicts',
        options: ['--quiet', '--verbose'],
        description: 'mutation fixture',
      });
      expect(api.validateCurrentOptionRelations()).toContain(
        'mutation.unknown-command references unknown command skillsmith ghost',
      );
      relations.pop();

      relations.push({
        id: 'mutation.unknown-operand',
        command: 'skillsmith doctor',
        kind: 'conflicts',
        options: ['--all-tools', '--ghost'],
        description: 'mutation fixture',
      });
      expect(api.validateCurrentOptionRelations()).toContain(
        'mutation.unknown-operand has unknown option --ghost',
      );
      relations.pop();

      relations.push({
        id: 'mutation.bad-cardinality',
        command: 'skillsmith dev',
        kind: 'cardinality',
        subject: 'option-occurrences',
        whenOption: '--dest',
        exact: 1,
        maximum: 2,
        label: 'mutation fixture',
        description: 'mutation fixture',
      });
      expect(api.validateCurrentOptionRelations()).toEqual(
        expect.arrayContaining([
          'mutation.bad-cardinality must have one non-negative integer cardinality bound',
          'mutation.bad-cardinality option-occurrences cardinality must name an option',
        ]),
      );
      relations.pop();

      for (const subject of ['ghost', '', null] as const) {
        relations.push({
          id: `mutation.bad-cardinality-subject.${String(subject)}`,
          command: 'skillsmith dev',
          kind: 'cardinality',
          subject,
          whenOption: '--dest',
          option: '--tool',
          exact: 1,
          label: 'mutation fixture',
          description: 'mutation fixture',
        } as unknown as (typeof relations)[number]);
        expect(api.validateCurrentOptionRelations()).toContain(
          `mutation.bad-cardinality-subject.${String(subject)} has unknown cardinality subject ${String(subject)}`,
        );
        relations.pop();
      }

      const cardinality = relations.find(
        (relation) =>
          relation.id === 'skillsmith.dev.dest.one-tool' && relation.kind === 'cardinality',
      );
      if (cardinality === undefined) throw new Error('cardinality mutation fixture is missing');
      const mutableCardinality = cardinality as unknown as { subject: unknown };
      const originalSubject = mutableCardinality.subject;
      mutableCardinality.subject = 'ghost';
      try {
        expect(api.validateCurrentOptionRelations()).toEqual(
          expect.arrayContaining([
            'skillsmith.dev.dest.one-tool does not match the required current option relation contract',
            'skillsmith.dev.dest.one-tool has unknown cardinality subject ghost',
          ]),
        );
      } finally {
        mutableCardinality.subject = originalSubject;
      }

      relations.push({
        id: 'mutation.bad-scope-consistency',
        command: 'skillsmith doctor',
        kind: 'scope-consistency',
        scopeOption: '--user',
        sugars: [{ option: '--scope', value: 'ghost' }],
        description: 'mutation fixture',
      });
      expect(api.validateCurrentOptionRelations()).toEqual(
        expect.arrayContaining([
          'mutation.bad-scope-consistency scope option must accept a value',
          'mutation.bad-scope-consistency scope shorthand --scope must be boolean',
          'mutation.bad-scope-consistency has unsupported scope shorthand value ghost',
          "mutation.bad-scope-consistency does not close the command's scope shorthands",
        ]),
      );
      relations.pop();

      relations.push({
        id: 'mutation.bad-distinct-values.boolean',
        command: 'skillsmith doctor',
        kind: 'distinct-values',
        option: '--all-tools',
        description: 'mutation fixture',
      });
      expect(api.validateCurrentOptionRelations()).toEqual(
        expect.arrayContaining([
          'mutation.bad-distinct-values.boolean option --all-tools must accept a value',
          'mutation.bad-distinct-values.boolean option --all-tools must be repeatable',
        ]),
      );
      relations.pop();

      relations.push({
        id: 'mutation.bad-distinct-values.singular',
        command: 'skillsmith doctor',
        kind: 'distinct-values',
        option: '--scope',
        description: 'mutation fixture',
      });
      expect(api.validateCurrentOptionRelations()).toContain(
        'mutation.bad-distinct-values.singular option --scope must be repeatable',
      );
      relations.pop();

      relations.push({
        id: 'mutation.bad-distinct-values.unknown',
        command: 'skillsmith doctor',
        kind: 'distinct-values',
        option: '--ghost',
        description: 'mutation fixture',
      });
      expect(api.validateCurrentOptionRelations()).toContain(
        'mutation.bad-distinct-values.unknown has unknown option --ghost',
      );
    } finally {
      relations.splice(baseline);
    }
    expect(api.validateCurrentOptionRelations()).toEqual([]);
  });

  test('scope consistency retains read agreement while lifecycle forms are exclusive', async () => {
    const api = await requireOptionContractApi();
    const agreementCommands = [
      ['skillsmith list', ['user', 'project', 'system', 'managed']],
      ['skillsmith commands', ['user', 'project']],
      ['skillsmith doctor', ['user', 'project', 'system']],
      ['skillsmith check', ['user', 'project', 'system']],
      ['skillsmith status', ['system', 'user', 'project', 'managed']],
    ] as const;

    for (const [command, scopes] of agreementCommands) {
      const [selected, other] = scopes;
      if (selected === undefined || other === undefined) throw new Error(`${command} fixture gap`);
      expect(
        api.validateOptionInvocation(command, ['--scope', selected, `--${selected}`]),
        `${command} agreeing long scope`,
      ).toEqual({ ok: true });
      expect(
        api.validateOptionInvocation(command, [`--${selected}`, `-s${selected}`]),
        `${command} agreeing attached short scope`,
      ).toEqual({ ok: true });
      expect(
        api.validateOptionInvocation(command, ['--scope', other, `--${selected}`]).ok,
        `${command} disagreeing scope`,
      ).toBeFalse();
      expect(
        api.validateOptionInvocation(command, [`--${selected}`, `--${other}`]).ok,
        `${command} multiple scope shorthands`,
      ).toBeFalse();
    }

    for (const command of ['skillsmith install', 'skillsmith uninstall'] as const) {
      for (const scope of ['user', 'project'] as const) {
        expect(
          api.validateOptionInvocation(command, ['--scope', scope, `--${scope}`]).ok,
          `${command} equivalent mixed scope forms`,
        ).toBeFalse();
        expect(
          api.validateOptionInvocation(command, [`--${scope}`, `-s${scope}`]).ok,
          `${command} equivalent attached mixed scope forms`,
        ).toBeFalse();
      }
      expect(
        api.validateOptionInvocation(command, ['--user', '--project']).ok,
        `${command} multiple scope shorthands`,
      ).toBeFalse();
    }

    const relations =
      api.CURRENT_OPTION_RELATIONS as (typeof api.CURRENT_OPTION_RELATIONS)[number][];
    const listScope = relations.find(
      (relation) => relation.command === 'skillsmith list' && relation.kind === 'scope-consistency',
    );
    const sugars = listScope?.sugars as { option: string; value: string }[] | undefined;
    const removed = sugars?.pop();
    try {
      expect(api.validateCurrentOptionRelations()).toContain(
        "skillsmith.list.scope-consistency does not close the command's scope shorthands",
      );
      expect(
        api.validateOptionInvocation('skillsmith list', ['--managed', '--user']).ok,
      ).toBeTrue();
    } finally {
      if (removed !== undefined) sugars?.push(removed);
    }
    expect(api.validateOptionInvocation('skillsmith list', ['--managed', '--user']).ok).toBeFalse();

    const configRoot = await mkdtemp(join(tmpdir(), 'skillsmith-scope-relations-'));
    const configDir = join(configRoot, 'skillsmith');
    await mkdir(configDir, { recursive: true });
    try {
      const env = { CI: '1', NO_COLOR: '1', XDG_CONFIG_HOME: configRoot };
      const agreeing = await runHermeticCli(
        ['list', '--scope', 'user', '--user', '--json'],
        process.cwd(),
        env,
      );
      expect(agreeing).toMatchObject({ code: 0, stderr: '' });

      await writeFile(join(configDir, 'config.toml'), 'garbage = nope bar\n');
      for (const args of [
        ['list', '--scope', 'project', '--user', '--json'],
        ['commands', '--scope', 'project', '--user', '--json'],
        ['doctor', '--scope', 'project', '--user', '--json'],
        ['check', '--scope', 'project', '--user', '--json'],
        ['install', 'source', '--scope', 'project', '--user', '--json', '--no-prompt'],
        ['uninstall', 'target', '--scope', 'project', '--user', '--json', '--no-prompt'],
      ] as const) {
        const result = await runHermeticCli(args, process.cwd(), env);
        expect(result.code, args[0]).toBe(2);
        expect(result.stderr, args[0]).toBe('');
        const expected =
          args[0] === 'install' || args[0] === 'uninstall'
            ? '--scope cannot be combined with --user'
            : '--scope project cannot be combined with --user';
        expect(JSON.parse(result.stdout).message, args[0]).toContain(expected);
      }
    } finally {
      await rm(configRoot, { recursive: true, force: true });
    }
  }, 20_000);

  test('combined short booleans and attached short values match Commander semantics', async () => {
    const api = await requireOptionContractApi();
    expect(api.validateOptionInvocation('skillsmith', ['-qv']).ok).toBeFalse();
    expect(
      api.validateOptionInvocation('skillsmith doctor', ['--all-tools', '-tcodex']).ok,
    ).toBeFalse();
    expect(
      api.validateOptionInvocation('skillsmith dev', ['target', '-tcodex', '--dest', '/tmp/x']),
    ).toEqual({ ok: true });

    const relations =
      api.CURRENT_OPTION_RELATIONS as (typeof api.CURRENT_OPTION_RELATIONS)[number][];
    const index = relations.findIndex(
      (relation) =>
        relation.command === 'skillsmith' &&
        relation.kind === 'conflicts' &&
        relation.options?.includes('--quiet') &&
        relation.options.includes('--verbose'),
    );
    const removed = relations.splice(index, 1)[0];
    try {
      expect(api.validateOptionInvocation('skillsmith', ['-qv'])).toEqual({ ok: true });
    } finally {
      if (removed !== undefined) relations.splice(index, 0, removed);
    }
    expect(api.validateOptionInvocation('skillsmith', ['-qv']).ok).toBeFalse();

    const cwd = process.cwd();
    const env = { CI: '1', NO_COLOR: '1' };
    const root = await runHermeticCli(['version', '-qv'], cwd, env);
    expect(root).toMatchObject({ code: 2, stdout: '' });
    expect(root.stderr).toContain('--quiet cannot be combined with --verbose');

    const doctor = await runHermeticCli(['doctor', '--all-tools', '-tcodex', '--json'], cwd, env);
    expect(doctor).toMatchObject({ code: 2, stderr: '' });
    expect(JSON.parse(doctor.stdout)).toMatchObject({
      message: '--all-tools cannot be combined with --tool',
      exitCode: 2,
    });

    const dev = await runHermeticCli(
      ['dev', 'target', '-tcodex', '--dest', '/tmp/x', '--dry-run', '--json', '--no-prompt'],
      cwd,
      env,
    );
    expect(`${dev.stdout}${dev.stderr}`).not.toContain('--dest requires exactly one --tool');
  }, 20_000);

  test('every current conflict and requirement rejects through one pure preflight', async () => {
    const api = await requireOptionContractApi();
    const cases = [
      ['skillsmith', ['--quiet', '--verbose']],
      ['skillsmith', ['--quiet', '--debug']],
      ['skillsmith', ['--color', 'always', '--no-color']],
      ['skillsmith list', ['--enabled', '--disabled']],
      ['skillsmith commands', ['--disabled', '--unconfigured']],
      ['skillsmith doctor', ['--all-tools', '--tool', 'codex']],
      ['skillsmith doctor', ['--lockfile', 'custom.lock']],
      ['skillsmith check', ['--report-only', '--exit-code']],
      ['skillsmith check', ['--all-tools', '--tool', 'codex']],
      ['skillsmith status', ['--lockfile', 'custom.lock']],
      ['skillsmith status', ['--system', '--user']],
      ['skillsmith verify', ['--static', '--deep']],
      ['skillsmith install', ['source', '--deep', '--no-verify']],
      ['skillsmith install', ['one', 'two', '--ref', 'main']],
      ['skillsmith install', ['one', 'two', '--path', './skills']],
      ['skillsmith install', ['source', '--no-save', '--file', 'skillsmith.toml']],
      ['skillsmith install', ['source', '--no-save', '--lockfile', 'skillsmith.lock']],
      ['skillsmith install', ['source', '--lockfile', 'skillsmith.lock']],
      ['skillsmith install', ['source', '--scope', 'user', '--user']],
      ['skillsmith install', ['source', '--scope', 'user', '--project']],
      ['skillsmith install', ['source', '--yes', '--dry-run']],
      ['skillsmith uninstall', ['skill', '--no-save', '--file', 'skillsmith.toml']],
      ['skillsmith uninstall', ['skill', '--no-save', '--lockfile', 'skillsmith.lock']],
      ['skillsmith uninstall', ['skill', '--lockfile', 'skillsmith.lock']],
      ['skillsmith uninstall', ['skill', '--scope', 'project', '--project']],
      ['skillsmith uninstall', ['skill', '--all-scopes', '--project']],
      ['skillsmith uninstall', ['skill', '--yes', '--dry-run']],
      ['skillsmith dev', ['target', '--all']],
      ['skillsmith dev', ['target', '--yes', '--dry-run']],
      ['skillsmith dev', ['target', '--rollback', '--source', '/tmp/source']],
      ['skillsmith dev', ['one', 'two', '--source', '/tmp/source']],
      ['skillsmith dev', ['target', '--dest', '/tmp/dest']],
      ['skillsmith promote', ['target', '--rollback', '--allow-dirty']],
      ['skillsmith promote', ['target', '--all']],
      ['skillsmith promote', ['target', '--yes', '--dry-run']],
    ] as const;

    for (const [command, args] of cases) {
      const result = api.validateOptionInvocation(command, args);
      expect(result.ok, `${command} ${args.join(' ')}`).toBeFalse();
      if (result.ok) throw new Error(`invalid option relation passed: ${command}`);
      expect(result.error.exitCode).toBe(2);
      expect(result.error.message).toMatch(/--|target|source|tool/i);
    }
  });

  test('symmetric conflicts reject in both orders before live command work', async () => {
    const api = await requireOptionContractApi();
    for (const [command, left, right] of [
      ['skillsmith', ['--quiet'], ['--verbose']],
      ['skillsmith', ['--quiet'], ['--debug']],
      ['skillsmith check', ['--report-only'], ['--exit-code']],
      ['skillsmith verify', ['--static'], ['--deep']],
      ['skillsmith install', ['source', '--deep'], ['--no-verify']],
      ['skillsmith install', ['source', '--no-save'], ['--file', 'skillsmith.toml']],
      ['skillsmith install', ['source', '--no-save'], ['--lockfile', 'skillsmith.lock']],
      ['skillsmith install', ['source', '--scope', 'user'], ['--user']],
      ['skillsmith uninstall', ['skill', '--no-save'], ['--file', 'skillsmith.toml']],
      ['skillsmith uninstall', ['skill', '--no-save'], ['--lockfile', 'skillsmith.lock']],
      ['skillsmith uninstall', ['skill', '--scope', 'project'], ['--project']],
    ] as const) {
      for (const args of [
        [...left, ...right],
        [...right, ...left],
      ]) {
        expect(
          api.validateOptionInvocation(command, args).ok,
          `${command} ${args.join(' ')}`,
        ).toBeFalse();
      }
    }
  });

  test('lifecycle singular options and path source cardinality are registry-owned', async () => {
    const api = await requireOptionContractApi();
    const repeated = [
      ['skillsmith install', ['source', '--file', 'one.toml', '--file', 'two.toml']],
      [
        'skillsmith install',
        ['source', '--file', 'state.toml', '--lockfile', 'one.lock', '--lockfile', 'two.lock'],
      ],
      ['skillsmith install', ['source', '--ref', 'one', '--ref', 'two']],
      ['skillsmith install', ['source', '--path', './one', '--path', './two']],
      ['skillsmith install', ['source', '--scope', 'user', '--scope', 'user']],
      ['skillsmith uninstall', ['skill', '--file', 'one.toml', '--file', 'two.toml']],
      [
        'skillsmith uninstall',
        ['skill', '--file', 'state.toml', '--lockfile', 'one.lock', '--lockfile', 'two.lock'],
      ],
      ['skillsmith uninstall', ['skill', '--scope', 'project', '--scope', 'project']],
      ['skillsmith plan', ['--file', 'one.toml', '--file', 'two.toml']],
      [
        'skillsmith plan',
        ['--file', 'state.toml', '--lockfile', 'one.lock', '--lockfile', 'two.lock'],
      ],
      ['skillsmith plan', ['--scope', 'user', '--scope', 'user']],
      ['skillsmith plan', ['--user', '--user']],
      ['skillsmith plan', ['--project', '--project']],
      ['skillsmith plan', ['--out', 'one.plan', '--out', 'two.plan']],
    ] as const;

    for (const [command, args] of repeated) {
      const result = api.validateOptionInvocation(command, args);
      expect(result.ok, `${command} ${args.join(' ')}`).toBeFalse();
      if (result.ok) throw new Error(`repeated singular option passed: ${command}`);
      expect(result.error.message).toContain('may only be specified once');
    }

    expect(
      api.validateOptionInvocation('skillsmith install', [
        'source',
        '--path',
        './skills',
        '--tool',
        'codex',
        '--tool',
        'codex',
      ]),
      'duplicate tools remain valid for downstream registry-order deduplication',
    ).toEqual({ ok: true });
  });

  test('observed live parser gaps fail with the intended relation instead of continuing', async () => {
    const cwd = process.cwd();
    const env = { CI: '1', NO_COLOR: '1' };
    for (const args of [
      ['version', '--quiet', '--verbose'],
      ['version', '--quiet', '--debug'],
    ]) {
      const result = await runHermeticCli(args, cwd, env);
      expect(result.code, args.join(' ')).toBe(2);
      expect(result.stderr, args.join(' ')).toContain('--quiet');
    }

    const verify = await runHermeticCli(['verify', '.', '--static', '--deep', '--json'], cwd, env);
    expect(verify.code).toBe(2);
    expect(verify.stderr).toBe('');
    const error = JSON.parse(verify.stdout) as { message?: string; exitCode?: number };
    expect(error.exitCode).toBe(2);
    expect(error.message).toContain('--static');
    expect(error.message).toContain('--deep');

    for (const formatArgs of [['--format', 'json'], ['--format=json']] as const) {
      const agents = await runHermeticCli(
        ['agents', ...formatArgs, '--quiet', '--verbose'],
        cwd,
        env,
      );
      expect(agents.code, formatArgs.join(' ')).toBe(2);
      expect(agents.stderr, formatArgs.join(' ')).toBe('');
      expect(JSON.parse(agents.stdout), formatArgs.join(' ')).toMatchObject({
        schemaVersion: 1,
        kind: 'error',
        code: 'usage',
        message: '--quiet cannot be combined with --verbose',
        exitCode: 2,
      });
    }

    const commandNamedConfigValue = await runHermeticCli(
      ['--config', 'install', 'install', 'source', '--ref', 'main', '--no-prompt'],
      cwd,
      env,
    );
    expect(commandNamedConfigValue.code).toBe(2);
    expect(`${commandNamedConfigValue.stdout}${commandNamedConfigValue.stderr}`).not.toContain(
      '--ref requires exactly one source',
    );
  }, 20_000);
});

describe('EWP-OPT-TS04', () => {
  test('current mutation commands expose one truthful preview, approval, prompt, and output family', () => {
    const program = buildProgram();
    for (const commandName of ['install', 'uninstall', 'dev', 'promote'] as const) {
      const command = program.commands.find((candidate) => candidate.name() === commandName);
      if (!command) throw new Error(`live command missing: ${commandName}`);
      const options = new Set(
        [program, command].flatMap((owner) => owner.options.map((option) => option.long)),
      );
      for (const option of ['--dry-run', '--yes', '--no-prompt', '--json']) {
        expect(options.has(option)).toBeTrue();
      }
      if (commandName === 'install' || commandName === 'uninstall') {
        const approval = command.options.find((option) => option.long === '--yes');
        expect(approval?.description).toContain('Approve');
        expect(approval?.description).not.toContain('no-op');
      }
      expect(Object.hasOwn(NON_MUTATING_MODE_POLICIES, commandName)).toBeTrue();
    }
    for (const commandName of ['dev', 'promote'] as const) {
      const command = program.commands.find((candidate) => candidate.name() === commandName);
      expect(
        command?.options.some((option) => option.long === '--continue-on-error'),
        `${commandName} must expose its G3B-02 scheduler policy`,
      ).toBeTrue();
    }
    expect(
      program.commands
        .find((candidate) => candidate.name() === 'uninstall')
        ?.options.some((option) => option.long === '--continue-on-error'),
      'uninstall exposes its G4A-01-owned public scheduler option',
    ).toBeTrue();
  });

  test('G4A-01 adds exactly eight approved lifecycle options with semantic defaults', async () => {
    const api = await requireOptionContractApi();
    const expected = [
      {
        path: 'skillsmith install',
        flags: '--file <path>',
        long: '--file',
        short: null,
        attributeName: 'file',
        valueShape: 'required',
        negated: false,
        flagDefault: undefined,
        parsedDefault: undefined,
      },
      {
        path: 'skillsmith install',
        flags: '--lockfile <path>',
        long: '--lockfile',
        short: null,
        attributeName: 'lockfile',
        valueShape: 'required',
        negated: false,
        flagDefault: undefined,
        parsedDefault: undefined,
      },
      {
        path: 'skillsmith install',
        flags: '--no-save',
        long: '--no-save',
        short: null,
        attributeName: 'save',
        valueShape: 'boolean',
        negated: true,
        flagDefault: false,
        parsedDefault: true,
      },
      {
        path: 'skillsmith install',
        flags: '-p, --path <dir>',
        long: '--path',
        short: '-p',
        attributeName: 'path',
        valueShape: 'required',
        negated: false,
        flagDefault: undefined,
        parsedDefault: undefined,
      },
      {
        path: 'skillsmith uninstall',
        flags: '--continue-on-error',
        long: '--continue-on-error',
        short: null,
        attributeName: 'continueOnError',
        valueShape: 'boolean',
        negated: false,
        flagDefault: false,
        parsedDefault: false,
      },
      {
        path: 'skillsmith uninstall',
        flags: '--file <path>',
        long: '--file',
        short: null,
        attributeName: 'file',
        valueShape: 'required',
        negated: false,
        flagDefault: undefined,
        parsedDefault: undefined,
      },
      {
        path: 'skillsmith uninstall',
        flags: '--lockfile <path>',
        long: '--lockfile',
        short: null,
        attributeName: 'lockfile',
        valueShape: 'required',
        negated: false,
        flagDefault: undefined,
        parsedDefault: undefined,
      },
      {
        path: 'skillsmith uninstall',
        flags: '--no-save',
        long: '--no-save',
        short: null,
        attributeName: 'save',
        valueShape: 'boolean',
        negated: true,
        flagDefault: false,
        parsedDefault: true,
      },
    ] as const;

    const program = buildProgram();
    for (const row of expected) {
      const spec = api.CURRENT_COMMAND_SPECS.find((candidate) => candidate.path === row.path);
      const option = spec?.options.find((candidate) => candidate.long === row.long);
      expect(option, `${row.path} ${row.long}`).toMatchObject({
        flags: row.flags,
        long: row.long,
        short: row.short,
        attributeName: row.attributeName,
        valueShape: row.valueShape,
        repeatable: false,
        negated: row.negated,
        flagDefault: row.flagDefault,
        parsedDefault: row.parsedDefault,
      });
      const command = program.commands.find(
        (candidate) => `skillsmith ${candidate.name()}` === row.path,
      );
      const live = command?.options.filter((candidate) => candidate.long === row.long);
      expect(live, `${row.path} ${row.long} live count`).toHaveLength(1);
      expect(live?.[0]?.flags, `${row.path} ${row.long} live flags`).toBe(row.flags);
    }

    const approved = new Set(expected.map(({ path, long }) => `${path}:${long}`));
    const delta = api.CURRENT_COMMAND_SPECS.flatMap((spec) =>
      spec.options
        .filter((option) => approved.has(`${spec.path}:${option.long}`))
        .map((option) => `${spec.path}:${option.flags}`),
    );
    expect(delta).toEqual(expected.map(({ path, flags }) => `${path}:${flags}`));
    expect(api.CURRENT_COMMAND_SPECS.reduce((count, spec) => count + spec.options.length, 0)).toBe(
      281,
    );
  });

  test('G3B-02 scheduler options retain their long-only boolean shape and false defaults', async () => {
    const api = await requireOptionContractApi();
    const findings: string[] = [];
    const inventory = api.CURRENT_COMMAND_SPECS.reduce(
      (count, spec) => count + spec.options.length,
      0,
    );
    if (inventory !== 281) findings.push(`option inventory is ${inventory}, expected 281`);

    const program = buildProgram();
    for (const commandName of ['dev', 'promote'] as const) {
      const path = `skillsmith ${commandName}`;
      const spec = api.CURRENT_COMMAND_SPECS.find((candidate) => candidate.path === path);
      const options = spec?.options.filter((option) => option.long === '--continue-on-error') ?? [];
      if (options.length !== 1) {
        findings.push(`${path} exposes ${options.length} --continue-on-error options, expected 1`);
        continue;
      }
      const [option] = options;
      if (
        option?.attributeName !== 'continueOnError' ||
        option.valueShape !== 'boolean' ||
        option.repeatable ||
        option.negated ||
        option.flagDefault !== false ||
        option.parsedDefault !== false
      ) {
        findings.push(`${path} --continue-on-error does not have the closed boolean/false shape`);
      }
      const live = program.commands
        .find((candidate) => candidate.name() === commandName)
        ?.options.filter((candidate) => candidate.long === '--continue-on-error');
      if (live?.length !== 1 || live[0]?.short !== undefined) {
        findings.push(`${path} --continue-on-error is not exactly one long-only live option`);
      }
    }

    const install = api.CURRENT_COMMAND_SPECS.find(
      (candidate) => candidate.path === 'skillsmith install',
    );
    if (install?.options.filter((option) => option.long === '--continue-on-error').length !== 1) {
      findings.push('skillsmith install lost its existing --continue-on-error option');
    }
    expect(findings).toEqual([]);
  });

  test('approval is rejected for preview while output and noninteractive assertions remain valid', () => {
    for (const commandName of ['install', 'uninstall', 'dev', 'promote'] as const) {
      const rejected = validateNonMutatingMode(commandName, {
        dryRun: true,
        yes: true,
        json: true,
      });
      expect(rejected.ok).toBeFalse();
      if (rejected.ok) throw new Error(`${commandName} unexpectedly accepted preview approval`);
      expect(rejected.exitCode).toBe(2);
      expect(rejected.message).toMatch(/--yes.*--dry-run|--dry-run.*--yes/);

      expect(
        validateNonMutatingMode(commandName, {
          dryRun: true,
          prompt: false,
          json: true,
        }),
      ).toEqual({ ok: true });
    }
  });

  test('force shapes an eligible preview but never supplies its approval', () => {
    for (const commandName of ['install', 'uninstall'] as const) {
      expect(
        validateNonMutatingMode(commandName, {
          dryRun: true,
          force: true,
          prompt: false,
        }),
      ).toEqual({ ok: true });
      const execution = validateNonMutatingMode(commandName, { force: true });
      expect(execution).toEqual({ ok: true });
    }
  });

  test('bounded force results distinguish a supplied but unused flag from applied override work', async () => {
    const core = (await import('../../../core/src/index.ts')) as Record<string, unknown>;
    const createBoundedForceEffect = Reflect.get(core, 'createBoundedForceEffect');
    expect(
      typeof createBoundedForceEffect,
      'G3B-01 must export the closed bounded-force result constructor',
    ).toBe('function');
    if (typeof createBoundedForceEffect !== 'function') return;

    const notRequested = Reflect.apply(createBoundedForceEffect, undefined, [
      { supported: true, requested: false, conflict: null },
    ]) as unknown;
    expect(notRequested).toEqual({
      requested: false,
      applied: false,
      conflictType: null,
      target: null,
      normalBehavior: null,
      forcedBehavior: null,
      backup: null,
    });
    expect(Object.isFrozen(notRequested)).toBeTrue();

    const unused = Reflect.apply(createBoundedForceEffect, undefined, [
      { supported: true, requested: true, conflict: null },
    ]) as unknown;
    expect(unused).toEqual({
      requested: true,
      applied: false,
      conflictType: null,
      target: null,
      normalBehavior: null,
      forcedBehavior: null,
      backup: null,
    });
    expect(Object.isFrozen(unused)).toBeTrue();

    const target = {
      kind: 'live',
      skill: 'alpha',
      tool: 'codex',
      scope: 'user',
      projectRoot: null,
      location: { kind: 'portable', token: 'skills/user/codex/alpha' },
    } as const;
    const conflict = {
      class: 'unmanaged-target',
      normal: 'refuse',
      forced: 'backup-and-replace',
      target,
      backup: 'required',
    } as const;

    const applicable = Reflect.apply(createBoundedForceEffect, undefined, [
      { supported: true, requested: true, applied: false, conflict },
    ]) as unknown;
    expect(applicable).toEqual({
      requested: true,
      applied: false,
      conflictType: 'unmanaged-target',
      target,
      normalBehavior: 'refuse',
      forcedBehavior: 'backup-and-replace',
      backup: 'required',
    });
    expect(Object.isFrozen(applicable)).toBeTrue();
    expect(Object.isFrozen((applicable as { target: unknown }).target)).toBeTrue();

    const applied = Reflect.apply(createBoundedForceEffect, undefined, [
      { supported: true, requested: true, applied: true, conflict },
    ]) as unknown;
    expect(applied).toEqual({
      requested: true,
      applied: true,
      conflictType: 'unmanaged-target',
      target,
      normalBehavior: 'refuse',
      forcedBehavior: 'backup-and-replace',
      backup: 'required',
    });
    expect(Object.isFrozen(applied)).toBeTrue();

    expect(applicable).not.toBe(applied);
    expect((applicable as { target: unknown }).target).not.toBe(target);
  });
});

describe('EWP-OPT-TS06', () => {
  const candidates = [
    {
      name: 'review',
      tool: 'codex',
      scope: 'user',
      path: '/home/alice/.codex/skills/review',
      capabilities: ['dev', 'promote', 'undo'],
    },
    {
      name: 'review',
      tool: 'codex',
      scope: 'project',
      path: '/work/acme/.codex/skills/review',
      capabilities: ['dev', 'promote', 'undo'],
    },
    {
      name: 'lint',
      tool: 'claude-code',
      scope: 'project',
      path: '/work/acme/.claude/skills/lint',
      capabilities: ['dev', 'promote', 'undo'],
    },
  ] as const;

  const mutationPolicy = {
    requiresSelection: true,
    allowBoundedDefault: false,
    allowAbsentCreate: false,
    allowedTools: ['claude-code', 'codex'],
    allowedScopes: ['user', 'project'],
    allowedCapabilities: ['dev', 'promote', 'undo'],
  } as const;

  const validate = (request: SelectionRequest, policy: SelectionPolicy = mutationPolicy) => {
    const result = validateSelectionRequest(request, policy);
    if (!result.ok)
      throw new Error(`unexpected selection validation failure: ${result.error.code}`);
    return result.value;
  };

  test('target-or-all grammar rejects a missing required selection and positional-plus-all', () => {
    for (const request of [
      { targets: [], all: false },
      { targets: ['review'], all: true },
    ]) {
      const result = validateSelectionRequest(request, mutationPolicy);
      expect(result.ok).toBeFalse();
      if (result.ok) throw new Error('invalid mutation selection unexpectedly passed');
      expect(result.error).toMatchObject({ code: 'usage', exitCode: 2 });
    }
  });

  test('unmatched explicit targets never widen to another target or to all candidates', () => {
    const request = validate({ targets: ['absent-*'], all: false });
    const result = resolveTargetSelection(candidates, request);
    expect(result.ok).toBeFalse();
    if (result.ok) throw new Error('unmatched target unexpectedly passed');
    expect(result.error).toMatchObject({ code: 'unmatched', exitCode: 2 });
    expect(result.error.targets).toEqual(['absent-*']);
  });

  test('bounded defaults and explicit all select only their named bounds and retain provenance', () => {
    const boundedPolicy = {
      ...mutationPolicy,
      requiresSelection: false,
      allowBoundedDefault: true,
    } as const;
    const bounded = resolveTargetSelection(
      candidates.filter((candidate) => candidate.scope === 'project'),
      validate({ targets: [], all: false }, boundedPolicy),
    );
    expect(bounded).toMatchObject({
      ok: true,
      value: {
        outcome: 'selected',
        selectionSource: 'bounded-default',
        selected: [{ scope: 'project' }, { scope: 'project' }],
      },
    });

    const all = resolveTargetSelection(
      candidates,
      validate({ targets: [], all: true, scopes: ['project'] }),
    );
    expect(all).toMatchObject({
      ok: true,
      value: {
        outcome: 'selected',
        selectionSource: 'explicit-all',
        selected: [{ scope: 'project' }, { scope: 'project' }],
      },
    });
  });

  test('a valid explicit selection filtered to zero is an explained no-op, never widened', () => {
    const result = resolveTargetSelection(
      candidates,
      validate({ targets: ['review'], all: false, scopes: ['project'], tools: ['claude-code'] }),
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        selected: [],
        outcome: 'filter-noop',
        selectionSource: 'explicit-targets',
      },
    });
    if (!result.ok) throw new Error('filter-to-zero unexpectedly failed');
    expect(result.value.reason).toMatch(/filter/i);
  });

  test('optional-target policy stays declarative for downstream bounded and exception commands', () => {
    const policies = {
      status: { requiresSelection: false, allowBoundedDefault: true },
      plan: { requiresSelection: false, allowBoundedDefault: true },
      apply: { requiresSelection: false, allowBoundedDefault: true },
      sync: { requiresSelection: false, allowBoundedDefault: true },
      gc: { requiresSelection: false, allowBoundedDefault: true },
      updateMutation: { requiresSelection: true, allowBoundedDefault: false },
      updateCheck: { requiresSelection: false, allowBoundedDefault: true },
      undo: { requiresSelection: true, allowBoundedDefault: false },
    } as const;

    for (const [command, contract] of Object.entries(policies)) {
      const result = validateSelectionRequest(
        { targets: [], all: false },
        { ...mutationPolicy, ...contract },
      );
      expect(result.ok, command).toBe(!contract.requiresSelection);
    }
  });

  test('current help exposes target-or-all grammar while completion never invents positional all', async () => {
    const program = buildProgram();

    for (const commandName of ['dev', 'promote'] as const) {
      const command = program.commands.find((candidate) => candidate.name() === commandName);
      const spec = CURRENT_COMMAND_SPECS.find(
        (candidate) => candidate.path === `skillsmith ${commandName}`,
      );
      if (!command || !spec) throw new Error(`${commandName} command missing`);

      expect(command.helpInformation()).toContain('[skill...]');
      expect(command.options.some((option) => option.long === '--all')).toBeTrue();
      expect(spec.arguments).toEqual([
        expect.objectContaining({
          name: 'skill',
          variadic: true,
          choices: [],
          completionProvider: 'skill',
        }),
      ]);
      expect(spec.arguments.flatMap((argument) => argument.choices ?? [])).not.toContain('all');
      const candidates = (
        await parseCompletionGraph([commandName, ''], {
          cwd: '/completion-fixture',
          monotonicMilliseconds: () => 0,
          ports: EMPTY_COMPLETION_PORTS,
        })
      )
        .trimEnd()
        .split('\n')
        .filter((line) => !line.startsWith(':'))
        .map((line) => line.split('\t', 1)[0]);
      expect(candidates).not.toContain('all');
    }
  });
});

describe('EWP-OPT-TS08', () => {
  test('advanced manifest and lock selectors have one cross-command relation matrix', async () => {
    const api = await requireOptionContractApi();
    const paired = [
      'skillsmith status',
      'skillsmith doctor',
      'skillsmith check',
      'skillsmith install',
      'skillsmith uninstall',
      'skillsmith export',
      'skillsmith plan',
      'skillsmith apply',
      'skillsmith sync',
      'skillsmith update',
    ] as const;
    for (const path of paired) {
      const spec = api.CURRENT_COMMAND_SPECS.find((candidate) => candidate.path === path);
      expect(spec, path).toBeDefined();
      const options = spec?.options.map(({ long }) => long) ?? [];
      expect(options, path).toContain('--file');
      expect(options, path).toContain('--lockfile');
    }
    expect(
      api.CURRENT_COMMAND_SPECS.find(({ path }) => path === 'skillsmith init')?.options.map(
        ({ long }) => long,
      ),
    ).not.toContain('--lockfile');
    expect(api.validateCurrentOptionRelations()).toEqual([]);

    const accepted = [
      ['skillsmith status', ['--file', 'one.toml', '--lockfile', 'one.lock']],
      ['skillsmith doctor', ['--file', 'one.toml']],
      ['skillsmith check', ['--file', 'one.toml', '--lockfile', 'one.lock']],
      ['skillsmith export', ['--file', 'one.toml']],
      ['skillsmith plan', ['--file', 'one.toml', '--lockfile', 'one.lock']],
      ['skillsmith apply', ['--file', 'one.toml', '--lockfile', 'one.lock']],
      [
        'skillsmith sync',
        ['--from', 'claude-code', '--to', 'codex', '--save', '--file', 'one.toml'],
      ],
      ['skillsmith update', ['review', '--file', 'one.toml', '--lockfile', 'one.lock']],
    ] as const;
    for (const [command, args] of accepted) {
      expect(api.validateOptionInvocation(command, args), `${command} ${args.join(' ')}`).toEqual({
        ok: true,
      });
    }

    const rejected = [
      ['skillsmith install', ['review', '--no-save', '--file', 'one.toml']],
      ['skillsmith install', ['review', '--no-save', '--lockfile', 'one.lock']],
      ['skillsmith uninstall', ['review', '--no-save', '--file', 'one.toml']],
      ['skillsmith uninstall', ['review', '--no-save', '--lockfile', 'one.lock']],
      ['skillsmith sync', ['--from', 'claude-code', '--to', 'codex', '--file', 'one.toml']],
      ['skillsmith apply', ['--plan', 'saved.plan', '--file', 'one.toml']],
      ['skillsmith apply', ['--plan', 'saved.plan', '--lockfile', 'one.lock']],
      ['skillsmith update', ['review', '--file', 'one.toml', '--file', 'two.toml']],
      ['skillsmith update', ['review', '--lockfile', 'one.lock', '--lockfile', 'two.lock']],
    ] as const;
    for (const [command, args] of rejected) {
      const result = api.validateOptionInvocation(command, args);
      expect(result.ok, `${command} ${args.join(' ')}`).toBeFalse();
      if (!result.ok) expect(result.error.exitCode).toBe(2);
    }

    const fleet = await createUpdateFleet();
    try {
      const customRoot = join(fleet.cwd, 'custom-pair');
      const customManifest = join(customRoot, 'team.toml');
      const customLock = join(customRoot, 'team.lock');
      await mkdir(customRoot, { recursive: true });
      await Promise.all([
        writeFile(customManifest, await readFile(fleet.manifest)),
        writeFile(customLock, await readFile(fleet.lock)),
      ]);
      const explicit = await runUpdateCli(fleet, [
        'update',
        'factor-scan',
        '--file',
        customManifest,
        '--lockfile',
        customLock,
        '--dry-run',
        '--json',
      ]);
      expect(explicit.exitCode, explicit.stderr).toBe(0);
      const explicitReport = JSON.parse(explicit.stdout) as Record<string, unknown>;
      expect(explicitReport).toMatchObject({
        artifactPair: {
          manifestPath: customManifest,
          lockPath: customLock,
          lockSource: 'explicit',
          selectionSource: 'explicit',
        },
      });

      const relative = await runUpdateCli(fleet, [
        'update',
        'factor-scan',
        '--file',
        'custom-pair/team.toml',
        '--lockfile',
        'custom-pair/team.lock',
        '--dry-run',
        '--json',
      ]);
      expect(relative.exitCode, relative.stderr).toBe(0);
      const relativeReport = JSON.parse(relative.stdout) as Record<string, unknown>;
      expect(relativeReport.artifactPair).toEqual(explicitReport.artifactPair);
      const operationIdentity = (value: unknown) =>
        (Array.isArray(value) ? value : []).map((operation: Record<string, unknown>) => ({
          kind: operation.kind,
          operationId: operation.operationId,
          groupId: operation.groupId,
          pairId: operation.pairId,
        }));
      expect(operationIdentity(relativeReport.operations)).toEqual(
        operationIdentity(explicitReport.operations),
      );

      const ordinary = await runUpdateCli(fleet, ['update', 'factor-scan', '--dry-run', '--json']);
      expect(ordinary.exitCode, ordinary.stderr).toBe(0);
      expect(JSON.parse(ordinary.stdout)).toMatchObject({
        artifactPair: {
          manifestPath: fleet.manifest,
          lockPath: fleet.lock,
          lockSource: 'sibling',
          selectionSource: 'discovered-project',
        },
      });
    } finally {
      await destroyUpdateFleet(fleet);
    }
  }, 30_000);
});

describe('EWP-OPT-TS09', () => {
  test('fresh and saved apply have one exhaustive declarative option partition', async () => {
    const api = await requireOptionContractApi();
    const apply = api.CURRENT_COMMAND_SPECS.find((spec) => spec.path === 'skillsmith apply');
    expect(apply, 'live apply CommandSpec').toBeDefined();
    expect(apply?.aliases).toEqual([]);
    expect(apply?.options.map(({ long }) => long).sort()).toEqual(
      [
        '--check',
        '--continue-on-error',
        '--dry-run',
        '--file',
        '--json',
        '--locked',
        '--lockfile',
        '--plan',
        '--project',
        '--prune',
        '--scope',
        '--tool',
        '--user',
        '--yes',
      ].sort(),
    );
    expect(api.validateCurrentOptionRelations()).toEqual([]);
    expect(
      api.CURRENT_OPTION_RELATIONS.filter((relation) => relation.command === 'skillsmith apply'),
    ).not.toHaveLength(0);

    const accepted = [
      ['--file', 'skillsmith.toml', '--lockfile', 'skillsmith.lock'],
      ['--tool', 'codex', '--tool', 'claude-code', '--scope', 'user', '--prune'],
      ['--project', '--locked', '--continue-on-error'],
      ['--dry-run', '--no-prompt'],
      ['--check', '--no-prompt'],
      ['--plan', 'review.plan'],
      ['--plan', 'review.plan', '--dry-run', '--json'],
      ['--plan', 'review.plan', '--check', '--no-prompt'],
    ] as const;
    for (const args of accepted) {
      expect(
        api.validateOptionInvocation('skillsmith apply', args),
        `accepted: ${args.join(' ')}`,
      ).toEqual({ ok: true });
    }

    const savedConflicts = [
      ['--file', 'skillsmith.toml'],
      ['--lockfile', 'skillsmith.lock'],
      ['--tool', 'codex'],
      ['--scope', 'user'],
      ['--user'],
      ['--project'],
      ['--locked'],
      ['--prune'],
      ['--yes'],
      ['--continue-on-error'],
    ] as const;
    const rejected = [
      ...savedConflicts.flatMap((conflict) => [
        ['--plan', 'review.plan', ...conflict],
        [...conflict, '--plan', 'review.plan'],
      ]),
      ['--dry-run', '--check'],
      ['--check', '--dry-run'],
      ['--dry-run', '--yes'],
      ['--yes', '--dry-run'],
      ['--check', '--yes'],
      ['--yes', '--check'],
      ['--lockfile', 'skillsmith.lock'],
      ['--file', 'one.toml', '--file', 'two.toml'],
      ['--plan', 'one.plan', '--plan', 'two.plan'],
      ['--scope', 'user', '--project'],
      ['--tool', 'codex', '--tool', 'codex'],
      ['--tool=codex', '--tool', 'codex'],
      ['-tcodex', '--tool', 'codex'],
    ] as const;
    for (const args of rejected) {
      const result = api.validateOptionInvocation('skillsmith apply', args);
      expect(result.ok, `rejected: ${args.join(' ')}`).toBeFalse();
      if (result.ok) throw new Error(`invalid apply option relation passed: ${args.join(' ')}`);
      expect(result.error.exitCode).toBe(2);
    }

    const relations =
      api.CURRENT_OPTION_RELATIONS as (typeof api.CURRENT_OPTION_RELATIONS)[number][];
    const index = relations.findIndex(
      (relation) => relation.id === 'skillsmith.apply.tool.distinct-values',
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const removed = relations.splice(index, 1)[0];
    try {
      expect(api.validateCurrentOptionRelations()).toContain(
        'missing required current option relation skillsmith.apply.tool.distinct-values',
      );
      expect(
        api.validateOptionInvocation('skillsmith apply', ['--tool', 'codex', '--tool', 'codex']),
      ).toEqual({ ok: true });
    } finally {
      if (removed !== undefined) relations.splice(index, 0, removed);
    }
    expect(
      api.validateOptionInvocation('skillsmith apply', ['--tool', 'codex', '--tool', 'codex']).ok,
    ).toBeFalse();
  });

  test('saved-plan conflicts fail before discovery, plan reads, prompts, or state creation', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'skillsmith-apply-preflight-'));
    const stateRoot = join(sandbox, 'watched-state');
    const cwd = join(stateRoot, 'cwd');
    const home = join(stateRoot, 'home');
    const config = join(stateRoot, 'config');
    const data = join(stateRoot, 'data');
    const cache = join(sandbox, 'cache');
    await Promise.all(
      [cwd, home, config, data, cache].map((path) => mkdir(path, { recursive: true })),
    );
    await writeFile(join(config, 'skillsmith.toml'), 'not = [valid\n');
    const before = await snapshotTree(stateRoot);
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: data,
      XDG_CACHE_HOME: cache,
      SKILLSMITH_HOME: join(data, 'skillsmith'),
      CI: '1',
      NO_COLOR: '1',
    };
    try {
      for (const args of [
        ['apply', '--plan', join(sandbox, 'absent.plan'), '--file', 'state.toml', '--json'],
        ['apply', '--plan', join(sandbox, 'absent.plan'), '--yes', '--json'],
        ['apply', '--plan', join(sandbox, 'absent.plan'), '--dry-run', '--check', '--json'],
        ['apply', '--tool', 'codex', '--tool=codex', '--json'],
      ] as const) {
        const result = await runHermeticCli(args, cwd, env);
        expect(result.code, args.join(' ')).toBe(2);
        expect(JSON.parse(result.stdout), args.join(' ')).toMatchObject({
          code: 'usage',
          exitCode: 2,
        });
        expect(await snapshotTree(stateRoot), args.join(' ')).toEqual(before);
      }
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});

describe('EWP-OPT-TS10', () => {
  test.each(['install', 'uninstall', 'dev', 'promote'] as const)(
    '%s rejects --yes with --dry-run as a usage error',
    (commandName) => {
      const result = validateNonMutatingMode(commandName, { dryRun: true, yes: true });
      expect(result.ok).toBeFalse();
      if (result.ok) throw new Error(`${commandName} unexpectedly accepted contradictory modes`);
      expect(result.exitCode).toBe(2);
      expect(result.message).toContain('--yes');
      expect(result.message).toContain('--dry-run');
    },
  );

  test('the declarative check policy keeps exit-code compatibility opposite report-only', () => {
    expect(validateNonMutatingMode('check', { exitCode: true })).toEqual({ ok: true });
    const conflict = validateNonMutatingMode('check', { reportOnly: true, exitCode: true });
    expect(conflict.ok).toBeFalse();
    if (conflict.ok) throw new Error('check unexpectedly combined opposite exit policies');
    expect(conflict.exitCode).toBe(2);
    expect(conflict.message).toContain('--report-only');
    expect(conflict.message).toContain('--exit-code');
  });

  test('meaningful current-command preview shaping remains valid', () => {
    const accepted = [
      validateNonMutatingMode('install', {
        dryRun: true,
        force: true,
        strict: true,
        continueOnError: true,
        prompt: false,
      }),
      validateNonMutatingMode('uninstall', {
        dryRun: true,
        force: true,
        prompt: false,
      }),
      validateNonMutatingMode('dev', {
        dryRun: true,
        strict: true,
        prompt: false,
      }),
      validateNonMutatingMode('promote', {
        dryRun: true,
        allowDirty: true,
        strict: true,
        prompt: false,
      }),
    ];
    expect(accepted).toEqual(accepted.map(() => ({ ok: true })));
  });

  test('live mutators reject preview approval in either option order before creating state', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'skillsmith-non-mutating-'));
    const stateRoot = join(sandbox, 'watched-state');
    const cwd = join(stateRoot, 'cwd');
    const home = join(stateRoot, 'home');
    const config = join(stateRoot, 'config');
    const data = join(stateRoot, 'data');
    const state = join(stateRoot, 'state');
    const cache = join(sandbox, 'runtime-cache');
    await Promise.all(
      [cwd, home, config, data, state, cache].map((path) => mkdir(path, { recursive: true })),
    );
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: data,
      XDG_STATE_HOME: state,
      XDG_CACHE_HOME: cache,
      SKILLSMITH_HOME: join(data, 'skillsmith'),
      CODEX_HOME: join(home, '.codex'),
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CI: '1',
      NO_COLOR: '1',
    };
    const cases = [
      { command: 'install', target: 'not-a-source', approvals: ['--yes', '-y'] },
      { command: 'uninstall', target: 'absent', approvals: ['--yes', '-y'] },
      { command: 'dev', target: 'absent', approvals: ['--yes'] },
      { command: 'promote', target: 'absent', approvals: ['--yes'] },
    ] as const;

    try {
      const invocations = cases.flatMap(({ command, target, approvals }) =>
        approvals.flatMap((approval) => [
          [command, target, '--dry-run', approval],
          [command, approval, '--dry-run', target],
        ]),
      );
      const before = await snapshotTree(stateRoot);
      const results = await Promise.all(invocations.map((args) => runHermeticCli(args, cwd, env)));
      for (const result of results) {
        expect(result.code).toBe(2);
        expect(result.stderr).toContain('--dry-run');
        expect(result.stderr).toContain('--yes');
      }
      expect(await snapshotTree(stateRoot)).toEqual(before);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});

describe('sync CommandSpec option contract', () => {
  test('registers the exact additive grammar and pre-I/O relations once', async () => {
    const api = await requireOptionContractApi();
    const spec = api.CURRENT_COMMAND_SPECS.find(({ path }) => path === 'skillsmith sync');
    expect(spec?.aliases).toEqual([]);
    expect(spec?.options.map(({ flags }) => flags)).toEqual([
      '--from <scope|path>',
      '--to <scope|path>',
      '-t, --tool <name>',
      '-f, --force',
      '--delete',
      '--save',
      '--file <path>',
      '--lockfile <path>',
      '--dry-run',
      '-y, --yes',
      '--continue-on-error',
      '--json',
      '-h, --help',
    ]);
    expect(api.validateCurrentCommandSpecs()).toEqual([]);
    expect(api.validateCurrentOptionRelations()).toEqual([]);

    for (const args of [
      [],
      ['--from', 'user'],
      ['--to', 'project'],
      ['--from', 'user', '--from', 'system', '--to', 'project'],
      ['--from', 'user', '--to', 'project', '--yes', '--dry-run'],
      ['--from', 'user', '--to', 'project', '--file', 'state.toml'],
      ['--from', 'user', '--to', 'project', '--save', '--lockfile', 'state.lock'],
    ] as const) {
      expect(api.validateOptionInvocation('skillsmith sync', args).ok, args.join(' ')).toBeFalse();
    }
    expect(
      api.validateOptionInvocation('skillsmith sync', [
        '--from',
        'user',
        '--to',
        'project',
        '--tool',
        'codex',
        '--tool=codex',
      ]),
    ).toEqual({ ok: true });
    expect(
      api.validateOptionInvocation('skillsmith sync', [
        'lint',
        '--from',
        'user',
        '--to',
        './project-b',
        '-tcodex',
        '--save',
        '--file',
        'state.toml',
        '--lockfile',
        'state.lock',
        '--dry-run',
        '--json',
      ]),
    ).toEqual({ ok: true });
  });
});

describe('update CommandSpec option contract', () => {
  test('registers the exact optional-target grammar and pre-I/O relations once', async () => {
    const api = await requireOptionContractApi();
    const spec = api.CURRENT_COMMAND_SPECS.find(({ path }) => path === 'skillsmith update');
    expect(spec?.aliases).toEqual([]);
    expect(spec?.arguments).toEqual([
      expect.objectContaining({ name: 'skill', required: false, variadic: true }),
    ]);
    expect(spec?.options.map(({ flags }) => flags)).toEqual([
      '--all',
      '--file <path>',
      '--lockfile <path>',
      '-t, --tool <name>',
      '--check',
      '--dry-run',
      '--ref <git-ref>',
      '--pin',
      '--strict',
      '-y, --yes',
      '--continue-on-error',
      '--json',
      '-h, --help',
    ]);
    expect(api.validateCurrentCommandSpecs()).toEqual([]);
    expect(api.validateCurrentOptionRelations()).toEqual([]);

    for (const args of [
      ['--lockfile', 'state.lock'],
      ['skill', '--ref', 'main', '--ref', 'next'],
      ['skill', '--check', '--dry-run'],
      ['skill', '--check', '--yes'],
      ['skill', '--dry-run', '--yes'],
      ['first', 'second', '--ref', 'main'],
    ] as const) {
      expect(
        api.validateOptionInvocation('skillsmith update', args).ok,
        args.join(' '),
      ).toBeFalse();
    }
    expect(api.validateOptionInvocation('skillsmith update', ['--check'])).toEqual({ ok: true });
    expect(
      api.validateOptionInvocation('skillsmith update', [
        'factor-*',
        '-tcodex',
        '--strict',
        '--dry-run',
        '--json',
      ]),
    ).toEqual({ ok: true });
  });
});

describe('EWP-OPT-TS05', () => {
  test('one CommandSpec registry owns parser, help, docs, and generic fixture execution metadata', async () => {
    const api = await requireOptionContractApi();
    const specs = api.CURRENT_COMMAND_SPECS as readonly (CommandSpecContract & {
      readonly primaryQuestion?: string;
      readonly minimalInvocations?: readonly string[];
      readonly commonWorkflows?: readonly { readonly invocation: string }[];
    })[];
    const publicSpecs = specs.filter((spec) => spec.path.split(' ').length === 2);
    expect(publicSpecs).toHaveLength(24);
    for (const spec of publicSpecs) {
      expect(spec.primaryQuestion?.length ?? 0, spec.path).toBeGreaterThan(10);
      expect(spec.minimalInvocations?.length ?? 0, spec.path).toBeGreaterThanOrEqual(1);
      expect(spec.commonWorkflows?.length ?? 0, spec.path).toBeGreaterThanOrEqual(2);
    }

    const loadPlannedModule = async (path: string): Promise<Record<string, unknown>> =>
      (await import(path)) as Record<string, unknown>;
    const reference = await loadPlannedModule('../../src/help/reference.ts');
    const help = await loadPlannedModule('../../src/help/render.ts');
    expect(typeof reference.renderCommandReference).toBe('function');
    expect(typeof help.renderCommandHelp).toBe('function');
    expect(typeof help.renderRootHelp).toBe('function');

    const legacy = {
      ...(publicSpecs[0] as unknown as Record<string, unknown>),
      helpOrder: undefined,
      minimalInvocations: undefined,
      commonWorkflows: undefined,
      options: publicSpecs[0]?.options.map((option) => ({
        ...option,
        helpFamily: undefined,
        helpLevel: undefined,
      })),
    } as Record<string, unknown>;
    const rendered = (
      reference.renderCommandReference as (
        candidates: readonly unknown[],
        version: string,
      ) => string
    )([legacy], 'fixture-version');
    expect(rendered).toContain('fixture-version');
    expect(rendered).toContain(
      ((legacy.examples as readonly string[] | undefined)?.[0] ?? legacy.path) as string,
    );
    for (const option of publicSpecs[0]?.options ?? []) expect(rendered).toContain(option.flags);
  });

  test('legacy extension declarations normalize progressive-help defaults before attachment', () => {
    const legacyFixture = {
      name: 'legacy-fixture',
      path: 'skillsmith legacy-fixture',
      aliases: ['lf'],
      group: 'maintain',
      primaryQuestion: 'Does the original extension contract remain source compatible?',
      description: 'Exercise a declaration created before progressive-help metadata existed.',
      arguments: [],
      options: [
        {
          flags: '--legacy-mode <mode>',
          long: '--legacy-mode',
          short: null,
          attributeName: 'legacyMode',
          valueShape: 'required',
          knownValues: [],
          allowedValues: [],
          repeatable: false,
          negated: false,
          flagDefault: undefined,
          parsedDefault: undefined,
          description: 'Legacy extension mode',
        },
      ],
      examples: ['skillsmith legacy-fixture --legacy-mode safe'],
      capability: 'read',
      application: 'help',
    } as const satisfies CommandSpec;
    const extensionInput: CommandSpecInput = legacyFixture;
    const normalized = normalizeCommandSpec(extensionInput);

    expect(normalized.helpOrder).toBe(Number.MAX_SAFE_INTEGER);
    expect(normalized.minimalInvocations).toEqual([...legacyFixture.examples]);
    expect(normalized.commonWorkflows.map(({ invocation }) => invocation)).toEqual([
      ...legacyFixture.examples,
    ]);
    expect(normalized.options[0]).toMatchObject({
      helpFamily: 'automation-output',
      helpLevel: 'common',
    });

    const command = buildProgram(undefined, { additionalSpecs: [extensionInput] }).commands.find(
      (candidate) => candidate.name() === legacyFixture.name,
    );
    expect(command?.aliases()).toEqual(['lf']);
    expect(command?.helpInformation()).toContain('AUTOMATION AND OUTPUT');
    expect(command?.helpInformation()).toContain(legacyFixture.examples[0]);
  });
});

describe('EWP-OPT-TS07', () => {
  test('every local option has one stable visible help family and level', async () => {
    const api = await requireOptionContractApi();
    const families = new Set([
      'targets-scope',
      'source-destination-artifacts',
      'behavior-verification',
      'safety-approval',
      'automation-output',
      'inherited-globals',
    ]);
    const levels = new Set(['common', 'advanced']);
    for (const spec of api.CURRENT_COMMAND_SPECS) {
      for (const option of spec.options as readonly (CommandSpecOptionContract & {
        readonly helpFamily?: string;
        readonly helpLevel?: string;
      })[]) {
        expect(families.has(option.helpFamily ?? ''), `${spec.path} ${option.long}`).toBeTrue();
        expect(levels.has(option.helpLevel ?? ''), `${spec.path} ${option.long}`).toBeTrue();
      }
    }
  });

  test('Commander compatibility preserves explicit negated defaults before the upgrade', () => {
    const program = buildProgram();
    const install = program.commands.find((command) => command.name() === 'install');
    expect(program.opts()).toMatchObject({ prompt: true });
    expect(install?.optsWithGlobals()).toMatchObject({ prompt: true, verify: true });
  });
});
