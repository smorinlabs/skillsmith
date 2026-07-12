import { describe, expect, test } from 'bun:test';
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
  test('live Commander tree, immutable snapshot, and closed ledger agree exactly', () => {
    const live = canonicalizeCommanderTree(buildProgram());
    expect(live).toEqual(snapshot as readonly CanonicalCommand[]);
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
