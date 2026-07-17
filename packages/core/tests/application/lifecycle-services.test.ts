import { describe, expect, test } from 'bun:test';
import type { runInstall } from '../../src/acquire/run.ts';
import type { InstallReport, UninstallReport } from '../../src/acquire/types.ts';
import { createToolRegistry, toolRegistry } from '../../src/agents/registry.ts';
import {
  LIFECYCLE_APPLICATION_SERVICES,
  createLifecycleApplicationServices,
} from '../../src/application/lifecycle-services.ts';
import type {
  ApplicationService,
  CurrentApplicationContext,
  CurrentCommandRequest,
  InteractionPort,
} from '../../src/application/types.ts';
import { resolveRuntimeConfiguration } from '../../src/config/runtime.ts';
import {
  createObservationEmitter,
  createOperationContext,
  noopObserver,
} from '../../src/observation/index.ts';
import type { prepareRollback } from '../../src/place/run.ts';
import type { FlipReport } from '../../src/place/types.ts';
import type { RuntimePorts } from '../../src/ports/types.ts';
import { err, ok } from '../../src/result.ts';
import { buildFixtureFleet, destroyFixtureFleet } from '../fixtures/place/fleet.ts';

const ports = {} as RuntimePorts;

const noninteractive: InteractionPort = {
  mode: 'noninteractive',
  choose: async () => ({ status: 'refused', reason: 'noninteractive' }),
  confirm: async () => ({ status: 'refused', reason: 'noninteractive' }),
};

const observation = Object.freeze({
  context: createOperationContext({
    command: 'skillsmith test',
    workflow: 'test',
    clock: {
      wallNowIso: () => '2026-01-01T00:00:00.000Z',
      monotonicMilliseconds: () => 0,
    },
    id: { nextId: () => 'test-operation' },
  }),
  emitter: createObservationEmitter({ observer: noopObserver }),
});

const context = (
  overrides: Partial<CurrentApplicationContext> = {},
): CurrentApplicationContext => ({
  observation,
  ports,
  artifactCoordinator: {} as CurrentApplicationContext['artifactCoordinator'],
  configuration: resolveRuntimeConfiguration({ HOME: '/home/test' }),
  interaction: noninteractive,
  invocationCwd: '/invocation',
  globalOptions: {},
  projectContext: {
    invocationCwd: '/invocation',
    effectiveCwd: '/project/packages/nested',
    projectRoot: '/project',
    projectIdentity: '/project',
    projectKind: 'git',
    discoveredConfigPath: null,
    explicitConfigPath: null,
  },
  ...overrides,
});

const installReport = (action: 'installed' | 'noop' = 'installed'): InstallReport => ({
  dryRun: false,
  requested: {
    sources: ['owner/repo/skill'],
    tools: ['codex'],
    explicitTools: true,
    scope: 'project',
    explicitScope: true,
    ref: null,
    pin: false,
    direct: false,
    force: false,
    verify: 'static',
    deep: false,
  },
  results: [
    {
      source: 'owner/repo/skill',
      skill: 'skill',
      tool: 'codex',
      scope: 'project',
      placementPath: '/project/.codex/skills/skill',
      action,
      reason: null,
      placement: 'symlink',
      store: null,
      origin: null,
      verify: null,
      candidates: null,
    },
  ],
  summary: {
    installed: action === 'installed' ? 1 : 0,
    updated: 0,
    repaired: 0,
    noop: action === 'noop' ? 1 : 0,
    skipped: 0,
    refused: 0,
    failed: 0,
  },
});

const uninstallReport = (): UninstallReport => ({
  dryRun: true,
  requested: {
    targets: ['skill'],
    tools: ['codex'],
    explicitTools: true,
    scope: null,
    allScopes: false,
    force: false,
  },
  results: [
    {
      skill: 'skill',
      tool: 'codex',
      scope: 'project',
      placementPath: '/project/.codex/skills/skill',
      action: 'removed',
      reason: null,
      before: null,
      storeRetained: null,
      backupKept: null,
    },
  ],
  summary: { removed: 1, noop: 0, refused: 0, failed: 0 },
});

const flipReport = (
  op: FlipReport['op'],
  result: Partial<FlipReport['results'][number]> = {},
): FlipReport => ({
  op,
  dryRun: false,
  requested: { targets: ['skill'], all: false, tools: ['codex'], explicitTools: true },
  plan: {
    domain: 'skillsmith.operation-plan',
    schemaVersion: 1,
    command: op === 'promote' ? 'promote' : 'dev',
    selection: {
      source: 'explicit-targets',
      outcome: 'selected',
      targets: ['skill'],
      all: false,
      tools: ['codex'],
      scopes: ['project'],
      groupIds: [],
    },
    batchPolicy: 'fail-fast',
    operations: [],
    checks: [],
    diagnostics: [],
  },
  executionResults: [],
  results: [
    {
      skill: 'skill',
      tool: 'codex',
      placementPath: '/project/.codex/skills/skill',
      action: 'flipped',
      reason: null,
      before: null,
      after: null,
      store: null,
      verify: null,
      ...result,
    },
  ],
  summary: {
    flipped: result.action === undefined || result.action === 'flipped' ? 1 : 0,
    updated: 0,
    noop: 0,
    skipped: 0,
    refused: result.action === 'refused' ? 1 : 0,
    failed: result.action === 'failed' ? 1 : 0,
    rolledBack: 0,
    created: 0,
    adopted: 0,
  },
});

describe('lifecycle application services', () => {
  test('the public registry exposes four parser-independent application services', () => {
    const services: Readonly<Record<string, ApplicationService<CurrentCommandRequest, unknown>>> =
      LIFECYCLE_APPLICATION_SERVICES;
    expect(Object.keys(services)).toEqual(['install', 'uninstall', 'dev', 'promote']);
  });

  test('default lifecycle runners remain bound to the injected registry', async () => {
    const f = await buildFixtureFleet();
    try {
      const registry = createToolRegistry(
        toolRegistry.adapters.map((adapter) => {
          if (adapter.descriptor.id !== 'codex' || adapter.placement === undefined) return adapter;
          const placement = adapter.placement;
          return {
            ...adapter,
            placement: {
              ...placement,
              resolveScoped: async (...args: Parameters<typeof placement.resolveScoped>) => {
                const resolution = await placement.resolveScoped(...args);
                return { ...resolution, duplicateReason: 'INJECTED-REGISTRY-PLACEMENT' };
              },
            },
          };
        }),
      );
      const services = createLifecycleApplicationServices({}, registry);
      const outcome = await services.promote(
        {
          arguments: [['beta']],
          options: { tool: ['codex'], verify: false, dryRun: true },
        },
        context({
          ports: f.env,
          configuration: f.configuration,
          invocationCwd: f.home,
          projectContext: {
            invocationCwd: f.home,
            effectiveCwd: f.home,
            projectRoot: null,
            projectIdentity: null,
            projectKind: 'non-git',
            discoveredConfigPath: null,
            explicitConfigPath: null,
          },
        }),
      );

      expect(outcome.report.value?.results[0]?.action).toBe('refused');
      expect(outcome.report.value?.results[0]?.reason).toBe('INJECTED-REGISTRY-PLACEMENT');
    } finally {
      await destroyFixtureFleet(f);
    }
  });

  test('install validates selection before context access and preserves capability refusal', async () => {
    const services = createLifecycleApplicationServices();
    const poisoned = new Proxy({} as CurrentApplicationContext, {
      get: (_target, property) => {
        throw new Error(`unexpected context access: ${String(property)}`);
      },
    });

    const outcome = await services.install(
      { arguments: [['owner/repo/skill']], options: { tool: ['opencode'] } },
      poisoned,
    );

    expect(outcome.exitClass).toBe('capability');
    expect(outcome.report).toEqual({ command: 'install', value: null });
    expect(outcome.diagnostics[0]?.message).toContain("tool 'opencode'");
    expect(outcome.mutation.kind).toBe('none');
  });

  test('install forwards normalized values and interaction through core domain APIs', async () => {
    let observedOptions: Record<string, unknown> | undefined;
    let installArguments: readonly unknown[] = [];
    let picked = false;
    const artifactCoordinator = Object.freeze({
      fixture: 'install-artifact-coordinator',
    }) as unknown as CurrentApplicationContext['artifactCoordinator'];
    const report = installReport();
    const interactive: InteractionPort = {
      mode: 'interactive',
      choose: async <TValue>(request: {
        readonly choices: readonly { readonly value: TValue }[];
      }) => {
        picked = true;
        return { status: 'resolved' as const, value: request.choices[0]?.value as TValue };
      },
      confirm: async () => ({ status: 'resolved', value: true }),
    };
    const services = createLifecycleApplicationServices({
      install: (async (...args: Parameters<typeof runInstall>) => {
        installArguments = args;
        const [, options, deps] = args;
        observedOptions = options as unknown as Record<string, unknown>;
        expect(deps?.artifactCoordinator).toBe(artifactCoordinator);
        expect(
          await deps?.pick?.([
            { name: 'skill', path: 'skills/skill' },
            { name: 'other', path: 'skills/other' },
          ]),
        ).toEqual({ name: 'skill', path: 'skills/skill' });
        return ok(report);
      }) as never,
    });

    const outcome = await services.install(
      {
        arguments: [['owner/repo/skill']],
        options: {
          tool: ['codex', 'codex'],
          project: true,
          ref: 'v1',
          file: './skillsmith.toml',
          lockfile: './skillsmith.lock',
          path: './custom/skills',
          pin: true,
          verify: true,
          continueOnError: true,
          prompt: true,
        },
      },
      context({
        artifactCoordinator,
        interaction: interactive,
        signal: AbortSignal.timeout(10_000),
      }),
    );

    expect(picked).toBeTrue();
    expect(installArguments).toHaveLength(3);
    expect(installArguments).not.toContain(observation);
    expect(observedOptions).toMatchObject({
      sources: ['owner/repo/skill'],
      tools: ['codex'],
      scope: 'project',
      ref: 'v1',
      file: './skillsmith.toml',
      lockfile: './skillsmith.lock',
      noSave: false,
      path: './custom/skills',
      pin: true,
      noVerify: false,
      continueOnError: true,
      cwd: '/project/packages/nested',
      configuration: resolveRuntimeConfiguration({ HOME: '/home/test' }),
    });
    expect(outcome.exitClass).toBe('success');
    expect(outcome.report).toEqual({ command: 'install', value: report });
    expect(outcome.mutation).toEqual({
      kind: 'applied',
      planned: 1,
      changed: 1,
      unchanged: 0,
      failed: 0,
    });
  });

  test('install and uninstall reject additive option conflicts before context access', async () => {
    let installCalls = 0;
    let uninstallCalls = 0;
    const services = createLifecycleApplicationServices({
      install: (async () => {
        installCalls++;
        return ok(installReport());
      }) as never,
      uninstall: (async () => {
        uninstallCalls++;
        return ok(uninstallReport());
      }) as never,
    });
    const poisoned = new Proxy({} as CurrentApplicationContext, {
      get: (_target, property) => {
        throw new Error(`unexpected context access: ${String(property)}`);
      },
    });

    const installCases = [
      {
        request: {
          arguments: [['owner/repo/skill']],
          options: { save: false, file: './skillsmith.toml' },
        },
        code: 'save-conflict',
        message: '--no-save cannot be combined with --file',
      },
      {
        request: {
          arguments: [['owner/repo/skill']],
          options: { save: false, lockfile: './skillsmith.lock' },
        },
        code: 'save-conflict',
        message: '--no-save cannot be combined with --lockfile',
      },
      {
        request: {
          arguments: [['owner/repo/skill']],
          options: { lockfile: './skillsmith.lock' },
        },
        code: 'artifact-lockfile-requires-file',
        message: '--lockfile requires --file',
      },
      {
        request: {
          arguments: [['owner/repo/one', 'owner/repo/two']],
          options: { path: './custom/skills' },
        },
        code: 'path-source',
        message: '--path is only valid with exactly one source',
      },
      {
        request: {
          arguments: [['owner/repo/skill']],
          options: {
            path: './custom/skills',
            tool: ['codex', 'codex', 'claude-code'],
          },
        },
        code: 'path-tool',
        message: '--path requires at most one explicit --tool (got 2)',
      },
      {
        request: {
          arguments: [['owner/repo/skill']],
          options: { scope: 'project', project: true },
        },
        code: 'scope',
        message: '--scope=project conflicts with --project',
      },
    ] as const;
    for (const fixture of installCases) {
      const outcome = await services.install(fixture.request, poisoned);
      expect(outcome.exitClass).toBe('usage');
      expect(outcome.diagnostics[0]?.code).toBe(fixture.code);
      expect(outcome.diagnostics[0]?.message).toBe(fixture.message);
    }

    const uninstallCases = [
      {
        request: {
          arguments: [['skill']],
          options: { save: false, file: './skillsmith.toml' },
        },
        code: 'save-conflict',
        message: '--no-save cannot be combined with --file',
      },
      {
        request: {
          arguments: [['skill']],
          options: { save: false, lockfile: './skillsmith.lock' },
        },
        code: 'save-conflict',
        message: '--no-save cannot be combined with --lockfile',
      },
      {
        request: {
          arguments: [['skill']],
          options: { lockfile: './skillsmith.lock' },
        },
        code: 'artifact-lockfile-requires-file',
        message: '--lockfile requires --file',
      },
      {
        request: {
          arguments: [['skill']],
          options: { scope: 'user', user: true },
        },
        code: 'scope',
        message: '--scope=user conflicts with --user',
      },
    ] as const;
    for (const fixture of uninstallCases) {
      const outcome = await services.uninstall(fixture.request, poisoned);
      expect(outcome.exitClass).toBe('usage');
      expect(outcome.diagnostics[0]?.code).toBe(fixture.code);
      expect(outcome.diagnostics[0]?.message).toBe(fixture.message);
    }

    expect(installCalls).toBe(0);
    expect(uninstallCalls).toBe(0);
  });

  test('negated Commander save and additive uninstall values reach the domain options', async () => {
    let installOptions: Record<string, unknown> | undefined;
    const uninstallOptions: Record<string, unknown>[] = [];
    const services = createLifecycleApplicationServices({
      install: (async (...args: Parameters<typeof runInstall>) => {
        installOptions = args[1] as unknown as Record<string, unknown>;
        return ok(installReport());
      }) as never,
      uninstall: (async (...args: unknown[]) => {
        uninstallOptions.push(args[1] as Record<string, unknown>);
        return ok(uninstallReport());
      }) as never,
    });

    await services.install(
      {
        arguments: [['owner/repo/skill']],
        options: { save: false, path: './custom/skills', tool: ['codex', 'codex'] },
      },
      context(),
    );
    await services.uninstall(
      {
        arguments: [['skill']],
        options: {
          file: './skillsmith.toml',
          lockfile: './skillsmith.lock',
          continueOnError: true,
        },
      },
      context(),
    );
    await services.uninstall({ arguments: [['skill']], options: { save: false } }, context());

    expect(installOptions).toMatchObject({
      tools: ['codex'],
      noSave: true,
      path: './custom/skills',
    });
    expect(uninstallOptions[0]).toMatchObject({
      file: './skillsmith.toml',
      lockfile: './skillsmith.lock',
      noSave: false,
      continueOnError: true,
      cwd: '/project/packages/nested',
    });
    expect(uninstallOptions[1]).toMatchObject({
      noSave: true,
      continueOnError: false,
      cwd: '/project/packages/nested',
    });
  });

  test('uninstall keeps scope/mode refusals pre-domain and reports dry-run as preview', async () => {
    let calls = 0;
    let uninstallArguments: readonly unknown[] = [];
    const services = createLifecycleApplicationServices({
      uninstall: (async (...args: unknown[]) => {
        calls++;
        uninstallArguments = args;
        return ok(uninstallReport());
      }) as never,
    });

    const refused = await services.uninstall(
      {
        arguments: [['skill']],
        options: { allScopes: true, project: true },
      },
      context(),
    );
    expect(refused.exitClass).toBe('usage');
    expect(calls).toBe(0);

    const preview = await services.uninstall(
      {
        arguments: [['skill']],
        options: { tool: ['codex'], dryRun: true },
      },
      context(),
    );
    expect(calls).toBe(1);
    expect(uninstallArguments).toHaveLength(3);
    expect(uninstallArguments).not.toContain(observation);
    expect(preview.exitClass).toBe('success');
    expect(preview.mutation).toEqual({
      kind: 'preview',
      planned: 1,
      changed: 1,
      unchanged: 0,
      failed: 0,
    });
  });

  test('dev rollback dispatches to rollback and translates report refusal semantically', async () => {
    let devCalls = 0;
    let devArguments: readonly unknown[] = [];
    let rollbackArguments: readonly unknown[] = [];
    let rollbackOptions: Parameters<typeof prepareRollback>[1] | undefined;
    const refused = flipReport('rollback', {
      action: 'refused',
      reason: 'no prior state',
      error: { code: 'flip-refused', message: 'no prior state' },
    });
    const services = createLifecycleApplicationServices({
      prepareDev: (async (...args: unknown[]) => {
        devCalls++;
        devArguments = args;
        const report = flipReport('dev');
        return ok({
          preview: { ...report, dryRun: true, executionResults: [] },
          plan: report.plan,
          execute: async () => ok(report),
        });
      }) as never,
      prepareRollback: (async (...args: Parameters<typeof prepareRollback>) => {
        rollbackArguments = args;
        const [, options] = args;
        rollbackOptions = options;
        return ok({
          preview: { ...refused, dryRun: true, executionResults: [] },
          plan: refused.plan,
          execute: async () => ok(refused),
        });
      }) as never,
    });

    const outcome = await services.dev(
      {
        arguments: [['skill']],
        options: { tool: ['codex'], rollback: true, verify: true },
      },
      context(),
    );

    expect(devCalls).toBe(0);
    expect(rollbackArguments).toHaveLength(2);
    expect(rollbackArguments).not.toContain(observation);
    expect(rollbackOptions).toMatchObject({ op: 'dev', targets: ['skill'], tools: ['codex'] });
    expect(outcome.exitClass).toBe('usage');
    expect(outcome.diagnostics).toEqual([
      { code: 'skillsmith.flip-refused', severity: 'error', message: 'no prior state' },
    ]);
    expect(outcome.mutation.failed).toBe(1);

    const forward = await services.dev(
      {
        arguments: [['skill']],
        options: { tool: ['codex'], verify: true, dryRun: true },
      },
      context(),
    );
    expect(forward.exitClass).toBe('success');
    expect(devCalls).toBe(1);
    expect(devArguments).toHaveLength(2);
    expect(devArguments).not.toContain(observation);
  });

  test('promote maps top-level domain errors and cancellation without numeric exit policy', async () => {
    let promoteArguments: readonly unknown[] = [];
    const permissionServices = createLifecycleApplicationServices({
      preparePromote: (async (...args: unknown[]) => {
        promoteArguments = args;
        return err({ code: 'permission-denied', message: 'read only', path: '/store' });
      }) as never,
    });
    const request = {
      arguments: [['skill']],
      options: { tool: ['codex'], verify: true },
    } as const;
    expect((await permissionServices.promote(request, context())).exitClass).toBe('permission');
    expect(promoteArguments).toHaveLength(2);
    expect(promoteArguments).not.toContain(observation);

    const controller = new AbortController();
    controller.abort();
    const report = flipReport('promote');
    const cancelledServices = createLifecycleApplicationServices({
      preparePromote: (async () =>
        ok({
          preview: { ...report, dryRun: true, executionResults: [] },
          plan: report.plan,
          execute: async () => ok(report),
        })) as never,
    });
    const cancelled = await cancelledServices.promote(
      request,
      context({ signal: controller.signal }),
    );
    expect(cancelled.exitClass).toBe('cancelled');
    expect(cancelled.mutation.kind).toBe('applied');
  });
});
