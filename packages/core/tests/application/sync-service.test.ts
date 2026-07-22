import { describe, expect, test } from 'bun:test';
import { runSyncApplication } from '../../src/application/sync-service.ts';
import type {
  CurrentApplicationContext,
  PreparedSyncApplication,
  SyncApplicationPort,
} from '../../src/application/types.ts';
import type { SyncReportV1Dto } from '../../src/contracts/v1/sync.ts';
import { ok } from '../../src/result.ts';

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
});
