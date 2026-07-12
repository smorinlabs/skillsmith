import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveTargetSelection,
  validateSelectionRequest,
} from '../../../core/src/selection/resolve.ts';
import { hermeticGitEnv } from '../../../core/tests/fixtures/git-env.ts';
import { walk } from '../../src/completion/walk.ts';
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
import {
  NON_MUTATING_MODE_POLICIES,
  validateNonMutatingMode,
} from '../../src/util/non-mutating-mode.ts';
import { CLI_ENTRYPOINT } from '../fixtures/cli.ts';

const snapshotTree = async (root: string): Promise<readonly string[]> =>
  (await readdir(root, { recursive: true, encoding: 'utf8' })).sort();

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
    options.push({
      flags: '--no-color',
      short: null,
      long: '--no-color',
      attributeName: 'color',
      requiredValue: false,
      optionalValue: false,
      variadic: false,
      negated: true,
      choices: [],
      defaultValue: false,
      defaultSource: 'literal',
      repeatable: false,
      hidden: false,
    });
    options.sort((a, b) => a.flags.localeCompare(b.flags));

    const migrated = structuredClone(migrationLedger);
    const current = migrated.current as (typeof migrated.current)[number][];
    const debugLedger = current.findIndex((entry) => entry.key === 'option:skillsmith:--debug');
    if (debugLedger < 0) throw new Error('current debug entry missing');
    current.splice(debugLedger, 1);
    const noColor = migrated.target.find((entry) => entry.key === 'option:skillsmith:--no-color');
    if (!noColor) throw new Error('target no-color entry missing');
    current.push({
      ...structuredClone(noColor),
      option: {
        flags: '--no-color',
        short: null,
        long: '--no-color',
        attributeName: 'color',
        requiredValue: false,
        optionalValue: false,
        variadic: false,
        valueShape: 'boolean',
        choices: [],
        defaultValue: 'false',
        defaultSource: 'literal',
        repeatable: false,
        negated: true,
        hidden: false,
      },
    });
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
    mutateOption('skillsmith dev', '--no-prompt', (option) => {
      option.negated = false;
    });
  });
});

describe('EWP-OPT-TS04', () => {
  test('current mutation commands expose one truthful preview, approval, prompt, and output family', () => {
    const program = buildProgram();
    for (const commandName of ['install', 'uninstall', 'dev', 'promote'] as const) {
      const command = program.commands.find((candidate) => candidate.name() === commandName);
      if (!command) throw new Error(`live command missing: ${commandName}`);
      const options = new Set(command.options.map((option) => option.long));
      for (const option of ['--dry-run', '--yes', '--no-prompt', '--json']) {
        expect(options.has(option)).toBeTrue();
      }
      expect(Object.hasOwn(NON_MUTATING_MODE_POLICIES, commandName)).toBeTrue();
    }
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

  const validate = (
    request: Parameters<typeof validateSelectionRequest>[0],
    policy: Parameters<typeof validateSelectionRequest>[1] = mutationPolicy,
  ) => {
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

  test('current help exposes target-or-all grammar while completion never invents positional all', () => {
    const program = buildProgram();
    const completion = walk(program)[0];
    if (!completion) throw new Error('completion root missing');

    for (const commandName of ['dev', 'promote'] as const) {
      const command = program.commands.find((candidate) => candidate.name() === commandName);
      const completionCommand = completion.subcommands.find(
        (candidate) => candidate.name === commandName,
      );
      if (!command || !completionCommand) throw new Error(`${commandName} command missing`);

      expect(command.helpInformation()).toContain('[skill...]');
      expect(command.options.some((option) => option.long === '--all')).toBeTrue();
      expect(completionCommand.args).toEqual([
        expect.objectContaining({ name: 'skill', variadic: true, choices: null }),
      ]);
      expect(completionCommand.args.flatMap((argument) => argument.choices ?? [])).not.toContain(
        'all',
      );
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

  test('the declarative report-only check policy reserves --exit-code as invalid', () => {
    const result = validateNonMutatingMode('check', { exitCode: true });
    expect(result.ok).toBeFalse();
    if (result.ok) throw new Error('check unexpectedly accepted --exit-code');
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain('--exit-code');
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
      for (const { command, target, approvals } of cases) {
        for (const approval of approvals) {
          for (const args of [
            [command, target, '--dry-run', approval],
            [command, approval, '--dry-run', target],
          ]) {
            const before = await snapshotTree(stateRoot);
            const result = await runHermeticCli(args, cwd, env);
            expect(result.code).toBe(2);
            expect(result.stderr).toContain('--dry-run');
            expect(result.stderr).toContain('--yes');
            expect(await snapshotTree(stateRoot)).toEqual(before);
          }
        }
      }
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});
