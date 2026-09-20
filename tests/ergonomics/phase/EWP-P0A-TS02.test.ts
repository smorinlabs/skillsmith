import { describe, expect, test } from 'bun:test';
import {
  assertCommandOptionMatrix,
  migrationLedger,
} from '../../../packages/cli/src/contracts/cli-migration-ledger.ts';

describe('EWP-P0A-TS02', () => {
  test('matrix has no duplicate short flags or contradictory defaults', () => {
    expect(() => assertCommandOptionMatrix(migrationLedger)).not.toThrow();
  });

  test('rejects a duplicate command-local short flag', () => {
    const mutated = structuredClone(migrationLedger);
    (mutated.target as (typeof mutated.target)[number][]).push({
      key: 'option:skillsmith agents:-t, --target <name>',
      disposition: 'N',
      phase: 'P17-1',
      validationOwner: 'EWP-CMD-AGENTS-TS01',
    });
    expect(() => assertCommandOptionMatrix(mutated)).toThrow(/option shape|duplicate short flag/);
  });
  test('rejects default, choices, repeatability, and negation drift', () => {
    for (const field of [
      'defaultValue',
      'defaultSource',
      'choices',
      'repeatable',
      'negated',
    ] as const) {
      const mutated = structuredClone(migrationLedger);
      const entry = mutated.target.find((row) => row.option);
      if (!entry?.option) throw new Error('fixture option is missing');
      if (field === 'choices') entry.option.choices = ['ghost'];
      else if (field === 'defaultSource') entry.option.defaultSource = 'none';
      else if (field === 'defaultValue') entry.option.defaultValue = 'contradiction';
      else entry.option[field] = !entry.option[field];
      expect(() => assertCommandOptionMatrix(mutated)).toThrow(/option shape/);
    }
  });
  test('mandatory sync endpoints are required values with no default', () => {
    for (const flag of ['--from <scope|path>', '--to <scope|path>']) {
      const entry = migrationLedger.target.find(
        (row) => row.key === `option:skillsmith sync:${flag}`,
      );
      expect(entry?.option).toMatchObject({
        valueShape: 'required',
        choices: [],
        defaultSource: 'none',
        defaultValue: 'unset',
      });
    }
  });

  test('target tool and command-specific scope choices are exact', () => {
    const tools = migrationLedger.target.filter((row) => row.option?.long === '--tool');
    expect(tools.length).toBeGreaterThan(0);
    for (const row of tools) {
      expect(row.option?.choices).toEqual([
        'claude-code',
        'codex',
        'kilo-code',
        'opencode',
        'muse',
      ]);
    }
    const scopes = Object.fromEntries(
      migrationLedger.target
        .filter((row) => row.option?.long === '--scope')
        .map((row) => [row.key.match(/^option:skillsmith ([^:]+):/)?.[1], row.option?.choices]),
    );
    expect(scopes).toEqual({
      'config get': ['user', 'project', 'system'],
      'config set': ['user', 'project', 'system'],
      'config list': ['user', 'project', 'system'],
      'config unset': ['user', 'project', 'system'],
      list: ['user', 'project', 'system', 'managed'],
      'cross-tool-names': ['user', 'project', 'system', 'managed'],
      commands: ['user', 'project'],
      status: ['user', 'project', 'system', 'managed'],
      doctor: ['user', 'project', 'system'],
      check: ['user', 'project', 'system'],
      install: ['user', 'project'],
      uninstall: ['user', 'project'],
      dev: ['user', 'project'],
      promote: ['user', 'project'],
      init: ['user', 'project'],
      export: ['user', 'project', 'system', 'managed'],
      plan: ['user', 'project'],
      apply: ['user', 'project'],
      undo: ['user', 'project'],
    });
  });

  test('version and apply mode compatibility surfaces are aliases', () => {
    for (const key of [
      'option:skillsmith:-V, --version',
      'option:skillsmith apply:--dry-run',
      'option:skillsmith apply:--check',
    ]) {
      expect(migrationLedger.target.find((row) => row.key === key)?.disposition).toBe('A');
    }
  });
});
