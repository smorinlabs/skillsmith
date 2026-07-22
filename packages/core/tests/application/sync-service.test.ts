import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSyncApplication } from '../../src/application/sync-service.ts';
import type {
  CurrentApplicationContext,
  PreparedSyncApplication,
  SyncApplicationPort,
} from '../../src/application/types.ts';
import { createTestNodeArtifactCoordinatorPorts } from '../../src/artifacts/node-coordinator.ts';
import { resolveRuntimeConfiguration } from '../../src/config/runtime.ts';
import type { SyncReportV1Dto } from '../../src/contracts/v1/sync.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';
import type { RuntimePorts } from '../../src/ports/types.ts';
import { ok } from '../../src/result.ts';

const executionRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    executionRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const executionFixture = async (currentDestination: boolean) => {
  const root = await mkdtemp(join(tmpdir(), 'skillsmith-sync-application-identity-'));
  executionRoots.push(root);
  const home = join(root, 'home');
  const current = join(root, 'current');
  const destination = currentDestination ? current : join(root, 'destination');
  const sourceSkill = join(home, '.agents', 'skills', 'alpha');
  const data = join(root, 'data');
  await Promise.all(
    [home, current, destination, sourceSkill, data].map((path) => mkdir(path, { recursive: true })),
  );
  const source = '---\nname: alpha\n---\n\n# endpoint identity\n';
  await writeFile(join(sourceSkill, 'SKILL.md'), source);
  const base = await defaultRuntimePorts();
  const ports: RuntimePorts = {
    ...base,
    homeDir: home,
    xdg: {
      config: join(root, 'xdg', 'config'),
      data: join(root, 'xdg', 'data'),
      cache: join(root, 'xdg', 'cache'),
    },
  };
  const applicationContext = {
    ports,
    artifactCoordinator: await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination')),
    configuration: resolveRuntimeConfiguration({
      SKILLSMITH_HOME: data,
      CODEX_HOME: join(home, '.codex'),
    }),
    invocationCwd: current,
    globalOptions: {},
    interaction: {
      mode: 'noninteractive',
      choose: async () => ({ status: 'refused', reason: 'unused' }),
      confirm: async () => {
        throw new Error('single nonconflicting sync must not request approval');
      },
    },
  } as unknown as CurrentApplicationContext;
  return { root, current, destination, sourceSkill, source, applicationContext };
};

const emptyReport = (mode: 'dry-run' | 'execute' = 'execute'): SyncReportV1Dto => ({
  schemaVersion: 1,
  kind: 'skillsmith.sync',
  command: 'sync',
  mode,
  state: mode === 'dry-run' ? 'ready' : 'completed',
  endpoints: {
    from: { kind: 'user', scope: 'user', selectedInput: 'user', projectRoot: null },
    to: { kind: 'project', scope: 'project', selectedInput: 'project', projectRoot: '/project' },
  },
  artifactPair: null,
  options: {
    force: false,
    delete: false,
    save: false,
    dryRun: mode === 'dry-run',
    continueOnError: false,
  },
  selection: {
    selectionSource: 'bounded-default',
    selectionOutcome: 'filter-noop',
    targets: [],
    skills: [],
    tools: [],
    groupIds: [],
    sourceMembers: 0,
    destinationMembers: 0,
  },
  operations: [],
  checks: [],
  diagnostics: [],
  approval: { required: false, outcome: 'not-required' },
  groups: [],
  effects: [],
  summary: {
    groups: 0,
    pairs: 0,
    planned: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    notRun: 0,
    changed: 0,
    unchanged: 0,
    effects: 0,
    drift: 0,
    refusals: 0,
  },
});

const context = (port: SyncApplicationPort): CurrentApplicationContext =>
  ({
    sync: port,
    interaction: {
      mode: 'noninteractive',
      choose: async () => ({ status: 'refused', reason: 'unused' }),
      confirm: async () => ({ status: 'refused', reason: 'unavailable' }),
    },
  }) as unknown as CurrentApplicationContext;

describe('sync application service', () => {
  test('normalizes the exact request and dry-run never executes', async () => {
    let preparedRequest: unknown;
    let executions = 0;
    const prepared: PreparedSyncApplication = Object.freeze({
      report: {
        ...emptyReport('dry-run'),
        endpoints: {
          ...emptyReport('dry-run').endpoints,
          to: { ...emptyReport('dry-run').endpoints.to, selectedInput: './project' },
        },
      },
    });
    const port: SyncApplicationPort = {
      prepare: async (request) => {
        preparedRequest = request;
        return ok(prepared);
      },
      execute: async () => {
        executions++;
        return ok(emptyReport());
      },
    };
    const outcome = await runSyncApplication(
      {
        arguments: [['lint', 'review']],
        options: { from: 'user', to: './project', tool: ['codex'], dryRun: true },
      },
      context(port),
    );
    expect(preparedRequest).toEqual({
      from: 'user',
      to: './project',
      skills: ['lint', 'review'],
      tools: ['codex'],
      force: false,
      delete: false,
      save: false,
      file: null,
      lockfile: null,
      dryRun: true,
      yes: false,
      continueOnError: false,
    });
    expect(executions).toBe(0);
    expect(outcome.exitClass).toBe('success');
    expect(outcome.report.result?.mode).toBe('dry-run');
  });

  test('refuses malformed endpoints before calling the injected port', async () => {
    let calls = 0;
    const port: SyncApplicationPort = {
      prepare: async () => {
        calls++;
        return ok(Object.freeze({ report: emptyReport() }));
      },
      execute: async () => {
        calls++;
        return ok(emptyReport());
      },
    };
    const outcome = await runSyncApplication(
      { arguments: [[]], options: { from: 'user' } },
      context(port),
    );
    expect(calls).toBe(0);
    expect(outcome.exitClass).toBe('usage');
    expect(outcome.report.result).toBeNull();
  });

  test('presents exact group facts and executes the same prepared object after approval', async () => {
    const pair = {
      tool: 'codex',
      source: { scope: 'user', present: true },
      destination: { scope: 'project', present: false },
      action: 'install',
      outcome: 'planned',
      skipReason: null,
      failure: null,
      force: {
        requested: true,
        used: true,
        conflictType: 'destination-exists',
        destination: '/project/lint',
        normal: 'refuse',
        forced: 'backup-and-replace',
        required: true,
        outcome: 'planned',
      },
      drift: { artifact: false, live: true },
    } as const;
    const preparedReport: SyncReportV1Dto = {
      ...emptyReport(),
      state: 'ready',
      options: { ...emptyReport().options, force: true },
      selection: {
        ...emptyReport().selection,
        selectionOutcome: 'selected',
        skills: ['lint'],
        tools: ['codex'],
        groupIds: ['group:lint'],
      },
      approval: { required: true, outcome: 'pending' },
      operations: [
        {
          operationId: 'operation:v1:sync-lint',
          groupId: 'group:lint',
          pairId: 'pair:v1:sync-lint-codex-project',
          kind: 'update',
          dependsOn: [],
          skill: 'lint',
          source: {
            kind: 'local-dev',
            path: '/user/lint',
            contentHash: `sha256:${'a'.repeat(64)}`,
          },
          tool: 'codex',
          scope: 'project',
          before: {
            kind: 'placement',
            resource: {
              kind: 'live',
              skill: 'lint',
              tool: 'codex',
              scope: 'project',
              projectRoot: { kind: 'machine-bound', path: '/project' },
              location: { kind: 'machine-bound', path: '/project/.agents/skills/lint' },
            },
            classification: 'unmanaged',
            representation: 'copy',
            linkTarget: null,
            dangling: false,
            source: null,
            contentHash: `sha256:${'b'.repeat(64)}`,
          },
          after: {
            kind: 'placement',
            resource: {
              kind: 'live',
              skill: 'lint',
              tool: 'codex',
              scope: 'project',
              projectRoot: { kind: 'machine-bound', path: '/project' },
              location: { kind: 'machine-bound', path: '/project/.agents/skills/lint' },
            },
            classification: 'dev',
            representation: 'symlink',
            linkTarget: { kind: 'machine-bound', path: '/user/lint' },
            dangling: false,
            source: {
              kind: 'local-dev',
              path: '/user/lint',
              contentHash: `sha256:${'a'.repeat(64)}`,
            },
            contentHash: `sha256:${'a'.repeat(64)}`,
          },
          reason: { code: 'desired-placement-refresh', message: 'Refresh selected placement.' },
          selectionSource: 'bounded-default',
          preconditionIds: [],
          requiredCheckIds: [],
          reversibility: {
            kind: 'conditional',
            retentionResourceIds: ['resource:v1:sync-lint-backup'],
          },
          mutates: { live: true, manifest: false, lock: false, ledger: true },
          conflict: {
            class: 'destination-exists',
            normal: 'refuse',
            forced: 'backup-and-replace',
            target: {
              kind: 'live',
              skill: 'lint',
              tool: 'codex',
              scope: 'project',
              projectRoot: { kind: 'machine-bound', path: '/project' },
              location: { kind: 'machine-bound', path: '/project/.agents/skills/lint' },
            },
            backup: 'required',
          },
        },
      ],
      groups: [{ groupId: 'group:lint', skill: 'lint', pairs: [pair] }],
      summary: { ...emptyReport().summary, groups: 1, pairs: 1, planned: 1, changed: 1, drift: 1 },
    };
    const prepared = Object.freeze({ report: preparedReport });
    let executedPrepared: PreparedSyncApplication | null = null;
    let preview: unknown;
    const port: SyncApplicationPort = {
      prepare: async () => ok(prepared),
      execute: async (value) => {
        executedPrepared = value;
        return ok({
          ...preparedReport,
          state: 'completed',
          approval: { required: true, outcome: 'approved' },
          groups: [
            {
              groupId: 'group:lint',
              skill: 'lint',
              pairs: [
                {
                  ...pair,
                  outcome: 'succeeded',
                  force: { ...pair.force, outcome: 'succeeded' },
                },
              ],
            },
          ],
          summary: { ...preparedReport.summary, planned: 0, succeeded: 1 },
        });
      },
    };
    const approvedContext = {
      ...context(port),
      interaction: {
        mode: 'interactive',
        choose: async () => ({ status: 'refused', reason: 'unused' }),
        confirm: async (request: unknown) => {
          preview = request;
          return { status: 'resolved', value: true } as const;
        },
      },
    } as CurrentApplicationContext;
    const outcome = await runSyncApplication(
      { arguments: [[]], options: { from: 'user', to: 'project', force: true } },
      approvedContext,
    );
    expect((executedPrepared as unknown) === prepared).toBeTrue();
    expect(preview).toMatchObject({ preview: { groupIds: ['group:lint'] } });
    expect(outcome.exitClass).toBe('success');
    expect(outcome.report.result?.summary.succeeded).toBe(1);
  });

  for (const selected of [
    {
      name: 'relative non-Git path',
      currentDestination: false,
      to: (_fixture: Awaited<ReturnType<typeof executionFixture>>) => '../destination',
      kind: 'path',
    },
    {
      name: 'absolute non-Git path',
      currentDestination: false,
      to: (fixture: Awaited<ReturnType<typeof executionFixture>>) => fixture.destination,
      kind: 'path',
    },
    {
      name: 'current non-Git project',
      currentDestination: true,
      to: (_fixture: Awaited<ReturnType<typeof executionFixture>>) => 'project',
      kind: 'project',
    },
  ] as const) {
    test(`executes into an exact ${selected.name} identity`, async () => {
      const fixture = await executionFixture(selected.currentDestination);
      const sourceBefore = await readFile(join(fixture.sourceSkill, 'SKILL.md'));
      const outcome = await runSyncApplication(
        {
          arguments: [['alpha']],
          options: { from: 'user', to: selected.to(fixture), tool: ['codex'] },
        },
        fixture.applicationContext,
      );

      expect(outcome.exitClass, JSON.stringify(outcome.diagnostics)).toBe('success');
      expect(outcome.report.result).toMatchObject({
        state: 'completed',
        endpoints: {
          to: {
            kind: selected.kind,
            scope: 'project',
            projectRoot: fixture.destination,
          },
        },
        summary: { succeeded: 1, failed: 0 },
      });
      expect(
        await readFile(join(fixture.destination, '.agents', 'skills', 'alpha', 'SKILL.md')),
      ).toEqual(sourceBefore);
      expect(await readFile(join(fixture.sourceSkill, 'SKILL.md'))).toEqual(sourceBefore);
    });
  }
});
