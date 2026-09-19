import { describe, expect, test } from 'bun:test';
import {
  assertHelpAndTargetClosure,
  migrationLedger,
} from '../../../packages/cli/src/contracts/cli-migration-ledger.ts';
import snapshot from '../../../packages/cli/src/contracts/commander-surface-v0.7.0.json';
import { canonicalizeCommanderTree } from '../../../packages/cli/src/contracts/commander-surface.ts';
import { buildProgram } from '../../../packages/cli/src/program.ts';

describe('EWP-P0A-TS08', () => {
  test('current help, current ledger, target registry, and future help ownership close', () => {
    expect(() =>
      assertHelpAndTargetClosure(canonicalizeCommanderTree(buildProgram()), migrationLedger),
    ).not.toThrow();
  });

  test('rejects stale help and missing future target-help ownership', () => {
    const stale = structuredClone(migrationLedger);
    stale.currentHelpInventory.skillsmith?.visibleOptions.pop();
    expect(() => assertHelpAndTargetClosure(snapshot, stale)).toThrow(/help inventory is stale/);
    const ownerless = structuredClone(migrationLedger);
    ownerless.targetHelpOwner.phase = 'P17-G0-02' as never;
    expect(() => assertHelpAndTargetClosure(snapshot, ownerless)).toThrow(
      /target help owner missing/,
    );
    const misspelled = structuredClone(migrationLedger);
    const first = misspelled.target[0];
    if (!first) throw new Error('fixture target ledger is empty');
    first.key += '-wrong';
    expect(() => assertHelpAndTargetClosure(snapshot, misspelled)).toThrow(/target registry/);
  });

  test('rejects a live option hidden from generated help', () => {
    const live = structuredClone(canonicalizeCommanderTree(buildProgram()));
    const root = live.find((command) => command.path === 'skillsmith');
    const debug = root?.options.find((option) => option.long === '--debug');
    if (!debug) throw new Error('live debug option is missing');
    debug.hidden = true;
    expect(() => assertHelpAndTargetClosure(live, migrationLedger)).toThrow(
      /help inventory is stale/,
    );
  });
});
