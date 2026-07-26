import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { basename, delimiter, join } from 'node:path';
import {
  type UpdateFleet,
  createUpdateFleet,
  destroyUpdateFleet,
  snapshotUpdateState,
} from '../../../../tests/ergonomics/fixtures/p5-update/fleet.ts';
import type { CurrentApplicationContext, InteractionPort } from '../../src/application/types.ts';
import { runUpdateApplication } from '../../src/application/update-service.ts';
import { createTestNodeArtifactCoordinatorPorts } from '../../src/artifacts/node-coordinator.ts';
import { resolveRuntimeConfiguration } from '../../src/config/runtime.ts';
import { createObservationEmitter, createOperationContext } from '../../src/observation/index.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';
import { type BinaryProcessPort, createGitPort } from '../../src/ports/git.ts';
import type { ProcessPort, RuntimePorts } from '../../src/ports/types.ts';

setDefaultTimeout(60_000);

const fleets: UpdateFleet[] = [];

afterEach(async () => {
  await Promise.all(fleets.splice(0).map(destroyUpdateFleet));
});

const fleet = async (): Promise<UpdateFleet> => {
  const value = await createUpdateFleet({ reviewMoving: true });
  fleets.push(value);
  return value;
};

const definedEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const fixturePorts = async (selected: UpdateFleet): Promise<RuntimePorts> => {
  const base = await defaultRuntimePorts();
  const environment = definedEnvironment(selected.env);
  const exec: ProcessPort['exec'] = (command, args, options = {}) =>
    base.exec(command, args, {
      ...options,
      env: { ...environment, ...options.env },
    });
  const processPort: ProcessPort = {
    exec,
    runVersion: async (binaryPath, args, signal) => {
      try {
        const product = await exec(binaryPath, args, {
          timeoutMs: 2_000,
          ...(signal === undefined ? {} : { signal }),
        });
        return product.code === 0 && !product.timedOut
          ? product.stdout.trim().split('\n')[0]?.trim() || 'unknown'
          : 'unknown';
      } catch {
        return 'unknown';
      }
    },
  };
  const binaryProcessPort: BinaryProcessPort = {
    exec: async (command, args, options = {}) => {
      const product = await exec(command, args, options);
      return { ...product, stdout: new TextEncoder().encode(product.stdout) };
    },
  };
  const path = environment.PATH ?? '';
  return {
    ...base,
    ...processPort,
    homeDir: selected.home,
    executableSearchPath: path.split(delimiter).filter(Boolean),
    xdg: {
      config: environment.XDG_CONFIG_HOME as string,
      data: environment.XDG_DATA_HOME as string,
      cache: environment.XDG_CACHE_HOME as string,
    },
    git: createGitPort(processPort, binaryProcessPort),
  };
};

const contextFor = async (
  selected: UpdateFleet,
  interaction: InteractionPort,
  events: string[],
): Promise<CurrentApplicationContext> => ({
  ports: await fixturePorts(selected),
  artifactCoordinator: await createTestNodeArtifactCoordinatorPorts(
    join(selected.root, 'coordination'),
  ),
  configuration: resolveRuntimeConfiguration(selected.env),
  invocationCwd: selected.cwd,
  globalOptions: {},
  projectContext: {
    invocationCwd: selected.cwd,
    effectiveCwd: selected.cwd,
    projectRoot: selected.cwd,
    projectIdentity: selected.cwd,
    projectKind: 'git',
    discoveredConfigPath: selected.manifest,
    explicitConfigPath: null,
  },
  interaction,
  observation: {
    context: createOperationContext({
      command: 'skillsmith update',
      workflow: 'update',
      clock: {
        wallNowIso: () => '2026-07-22T00:00:00.000Z',
        monotonicMilliseconds: () => 0,
      },
      id: { nextId: (purpose) => `update-service-${purpose}` },
    }),
    emitter: createObservationEmitter({
      toolIds: ['claude-code', 'codex'],
      observer: {
        observe: (event) => {
          if (event.kind === 'tool.verification.started') {
            events.push(`verify:${event.toolId}`);
          }
        },
      },
    }),
  },
});

const request = {
  arguments: [[]],
  options: { all: true },
} as const;

describe('update application approval boundary', () => {
  test('presents one exact bulk preview and never verifies refused or cancelled work', async () => {
    for (const terminal of ['refused', 'cancelled'] as const) {
      const selected = await fleet();
      const before = await snapshotUpdateState(selected);
      const events: string[] = [];
      let preview:
        | Extract<
            NonNullable<Parameters<InteractionPort['confirm']>[0]['preview']>,
            { kind: 'exact-update-preview' }
          >
        | undefined;
      const interaction: InteractionPort = {
        mode: 'interactive',
        choose: async () => ({ status: 'refused', reason: 'unused' }),
        confirm: async (confirmation) => {
          expect(events).toEqual([]);
          expect(confirmation).toMatchObject({
            id: 'update-exact-plan',
            preview: { kind: 'exact-update-preview', command: 'update' },
          });
          preview = confirmation.preview as typeof preview;
          events.push(`approval:${terminal}`);
          return terminal === 'cancelled'
            ? { status: 'cancelled' }
            : { status: 'refused', reason: 'fixture refusal' };
        },
      };
      const outcome = await runUpdateApplication(
        request,
        await contextFor(selected, interaction, events),
      );

      expect(outcome).toMatchObject({
        exitClass: terminal === 'cancelled' ? 'cancelled' : 'usage',
        report: {
          result: {
            state: 'refused',
            approval: { required: true, outcome: terminal },
            groups: [
              { skill: 'factor-scan', outcome: 'planned' },
              { skill: 'review', outcome: 'planned' },
            ],
          },
        },
        mutation: { kind: 'none', changed: 0 },
      });
      expect(events).toEqual([`approval:${terminal}`]);
      expect(preview?.groupIds).toEqual(outcome.report.result?.selection.groupIds);
      const previewIds = new Set(preview?.groupIds);
      expect(preview?.operationIds).toEqual(
        outcome.report.result?.operations
          .filter(({ groupId }) => previewIds.has(groupId))
          .map(({ operationId }) => operationId),
      );
      expect(await snapshotUpdateState(selected)).toEqual(before);
    }
  });

  test('begins verification only after interactive approval of the exact bulk preview', async () => {
    const selected = await fleet();
    const events: string[] = [];
    const interaction: InteractionPort = {
      mode: 'interactive',
      choose: async () => ({ status: 'refused', reason: 'unused' }),
      confirm: async () => {
        expect(events).toEqual([]);
        events.push('approval:approved');
        return { status: 'resolved', value: true };
      },
    };
    const outcome = await runUpdateApplication(
      request,
      await contextFor(selected, interaction, events),
    );

    expect(outcome.report.result?.approval).toEqual({ required: true, outcome: 'approved' });
    expect(events[0]).toBe('approval:approved');
    expect(events.slice(1)).toEqual(['verify:claude-code', 'verify:codex', 'verify:codex']);
  });

  test('preserves usage precedence and cancellation before approval, verification, or writes', async () => {
    const selected = await fleet();
    const before = await snapshotUpdateState(selected);
    const events: string[] = [];
    const controller = new AbortController();
    controller.abort();
    const interaction: InteractionPort = {
      mode: 'interactive',
      choose: async () => {
        throw new Error('cancelled update must not choose');
      },
      confirm: async () => {
        throw new Error('cancelled update must not confirm');
      },
    };
    const context = {
      ...(await contextFor(selected, interaction, events)),
      signal: controller.signal,
    };

    expect(
      (
        await runUpdateApplication(
          { arguments: [['factor-scan']], options: { all: true } },
          context,
        )
      ).exitClass,
    ).toBe('usage');
    expect(await runUpdateApplication(request, context)).toMatchObject({
      exitClass: 'cancelled',
      report: { result: null },
      diagnostics: [{ code: 'update-cancelled' }],
      mutation: { kind: 'none', changed: 0 },
    });
    expect(events).toEqual([]);
    expect(await snapshotUpdateState(selected)).toEqual(before);
  });
});

describe('update application source lifecycle', () => {
  test('materializes one inspected source once and reuses it for every selected tool', async () => {
    const selected = await fleet();
    const events: string[] = [];
    const interaction: InteractionPort = {
      mode: 'noninteractive',
      choose: async () => ({ status: 'refused', reason: 'unused' }),
      confirm: async () => {
        throw new Error('single declaration dry-run must not request approval');
      },
    };
    const context = await contextFor(selected, interaction, events);
    const calls = { initialize: 0, fetch: 0, materialize: 0 };
    const git: RuntimePorts['git'] = {
      ...context.ports.git,
      initializeFetch: async (input) => {
        calls.initialize += 1;
        return context.ports.git.initializeFetch(input);
      },
      fetchRef: async (input) => {
        calls.fetch += 1;
        return context.ports.git.fetchRef(input);
      },
      materializeTree: async (input) => {
        calls.materialize += 1;
        return context.ports.git.materializeTree(input);
      },
    };
    const outcome = await runUpdateApplication(
      { arguments: [['factor-scan']], options: { dryRun: true } },
      { ...context, ports: { ...context.ports, git } },
    );

    expect(outcome).toMatchObject({
      exitClass: 'success',
      report: {
        result: {
          state: 'ready',
          candidates: [{ proposed: { resolvedSha: selected.remote.updateHead } }],
          groups: [{ skill: 'factor-scan', tools: ['claude-code', 'codex'] }],
        },
      },
    });
    expect(calls).toEqual({ initialize: 1, fetch: 1, materialize: 1 });
    expect(
      outcome.report.result?.operations
        .filter(({ kind }) => kind === 'update')
        .map(({ source }) => (source?.kind === 'portable' ? source.resolvedSha : null)),
    ).toEqual([selected.remote.updateHead, selected.remote.updateHead]);
    expect(events).toEqual(['verify:claude-code', 'verify:codex']);
  });

  test('classifies fetch and materialization failures before approval or durable writes', async () => {
    for (const phase of ['fetch', 'materialize'] as const) {
      const selected = await fleet();
      const before = await snapshotUpdateState(selected);
      const events: string[] = [];
      const interaction: InteractionPort = {
        mode: 'noninteractive',
        choose: async () => ({ status: 'refused', reason: 'unused' }),
        confirm: async () => {
          throw new Error(`${phase} failure must not request approval`);
        },
      };
      const context = await contextFor(selected, interaction, events);
      const git =
        phase === 'fetch'
          ? {
              ...context.ports.git,
              initializeFetch: async () => {
                throw new Error('fixture fetch failure');
              },
            }
          : {
              ...context.ports.git,
              materializeTree: async () => {
                throw new Error('fixture materialization failure');
              },
            };
      const outcome = await runUpdateApplication(
        { arguments: [['factor-scan']], options: {} },
        { ...context, ports: { ...context.ports, git } },
      );

      expect(outcome, phase).toMatchObject({
        exitClass: 'source',
        report: { result: null },
        diagnostics: [{ code: 'update-source-resolution' }],
        mutation: { kind: 'none', changed: 0 },
      });
      expect(events, phase).toEqual([]);
      expect(await snapshotUpdateState(selected), phase).toEqual(before);
    }
  });

  test('reports final source cleanup failure without changing durable state', async () => {
    const selected = await fleet();
    const before = await snapshotUpdateState(selected);
    const events: string[] = [];
    const interaction: InteractionPort = {
      mode: 'noninteractive',
      choose: async () => ({ status: 'refused', reason: 'unused' }),
      confirm: async () => {
        throw new Error('single dry-run must not request approval');
      },
    };
    const context = await contextFor(selected, interaction, events);
    const removeTree: RuntimePorts['removeTree'] = async (path) => {
      if (basename(path).startsWith('.skillsmith-update-fetch-')) {
        throw new Error('fixture cleanup failure');
      }
      return context.ports.removeTree(path);
    };
    const outcome = await runUpdateApplication(
      { arguments: [['factor-scan']], options: { dryRun: true } },
      { ...context, ports: { ...context.ports, removeTree } },
    );

    expect(outcome).toMatchObject({
      exitClass: 'failure',
      report: { result: { state: 'ready', mode: 'dry-run' } },
      diagnostics: [{ code: 'update-source-cleanup' }],
      mutation: { kind: 'preview', changed: 0 },
    });
    expect(events).toEqual(['verify:claude-code', 'verify:codex']);
    expect(await snapshotUpdateState(selected)).toEqual(before);
  });

  test('preserves durable report and mutation truth when execution cleanup fails', async () => {
    const selected = await fleet();
    const before = await snapshotUpdateState(selected);
    const events: string[] = [];
    const context = await contextFor(
      selected,
      {
        mode: 'noninteractive',
        choose: async () => ({ status: 'refused', reason: 'unused' }),
        confirm: async () => {
          throw new Error('single execution must not request approval');
        },
      },
      events,
    );
    const removeTree: RuntimePorts['removeTree'] = async (path) => {
      if (basename(path).startsWith('.skillsmith-update-fetch-')) {
        throw new Error('fixture post-commit cleanup failure');
      }
      return context.ports.removeTree(path);
    };

    const outcome = await runUpdateApplication(
      { arguments: [['factor-scan']], options: {} },
      { ...context, ports: { ...context.ports, removeTree } },
    );

    expect(outcome).toMatchObject({
      exitClass: 'failure',
      report: {
        result: {
          state: 'completed',
          groups: [{ skill: 'factor-scan', outcome: 'succeeded' }],
        },
      },
      diagnostics: [{ code: 'update-source-cleanup' }],
      mutation: { kind: 'applied', planned: 3, changed: 3, unchanged: 0, failed: 0 },
    });
    expect(await snapshotUpdateState(selected)).not.toEqual(before);
  });

  test('surfaces permission denial when preparation failure cleanup cannot complete', async () => {
    const selected = await fleet();
    const before = await snapshotUpdateState(selected);
    const events: string[] = [];
    const context = await contextFor(
      selected,
      {
        mode: 'noninteractive',
        choose: async () => ({ status: 'refused', reason: 'unused' }),
        confirm: async () => {
          throw new Error('failed preparation must not request approval');
        },
      },
      events,
    );
    const permission = Object.assign(new Error('fixture cleanup permission denial'), {
      code: 'EACCES',
    });
    const git: RuntimePorts['git'] = {
      ...context.ports.git,
      initializeFetch: async () => {
        throw new Error('fixture fetch failure');
      },
    };
    const removeTree: RuntimePorts['removeTree'] = async (path) => {
      if (basename(path).startsWith('.skillsmith-update-fetch-')) throw permission;
      return context.ports.removeTree(path);
    };

    const outcome = await runUpdateApplication(
      { arguments: [['factor-scan']], options: {} },
      { ...context, ports: { ...context.ports, git, removeTree } },
    );

    expect(outcome).toMatchObject({
      exitClass: 'permission',
      report: { result: null },
      diagnostics: [{ code: 'update-source-cleanup' }],
      mutation: { kind: 'none', changed: 0 },
    });
    expect(await snapshotUpdateState(selected)).toEqual(before);
  });

  test('reports no mutation for a fully current execution rerun', async () => {
    const selected = await fleet();
    const events: string[] = [];
    const context = await contextFor(
      selected,
      {
        mode: 'noninteractive',
        choose: async () => ({ status: 'refused', reason: 'unused' }),
        confirm: async () => {
          throw new Error('single execution must not request approval');
        },
      },
      events,
    );
    const invocation = { arguments: [['factor-scan']], options: {} } as const;
    expect((await runUpdateApplication(invocation, context)).exitClass).toBe('success');

    const current = await runUpdateApplication(invocation, context);

    expect(current).toMatchObject({
      exitClass: 'success',
      report: { result: { state: 'current', operations: [] } },
      mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
    });
  });

  test('counts a committed artifact prefix when a later live operation fails', async () => {
    const selected = await fleet();
    const before = await snapshotUpdateState(selected);
    const events: string[] = [];
    const context = await contextFor(
      selected,
      {
        mode: 'noninteractive',
        choose: async () => ({ status: 'refused', reason: 'unused' }),
        confirm: async () => {
          throw new Error('single execution must not request approval');
        },
      },
      events,
    );
    const copyTree: RuntimePorts['copyTree'] = async (from, to) => {
      if (!to.includes('/skillsmith/verify/')) {
        throw new Error('fixture live/store copy failure');
      }
      return context.ports.copyTree(from, to);
    };

    const outcome = await runUpdateApplication(
      { arguments: [['factor-scan']], options: {} },
      { ...context, ports: { ...context.ports, copyTree } },
    );
    const after = await snapshotUpdateState(selected);

    expect(outcome).toMatchObject({
      exitClass: 'failure',
      report: { result: { state: 'partial', groups: [{ outcome: 'failed' }] } },
      mutation: { kind: 'applied', planned: 3, changed: 1, unchanged: 0, failed: 2 },
    });
    expect(after.lock).not.toEqual(before.lock);
  });

  test('rejects a source URL from an application-built filter-noop report', async () => {
    const selected = await fleet();
    const context = await contextFor(
      selected,
      {
        mode: 'noninteractive',
        choose: async () => ({ status: 'refused', reason: 'unused' }),
        confirm: async () => {
          throw new Error('filter-noop check must not request approval');
        },
      },
      [],
    );

    const outcome = await runUpdateApplication(
      { arguments: [['git://fixture.invalid/org/project']], options: { check: true } },
      context,
    );

    expect(outcome).toMatchObject({
      exitClass: 'failure',
      report: { result: null },
      diagnostics: [{ code: 'update-report-invalid' }],
      mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
    });
  });
});
