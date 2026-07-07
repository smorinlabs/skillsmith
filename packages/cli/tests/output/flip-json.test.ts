import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FlipReport } from '@skillsmith/core';
import { FlipJsonSchema, renderFlipJson } from '../../src/output/flip-json.ts';

const GOLDEN_PATH = join(import.meta.dir, '..', 'fixtures', 'flip-report.golden.json');
const goldenText = readFileSync(GOLDEN_PATH, 'utf8');

// Matches the spec §11 contract example verbatim, minus `kind`/`schemaVersion` (renderFlipJson
// adds those) and minus `error` (core-only, never rendered).
const report: FlipReport = {
  op: 'promote',
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
      action: 'flipped',
      reason: null,
      before: {
        mode: 'dev',
        symlinkTarget:
          '/Users/alice/c/smorinlabs-harness/plugins/factor-harness/skills/factor-scan',
      },
      after: {
        mode: 'pinned',
        storePath:
          '/Users/alice/.local/share/skillsmith/store/smorinlabs/smorinlabs-harness@3f2a1b9c0d4e/factor-scan',
      },
      store: {
        path: '/Users/alice/.local/share/skillsmith/store/smorinlabs/smorinlabs-harness@3f2a1b9c0d4e/factor-scan',
        rev: '3f2a1b9c0d4e',
        gitSha: '3f2a1b9c0d4e0000000000000000000000000000',
        dirty: false,
        reused: false,
      },
      verify: { gate: 'passed', verdict: 'pass' },
    },
    {
      skill: 'factor-scan',
      tool: 'codex',
      placementPath: '/Users/alice/.codex/skills/factor-scan',
      action: 'refused',
      reason: 'found in both ~/.agents/skills and ~/.codex/skills; resolve the duplicate first',
      before: null,
      after: null,
      store: null,
      verify: null,
      error: {
        code: 'flip-refused',
        message: 'found in both ~/.agents/skills and ~/.codex/skills',
      },
    },
  ],
  summary: { flipped: 1, updated: 0, noop: 0, skipped: 0, refused: 1, failed: 0, rolledBack: 0 },
};

describe('renderFlipJson', () => {
  test('matches the committed golden (parse-compare, formatting-proof)', () => {
    const rendered = renderFlipJson(report);
    expect(JSON.parse(rendered)).toEqual(JSON.parse(goldenText));
  });

  test('validates against FlipJsonSchema', () => {
    const rendered = renderFlipJson(report);
    expect(() => FlipJsonSchema.parse(JSON.parse(rendered))).not.toThrow();
  });

  test('top-level field set is exact; kind and schemaVersion are correct', () => {
    const rendered = JSON.parse(renderFlipJson(report)) as Record<string, unknown>;
    expect(Object.keys(rendered).sort()).toEqual(
      ['kind', 'schemaVersion', 'op', 'dryRun', 'requested', 'results', 'summary'].sort(),
    );
    expect(rendered.kind).toBe('skillsmith.flip');
    expect(rendered.schemaVersion).toBe(1);
  });

  test('the core-only `error` field never appears in the rendered output', () => {
    const rendered = JSON.parse(renderFlipJson(report)) as { results: Record<string, unknown>[] };
    for (const r of rendered.results) expect('error' in r).toBe(false);
  });

  test('schema rejects an unknown action', () => {
    const bad = {
      ...report,
      results: [{ ...report.results[0], action: 'installed' }],
    } as unknown as FlipReport;
    expect(() => renderFlipJson(bad)).toThrow();
  });

  test('schema rejects a wrong `kind`', () => {
    const rendered = JSON.parse(renderFlipJson(report));
    rendered.kind = 'skillsmith.verify';
    expect(() => FlipJsonSchema.parse(rendered)).toThrow();
  });

  test('a rollback report renders with op "rollback"', () => {
    const rollback: FlipReport = {
      ...report,
      op: 'rollback',
      results: [
        {
          skill: 'factor-scan',
          tool: 'claude-code',
          placementPath: '/Users/alice/.claude/skills/factor-scan',
          action: 'rolled-back',
          reason: null,
          before: { mode: 'pinned', storePath: '/store/x' },
          after: { mode: 'dev', symlinkTarget: '/src/x' },
          store: {
            path: '/store/x',
            rev: 'abc123def456',
            gitSha: null,
            dirty: false,
            reused: true,
          },
          verify: null,
        },
      ],
      summary: {
        flipped: 0,
        updated: 0,
        noop: 0,
        skipped: 0,
        refused: 0,
        failed: 0,
        rolledBack: 1,
      },
    };
    const rendered = JSON.parse(renderFlipJson(rollback));
    expect(rendered.op).toBe('rollback');
    expect(rendered.results[0].action).toBe('rolled-back');
  });
});
