import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
    [home, current, destination, sourceSkill].map((path) => mkdir(path, { recursive: true })),
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
  return { root, current, destination, sourceSkill, source, data, applicationContext };
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

  test('rejects source URLs from both prepared and executed adapter reports', async () => {
    const sourceUrl = 'git://fixture.invalid/org/project';
    const sourceBearing = (mode: 'dry-run' | 'execute'): SyncReportV1Dto => {
      const base = emptyReport(mode);
      return {
        ...base,
        endpoints: {
          ...base.endpoints,
          to: { ...base.endpoints.to, projectRoot: sourceUrl },
        },
      };
    };
    const rejected = {
      exitClass: 'failure',
      report: { result: null },
      diagnostics: [{ code: 'invalid-sync-report' }],
      mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
    } as const;

    let dryRunExecutions = 0;
    const dryRun = await runSyncApplication(
      { arguments: [[]], options: { from: 'user', to: 'project', dryRun: true } },
      context({
        prepare: async () => ok(Object.freeze({ report: sourceBearing('dry-run') })),
        execute: async () => {
          dryRunExecutions++;
          return ok(emptyReport());
        },
      }),
    );
    expect(dryRun).toMatchObject(rejected);
    expect(dryRunExecutions).toBe(0);

    let executions = 0;
    const execute = await runSyncApplication(
      { arguments: [[]], options: { from: 'user', to: 'project' } },
      context({
        prepare: async () => ok(Object.freeze({ report: emptyReport() })),
        execute: async () => {
          executions++;
          return ok(sourceBearing('execute'));
        },
      }),
    );
    expect(execute).toMatchObject(rejected);
    expect(executions).toBe(1);
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

  test('succeeds on the first pristine-data execution and noops on its exact retry', async () => {
    const fixture = await executionFixture(false);
    const request = {
      arguments: [['alpha']],
      options: { from: 'user', to: '../destination', tool: ['codex'] },
    } as const;

    expect(await fixture.applicationContext.ports.pathKind(fixture.data)).toBe('absent');
    const first = await runSyncApplication(request, fixture.applicationContext);
    expect(first.exitClass, JSON.stringify(first.diagnostics)).toBe('success');
    expect(first.report.result).toMatchObject({
      state: 'completed',
      groups: [{ skill: 'alpha', pairs: [{ action: 'install', outcome: 'succeeded' }] }],
      summary: { succeeded: 1, unchanged: 0 },
    });
    expect(await fixture.applicationContext.ports.pathKind(fixture.data)).toBe('dir');

    const rerun = await runSyncApplication(request, fixture.applicationContext);
    expect(rerun.exitClass, JSON.stringify(rerun.diagnostics)).toBe('success');
    expect(rerun.report.result).toMatchObject({
      mode: 'execute',
      state: 'completed',
      operations: [],
      groups: [{ skill: 'alpha', pairs: [{ action: 'noop', outcome: 'succeeded' }] }],
      summary: { planned: 0, succeeded: 1, changed: 0, unchanged: 1 },
    });
    expect(await readFile(join(fixture.sourceSkill, 'SKILL.md'), 'utf8')).toBe(fixture.source);
    expect(
      await readFile(join(fixture.destination, '.agents', 'skills', 'alpha', 'SKILL.md'), 'utf8'),
    ).toBe(fixture.source);
  });

  test('fails closed on an external post-bootstrap appearance without empty data residue', async () => {
    const fixture = await executionFixture(false);
    const base = fixture.applicationContext.ports;
    const externalConfig = join(fixture.destination, 'skillsmith.toml');
    let appeared = false;
    const ports: RuntimePorts = {
      ...base,
      makeDir: async (path) => {
        await base.makeDir(path);
        if (!appeared && path === fixture.data) {
          appeared = true;
          await writeFile(externalConfig, 'version = 1\n');
        }
      },
    };
    const changedContext = {
      ...fixture.applicationContext,
      ports,
    } as unknown as CurrentApplicationContext;

    expect(await ports.pathKind(fixture.data)).toBe('absent');
    const outcome = await runSyncApplication(
      {
        arguments: [['alpha']],
        options: { from: 'user', to: '../destination', tool: ['codex'] },
      },
      changedContext,
    );

    expect(appeared).toBeTrue();
    expect(outcome).toMatchObject({
      exitClass: 'state',
      diagnostics: [{ code: 'flip-refused' }],
    });
    expect(await readFile(externalConfig, 'utf8')).toBe('version = 1\n');
    expect(await ports.pathKind(fixture.data)).toBe('absent');
    expect(await ports.pathKind(join(fixture.destination, '.agents', 'skills', 'alpha'))).toBe(
      'absent',
    );
    expect(await readFile(join(fixture.sourceSkill, 'SKILL.md'), 'utf8')).toBe(fixture.source);
  });

  for (const setupFailure of [
    {
      name: 'permission',
      portCode: 'permission',
      exitClass: 'permission',
      code: 'permission-denied',
    },
    { name: 'cancellation', portCode: 'cancelled', exitClass: 'cancelled', code: 'cancelled' },
  ] as const) {
    test(`retains the ${setupFailure.name} exit class from ledger bootstrap setup`, async () => {
      const fixture = await executionFixture(false);
      const base = fixture.applicationContext.ports;
      const bootstrapLock = join(
        fixture.applicationContext.artifactCoordinator.coordinationRoot,
        'apply-ledger-bootstrap',
      );
      const ports: RuntimePorts = {
        ...base,
        withFileLock: async <T>(
          path: string,
          operation: () => Promise<T>,
          options?: { readonly signal?: AbortSignal },
        ) => {
          if (path === bootstrapLock) {
            throw Object.freeze({
              code: setupFailure.portCode,
              message: `synthetic bootstrap ${setupFailure.name}`,
            });
          }
          return base.withFileLock(path, operation, options);
        },
      };

      const outcome = await runSyncApplication(
        {
          arguments: [['alpha']],
          options: { from: 'user', to: '../destination', tool: ['codex'] },
        },
        { ...fixture.applicationContext, ports } as unknown as CurrentApplicationContext,
      );

      expect(outcome).toMatchObject({
        exitClass: setupFailure.exitClass,
        diagnostics: [{ code: setupFailure.code }],
      });
      expect(await ports.pathKind(fixture.data)).toBe('absent');
    });
  }

  test('force-replaces an edited managed copy with exact before and after identities', async () => {
    const fixture = await executionFixture(false);
    const destinationRoot = join(fixture.destination, '.agents', 'skills');
    const destinationSkill = join(destinationRoot, 'alpha');
    await mkdir(destinationSkill, { recursive: true });
    await writeFile(join(destinationSkill, 'SKILL.md'), '# unmanaged destination\n');
    const approvedContext = {
      ...fixture.applicationContext,
      interaction: {
        mode: 'noninteractive',
        choose: async () => ({ status: 'refused', reason: 'unused' }),
        confirm: async () => ({ status: 'resolved', value: true }),
      },
    } as unknown as CurrentApplicationContext;
    const request = {
      arguments: [['alpha']],
      options: {
        from: 'user',
        to: '../destination',
        tool: ['codex'],
        force: true,
        yes: true,
      },
    } as const;

    const first = await runSyncApplication(request, approvedContext);
    expect(first.exitClass, JSON.stringify(first.diagnostics)).toBe('success');
    expect(first.report.result).toMatchObject({
      state: 'completed',
      groups: [
        {
          pairs: [
            {
              action: 'update',
              outcome: 'succeeded',
              force: { requested: true, used: true, required: true, outcome: 'succeeded' },
            },
          ],
        },
      ],
    });

    const edited = '---\nname: alpha\n---\n\n# edited managed destination\n';
    await writeFile(join(destinationSkill, 'SKILL.md'), edited);
    const rerun = await runSyncApplication(request, approvedContext);
    expect(rerun.exitClass, JSON.stringify(rerun.diagnostics)).toBe('success');
    expect(rerun.report.result).toMatchObject({
      state: 'completed',
      groups: [
        {
          pairs: [
            {
              action: 'update',
              outcome: 'succeeded',
              force: { requested: true, used: true, required: true, outcome: 'succeeded' },
            },
          ],
        },
      ],
      summary: { succeeded: 1, failed: 0, changed: 1 },
    });
    expect(await readFile(join(destinationSkill, 'SKILL.md'), 'utf8')).toBe(fixture.source);
    const backups = (await readdir(destinationRoot, { withFileTypes: true })).filter(
      (entry) => entry.isDirectory() && entry.name.startsWith('.skillsmith-backup-alpha-'),
    );
    const backupBytes = await Promise.all(
      backups.map((entry) => readFile(join(destinationRoot, entry.name, 'SKILL.md'), 'utf8')),
    );
    expect(backupBytes).toContain(edited);
  });
});
