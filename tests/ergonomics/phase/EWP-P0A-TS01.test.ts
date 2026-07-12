import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { validatePlanStructure } from '../../../scripts/p17-plan-structure';

const root = resolve(import.meta.dir, '../../..');
const plan = readFileSync(
  resolve(root, 'docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md'),
  'utf8',
);

describe('EWP-P0A-TS01 identifier, heading, and decision-status validation', () => {
  test('EWP-P0A-TS01 accepts the canonical plan', () => {
    expect(validatePlanStructure(plan, ['EWP-P0A-TS01'])).toEqual([]);
  });

  test('EWP-P0A-TS01 rejects duplicate and missing decision headings', () => {
    const duplicate = plan.replace(
      '#### D-002 — Saved executable plans',
      '#### D-001 — User-facing planning command',
    );
    expect(validatePlanStructure(duplicate, ['EWP-P0A-TS01'])).toContain(
      'duplicate detailed decision heading D-001',
    );
    expect(validatePlanStructure(duplicate, ['EWP-P0A-TS01'])).toContain(
      'missing detailed decision heading D-002',
    );
  });

  test('EWP-P0A-TS01 rejects unresolved decision status', () => {
    const unresolved = plan.replace('- **Status:** accepted', '- **Status:** pending');
    expect(validatePlanStructure(unresolved, ['EWP-P0A-TS01'])).toContain(
      'D-001 decision status must be accepted, found pending',
    );
  });

  test.each([
    ['answer', '- **Answer:**'],
    ['rationale', '- **Rationale:**'],
    ['rejected alternatives', '- **Rejected alternatives:**'],
    ['affected sections', '- **Affected sections:**'],
    ['recorded date', '- **Recorded:**'],
  ])('EWP-P0A-TS01 rejects a decision missing %s', (field, marker) => {
    const start = plan.indexOf('#### D-001 —');
    const markerIndex = plan.indexOf(marker, start);
    const mutated = `${plan.slice(0, markerIndex)}- **Removed ${field}:**${plan.slice(markerIndex + marker.length)}`;
    expect(validatePlanStructure(mutated, ['EWP-P0A-TS01'])).toContain(
      `D-001 missing decision ${field}`,
    );
  });

  test('EWP-P0A-TS01 rejects missing amendment history and descending ranges', () => {
    const start = plan.indexOf('#### D-006 —');
    const end = plan.indexOf('#### D-007 —', start);
    const section = plan.slice(start, end).replace(/^- \*\*Amended:\*\*.+(?:\n {2}.+)*/gm, '');
    const missingAmendment = `${plan.slice(0, start)}${section}${plan.slice(end)}`;
    expect(validatePlanStructure(missingAmendment, ['EWP-P0A-TS01'])).toContain(
      'D-006 decision amendment history none does not match 2026-07-11:EWP-CF-021,2026-07-11:EWP-CF-022',
    );
    const descending = plan.replace('D-001..D-016', 'D-016..D-001');
    expect(validatePlanStructure(descending, ['EWP-P0A-TS01'])).toContain(
      'malformed descending range D-016..D-001',
    );
  });

  test('EWP-P0A-TS01 rejects duplicate rows, empty fields, and wrong amendment identities', () => {
    const registerRow =
      '| D-001 | User-facing planning command | Separate `plan`; plain `apply` also plans | Only `apply --dry-run` | accepted |';
    expect(
      validatePlanStructure(plan.replace(registerRow, `${registerRow}\n${registerRow}`), [
        'EWP-P0A-TS01',
      ]),
    ).toContain('D-001 duplicate decision register row');
    const emptyRationale = plan.replace(
      /^- \*\*Rationale:\*\*[\s\S]*?(?=\n- \*\*Rejected alternatives:)/m,
      '- **Rationale:**',
    );
    expect(validatePlanStructure(emptyRationale, ['EWP-P0A-TS01'])).toContain(
      'D-001 decision rationale is empty or not meaningful',
    );
    const wrongAmendment = plan.replace('by EWP-CF-029', 'by EWP-CF-999');
    expect(validatePlanStructure(wrongAmendment, ['EWP-P0A-TS01'])).toContain(
      'D-003 decision amendment history 2026-07-11:EWP-CF-999 does not match 2026-07-11:EWP-CF-029',
    );
  });

  test('EWP-P0A-TS01 rejects comment-only fields, undefined decisions, and wrong amendment dates', () => {
    const commentOnly = plan.replace(
      /^- \*\*Rationale:\*\*[\s\S]*?(?=\n- \*\*Rejected alternatives:)/m,
      '- **Rationale:** <!-- -->',
    );
    expect(validatePlanStructure(commentOnly, ['EWP-P0A-TS01'])).toContain(
      'D-001 decision rationale is empty or not meaningful',
    );
    expect(validatePlanStructure(`${plan}\nSee D-999.\n`, ['EWP-P0A-TS01'])).toContain(
      'malformed or undefined identifier D-999',
    );
    const wrongDate = plan.replace('2026-07-11 by EWP-CF-029', '2099-12-31 by EWP-CF-029');
    expect(validatePlanStructure(wrongDate, ['EWP-P0A-TS01'])).toContain(
      'D-003 decision amendment history 2099-12-31:EWP-CF-029 does not match 2026-07-11:EWP-CF-029',
    );
  });

  test.each([
    ['answer', '- **Answer:** forged duplicate answer'],
    ['answer', '- **Answer:** <!-- forged -->'],
    ['recorded date', '- **Recorded:** 2099-12-31'],
    ['recorded date', '- **Recorded:** not-a-date'],
  ])('EWP-P0A-TS01 rejects duplicate decision %s fields', (field, duplicate) => {
    const end = plan.indexOf('#### D-002 —');
    const mutated = `${plan.slice(0, end)}${duplicate}\n\n${plan.slice(end)}`;
    expect(validatePlanStructure(mutated, ['EWP-P0A-TS01'])).toContain(
      `D-001 has duplicate decision ${field} fields`,
    );
  });

  test.each([
    ['inline', '2026-07-11 by EWP-CF-029 forged continuation'],
    ['multiline', '2026-07-11 by EWP-CF-029\n  forged continuation'],
  ])('EWP-P0A-TS01 rejects %s forged amendment continuation', (_kind, replacement) => {
    const mutated = plan.replace('2026-07-11 by EWP-CF-029', replacement);
    expect(validatePlanStructure(mutated, ['EWP-P0A-TS01'])).toContain(
      'D-003 decision amendment content does not match canonical history',
    );
  });

  test('EWP-P0A-TS01 rejects duplicate and suffixed decision status values', () => {
    const end = plan.indexOf('#### D-002 —');
    const duplicate = `${plan.slice(0, end)}- **Status:** modified\n\n${plan.slice(end)}`;
    expect(validatePlanStructure(duplicate, ['EWP-P0A-TS01'])).toContain(
      'D-001 has duplicate decision status fields',
    );
    const suffixed = plan.replace('- **Status:** accepted', '- **Status:** accepted forged suffix');
    expect(validatePlanStructure(suffixed, ['EWP-P0A-TS01'])).toContain(
      'D-001 decision status must be accepted, found accepted forged suffix',
    );
  });

  test('EWP-P0A-TS01 rejects malformed amendment-like markers', () => {
    const end = plan.indexOf('#### D-002 —');
    for (const marker of ['Amended :', 'Amendment:', 'amended:']) {
      const mutated = `${plan.slice(0, end)}- **${marker}** 2099-12-31 by EWP-CF-001\n\n${plan.slice(end)}`;
      expect(validatePlanStructure(mutated, ['EWP-P0A-TS01'])).toContain(
        `D-001 has malformed decision field marker - **${marker}**`,
      );
    }
  });

  test('EWP-P0A-TS01 rejects lookalike required decision field markers', () => {
    const end = plan.indexOf('#### D-002 —');
    for (const marker of [
      'Status :',
      'status:',
      'Answer :',
      'recorded:',
      'Amendments:',
      'Amend:',
      'Decision status:',
      'Recorded date:',
      'Rejected alternative:',
    ]) {
      const mutated = `${plan.slice(0, end)}- **${marker}** modified\n\n${plan.slice(end)}`;
      expect(validatePlanStructure(mutated, ['EWP-P0A-TS01'])).toContain(
        `D-001 has malformed decision field marker - **${marker}**`,
      );
    }
  });

  test.each([
    '  - **Unknown:** forged',
    '-  **Unknown:** forged',
    '\t- **Unknown:** forged',
    '+ **Unknown:** forged',
    '* **Unknown:** forged',
    '  - **Status:** modified',
  ])('EWP-P0A-TS01 rejects Markdown list field disguise %s', (field) => {
    const end = plan.indexOf('#### D-002 —');
    const mutated = `${plan.slice(0, end)}${field}\n\n${plan.slice(end)}`;
    const label = field.match(/\*\*([^*]+)\*\*/)?.[1] ?? '';
    expect(validatePlanStructure(mutated, ['EWP-P0A-TS01'])).toContain(
      `D-001 has malformed decision field marker - **${label}**`,
    );
  });

  test.each(['- __Unknown:__ forged', '- __Status:__ modified', '  + __Recorded:__ 2099-12-31'])(
    'EWP-P0A-TS01 rejects underscore-strong field disguise %s',
    (field) => {
      const insertion = plan.indexOf('- **Rationale:**', plan.indexOf('#### D-001 —'));
      const mutated = `${plan.slice(0, insertion)}${field}\n${plan.slice(insertion)}`;
      const label = field.match(/__([^_]+)__/u)?.[1] ?? '';
      expect(validatePlanStructure(mutated, ['EWP-P0A-TS01'])).toContain(
        `D-001 has malformed decision field marker - **${label}**`,
      );
    },
  );

  test.each([
    '- ***Unknown:*** forged',
    '- ___Unknown:___ forged',
    '\t\t- **Unknown:** forged',
    '- Unknown: forged',
  ])('EWP-P0A-TS01 rejects arbitrary unordered-list disguise %s', (field) => {
    const insertion = plan.indexOf('- **Rationale:**', plan.indexOf('#### D-001 —'));
    const mutated = `${plan.slice(0, insertion)}${field}\n${plan.slice(insertion)}`;
    expect(
      validatePlanStructure(mutated, ['EWP-P0A-TS01']).some((diagnostic) =>
        diagnostic.startsWith('D-001 has malformed decision field marker'),
      ),
    ).toBe(true);
  });

  test.each(['> - **Unknown:** forged', '> - **Status:** modified', '>   - Unknown: forged'])(
    'EWP-P0A-TS01 rejects blockquoted unordered-list disguise %s',
    (field) => {
      const insertion = plan.indexOf('- **Rationale:**', plan.indexOf('#### D-001 —'));
      const mutated = `${plan.slice(0, insertion)}${field}\n${plan.slice(insertion)}`;
      expect(
        validatePlanStructure(mutated, ['EWP-P0A-TS01']).some((diagnostic) =>
          diagnostic.startsWith('D-001 has malformed decision field marker'),
        ),
      ).toBe(true);
    },
  );

  test.each([
    '-\n  **Unknown:** forged',
    '+\n  **Status:** modified',
    '*\n  __Unknown:__ forged',
    '> -\n>   **Unknown:** forged',
    '> > -\n> >   **Unknown:** forged',
  ])('EWP-P0A-TS01 rejects empty-list container disguise %s', (field) => {
    const insertion = plan.indexOf('- **Rationale:**', plan.indexOf('#### D-001 —'));
    const mutated = `${plan.slice(0, insertion)}${field}\n${plan.slice(insertion)}`;
    expect(validatePlanStructure(mutated, ['EWP-P0A-TS01'])).toContain(
      'decision detail block does not match canonical accepted record',
    );
  });
});
