import { describe, expect, test } from 'bun:test';
import {
  type ExecutableOperation,
  type ExecutableOperationKind,
  type OperationDigest,
  type OperationGroupIdentity,
  type OperationIdentity,
  type OperationImage,
  type OperationPairIdentity,
  type OperationPlanInput,
  type OperationSource,
  type PlanCheckIdentity,
  type PlanningDiagnosticIdentity,
  createBoundedForceEffect,
  createOperationExecutionResult,
  createOperationGroupId,
  createOperationId,
  createOperationPairId,
  createOperationPlan,
  createPlanCheckId,
  createPlanningDiagnosticId,
} from '../../src/planning/index.ts';

const CONTENT_HASH = `sha256:${'a'.repeat(64)}` as OperationDigest;
const BYTE_HASH = `sha256:${'b'.repeat(64)}` as OperationDigest;
const SOURCE: OperationSource = {
  kind: 'portable',
  identity: { host: 'example.test', repository: 'fixture/repo', path: 'skills/alpha' },
  requestedRef: null,
  resolvedSha: 'c'.repeat(40),
  sourcePath: 'skills/alpha',
  contentHash: CONTENT_HASH,
};
const RESOURCE = {
  kind: 'live',
  skill: 'alpha',
  tool: 'codex',
  scope: 'user',
  projectRoot: null,
  location: { kind: 'portable', token: 'skills/user/codex/alpha' },
} as const;
const ABSENT: OperationImage = { kind: 'absent', resource: RESOURCE };
const PINNED: OperationImage = {
  kind: 'placement',
  resource: RESOURCE,
  classification: 'pinned',
  representation: 'copy',
  linkTarget: null,
  dangling: false,
  source: SOURCE,
  contentHash: CONTENT_HASH,
};

const groupIdentityFor = (
  source: OperationSource | null = SOURCE,
  skill = 'alpha',
  target: string | null = null,
): OperationGroupIdentity => ({
  domain: 'skillsmith.operation-group-identity',
  schemaVersion: 1,
  command: 'install',
  skill,
  source,
  scope: 'user',
  target,
});

const pairIdentityFor = (groupId: string): OperationPairIdentity => ({
  domain: 'skillsmith.operation-pair-identity',
  schemaVersion: 1,
  groupId,
  tool: 'codex',
  resource: RESOURCE,
});

const identityFor = (kind: ExecutableOperationKind): OperationIdentity => ({
  domain: 'skillsmith.operation-identity',
  schemaVersion: 1,
  groupId: createOperationGroupId(groupIdentityFor()),
  pairId: createOperationPairId(pairIdentityFor(createOperationGroupId(groupIdentityFor()))),
  kind,
  skill: 'alpha',
  source: SOURCE,
  tool: 'codex',
  scope: 'user',
});

const operationFor = (
  kind: 'install' | 'repair' = 'install',
  dependencies: readonly string[] = [],
): ExecutableOperation => ({
  operationId: createOperationId(identityFor(kind)),
  groupId: createOperationGroupId(groupIdentityFor()),
  pairId: createOperationPairId(pairIdentityFor(createOperationGroupId(groupIdentityFor()))),
  kind,
  dependencyMetadata: {
    domain: 'skillsmith.operation-dependency',
    schemaVersion: 1,
    operationIds: dependencies,
  },
  skill: 'alpha',
  source: SOURCE,
  tool: 'codex',
  scope: 'user',
  before: kind === 'install' ? ABSENT : PINNED,
  after: PINNED,
  reason: { code: `${kind}-selected`, message: `${kind} selected.` },
  selectionSource: 'explicit-targets',
  preconditionIds: [],
  requiredCheckIds: [],
  reversibility: { kind: 'none', retentionResourceIds: [] },
  mutates: { live: true, manifest: false, lock: false, ledger: true },
  conflict: null,
});

const planFor = (
  operations: readonly ExecutableOperation[] = [operationFor()],
): OperationPlanInput => ({
  domain: 'skillsmith.operation-plan',
  schemaVersion: 1,
  command: 'install',
  selection: {
    source: 'explicit-targets',
    skills: ['alpha'],
    tools: ['codex'],
    scopes: ['user'],
  },
  batchPolicy: 'fail-fast',
  operations,
  checks: [],
  diagnostics: [],
});

describe('planning constructors', () => {
  test('hashes structured group, pair, check, and diagnostic identities without indexes or delimiters', () => {
    const groupIdentity = groupIdentityFor();
    const groupId = createOperationGroupId(groupIdentity);
    const pairId = createOperationPairId(pairIdentityFor(groupId));
    const installId = createOperationId({
      ...identityFor('install'),
      groupId,
      pairId,
    });
    const repairId = createOperationId({
      ...identityFor('repair'),
      groupId,
      pairId,
    });

    expect(groupId).toMatch(/^group:v1:[0-9a-f]{64}$/);
    expect(pairId).toMatch(/^pair:v1:[0-9a-f]{64}$/);
    expect(
      createOperationGroupId(
        Object.fromEntries(
          Object.entries(groupIdentity).reverse(),
        ) as unknown as OperationGroupIdentity,
      ),
    ).toBe(groupId);
    expect(
      createOperationPairId(
        Object.fromEntries(
          Object.entries(pairIdentityFor(groupId)).reverse(),
        ) as unknown as OperationPairIdentity,
      ),
    ).toBe(pairId);

    const changedSource: OperationSource = {
      ...SOURCE,
      resolvedSha: 'd'.repeat(40),
      contentHash: BYTE_HASH,
    };
    expect(createOperationGroupId(groupIdentityFor(changedSource))).not.toBe(groupId);
    expect(createOperationGroupId(groupIdentityFor(null, 'a:b', 'c'))).not.toBe(
      createOperationGroupId(groupIdentityFor(null, 'a', 'b:c')),
    );

    const checkIdentity: PlanCheckIdentity = {
      domain: 'skillsmith.plan-check-identity',
      schemaVersion: 1,
      kind: 'precondition-validation',
      operationIds: [repairId, installId],
      preconditionIds: ['precondition:z', 'precondition:a'],
    };
    const checkId = createPlanCheckId(checkIdentity);
    expect(checkId).toMatch(/^check:v1:[0-9a-f]{64}$/);
    expect(
      createPlanCheckId({
        ...checkIdentity,
        operationIds: [installId, repairId],
        preconditionIds: ['precondition:a', 'precondition:z'],
      }),
    ).toBe(checkId);

    const diagnosticIdentity: PlanningDiagnosticIdentity = {
      domain: 'skillsmith.planning-diagnostic-identity',
      schemaVersion: 1,
      kind: 'warning',
      severity: 'warning',
      refusalClass: null,
      affected: {
        skill: 'alpha',
        source: SOURCE,
        tool: 'codex',
        scope: 'user',
        path: RESOURCE.location,
      },
      correlation: { groupId, pairId, operationId: installId },
      reasonCode: 'fixture-warning',
      selectionSource: 'explicit-targets',
    };
    const diagnosticId = createPlanningDiagnosticId(diagnosticIdentity);
    expect(diagnosticId).toMatch(/^diagnostic:v1:[0-9a-f]{64}$/);
    expect(
      createPlanningDiagnosticId(
        Object.fromEntries(
          Object.entries(diagnosticIdentity).reverse(),
        ) as unknown as PlanningDiagnosticIdentity,
      ),
    ).toBe(diagnosticId);
    expect(
      createPlanningDiagnosticId({ ...diagnosticIdentity, reasonCode: 'other-warning' }),
    ).not.toBe(diagnosticId);

    expect(() =>
      createOperationGroupId({
        ...groupIdentity,
        target: 'authorization: Bearer fixture-secret-value',
      }),
    ).toThrow(/sensitive material/i);
    expect(() => createOperationPairId(new Proxy(pairIdentityFor(groupId), {}))).toThrow(
      /proxies/i,
    );
  });

  test('creates collision-safe IDs and immutable caller-detached canonical plans', () => {
    const identity = identityFor('install');
    const reversedIdentity = Object.fromEntries(Object.entries(identity).reverse());
    expect(createOperationId(reversedIdentity as unknown as OperationIdentity)).toBe(
      createOperationId(identity),
    );

    const install = operationFor('install');
    const repair = operationFor('repair', [install.operationId]);
    const input = structuredClone(planFor([repair, install]));
    const plan = createOperationPlan(input);
    expect(plan.operations.map(({ kind }) => kind)).toEqual(['install', 'repair']);
    expect(plan.operations[1]?.dependencyMetadata.operationIds).toEqual([install.operationId]);
    expect(Object.isFrozen(plan)).toBeTrue();
    expect(Object.isFrozen(plan.operations)).toBeTrue();
    expect(Object.isFrozen(plan.operations[1]?.dependencyMetadata.operationIds)).toBeTrue();

    const mutableInput = input as unknown as { selection: { skills?: string[] } };
    mutableInput.selection.skills?.push('caller-mutation');
    expect(plan.selection.skills).toEqual(['alpha']);
    expect(() => (plan.operations as ExecutableOperation[]).push(install)).toThrow(TypeError);
  });

  test('rejects non-ordinary input and invalid dependency or identity facts', () => {
    expect(() => createOperationId(new Proxy(identityFor('install'), {}))).toThrow(/proxies/i);

    const accessorIdentity = { ...identityFor('install') } as Record<string, unknown>;
    Object.defineProperty(accessorIdentity, 'skill', { enumerable: true, get: () => 'alpha' });
    expect(() => createOperationId(accessorIdentity as unknown as OperationIdentity)).toThrow(
      /accessor/i,
    );

    const prototypeKeyIdentity = Object.assign(Object.create(null), identityFor('install'));
    Object.defineProperty(prototypeKeyIdentity, '__proto__', {
      value: { polluted: true },
      enumerable: true,
    });
    expect(() => createOperationId(prototypeKeyIdentity as OperationIdentity)).toThrow(
      /__proto__.*unknown/i,
    );
    expect(Reflect.get(Object.prototype, 'polluted')).toBeUndefined();

    const sparse = structuredClone(planFor()) as unknown as Record<string, unknown>;
    (sparse.selection as Record<string, unknown>).skills = Array(1);
    expect(() => createOperationPlan(sparse as unknown as OperationPlanInput)).toThrow(/sparse/i);

    const mismatched = structuredClone(operationFor());
    (mismatched as unknown as Record<string, unknown>).operationId = createOperationId(
      identityFor('repair'),
    );
    expect(() => createOperationPlan(planFor([mismatched]))).toThrow(/semantic identity/i);

    const dangling = structuredClone(operationFor('repair'));
    (dangling.dependencyMetadata as unknown as { operationIds: string[] }).operationIds = [
      'operation:v1:missing',
    ];
    expect(() => createOperationPlan(planFor([dangling]))).toThrow(/dangling dependency/i);

    const implicitDev = structuredClone(planFor()) as unknown as Record<string, unknown>;
    implicitDev.command = 'dev';
    (implicitDev.selection as Record<string, unknown>).source = 'bounded-default';
    expect(() => createOperationPlan(implicitDev as unknown as OperationPlanInput<'dev'>)).toThrow(
      /selection.*explicit/i,
    );
  });

  test('constructs closed execution, image, and bounded-force products', () => {
    const operationId = createOperationId(identityFor('install'));
    const resultInput = {
      operationId,
      outcome: 'succeeded',
      actualBefore: structuredClone(ABSENT),
      actualAfter: structuredClone(PINNED),
      force: null,
      error: null,
    } as const;
    const result = createOperationExecutionResult(resultInput);
    expect(result).toEqual(resultInput);
    expect(Object.isFrozen(result.actualAfter)).toBeTrue();

    expect(() =>
      createOperationExecutionResult({ ...resultInput, outcome: 'failed', error: null }),
    ).toThrow(/error must be present exactly/i);
    expect(() =>
      createOperationExecutionResult({
        ...resultInput,
        outcome: 'failed',
        error: {
          code: 'fixture-failed',
          message: 'authorization: Bearer fixture-secret-value',
          remediation: 'Retry with a sanitized fixture.',
        },
      }),
    ).toThrow(/sensitive material/i);
    expect(() =>
      createOperationExecutionResult({
        ...resultInput,
        actualAfter: {
          kind: 'ledger',
          projectRoot: null,
          schemaVersion: 3,
          byteHash: BYTE_HASH,
          semanticHash: BYTE_HASH,
        },
      } as never),
    ).toThrow(/schemaVersion/i);

    const force = createBoundedForceEffect({
      supported: true,
      requested: true,
      applied: true,
      conflict: {
        class: 'source-changed',
        normal: 'refuse',
        forced: 'replace',
        target: RESOURCE,
        backup: 'none',
      },
    });
    expect(force).toMatchObject({
      requested: true,
      applied: true,
      conflictType: 'source-changed',
      forcedBehavior: 'replace',
      backup: 'none',
    });
    expect(Object.isFrozen(force.target)).toBeTrue();
  });
});
