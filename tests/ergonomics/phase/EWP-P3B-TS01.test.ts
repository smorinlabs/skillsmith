import { describe, expect, test } from 'bun:test';
import type {
  FlipAction,
  InstallAction,
  UninstallAction,
} from '../../../packages/core/src/index.ts';
import * as publicCore from '../../../packages/core/src/index.ts';

type UnknownRecord = Record<string, unknown>;
type CreateOperationId = (input: Readonly<UnknownRecord>) => string;
type CreateStructuredPlanningId = (input: Readonly<UnknownRecord>) => string;
type CreateOperationPlan = (input: UnknownRecord) => UnknownRecord;
type CreateOperationExecutionResult = (input: UnknownRecord) => UnknownRecord;
type ComparePlanningDiagnostics = (left: UnknownRecord, right: UnknownRecord) => number;
type CompatibilityFamily = 'install' | 'uninstall' | 'flip';
type CurrentCompatibilityAction = InstallAction | UninstallAction | FlipAction;
type CompatibilityProjectionInput = Readonly<{
  family: CompatibilityFamily;
  operation: Readonly<UnknownRecord> | null;
  diagnostic: Readonly<UnknownRecord> | null;
  result: Readonly<UnknownRecord> | null;
}>;
type ToCurrentCompatibilityAction = (
  input: CompatibilityProjectionInput,
) => CurrentCompatibilityAction;

const core = publicCore as unknown as UnknownRecord;
const CONTENT_HASH = `sha256:${'a'.repeat(64)}`;
const OLD_CONTENT_HASH = `sha256:${'e'.repeat(64)}`;
const RESOLVED_SHA = 'b'.repeat(40);

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

const expectDeepFrozen = (value: unknown, seen = new Set<object>()): void => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBeTrue();
  for (const child of Object.values(value)) expectDeepFrozen(child, seen);
};

const liveResource = Object.freeze({
  kind: 'live',
  skill: 'alpha',
  tool: 'codex',
  scope: 'user',
  projectRoot: null,
  location: Object.freeze({ kind: 'portable', token: 'skills/user/alpha' }),
});
const portableSource = Object.freeze({
  kind: 'portable',
  identity: Object.freeze({
    host: 'example.test',
    repository: 'fixture/repo',
    path: 'skills/alpha',
  }),
  requestedRef: null,
  resolvedSha: RESOLVED_SHA,
  sourcePath: 'skills/alpha',
  contentHash: CONTENT_HASH,
});
const oldPortableSource = Object.freeze({
  ...portableSource,
  resolvedSha: 'f'.repeat(40),
  contentHash: OLD_CONTENT_HASH,
});
const localDevSource = Object.freeze({
  kind: 'local-dev',
  path: '/fixture/checkout/skills/alpha',
  contentHash: CONTENT_HASH,
});

const absentImage = Object.freeze({ kind: 'absent', resource: liveResource });
const placementImage = (
  classification: 'dev' | 'pinned' | 'unmanaged',
  source: Readonly<UnknownRecord> | null,
  overrides: UnknownRecord = {},
): Readonly<UnknownRecord> =>
  Object.freeze({
    kind: 'placement',
    resource: liveResource,
    classification,
    representation:
      classification === 'dev' ? 'symlink' : classification === 'pinned' ? 'copy' : 'other',
    linkTarget:
      classification === 'dev'
        ? Object.freeze({ kind: 'machine-bound', path: '/fixture/checkout/skills/alpha' })
        : null,
    dangling: false,
    source,
    contentHash: source === null ? null : CONTENT_HASH,
    ...overrides,
  });

const pinnedImage = placementImage('pinned', portableSource);
const oldPinnedImage = placementImage('pinned', oldPortableSource, {
  contentHash: OLD_CONTENT_HASH,
});
const repairedImage = placementImage('pinned', portableSource, {
  representation: 'symlink',
  linkTarget: Object.freeze({ kind: 'portable', token: `store/${CONTENT_HASH}` }),
});
const devImage = placementImage('dev', localDevSource);
const changedDevImage = placementImage(
  'dev',
  {
    ...localDevSource,
    path: '/fixture/checkout/skills/alpha-next',
  },
  {
    linkTarget: Object.freeze({
      kind: 'machine-bound',
      path: '/fixture/checkout/skills/alpha-next',
    }),
  },
);
const unmanagedImage = placementImage('unmanaged', null);

const operationInput = (
  operationId: string,
  groupId: string,
  pairId: string,
  kind: string,
  before: Readonly<UnknownRecord>,
  after: Readonly<UnknownRecord>,
  reasonCode: string,
  requiredCheckIds: readonly string[] = [],
): UnknownRecord => ({
  operationId,
  groupId,
  pairId,
  kind,
  dependencyMetadata: {
    domain: 'skillsmith.operation-dependency',
    schemaVersion: 1,
    operationIds: [],
  },
  skill: 'alpha',
  source:
    kind === 'link-dev' || kind === 'promote'
      ? structuredClone(localDevSource)
      : structuredClone(portableSource),
  tool: 'codex',
  scope: 'user',
  before: structuredClone(before),
  after: structuredClone(after),
  reason: { code: reasonCode, message: `Fixture reason for ${reasonCode}.` },
  selectionSource: 'explicit-targets',
  preconditionIds: ['precondition:user:alpha'],
  requiredCheckIds: [...requiredCheckIds],
  reversibility: { kind: 'none', retentionResourceIds: [] },
  mutates: { live: true, manifest: false, lock: false, ledger: true },
  conflict: null,
});

const operationGroupIdentityInput = (
  command: 'install' | 'uninstall' | 'dev' | 'promote',
  kind: string,
): UnknownRecord => ({
  domain: 'skillsmith.operation-group-identity',
  schemaVersion: 1,
  command,
  skill: 'alpha',
  source:
    kind === 'link-dev' || kind === 'promote'
      ? structuredClone(localDevSource)
      : structuredClone(portableSource),
  scope: 'user',
  target: null,
});

const operationPairIdentityInput = (groupId: string): UnknownRecord => ({
  domain: 'skillsmith.operation-pair-identity',
  schemaVersion: 1,
  groupId,
  tool: 'codex',
  resource: structuredClone(liveResource),
});

const operationIdentityInput = (kind: string, groupId: string, pairId: string): UnknownRecord => ({
  domain: 'skillsmith.operation-identity',
  schemaVersion: 1,
  groupId,
  pairId,
  kind,
  skill: 'alpha',
  source:
    kind === 'link-dev' || kind === 'promote'
      ? structuredClone(localDevSource)
      : structuredClone(portableSource),
  tool: 'codex',
  scope: 'user',
});

const planInput = (
  command: 'install' | 'uninstall' | 'dev' | 'promote',
  operations: readonly UnknownRecord[],
  checks: readonly UnknownRecord[] = [],
  diagnostics: readonly UnknownRecord[] = [],
): UnknownRecord => ({
  domain: 'skillsmith.operation-plan',
  schemaVersion: 1,
  command,
  selection: {
    source: 'explicit-targets',
    skills: ['alpha'],
    tools: ['codex'],
    scopes: ['user'],
  },
  batchPolicy: 'fail-fast',
  operations: [...operations],
  checks: [...checks],
  diagnostics: [...diagnostics],
});

describe('EWP-P3B-TS01', () => {
  test('separates immutable planning products and exhaustively projects all current compatibility actions', () => {
    const createOperationGroupId =
      requireFactory<CreateStructuredPlanningId>('createOperationGroupId');
    const createOperationId = requireFactory<CreateOperationId>('createOperationId');
    const createOperationPairId =
      requireFactory<CreateStructuredPlanningId>('createOperationPairId');
    const createOperationPlan = requireFactory<CreateOperationPlan>('createOperationPlan');
    const createOperationExecutionResult = requireFactory<CreateOperationExecutionResult>(
      'createOperationExecutionResult',
    );
    const toCurrentCompatibilityAction = requireFactory<ToCurrentCompatibilityAction>(
      'toCurrentCompatibilityAction',
    );
    const createPlanCheckId = requireFactory<CreateStructuredPlanningId>('createPlanCheckId');
    const createPlanningDiagnosticId = requireFactory<CreateStructuredPlanningId>(
      'createPlanningDiagnosticId',
    );
    const comparePlanningDiagnostics = requireFactory<ComparePlanningDiagnostics>(
      'comparePlanningDiagnostics',
    );

    const groupId = createOperationGroupId(operationGroupIdentityInput('install', 'install'));
    const pairId = createOperationPairId(operationPairIdentityInput(groupId));
    const operationId = createOperationId(operationIdentityInput('install', groupId, pairId));
    const checkId = createPlanCheckId({
      domain: 'skillsmith.plan-check-identity',
      schemaVersion: 1,
      kind: 'precondition-validation',
      operationIds: [operationId],
      preconditionIds: ['precondition:user:alpha'],
    });
    const diagnosticKinds = ['noop', 'skip', 'refuse', 'conflict', 'warning'] as const;
    const installOperationInput = operationInput(
      operationId,
      groupId,
      pairId,
      'install',
      absentImage,
      pinnedImage,
      'install-selected',
      [checkId],
    );
    const checkInput: UnknownRecord = {
      checkId,
      blocking: true,
      operationIds: [operationId],
      kind: 'precondition-validation',
      preconditionIds: ['precondition:user:alpha'],
    };
    const diagnosticInputs = diagnosticKinds.map((kind) => {
      const severity = kind === 'refuse' || kind === 'conflict' ? 'error' : 'info';
      const refusalClass = kind === 'refuse' ? 'state' : null;
      const affected = {
        skill: 'alpha',
        source: structuredClone(portableSource),
        tool: 'codex',
        scope: 'user',
        path: null,
      };
      const correlation = {
        groupId,
        pairId,
        operationId: kind === 'warning' ? operationId : null,
      };
      const reasonCode = `planned-${kind}`;
      return {
        diagnosticId: createPlanningDiagnosticId({
          domain: 'skillsmith.planning-diagnostic-identity',
          schemaVersion: 1,
          kind,
          severity,
          refusalClass,
          affected,
          correlation,
          reasonCode,
          selectionSource: 'explicit-targets',
        }),
        kind,
        severity,
        refusalClass,
        affected,
        correlation,
        reason: { code: reasonCode, message: `Planned ${kind} disposition.` },
        selectionSource: 'explicit-targets',
      };
    });
    diagnosticInputs.sort(comparePlanningDiagnostics);
    const input = planInput('install', [installOperationInput], [checkInput], diagnosticInputs);

    const plan = createOperationPlan(input);
    const operations = asRecords(plan.operations, 'operation plan operations');
    const checks = asRecords(plan.checks, 'operation plan checks');
    const diagnostics = asRecords(plan.diagnostics, 'operation plan diagnostics');

    expect(plan).toEqual(input);
    expect(plan).not.toHaveProperty('results');
    expect(asRecord(plan.selection, 'plan selection').source).toBe('explicit-targets');
    expect(operations.map((operation) => operation.kind)).toEqual(['install']);
    expect(checks.map((check) => check.kind)).toEqual(['precondition-validation']);
    expect(diagnostics.map((diagnostic) => diagnostic.kind)).toEqual(
      diagnosticInputs.map((diagnostic) => diagnostic.kind),
    );
    expect(operations[0]).not.toHaveProperty('outcome');
    expect(operations[0]).not.toHaveProperty('diagnosticId');
    expect(checks[0]).not.toHaveProperty('operationId');
    expect(checks[0]).not.toHaveProperty('outcome');
    expect(diagnostics[0]).not.toHaveProperty('actualBefore');
    expect(diagnostics[0]).not.toHaveProperty('outcome');

    const resultInputs: UnknownRecord[] = [
      {
        operationId,
        outcome: 'succeeded',
        actualBefore: structuredClone(absentImage),
        actualAfter: structuredClone(pinnedImage),
        force: null,
        error: null,
      },
      {
        operationId,
        outcome: 'failed',
        actualBefore: structuredClone(absentImage),
        actualAfter: structuredClone(absentImage),
        force: null,
        error: {
          code: 'write-failed',
          message: 'The local fixture write failed.',
          remediation: 'Inspect the fixture permissions and retry.',
        },
      },
      {
        operationId,
        outcome: 'cancelled',
        actualBefore: structuredClone(absentImage),
        actualAfter: structuredClone(absentImage),
        force: null,
        error: null,
      },
      {
        operationId,
        outcome: 'rolled-back',
        actualBefore: structuredClone(pinnedImage),
        actualAfter: structuredClone(absentImage),
        force: null,
        error: null,
      },
    ];
    const results = resultInputs.map(createOperationExecutionResult);

    expect(results.map((result) => result.outcome)).toEqual([
      'succeeded',
      'failed',
      'cancelled',
      'rolled-back',
    ]);
    for (const result of results) {
      expect(Object.keys(result).sort()).toEqual(
        ['operationId', 'outcome', 'actualBefore', 'actualAfter', 'force', 'error'].sort(),
      );
      expect(result).not.toHaveProperty('kind');
      expect(result).not.toHaveProperty('reason');
      expect(result).not.toHaveProperty('diagnosticId');
    }

    // Construction must copy caller-owned input before recursively freezing the public products.
    asRecords(asRecord(input.selection, 'input selection').skills, 'input skills').push({
      unexpected: true,
    });
    asRecord(
      asRecord(asRecords(input.operations, 'input operations')[0]?.reason, 'input reason'),
      'input reason',
    ).message = 'caller mutation';
    asRecord(resultInputs[1]?.error, 'input result error').remediation = 'caller mutation';
    expect(asRecords(asRecord(plan.selection, 'plan selection').skills, 'plan skills')).toEqual([
      'alpha',
    ]);
    expect(asRecord(operations[0]?.reason, 'plan reason').message).toBe(
      'Fixture reason for install-selected.',
    );
    expect(asRecord(results[1]?.error, 'result error').remediation).toBe(
      'Inspect the fixture permissions and retry.',
    );

    expectDeepFrozen(plan);
    for (const result of results) expectDeepFrozen(result);
    expect(() => {
      asRecord(operations[0]?.reason, 'frozen reason').message = 'mutation';
    }).toThrow(TypeError);
    expect(() => {
      asRecords(plan.operations, 'frozen operations').push({});
    }).toThrow(TypeError);
    expect(() => {
      asRecord(results[1]?.error, 'frozen result error').message = 'mutation';
    }).toThrow(TypeError);

    const constructOperation = (
      command: 'install' | 'uninstall' | 'dev' | 'promote',
      kind: string,
      before: Readonly<UnknownRecord>,
      after: Readonly<UnknownRecord>,
      reasonCode: string,
    ): UnknownRecord => {
      const groupId = createOperationGroupId(operationGroupIdentityInput(command, kind));
      const pairId = createOperationPairId(operationPairIdentityInput(groupId));
      const id = createOperationId(operationIdentityInput(kind, groupId, pairId));
      return asRecords(
        createOperationPlan(
          planInput(command, [
            operationInput(id, groupId, pairId, kind, before, after, reasonCode),
          ]),
        ).operations,
        `${reasonCode} operations`,
      )[0] as UnknownRecord;
    };
    const installOperation = operations[0] as UnknownRecord;
    const updateOperation = constructOperation(
      'install',
      'update',
      oldPinnedImage,
      pinnedImage,
      'update-selected',
    );
    const repairOperation = constructOperation(
      'install',
      'repair',
      repairedImage,
      pinnedImage,
      'repair-selected',
    );
    const removeOperation = constructOperation(
      'uninstall',
      'remove',
      pinnedImage,
      absentImage,
      'remove-selected',
    );
    const promoteOperation = constructOperation(
      'promote',
      'promote',
      devImage,
      pinnedImage,
      'promote-selected',
    );
    const updateDevOperation = constructOperation(
      'dev',
      'link-dev',
      devImage,
      changedDevImage,
      'dev-updated',
    );
    const createDevOperation = constructOperation(
      'dev',
      'link-dev',
      absentImage,
      devImage,
      'dev-created',
    );
    const adoptDevOperation = constructOperation(
      'dev',
      'link-dev',
      unmanagedImage,
      devImage,
      'dev-adopted',
    );

    const resultFor = (
      operation: UnknownRecord,
      outcome: 'succeeded' | 'failed' | 'rolled-back',
    ): UnknownRecord =>
      createOperationExecutionResult({
        operationId: String(operation.operationId),
        outcome,
        actualBefore: structuredClone(operation.before),
        actualAfter:
          outcome === 'failed' || outcome === 'rolled-back'
            ? structuredClone(operation.before)
            : structuredClone(operation.after),
        force: null,
        error:
          outcome === 'failed'
            ? {
                code: 'fixture-failed',
                message: 'The hermetic fixture operation failed.',
                remediation: 'Correct the fixture state and retry.',
              }
            : null,
      });
    const diagnosticByKind = new Map(diagnostics.map((item) => [String(item.kind), item]));
    const requireDiagnostic = (
      kind: 'noop' | 'skip' | 'refuse' | 'conflict' | 'warning',
    ): UnknownRecord => {
      const value = diagnosticByKind.get(kind);
      expect(value, `${kind} diagnostic`).toBeDefined();
      return value as UnknownRecord;
    };

    const compatibilityMatrix = [
      {
        family: 'install',
        expected: 'installed',
        operation: installOperation,
        diagnostic: requireDiagnostic('warning'),
        outcome: 'succeeded',
      },
      { family: 'install', expected: 'updated', operation: updateOperation, outcome: 'succeeded' },
      { family: 'install', expected: 'repaired', operation: repairOperation, outcome: 'succeeded' },
      { family: 'install', expected: 'noop', diagnostic: requireDiagnostic('noop') },
      { family: 'install', expected: 'skipped', diagnostic: requireDiagnostic('skip') },
      { family: 'install', expected: 'refused', diagnostic: requireDiagnostic('refuse') },
      { family: 'install', expected: 'failed', operation: installOperation, outcome: 'failed' },
      {
        family: 'uninstall',
        expected: 'removed',
        operation: removeOperation,
        outcome: 'succeeded',
      },
      { family: 'uninstall', expected: 'noop', diagnostic: requireDiagnostic('noop') },
      { family: 'uninstall', expected: 'refused', diagnostic: requireDiagnostic('conflict') },
      { family: 'uninstall', expected: 'failed', operation: removeOperation, outcome: 'failed' },
      { family: 'flip', expected: 'flipped', operation: promoteOperation, outcome: 'succeeded' },
      { family: 'flip', expected: 'updated', operation: updateDevOperation, outcome: 'succeeded' },
      { family: 'flip', expected: 'noop', diagnostic: requireDiagnostic('noop') },
      { family: 'flip', expected: 'skipped', diagnostic: requireDiagnostic('skip') },
      { family: 'flip', expected: 'refused', diagnostic: requireDiagnostic('refuse') },
      { family: 'flip', expected: 'failed', operation: promoteOperation, outcome: 'failed' },
      {
        family: 'flip',
        expected: 'rolled-back',
        operation: promoteOperation,
        outcome: 'rolled-back',
      },
      { family: 'flip', expected: 'created', operation: createDevOperation, outcome: 'succeeded' },
      { family: 'flip', expected: 'adopted', operation: adoptDevOperation, outcome: 'succeeded' },
    ] as const satisfies readonly Readonly<{
      family: CompatibilityFamily;
      expected: CurrentCompatibilityAction;
      operation?: UnknownRecord;
      diagnostic?: UnknownRecord;
      outcome?: 'succeeded' | 'failed' | 'rolled-back';
    }>[];

    expect(compatibilityMatrix).toHaveLength(20);
    expect(
      compatibilityMatrix.filter((row) => row.family === 'install').map((row) => row.expected),
    ).toEqual<InstallAction[]>([
      'installed',
      'updated',
      'repaired',
      'noop',
      'skipped',
      'refused',
      'failed',
    ]);
    expect(
      compatibilityMatrix.filter((row) => row.family === 'uninstall').map((row) => row.expected),
    ).toEqual<UninstallAction[]>(['removed', 'noop', 'refused', 'failed']);
    expect(
      compatibilityMatrix.filter((row) => row.family === 'flip').map((row) => row.expected),
    ).toEqual<FlipAction[]>([
      'flipped',
      'updated',
      'noop',
      'skipped',
      'refused',
      'failed',
      'rolled-back',
      'created',
      'adopted',
    ]);

    for (const row of compatibilityMatrix) {
      const operation = row.operation ?? null;
      const diagnostic = row.diagnostic ?? null;
      const result =
        operation !== null && row.outcome !== undefined ? resultFor(operation, row.outcome) : null;
      if (row.expected === 'rolled-back') {
        expect(result?.actualAfter).toEqual(operation?.before);
      }
      expect(
        toCurrentCompatibilityAction(
          Object.freeze({ family: row.family, operation, diagnostic, result }),
        ),
        `${row.family}:${row.expected}`,
      ).toBe(row.expected);
    }
  });
});
