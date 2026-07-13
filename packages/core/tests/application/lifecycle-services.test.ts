import { describe, expect, test } from 'bun:test';
import type { runInstall } from '../../src/acquire/run.ts';
import type { InstallReport, UninstallReport } from '../../src/acquire/types.ts';
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
import type { runRollback } from '../../src/place/run.ts';
import type { FlipReport } from '../../src/place/types.ts';
import type { RuntimePorts } from '../../src/ports/types.ts';
import { err, ok } from '../../src/result.ts';

const ports = {} as RuntimePorts;

const noninteractive: InteractionPort = {
  mode: 'noninteractive',
  choose: async () => ({ status: 'refused', reason: 'noninteractive' }),
  confirm: async () => ({ status: 'refused', reason: 'noninteractive' }),
};

const context = (
  overrides: Partial<CurrentApplicationContext> = {},
): CurrentApplicationContext => ({
  ports,
  configuration: resolveRuntimeConfiguration({ HOME: '/home/test' }),
  interaction: noninteractive,
  invocationCwd: '/invocation',
  globalOptions: {},
  projectContext: {
    invocationCwd: '/invocation',
    effectiveCwd: '/effective',
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
    let picked = false;
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
      install: (async (
        _env: Parameters<typeof runInstall>[0],
        options: Parameters<typeof runInstall>[1],
        deps: Parameters<typeof runInstall>[2],
      ) => {
        observedOptions = options as unknown as Record<string, unknown>;
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
          tool: ['codex'],
          project: true,
          ref: 'v1',
          pin: true,
          verify: true,
          continueOnError: true,
          prompt: true,
        },
      },
      context({ interaction: interactive, signal: AbortSignal.timeout(10_000) }),
    );

    expect(picked).toBeTrue();
    expect(observedOptions).toMatchObject({
      sources: ['owner/repo/skill'],
      tools: ['codex'],
      scope: 'project',
      ref: 'v1',
      pin: true,
      noVerify: false,
      continueOnError: true,
      cwd: '/project',
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

  test('uninstall keeps scope/mode refusals pre-domain and reports dry-run as preview', async () => {
    let calls = 0;
    const services = createLifecycleApplicationServices({
      uninstall: (async () => {
        calls++;
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
    let rollbackOptions: Parameters<typeof runRollback>[1] | undefined;
    const refused = flipReport('rollback', {
      action: 'refused',
      reason: 'no prior state',
      error: { code: 'flip-refused', message: 'no prior state' },
    });
    const services = createLifecycleApplicationServices({
      dev: (async () => {
        devCalls++;
        return ok(flipReport('dev'));
      }) as never,
      rollback: (async (
        _env: Parameters<typeof runRollback>[0],
        options: Parameters<typeof runRollback>[1],
      ) => {
        rollbackOptions = options;
        return ok(refused);
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
    expect(rollbackOptions).toMatchObject({ op: 'dev', targets: ['skill'], tools: ['codex'] });
    expect(outcome.exitClass).toBe('usage');
    expect(outcome.diagnostics).toEqual([
      { code: 'skillsmith.flip-refused', severity: 'error', message: 'no prior state' },
    ]);
    expect(outcome.mutation.failed).toBe(1);
  });

  test('promote maps top-level domain errors and cancellation without numeric exit policy', async () => {
    const permissionServices = createLifecycleApplicationServices({
      promote: (async () =>
        err({ code: 'permission-denied', message: 'read only', path: '/store' })) as never,
    });
    const request = {
      arguments: [['skill']],
      options: { tool: ['codex'], verify: true },
    } as const;
    expect((await permissionServices.promote(request, context())).exitClass).toBe('permission');

    const controller = new AbortController();
    controller.abort();
    const cancelledServices = createLifecycleApplicationServices({
      promote: (async () => ok(flipReport('promote'))) as never,
    });
    const cancelled = await cancelledServices.promote(
      request,
      context({ signal: controller.signal }),
    );
    expect(cancelled.exitClass).toBe('cancelled');
    expect(cancelled.mutation.kind).toBe('applied');
  });
});
