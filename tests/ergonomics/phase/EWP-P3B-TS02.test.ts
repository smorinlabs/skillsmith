import { describe, expect, test } from 'bun:test';
import * as publicCore from '../../../packages/core/src/index.ts';

type UnknownRecord = Record<string, unknown>;
type CreateOperationPlan = (input: UnknownRecord) => UnknownRecord;
type CreateOperationExecutionResult = (input: UnknownRecord) => UnknownRecord;
type CreateOperationId = (input: Readonly<UnknownRecord>) => string;

const core = publicCore as unknown as UnknownRecord;
const CONTENT_HASH = `sha256:${'c'.repeat(64)}`;
const RESOLVED_SHA = 'd'.repeat(40);
const portableSource = Object.freeze({
  kind: 'portable',
  identity: Object.freeze({ host: 'example.test', repository: 'fixture/repo', path: 'skills' }),
  requestedRef: null,
  resolvedSha: RESOLVED_SHA,
  sourcePath: 'skills',
  contentHash: CONTENT_HASH,
});

const requireFactory = <TFunction extends (...args: never[]) => unknown>(
  name: string,
): TFunction => {
  const candidate = core[name];
  expect(typeof candidate, `missing G3B-01 public ${name} behavior`).toBe('function');
  return candidate as TFunction;
};

const asRecord = (value: unknown, label: string): UnknownRecord => {
  expect(value !== null && typeof value === 'object' && !Array.isArray(value), label).toBeTrue();
  return value as UnknownRecord;
};

const asRecords = (value: unknown, label: string): UnknownRecord[] => {
  expect(Array.isArray(value), label).toBeTrue();
  return value as UnknownRecord[];
};

const resourceFor = (skill: string, tool: string, scope: string): UnknownRecord => ({
  kind: 'live',
  skill,
  tool,
  scope,
  projectRoot: scope === 'project' ? { kind: 'portable', token: 'project-root' } : null,
  location: { kind: 'portable', token: `skills/${scope}/${tool}/${skill}` },
});

const identityFor = ({
  groupId,
  pairId,
  kind,
  skill,
  tool,
  scope,
}: Readonly<{
  groupId: string;
  pairId: string;
  kind: string;
  skill: string;
  tool: string;
  scope: string;
}>): UnknownRecord => ({
  domain: 'skillsmith.operation-identity',
  schemaVersion: 1,
  groupId,
  pairId,
  kind,
  skill,
  source: structuredClone(portableSource),
  tool,
  scope,
});

const operationFor = ({
  operationId,
  groupId,
  pairId,
  kind,
  skill,
  tool,
  scope,
  dependencies = [],
  checkId,
}: Readonly<{
  operationId: string;
  groupId: string;
  pairId: string;
  kind: string;
  skill: string;
  tool: string;
  scope: string;
  dependencies?: readonly string[];
  checkId: string;
}>): UnknownRecord => {
  const resource = resourceFor(skill, tool, scope);
  const before =
    kind === 'repair'
      ? {
          kind: 'placement',
          resource,
          classification: 'pinned',
          representation: 'symlink',
          linkTarget: { kind: 'portable', token: `store/${CONTENT_HASH}` },
          dangling: false,
          source: structuredClone(portableSource),
          contentHash: CONTENT_HASH,
        }
      : { kind: 'absent', resource };
  return {
    operationId,
    groupId,
    pairId,
    kind,
    dependencyMetadata: {
      domain: 'skillsmith.operation-dependency',
      schemaVersion: 1,
      operationIds: [...dependencies],
    },
    skill,
    source: structuredClone(portableSource),
    tool,
    scope,
    before,
    after: {
      kind: 'placement',
      resource,
      classification: 'pinned',
      representation: 'copy',
      linkTarget: null,
      dangling: false,
      source: structuredClone(portableSource),
      contentHash: CONTENT_HASH,
    },
    reason: { code: `${kind}-selected`, message: `${kind} selected for ${skill}.` },
    selectionSource: 'explicit-all',
    preconditionIds: [`precondition:${scope}:${skill}:${tool}`],
    requiredCheckIds: [checkId],
    reversibility: { kind: 'none', retentionResourceIds: [] },
    mutates: { live: true, manifest: false, lock: false, ledger: true },
    conflict: null,
  };
};

const reverseObjectMembers = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(reverseObjectMembers);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as UnknownRecord)
      .reverse()
      .map(([key, child]) => [key, reverseObjectMembers(child)]),
  );
};

const permutations = <T>(values: readonly T[]): T[][] => {
  if (values.length <= 1) return [[...values]];
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)]).map((rest) => [
      value,
      ...rest,
    ]),
  );
};

const executionIntent = (plan: UnknownRecord): readonly UnknownRecord[] =>
  asRecords(plan.operations, 'plan operations').map((operation) => structuredClone(operation));

describe('EWP-P3B-TS02', () => {
  test('constructs collision-safe identities and canonical plans across exhaustive input permutations', () => {
    const createOperationPlan = requireFactory<CreateOperationPlan>('createOperationPlan');
    const createOperationExecutionResult = requireFactory<CreateOperationExecutionResult>(
      'createOperationExecutionResult',
    );
    const createOperationId = requireFactory<CreateOperationId>('createOperationId');

    const alphaInstallIdentity = identityFor({
      groupId: 'group:user:alpha',
      pairId: 'pair:user:alpha:codex',
      kind: 'install',
      skill: 'alpha',
      tool: 'codex',
      scope: 'user',
    });
    const alphaRepairIdentity = identityFor({
      groupId: 'group:user:alpha',
      pairId: 'pair:user:alpha:codex',
      kind: 'repair',
      skill: 'alpha',
      tool: 'codex',
      scope: 'user',
    });
    const betaInstallIdentity = identityFor({
      groupId: 'group:project:beta',
      pairId: 'pair:project:beta:opencode',
      kind: 'install',
      skill: 'beta',
      tool: 'opencode',
      scope: 'project',
    });
    const alphaInstallId = createOperationId(alphaInstallIdentity);
    const alphaRepairId = createOperationId(alphaRepairIdentity);
    const betaInstallId = createOperationId(betaInstallIdentity);
    for (const [identity, operationId] of [
      [alphaInstallIdentity, alphaInstallId],
      [alphaRepairIdentity, alphaRepairId],
      [betaInstallIdentity, betaInstallId],
    ] as const) {
      expect(operationId).toBeString();
      expect(operationId.length).toBeGreaterThan(16);
      expect(createOperationId(reverseObjectMembers(identity) as UnknownRecord)).toBe(operationId);
    }
    expect(new Set([alphaInstallId, alphaRepairId, betaInstallId])).toHaveSize(3);

    const generatedIdentities = Array.from({ length: 64 }, (_, index) =>
      identityFor({
        groupId: `group:${index % 2 === 0 ? 'user' : 'project'}:skill:${index}/%`,
        pairId: `pair:${index}:codex:segment`,
        kind: index % 3 === 0 ? 'install' : index % 3 === 1 ? 'update' : 'repair',
        skill: `skill:${index}/%`,
        tool: index % 2 === 0 ? 'codex' : 'opencode',
        scope: index % 2 === 0 ? 'user' : 'project',
      }),
    );
    const generatedIds = generatedIdentities.map(createOperationId);
    expect(new Set(generatedIds)).toHaveSize(generatedIdentities.length);
    for (const [index, identity] of generatedIdentities.entries()) {
      expect(createOperationId(reverseObjectMembers(identity) as UnknownRecord)).toBe(
        generatedIds[index],
      );
    }
    const delimiterCollisionLeft = identityFor({
      groupId: 'group:user:a',
      pairId: 'pair:user:a:b:codex',
      kind: 'install',
      skill: 'a:b',
      tool: 'codex',
      scope: 'user',
    });
    const delimiterCollisionRight = identityFor({
      groupId: 'group:user:a:b',
      pairId: 'pair:user:a:codex',
      kind: 'install',
      skill: 'a',
      tool: 'codex',
      scope: 'user',
    });
    expect(createOperationId(delimiterCollisionLeft)).not.toBe(
      createOperationId(delimiterCollisionRight),
    );

    const alphaCheckId = 'check:user:alpha:preconditions';
    const betaCheckId = 'check:project:beta:preconditions';
    const alphaInstall = operationFor({
      operationId: alphaInstallId,
      groupId: 'group:user:alpha',
      pairId: 'pair:user:alpha:codex',
      kind: 'install',
      skill: 'alpha',
      tool: 'codex',
      scope: 'user',
      checkId: alphaCheckId,
    });
    const alphaRepair = operationFor({
      operationId: alphaRepairId,
      groupId: 'group:user:alpha',
      pairId: 'pair:user:alpha:codex',
      kind: 'repair',
      skill: 'alpha',
      tool: 'codex',
      scope: 'user',
      dependencies: [alphaInstallId],
      checkId: alphaCheckId,
    });
    const betaInstall = operationFor({
      operationId: betaInstallId,
      groupId: 'group:project:beta',
      pairId: 'pair:project:beta:opencode',
      kind: 'install',
      skill: 'beta',
      tool: 'opencode',
      scope: 'project',
      checkId: betaCheckId,
    });

    const alphaCheck: UnknownRecord = {
      checkId: alphaCheckId,
      blocking: true,
      operationIds: [alphaInstallId, alphaRepairId],
      kind: 'precondition-validation',
      preconditionIds: ['precondition:user:alpha:codex'],
    };
    const betaCheck: UnknownRecord = {
      checkId: betaCheckId,
      blocking: true,
      operationIds: [betaInstallId],
      kind: 'precondition-validation',
      preconditionIds: ['precondition:project:beta:opencode'],
    };
    const alphaDiagnostic: UnknownRecord = {
      diagnosticId: 'diagnostic:user:alpha:warning',
      kind: 'warning',
      severity: 'warning',
      refusalClass: null,
      affected: {
        skill: 'alpha',
        source: structuredClone(portableSource),
        tool: 'codex',
        scope: 'user',
        path: null,
      },
      correlation: {
        groupId: 'group:user:alpha',
        pairId: 'pair:user:alpha:codex',
        operationId: alphaInstallId,
      },
      reason: { code: 'alpha-warning', message: 'Synthetic local planning warning.' },
      selectionSource: 'explicit-all',
    };
    const betaDiagnostic: UnknownRecord = {
      diagnosticId: 'diagnostic:project:beta:noop',
      kind: 'noop',
      severity: 'info',
      refusalClass: null,
      affected: {
        skill: 'beta',
        source: structuredClone(portableSource),
        tool: 'opencode',
        scope: 'project',
        path: null,
      },
      correlation: {
        groupId: 'group:project:beta',
        pairId: 'pair:project:beta:opencode',
        operationId: null,
      },
      reason: { code: 'beta-noop', message: 'Synthetic local planning noop.' },
      selectionSource: 'explicit-all',
    };

    const baseInput: UnknownRecord = {
      domain: 'skillsmith.operation-plan',
      schemaVersion: 1,
      command: 'install',
      selection: {
        source: 'explicit-all',
        skills: ['alpha', 'beta'],
        tools: ['codex', 'opencode'],
        scopes: ['user', 'project'],
      },
      batchPolicy: 'fail-fast',
      operations: [alphaInstall, alphaRepair, betaInstall],
      checks: [alphaCheck, betaCheck],
      diagnostics: [alphaDiagnostic, betaDiagnostic],
    };
    const baseline = createOperationPlan(baseInput);
    let permutationCount = 0;
    const selection = asRecord(baseInput.selection, 'base selection');
    for (const operations of permutations([alphaInstall, alphaRepair, betaInstall])) {
      for (const checks of permutations([alphaCheck, betaCheck])) {
        for (const diagnostics of permutations([alphaDiagnostic, betaDiagnostic])) {
          for (const skills of permutations(selection.skills as string[])) {
            for (const tools of permutations(selection.tools as string[])) {
              for (const scopes of permutations(selection.scopes as string[])) {
                const permuted: UnknownRecord = {
                  ...structuredClone(baseInput),
                  selection: { source: 'explicit-all', skills, tools, scopes },
                  operations,
                  checks,
                  diagnostics,
                };
                const memberPermuted =
                  permutationCount % 2 === 0
                    ? permuted
                    : (reverseObjectMembers(permuted) as UnknownRecord);
                expect(createOperationPlan(memberPermuted)).toEqual(baseline);
                permutationCount++;
              }
            }
          }
        }
      }
    }
    expect(permutationCount).toBe(192);

    const previewPlan = createOperationPlan({
      ...structuredClone(baseInput),
      operations: [betaInstall, alphaRepair, alphaInstall],
      checks: [betaCheck, alphaCheck],
      diagnostics: [betaDiagnostic, alphaDiagnostic],
      selection: {
        source: 'explicit-all',
        skills: ['beta', 'alpha'],
        tools: ['opencode', 'codex'],
        scopes: ['project', 'user'],
      },
    });
    const executionPlan = createOperationPlan(reverseObjectMembers(baseInput) as UnknownRecord);
    const previewOperations = asRecords(previewPlan.operations, 'preview operations');
    const executionOperations = asRecords(executionPlan.operations, 'execution operations');

    expect(previewPlan).toEqual(executionPlan);
    expect(previewOperations.map((operation) => operation.operationId)).toEqual([
      alphaInstallId,
      alphaRepairId,
      betaInstallId,
    ]);
    expect(asRecord(previewPlan.selection, 'canonical selection')).toMatchObject({
      source: 'explicit-all',
      skills: ['alpha', 'beta'],
      tools: ['codex', 'opencode'],
      scopes: ['user', 'project'],
    });
    expect(asRecords(previewPlan.checks, 'canonical checks').map((check) => check.checkId)).toEqual(
      [alphaCheckId, betaCheckId],
    );
    expect(
      asRecords(previewPlan.diagnostics, 'canonical diagnostics').map(
        (diagnostic) => diagnostic.diagnosticId,
      ),
    ).toEqual(['diagnostic:user:alpha:warning', 'diagnostic:project:beta:noop']);
    expect(
      asRecord(previewOperations[1]?.dependencyMetadata, 'repair dependency metadata'),
    ).toEqual({
      domain: 'skillsmith.operation-dependency',
      schemaVersion: 1,
      operationIds: [alphaInstallId],
    });
    expect(Object.isFrozen(previewOperations[1]?.dependencyMetadata)).toBeTrue();
    expect(
      Object.isFrozen(
        asRecord(previewOperations[1]?.dependencyMetadata, 'dependencies').operationIds,
      ),
    ).toBeTrue();

    const executionResults = executionOperations.map((operation) =>
      createOperationExecutionResult({
        operationId: String(operation.operationId),
        outcome: 'succeeded',
        actualBefore: structuredClone(operation.before),
        actualAfter: structuredClone(operation.after),
        force: null,
        error: null,
      }),
    );
    expect(executionIntent(executionPlan)).toEqual(executionIntent(previewPlan));
    expect(executionResults.map((result) => result.operationId)).toEqual(
      previewOperations.map((operation) => operation.operationId),
    );
    expect(previewPlan).not.toHaveProperty('results');
    expect(executionPlan).not.toHaveProperty('results');

    expect(() =>
      createOperationPlan({
        ...structuredClone(baseInput),
        operations: [structuredClone(alphaInstall), structuredClone(alphaInstall)],
        checks: [structuredClone(alphaCheck)],
        diagnostics: [],
      }),
    ).toThrow(/duplicate|collision|operation.?id/i);

    const danglingRepair = structuredClone(alphaRepair);
    asRecord(danglingRepair.dependencyMetadata, 'dangling dependency metadata').operationIds = [
      createOperationId(
        identityFor({
          groupId: 'group:user:missing',
          pairId: 'pair:user:missing:codex',
          kind: 'install',
          skill: 'missing',
          tool: 'codex',
          scope: 'user',
        }),
      ),
    ];
    expect(() =>
      createOperationPlan({
        ...structuredClone(baseInput),
        operations: [structuredClone(alphaInstall), danglingRepair],
        checks: [structuredClone(alphaCheck)],
        diagnostics: [],
      }),
    ).toThrow(/depend|dangling|missing|unknown/i);

    const cyclicInstall = structuredClone(alphaInstall);
    asRecord(cyclicInstall.dependencyMetadata, 'cyclic dependency metadata').operationIds = [
      alphaRepairId,
    ];
    expect(() =>
      createOperationPlan({
        ...structuredClone(baseInput),
        operations: [cyclicInstall, structuredClone(alphaRepair)],
        checks: [structuredClone(alphaCheck)],
        diagnostics: [],
      }),
    ).toThrow(/cycle|depend|earlier|forward/i);

    const duplicateDependencyRepair = structuredClone(alphaRepair);
    asRecord(
      duplicateDependencyRepair.dependencyMetadata,
      'duplicate dependency metadata',
    ).operationIds = [alphaInstallId, alphaInstallId];
    expect(() =>
      createOperationPlan({
        ...structuredClone(baseInput),
        operations: [structuredClone(alphaInstall), duplicateDependencyRepair],
        checks: [structuredClone(alphaCheck)],
        diagnostics: [],
      }),
    ).toThrow(/duplicate.*depend|depend.*duplicate/i);

    for (const invalidMetadata of [
      {
        domain: 'skillsmith.observation-dependency',
        schemaVersion: 1,
        operationIds: [alphaInstallId],
      },
      {
        domain: 'skillsmith.operation-dependency',
        schemaVersion: 2,
        operationIds: [alphaInstallId],
      },
    ]) {
      const invalidRepair = structuredClone(alphaRepair);
      invalidRepair.dependencyMetadata = invalidMetadata;
      expect(() =>
        createOperationPlan({
          ...structuredClone(baseInput),
          operations: [structuredClone(alphaInstall), invalidRepair],
          checks: [structuredClone(alphaCheck)],
          diagnostics: [],
        }),
      ).toThrow(/depend|domain|schema|version/i);
    }

    const mismatchedIdentity = identityFor({
      groupId: 'group:user:omega',
      pairId: 'pair:user:omega:codex',
      kind: 'remove',
      skill: 'omega',
      tool: 'codex',
      scope: 'user',
    });
    const mismatchedOperation = structuredClone(alphaInstall);
    mismatchedOperation.operationId = createOperationId(mismatchedIdentity);
    mismatchedOperation.requiredCheckIds = [];
    expect(() =>
      createOperationPlan({
        ...structuredClone(baseInput),
        operations: [mismatchedOperation],
        checks: [],
        diagnostics: [],
      }),
    ).toThrow(/identity|operation.?id|semantic|mismatch/i);
  });
});
