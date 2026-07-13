import { describe, expect, test } from 'bun:test';
import {
  assertOptionGateOwnership,
  migrationLedger,
} from '../../../packages/cli/src/contracts/cli-migration-ledger.ts';
import catalog from '../../../projects/p17/catalog.json';

describe('EWP-P0A-TS04', () => {
  test('all ten parser gates have immutable downstream ownership and only TS01 is required now', () => {
    expect(() => assertOptionGateOwnership(migrationLedger)).not.toThrow();
    for (const [id, gate] of Object.entries(migrationLedger.optionGates)) {
      const entity = catalog.entities.find((candidate) => candidate.id === id);
      expect(entity?.primaryGroup).toBe(gate.phase);
    }
    expect(migrationLedger.optionGates['EWP-OPT-TS08']?.phase).toBe('P17-G5-05');
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
