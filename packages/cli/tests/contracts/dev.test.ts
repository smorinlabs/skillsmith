import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { lstat, mkdir, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createLifecycleApplicationServices } from '../../../core/src/application/lifecycle-services.ts';
import type {
  CurrentApplicationContext,
  InteractionPort,
} from '../../../core/src/application/types.ts';
import {
  emptyLedger,
  getPair,
  readLedger,
  setPairAt,
  writeLedger,
} from '../../../core/src/place/ledger.ts';
import { ledgerPathOf, storeRootOf } from '../../../core/src/place/paths.ts';
import { prepareDev, runDev, runPromote, runRollback } from '../../../core/src/place/run.ts';
import type {
  DevRecord,
  FlipOptions,
  FlipReport,
  PairRecord,
} from '../../../core/src/place/types.ts';
import type { RuntimePorts } from '../../../core/src/ports/types.ts';
import type { Result } from '../../../core/src/result.ts';
import { hermeticGitEnv } from '../../../core/tests/fixtures/git-env.ts';
import {
  cannedFlipDeps,
  makeSkillSource,
  passFlipDeps,
} from '../../../core/tests/fixtures/place/dev-source.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../../../core/tests/fixtures/place/fleet.ts';
import { SimulatedCrash } from '../../../core/tests/place/crash-env.ts';
import { currentWireContractRegistry } from '../../src/contracts/wire-contracts.ts';
import { renderFlipJson } from '../../src/output/flip-json.ts';
import { validateOptionInvocation } from '../../src/spec/index.ts';
import { CLI_ENTRYPOINT } from '../fixtures/cli.ts';

setDefaultTimeout(30_000);

type UnknownRecord = Record<string, unknown>;
type ScopedFlipOptions = FlipOptions & {
  readonly scope?: 'user' | 'project';
  readonly selectionSource?: 'explicit-targets' | 'explicit-all';
};

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const records = (value: unknown): readonly UnknownRecord[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const FLIP_V4_TOP_LEVEL_KEYS = [
  'checks',
  'diagnostics',
  'dryRun',
  'kind',
  'op',
  'operations',
  'results',
  'schemaVersion',
  'selection',
  'summary',
].sort();

const requireFlipV4Envelope = (
  value: UnknownRecord,
  label: string,
  expected: Readonly<{ readonly op: 'dev' | 'rollback'; readonly dryRun: boolean }>,
): UnknownRecord => {
  expect(Object.keys(value).sort(), `${label} top-level contract`).toEqual(FLIP_V4_TOP_LEVEL_KEYS);
  expect(value).toMatchObject({
    schemaVersion: 4,
    kind: 'skillsmith.flip',
    op: expected.op,
    dryRun: expected.dryRun,
  });
  expect(Array.isArray(value.operations)).toBeTrue();
  expect(Array.isArray(value.checks)).toBeTrue();
  expect(Array.isArray(value.diagnostics)).toBeTrue();
  expect(Array.isArray(value.results)).toBeTrue();
  expect(isRecord(value.summary)).toBeTrue();
  expect(isRecord(value.selection)).toBeTrue();
  if (!isRecord(value.selection)) throw new Error(`${label} omitted selection`);
  expect(Object.keys(value.selection).sort()).toEqual(
    ['all', 'batchPolicy', 'groupIds', 'outcome', 'scopes', 'source', 'targets', 'tools'].sort(),
  );
  expect(typeof value.selection.source).toBe('string');
  expect(['explicit-targets', 'explicit-all', 'bounded-default']).toContain(
    value.selection.source as string,
  );
  expect(typeof value.selection.batchPolicy).toBe('string');
  expect(['fail-fast', 'continue-on-error']).toContain(value.selection.batchPolicy as string);
  expect(Array.isArray(value.selection.targets)).toBeTrue();
  expect(typeof value.selection.all).toBe('boolean');
  expect(Array.isArray(value.selection.tools)).toBeTrue();
  expect(Array.isArray(value.selection.scopes)).toBeTrue();
  expect(Array.isArray(value.selection.groupIds)).toBeTrue();
  expect(typeof value.selection.outcome).toBe('string');
  return value.selection;
};

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

const reportRecord = (report: FlipReport): UnknownRecord => report as unknown as UnknownRecord;

const requirePlan = (report: FlipReport, label: string): UnknownRecord => {
  const plan = reportRecord(report).plan;
  expect(isRecord(plan), `${label} must expose its immutable G3B-01 operation plan`).toBeTrue();
  if (!isRecord(plan)) throw new Error(`${label} operation plan is unavailable`);
  expect(plan.domain).toBe('skillsmith.operation-plan');
  expect(plan.schemaVersion).toBe(1);
  expect(plan.command).toBe('dev');
  expect(Array.isArray(plan.operations)).toBeTrue();
  expect(Array.isArray(plan.checks)).toBeTrue();
  expect(Array.isArray(plan.diagnostics)).toBeTrue();
  expect(Object.isFrozen(plan)).toBeTrue();
  return plan;
};

const executionResultsOf = (report: FlipReport, label: string): readonly UnknownRecord[] => {
  const value = reportRecord(report).executionResults;
  expect(Array.isArray(value), `${label} must expose separate execution results`).toBeTrue();
  return records(value);
};

const operationIds = (plan: UnknownRecord): unknown[] =>
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

const executionIds = (report: FlipReport, label: string): unknown[] =>
  executionResultsOf(report, label).map((result) => result.operationId);

const baseOptions = (
  fleet: FixtureFleet,
  overrides: Partial<ScopedFlipOptions> = {},
): ScopedFlipOptions => ({
  targets: [],
  cwd: fleet.home,
  configuration: fleet.configuration,
  ...overrides,
});

const devRecord = (sourcePath: string): DevRecord => ({
  sourcePath,
  resolvedPath: sourcePath,
  repoRoot: null,
  sourceRelPath: null,
  remote: null,
  recordedAt: '2026-07-15T00:00:00.000Z',
});

const pinnedPair = (placementPath: string, sourcePath: string, storePath: string): PairRecord => ({
  placementPath,
  mode: 'pinned',
  dev: devRecord(sourcePath),
  pinned: {
    storePath,
    rev: 'fixture-rev',
    gitSha: null,
    dirty: false,
    contentHash: `sha256:${'a'.repeat(64)}`,
    snapshotAt: '2026-07-15T00:00:00.000Z',
    verify: 'passed',
    placement: 'copy',
  },
  journal: null,
});

const writeFixtureLedger = async (fleet: FixtureFleet, ledger: ReturnType<typeof emptyLedger>) => {
  const written = await writeLedger(fleet.env, ledgerPathOf(fleet.data), ledger);
  expect(written.ok, written.ok ? undefined : errorText(written.error)).toBeTrue();
  if (!written.ok) throw new Error(errorText(written.error));
};

const runCli = async (
  fleet: FixtureFleet,
  args: readonly string[],
): Promise<Readonly<{ code: number; stdout: string; stderr: string }>> => {
  const process = Bun.spawn(['bun', CLI_ENTRYPOINT, ...args], {
    cwd: fleet.project,
    env: hermeticGitEnv({
      HOME: fleet.home,
      CLAUDE_CONFIG_DIR: join(fleet.home, '.claude'),
      CODEX_HOME: join(fleet.home, '.codex'),
      SKILLSMITH_HOME: fleet.data,
    }),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await process.exited;
  return {
    code,
    stdout: await new Response(process.stdout).text(),
    stderr: await new Response(process.stderr).text(),
  };
};

const treeOrEmpty = async (root: string): Promise<readonly string[]> => {
  try {
    return (await readdir(root, { recursive: true, encoding: 'utf8' })).sort();
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return [];
    throw error;
  }
};

const pathKind = async (path: string): Promise<'symlink' | 'dir' | 'file' | 'absent'> => {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return 'symlink';
    if (stat.isDirectory()) return 'dir';
    return 'file';
  } catch {
    return 'absent';
  }
};

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

const applicationContext = (
  fleet: FixtureFleet,
  ports: RuntimePorts,
  interaction: InteractionPort,
): CurrentApplicationContext => ({
  observation: {} as CurrentApplicationContext['observation'],
  ports,
  configuration: fleet.configuration,
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
});

const runDevSchedulingScenario = async (
  continueOnError: boolean,
): Promise<
  Readonly<{
    forwarded: unknown;
    batchPolicy: unknown;
    exitClass: string;
    actions: readonly unknown[];
    outcomes: readonly unknown[];
  }>
> => {
  const fleet = await buildFixtureFleet();
  try {
    const userPath = join(fleet.home, '.claude', 'skills', 'copied');
    const projectPath = join(fleet.project, '.claude', 'skills', 'project-pinned');
    await mkdir(projectPath, { recursive: true });
    await writeFile(join(projectPath, 'SKILL.md'), '---\nname: project-pinned\n---\n');

    const ledger = emptyLedger('2026-07-15T00:00:00.000Z');
    setPairAt(
      ledger,
      null,
      'copied',
      'claude-code',
      pinnedPair(userPath, resolve(fleet.alphaSrc), join(fleet.data, 'store', 'user-copy')),
    );
    setPairAt(
      ledger,
      fleet.projectReal,
      'project-pinned',
      'claude-code',
      pinnedPair(projectPath, resolve(fleet.betaSrc), join(fleet.data, 'store', 'project-copy')),
    );
    await writeFixtureLedger(fleet, ledger);

    let interruptedFirstGroup = false;
    const ports: RuntimePorts = {
      ...fleet.env,
      rename: async (from, to) => {
        if (!interruptedFirstGroup && to.includes('.skillsmith-backup-copied-')) {
          interruptedFirstGroup = true;
          throw new SimulatedCrash(1, 'dev-scheduler-first-group');
        }
        return fleet.env.rename(from, to);
      },
    };
    let forwarded: unknown;
    const services = createLifecycleApplicationServices({
      prepareDev: (async (env, options, deps) => {
        forwarded = Reflect.get(options, 'continueOnError');
        return deps === undefined ? prepareDev(env, options) : prepareDev(env, options, deps);
      }) as typeof prepareDev,
    });
    const interaction: InteractionPort = {
      mode: 'interactive',
      choose: async () => ({ status: 'refused', reason: 'no choice expected' }),
      confirm: async () => ({ status: 'resolved', value: true }),
    };
    const outcome = await services.dev(
      {
        arguments: [[]],
        options: {
          all: true,
          tool: ['claude-code'],
          yes: true,
          verify: false,
          continueOnError,
        },
      },
      applicationContext(fleet, ports, interaction),
    );
    expect(interruptedFirstGroup).toBeTrue();
    expect(outcome.report.value).not.toBeNull();
    if (outcome.report.value === null) throw new Error('dev scheduler report is unavailable');
    const plan = requirePlan(outcome.report.value, 'dev scheduler execution');
    return {
      forwarded,
      batchPolicy: plan.batchPolicy,
      exitClass: outcome.exitClass,
      actions: outcome.report.value.results.map((result) => result.action),
      outcomes: executionResultsOf(outcome.report.value, 'dev scheduler execution').map(
        (result) => result.outcome,
      ),
    };
  } finally {
    await destroyFixtureFleet(fleet);
  }
};

describe('EWP-CMD-DEV-TS01', () => {
  test('create/adopt/noop/mismatch/foreign/absent states project to operations or diagnostics', async () => {
    const fleet = await buildFixtureFleet();
    try {
      const created = unwrapReport(
        await runDev(
          fleet.env,
          baseOptions(fleet, {
            targets: ['beta'],
            tools: ['claude-code'],
            source: resolve(fleet.betaSrc),
          }),
          passFlipDeps(),
        ),
        'create',
      );
      const adopted = unwrapReport(
        await runDev(
          fleet.env,
          baseOptions(fleet, {
            targets: ['alpha'],
            tools: ['claude-code'],
            source: resolve(fleet.alphaSrc),
          }),
          passFlipDeps(),
        ),
        'adopt',
      );
      const noop = unwrapReport(
        await runDev(
          fleet.env,
          baseOptions(fleet, {
            targets: ['alpha'],
            tools: ['claude-code'],
            source: resolve(fleet.alphaSrc),
          }),
          passFlipDeps(),
        ),
        'noop',
      );
      const mismatch = unwrapReport(
        await runDev(
          fleet.env,
          baseOptions(fleet, {
            targets: ['alpha'],
            tools: ['claude-code'],
            source: resolve(fleet.betaSrc),
          }),
          passFlipDeps(),
        ),
        'mismatch',
      );
      const foreignPath = join(fleet.home, '.claude', 'skills', 'foreign');
      await writeFile(foreignPath, 'not a managed skill\n');
      const foreign = unwrapReport(
        await runDev(
          fleet.env,
          baseOptions(fleet, {
            targets: ['foreign'],
            tools: ['claude-code'],
            source: resolve(fleet.betaSrc),
          }),
          passFlipDeps(),
        ),
        'foreign',
      );
      const absent = await runDev(
        fleet.env,
        baseOptions(fleet, { targets: ['does-not-exist'], tools: ['claude-code'] }),
        passFlipDeps(),
      );
      expect(absent.ok, 'an absent explicit target must fail the whole invocation').toBeFalse();

      expect([
        created.results[0]?.action,
        adopted.results[0]?.action,
        noop.results[0]?.action,
        mismatch.results[0]?.action,
        foreign.results[0]?.action,
      ]).toEqual(['created', 'adopted', 'noop', 'refused', 'refused']);

      for (const [label, report] of [
        ['create', created],
        ['adopt', adopted],
      ] as const) {
        const plan = requirePlan(report, label);
        expect(records(plan.operations).map((operation) => operation.kind)).toContain('link-dev');
        expect(executionIds(report, label)).toEqual(operationIds(plan));
      }
      for (const [label, report] of [
        ['noop', noop],
        ['mismatch', mismatch],
        ['foreign', foreign],
      ] as const) {
        const plan = requirePlan(report, label);
        expect(records(plan.operations)).toHaveLength(0);
        expect(records(plan.diagnostics).map((diagnostic) => diagnostic.kind)).toContain(
          label === 'noop' ? 'noop' : 'refuse',
        );
      }
    } finally {
      await destroyFixtureFleet(fleet);
    }
  });
});

describe('EWP-CMD-DEV-TS02', () => {
  test('target/scope validation resolves unique targets and never widens ambiguity or absence', async () => {
    for (const args of [
      ['alpha', '--scope', 'project'],
      ['alpha', '--user'],
      ['alpha', '--project'],
    ]) {
      expect(validateOptionInvocation('skillsmith dev', args), args.join(' ')).toEqual({
        ok: true,
      });
    }

    const fleet = await buildFixtureFleet();
    try {
      const empty = await runCli(fleet, ['dev']);
      expect(empty.code, empty.stderr).toBe(2);
      const widened = await runCli(fleet, ['dev', 'alpha', '--all']);
      expect(widened.code, widened.stderr).toBe(2);
      const allSource = await runCli(fleet, ['dev', '--all', '--source', fleet.alphaSrc]);
      expect(allSource.code, allSource.stderr).toBe(2);
      const sourceCardinality = await runCli(fleet, [
        'dev',
        'alpha',
        'beta',
        '--source',
        fleet.alphaSrc,
      ]);
      expect(sourceCardinality.code, sourceCardinality.stderr).toBe(2);
      const destWithoutTool = await runCli(fleet, [
        'dev',
        'new-skill',
        '--source',
        fleet.alphaSrc,
        '--dest',
        join(fleet.base, 'custom'),
      ]);
      expect(destWithoutTool.code, destWithoutTool.stderr).toBe(2);
      const destWithTwoTools = await runCli(fleet, [
        'dev',
        'new-skill',
        '--source',
        fleet.alphaSrc,
        '--dest',
        join(fleet.base, 'custom'),
        '--tool',
        'claude-code',
        '--tool',
        'codex',
      ]);
      expect(destWithTwoTools.code, destWithTwoTools.stderr).toBe(2);
      const unknownTool = await runCli(fleet, ['dev', 'alpha', '--tool', 'not-a-tool']);
      expect(unknownTool.code, unknownTool.stderr).toBe(2);
      const unsupportedTool = await runCli(fleet, [
        'dev',
        'alpha',
        '--tool',
        'opencode',
        '--dry-run',
        '--json',
      ]);
      expect(unsupportedTool.code, unsupportedTool.stderr).toBe(4);

      for (const args of [
        ['alpha', '--scope', 'user', '--project'],
        ['alpha', '--user', '--project'],
      ]) {
        expect(validateOptionInvocation('skillsmith dev', args), args.join(' ')).toMatchObject({
          ok: false,
        });
      }

      const projectRoot = join(fleet.project, '.claude', 'skills');
      await mkdir(projectRoot, { recursive: true });
      await symlink(resolve(fleet.alphaSrc), join(projectRoot, 'alpha'));

      const ambiguous = await runDev(
        fleet.env,
        baseOptions(fleet, {
          targets: ['alpha'],
          tools: ['claude-code'],
          dryRun: true,
          cwd: fleet.project,
          selectionSource: 'explicit-targets',
        }),
        passFlipDeps(),
      );
      expect(ambiguous.ok, 'same-name user/project targets must refuse as ambiguous').toBeFalse();

      await rm(join(projectRoot, 'alpha'));
      const unique = unwrapReport(
        await runDev(
          fleet.env,
          baseOptions(fleet, {
            targets: ['alpha'],
            tools: ['claude-code'],
            dryRun: true,
            cwd: fleet.project,
            selectionSource: 'explicit-targets',
          }),
          passFlipDeps(),
        ),
        'unique unscoped target',
      );
      expect(requirePlan(unique, 'unique unscoped target').selection).toMatchObject({
        source: 'explicit-targets',
        scopes: ['user'],
      });

      const contraryPath = await runDev(
        fleet.env,
        baseOptions(fleet, {
          targets: [join(fleet.home, '.claude', 'skills', 'alpha')],
          tools: ['claude-code'],
          scope: 'project',
          dryRun: true,
          cwd: fleet.project,
          selectionSource: 'explicit-targets',
        }),
        passFlipDeps(),
      );
      expect(contraryPath.ok, 'an exact user path plus project scope must refuse').toBeFalse();

      const invalidLeaf = unwrapReport(
        await runDev(
          fleet.env,
          baseOptions(fleet, {
            targets: ['.'],
            tools: ['claude-code'],
            dryRun: true,
            cwd: fleet.project,
            selectionSource: 'explicit-targets',
          }),
          passFlipDeps(),
        ),
        'invalid leaf',
      );
      expect(invalidLeaf.results[0]?.action).toBe('refused');
      expect(records(requirePlan(invalidLeaf, 'invalid leaf').diagnostics)).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'refuse' })]),
      );

      const outside = await runDev(
        fleet.env,
        baseOptions(fleet, {
          targets: [join(fleet.base, 'outside', 'alpha')],
          tools: ['claude-code'],
          dryRun: true,
          cwd: fleet.project,
          selectionSource: 'explicit-targets',
        }),
        passFlipDeps(),
      );
      expect(outside.ok, 'an exact path outside every selected tool root must refuse').toBeFalse();

      const customDest = join(fleet.base, 'custom-skills');
      await mkdir(customDest, { recursive: true });
      const shadow = unwrapReport(
        await runDev(
          fleet.env,
          baseOptions(fleet, {
            targets: ['alpha'],
            tools: ['claude-code'],
            source: fleet.alphaSrc,
            dest: customDest,
            dryRun: true,
            selectionSource: 'explicit-targets',
          }),
          passFlipDeps(),
        ),
        'destination shadow',
      );
      expect(shadow.results[0]?.action).toBe('refused');
      expect(records(requirePlan(shadow, 'destination shadow').diagnostics)).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'refuse' })]),
      );

      const containedSource = await makeSkillSource(fleet.base, 'contained');
      const contained = unwrapReport(
        await runDev(
          fleet.env,
          baseOptions(fleet, {
            targets: ['contained'],
            tools: ['claude-code'],
            source: containedSource,
            dest: customDest,
            dryRun: true,
            selectionSource: 'explicit-targets',
          }),
          passFlipDeps(),
        ),
        'contained destination',
      );
      expect(
        records(requirePlan(contained, 'contained destination').operations)[0]?.after,
      ).toMatchObject({
        resource: { location: { kind: 'machine-bound', path: join(customDest, 'contained') } },
      });

      const source = await makeSkillSource(fleet.base, 'project-default');
      const projectDefault = unwrapReport(
        await runDev(
          fleet.env,
          baseOptions(fleet, {
            targets: ['project-default'],
            tools: ['claude-code'],
            source,
            dryRun: true,
            cwd: fleet.project,
            selectionSource: 'explicit-targets',
          }),
          passFlipDeps(),
        ),
        'project-default create',
      );
      expect(requirePlan(projectDefault, 'project-default create').selection).toMatchObject({
        scopes: ['project'],
      });
    } finally {
      await destroyFixtureFleet(fleet);
    }
  });
});

describe('EWP-CMD-DEV-TS03', () => {
  test('static verification is a blocking plan check with strict and no-verify behavior', async () => {
    const fleet = await buildFixtureFleet();
    try {
      const defaultCalls: unknown[] = [];
      const defaultReport = unwrapReport(
        await runDev(
          fleet.env,
          baseOptions(fleet, {
            targets: ['beta'],
            tools: ['claude-code'],
            source: resolve(fleet.betaSrc),
          }),
          cannedFlipDeps('warn', defaultCalls as never[]),
        ),
        'default verification',
      );
      expect(defaultReport.results[0]?.action).toBe('created');
      expect(defaultCalls).toHaveLength(1);

      const strictSource = await makeSkillSource(fleet.base, 'strict-source');
      const strictCalls: unknown[] = [];
      const strictReport = unwrapReport(
        await runDev(
          fleet.env,
          baseOptions(fleet, {
            targets: ['strict-source'],
            tools: ['claude-code'],
            source: strictSource,
            strict: true,
          }),
          cannedFlipDeps('warn', strictCalls as never[]),
        ),
        'strict verification',
      );
      expect(strictReport.results[0]?.action).toBe('failed');
      expect(strictCalls).toHaveLength(1);

      const skippedSource = await makeSkillSource(fleet.base, 'no-verify-source');
      const skippedCalls: unknown[] = [];
      const skippedReport = unwrapReport(
        await runDev(
          fleet.env,
          baseOptions(fleet, {
            targets: ['no-verify-source'],
            tools: ['claude-code'],
            source: skippedSource,
            noVerify: true,
          }),
          cannedFlipDeps('fail', skippedCalls as never[]),
        ),
        'no-verify',
      );
      expect(skippedReport.results[0]?.action).toBe('created');
      expect(skippedCalls).toHaveLength(0);

      const defaultPlan = requirePlan(defaultReport, 'default verification');
      const strictPlan = requirePlan(strictReport, 'strict verification');
      const skippedPlan = requirePlan(skippedReport, 'no-verify');
      for (const plan of [defaultPlan, strictPlan]) {
        const verificationChecks = records(plan.checks).filter(
          (check) => check.kind === 'verification',
        );
        expect(verificationChecks).toHaveLength(1);
        expect(verificationChecks[0]).toMatchObject({
          kind: 'verification',
          tool: 'claude-code',
          mode: 'static',
          blocking: true,
          expectedContentHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          operationIds: operationIds(plan),
        });
      }
      const defaultNonVerificationKinds = records(defaultPlan.checks)
        .filter((check) => check.kind !== 'verification')
        .map((check) => check.kind);
      expect(records(skippedPlan.checks).filter((check) => check.kind === 'verification')).toEqual(
        [],
      );
      expect(records(skippedPlan.checks).map((check) => check.kind)).toEqual(
        defaultNonVerificationKinds,
      );
      expect(executionResultsOf(strictReport, 'strict verification')).toEqual(
        expect.arrayContaining([expect.objectContaining({ outcome: 'failed' })]),
      );
    } finally {
      await destroyFixtureFleet(fleet);
    }
  });
});

describe('EWP-CMD-DEV-TS04', () => {
  test('default policy skips later groups while continuation preserves failure and executes them', async () => {
    const failFast = await runDevSchedulingScenario(false);
    const continued = await runDevSchedulingScenario(true);

    expect([failFast, continued]).toEqual([
      {
        forwarded: false,
        batchPolicy: 'fail-fast',
        exitClass: 'failure',
        actions: ['failed', 'skipped'],
        outcomes: ['failed', 'skipped-after-failure'],
      },
      {
        forwarded: true,
        batchPolicy: 'continue-on-error',
        exitClass: 'failure',
        actions: ['failed', 'flipped'],
        outcomes: ['failed', 'succeeded'],
      },
    ]);
  });

  test('scoped bulk selection is canonical, carries planned policy, and requires one approval', async () => {
    const fleet = await buildFixtureFleet();
    try {
      const userPath = join(fleet.home, '.claude', 'skills', 'copied');
      const projectRoot = join(fleet.project, '.claude', 'skills');
      const projectPath = join(projectRoot, 'project-pinned');
      const latePath = join(projectRoot, 'late-pinned');
      await mkdir(projectPath, { recursive: true });
      await writeFile(join(projectPath, 'SKILL.md'), '---\nname: project-pinned\n---\n');

      const ledger = emptyLedger('2026-07-15T00:00:00.000Z');
      setPairAt(
        ledger,
        null,
        'copied',
        'claude-code',
        pinnedPair(userPath, resolve(fleet.alphaSrc), join(fleet.data, 'store', 'user-copy')),
      );
      setPairAt(
        ledger,
        fleet.projectReal,
        'project-pinned',
        'claude-code',
        pinnedPair(projectPath, resolve(fleet.betaSrc), join(fleet.data, 'store', 'project-copy')),
      );
      setPairAt(
        ledger,
        fleet.projectReal,
        'late-pinned',
        'claude-code',
        pinnedPair(latePath, resolve(fleet.betaSrc), join(fleet.data, 'store', 'late-copy')),
      );
      await writeFixtureLedger(fleet, ledger);

      const preview = unwrapReport(
        await runDev(
          fleet.env,
          baseOptions(fleet, {
            all: true,
            tools: ['claude-code'],
            dryRun: true,
            cwd: fleet.project,
            selectionSource: 'explicit-all',
          }),
          passFlipDeps(),
        ),
        'scoped bulk preview',
      );
      const plan = requirePlan(preview, 'scoped bulk preview');
      expect(plan.selection).toMatchObject({
        source: 'explicit-all',
        scopes: ['user', 'project'],
      });
      expect(plan.batchPolicy).toBe('fail-fast');
      expect(
        records(plan.operations).map((operation) => [
          operation.scope,
          operation.skill,
          operation.tool,
        ]),
      ).toEqual([
        ['user', 'copied', 'claude-code'],
        ['project', 'project-pinned', 'claude-code'],
      ]);
      expect(executionResultsOf(preview, 'scoped bulk preview')).toEqual([]);

      const filterNoop = unwrapReport(
        await runDev(
          fleet.env,
          baseOptions(fleet, {
            all: true,
            tools: ['codex'],
            scope: 'project',
            dryRun: true,
            cwd: fleet.project,
            selectionSource: 'explicit-all',
          }),
          passFlipDeps(),
        ),
        'filter noop',
      );
      const filterPlan = requirePlan(filterNoop, 'filter noop');
      expect(records(filterPlan.operations)).toEqual([]);
      expect(records(filterPlan.diagnostics)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'noop', selectionSource: 'explicit-all' }),
        ]),
      );

      const refused = await runCli(fleet, ['--no-prompt', 'dev', '--all', '--tool', 'claude-code']);
      expect(refused.code, refused.stderr).toBe(2);
      expect(refused.stderr).toMatch(/approval|confirm/i);

      const events: string[] = [];
      const confirmations: { readonly id: string; readonly message: string }[] = [];
      let capturedPlan: UnknownRecord | null = null;
      let capturedPreview: FlipReport | null = null;
      let dependencyCalls = 0;
      const interaction: InteractionPort = {
        mode: 'interactive',
        choose: async () => ({ status: 'refused', reason: 'no choice expected' }),
        confirm: async (request) => {
          expect(
            capturedPlan,
            'confirmation must observe the completed immutable plan',
          ).not.toBeNull();
          if (capturedPlan === null) throw new Error('confirmation ran before plan construction');
          expect(events).toEqual(['plan']);
          expect(
            events.some((event) => event.startsWith('write:')),
            'approval must occur after immutable planning and before the first execution mutation',
          ).toBeFalse();
          const groupCount = new Set(
            records(capturedPlan.operations).map((operation) => operation.groupId),
          ).size;
          expect(request.message).toContain(String(groupCount));
          expect(request.message).toContain(String(records(capturedPlan.operations).length));
          const selection = capturedPlan.selection;
          expect(isRecord(selection)).toBeTrue();
          if (!isRecord(selection)) throw new Error('approved plan omitted selection facts');
          expect(selection.scopes).toEqual(['user', 'project']);
          for (const scope of selection.scopes as readonly string[]) {
            expect(request.message).toContain(scope);
          }
          await mkdir(latePath, { recursive: true });
          await writeFile(join(latePath, 'SKILL.md'), '---\nname: late-pinned\n---\n');
          events.push('confirm');
          confirmations.push(request);
          return { status: 'resolved', value: true };
        },
      };
      const prepareOnce: typeof prepareDev = async (env, options, deps) => {
        dependencyCalls += 1;
        expect(dependencyCalls, 'bulk approval must prepare exactly once').toBe(1);
        expect(options.cwd).toBe(fleet.project);
        expect(options.projectRoot).toBe(fleet.projectReal);
        const prepared =
          deps === undefined
            ? await prepareDev(env, options)
            : await prepareDev(env, options, deps);
        if (!prepared.ok) return prepared;
        capturedPreview = prepared.value.preview;
        capturedPlan = prepared.value.plan as unknown as UnknownRecord;
        requirePlan(capturedPreview, 'approval-stage preview');
        expect(executionResultsOf(capturedPreview, 'approval-stage preview')).toEqual([]);
        events.push('plan');
        return {
          ok: true,
          value: {
            preview: prepared.value.preview,
            plan: prepared.value.plan,
            execute: async () => {
              expect(capturedPlan, 'execution cannot precede plan capture').not.toBeNull();
              events.push('execute');
              const executed = await prepared.value.execute();
              if (executed.ok && capturedPlan !== null) {
                const executedPlan = requirePlan(executed.value, 'approval-stage execution');
                expect(executedPlan).toEqual(capturedPlan);
                expect(executionIds(executed.value, 'approval-stage execution')).toEqual(
                  operationIds(executedPlan),
                );
              }
              return executed;
            },
          },
        };
      };
      const services = createLifecycleApplicationServices({ prepareDev: prepareOnce });
      const outcome = await services.dev(
        {
          arguments: [[]],
          options: { all: true, tool: ['claude-code'], yes: true, verify: true },
        },
        applicationContext(fleet, trackedMutationPorts(fleet.env, events), interaction),
      );
      expect(confirmations, 'a mutating bulk plan requires exactly one confirmation').toHaveLength(
        1,
      );
      expect(dependencyCalls).toBe(1);
      expect(capturedPreview).not.toBeNull();
      expect(outcome.exitClass).toBe('success');
      expect(outcome.report.value).not.toBeNull();
      if (outcome.report.value === null) throw new Error('approved dev report is unavailable');
      const approvedPlan = requirePlan(outcome.report.value, 'approved scoped bulk');
      const approvalPlan = capturedPlan as UnknownRecord | null;
      expect(approvalPlan).not.toBeNull();
      if (approvalPlan === null) throw new Error('approved dev plan was not captured');
      expect(approvedPlan).toEqual(approvalPlan);
      expect(events.slice(0, 3)).toEqual(['plan', 'confirm', 'execute']);
      expect(events.findIndex((event) => event.startsWith('write:'))).toBeGreaterThan(
        events.indexOf('execute'),
      );
      expect(await pathKind(latePath)).toBe('dir');
      expect(
        records(approvedPlan.operations).some((operation) => operation.skill === 'late-pinned'),
      ).toBeFalse();
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
        choose: async () => ({ status: 'refused', reason: 'no choice expected' }),
        confirm: async () => {
          confirmations += 1;
          return { status: 'resolved', value: true };
        },
      };
      const outcome = await createLifecycleApplicationServices().dev(
        {
          arguments: [['alpha', 'missing-explicit-target']],
          options: { tool: ['claude-code'], yes: true, verify: true },
        },
        applicationContext(fleet, trackedMutationPorts(fleet.env, events), interaction),
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

describe('EWP-CMD-DEV-TS05', () => {
  test('preview and execution share operations while rollback carries inverse intent and conflicts pre-I/O', async () => {
    expect(
      validateOptionInvocation('skillsmith dev', ['copied', '--dry-run', '--yes']),
    ).toMatchObject({ ok: false });
    let contextReads = 0;
    const poisonedContext = new Proxy({} as CurrentApplicationContext, {
      get() {
        contextReads += 1;
        throw new Error('dry-run/approval conflict touched application context');
      },
    });
    const conflict = await createLifecycleApplicationServices().dev(
      {
        arguments: [['copied']],
        options: { tool: ['claude-code'], dryRun: true, yes: true },
      },
      poisonedContext,
    );
    expect(conflict.exitClass).toBe('usage');
    expect(conflict.report.value).toBeNull();
    expect(contextReads, 'the mode conflict must refuse before discovery, prompting, or I/O').toBe(
      0,
    );

    const fleet = await buildFixtureFleet();
    try {
      const options = baseOptions(fleet, {
        targets: ['copied'],
        tools: ['claude-code'],
        source: resolve(fleet.alphaSrc),
        selectionSource: 'explicit-targets',
      });
      const preview = unwrapReport(
        await runDev(fleet.env, { ...options, dryRun: true }, passFlipDeps()),
        'dev preview',
      );
      const previewPlan = requirePlan(preview, 'dev preview');
      expect(executionResultsOf(preview, 'dev preview')).toEqual([]);

      const execution = unwrapReport(
        await runDev(fleet.env, options, passFlipDeps()),
        'dev execution',
      );
      const executionPlan = requirePlan(execution, 'dev execution');
      expect(executionPlan.operations).toEqual(previewPlan.operations);
      expect(executionIds(execution, 'dev execution')).toEqual(operationIds(executionPlan));
      const renderedExecution = JSON.parse(renderFlipJson(execution)) as UnknownRecord;
      requireFlipV4Envelope(renderedExecution, 'rendered dev execution', {
        op: 'dev',
        dryRun: false,
      });
      expect(renderedExecution.selection).toEqual(
        wireSelectionForPlan(executionPlan, 'dev execution'),
      );
      expect(
        records(renderedExecution.operations).map((operation) => operation.operationId),
      ).toEqual(operationIds(executionPlan));
      expect(records(renderedExecution.checks).map((check) => check.checkId)).toEqual(
        records(executionPlan.checks).map((check) => check.checkId),
      );
      expect(
        records(renderedExecution.diagnostics).map((diagnostic) => diagnostic.diagnosticId),
      ).toEqual(records(executionPlan.diagnostics).map((diagnostic) => diagnostic.diagnosticId));
      const runtimeExecutionResults = executionResultsOf(execution, 'rendered dev execution');
      const renderedExecutionResults = records(renderedExecution.results);
      expect(renderedExecutionResults).toHaveLength(runtimeExecutionResults.length);
      for (const [index, renderedResult] of renderedExecutionResults.entries()) {
        const runtimeResult = runtimeExecutionResults[index];
        if (runtimeResult === undefined) {
          throw new Error(`rendered dev execution result ${index} has no runtime counterpart`);
        }
        expect(renderedResult).toEqual(runtimeResult);
        expect(renderedResult).toMatchObject({
          operationId: runtimeResult.operationId,
          outcome: runtimeResult.outcome,
          actualBefore: runtimeResult.actualBefore,
          actualAfter: runtimeResult.actualAfter,
          error: runtimeResult.error,
        });
        expect(Object.keys(renderedResult).sort()).toEqual(
          ['actualAfter', 'actualBefore', 'error', 'force', 'operationId', 'outcome'].sort(),
        );
        if (isRecord(renderedResult.error)) {
          expect(Object.keys(renderedResult.error).sort()).toEqual(
            ['code', 'message', 'remediation'].sort(),
          );
        }
      }

      const { source: _forwardSource, ...rollbackOptions } = options;
      const rollback = unwrapReport(
        await runRollback(
          fleet.env,
          { ...rollbackOptions, dryRun: true, rollback: true, op: 'dev' },
          passFlipDeps(),
        ),
        'dev rollback preview',
      );
      const rollbackPlan = requirePlan(rollback, 'dev rollback preview');
      expect(records(rollbackPlan.operations)).toHaveLength(
        records(executionPlan.operations).length,
      );
      for (const [index, operation] of records(executionPlan.operations).entries()) {
        const inverse = records(rollbackPlan.operations)[index];
        expect(inverse?.operationId).not.toBe(operation.operationId);
        expect(inverse?.kind).toBe('promote');
        expect(inverse).toMatchObject({
          groupId: operation.groupId,
          pairId: operation.pairId,
          skill: operation.skill,
          tool: operation.tool,
          scope: operation.scope,
        });
        expect(inverse?.before).toEqual(operation.after);
        expect(inverse?.after).toEqual(operation.before);
        expect(inverse?.reason).toEqual({
          code: expect.stringMatching(/rollback|inverse/),
          message: expect.stringMatching(/rollback|inverse/i),
        });
      }
      expect(executionResultsOf(rollback, 'dev rollback preview')).toEqual([]);
      const repeatedRollback = unwrapReport(
        await runRollback(
          fleet.env,
          { ...rollbackOptions, dryRun: true, rollback: true, op: 'dev' },
          passFlipDeps(),
        ),
        'repeated dev rollback preview',
      );
      const repeatedRollbackPlan = requirePlan(repeatedRollback, 'repeated dev rollback preview');
      expect(repeatedRollbackPlan).toEqual(rollbackPlan);
      expect(executionResultsOf(repeatedRollback, 'repeated dev rollback preview')).toEqual([]);
      const renderedRollbackText = renderFlipJson(rollback);
      const renderedRepeatedRollbackText = renderFlipJson(repeatedRollback);
      expect(renderedRepeatedRollbackText).toBe(renderedRollbackText);
      const renderedRollback = JSON.parse(renderedRollbackText) as UnknownRecord;
      const renderedRepeatedRollback = JSON.parse(renderedRepeatedRollbackText) as UnknownRecord;
      requireFlipV4Envelope(renderedRollback, 'rendered dev rollback', {
        op: 'rollback',
        dryRun: true,
      });
      requireFlipV4Envelope(renderedRepeatedRollback, 'rendered repeated dev rollback', {
        op: 'rollback',
        dryRun: true,
      });
      expect(renderedRollback.selection).toEqual(
        wireSelectionForPlan(rollbackPlan, 'dev rollback'),
      );
      expect(
        records(renderedRollback.operations).map((operation) => operation.operationId),
      ).toEqual(operationIds(rollbackPlan));
      expect(
        records(renderedRepeatedRollback.operations).map((operation) => operation.operationId),
      ).toEqual(operationIds(rollbackPlan));
      expect(Array.isArray(renderedRollback.checks)).toBeTrue();
      expect(Array.isArray(renderedRollback.diagnostics)).toBeTrue();
      expect(records(renderedRollback.results)).toEqual([]);

      const wire = currentWireContractRegistry.forCommand('skillsmith dev');
      expect(wire?.descriptor).toMatchObject({ id: 'flip', version: 4 });
    } finally {
      await destroyFixtureFleet(fleet);
    }
  });
});

describe('EWP-CMD-DEV-TS06', () => {
  test('an injected dev interruption recovers with source/store retention and no staging or backup residue', async () => {
    const fleet = await buildFixtureFleet();
    try {
      const skill = 'alpha';
      const source = resolve(fleet.alphaSrc);
      const placementRoot = join(fleet.home, '.claude', 'skills');
      const placementPath = join(placementRoot, skill);
      const ledgerPath = ledgerPathOf(fleet.data);
      const sourceBefore = await treeOrEmpty(source);
      const seeded = unwrapReport(
        await runPromote(
          fleet.env,
          baseOptions(fleet, {
            targets: [skill],
            tools: ['claude-code'],
            noVerify: true,
          }),
          passFlipDeps(),
        ),
        'managed pinned seed',
      );
      expect(seeded.results[0]?.action).toBe('flipped');
      const storeBeforeCrash = await treeOrEmpty(storeRootOf(fleet.data));
      expect(storeBeforeCrash.length).toBeGreaterThan(0);

      let interruptedBackupRename = false;
      const interruptedPorts: RuntimePorts = {
        ...fleet.env,
        rename: async (from, to) => {
          if (!interruptedBackupRename && to.includes(`.skillsmith-backup-${skill}-`)) {
            interruptedBackupRename = true;
            throw new SimulatedCrash(1, 'rename-live-to-backup');
          }
          return fleet.env.rename(from, to);
        },
      };
      const options = baseOptions(fleet, {
        targets: [skill],
        tools: ['claude-code'],
        noVerify: true,
        selectionSource: 'explicit-targets',
      });
      const interrupted = unwrapReport(
        await runDev(interruptedPorts, options, passFlipDeps()),
        'injected backed-up interruption',
      );
      expect(interruptedBackupRename).toBeTrue();
      expect(interrupted.results[0]?.action).toBe('failed');

      const interruptedLedger = await readLedger(fleet.env, ledgerPath);
      expect(
        interruptedLedger.ok,
        interruptedLedger.ok ? undefined : errorText(interruptedLedger.error),
      ).toBeTrue();
      if (!interruptedLedger.ok) throw new Error(errorText(interruptedLedger.error));
      const interruptedPair = getPair(interruptedLedger.value, skill, 'claude-code');
      expect(interruptedPair?.journal?.phase).toBe('backed-up');
      const stagingPath = interruptedPair?.journal?.stagingPath;
      const backupPath = interruptedPair?.journal?.backupPath;
      if (stagingPath === undefined || backupPath === undefined) {
        throw new Error('interrupted journal omitted staging or backup paths');
      }
      expect(stagingPath).toContain(`.skillsmith-staging-${skill}-`);
      expect(backupPath).toContain(`.skillsmith-backup-${skill}-`);
      expect(await pathKind(stagingPath)).toBe('symlink');
      expect(await pathKind(placementPath)).toBe('dir');
      expect(await pathKind(backupPath)).toBe('absent');
      expect(interruptedPair?.pinned?.storePath).toEqual(expect.any(String));
      if (interruptedPair?.pinned?.storePath === undefined) {
        throw new Error('interrupted dev pair omitted its retained store path');
      }
      expect(await pathKind(interruptedPair.pinned.storePath)).toBe('dir');
      expect(await treeOrEmpty(source)).toEqual(sourceBefore);

      const recovery = unwrapReport(
        await runDev(fleet.env, options, passFlipDeps()),
        'same-operation recovery',
      );
      expect(recovery.results[0]?.action).toBe('flipped');

      const recoveredLedger = await readLedger(fleet.env, ledgerPath);
      expect(
        recoveredLedger.ok,
        recoveredLedger.ok ? undefined : errorText(recoveredLedger.error),
      ).toBeTrue();
      if (!recoveredLedger.ok) throw new Error(errorText(recoveredLedger.error));
      const recoveredPair = getPair(recoveredLedger.value, skill, 'claude-code');
      expect(recoveredPair).toMatchObject({
        mode: 'dev',
        dev: { sourcePath: source, resolvedPath: source },
        pinned: { storePath: interruptedPair.pinned.storePath },
        journal: {
          op: 'dev',
          phase: 'committed',
          stagingPath,
          backupPath,
        },
      });
      expect(await pathKind(placementPath)).toBe('symlink');
      expect(await readlink(placementPath)).toBe(source);
      expect(await pathKind(interruptedPair.pinned.storePath)).toBe('dir');
      expect(await treeOrEmpty(storeRootOf(fleet.data))).toEqual(storeBeforeCrash);
      expect(await treeOrEmpty(source)).toEqual(sourceBefore);
      expect(
        (await readdir(placementRoot)).filter((name) => name.startsWith('.skillsmith-')),
      ).toEqual([]);
      expect(
        (await treeOrEmpty(fleet.data)).filter(
          (path) => path.includes('.skillsmith-') || path.includes('placements.json.tmp-'),
        ),
      ).toEqual([]);

      const renderedRecovery = JSON.parse(renderFlipJson(recovery)) as UnknownRecord;
      requireFlipV4Envelope(renderedRecovery, 'rendered dev recovery', {
        op: 'dev',
        dryRun: false,
      });
      expect(renderedRecovery.selection).toEqual(
        wireSelectionForPlan(requirePlan(recovery, 'same-operation recovery'), 'dev recovery'),
      );
      const renderedOperations = records(renderedRecovery.operations);
      expect(renderedOperations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'link-dev',
            skill,
            tool: 'claude-code',
            scope: 'user',
          }),
        ]),
      );
      const runtimeRecoveryResults = executionResultsOf(recovery, 'same-operation recovery');
      expect(records(renderedRecovery.results)).toEqual(runtimeRecoveryResults);
      expect(records(renderedRecovery.results).map((result) => result.operationId)).toEqual(
        renderedOperations.map((operation) => operation.operationId),
      );
      for (const result of records(renderedRecovery.results)) {
        expect(result).toMatchObject({
          outcome: expect.stringMatching(/^(succeeded|failed|cancelled|rolled-back)$/),
          actualBefore: expect.anything(),
          actualAfter: expect.anything(),
          error: null,
        });
      }
    } finally {
      await destroyFixtureFleet(fleet);
    }
  });
});
