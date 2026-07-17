import { describe, expect, test } from 'bun:test';
import {
  type AcquisitionSnapshotAuthorityV1,
  createAcquisitionRepositoryLifecycleControllerV1,
  executeAcquirePlans,
  resolveAcquisitionArtifactDestinationV1,
} from '../../src/acquire/execute.ts';
import type { ProjectContext } from '../../src/context/types.ts';
import type { PlacementExecutionInput } from '../../src/place/execute.ts';
import { emptyLedgerModel } from '../../src/place/ledger.ts';
import type { PlacementPorts } from '../../src/place/types.ts';
import { createOperationExecutionResult } from '../../src/planning/create.ts';
import type { ExecutableOperation, OperationExecutionResult } from '../../src/planning/types.ts';
import { err, ok } from '../../src/result.ts';
import { stageLogicalRepositoryEditV1 } from '../../src/state/repositories.ts';
import { type ExpectedRevisionV1, createExpectedRevisionV1 } from '../../src/state/types.ts';

const ROOT = '/work/repo';
const CWD = '/work/repo/packages/app';
const NESTED_MANIFEST = '/work/repo/packages/app/skillsmith.toml';
const PROJECT_MANIFEST = '/work/repo/skillsmith.toml';
const USER_MANIFEST = '/home/user/.config/skillsmith/skillsmith.toml';

const projectContext = (discoveredConfigPath: string | null = null): ProjectContext =>
  Object.freeze({
    invocationCwd: CWD,
    effectiveCwd: CWD,
    projectRoot: ROOT,
    projectIdentity: ROOT,
    projectKind: 'git',
    discoveredConfigPath,
    explicitConfigPath: null,
  });

const manifest = (names: readonly string[], scope: 'project' | 'user' = 'project'): string =>
  `${[
    'version = 1',
    '[defaults]',
    `scope = "${scope}"`,
    'tools = ["codex"]',
    ...names.flatMap((name) => [
      '[[skills]]',
      `name = "${name}"`,
      `source = "github.com/acme/skills//${name}"`,
    ]),
  ].join('\n')}\n`;

class DestinationPorts {
  readonly xdg = Object.freeze({
    config: '/home/user/.config',
    data: '/home/user/.local/share',
    cache: '/home/user/.cache',
  });
  readonly calls = {
    pathKind: [] as string[],
    readText: [] as string[],
    realpath: [] as string[],
  };
  readonly entries = new Map<
    string,
    Readonly<{ kind: 'file' | 'dir' | 'symlink'; text?: string; realpath?: string }>
  >([
    [ROOT, { kind: 'dir' }],
    ['/home/user/.config/skillsmith', { kind: 'dir' }],
  ]);

  constructor(
    entries: Readonly<
      Record<
        string,
        Readonly<{ kind: 'file' | 'dir' | 'symlink'; text?: string; realpath?: string }>
      >
    > = {},
  ) {
    for (const [path, entry] of Object.entries(entries)) this.entries.set(path, entry);
  }

  async pathKind(path: string): Promise<'absent' | 'file' | 'dir' | 'symlink'> {
    this.calls.pathKind.push(path);
    return this.entries.get(path)?.kind ?? 'absent';
  }

  async readText(path: string): Promise<string> {
    this.calls.readText.push(path);
    const entry = this.entries.get(path);
    if (entry?.kind !== 'file' || entry.text === undefined) {
      throw new Error(`unexpected destination manifest read: ${path}`);
    }
    return entry.text;
  }

  async realpath(path: string): Promise<string> {
    this.calls.realpath.push(path);
    return this.entries.get(path)?.realpath ?? path;
  }
}

const resolveDestination = (
  ports: DestinationPorts,
  input: Partial<
    Omit<Parameters<typeof resolveAcquisitionArtifactDestinationV1>[0], 'ports' | 'projectContext'>
  > = {},
  context: ProjectContext = projectContext(),
) =>
  resolveAcquisitionArtifactDestinationV1({
    ports,
    projectContext: context,
    names: ['factor-scan'],
    scope: 'project',
    mode: 'save',
    ...input,
  });

describe('acquisition artifact destination resolution', () => {
  test('returns live-only none before reading any portable port', async () => {
    let accesses = 0;
    const ports = new Proxy({} as DestinationPorts, {
      get() {
        accesses += 1;
        throw new Error('no-save accessed a portable port');
      },
    });

    const result = await resolveDestination(ports, {
      names: [],
      noSave: true,
      file: '../../state/team.toml',
      lockfile: '../../state/team.lock',
    });

    expect(result).toEqual({
      outcome: 'none',
      saveMode: 'live-only',
      pair: null,
      selection: { outcome: 'none', reason: 'no-save' },
    });
    expect(accesses).toBe(0);
    expect(Object.isFrozen(result)).toBeTrue();
    expect(Object.isFrozen(result.selection)).toBeTrue();
  });

  test('returns pre-resolution none for empty or duplicate raw resolved names without discovery', async () => {
    for (const names of [[], ['factor-scan', 'factor-scan']] as const) {
      const ports = new DestinationPorts();
      const result = await resolveDestination(ports, { names });
      expect(result).toEqual({
        outcome: 'none',
        saveMode: 'desired-state',
        pair: null,
        selection: { outcome: 'none', reason: 'pre-resolution-failure' },
      });
      expect(ports.calls).toEqual({ pathKind: [], readText: [], realpath: [] });
    }
  });

  test('resolves one exact explicit pair with either its sibling or explicit lock', async () => {
    for (const explicitLock of [false, true]) {
      const ports = new DestinationPorts();
      const result = await resolveDestination(ports, {
        file: '../../state/team.toml',
        ...(explicitLock ? { lockfile: '../../portable/team.state.lock' } : {}),
      });
      expect(result).toMatchObject({
        outcome: 'selected',
        saveMode: 'desired-state',
        pair: {
          file: { path: '/work/repo/state/team.toml' },
          lockfile: {
            path: explicitLock
              ? '/work/repo/portable/team.state.lock'
              : '/work/repo/state/team.lock',
          },
          lockfileSource: explicitLock ? 'explicit' : 'sibling',
        },
        selection: { outcome: 'selected', selectedBy: 'explicit-file' },
      });
    }
  });

  test('does not discard a lockfile-only selector when the explicit file is missing', async () => {
    const result = await resolveDestination(new DestinationPorts(), {
      lockfile: '../../portable/team.state.lock',
    });
    expect(result).toEqual({
      outcome: 'refused',
      saveMode: 'desired-state',
      pair: null,
      selection: { outcome: 'refused', reason: 'invalid-candidate', candidates: [] },
    });
  });

  test('selects a unique owner before scope defaults and identifies new user/project declarations', async () => {
    const projectOwnerPorts = new DestinationPorts({
      [PROJECT_MANIFEST]: { kind: 'file', text: manifest(['factor-scan']) },
    });
    const projectOwner = await resolveDestination(
      projectOwnerPorts,
      { scope: 'user' },
      projectContext(PROJECT_MANIFEST),
    );
    expect(projectOwner).toMatchObject({
      outcome: 'selected',
      pair: { file: { path: PROJECT_MANIFEST } },
      selection: { outcome: 'selected', selectedBy: 'selected-project-owner' },
    });

    const rootOwner = await resolveDestination(
      new DestinationPorts({
        [NESTED_MANIFEST]: { kind: 'file', text: manifest(['other']) },
        [PROJECT_MANIFEST]: { kind: 'file', text: manifest(['factor-scan']) },
      }),
      {},
      projectContext(NESTED_MANIFEST),
    );
    expect(rootOwner).toMatchObject({
      outcome: 'selected',
      pair: { file: { path: PROJECT_MANIFEST } },
      selection: { outcome: 'selected', selectedBy: 'project-root-owner' },
    });

    const userOwner = await resolveDestination(
      new DestinationPorts({
        [PROJECT_MANIFEST]: { kind: 'file', text: manifest(['other']) },
        [USER_MANIFEST]: { kind: 'file', text: manifest(['factor-scan'], 'user') },
      }),
      {},
      projectContext(PROJECT_MANIFEST),
    );
    expect(userOwner).toMatchObject({
      outcome: 'selected',
      pair: { file: { path: USER_MANIFEST } },
      selection: { outcome: 'selected', selectedBy: 'user-owner' },
    });

    const newUser = await resolveDestination(new DestinationPorts(), { scope: 'user' });
    expect(newUser).toMatchObject({
      outcome: 'selected',
      pair: { file: { path: USER_MANIFEST } },
      selection: { outcome: 'selected', selectedBy: 'new-user' },
    });

    const newProject = await resolveDestination(new DestinationPorts());
    expect(newProject).toMatchObject({
      outcome: 'selected',
      pair: { file: { path: PROJECT_MANIFEST } },
      selection: { outcome: 'selected', selectedBy: 'new-project' },
    });
  });

  test('derives legacy-project-migration from the selected discovery candidate', async () => {
    const ports = new DestinationPorts({
      [PROJECT_MANIFEST]: { kind: 'file', text: 'tool = "codex"\nscope = "project"\n' },
    });
    const result = await resolveDestination(ports, {}, projectContext(PROJECT_MANIFEST));
    expect(result).toMatchObject({
      outcome: 'selected',
      pair: { file: { path: PROJECT_MANIFEST } },
      selection: { outcome: 'selected', selectedBy: 'legacy-project-migration' },
    });
  });

  test('returns typed ambiguous, split, and invalid-candidate refusals', async () => {
    const ambiguous = await resolveDestination(
      new DestinationPorts({
        [PROJECT_MANIFEST]: { kind: 'file', text: manifest(['factor-scan']) },
        [USER_MANIFEST]: { kind: 'file', text: manifest(['factor-scan'], 'user') },
      }),
      {},
      projectContext(PROJECT_MANIFEST),
    );
    expect(ambiguous).toEqual({
      outcome: 'refused',
      saveMode: 'desired-state',
      pair: null,
      selection: {
        outcome: 'refused',
        reason: 'ambiguous-owner',
        candidates: [PROJECT_MANIFEST, USER_MANIFEST],
      },
    });

    const split = await resolveDestination(
      new DestinationPorts({
        [PROJECT_MANIFEST]: { kind: 'file', text: manifest(['alpha']) },
        [USER_MANIFEST]: { kind: 'file', text: manifest(['beta'], 'user') },
      }),
      { names: ['alpha', 'beta'] },
      projectContext(PROJECT_MANIFEST),
    );
    expect(split).toMatchObject({
      outcome: 'refused',
      pair: null,
      selection: {
        outcome: 'refused',
        reason: 'split-owner',
        candidates: [PROJECT_MANIFEST, USER_MANIFEST],
      },
    });

    const invalid = await resolveDestination(
      new DestinationPorts({
        [PROJECT_MANIFEST]: { kind: 'file', text: 'version = 1\ntool = "codex"\n' },
      }),
      {},
      projectContext(PROJECT_MANIFEST),
    );
    expect(invalid).toMatchObject({
      outcome: 'refused',
      pair: null,
      selection: {
        outcome: 'refused',
        reason: 'invalid-candidate',
        candidates: [PROJECT_MANIFEST],
      },
    });
  });

  test('preserves an exact explicit absent remove pair and gives automatic absence no owner', async () => {
    const explicitPorts = new DestinationPorts();
    const explicit = await resolveDestination(explicitPorts, {
      mode: 'remove',
      file: '../../state/team.toml',
      lockfile: '../../portable/team.state.lock',
    });
    expect(explicit).toMatchObject({
      outcome: 'selected',
      pair: {
        file: { path: '/work/repo/state/team.toml' },
        lockfile: { path: '/work/repo/portable/team.state.lock' },
        lockfileSource: 'explicit',
      },
      selection: { outcome: 'selected', selectedBy: 'explicit-file' },
    });

    const automaticPorts = new DestinationPorts();
    const automatic = await resolveDestination(automaticPorts, { mode: 'remove' });
    expect(automatic).toEqual({
      outcome: 'none',
      saveMode: 'desired-state',
      pair: null,
      selection: { outcome: 'none', reason: 'no-owner' },
    });
    expect(automaticPorts.calls.realpath).toEqual([]);
  });
});

const absentLedgerRevision = (resourceId: string, marker: string): ExpectedRevisionV1 => {
  const revision = createExpectedRevisionV1({
    schemaVersion: 1,
    domain: 'ledger',
    resourceId,
    state: 'absent',
    targetIdentity: `/fixture/${marker}/placements.json`,
    targetKind: 'absent',
    parentIdentity: `/fixture/${marker}`,
    parentKind: 'directory',
    parentMetadataIdentity: `metadata:v1:${marker.repeat(64).slice(0, 64)}`,
  });
  if (!revision.ok) throw new Error('fixture revision is invalid');
  return revision.value;
};

const operation = (marker: string): ExecutableOperation => {
  return {
    operationId: `operation:v1:${marker.repeat(64).slice(0, 64)}`,
    groupId: `group:v1:${marker.repeat(64).slice(0, 64)}`,
    pairId: null,
    kind: 'migrate-ledger',
    dependencyMetadata: {
      domain: 'skillsmith.operation-dependency',
      schemaVersion: 1,
      operationIds: [],
    },
    skill: null,
    source: null,
    tool: null,
    scope: null,
    before: {
      kind: 'ledger',
      projectRoot: null,
      schemaVersion: 1,
      byteHash: `sha256:${'a'.repeat(64)}`,
      semanticHash: `sha256:${'b'.repeat(64)}`,
    },
    after: {
      kind: 'ledger',
      projectRoot: null,
      schemaVersion: 2,
      byteHash: `sha256:${'c'.repeat(64)}`,
      semanticHash: `sha256:${'d'.repeat(64)}`,
    },
    reason: { code: 'fixture', message: 'fixture' },
    selectionSource: 'explicit-targets',
    preconditionIds: [],
    requiredCheckIds: [],
    reversibility: { kind: 'none', retentionResourceIds: [] },
    mutates: { live: false, manifest: false, lock: false, ledger: true },
    conflict: null,
  };
};

const resultFor = (
  operation: ExecutableOperation,
  outcome: 'succeeded' | 'failed',
): OperationExecutionResult =>
  createOperationExecutionResult({
    operationId: operation.operationId,
    outcome,
    actualBefore: operation.before,
    actualAfter: outcome === 'succeeded' ? operation.after : operation.before,
    force: null,
    error:
      outcome === 'succeeded'
        ? null
        : {
            code: 'fixture-failed',
            message: 'fixture failed',
            remediation: 'retry',
          },
  });

const lifecycleFixture = () => {
  const resourceId = 'ledger:fixture';
  const firstRevision = absentLedgerRevision(resourceId, 'a');
  const secondRevision = absentLedgerRevision(resourceId, 'b');
  let currentRevision = firstRevision;
  let observationFails = false;
  const stagedExpected: ExpectedRevisionV1[] = [];
  const repository = {
    observe: async () => err({ code: 'unused' }),
    observeRevision: async () =>
      observationFails
        ? err({
            code: 'state-repository' as const,
            domain: 'ledger' as const,
            reason: 'observation-failed' as const,
          })
        : ok(currentRevision),
    stage: async (request: Parameters<typeof stageLogicalRepositoryEditV1>[0]) => {
      stagedExpected.push(request.expectedRevision);
      return stageLogicalRepositoryEditV1({
        ...request,
        observedRevision: currentRevision,
      });
    },
  };
  const authority = {
    ledgerResourceId: resourceId,
    repositories: { ledger: repository, live: repository, store: repository },
  } as unknown as AcquisitionSnapshotAuthorityV1;
  const controller = createAcquisitionRepositoryLifecycleControllerV1({
    authority,
    snapshotId: `snapshot:v1:${'e'.repeat(64)}`,
    expectedRevisions: [firstRevision],
  });
  return {
    controller,
    resourceId,
    firstRevision,
    secondRevision,
    stagedExpected,
    setRevision: (revision: ExpectedRevisionV1) => {
      currentRevision = revision;
    },
    failObservation: () => {
      observationFails = true;
    },
  };
};

const executeLifecycleBinding = async (
  fixture: ReturnType<typeof lifecycleFixture>,
  planned: ExecutableOperation,
  execute: () => Promise<OperationExecutionResult>,
) => {
  const bound = fixture.controller.bind(
    planned,
    {
      operationId: planned.operationId,
      groupId: planned.groupId,
      pairId: planned.pairId,
      unstartedForce: null,
      observeActualBefore: async () => planned.before,
      execute: async () => execute(),
    },
    [fixture.resourceId],
  );
  return bound.execute({
    operationId: planned.operationId,
    groupId: planned.groupId,
    pairId: planned.pairId,
    actualBefore: planned.before,
    unstartedForce: null,
    execute: async () => {
      throw new Error('fixture validated binding cannot be re-entered');
    },
  });
};

describe('acquisition execution boundary', () => {
  test('preserves the approved ledger for an empty physical plan sequence', async () => {
    const ledger = emptyLedgerModel('2026-07-16T00:00:00.000Z');
    const input: PlacementExecutionInput = {
      env: {} as PlacementPorts,
      ledgerPath: '/tmp/placements.json',
      ledger,
      journalNow: () => '2026-07-16T00:00:00.000Z',
      newTransactionId: () => 'unused',
    };

    const executed = await executeAcquirePlans(input, []);
    expect(executed.ok).toBeTrue();
    if (executed.ok) expect(executed.value).toEqual([]);
    expect(executed.state.ledger).toBe(ledger);
  });

  test('advances the sequential cursor through committed lifecycle receipts', async () => {
    const fixture = lifecycleFixture();
    const first = operation('1');
    const second = operation('2');
    await executeLifecycleBinding(fixture, first, async () => {
      fixture.setRevision(fixture.secondRevision);
      return resultFor(first, 'succeeded');
    });
    await executeLifecycleBinding(fixture, second, async () => resultFor(second, 'succeeded'));

    expect(fixture.stagedExpected).toEqual([fixture.firstRevision, fixture.secondRevision]);
  });

  test('keeps the sequential cursor usable after a truthful rolled-back receipt', async () => {
    const fixture = lifecycleFixture();
    const first = operation('3');
    const second = operation('4');
    expect(
      (await executeLifecycleBinding(fixture, first, async () => resultFor(first, 'failed')))
        .outcome,
    ).toBe('failed');
    await executeLifecycleBinding(fixture, second, async () => resultFor(second, 'succeeded'));

    expect(fixture.stagedExpected).toEqual([fixture.firstRevision, fixture.firstRevision]);
  });

  test('blocks later physical work after an indeterminate lifecycle receipt', async () => {
    const fixture = lifecycleFixture();
    const first = operation('5');
    const second = operation('6');
    await executeLifecycleBinding(fixture, first, async () => {
      fixture.failObservation();
      return resultFor(first, 'failed');
    });
    let laterCalls = 0;
    const later = await executeLifecycleBinding(fixture, second, async () => {
      laterCalls += 1;
      return resultFor(second, 'succeeded');
    });

    expect(later.outcome).toBe('failed');
    expect(later.error?.code).toBe('repository-lifecycle-failed');
    expect(laterCalls).toBe(0);
    expect(fixture.stagedExpected).toHaveLength(1);
  });
});
