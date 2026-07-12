import { describe, expect, test } from 'bun:test';
import {
  assertTargetOwnership,
  migrationLedger,
} from '../../../packages/cli/src/contracts/cli-migration-ledger.ts';

describe('EWP-P0A-TS03', () => {
  test('every proposed command has exact implementation, validation ranges, and truthful workflows', () => {
    expect(() => assertTargetOwnership(migrationLedger)).not.toThrow();
  });

  test('rejects missing and prose-only command ownership', () => {
    const missing = structuredClone(migrationLedger);
    missing.targetCommands.pop();
    expect(() => assertTargetOwnership(missing)).toThrow(/count|ownership differs/);
    const prose = structuredClone(migrationLedger);
    const first = prose.targetCommands[0];
    if (!first) throw new Error('fixture target command ownership is empty');
    first.workflows = ['EWP-NOT-REAL'];
    expect(() => assertTargetOwnership(prose)).toThrow(/validation\/workflow ownership/);
  });

  test('help owns only TS01..06 and version owns only TS07', () => {
    const help = migrationLedger.targetCommands.find((row) => row.command === 'skillsmith help');
    const version = migrationLedger.targetCommands.find(
      (row) => row.command === 'skillsmith version',
    );
    expect(help?.validations).toEqual(
      Array.from(
        { length: 6 },
        (_, index) => `EWP-CMD-HELP-TS${String(index + 1).padStart(2, '0')}`,
      ),
    );
    expect(version?.validations).toEqual(['EWP-CMD-HELP-TS07']);
    expect(
      migrationLedger.target
        .filter((row) => row.key.includes('skillsmith help'))
        .map((row) => row.validationOwner),
    ).not.toContain('EWP-CMD-HELP-TS07');
    expect(
      migrationLedger.target
        .filter(
          (row) =>
            row.key.includes('skillsmith version') || row.key === 'option:skillsmith:-V, --version',
        )
        .map((row) => row.validationOwner),
    ).toEqual(['EWP-CMD-HELP-TS07', 'EWP-CMD-HELP-TS07']);
  });
});
