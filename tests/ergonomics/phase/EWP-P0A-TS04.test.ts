import { describe, expect, test } from 'bun:test';
import {
  assertOptionGateOwnership,
  migrationLedger,
} from '../../../packages/cli/src/contracts/cli-migration-ledger.ts';

describe('EWP-P0A-TS04', () => {
  test('all ten parser gates have immutable downstream ownership and only TS01 is required now', () => {
    expect(() => assertOptionGateOwnership(migrationLedger)).not.toThrow();
  });

  test('rejects missing gates and early promotion of downstream gates', () => {
    const missing = structuredClone(migrationLedger);
    Reflect.deleteProperty(missing.optionGates, 'EWP-OPT-TS10');
    expect(() => assertOptionGateOwnership(missing)).toThrow(/gate set differs/);
    const promoted = structuredClone(migrationLedger);
    const future = promoted.optionGates['EWP-OPT-TS02'];
    if (!future) throw new Error('fixture option gate is missing');
    future.requiredNow = true;
    expect(() => assertOptionGateOwnership(promoted)).toThrow(/promoted early/);
    const ghost = structuredClone(migrationLedger);
    ghost.optionGates['EWP-OPT-TS02'] = {
      target: 'ghost.test.ts#EWP-OPT-TS02',
      phase: 'P17-NONSENSE',
      requiredNow: false,
    };
    expect(() => assertOptionGateOwnership(ghost)).toThrow(/invalid owner/);
  });
});
