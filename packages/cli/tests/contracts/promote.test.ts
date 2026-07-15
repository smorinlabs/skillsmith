import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { lstat, mkdir, readdir, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createLifecycleApplicationServices } from '../../../core/src/application/lifecycle-services.ts';
import type {
  CurrentApplicationContext,
  InteractionPort,
} from '../../../core/src/application/types.ts';
import { resolveRuntimeConfiguration } from '../../../core/src/config/runtime.ts';
import {
  createObservationEmitter,
  createOperationContext,
  noopObserver,
} from '../../../core/src/observation/index.ts';
import { getPair, readLedger } from '../../../core/src/place/ledger.ts';
import { ledgerPathOf, storeRootOf } from '../../../core/src/place/paths.ts';
import { preparePromote, runPromote, runRollback } from '../../../core/src/place/run.ts';
import type { FlipOptions, FlipReport } from '../../../core/src/place/types.ts';
import type { RuntimePorts } from '../../../core/src/ports/types.ts';
import type { Result } from '../../../core/src/result.ts';
import { cannedFlipDeps, passFlipDeps } from '../../../core/tests/fixtures/place/dev-source.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../../../core/tests/fixtures/place/fleet.ts';
import { SimulatedCrash } from '../../../core/tests/place/crash-env.ts';
import { currentWireContractRegistry } from '../../src/contracts/wire-contracts.ts';
import { renderFlipJson } from '../../src/output/flip-json.ts';

setDefaultTimeout(30_000);

type UnknownRecord = Record<string, unknown>;
type ScopedFlipOptions = FlipOptions & {
  readonly scope?: 'user' | 'project';
  readonly selectionSource?: 'explicit-targets' | 'explicit-all';
};
type CompatibilityActionMapper = (input: {
  readonly family: 'flip';
  readonly operation: UnknownRecord | null;
  readonly diagnostic: UnknownRecord | null;
  readonly result: UnknownRecord | null;
}) => string;

const FLIP_V3_TOP_LEVEL_KEYS = [
  'schemaVersion',
  'kind',
  'op',
  'dryRun',
  'summary',
  'selection',
  'operations',
  'checks',
  'diagnostics',
  'results',
] as const;

const FLIP_V3_SELECTION_KEYS = [
  'source',
  'outcome',
  'targets',
  'all',
  'tools',
  'scopes',
  'groupIds',
  'batchPolicy',
] as const;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const records = (value: unknown): readonly UnknownRecord[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const errorText = (error: unknown): string => {
  if (!isRecord(error)) return String(error);
  return typeof error.message === 'string'
    ? error.message
    : typeof error.code === 'string'
      ? error.code
      : String(error);
};

const unwrapReport = (result: Result<FlipReport, unknown>, label: string): FlipReport => {
  expect(result.ok, result.ok ? undefined : `${label}: ${errorText(result.error)}`).toBeTrue();
  if (!result.ok) throw new Error(`${label}: ${errorText(result.error)}`);
  return result.value;
};

const requirePlan = (report: FlipReport, label: string): UnknownRecord => {
  const plan = (report as unknown as UnknownRecord).plan;
  expect(isRecord(plan), `${label} must expose the G3B-01 operation plan`).toBeTrue();
  if (!isRecord(plan)) throw new Error(`${label} operation plan is unavailable`);
  expect(plan).toMatchObject({
    domain: 'skillsmith.operation-plan',
    schemaVersion: 1,
    command: 'promote',
  });
  for (const field of ['operations', 'checks', 'diagnostics']) {
    expect(Array.isArray(plan[field]), `${label} plan.${field}`).toBeTrue();
  }
  expect(Object.isFrozen(plan)).toBeTrue();
  return plan;
};

const executionResults = (report: FlipReport, label: string): readonly UnknownRecord[] => {
  const value = (report as unknown as UnknownRecord).executionResults;
  expect(Array.isArray(value), `${label} must expose separate execution results`).toBeTrue();
  return records(value);
};

const operationIds = (plan: UnknownRecord): readonly unknown[] =>
  records(plan.operations).map((operation) => operation.operationId);

const wireSelectionForPlan = (plan: UnknownRecord, label: string): UnknownRecord => {
  expect(isRecord(plan.selection), `${label} plan.selection`).toBeTrue();
  if (!isRecord(plan.selection)) throw new Error(`${label} selection is unavailable`);
  return {
    source: plan.selection.source,
    outcome: plan.selection.outcome,
    targets: plan.selection.targets,
    all: plan.selection.all,
    tools: plan.selection.tools,
    scopes: plan.selection.scopes,
    groupIds: plan.selection.groupIds,
    batchPolicy: plan.batchPolicy,
  };
};

const executionIds = (report: FlipReport, label: string): readonly unknown[] =>
  executionResults(report, label).map((result) => result.operationId);

const baseOptions = (
  fleet: FixtureFleet,
  overrides: Partial<ScopedFlipOptions> = {},
): ScopedFlipOptions => ({
  targets: [],
  cwd: fleet.home,
  configuration: fleet.configuration,
  ...overrides,
});

const renderV3 = (report: FlipReport): UnknownRecord =>
  JSON.parse(renderFlipJson(report)) as UnknownRecord;

const requireCompatibilityMapper = async (): Promise<CompatibilityActionMapper> => {
  const core = (await import('../../../core/src/index.ts')) as Record<string, unknown>;
  const mapper = Reflect.get(core, 'toCurrentCompatibilityAction');
  expect(
    typeof mapper,
    'G3B-01 must export toCurrentCompatibilityAction through the public core boundary',
  ).toBe('function');
  if (typeof mapper !== 'function') throw new Error('compatibility action mapper is unavailable');
  return mapper as CompatibilityActionMapper;
};

const treeOrEmpty = async (root: string): Promise<readonly string[]> => {
  try {
    return (await readdir(root, { recursive: true, encoding: 'utf8' })).sort();
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return [];
    throw error;
  }
};

const residueNames = async (root: string): Promise<readonly string[]> =>
  (await treeOrEmpty(root)).filter(
    (name) => name.includes('.skillsmith-staging-') || name.includes('.skillsmith-backup-'),
  );

const MUTATION_PORTS = new Set<PropertyKey>([
  'makeDir',
  'writeTextFile',
  'makeSymlink',
  'rename',
  'copyTree',
  'removeTree',
  'fsyncFile',
  'fsyncDir',
  'withFileLock',
]);

const trackedMutationPorts = (ports: RuntimePorts, events: string[]): RuntimePorts =>
  new Proxy(ports, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function' || !MUTATION_PORTS.has(property)) return value;
      return (...args: unknown[]) => {
        events.push(`write:${String(property)}`);
        return Reflect.apply(value, target, args);
      };
    },
  }) as RuntimePorts;

const observation = Object.freeze({
  context: createOperationContext({
    command: 'skillsmith promote',
    workflow: 'contract-test',
    clock: {
      wallNowIso: () => '2026-07-15T00:00:00.000Z',
      monotonicMilliseconds: () => 0,
    },
    id: { nextId: () => 'promote-contract-test' },
  }),
  emitter: createObservationEmitter({ observer: noopObserver }),
});

const applicationContext = (
  fleet: FixtureFleet,
  interaction: InteractionPort,
  overrides: Partial<CurrentApplicationContext> = {},
): CurrentApplicationContext => ({
  observation,
  ports: fleet.env,
  configuration: resolveRuntimeConfiguration({ HOME: fleet.home, SKILLSMITH_HOME: fleet.data }),
  interaction,
  invocationCwd: fleet.project,
  globalOptions: {},
  projectContext: {
    invocationCwd: fleet.project,
    effectiveCwd: fleet.project,
    projectRoot: fleet.projectReal,
    projectIdentity: fleet.projectReal,
    projectKind: 'git',
    discoveredConfigPath: null,
    explicitConfigPath: null,
  },
  ...overrides,
});

describe('EWP-CMD-PROMOTE-TS01', () => {
  test('scoped dev placement promotes once and converges to a non-executable noop', async () => {
    const fleet = await buildFixtureFleet();
    try {
      const first = unwrapReport(
        await runPromote(
          fleet.env,
          baseOptions(fleet, {
            targets: ['alpha'],
            tools: ['claude-code'],
            scope: 'user',
            selectionSource: 'explicit-targets',
          }),
          passFlipDeps(),
        ),
        'initial scoped promote',
      );
      expect(first.results[0]).toMatchObject({
        skill: 'alpha',
        tool: 'claude-code',
        action: 'flipped',
      });
      const firstPlan = requirePlan(first, 'initial scoped promote');
      expect(firstPlan.selection).toMatchObject({
        source: 'explicit-targets',
        scopes: ['user'],
      });
      expect(records(firstPlan.operations)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'promote',
            skill: 'alpha',
            tool: 'claude-code',
            scope: 'user',
          }),
        ]),
      );
      expect(executionIds(first, 'initial scoped promote')).toEqual(operationIds(firstPlan));

      const converged = unwrapReport(
        await runPromote(
          fleet.env,
          baseOptions(fleet, {
            targets: ['alpha'],
            tools: ['claude-code'],
            scope: 'user',
            selectionSource: 'explicit-targets',
          }),
          passFlipDeps(),
        ),
        'converged promote',
      );
      expect(converged.results[0]?.action).toBe('noop');
      const convergedPlan = requirePlan(converged, 'converged promote');
      expect(records(convergedPlan.operations)).toEqual([]);
      expect(records(convergedPlan.diagnostics)).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'noop' })]),
      );

      const unmanaged = unwrapReport(
        await runPromote(
          fleet.env,
          baseOptions(fleet, {
            targets: ['copied'],
            tools: ['claude-code'],
            scope: 'user',
            dryRun: true,
            selectionSource: 'explicit-targets',
          }),
          passFlipDeps(),
        ),
        'unmanaged pinned placement',
      );
      expect(unmanaged.results[0]?.action).toBe('noop');
      expect(records(requirePlan(unmanaged, 'unmanaged pinned placement').operations)).toEqual([]);
    } finally {
      await destroyFixtureFleet(fleet);
    }
  });
});

describe('EWP-CMD-PROMOTE-TS02', () => {
  test('clean, dirty, allowed-dirty, and non-Git provenance drive real plans and compatibility', async () => {
    const fleet = await buildFixtureFleet();
    try {
      const clean = unwrapReport(
        await runPromote(
          fleet.env,
          baseOptions(fleet, { targets: ['alpha'], tools: ['claude-code'], dryRun: true }),
          passFlipDeps(),
        ),
        'clean preview',
      );
      const cleanPlan = requirePlan(clean, 'clean preview');
      expect(records(cleanPlan.operations)).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'promote', skill: 'alpha' })]),
      );

      await fleet.makeCheckoutDirty();
      const refused = unwrapReport(
        await runPromote(
          fleet.env,
          baseOptions(fleet, { targets: ['alpha'], tools: ['claude-code'], dryRun: true }),
          passFlipDeps(),
        ),
        'dirty refused preview',
      );
      expect(refused.results[0]?.action).toBe('refused');
      const refusedPlan = requirePlan(refused, 'dirty refused preview');
      expect(records(refusedPlan.operations)).toEqual([]);
      const dirtyDiagnostic = records(refusedPlan.diagnostics).find(
        (diagnostic) => diagnostic.kind === 'refuse',
      );
      expect(dirtyDiagnostic).toBeDefined();
      if (!dirtyDiagnostic) throw new Error('dirty refusal diagnostic is unavailable');
      const compatibilityAction = (await requireCompatibilityMapper())({
        family: 'flip',
        operation: null,
        diagnostic: dirtyDiagnostic,
        result: null,
      });
      const refusedAction = refused.results[0]?.action;
      expect(refusedAction).toBeDefined();
      if (refusedAction === undefined) throw new Error('dirty compatibility action is unavailable');
      expect(compatibilityAction).toBe(refusedAction);

      const allowed = unwrapReport(
        await runPromote(
          fleet.env,
          baseOptions(fleet, {
            targets: ['alpha'],
            tools: ['claude-code'],
            allowDirty: true,
          }),
          passFlipDeps(),
        ),
        'allowed dirty promote',
      );
      expect(allowed.results[0]?.store).toMatchObject({ dirty: true });
      expect(allowed.results[0]?.store?.rev).toMatch(/^dirty-[0-9a-f]{12}$/);
      const allowedPlan = requirePlan(allowed, 'allowed dirty promote');
      expect(executionIds(allowed, 'allowed dirty promote')).toEqual(operationIds(allowedPlan));

      const nonGit = unwrapReport(
        await runPromote(
          fleet.env,
          baseOptions(fleet, { targets: ['gamma'], tools: ['codex'] }),
          passFlipDeps(),
        ),
        'non-Git promote',
      );
      expect(nonGit.results[0]?.store?.rev).toMatch(/^content-[0-9a-f]{12}$/);
      expect(nonGit.results[0]?.store?.gitSha).toBeNull();
      const nonGitPlan = requirePlan(nonGit, 'non-Git promote');
      expect(executionIds(nonGit, 'non-Git promote')).toEqual(operationIds(nonGitPlan));
    } finally {
      await destroyFixtureFleet(fleet);
    }
  });
});

describe('EWP-CMD-PROMOTE-TS03', () => {
  test('per-tool verification, strict inconclusive, and no-verify stay separate plan checks/results', async () => {
    const fleet = await buildFixtureFleet();
    try {
      const claudeCalls: unknown[] = [];
      const claude = unwrapReport(
        await runPromote(
          fleet.env,
          baseOptions(fleet, { targets: ['alpha'], tools: ['claude-code'] }),
          cannedFlipDeps('warn', claudeCalls as never[]),
        ),
        'claude warning promote',
      );
      expect(claude.results[0]?.verify?.gate).toBe('warned');
      expect(claudeCalls).toHaveLength(1);
      const claudeChecks = records(requirePlan(claude, 'claude warning promote').checks).filter(
        (check) => check.kind === 'verification',
      );
      expect(claudeChecks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ tool: 'claude-code', mode: 'static', blocking: true }),
        ]),
      );

      const codexCalls: unknown[] = [];
      const codexStrict = unwrapReport(
        await runPromote(
          fleet.env,
          baseOptions(fleet, { targets: ['beta'], tools: ['codex'], strict: true }),
          cannedFlipDeps('inconclusive', codexCalls as never[]),
        ),
        'codex strict inconclusive promote',
      );
      expect(codexStrict.results[0]?.action).toBe('failed');
      expect(codexCalls).toHaveLength(1);
      const codexPlan = requirePlan(codexStrict, 'codex strict inconclusive promote');
      expect(records(codexPlan.checks).filter((check) => check.kind === 'verification')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ tool: 'codex', mode: 'static+deep', blocking: true }),
        ]),
      );
      expect(executionResults(codexStrict, 'codex strict inconclusive promote')).toEqual(
        expect.arrayContaining([expect.objectContaining({ outcome: 'failed' })]),
      );

      const skippedCalls: unknown[] = [];
      const skipped = unwrapReport(
        await runPromote(
          fleet.env,
          baseOptions(fleet, { targets: ['gamma'], tools: ['codex'], noVerify: true }),
          cannedFlipDeps('fail', skippedCalls as never[]),
        ),
        'no-verify promote',
      );
      expect(skipped.results[0]?.verify?.gate).toBe('skipped');
      expect(skippedCalls).toHaveLength(0);
      expect(
        records(requirePlan(skipped, 'no-verify promote').checks).filter(
          (check) => check.kind === 'verification',
        ),
      ).toEqual([]);
    } finally {
      await destroyFixtureFleet(fleet);
    }
  });
});

describe('EWP-CMD-PROMOTE-TS04', () => {
  test('the canonical scoped bulk plan exists before one approval and is identical at execution', async () => {
    const fleet = await buildFixtureFleet();
    try {
      await rm(join(fleet.home, '.claude', 'skills', 'dangler'));
      const projectRoot = join(fleet.project, '.claude', 'skills');
      await mkdir(projectRoot, { recursive: true });
      await symlink(resolve(fleet.betaSrc), join(projectRoot, 'project-beta'));
      const latePath = join(projectRoot, 'late-project');

      let plannedReport: FlipReport | undefined;
      let plannedPlan: UnknownRecord | undefined;
      const events: string[] = [];
      let prepareCalls = 0;
      const interaction: InteractionPort = {
        mode: 'interactive',
        choose: async <TValue>(request: {
          readonly choices: readonly { readonly value: TValue }[];
        }) => ({ status: 'resolved', value: request.choices[0]?.value as TValue }),
        confirm: async () => {
          expect(plannedReport, 'approval must observe the runner preview report').toBeDefined();
          expect(plannedPlan, 'approval must observe the immutable operation plan').toBeDefined();
          if (plannedPlan === undefined) throw new Error('approval plan is unavailable');
          expect(Object.isFrozen(plannedPlan)).toBeTrue();
          expect(records(plannedPlan.operations)).toHaveLength(2);
          await symlink(resolve(fleet.betaSrc), latePath);
          events.push('confirm');
          return { status: 'resolved', value: true };
        },
      };
      const services = createLifecycleApplicationServices({
        preparePromote: (async (env, options, deps) => {
          prepareCalls += 1;
          expect(prepareCalls, 'bulk approval must prepare exactly once').toBe(1);
          expect(options.cwd).toBe(fleet.project);
          expect(options.projectRoot).toBe(fleet.projectReal);
          const prepared =
            deps === undefined
              ? await preparePromote(env, options)
              : await preparePromote(env, options, deps);
          if (!prepared.ok) return prepared;
          plannedReport = prepared.value.preview;
          plannedPlan = requirePlan(plannedReport, 'service bulk approval preview');
          expect(plannedPlan.selection).toMatchObject({
            source: 'explicit-all',
            scopes: ['user', 'project'],
          });
          expect(plannedPlan.batchPolicy).toBe('fail-fast');
          expect(
            records(plannedPlan.operations).map((operation) => [
              operation.scope,
              operation.skill,
              operation.tool,
            ]),
          ).toEqual([
            ['user', 'alpha', 'claude-code'],
            ['project', 'project-beta', 'claude-code'],
          ]);
          expect(executionResults(plannedReport, 'service bulk approval preview')).toEqual([]);
          events.push('plan');
          return {
            ok: true,
            value: {
              preview: prepared.value.preview,
              plan: prepared.value.plan,
              execute: async () => {
                expect(events).toEqual(['plan', 'confirm']);
                events.push('execute');
                const result = await prepared.value.execute();
                if (result.ok && plannedPlan !== undefined) {
                  expect(requirePlan(result.value, 'service bulk execution')).toEqual(plannedPlan);
                }
                return result;
              },
            },
          };
        }) as typeof preparePromote,
      });
      const outcome = await services.promote(
        {
          arguments: [[]],
          options: { all: true, tool: ['claude-code'], yes: true, verify: false },
        },
        applicationContext(fleet, interaction),
      );

      expect(events).toEqual(['plan', 'confirm', 'execute']);
      expect(prepareCalls).toBe(1);
      expect(plannedReport).toBeDefined();
      expect(plannedPlan).toBeDefined();
      expect(outcome.report.value).not.toBeNull();
      if (outcome.report.value === null)
        throw new Error('approved execution report is unavailable');
      const executionPlan = requirePlan(outcome.report.value, 'approved bulk execution');
      if (plannedPlan === undefined) throw new Error('approved preview plan was not captured');
      expect(executionPlan).toEqual(plannedPlan);
      expect(executionIds(outcome.report.value, 'approved bulk execution')).toEqual(
        operationIds(executionPlan),
      );
      expect(
        records(executionPlan.operations).some((operation) => operation.skill === 'late-project'),
      ).toBeFalse();
      expect((await lstat(latePath)).isSymbolicLink()).toBeTrue();
    } finally {
      await destroyFixtureFleet(fleet);
    }
  });

  test('a missing member fails an explicit multi-target invocation before approval or writes', async () => {
    const fleet = await buildFixtureFleet();
    try {
      const events: string[] = [];
      let confirmations = 0;
      const interaction: InteractionPort = {
        mode: 'interactive',
        choose: async <TValue>(request: {
          readonly choices: readonly { readonly value: TValue }[];
        }) => ({ status: 'resolved', value: request.choices[0]?.value as TValue }),
        confirm: async () => {
          confirmations += 1;
          return { status: 'resolved', value: true };
        },
      };
      const outcome = await createLifecycleApplicationServices().promote(
        {
          arguments: [['alpha', 'missing-explicit-target']],
          options: { tool: ['claude-code'], yes: true, verify: false },
        },
        applicationContext(fleet, interaction, {
          ports: trackedMutationPorts(fleet.env, events),
        }),
      );

      expect(outcome.exitClass).toBe('usage');
      expect(outcome.report.value).toBeNull();
      expect(outcome.diagnostics.map((diagnostic) => diagnostic.message).join('\n')).toContain(
        'missing-explicit-target',
      );
      expect(confirmations).toBe(0);
      expect(events.filter((event) => event.startsWith('write:'))).toEqual([]);
    } finally {
      await destroyFixtureFleet(fleet);
    }
  });
});

describe('EWP-CMD-PROMOTE-TS05', () => {
  test('actual preview/JSON/execution/rollback share deterministic inverse identities and conflicts are pre-I/O', async () => {
    let contextCalls = 0;
    let domainCalls = 0;
    const conflictServices = createLifecycleApplicationServices({
      resolveContext: (async () => {
        contextCalls++;
        throw new Error('option conflict reached project discovery');
      }) as never,
      preparePromote: (async () => {
        domainCalls++;
        throw new Error('option conflict reached promote runner');
      }) as never,
    });
    const fleet = await buildFixtureFleet();
    try {
      const interaction: InteractionPort = {
        mode: 'noninteractive',
        choose: async () => ({ status: 'refused', reason: 'noninteractive' }),
        confirm: async () => ({ status: 'refused', reason: 'noninteractive' }),
      };
      const context = applicationContext(fleet, interaction);
      const { projectContext: _projectContext, ...unresolvedContext } = context;
      const conflict = await conflictServices.promote(
        {
          arguments: [['alpha']],
          options: { dryRun: true, yes: true, verify: true },
        },
        unresolvedContext,
      );
      expect(conflict.exitClass).toBe('usage');
      expect(contextCalls).toBe(0);
      expect(domainCalls).toBe(0);

      const options = baseOptions(fleet, {
        targets: ['alpha'],
        tools: ['claude-code'],
        noVerify: true,
        selectionSource: 'explicit-targets',
      });
      const preview = unwrapReport(
        await runPromote(fleet.env, { ...options, dryRun: true }, passFlipDeps()),
        'promote preview',
      );
      const previewPlan = requirePlan(preview, 'promote preview');
      expect(executionResults(preview, 'promote preview')).toEqual([]);

      const previewWire = renderV3(preview);
      expect(previewWire).toMatchObject({
        schemaVersion: 3,
        kind: 'skillsmith.flip',
        op: 'promote',
        dryRun: true,
        summary: preview.summary,
        operations: previewPlan.operations,
        checks: previewPlan.checks,
        diagnostics: previewPlan.diagnostics,
        results: [],
      });
      expect(Object.keys(previewWire).sort()).toEqual([...FLIP_V3_TOP_LEVEL_KEYS].sort());
      expect(previewWire.selection).toEqual(wireSelectionForPlan(previewPlan, 'promote preview'));
      expect(previewWire.plan).toBeUndefined();
      expect(previewWire.executionResults).toBeUndefined();

      const execution = unwrapReport(
        await runPromote(fleet.env, options, passFlipDeps()),
        'promote execution',
      );
      const executionPlan = requirePlan(execution, 'promote execution');
      expect(executionPlan).toEqual(previewPlan);
      const runtimeExecutionResults = executionResults(execution, 'promote execution');
      expect(runtimeExecutionResults.map((result) => result.operationId)).toEqual([
        ...operationIds(executionPlan),
      ]);

      const executionWire = renderV3(execution);
      expect(executionWire).toMatchObject({
        schemaVersion: 3,
        kind: 'skillsmith.flip',
        op: 'promote',
        dryRun: false,
        summary: execution.summary,
        operations: executionPlan.operations,
        checks: executionPlan.checks,
        diagnostics: executionPlan.diagnostics,
        results: runtimeExecutionResults,
      });
      expect(Object.keys(executionWire).sort()).toEqual([...FLIP_V3_TOP_LEVEL_KEYS].sort());
      expect(executionWire.selection).toEqual(
        wireSelectionForPlan(executionPlan, 'promote execution'),
      );
      expect(isRecord(executionWire.selection)).toBeTrue();
      if (!isRecord(executionWire.selection)) throw new Error('flip@3 promote selection is absent');
      expect(Object.keys(executionWire.selection).sort()).toEqual(
        [...FLIP_V3_SELECTION_KEYS].sort(),
      );
      expect(executionWire.plan).toBeUndefined();
      expect(executionWire.executionResults).toBeUndefined();
      const wireExecutionResults = records(executionWire.results);
      expect(wireExecutionResults).toHaveLength(records(executionPlan.operations).length);
      expect(wireExecutionResults.map((result) => result.operationId)).toEqual([
        ...operationIds(executionPlan),
      ]);
      for (const result of wireExecutionResults) {
        expect(result).toMatchObject({
          operationId: expect.any(String),
          outcome: 'succeeded',
          error: null,
        });
        expect(result).toHaveProperty('actualBefore');
        expect(result).toHaveProperty('actualAfter');
        expect(result).toHaveProperty('force');
        for (const legacyField of ['skill', 'tool', 'action', 'placementPath', 'store', 'verify']) {
          expect(result).not.toHaveProperty(legacyField);
        }
      }

      const rollbackOptions = { ...options, rollback: true, op: 'promote' as const, dryRun: true };
      const rollback = unwrapReport(
        await runRollback(fleet.env, rollbackOptions, passFlipDeps()),
        'rollback preview',
      );
      const rollbackAgain = unwrapReport(
        await runRollback(fleet.env, rollbackOptions, passFlipDeps()),
        'repeated rollback preview',
      );
      const rollbackPlan = requirePlan(rollback, 'rollback preview');
      const rollbackPlanAgain = requirePlan(rollbackAgain, 'repeated rollback preview');
      expect(operationIds(rollbackPlanAgain)).toEqual(operationIds(rollbackPlan));
      expect(records(rollbackPlan.operations)).toHaveLength(
        records(executionPlan.operations).length,
      );
      for (const [index, forward] of records(executionPlan.operations).entries()) {
        const inverse = records(rollbackPlan.operations)[index];
        expect(inverse).toMatchObject({ kind: 'link-dev' });
        expect(inverse?.before).toEqual(forward.after);
        expect(inverse?.after).toEqual(forward.before);
      }
      expect(executionResults(rollback, 'rollback preview')).toEqual([]);
      const rollbackWire = renderV3(rollback);
      expect(records(rollbackWire.operations).map((operation) => operation.operationId)).toEqual([
        ...operationIds(rollbackPlan),
      ]);
      expect(rollbackWire.results).toEqual([]);
      expect(rollbackWire.plan).toBeUndefined();
      expect(rollbackWire.executionResults).toBeUndefined();
      expect(
        currentWireContractRegistry.forCommand('skillsmith promote')?.descriptor,
      ).toMatchObject({ id: 'flip', version: 3 });
    } finally {
      await destroyFixtureFleet(fleet);
    }
  });
});

describe('EWP-CMD-PROMOTE-TS06', () => {
  test('real hash/store reuse and interrupted-journal recovery correlate without residue', async () => {
    const fleet = await buildFixtureFleet();
    try {
      const options = baseOptions(fleet, {
        targets: ['alpha'],
        tools: ['claude-code'],
        noVerify: true,
        selectionSource: 'explicit-targets',
      });
      const first = unwrapReport(
        await runPromote(fleet.env, options, passFlipDeps()),
        'initial content snapshot',
      );
      const firstPlan = requirePlan(first, 'initial content snapshot');
      const firstOperation = records(firstPlan.operations)[0];
      expect(firstOperation).toBeDefined();
      expect(first.results[0]?.store).toMatchObject({ reused: false });
      const ledgerAfterFirst = await readLedger(fleet.env, ledgerPathOf(fleet.data));
      expect(ledgerAfterFirst.ok).toBeTrue();
      if (!ledgerAfterFirst.ok) throw new Error(errorText(ledgerAfterFirst.error));
      const firstPair = getPair(ledgerAfterFirst.value, 'alpha', 'claude-code');
      expect(firstPair?.pinned?.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(firstOperation?.after).toMatchObject({
        contentHash: firstPair?.pinned?.contentHash,
      });

      const rolledBack = unwrapReport(
        await runRollback(fleet.env, { ...options, rollback: true, op: 'promote' }, passFlipDeps()),
        'restore dev source',
      );
      expect(rolledBack.results[0]?.action).toBe('rolled-back');
      const reused = unwrapReport(
        await runPromote(fleet.env, options, passFlipDeps()),
        'reused content snapshot',
      );
      expect(reused.results[0]?.store).toMatchObject({
        path: first.results[0]?.store?.path,
        reused: true,
      });
      const reusedPlan = requirePlan(reused, 'reused content snapshot');
      expect(records(reusedPlan.operations)[0]?.after).toEqual(firstOperation?.after);
      const reusedOperation = records(reusedPlan.operations)[0];
      const reusedResult = executionResults(reused, 'reused content snapshot')[0];
      const reusedAction = reused.results[0]?.action;
      expect(reusedOperation).toBeDefined();
      expect(reusedResult).toBeDefined();
      expect(reusedAction).toBeDefined();
      if (
        reusedOperation === undefined ||
        reusedResult === undefined ||
        reusedAction === undefined
      ) {
        throw new Error('reused compatibility inputs are unavailable');
      }
      const mapper = await requireCompatibilityMapper();
      expect(
        mapper({
          family: 'flip',
          operation: reusedOperation,
          diagnostic: null,
          result: reusedResult,
        }),
      ).toBe(reusedAction);

      const crashOptions = baseOptions(fleet, {
        targets: ['beta'],
        tools: ['codex'],
        noVerify: true,
        selectionSource: 'explicit-targets',
      });
      const controller = new AbortController();
      let interruptedBeforeBackup = false;
      const interruptedPorts = {
        ...fleet.env,
        rename: async (from: string, to: string) => {
          if (!interruptedBeforeBackup && to.includes('.skillsmith-backup-beta-')) {
            interruptedBeforeBackup = true;
            controller.abort();
            throw new SimulatedCrash(1, 'promote-before-live-to-backup');
          }
          return fleet.env.rename(from, to);
        },
      };
      const interruptedPromise = runPromote(
        interruptedPorts,
        { ...crashOptions, signal: controller.signal },
        passFlipDeps(),
      );
      const interrupted = unwrapReport(await interruptedPromise, 'interrupted promote');
      expect(interruptedBeforeBackup).toBeTrue();
      expect(interrupted.results[0]?.action).toBe('failed');
      requirePlan(interrupted, 'interrupted promote');

      const ledgerAfterCrash = await readLedger(fleet.env, ledgerPathOf(fleet.data));
      expect(ledgerAfterCrash.ok).toBeTrue();
      if (!ledgerAfterCrash.ok) throw new Error(errorText(ledgerAfterCrash.error));
      expect(getPair(ledgerAfterCrash.value, 'beta', 'codex')?.journal?.phase).toBe('backed-up');

      const recovered = unwrapReport(
        await runPromote(
          fleet.env,
          baseOptions(fleet, {
            targets: ['beta'],
            tools: ['codex'],
            noVerify: true,
            selectionSource: 'explicit-targets',
          }),
          passFlipDeps(),
        ),
        'recovered promote',
      );
      expect(recovered.results[0]).toMatchObject({ action: 'flipped', store: { reused: true } });
      const recoveredPlan = requirePlan(recovered, 'recovered promote');
      expect(executionIds(recovered, 'recovered promote')).toEqual(operationIds(recoveredPlan));

      const ledgerAfterRecovery = await readLedger(fleet.env, ledgerPathOf(fleet.data));
      expect(ledgerAfterRecovery.ok).toBeTrue();
      if (!ledgerAfterRecovery.ok) throw new Error(errorText(ledgerAfterRecovery.error));
      expect(getPair(ledgerAfterRecovery.value, 'beta', 'codex')?.journal?.phase).toBe('committed');
      expect(await residueNames(join(fleet.home, '.agents', 'skills'))).toEqual([]);
      expect(await residueNames(storeRootOf(fleet.data))).toEqual([]);
    } finally {
      await destroyFixtureFleet(fleet);
    }
  });
});
