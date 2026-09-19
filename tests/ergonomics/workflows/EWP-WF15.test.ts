import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { currentWireContractRegistry } from '../../../packages/cli/src/contracts/wire-contracts.ts';
import {
  normalizeCliError,
  renderCliError,
} from '../../../packages/cli/src/output/error-boundary.ts';
import { buildProgram } from '../../../packages/cli/src/program.ts';
import { createCliRuntimeAdapter } from '../../../packages/cli/src/runtime/adapter.ts';
import { createCurrentRendererRegistry } from '../../../packages/cli/src/runtime/current-renderers.ts';
import {
  NON_MUTATING_MODE_POLICIES,
  validateNonMutatingMode,
} from '../../../packages/cli/src/util/non-mutating-mode.ts';
import { installSignalHandler } from '../../../packages/cli/src/util/signals.ts';
import { CLI_ENTRYPOINT } from '../../../packages/cli/tests/fixtures/cli.ts';
import { createLifecycleApplicationServices } from '../../../packages/core/src/application/lifecycle-services.ts';
import type {
  CurrentApplicationContext,
  InteractionPort,
} from '../../../packages/core/src/application/types.ts';
import {
  createObservationEmitter,
  createOperationContext,
  noopObserver,
} from '../../../packages/core/src/observation/index.ts';
import type { RuntimePorts } from '../../../packages/core/src/ports/types.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../../../packages/core/tests/fixtures/place/fleet.ts';
import { SimulatedCrash } from '../../../packages/core/tests/place/crash-env.ts';

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const records = (value: unknown): readonly UnknownRecord[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const wf15Secret = (): string => `ghp_${['P17', 'WF15', 'SECRET', 'CANARY'].join('_')}_123456789`;
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

interface SchedulingProduct {
  readonly exitCode: number;
  readonly exits: readonly number[];
  readonly stdout: string;
  readonly stderr: string;
  readonly report: UnknownRecord | null;
  readonly mutationEvents: readonly string[];
}

const wf15Observation = () => ({
  context: createOperationContext({
    command: 'skillsmith promote',
    workflow: 'EWP-WF15',
    clock: {
      wallNowIso: () => '2026-07-15T00:00:00.000Z',
      monotonicMilliseconds: () => 0,
    },
    id: { nextId: () => 'ewp-wf15-scheduling' },
  }),
  emitter: createObservationEmitter({ observer: noopObserver }),
});

const interactiveApproval: InteractionPort = {
  mode: 'interactive',
  choose: async <TValue>(request: {
    readonly choices: readonly { readonly value: TValue }[];
  }) => ({ status: 'resolved', value: request.choices[0]?.value as TValue }),
  confirm: async () => ({ status: 'resolved', value: true }),
};

const noninteractiveRefusal: InteractionPort = {
  mode: 'noninteractive',
  choose: async () => ({ status: 'refused', reason: 'noninteractive fixture' }),
  confirm: async () => ({ status: 'refused', reason: 'noninteractive fixture' }),
};

const prepareSchedulingFleet = async (fleet: FixtureFleet): Promise<void> => {
  await rm(join(fleet.home, '.claude', 'skills', 'dangler'));
  const projectSkills = join(fleet.project, '.claude', 'skills');
  await mkdir(projectSkills, { recursive: true });
  await symlink(resolve(fleet.betaSrc), join(projectSkills, 'project-beta'));
};

const schedulingContext = (
  fleet: FixtureFleet,
  ports: RuntimePorts,
  interaction: InteractionPort,
  signal?: AbortSignal,
): CurrentApplicationContext => ({
  observation: wf15Observation(),
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
  ...(signal === undefined ? {} : { signal }),
});

const runSchedulingProduct = async (
  options: {
    readonly format: 'human' | 'json';
    readonly continueOnError?: boolean;
    readonly cancelOnFailure?: boolean;
    readonly refuseApproval?: boolean;
  },
  preparedFleet?: FixtureFleet,
): Promise<SchedulingProduct> => {
  const ownsFleet = preparedFleet === undefined;
  const fleet = preparedFleet ?? (await buildFixtureFleet());
  try {
    if (ownsFleet) await prepareSchedulingFleet(fleet);
    const mutationEvents: string[] = [];
    const controller = new AbortController();
    let interruptedFirstGroup = false;
    const ports = new Proxy(fleet.env, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== 'function' || !MUTATION_PORTS.has(property)) return value;
        return (...args: unknown[]) => {
          mutationEvents.push(`write:${String(property)}`);
          if (
            !options.refuseApproval &&
            property === 'rename' &&
            typeof args[1] === 'string' &&
            args[1].includes('.skillsmith-backup-alpha-') &&
            !interruptedFirstGroup
          ) {
            interruptedFirstGroup = true;
            if (options.cancelOnFailure) controller.abort();
            throw new SimulatedCrash(1, wf15Secret());
          }
          return Reflect.apply(value, target, args);
        };
      },
    }) as RuntimePorts;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exits: number[] = [];
    const services = createLifecycleApplicationServices();
    const adapter = createCliRuntimeAdapter({
      applications: { promote: services.promote },
      renderers: createCurrentRendererRegistry(
        {} as Parameters<typeof createCurrentRendererRegistry>[0],
      ),
      io: {
        stdout: { write: (value) => stdout.push(value) },
        stderr: { write: (value) => stderr.push(value) },
        exit: (code) => exits.push(code),
      },
    });
    const execution = await adapter.execute({
      application: 'promote',
      reportKind: 'promote',
      request: {
        arguments: [[]],
        options: {
          all: true,
          tool: ['claude-code'],
          yes: !options.refuseApproval,
          verify: false,
          continueOnError: options.continueOnError ?? false,
        },
      },
      context: schedulingContext(
        fleet,
        ports,
        options.refuseApproval ? noninteractiveRefusal : interactiveApproval,
        controller.signal,
      ),
      observation: wf15Observation(),
      format: options.format,
    });
    const lifecycleReport = isRecord(execution.outcome?.report) ? execution.outcome.report : null;
    const report =
      lifecycleReport !== null && isRecord(lifecycleReport.value) ? lifecycleReport.value : null;
    if (!options.refuseApproval) expect(interruptedFirstGroup).toBeTrue();
    return {
      exitCode: execution.exitCode,
      exits,
      stdout: stdout.join(''),
      stderr: stderr.join(''),
      report,
      mutationEvents,
    };
  } finally {
    if (ownsFleet) await destroyFixtureFleet(fleet);
  }
};

const requireSchedulingReport = (product: SchedulingProduct, label: string): UnknownRecord => {
  expect(
    product.report,
    `${label} must retain its scheduling report: ${JSON.stringify({
      exitCode: product.exitCode,
      stdout: product.stdout,
      stderr: product.stderr,
      writes: product.mutationEvents,
    })}`,
  ).not.toBeNull();
  if (product.report === null) throw new Error(`${label} scheduling report is unavailable`);
  const plan = product.report.plan;
  expect(isRecord(plan), `${label} must retain its canonical operation plan`).toBeTrue();
  if (!isRecord(plan)) throw new Error(`${label} scheduling plan is unavailable`);
  const operations = records(plan.operations);
  expect(operations, `${label} operation count`).toHaveLength(2);
  expect(new Set(operations.map((operation) => operation.groupId)).size).toBe(2);
  expect(new Set(operations.map((operation) => operation.pairId)).size).toBe(2);
  for (const operation of operations) {
    expect(operation.groupId).toBeString();
    expect(operation.pairId).toBeString();
  }
  const results = records(product.report.executionResults);
  expect(results.map((result) => result.operationId)).toEqual(
    operations.map((operation) => operation.operationId),
  );
  return plan;
};

const runCli = async (
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: Record<string, string> } = {},
) => {
  const proc = Bun.spawn(['bun', CLI_ENTRYPOINT, ...args], {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: { ...process.env, CI: '1', NO_COLOR: '1', ...options.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;
  return {
    exitCode,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
};

describe('EWP-WF15', () => {
  afterEach(() => {
    process.exitCode = 0;
  });

  test('the Phase-1 slice declares shared non-mutating policy coverage for current commands', () => {
    const liveCommands = new Set(buildProgram().commands.map((command) => command.name()));
    for (const commandName of ['install', 'uninstall', 'dev', 'promote', 'check'] as const) {
      expect(liveCommands.has(commandName)).toBeTrue();
      expect(Object.hasOwn(NON_MUTATING_MODE_POLICIES, commandName)).toBeTrue();
    }
  });

  test('preview approval conflicts while no-prompt remains a valid noninteractive assertion', () => {
    for (const commandName of ['install', 'uninstall', 'dev', 'promote'] as const) {
      const conflict = validateNonMutatingMode(commandName, {
        dryRun: true,
        yes: true,
        prompt: false,
      });
      expect(conflict.ok).toBeFalse();
      if (conflict.ok) throw new Error(`${commandName} unexpectedly approved a preview`);
      expect(conflict.exitCode).toBe(2);

      expect(validateNonMutatingMode(commandName, { dryRun: true, prompt: false })).toEqual({
        ok: true,
      });
    }
  });

  test('human errors are one sanitized diagnostic line', () => {
    const source = Object.assign(new Error('outer failure\nforged output'), {
      cause: new Error('nested implementation detail'),
    });
    const normalized = normalizeCliError(source);
    const rendered = renderCliError(normalized, 'human');
    expect(rendered).toBe('error: outer failure forged output\n');
    expect(rendered.split('\n')).toHaveLength(2);
    expect(rendered).not.toContain('nested implementation detail');
    expect(rendered).not.toContain('stack');
  });

  test('JSON errors are one newline-terminated v1 value without cause or stack leakage', () => {
    const normalized = normalizeCliError(
      Object.assign(new Error('cannot write'), {
        code: 'permission-denied',
        cause: new Error('private nested cause'),
      }),
    );
    const rendered = renderCliError(normalized, 'json');
    expect(rendered.endsWith('\n')).toBeTrue();
    expect(rendered.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(rendered)).toEqual({
      schemaVersion: 1,
      kind: 'error',
      code: 'permission-denied',
      message: 'cannot write',
      exitCode: 6,
    });
    expect(rendered).not.toContain('private nested cause');
    expect(rendered).not.toContain('stack');
  });

  test('a spawned current command traverses the same human and JSON error boundary', async () => {
    const human = await runCli(['agents', '--tool', 'ghost']);
    expect(human.exitCode).toBe(2);
    expect(human.stdout).toBe('');
    expect(human.stderr).toBe("error: unknown tool 'ghost'\n");

    const json = await runCli(['agents', '--tool', 'ghost', '--format', 'json']);
    expect(json.exitCode).toBe(2);
    expect(json.stderr).toBe('');
    expect(json.stdout.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(json.stdout)).toEqual({
      schemaVersion: 1,
      kind: 'error',
      code: 'invalid-enum',
      message: "unknown tool 'ghost'",
      exitCode: 2,
    });
  });

  test('spawned JSON usage failures produce one envelope and no human stderr', async () => {
    const cases = [
      ['install', 'not-a-source', '--dry-run', '--yes', '--json'],
      ['uninstall', 'absent', '--dry-run', '--yes', '--json'],
      ['dev', 'absent', '--dry-run', '--yes', '--json'],
      ['promote', 'absent', '--dry-run', '--yes', '--json'],
      ['install', '--ghost', '--json'],
      ['install', '--json'],
    ] as const;
    for (const args of cases) {
      const result = await runCli(args);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe('');
      expect(result.stdout.trimEnd().split('\n')).toHaveLength(1);
      const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(envelope.schemaVersion).toBe(1);
      expect(envelope.kind).toBe('error');
      expect(envelope.exitCode).toBe(2);
    }
  });

  test('config JSON failures sanitize core errors through the same boundary', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'skillsmith-error-boundary-'));
    const configRoot = join(sandbox, 'config');
    await mkdir(join(configRoot, 'skillsmith'), { recursive: true });
    await writeFile(join(configRoot, 'skillsmith', 'config.toml'), 'tools = [\n');
    try {
      const result = await runCli(['config', 'list', '--json'], {
        cwd: sandbox,
        env: {
          HOME: join(sandbox, 'home'),
          XDG_CONFIG_HOME: configRoot,
          XDG_DATA_HOME: join(sandbox, 'data'),
          XDG_STATE_HOME: join(sandbox, 'state'),
          XDG_CACHE_HOME: join(sandbox, 'cache'),
        },
      });
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toBe('');
      expect(result.stdout.trimEnd().split('\n')).toHaveLength(1);
      const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(envelope).toMatchObject({
        schemaVersion: 1,
        kind: 'error',
        code: 'config-error',
        exitCode: 3,
      });
      expect(envelope.message).toBeString();
      expect(String(envelope.message)).not.toContain('\n');
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test('usage errors and cancellation retain the shared exit contract', () => {
    const usage = normalizeCliError({
      code: 'commander.unknownOption',
      message: "unknown option '--ghost'",
    });
    expect(usage.exitCode).toBe(2);

    const controller = new AbortController();
    const handle = installSignalHandler(controller);
    try {
      process.emit('SIGINT');
      expect(controller.signal.aborted).toBeTrue();
      expect(handle.exitCode()).toBe(130);
    } finally {
      handle.uninstall();
    }
  });

  test('real CLI scheduling products preserve group boundaries, policy, cancellation, streams, and redaction', async () => {
    // Approval refusal is mutation-free, so it can reuse the fail-fast human fleet before that
    // fleet is changed. This keeps the five product assertions while avoiding a fifth pair of Git
    // repositories in the timeout-sensitive fixture setup.
    const sharedFleet = await buildFixtureFleet();
    let products: readonly [
      SchedulingProduct,
      SchedulingProduct,
      SchedulingProduct,
      SchedulingProduct,
      SchedulingProduct,
    ];
    try {
      await prepareSchedulingFleet(sharedFleet);
      const [humanProducts, failFastJson, continuedJson, cancelledJson] = await Promise.all([
        (async () => {
          const refused = await runSchedulingProduct(
            { format: 'human', refuseApproval: true },
            sharedFleet,
          );
          const failFast = await runSchedulingProduct({ format: 'human' }, sharedFleet);
          return [failFast, refused] as const;
        })(),
        runSchedulingProduct({ format: 'json' }),
        runSchedulingProduct({ format: 'json', continueOnError: true }),
        runSchedulingProduct({ format: 'json', cancelOnFailure: true }),
      ]);
      products = [humanProducts[0], failFastJson, continuedJson, cancelledJson, humanProducts[1]];
    } finally {
      await destroyFixtureFleet(sharedFleet);
    }
    const [failFastHuman, failFastJson, continuedJson, cancelledJson, refusedHuman] = products;

    for (const [label, product] of [
      ['fail-fast human', failFastHuman],
      ['fail-fast JSON', failFastJson],
    ] as const) {
      const plan = requireSchedulingReport(product, label);
      expect(plan.batchPolicy).toBe('fail-fast');
      expect(records(product.report?.executionResults).map((result) => result.outcome)).toEqual([
        'failed',
        'skipped-after-failure',
      ]);
      expect(records(product.report?.results).map((result) => result.action)).toEqual([
        'failed',
        'skipped',
      ]);
      expect(product.exitCode).toBe(1);
      expect(product.exits).toEqual([1]);
    }

    expect(failFastHuman.stdout).toContain('1 failed');
    expect(failFastHuman.stdout).toContain('1 skipped');
    expect(failFastHuman.stdout).toContain('Exit code: 1');
    expect(failFastHuman.stdout).not.toContain('"schemaVersion"');
    expect(failFastHuman.stderr.trimEnd().split('\n')).toHaveLength(1);
    expect(failFastHuman.stderr).toStartWith('error:');

    const failFastJsonValue = JSON.parse(failFastJson.stdout) as UnknownRecord;
    expect(failFastJsonValue).toMatchObject({
      schemaVersion: 4,
      kind: 'skillsmith.flip',
    });
    const failFastJsonPlan = isRecord(failFastJson.report?.plan) ? failFastJson.report.plan : null;
    const failFastJsonOperations = records(failFastJsonValue.operations);
    const failFastJsonResults = records(failFastJsonValue.results);
    expect(
      failFastJsonOperations.map((operation) => [operation.groupId, operation.pairId]),
    ).toEqual(
      records(failFastJsonPlan?.operations).map((operation) => [
        operation.groupId,
        operation.pairId,
      ]),
    );
    expect(failFastJsonResults.map((result) => result.outcome)).toEqual([
      'failed',
      'skipped-after-failure',
    ]);
    expect(failFastJsonResults.map((result) => result.operationId)).toEqual(
      failFastJsonOperations.map((operation) => operation.operationId),
    );
    expect(failFastJson.stderr.trimEnd().split('\n')).toHaveLength(1);
    expect(failFastJson.stderr).toStartWith('error:');

    const continuedPlan = requireSchedulingReport(continuedJson, 'continued JSON');
    expect(continuedPlan.batchPolicy).toBe('continue-on-error');
    expect(records(continuedJson.report?.executionResults).map((result) => result.outcome)).toEqual(
      ['failed', 'succeeded'],
    );
    expect(records(continuedJson.report?.results).map((result) => result.action)).toEqual([
      'failed',
      'flipped',
    ]);
    expect(continuedJson.exitCode).toBe(1);
    expect(continuedJson.exits).toEqual([1]);
    const continuedJsonValue = JSON.parse(continuedJson.stdout) as UnknownRecord;
    expect(continuedJsonValue).toMatchObject({ schemaVersion: 4 });
    expect(records(continuedJsonValue.results).map((result) => result.outcome)).toEqual([
      'failed',
      'succeeded',
    ]);
    expect(records(continuedJsonValue.results).map((result) => result.operationId)).toEqual(
      records(continuedJsonValue.operations).map((operation) => operation.operationId),
    );
    expect(continuedJson.stderr.trimEnd().split('\n')).toHaveLength(1);

    requireSchedulingReport(cancelledJson, 'cancelled JSON');
    expect(records(cancelledJson.report?.executionResults).map((result) => result.outcome)).toEqual(
      ['failed', 'cancelled'],
    );
    expect(cancelledJson.exitCode).toBe(130);
    expect(cancelledJson.exits).toEqual([130]);
    const cancelledJsonValue = JSON.parse(cancelledJson.stdout) as UnknownRecord;
    expect(cancelledJsonValue).toMatchObject({ schemaVersion: 4 });
    expect(records(cancelledJsonValue.results).map((result) => result.outcome)).toEqual([
      'failed',
      'cancelled',
    ]);
    expect(records(cancelledJsonValue.results).map((result) => result.operationId)).toEqual(
      records(cancelledJsonValue.operations).map((operation) => operation.operationId),
    );
    expect(cancelledJson.stderr.trimEnd().split('\n')).toHaveLength(1);

    expect(refusedHuman.exitCode).toBe(2);
    expect(refusedHuman.exits).toEqual([2]);
    expect(refusedHuman.report).toBeNull();
    expect(refusedHuman.stdout).toBe('');
    expect(refusedHuman.stderr).toBe(
      'error: promote bulk work requires approval or confirmation: noninteractive fixture\n',
    );
    expect(refusedHuman.mutationEvents).toEqual([]);

    for (const product of [failFastHuman, failFastJson, continuedJson, cancelledJson]) {
      const serialized = `${product.stdout}\n${product.stderr}\n${JSON.stringify(product.report)}`;
      expect(serialized).not.toContain(wf15Secret());
      expect(serialized).not.toContain('P17_WF15_SECRET');
      expect(serialized).toContain('[REDACTED]');
    }
  });

  test('G3B-02 keeps flip@3 addressable while current scheduling output advances to flip@4', () => {
    expect(currentWireContractRegistry.get('flip', 3)?.descriptor).toMatchObject({
      id: 'flip',
      version: 3,
    });
    expect(currentWireContractRegistry.forCommand('skillsmith dev')?.descriptor).toMatchObject({
      id: 'flip',
      version: 4,
    });
    expect(currentWireContractRegistry.forCommand('skillsmith promote')?.descriptor).toMatchObject({
      id: 'flip',
      version: 4,
    });
    expect(currentWireContractRegistry.latest('flip')?.descriptor).toMatchObject({
      id: 'flip',
      version: 4,
    });
  });
});
