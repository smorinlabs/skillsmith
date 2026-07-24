import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { validatePlanStructure } from '../../../scripts/p17-plan-structure';

const root = resolve(import.meta.dir, '../../..');
const plan = readFileSync(
  resolve(root, 'docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md'),
  'utf8',
);

const findingEndOf = (id: string, findingStart: number): number => {
  const nextFinding = Number(id.slice(-3)) + 1;
  const nextHeader = plan.indexOf(
    `#### EWP-CF-${String(nextFinding).padStart(3, '0')} —`,
    findingStart,
  );
  return nextHeader >= 0
    ? nextHeader
    : plan.indexOf('\n### 13.1 Current-program drift', findingStart);
};

describe('EWP-P0A-TS07 accepted-finding traceability validation', () => {
  test('EWP-P0A-TS07 accepts all canonical finding records', () => {
    expect(validatePlanStructure(plan, ['EWP-P0A-TS07'])).toEqual([]);
  });

  test.each([
    ['accepted resolution', '- **Accepted resolution:**'],
    ['saved example', '- **Saved before/after scenario:**'],
    ['affected contracts', '- **Affected sections and validation:**'],
    ['recorded date', '- **Recorded:**'],
  ])('EWP-P0A-TS07 rejects a finding missing %s', (field, marker) => {
    const findingStart = plan.indexOf('#### EWP-CF-001 —');
    const markerIndex = plan.indexOf(marker, findingStart);
    const mutated = `${plan.slice(0, markerIndex)}- **Removed ${field}:**${plan.slice(markerIndex + marker.length)}`;
    expect(validatePlanStructure(mutated, ['EWP-P0A-TS07'])).toContain(
      `EWP-CF-001 missing ${field}`,
    );
  });

  test('EWP-P0A-TS07 rejects index/detail set drift and undefined validation ownership', () => {
    const missingDetail = plan.replace(
      '#### EWP-CF-001 — Correct phase dependencies before extending command-specific orchestration',
      '#### EWP-CF-999 — orphaned conversational finding',
    );
    expect(validatePlanStructure(missingDetail, ['EWP-P0A-TS07'])).toContain(
      'EWP-CF-001 missing detailed finding section',
    );
    const undefinedValidation = plan.replace(
      'EWP-P2-TS01..05, EWP-P3B-TS01..03',
      'EWP-P2-TS99, EWP-P3B-TS01..03',
    );
    expect(validatePlanStructure(undefinedValidation, ['EWP-P0A-TS07'])).toContain(
      'EWP-CF-001 references undefined validation EWP-P2-TS99',
    );
  });

  test('EWP-P0A-TS07 rejects corrupted register and traceability rows', () => {
    const badRegister = plan.replace(
      '| EWP-CF-001 | Following bad precedent | Artifact, inspection, transaction, and apply phases had inverted dependencies | Reordered Phases 2-4 and made shared transaction primitives precede new mutations | accepted |',
      '| EWP-CF-001 | Following bad precedent | Artifact, inspection, transaction, and apply phases had inverted dependencies | WRONG | accepted |',
    );
    expect(validatePlanStructure(badRegister, ['EWP-P0A-TS07'])).toContain(
      'EWP-CF-001 accepted finding index resolution is not meaningful',
    );
    const traceStart = plan.indexOf('| Finding | Normative design retained in |');
    const rowStart = plan.indexOf('| EWP-CF-001 |', traceStart);
    const rowEnd = plan.indexOf('\n', rowStart);
    const badTrace = `${plan.slice(0, rowStart)}| EWP-CF-001 | WRONG | WRONG | EWP-P0A-TS01 |${plan.slice(rowEnd)}`;
    const diagnostics = validatePlanStructure(badTrace, ['EWP-P0A-TS07']);
    expect(diagnostics).toContain('EWP-CF-001 traceability normative contract is not meaningful');
    expect(diagnostics).toContain('EWP-CF-001 traceability example is not meaningful');
    expect(diagnostics).toContain(
      'EWP-CF-001 traceability validation EWP-P0A-TS01 is absent from detailed finding',
    );
  });

  test('EWP-P0A-TS07 rejects meaningful but mismatched traceability content', () => {
    const traceStart = plan.indexOf('| Finding | Normative design retained in |');
    const rowStart = plan.indexOf('| EWP-CF-001 |', traceStart);
    const rowEnd = plan.indexOf('\n', rowStart);
    const mismatched = `${plan.slice(0, rowStart)}| EWP-CF-001 | Section 99 quantum banana protocol | Pending journal abort and committed reversal | EWP-P2-TS01 |${plan.slice(rowEnd)}`;
    const diagnostics = validatePlanStructure(mismatched, ['EWP-P0A-TS07']);
    expect(diagnostics).toContain(
      'EWP-CF-001 traceability normative contract is not linked to its detail',
    );
    expect(diagnostics).toContain('EWP-CF-001 traceability example is not linked to its detail');
  });

  test('EWP-P0A-TS07 rejects duplicate rows, empty detail, and one-word linkage bypass', () => {
    const indexRow = plan.match(/^\| EWP-CF-001 \|.+$/m)?.[0] ?? '';
    expect(
      validatePlanStructure(plan.replace(indexRow, `${indexRow}\n${indexRow}`), ['EWP-P0A-TS07']),
    ).toContain('EWP-CF-001 duplicate accepted finding index row');
    const traceStart = plan.indexOf('| Finding | Normative design retained in |');
    const traceRowStart = plan.indexOf('| EWP-CF-001 |', traceStart);
    const traceRowEnd = plan.indexOf('\n', traceRowStart);
    const traceRow = plan.slice(traceRowStart, traceRowEnd);
    const duplicateTrace = `${plan.slice(0, traceRowStart)}${traceRow}\n${traceRow}${plan.slice(traceRowEnd)}`;
    expect(validatePlanStructure(duplicateTrace, ['EWP-P0A-TS07'])).toContain(
      'EWP-CF-001 duplicate traceability row',
    );
    const findingStart = plan.indexOf('#### EWP-CF-001 —');
    const findingEnd = plan.indexOf('#### EWP-CF-002 —', findingStart);
    const emptyFinding = plan
      .slice(findingStart, findingEnd)
      .replace(
        /^- \*\*Accepted resolution:\*\*[\s\S]*?(?=\n- \*\*Saved before\/after scenario:)/m,
        '- **Accepted resolution:**',
      );
    const emptyResolution = `${plan.slice(0, findingStart)}${emptyFinding}${plan.slice(findingEnd)}`;
    expect(validatePlanStructure(emptyResolution, ['EWP-P0A-TS07'])).toContain(
      'EWP-CF-001 accepted resolution is empty or not meaningful',
    );
    const weakRow =
      '| EWP-CF-001 | Quantum banana transaction protocol | Transaction bananas remain quantum forever | EWP-P2-TS01 |';
    const weakTrace = `${plan.slice(0, traceRowStart)}${weakRow}${plan.slice(traceRowEnd)}`;
    const diagnostics = validatePlanStructure(weakTrace, ['EWP-P0A-TS07']);
    expect(diagnostics).toContain(
      'EWP-CF-001 traceability normative contract is not linked to its detail',
    );
    expect(diagnostics).toContain('EWP-CF-001 traceability example is not linked to its detail');
  });

  test('EWP-P0A-TS07 rejects an HTML-comment-only accepted resolution', () => {
    const findingStart = plan.indexOf('#### EWP-CF-001 —');
    const findingEnd = plan.indexOf('#### EWP-CF-002 —', findingStart);
    const commentOnly = plan
      .slice(findingStart, findingEnd)
      .replace(
        /^- \*\*Accepted resolution:\*\*[\s\S]*?(?=\n- \*\*Saved before\/after scenario:)/m,
        '- **Accepted resolution:** <!-- -->',
      );
    const mutated = `${plan.slice(0, findingStart)}${commentOnly}${plan.slice(findingEnd)}`;
    expect(validatePlanStructure(mutated, ['EWP-P0A-TS07'])).toContain(
      'EWP-CF-001 accepted resolution is empty or not meaningful',
    );
  });

  test('EWP-P0A-TS07 rejects HTML-comment-only index and trace cells', () => {
    const indexRow = plan.match(/^\| EWP-CF-001 \|.+$/m)?.[0] ?? '';
    const indexCells = indexRow.split('|');
    indexCells[4] =
      ' <!-- Reordered Phases 2-4 and shared transaction primitives precede mutations --> ';
    const commentIndex = plan.replace(indexRow, indexCells.join('|'));
    expect(validatePlanStructure(commentIndex, ['EWP-P0A-TS07'])).toContain(
      'EWP-CF-001 accepted finding index resolution is not meaningful',
    );

    const traceStart = plan.indexOf('| Finding | Normative design retained in |');
    const rowStart = plan.indexOf('| EWP-CF-001 |', traceStart);
    const rowEnd = plan.indexOf('\n', rowStart);
    const traceCells = plan.slice(rowStart, rowEnd).split('|');
    traceCells[2] = ' <!-- artifact inspection transaction apply phases --> ';
    traceCells[3] = ' <!-- transaction primitives mutations ordered examples --> ';
    const commentTrace = `${plan.slice(0, rowStart)}${traceCells.join('|')}${plan.slice(rowEnd)}`;
    const diagnostics = validatePlanStructure(commentTrace, ['EWP-P0A-TS07']);
    expect(diagnostics).toContain('EWP-CF-001 traceability normative contract is not meaningful');
    expect(diagnostics).toContain('EWP-CF-001 traceability example is not meaningful');
  });

  test('EWP-P0A-TS07 rejects recorded-date drift in original and amended findings', () => {
    const originalStart = plan.indexOf('#### EWP-CF-001 —');
    const originalDate = plan.indexOf('- **Recorded:** 2026-07-10', originalStart);
    const originalDateDrift = `${plan.slice(0, originalDate)}- **Recorded:** 2099-12-31${plan.slice(originalDate + '- **Recorded:** 2026-07-10'.length)}`;
    expect(validatePlanStructure(originalDateDrift, ['EWP-P0A-TS07'])).toContain(
      'EWP-CF-001 recorded date 2099-12-31 does not match 2026-07-10',
    );

    const amendedStart = plan.indexOf('#### EWP-CF-016 —');
    const amendedDate = plan.indexOf('- **Recorded:** 2026-07-11', amendedStart);
    const amendedDateDrift = `${plan.slice(0, amendedDate)}- **Recorded:** 2026-07-10${plan.slice(amendedDate + '- **Recorded:** 2026-07-11'.length)}`;
    expect(validatePlanStructure(amendedDateDrift, ['EWP-P0A-TS07'])).toContain(
      'EWP-CF-016 recorded date 2026-07-10 does not match 2026-07-11',
    );
  });

  test.each(['EWP-CF-001', 'EWP-CF-015', 'EWP-CF-016', 'EWP-CF-043', 'EWP-CF-044'])(
    'EWP-P0A-TS07 rejects a duplicate recorded date for %s',
    (id) => {
      const findingStart = plan.indexOf(`#### ${id} —`);
      const findingEnd = findingEndOf(id, findingStart);
      const mutated = `${plan.slice(0, findingEnd)}\n- **Recorded:** 2099-12-31${plan.slice(findingEnd)}`;
      expect(validatePlanStructure(mutated, ['EWP-P0A-TS07'])).toContain(
        `${id} has duplicate recorded dates`,
      );
    },
  );

  test.each([
    ['EWP-CF-001', '<!-- forged -->'],
    ['EWP-CF-015', 'not-a-date'],
    ['EWP-CF-016', '2099-1-1'],
    ['EWP-CF-043', '<!-- forged -->'],
    ['EWP-CF-044', 'not-a-date'],
  ])('EWP-P0A-TS07 rejects a malformed duplicate recorded date for %s', (id, value) => {
    const findingStart = plan.indexOf(`#### ${id} —`);
    const findingEnd = findingEndOf(id, findingStart);
    const mutated = `${plan.slice(0, findingEnd)}\n- **Recorded:** ${value}${plan.slice(findingEnd)}`;
    expect(validatePlanStructure(mutated, ['EWP-P0A-TS07'])).toContain(
      `${id} has duplicate recorded dates`,
    );
  });

  test.each(['EWP-CF-001', 'EWP-CF-015', 'EWP-CF-016', 'EWP-CF-043', 'EWP-CF-044'])(
    'EWP-P0A-TS07 rejects recorded-date continuation content for %s',
    (id) => {
      const findingStart = plan.indexOf(`#### ${id} —`);
      const recorded = plan.indexOf('- **Recorded:**', findingStart);
      const lineEnd = plan.indexOf('\n', recorded);
      const recordedDate = /- \*\*Recorded:\*\* (\d{4}-\d{2}-\d{2})/u.exec(
        plan.slice(recorded, lineEnd),
      )?.[1];
      if (recordedDate === undefined) throw new Error(`${id} recorded date fixture missing`);
      const mutated = `${plan.slice(0, lineEnd)}\n  forged extra value${plan.slice(lineEnd)}`;
      expect(validatePlanStructure(mutated, ['EWP-P0A-TS07'])).toContain(
        `${id} recorded date ${recordedDate} forged extra value does not match ${recordedDate}`,
      );
    },
  );
});
