import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { validatePlanStructure } from '../../../scripts/p17-plan-structure';

const root = resolve(import.meta.dir, '../../..');
const plan = readFileSync(
  resolve(root, 'docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md'),
  'utf8',
);

describe('EWP-P0A-TS06 exhaustive plan-integrity validation', () => {
  test('EWP-P0A-TS06 accepts the canonical plan and recomputed inventory', () => {
    expect(validatePlanStructure(plan, ['EWP-P0A-TS06'])).toEqual([]);
  });

  test('EWP-P0A-TS06 rejects stale markers and placeholders', () => {
    expect(
      validatePlanStructure(`${plan}\nPending decision: choose later.\n`, ['EWP-P0A-TS06']),
    ).toContain('stale pending-decision marker');
    expect(
      validatePlanStructure(`${plan}\nTBD: fill this contract.\n`, ['EWP-P0A-TS06']),
    ).toContain('out-of-template placeholder TBD');
  });

  test('EWP-P0A-TS06 rejects count drift and nonexistent phase references', () => {
    const countDrift = plan.replace('65 named phase tasks', '64 named phase tasks');
    expect(validatePlanStructure(countDrift, ['EWP-P0A-TS06'])).toContain(
      'declared phase-task count 64 does not match 65',
    );
    const badPhase = plan.replace(
      'Phase 3B existing-mutator prerequisite',
      'Phase 9 existing-mutator prerequisite',
    );
    expect(validatePlanStructure(badPhase, ['EWP-P0A-TS06'])).toContain(
      'reference to nonexistent Phase 9',
    );
  });

  test('EWP-P0A-TS06 rejects a referenced but undefined validation ID', () => {
    const undefinedId = plan.replace('EWP-P2-TS01..05', 'EWP-P2-TS01..05, EWP-P2-TS99');
    expect(validatePlanStructure(undefinedId, ['EWP-P0A-TS06'])).toContain(
      'undefined EWP reference EWP-P2-TS99',
    );
  });

  test('EWP-P0A-TS06 rejects exact-set drift for non-validation IDs', () => {
    const undefinedTask = plan.replace('**EWP-P0A-T01:**', '**EWP-P0A-T99:**');
    const diagnostics = validatePlanStructure(undefinedTask, ['EWP-P0A-TS06']);
    expect(diagnostics).toContain('missing phase-task definition EWP-P0A-T01');
    expect(diagnostics).toContain('unexpected phase-task definition EWP-P0A-T99');
  });

  test('EWP-P0A-TS06 rejects a missing count declaration and descending range', () => {
    const missingCount = plan.replace('65 named phase tasks', 'many named phase tasks');
    expect(validatePlanStructure(missingCount, ['EWP-P0A-TS06'])).toContain(
      'missing declared phase-task count',
    );
    const descending = plan.replace('EWP-P4B-T03..T05', 'EWP-P4B-T05..T03');
    expect(validatePlanStructure(descending, ['EWP-P0A-TS06'])).toContain(
      'malformed descending range EWP-P4B-T05..T03',
    );
  });

  test('EWP-P0A-TS06 rejects undefined forward and slash endpoints', () => {
    const forward = plan.replace('EWP-P4B-T03..T05', 'EWP-P4B-T03..T99');
    expect(validatePlanStructure(forward, ['EWP-P0A-TS06'])).toContain(
      'undefined range endpoint EWP-P4B-T99 in EWP-P4B-T03..T99',
    );
    const slash = plan.replace('EWP-CMD-DOCTOR-TS03/05/06', 'EWP-CMD-DOCTOR-TS03/05/99');
    expect(validatePlanStructure(slash, ['EWP-P0A-TS06'])).toContain(
      'undefined slash reference EWP-CMD-DOCTOR-TS99 in EWP-CMD-DOCTOR-TS03/05/99',
    );
  });

  test('EWP-P0A-TS06 rejects malformed identifier widths, families, and spaced endpoints', () => {
    const malformed = `${plan}\nSee EWP-P0A-T1 and EWP-P0A-X99.\n`;
    const diagnostics = validatePlanStructure(malformed, ['EWP-P0A-TS06']);
    expect(diagnostics).toContain('malformed or undefined identifier EWP-P0A-T1');
    expect(diagnostics).toContain('malformed or undefined identifier EWP-P0A-X99');
    const spaced = `${plan}\nD-001 .. D-999\n`;
    expect(validatePlanStructure(spaced, ['EWP-P0A-TS06'])).toContain(
      'malformed or undefined identifier D-999',
    );
  });
});
