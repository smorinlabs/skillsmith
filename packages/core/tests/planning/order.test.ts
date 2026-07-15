import { describe, expect, test } from 'bun:test';
import {
  type ExecutableOperation,
  type PlanCheck,
  type PlanningDiagnostic,
  canonicalPlanningString,
  compareExecutableOperations,
  comparePlanChecks,
  comparePlanningDiagnostics,
  comparePlanningText,
} from '../../src/planning/index.ts';

const operation = (
  operationId: string,
  scope: 'user' | 'project',
  skill: string,
  tool: 'claude-code' | 'codex' | 'opencode',
  kind: 'install' | 'repair',
): ExecutableOperation =>
  ({
    operationId,
    scope,
    skill,
    tool,
    kind,
    source: null,
    groupId: `group:${scope}:${skill}`,
    pairId: `pair:${scope}:${skill}:${tool}`,
  }) as unknown as ExecutableOperation;

describe('planning canonical order', () => {
  test('uses unsigned UTF-16 comparison and canonical object-member order', () => {
    expect(comparePlanningText('a', 'b')).toBe(-1);
    expect(comparePlanningText('\u{1f600}', '\ue000')).toBe(-1);
    expect(comparePlanningText('\uffff', '\u{1f600}')).toBe(1);
    expect(canonicalPlanningString({ z: 1, a: { y: true, x: null } })).toBe(
      '{"a":{"x":null,"y":true},"z":1}',
    );
  });

  test('orders operations, checks, and diagnostics from semantic facts', () => {
    const operations = [
      operation('project', 'project', 'alpha', 'codex', 'install'),
      operation('repair', 'user', 'alpha', 'codex', 'repair'),
      operation('opencode', 'user', 'alpha', 'opencode', 'install'),
      operation('claude', 'user', 'alpha', 'claude-code', 'install'),
      operation('install', 'user', 'alpha', 'codex', 'install'),
    ].sort(compareExecutableOperations);
    expect(operations.map(({ operationId }) => operationId)).toEqual([
      'claude',
      'install',
      'repair',
      'opencode',
      'project',
    ]);

    const index = new Map(operations.map(({ operationId }, position) => [operationId, position]));
    const checks = [
      { checkId: 'later', operationIds: ['project'] },
      { checkId: 'z-first', operationIds: ['install'] },
      { checkId: 'a-first', operationIds: ['install'] },
    ] as unknown as PlanCheck[];
    checks.sort((left, right) => comparePlanChecks(index, left, right));
    expect(checks.map(({ checkId }) => checkId)).toEqual(['a-first', 'z-first', 'later']);

    const diagnostic = (diagnosticId: string, scope: 'user' | 'project'): PlanningDiagnostic =>
      ({
        diagnosticId,
        affected: { scope, skill: 'alpha', tool: 'codex' },
        correlation: { groupId: null, pairId: null, operationId: null },
      }) as unknown as PlanningDiagnostic;
    const diagnostics = [diagnostic('project', 'project'), diagnostic('user', 'user')].sort(
      comparePlanningDiagnostics,
    );
    expect(diagnostics.map(({ diagnosticId }) => diagnosticId)).toEqual(['user', 'project']);
  });
});
