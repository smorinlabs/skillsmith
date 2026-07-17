import { describe, expect, test } from 'bun:test';
import type { runInstall } from '../../src/acquire/run.ts';
import type {
  CurrentInstallReport,
  CurrentUninstallReport,
  PlannedUninstallReport,
  UninstallDeps,
} from '../../src/acquire/types.ts';
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

const noConflict = {
  requested: false,
  applied: false,
  conflictType: null,
  target: null,
  normalBehavior: null,
  forcedBehavior: null,
  backup: null,
} as const;

const installReport = (action: 'installed' | 'noop' = 'installed'): CurrentInstallReport => ({
  reportVersion: 2,
  dryRun: false,
  saveMode: 'live-only',
  artifactPair: null,
  artifactSelection: { outcome: 'none', reason: 'no-save' },
  artifactEffects: [],
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
    batchPolicy: 'fail-fast',
    path: null,
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
      requestIndex: 0,
      groupId: 'group:install:skill',
      pairId: 'pair:codex:project',
      executionOutcome: action === 'installed' ? 'succeeded' : null,
      drift: {
        status: 'not-evaluated',
        futureApply: 'depends-on-selected-manifest',
        reason: null,
      },
      force: noConflict,
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
    desiredState: { changed: 0, unchanged: 0, retained: 0, notWritten: 1, failed: 0 },
  },
});

const uninstallReport = (dryRun = true): CurrentUninstallReport => ({
  reportVersion: 2,
  dryRun,
  saveMode: 'live-only',
  artifactPair: null,
  artifactSelection: { outcome: 'none', reason: 'no-save' },
  artifactEffects: [],
  requested: {
    targets: ['skill'],
    tools: ['codex'],
    explicitTools: true,
    scope: null,
    allScopes: false,
    force: false,
    batchPolicy: 'fail-fast',
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
      requestIndex: 0,
      groupId: 'group:uninstall:skill',
      pairId: 'pair:codex:project',
      executionOutcome: dryRun ? null : 'succeeded',
      drift: {
        status: 'not-evaluated',
        futureApply: 'depends-on-selected-manifest',
        reason: null,
      },
      force: noConflict,
    },
  ],
  summary: {
    removed: 1,
    noop: 0,
    refused: 0,
    failed: 0,
    desiredState: { changed: 0, unchanged: 0, retained: 0, notWritten: 1, failed: 0 },
  },
});

const plannedUninstallReport = ({
  dryRun = true,
  groups = ['group:uninstall:one'],
  backupAndReplace = false,
  refused = false,
}: Readonly<{
  dryRun?: boolean;
  groups?: readonly string[];
  backupAndReplace?: boolean;
  refused?: boolean;
}> = {}): PlannedUninstallReport => {
  const base = uninstallReport(dryRun);
  return {
    ...base,
    ...(refused
      ? {
          results: [
            {
              ...(base.results[0] as CurrentUninstallReport['results'][number]),
              action: 'refused' as const,
              reason: 'multiple saving declaration groups are deferred to G4A-04',
              error: {
                code: 'flip-refused' as const,
                message: 'multiple saving declaration groups are deferred to G4A-04',
              },
            },
          ],
          summary: { ...base.summary, removed: 0, refused: 1 },
        }
      : {}),
    plan: {
      domain: 'skillsmith.operation-plan',
      schemaVersion: 1,
      command: 'uninstall',
      selection: {
        source: 'explicit-targets',
        outcome: 'selected',
        targets: ['skill'],
        all: false,
        tools: ['codex'],
        scopes: ['project'],
        groupIds: [...groups],
      },
      batchPolicy: 'fail-fast',
      operations: refused
        ? []
        : groups.map(
            (groupId, index) =>
              ({
                operationId: `operation:uninstall:${index}`,
                groupId,
                kind: 'uninstall',
                conflict:
                  backupAndReplace && index === 0
                    ? { forced: 'backup-and-replace' as const }
                    : null,
              }) as never,
          ),
      checks: [],
      diagnostics: [],
    },
    executionResults: [],
  };
};

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

  test('uninstall forwards artifact coordination and keeps one managed group prompt-free', async () => {
    let calls = 0;
    const artifactCoordinator = Object.freeze({
      fixture: 'uninstall-artifact-coordinator',
    }) as unknown as CurrentApplicationContext['artifactCoordinator'];
    const services = createLifecycleApplicationServices({
      uninstall: (async (...args: unknown[]) => {
        calls++;
        const options = args[1] as Readonly<Record<string, unknown>>;
        const deps = args[2] as Readonly<Record<string, unknown>>;
        expect(options.dryRun).toBeFalse();
        expect(deps.artifactCoordinator).toBe(artifactCoordinator);
        return ok(plannedUninstallReport({ dryRun: false }));
      }) as never,
    });
    const interaction: InteractionPort = {
      ...noninteractive,
      confirm: async () => {
        throw new Error('one managed uninstall group must not prompt');
      },
    };

    const outcome = await services.uninstall(
      { arguments: [['skill']], options: { tool: ['codex'] } },
      context({ artifactCoordinator, interaction }),
    );

    expect(calls).toBe(1);
    expect(outcome.exitClass).toBe('success');
    expect(outcome.report.value?.dryRun).toBeFalse();
  });

  test('uninstall force preview refuses backup-and-replace without approval or mutation', async () => {
    let calls = 0;
    const services = createLifecycleApplicationServices({
      uninstall: (async (...args: unknown[]) => {
        calls++;
        expect(args[1]).toMatchObject({ force: true, dryRun: true });
        return ok(plannedUninstallReport({ backupAndReplace: true }));
      }) as never,
    });

    const outcome = await services.uninstall(
      { arguments: [['skill']], options: { tool: ['codex'], force: true } },
      context(),
    );

    expect(calls).toBe(1);
    expect(outcome.exitClass).toBe('usage');
    expect(outcome.diagnostics).toEqual([
      {
        code: 'approval-required',
        severity: 'error',
        message: 'uninstall requires approval or confirmation: noninteractive',
      },
    ]);
    expect(outcome.mutation).toEqual({
      kind: 'none',
      planned: 0,
      changed: 0,
      unchanged: 0,
      failed: 0,
    });
  });

  test('uninstall approved all-scopes multi-group preview executes with the same authority', async () => {
    const calls: Readonly<Record<string, unknown>>[] = [];
    let confirmations = 0;
    const artifactCoordinator = Object.freeze({
      fixture: 'approved-uninstall-artifact-coordinator',
    }) as unknown as CurrentApplicationContext['artifactCoordinator'];
    const services = createLifecycleApplicationServices({
      uninstall: (async (...args: unknown[]) => {
        const options = args[1] as Readonly<Record<string, unknown>>;
        const deps = args[2] as UninstallDeps;
        calls.push(options);
        expect(deps.artifactCoordinator).toBe(artifactCoordinator);
        const report = plannedUninstallReport({
          dryRun: options.dryRun === true,
          groups: ['group:uninstall:one', 'group:uninstall:two'],
        });
        if (options.dryRun !== true) deps.observePreparedPlan?.(report.plan);
        return ok(report);
      }) as never,
    });
    const interaction: InteractionPort = {
      mode: 'noninteractive',
      choose: noninteractive.choose,
      confirm: async () => {
        confirmations++;
        return { status: 'resolved', value: true };
      },
    };

    const outcome = await services.uninstall(
      {
        arguments: [['skill']],
        options: { tool: ['codex'], allScopes: true, yes: true },
      },
      context({ artifactCoordinator, interaction }),
    );

    expect(calls.map(({ dryRun }) => dryRun)).toEqual([true, false]);
    expect(confirmations).toBe(1);
    expect(outcome.exitClass).toBe('success');
    expect(outcome.report.value?.dryRun).toBeFalse();
  });

  test('uninstall dry-run never asks for approval even when force preview needs backup', async () => {
    let calls = 0;
    const services = createLifecycleApplicationServices({
      uninstall: (async (...args: unknown[]) => {
        calls++;
        expect(args[1]).toMatchObject({ force: true, dryRun: true });
        return ok(plannedUninstallReport({ backupAndReplace: true }));
      }) as never,
    });
    const interaction: InteractionPort = {
      ...noninteractive,
      confirm: async () => {
        throw new Error('dry-run must not prompt');
      },
    };

    const outcome = await services.uninstall(
      {
        arguments: [['skill']],
        options: { tool: ['codex'], force: true, dryRun: true },
      },
      context({ interaction }),
    );

    expect(calls).toBe(1);
    expect(outcome.exitClass).toBe('success');
    expect(outcome.mutation.kind).toBe('preview');
  });

  test('uninstall multi-declaration domain refusal never prompts and remains non-dry', async () => {
    const dryRunCalls: unknown[] = [];
    const services = createLifecycleApplicationServices({
      uninstall: (async (...args: unknown[]) => {
        const options = args[1] as Readonly<Record<string, unknown>>;
        dryRunCalls.push(options.dryRun);
        return ok(
          plannedUninstallReport({
            dryRun: options.dryRun === true,
            groups: [],
            refused: true,
          }),
        );
      }) as never,
    });
    const interaction: InteractionPort = {
      ...noninteractive,
      confirm: async () => {
        throw new Error('a domain-refused plan must not prompt');
      },
    };

    const outcome = await services.uninstall(
      {
        arguments: [['skill', 'other']],
        options: { tool: ['codex'], continueOnError: true },
      },
      context({ interaction }),
    );

    expect(dryRunCalls).toEqual([true, false]);
    expect(outcome.exitClass).toBe('usage');
    expect(outcome.report.value?.dryRun).toBeFalse();
    expect(outcome.report.value?.summary.refused).toBe(1);
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
