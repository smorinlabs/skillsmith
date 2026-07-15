import { describe, expect, test } from 'bun:test';
import type { FlipReport, FlipResult, SkillSmithError } from '@skillsmith/core';
import { flipExitCode } from '../../src/util/flip-exit.ts';

const result = (overrides: Partial<FlipResult> = {}): FlipResult => ({
  skill: 'x',
  tool: 'claude-code',
  placementPath: '/x',
  action: 'flipped',
  reason: null,
  before: null,
  after: null,
  store: null,
  verify: null,
  ...overrides,
});

const report = (results: FlipResult[]): FlipReport => ({
  op: 'promote',
  dryRun: false,
  requested: { targets: [], all: true, tools: ['claude-code'], explicitTools: false },
  plan: {
    domain: 'skillsmith.operation-plan',
    schemaVersion: 1,
    command: 'promote',
    selection: {
      source: 'explicit-all',
      outcome: 'filter-noop',
      targets: [],
      all: true,
      tools: ['claude-code'],
      scopes: ['user', 'project'],
      groupIds: [],
    },
    batchPolicy: 'fail-fast',
    operations: [],
    checks: [],
    diagnostics: [],
  },
  executionResults: [],
  results,
  summary: {
    flipped: 0,
    updated: 0,
    noop: 0,
    skipped: 0,
    refused: 0,
    failed: 0,
    rolledBack: 0,
    created: 0,
    adopted: 0,
  },
});

describe('flipExitCode', () => {
  test('all success actions -> 0', () => {
    const r = report([
      result({ action: 'flipped' }),
      result({ action: 'noop' }),
      result({ action: 'skipped' }),
    ]);
    expect(flipExitCode(r)).toBe(0);
  });

  test('generic error -> 1', () => {
    const e: SkillSmithError = { code: 'generic', message: 'x' };
    const r = report([result({ action: 'failed', error: e })]);
    expect(flipExitCode(r)).toBe(1);
  });

  test('flip-refused -> 2', () => {
    const e: SkillSmithError = { code: 'flip-refused', message: 'x' };
    const r = report([result({ action: 'refused', error: e })]);
    expect(flipExitCode(r)).toBe(2);
  });

  test('ledger-error -> 3', () => {
    const e: SkillSmithError = { code: 'ledger-error', message: 'x' };
    const r = report([result({ action: 'failed', error: e })]);
    expect(flipExitCode(r)).toBe(3);
  });

  test('placement-not-found -> 4', () => {
    const e: SkillSmithError = { code: 'placement-not-found', message: 'x' };
    const r = report([result({ action: 'refused', error: e })]);
    expect(flipExitCode(r)).toBe(4);
  });

  test('source-unresolvable -> 5', () => {
    const e: SkillSmithError = { code: 'source-unresolvable', message: 'x' };
    const r = report([result({ action: 'refused', error: e })]);
    expect(flipExitCode(r)).toBe(5);
  });

  test('permission-denied -> 6', () => {
    const e: SkillSmithError = { code: 'permission-denied', message: 'x' };
    const r = report([result({ action: 'refused', error: e })]);
    expect(flipExitCode(r)).toBe(6);
  });

  test('batch max rule: highest per-pair code wins (2 vs 4 -> 4)', () => {
    const refused: SkillSmithError = { code: 'flip-refused', message: 'x' };
    const notFound: SkillSmithError = { code: 'placement-not-found', message: 'x' };
    const r = report([
      result({ action: 'refused', error: refused }),
      result({ action: 'refused', error: notFound }),
    ]);
    expect(flipExitCode(r)).toBe(4);
  });

  test('batch max rule: a failure outranks a refusal even later in the list (1 after 2 -> 2, but a 6 after 1 -> 6)', () => {
    const refused: SkillSmithError = { code: 'flip-refused', message: 'x' };
    const permission: SkillSmithError = { code: 'permission-denied', message: 'x' };
    const r = report([
      result({ action: 'refused', error: refused }),
      result({ action: 'refused', error: permission }),
    ]);
    expect(flipExitCode(r)).toBe(6);
  });

  test('empty results -> 0', () => {
    expect(flipExitCode(report([]))).toBe(0);
  });
});
