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
import {
  artifactPrefixDependencyError,
  orderExecutableOperationsTopologically,
} from '../../src/planning/order.ts';

const operation = <ToolId extends string>(
  operationId: string,
  scope: 'user' | 'project',
  skill: string,
  tool: ToolId,
  kind: 'install' | 'repair',
): ExecutableOperation<ToolId> =>
  ({
    operationId,
    scope,
    skill,
    tool,
    kind,
    source: null,
    groupId: `group:${scope}:${skill}`,
    pairId: `pair:${scope}:${skill}:${tool}`,
  }) as unknown as ExecutableOperation<ToolId>;

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

  test('uses supplied descriptor order with lexical fallback beyond that context', () => {
    type FixtureTool = 'fixture-a' | 'fixture-b' | 'fixture-z';
    const descriptorContext = { toolOrder: ['fixture-z', 'fixture-a'] as const };
    const operations = [
      operation('a', 'user', 'alpha', 'fixture-a', 'install'),
      operation('b', 'user', 'alpha', 'fixture-b', 'install'),
      operation('z', 'user', 'alpha', 'fixture-z', 'install'),
    ] as ExecutableOperation<FixtureTool>[];

    operations.sort((left, right) => compareExecutableOperations(left, right, descriptorContext));

    expect(operations.map(({ tool }) => tool)).toEqual(['fixture-z', 'fixture-a', 'fixture-b']);

    const lexicalFallback = [
      operation('z-outside', 'user', 'alpha', 'fixture-z', 'install'),
      operation('b-outside', 'user', 'alpha', 'fixture-b', 'install'),
    ];
    lexicalFallback.sort((left, right) =>
      compareExecutableOperations(left, right, { toolOrder: [] }),
    );
    expect(lexicalFallback.map(({ tool }) => tool)).toEqual(['fixture-b', 'fixture-z']);
  });

  test('orders null-pair artifact prerequisites before pair-bound live operations', () => {
    const live = operation('live', 'user', 'alpha', 'codex', 'install');
    const prerequisite = {
      ...operation('migrate', 'project', 'zeta', 'opencode', 'repair'),
      pairId: null,
      scope: null,
      skill: null,
      source: null,
      tool: null,
      kind: 'migrate-ledger',
    } as unknown as ExecutableOperation;

    expect(
      [live, prerequisite].sort(compareExecutableOperations).map(({ operationId }) => operationId),
    ).toEqual(['migrate', 'live']);
  });

  test('orders null-pair artifact prerequisites in dependency order', () => {
    const artifact = (
      operationId: string,
      kind: 'migrate-ledger' | 'migrate-project-config' | 'write-manifest' | 'write-lock',
    ): ExecutableOperation =>
      ({
        ...operation(operationId, 'user', 'artifact', 'codex', 'repair'),
        pairId: null,
        scope: null,
        skill: null,
        source: null,
        tool: null,
        kind,
      }) as unknown as ExecutableOperation;

    expect(
      [
        artifact('lock', 'write-lock'),
        artifact('manifest', 'write-manifest'),
        artifact('project', 'migrate-project-config'),
        artifact('ledger', 'migrate-ledger'),
      ]
        .sort(compareExecutableOperations)
        .map(({ operationId }) => operationId),
    ).toEqual(['ledger', 'project', 'manifest', 'lock']);
  });

  test('preserves semantic group order when no artifact-prefix lane exists', () => {
    const alpha = {
      ...operation('alpha-live', 'user', 'alpha', 'codex', 'install'),
      groupId: 'group:z',
      dependencyMetadata: {
        domain: 'skillsmith.operation-dependency',
        schemaVersion: 1,
        operationIds: [],
      },
    } as unknown as ExecutableOperation;
    const beta = {
      ...operation('beta-live', 'user', 'beta', 'codex', 'install'),
      groupId: 'group:a',
      dependencyMetadata: {
        domain: 'skillsmith.operation-dependency',
        schemaVersion: 1,
        operationIds: [],
      },
    } as unknown as ExecutableOperation;

    expect(
      orderExecutableOperationsTopologically([beta, alpha]).map(({ operationId }) => operationId),
    ).toEqual(['alpha-live', 'beta-live']);
  });

  test('orders only a complete cross-group artifact-prefix barrier', () => {
    const dependencyMetadata = (operationIds: readonly string[]) => ({
      domain: 'skillsmith.operation-dependency' as const,
      schemaVersion: 1 as const,
      operationIds,
    });
    const alphaSeed = operation('alpha-live', 'user', 'alpha', 'codex', 'install');
    const prefix = {
      ...alphaSeed,
      operationId: 'alpha-lock',
      groupId: 'group:sha256:ffff',
      pairId: null,
      scope: null,
      skill: null,
      source: null,
      tool: null,
      kind: 'write-lock',
      after: {
        kind: 'lock',
        location: { kind: 'portable', token: 'artifacts/skills-lock.json' },
      },
      dependencyMetadata: dependencyMetadata([]),
    } as unknown as ExecutableOperation;
    const alpha = {
      ...alphaSeed,
      groupId: 'group:sha256:0000',
      dependencyMetadata: dependencyMetadata([prefix.operationId]),
    } as ExecutableOperation;
    const beta = {
      ...operation('beta-live', 'user', 'beta', 'codex', 'install'),
      groupId: 'group:sha256:1111',
      dependencyMetadata: dependencyMetadata([prefix.operationId]),
    } as ExecutableOperation;
    for (const permutation of [
      [prefix, alpha, beta],
      [prefix, beta, alpha],
      [alpha, prefix, beta],
      [alpha, beta, prefix],
      [beta, prefix, alpha],
      [beta, alpha, prefix],
    ]) {
      expect(
        orderExecutableOperationsTopologically(permutation).map(({ operationId }) => operationId),
      ).toEqual(['alpha-lock', 'alpha-live', 'beta-live']);
    }

    const ledger = {
      ...prefix,
      operationId: 'ledger-migration',
      groupId: 'group:sha256:eeee',
      kind: 'migrate-ledger',
      after: { kind: 'ledger' },
    } as unknown as ExecutableOperation;
    for (const permutation of [
      [ledger, prefix, alpha],
      [ledger, alpha, prefix],
      [prefix, ledger, alpha],
      [prefix, alpha, ledger],
      [alpha, ledger, prefix],
      [alpha, prefix, ledger],
    ]) {
      expect(
        orderExecutableOperationsTopologically(permutation).map(({ operationId }) => operationId),
      ).toEqual(['ledger-migration', 'alpha-lock', 'alpha-live']);
    }

    const partialBeta = {
      ...beta,
      operationId: 'beta-second',
      dependencyMetadata: dependencyMetadata([]),
    };
    expect(() =>
      orderExecutableOperationsTopologically([prefix, alpha, beta, partialBeta]),
    ).toThrow(/does not fully depend on one artifact prefix/i);
    const arbitrary = {
      ...beta,
      dependencyMetadata: dependencyMetadata([alpha.operationId]),
    };
    expect(() => orderExecutableOperationsTopologically([prefix, alpha, arbitrary])).toThrow(
      /invalid cross-group artifact-prefix dependency/i,
    );

    const laterPrefix = {
      ...operation('beta-lock', 'user', 'beta', 'codex', 'install'),
      pairId: null,
      scope: null,
      skill: null,
      source: null,
      tool: null,
      kind: 'write-lock',
      after: {
        kind: 'lock',
        location: { kind: 'portable', token: 'artifacts/skills-lock.json' },
      },
      dependencyMetadata: dependencyMetadata([]),
    } as unknown as ExecutableOperation;
    const earlierManifest = {
      ...operation('alpha-manifest', 'user', 'alpha', 'codex', 'install'),
      pairId: null,
      scope: null,
      skill: null,
      source: null,
      tool: null,
      kind: 'write-manifest',
      dependencyMetadata: dependencyMetadata([laterPrefix.operationId]),
    } as unknown as ExecutableOperation;
    expect(artifactPrefixDependencyError([[earlierManifest], [laterPrefix]])).toMatch(
      /later|forward/i,
    );

    const firstLock = {
      ...prefix,
      operationId: 'group-a-lock',
      groupId: 'group:a',
      dependencyMetadata: dependencyMetadata([]),
    } as unknown as ExecutableOperation;
    const interveningLock = {
      ...prefix,
      operationId: 'group-b-lock',
      groupId: 'group:b',
      dependencyMetadata: dependencyMetadata([firstLock.operationId]),
    } as unknown as ExecutableOperation;
    const staleDependent = {
      ...beta,
      operationId: 'group-c-live',
      groupId: 'group:c',
      dependencyMetadata: dependencyMetadata([firstLock.operationId]),
    } as unknown as ExecutableOperation;
    expect(() =>
      orderExecutableOperationsTopologically([firstLock, interveningLock, staleDependent]),
    ).toThrow(/latest|stale|prefix/i);
  });
});
