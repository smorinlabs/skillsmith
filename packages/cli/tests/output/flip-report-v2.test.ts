import { describe, expect, test } from 'bun:test';
import type { FlipReport } from '@skillsmith/core';
import type { FlipReportV2 } from '../../../core/tests/fixtures/place/dev-source.ts';
import { renderFlipHuman } from '../../src/output/flip-human.ts';
import { FlipJsonSchema, renderFlipJson } from '../../src/output/flip-json.ts';

// PRD D4: FlipReport contract schemaVersion 1 -> 2. New `action` values `created` / `adopted`;
// new `summary.created` / `summary.adopted` counters alongside flipped/refused/failed. The report
// below is what a `dev --source` batch (one create + one adopt) emits under the v2 contract.
const v2Report: FlipReportV2 = {
  op: 'dev',
  dryRun: false,
  requested: {
    targets: ['factor-scan'],
    all: false,
    tools: ['claude-code', 'codex'],
    explicitTools: false,
  },
  results: [
    {
      skill: 'factor-scan',
      tool: 'claude-code',
      placementPath: '/Users/alice/.claude/skills/factor-scan',
      action: 'created',
      reason: null,
      before: null,
      after: {
        mode: 'dev',
        symlinkTarget:
          '/Users/alice/c/smorinlabs-harness/plugins/factor-harness/skills/factor-scan',
      },
      store: null,
      verify: { gate: 'passed', verdict: 'pass' },
    },
    {
      skill: 'factor-scan',
      tool: 'codex',
      placementPath: '/Users/alice/.agents/skills/factor-scan',
      action: 'adopted',
      reason: null,
      before: {
        mode: 'dev',
        symlinkTarget:
          '/Users/alice/c/smorinlabs-harness/plugins/factor-harness/skills/factor-scan',
      },
      after: {
        mode: 'dev',
        symlinkTarget:
          '/Users/alice/c/smorinlabs-harness/plugins/factor-harness/skills/factor-scan',
      },
      store: null,
      verify: { gate: 'passed', verdict: 'pass' },
    },
  ],
  summary: {
    flipped: 0,
    updated: 0,
    noop: 0,
    skipped: 0,
    refused: 0,
    failed: 0,
    rolledBack: 0,
    created: 1,
    adopted: 1,
  },
};

// The widened v2 shape narrows back to the P12 FlipReport for the renderers until T3 lands the
// real v2 core types (FlipAction ⊂ FlipActionV2, so the downcast is well-formed).
const asReport = (r: FlipReportV2): FlipReport => r as FlipReport;

describe('flip report contract v2 (P13 D4) — renderFlipJson', () => {
  test('renders a created/adopted report with schemaVersion 2', () => {
    const rendered = JSON.parse(renderFlipJson(asReport(v2Report))) as {
      schemaVersion: number;
      kind: string;
      results: { action: string }[];
    };
    expect(rendered.schemaVersion).toBe(2);
    expect(rendered.kind).toBe('skillsmith.flip');
    expect(rendered.results.map((r) => r.action)).toEqual(['created', 'adopted']);
  });

  test('summary carries created/adopted counters alongside the P12 buckets', () => {
    const rendered = JSON.parse(renderFlipJson(asReport(v2Report))) as {
      summary: Record<string, number>;
    };
    expect(rendered.summary.created).toBe(1);
    expect(rendered.summary.adopted).toBe(1);
    expect(rendered.summary.flipped).toBe(0);
    expect(rendered.summary.refused).toBe(0);
  });

  test('the schema accepts v2 payloads but stays closed (unknown actions still rejected)', () => {
    const rendered = renderFlipJson(asReport(v2Report));
    expect(() => FlipJsonSchema.parse(JSON.parse(rendered))).not.toThrow();

    const bad = {
      ...v2Report,
      results: [{ ...v2Report.results[0], action: 'installed' }],
    };
    expect(() => renderFlipJson(bad as unknown as FlipReport)).toThrow();
  });
});

describe('flip report contract v2 (P13 D4) — renderFlipHuman', () => {
  test('summary line counts created and adopted', () => {
    const out = renderFlipHuman(asReport(v2Report), 0);
    expect(out).toContain('1 created');
    expect(out).toContain('1 adopted');
  });
});
