import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AcquisitionSnapshotAuthorityV1,
  acquisitionRevisionPreconditions,
  acquisitionSnapshotArtifactAuthorityV1,
  createAcquisitionArtifactExecutionControllerV1,
  createAcquisitionRepositoryLifecycleControllerV1,
  executeAcquirePlans,
  readAcquisitionSnapshotV1,
  resolveAcquisitionArtifactDestinationV1,
  resolveAcquisitionProjectContextV1,
} from '../../src/acquire/execute.ts';
import { toolRegistry } from '../../src/agents/registry.ts';
import type { ArtifactCoordinatorPorts } from '../../src/artifacts/coordinator-types.ts';
import { hashCanonicalInput, hashManifestSemantics } from '../../src/artifacts/hash.ts';
import {
  type PortableLockV1,
  hashPortableLock,
  serializePortableLock,
} from '../../src/artifacts/lock.ts';
import { editManifestBytes } from '../../src/artifacts/manifest-edit.ts';
import { normalizeManifestDocument, readManifestSource } from '../../src/artifacts/manifest.ts';
import { createTestNodeArtifactCoordinatorPorts } from '../../src/artifacts/node-coordinator.ts';
import type { ResolvedArtifactPair } from '../../src/artifacts/pair.ts';
import { createLockRepository, createManifestRepository } from '../../src/artifacts/repository.ts';
import type { NormalizedManifestV1 } from '../../src/artifacts/types.ts';
import type { ProjectContext } from '../../src/context/types.ts';
import { withExecutionLockHierarchy } from '../../src/execution/lock-hierarchy.ts';
import {
  createExpectedRevisionExecutionPrecondition,
  validateExecutionPreconditions,
} from '../../src/execution/preconditions.ts';
import type { ExecutionPrecondition, PreparedExecutionBinding } from '../../src/execution/types.ts';
import type { PlacementExecutionInput } from '../../src/place/execute.ts';
import { emptyLedgerModel } from '../../src/place/ledger.ts';
import type { PlacementPorts } from '../../src/place/types.ts';
import { createOperationExecutionResult } from '../../src/planning/create.ts';
import type {
  CurrentMutatorOperationPlan,
  ExecutableOperation,
  OperationExecutionResult,
  OperationImage,
} from '../../src/planning/types.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';
import type { RuntimePorts } from '../../src/ports/types.ts';
import { err, ok } from '../../src/result.ts';
import { stageLogicalRepositoryEditV1 } from '../../src/state/repositories.ts';
import {
  type ExpectedRevisionV1,
  createExpectedRevisionV1,
  isExpectedRevisionV1,
} from '../../src/state/types.ts';

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

const expectNoneTypeCorrelation = (
  result: Awaited<ReturnType<typeof resolveAcquisitionArtifactDestinationV1>>,
): void => {
  if (result.outcome !== 'none') throw new Error('expected an acquisition none result');
  if (result.saveMode === 'live-only') {
    const reason: 'no-save' = result.selection.reason;
    expect(reason).toBe('no-save');
    return;
  }
  const reason: 'no-owner' | 'pre-resolution-failure' = result.selection.reason;
  expect(['no-owner', 'pre-resolution-failure']).toContain(reason);
};

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
    expectNoneTypeCorrelation(result);
  });

  test('returns pre-resolution none for empty or duplicate raw resolved names without discovery', async () => {
    for (const names of [[], [''], ['factor-scan', 'factor-scan']] as const) {
      const ports = new DestinationPorts();
      const result = await resolveDestination(ports, { names });
      expect(result).toEqual({
        outcome: 'none',
        saveMode: 'desired-state',
        pair: null,
        selection: { outcome: 'none', reason: 'pre-resolution-failure' },
      });
      expect(ports.calls).toEqual({ pathKind: [], readText: [], realpath: [] });
      expectNoneTypeCorrelation(result);
      expect(() => acquisitionSnapshotArtifactAuthorityV1(result)).toThrow(
        /artifact-free snapshot authority/u,
      );
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
      cause: {
        kind: 'pair',
        code: 'artifact-lockfile-requires-file',
        exitClass: 'usage',
        message: '--lockfile requires an explicit --file selector',
      },
    });
  });

  test('preserves exact nonportable pair failure while keeping the public selection coarse', async () => {
    const foreignFile = 'C:\\portable\\team.toml';
    const result = await resolveDestination(new DestinationPorts(), { file: foreignFile });
    expect(result).toEqual({
      outcome: 'refused',
      saveMode: 'desired-state',
      pair: null,
      selection: {
        outcome: 'refused',
        reason: 'nonportable-path',
        candidates: [foreignFile],
      },
      cause: {
        kind: 'pair',
        code: 'artifact-selector-nonportable',
        exitClass: 'usage',
        message: `artifact selector uses a foreign absolute-path form: ${foreignFile}`,
        paths: [foreignFile],
      },
    });
    if (result.outcome !== 'refused') throw new Error('expected nonportable refusal');
    expect(() => acquisitionSnapshotArtifactAuthorityV1(result)).toThrow(
      /artifact-free snapshot authority/u,
    );
    expect(Object.isFrozen(result.cause)).toBeTrue();
    expect(Object.isFrozen(result.cause.paths)).toBeTrue();
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

    const rootLegacy = await resolveDestination(
      new DestinationPorts({
        [NESTED_MANIFEST]: { kind: 'file', text: manifest(['other']) },
        [PROJECT_MANIFEST]: { kind: 'file', text: 'tool = "codex"\nscope = "project"\n' },
      }),
      {},
      projectContext(NESTED_MANIFEST),
    );
    expect(rootLegacy).toMatchObject({
      outcome: 'selected',
      pair: { file: { path: PROJECT_MANIFEST } },
      selection: { outcome: 'selected', selectedBy: 'legacy-project-migration' },
    });

    const removal = await resolveDestination(
      new DestinationPorts({
        [PROJECT_MANIFEST]: { kind: 'file', text: 'tool = "codex"\nscope = "project"\n' },
      }),
      { mode: 'remove' },
      projectContext(PROJECT_MANIFEST),
    );
    expect(removal).toMatchObject({
      outcome: 'selected',
      pair: { file: { path: PROJECT_MANIFEST } },
      selection: { outcome: 'selected', selectedBy: 'legacy-project-migration' },
    });
  });

  test('fails closed on automatic user legacy while preserving explicit-file precedence', async () => {
    const legacyUser = 'tool = "codex"\nscope = "user"\n';
    const automatic = await resolveDestination(
      new DestinationPorts({ [USER_MANIFEST]: { kind: 'file', text: legacyUser } }),
      { scope: 'user' },
    );
    expect(automatic).toEqual({
      outcome: 'refused',
      saveMode: 'desired-state',
      pair: null,
      selection: {
        outcome: 'refused',
        reason: 'invalid-candidate',
        candidates: [USER_MANIFEST],
      },
      cause: {
        kind: 'discovery',
        code: 'manifest-candidate-invalid',
        exitClass: 'state',
        message: `automatic user manifest candidate cannot use the project-only legacy migration: ${USER_MANIFEST}`,
        paths: [USER_MANIFEST],
      },
    });

    const explicit = await resolveDestination(
      new DestinationPorts({ [USER_MANIFEST]: { kind: 'file', text: legacyUser } }),
      { scope: 'user', file: '../../state/team.toml' },
    );
    expect(explicit).toMatchObject({
      outcome: 'selected',
      pair: { file: { path: '/work/repo/state/team.toml' } },
      selection: { outcome: 'selected', selectedBy: 'explicit-file' },
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
      cause: {
        kind: 'discovery',
        code: 'manifest-owner-ambiguous',
        exitClass: 'usage',
        message: `declaration 'factor-scan' has multiple manifest owners: ${PROJECT_MANIFEST}, ${USER_MANIFEST}`,
        paths: [PROJECT_MANIFEST, USER_MANIFEST],
      },
    });
    if (ambiguous.outcome !== 'refused') throw new Error('expected ambiguous refusal');
    expect(Object.isFrozen(ambiguous)).toBeTrue();
    expect(Object.isFrozen(ambiguous.selection)).toBeTrue();
    expect(Object.isFrozen(ambiguous.cause)).toBeTrue();
    expect(Object.isFrozen(ambiguous.cause.paths)).toBeTrue();
    const mutableCandidates: string[] = ambiguous.selection.candidates;
    expect(Object.isFrozen(mutableCandidates)).toBeFalse();
    mutableCandidates.push('/work/extra-owner.toml');
    expect(ambiguous.selection.candidates).toHaveLength(3);

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

describe('acquisition snapshot artifact authority', () => {
  test('observes an exact non-sibling pair and omits artifact-free state deterministically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-acquire-snapshot-'));
    try {
      const base = await defaultRuntimePorts();
      const xdg = {
        config: join(root, 'config'),
        data: join(root, 'data'),
        cache: join(root, 'cache'),
      };
      const cwd = join(root, 'work');
      const manifestPath = join(root, 'portable', 'team.toml');
      const lockPath = join(root, 'locks', 'team.state.lock');
      const siblingLockPath = join(root, 'portable', 'team.lock');
      const ledgerPath = join(root, 'data', 'placements.json');
      await Promise.all([
        mkdir(cwd, { recursive: true }),
        mkdir(join(root, 'portable'), { recursive: true }),
        mkdir(join(root, 'locks'), { recursive: true }),
        mkdir(xdg.config, { recursive: true }),
        mkdir(xdg.data, { recursive: true }),
        mkdir(xdg.cache, { recursive: true }),
      ]);
      const artifactPaths = new Set([
        manifestPath,
        lockPath,
        siblingLockPath,
        join(cwd, 'skillsmith.toml'),
        join(cwd, 'skillsmith.lock'),
        join(xdg.config, 'skillsmith', 'skillsmith.toml'),
        join(xdg.config, 'skillsmith', 'skillsmith.lock'),
      ]);
      const artifactTouches: string[] = [];
      const count = (path: string): void => {
        if (artifactPaths.has(path)) artifactTouches.push(path);
      };
      const env: RuntimePorts = {
        ...base,
        xdg,
        pathKind: async (path) => {
          count(path);
          return base.pathKind(path);
        },
        realpath: async (path) => {
          count(path);
          return base.realpath(path);
        },
        readBytes: async (path) => {
          count(path);
          return base.readBytes(path);
        },
        readFileMetadata: async (path) => {
          count(path);
          return base.readFileMetadata(path);
        },
      };
      const context = await resolveAcquisitionProjectContextV1({ env, cwd });
      const selectedResolution = await resolveAcquisitionArtifactDestinationV1({
        ports: env,
        projectContext: context,
        names: ['alpha'],
        scope: 'project',
        mode: 'remove',
        file: manifestPath,
        lockfile: lockPath,
      });
      if (selectedResolution.outcome !== 'selected') throw new Error('expected selected pair');
      artifactTouches.length = 0;
      const common = {
        env,
        registry: toolRegistry,
        capabilityQueries: [],
        projectContext: context,
        ledgerPath,
        liveResources: [
          {
            resourceId: 'live:zeta',
            skill: 'zeta',
            tool: 'codex' as const,
            scope: 'project' as const,
            projectIdentity: context.projectIdentity,
            placementPath: join(root, 'live', 'zeta'),
            storeRoot: join(root, 'store'),
          },
          {
            resourceId: 'live:alpha',
            skill: 'alpha',
            tool: 'codex' as const,
            scope: 'project' as const,
            projectIdentity: context.projectIdentity,
            placementPath: join(root, 'live', 'alpha'),
            storeRoot: join(root, 'store'),
          },
        ],
        storeResources: [
          {
            resource: { resourceId: 'store:zeta', storePath: join(root, 'store', 'zeta') },
            contentHash: `sha256:${'a'.repeat(64)}` as const,
          },
          {
            resource: { resourceId: 'store:alpha', storePath: join(root, 'store', 'alpha') },
            contentHash: `sha256:${'b'.repeat(64)}` as const,
          },
        ],
      };
      const selected = await readAcquisitionSnapshotV1({
        ...common,
        artifact: acquisitionSnapshotArtifactAuthorityV1(selectedResolution),
      });
      expect(selected.snapshot.artifact.mode).toBe('selected');
      if (selected.snapshot.artifact.mode !== 'selected') throw new Error('missing selected pair');
      expect(selected.snapshot.artifact.pair).toBe(selectedResolution.pair);
      const manifestRevision = selected.snapshot.artifact.manifest.revision;
      const lockRevision = selected.snapshot.artifact.lock.revision;
      if (manifestRevision.domain !== 'manifest' || lockRevision.domain !== 'lock') {
        throw new Error('artifact revision domains are incoherent');
      }
      expect(manifestRevision.targetIdentity).toBe(manifestPath);
      expect(lockRevision.targetIdentity).toBe(lockPath);
      const selectedAgain = await readAcquisitionSnapshotV1({
        ...common,
        artifact: acquisitionSnapshotArtifactAuthorityV1(selectedResolution),
      });
      expect(selected.snapshot.snapshotId).toBe(selectedAgain.snapshot.snapshotId);
      expect(artifactTouches).toContain(manifestPath);
      expect(artifactTouches).toContain(lockPath);
      expect(artifactTouches).not.toContain(siblingLockPath);
      const resources = acquisitionRevisionPreconditions(selected, [operation('f')]).map(
        ({ resource }) => resource,
      );
      expect(resources).toContainEqual({
        kind: 'manifest-bytes',
        location: { kind: 'machine-bound', path: manifestPath },
      });
      expect(resources).toContainEqual({
        kind: 'lock',
        location: { kind: 'machine-bound', path: lockPath },
      });

      const noneResolution = await resolveAcquisitionArtifactDestinationV1({
        ports: env,
        projectContext: context,
        names: ['alpha'],
        scope: 'project',
        mode: 'remove',
      });
      if (noneResolution.outcome !== 'none') throw new Error('expected owner-free authority');
      artifactTouches.length = 0;
      const none = await readAcquisitionSnapshotV1({
        ...common,
        artifact: acquisitionSnapshotArtifactAuthorityV1(noneResolution),
      });
      const reversed = await readAcquisitionSnapshotV1({
        ...common,
        artifact: acquisitionSnapshotArtifactAuthorityV1(noneResolution),
        liveResources: [...common.liveResources].reverse(),
        storeResources: [...common.storeResources].reverse(),
      });
      const noSaveResolution = await resolveAcquisitionArtifactDestinationV1({
        ports: env,
        projectContext: context,
        names: ['alpha'],
        scope: 'project',
        mode: 'remove',
        noSave: true,
        file: manifestPath,
        lockfile: lockPath,
      });
      if (noSaveResolution.outcome !== 'none') throw new Error('expected no-save authority');
      const noSave = await readAcquisitionSnapshotV1({
        ...common,
        artifact: acquisitionSnapshotArtifactAuthorityV1(noSaveResolution),
      });
      expect(none.snapshot.artifact).toEqual({ mode: 'none' });
      expect(none.repositories.artifact).toEqual({ mode: 'none' });
      expect(none.snapshot.snapshotId).toBe(reversed.snapshot.snapshotId);
      expect(none.snapshot.snapshotId).toBe(noSave.snapshot.snapshotId);
      expect(noSave.snapshot.artifact).toEqual({ mode: 'none' });
      expect(none.snapshot.snapshotId).not.toBe(selected.snapshot.snapshotId);
      expect(artifactTouches).toEqual([]);
      expect(
        acquisitionRevisionPreconditions(none, [operation('e')]).some(
          ({ expected }) =>
            (expected as ExpectedRevisionV1).domain === 'manifest' ||
            (expected as ExpectedRevisionV1).domain === 'lock',
        ),
      ).toBeFalse();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

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

const executionPair = (manifestPath: string, lockPath: string): ResolvedArtifactPair =>
  Object.freeze({
    file: Object.freeze({
      token: null,
      path: manifestPath,
      portability: 'machine-bound' as const,
      portableToken: null,
    }),
    lockfile: Object.freeze({
      token: null,
      path: lockPath,
      portability: 'machine-bound' as const,
      portableToken: null,
    }),
    lockfileSource: 'explicit' as const,
  });

const manifestSnapshotForExecution = (
  value: NormalizedManifestV1,
): Extract<OperationImage, { kind: 'manifest' }>['value'] => ({
  version: 1,
  defaults:
    value.defaults === undefined
      ? null
      : {
          tools: value.defaults.tools ?? null,
          scope: value.defaults.scope ?? null,
          path: value.defaults.path ?? null,
        },
  registry: value.registry === undefined ? null : { default: value.registry.default ?? null },
  skills: value.skills,
});

const manifestImageForExecution = (
  path: string,
  bytes: Uint8Array,
): Extract<OperationImage, { kind: 'manifest' }> => {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const document = readManifestSource(source);
  if (!document.ok) throw new Error('fixture manifest is unreadable');
  const normalized = normalizeManifestDocument(document.value);
  if (!normalized.ok) throw new Error('fixture manifest is not normalizable');
  const byteHash = hashCanonicalInput('resource', 1, bytes);
  if (!byteHash.ok) throw new Error('fixture manifest byte hash failed');
  return Object.freeze({
    kind: 'manifest' as const,
    location: Object.freeze({ kind: 'machine-bound' as const, path }),
    shape: document.value.shape,
    version: 1 as const,
    byteHash: byteHash.value as Extract<OperationImage, { kind: 'manifest' }>['byteHash'],
    semanticHash: hashManifestSemantics(normalized.value) as Extract<
      OperationImage,
      { kind: 'manifest' }
    >['semanticHash'],
    value: manifestSnapshotForExecution(normalized.value),
  });
};

const lockImageForExecution = (
  path: string,
  lock: PortableLockV1,
): Extract<OperationImage, { kind: 'lock' }> => {
  const canonicalHash = hashPortableLock(lock);
  if (!canonicalHash.ok) throw new Error('fixture lock hash failed');
  const value = structuredClone(lock);
  return Object.freeze({
    kind: 'lock' as const,
    location: Object.freeze({ kind: 'machine-bound' as const, path }),
    version: 1 as const,
    canonicalHash: canonicalHash.value as Extract<
      OperationImage,
      { kind: 'lock' }
    >['canonicalHash'],
    value: value as unknown as Extract<OperationImage, { kind: 'lock' }>['value'],
  });
};

const absentArtifactImage = (
  role: 'manifest' | 'lock',
  path: string,
): Extract<OperationImage, { kind: 'absent' }> =>
  Object.freeze({
    kind: 'absent' as const,
    resource: Object.freeze({
      kind: role === 'manifest' ? ('manifest-bytes' as const) : ('lock' as const),
      location: Object.freeze({ kind: 'machine-bound' as const, path }),
    }),
  });

const artifactOperationForExecution = (input: {
  marker: string;
  groupMarker: string;
  kind: 'migrate-project-config' | 'write-manifest' | 'write-lock';
  before: OperationImage;
  after: OperationImage;
  dependencies?: readonly string[];
}): ExecutableOperation => ({
  operationId: `operation:v1:${input.marker.repeat(64).slice(0, 64)}`,
  groupId: `group:v1:${input.groupMarker.repeat(64).slice(0, 64)}`,
  pairId: null,
  kind: input.kind,
  dependencyMetadata: {
    domain: 'skillsmith.operation-dependency',
    schemaVersion: 1,
    operationIds: input.dependencies ?? [],
  },
  skill: null,
  source: null,
  tool: null,
  scope: null,
  before: input.before,
  after: input.after,
  reason: { code: 'fixture', message: 'fixture' },
  selectionSource: 'explicit-targets',
  preconditionIds: [],
  requiredCheckIds: [],
  reversibility: { kind: 'none', retentionResourceIds: [] },
  mutates:
    input.kind === 'write-lock'
      ? { live: false, manifest: false, lock: true, ledger: false }
      : { live: false, manifest: true, lock: false, ledger: false },
  conflict: null,
});

const selectedExecutionAuthority = async (
  runtime: RuntimePorts,
  pair: ResolvedArtifactPair,
): Promise<AcquisitionSnapshotAuthorityV1> => {
  const manifestRepository = createManifestRepository({
    resourceId: 'manifest:execution-fixture',
    path: pair.file.path,
    ports: runtime,
  });
  const lockRepository = createLockRepository({
    resourceId: 'lock:execution-fixture',
    path: pair.lockfile.path,
    ports: runtime,
  });
  const manifest = await manifestRepository.observe('manifest:execution-fixture');
  const lock = await lockRepository.observe('lock:execution-fixture');
  if (!manifest.ok || !lock.ok) throw new Error('fixture artifact observation failed');
  return {
    snapshot: {
      artifact: Object.freeze({
        mode: 'selected' as const,
        pair,
        manifest: manifest.value,
        lock: lock.value,
      }),
    },
    repositories: {
      artifact: Object.freeze({
        mode: 'selected' as const,
        manifest: manifestRepository,
        lock: lockRepository,
      }),
    },
  } as unknown as AcquisitionSnapshotAuthorityV1;
};

const executePreparedArtifactBinding = (
  binding: PreparedExecutionBinding,
  operation: ExecutableOperation,
) =>
  binding.execute({
    operationId: operation.operationId,
    groupId: operation.groupId,
    pairId: operation.pairId,
    actualBefore: operation.before,
    unstartedForce: null,
    execute: async () => {
      throw new Error('fixture validated binding must not be re-entered');
    },
  });

const artifactPreconditionForExecution = (
  authority: AcquisitionSnapshotAuthorityV1,
  role: 'manifest' | 'lock',
  operationId: string,
  trace?: string[],
): ExecutionPrecondition => {
  const artifact = authority.snapshot.artifact;
  const repositories = authority.repositories.artifact;
  if (artifact.mode !== 'selected' || repositories.mode !== 'selected') {
    throw new Error('fixture selected authority is missing');
  }
  const component = role === 'manifest' ? artifact.manifest : artifact.lock;
  const path = role === 'manifest' ? artifact.pair.file.path : artifact.pair.lockfile.path;
  const repository = role === 'manifest' ? repositories.manifest : repositories.lock;
  return createExpectedRevisionExecutionPrecondition({
    operationIds: [operationId],
    resource: Object.freeze({
      kind: role === 'manifest' ? ('manifest-bytes' as const) : ('lock' as const),
      location: Object.freeze({ kind: 'machine-bound' as const, path }),
    }),
    expectedRevision: component.revision,
    observeRevision: async () => {
      trace?.push(`precondition:${role}`);
      const observed = await repository.observeRevision(component.revision.resourceId);
      if (!observed.ok) throw observed.error;
      return observed.value;
    },
  });
};

const artifactPreconditionPlan = (
  operations: readonly ExecutableOperation[],
  preconditions: readonly ExecutionPrecondition[],
): CurrentMutatorOperationPlan =>
  Object.freeze({
    domain: 'skillsmith.operation-plan' as const,
    schemaVersion: 1 as const,
    command: 'install' as const,
    selection: Object.freeze({
      source: 'explicit-targets' as const,
      tools: Object.freeze([]),
      scopes: Object.freeze([]),
    }),
    batchPolicy: 'fail-fast' as const,
    operations: Object.freeze(
      operations.map((operation) =>
        Object.freeze({
          ...operation,
          preconditionIds: Object.freeze(
            preconditions
              .filter((precondition) => precondition.operationIds.includes(operation.operationId))
              .map(({ preconditionId }) => preconditionId),
          ),
        }),
      ),
    ),
    checks: Object.freeze([]),
    diagnostics: Object.freeze([]),
  });

const executionControllerFixture = async (label: string) => {
  const root = await mkdtemp(join(tmpdir(), `skillsmith-acquire-controller-${label}-`));
  const runtime = await defaultRuntimePorts();
  const pair = executionPair(join(root, 'skillsmith.toml'), join(root, 'skillsmith.lock'));
  const authority = await selectedExecutionAuthority(runtime, pair);
  const delegate = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
  const acquisitions: Array<Readonly<{ policy: 'central' | 'compatibility'; target: string }>> = [];
  const withFileLock: ArtifactCoordinatorPorts['withFileLock'] = async (
    target,
    options,
    operation,
  ) => {
    acquisitions.push(Object.freeze({ policy: options.policy, target }));
    return delegate.withFileLock(target, options, operation);
  };
  const artifactCoordinator: ArtifactCoordinatorPorts = Object.freeze({
    ...delegate,
    withFileLock,
  });
  const ledgerPath = join(root, 'placements.json');
  const ledgerLocks: string[] = [];
  const controller = createAcquisitionArtifactExecutionControllerV1({
    authority,
    artifactCoordinator,
    ledgerPath,
    ledgerLockPort: Object.freeze({
      withFileLock: async <T>(path: string, operation: () => Promise<T>): Promise<T> => {
        ledgerLocks.push(path);
        return operation();
      },
    }),
  });
  return {
    root,
    runtime,
    pair,
    authority,
    artifactCoordinator,
    controller,
    acquisitions,
    ledgerLocks,
  };
};

const missingParentExecutionFixture = async (label: string) => {
  const root = await mkdtemp(join(tmpdir(), `skillsmith-acquire-scaffold-${label}-`));
  const runtime = await defaultRuntimePorts();
  const pair = executionPair(
    join(root, 'portable', 'nested', 'skillsmith.toml'),
    join(root, 'generated', 'nested', 'skillsmith.lock'),
  );
  const authority = await selectedExecutionAuthority(runtime, pair);
  const delegate = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
  const trace: string[] = [];
  const withFileLock: ArtifactCoordinatorPorts['withFileLock'] = async (
    target,
    options,
    operation,
  ) => {
    trace.push(`lock:${options.policy}:${target}`);
    try {
      return await delegate.withFileLock(target, options, operation);
    } finally {
      trace.push(`release:${options.policy}:${target}`);
    }
  };
  const artifactCoordinator: ArtifactCoordinatorPorts = Object.freeze({
    ...delegate,
    withFileLock,
    makeDirectoryExclusive: async (path: string, mode: 0o700) => {
      trace.push(`scaffold:${path}`);
      return delegate.makeDirectoryExclusive(path, mode);
    },
    removeEmptyDirectory: async (path: string) => {
      trace.push(`cleanup:${path}`);
      return delegate.removeEmptyDirectory(path);
    },
  });
  const ledgerPath = join(root, 'placements.json');
  const controller = createAcquisitionArtifactExecutionControllerV1({
    authority,
    artifactCoordinator,
    ledgerPath,
    ledgerLockPort: Object.freeze({
      withFileLock: async <T>(path: string, operation: () => Promise<T>): Promise<T> => {
        trace.push(`ledger:${path}`);
        return operation();
      },
    }),
  });
  return { root, runtime, pair, authority, artifactCoordinator, controller, trace };
};

describe('selected acquisition artifact execution controller', () => {
  test('refuses equality, ancestor, and sidecar-ancestor topology across all descriptors', async () => {
    const topologies = [
      {
        label: 'member-ancestor',
        manifest: 'portable',
        lock: 'portable/state.lock',
        ledger: 'placements.json',
      },
      {
        label: 'member-sidecar-equal',
        manifest: 'portable',
        lock: 'portable.lock',
        ledger: 'placements.json',
      },
      {
        label: 'member-sidecar-ancestor',
        manifest: 'portable',
        lock: 'portable.lock/state',
        ledger: 'placements.json',
      },
      {
        label: 'ledger-equal',
        manifest: 'portable.toml',
        lock: 'portable.lockfile',
        ledger: 'portable.toml',
      },
      {
        label: 'ledger-ancestor',
        manifest: 'state/portable.toml',
        lock: 'portable.lockfile',
        ledger: 'state',
      },
      {
        label: 'ledger-sidecar-ancestor',
        manifest: 'state.lock/portable.toml',
        lock: 'portable.lockfile',
        ledger: 'state',
      },
      {
        label: 'group-ancestor',
        manifest: 'coordination/global/portable.toml',
        lock: 'portable.lockfile',
        ledger: 'placements.json',
      },
      {
        label: 'group-sidecar-ancestor',
        manifest: 'coordination/global.lock/portable.toml',
        lock: 'portable.lockfile',
        ledger: 'placements.json',
      },
    ] as const;
    for (const topology of topologies) {
      const root = await mkdtemp(
        join(tmpdir(), `skillsmith-acquire-controller-${topology.label}-`),
      );
      try {
        const runtime = await defaultRuntimePorts();
        const artifactCoordinator = await createTestNodeArtifactCoordinatorPorts(
          join(root, 'coordination'),
        );
        const manifestPath = join(root, topology.manifest);
        const lockPath = join(root, topology.lock);
        const ledgerPath = join(root, topology.ledger);
        const pair = executionPair(manifestPath, lockPath);
        const authority = await selectedExecutionAuthority(runtime, pair);
        let ledgerLocks = 0;
        expect(() =>
          createAcquisitionArtifactExecutionControllerV1({
            authority,
            artifactCoordinator,
            ledgerPath,
            ledgerLockPort: Object.freeze({
              withFileLock: async <T>(_path: string, operation: () => Promise<T>): Promise<T> => {
                ledgerLocks += 1;
                return operation();
              },
            }),
          }),
        ).toThrow('artifact execution descriptor topology is unsafe');
        expect(ledgerLocks).toBe(0);
        expect(await runtime.pathKind(manifestPath)).toBe('absent');
        expect(await runtime.pathKind(lockPath)).toBe('absent');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  test('rejects virtual artifact members presented outside descriptor order', async () => {
    const fixture = await executionControllerFixture('member-order');
    try {
      const group = fixture.controller.locks.find(({ rank }) => rank === 'artifact-group');
      const members = fixture.controller.locks.filter(({ rank }) => rank === 'artifact-member');
      if (group === undefined || members.length !== 2) throw new Error('fixture locks are invalid');
      await expect(
        fixture.controller.lockPort.withFileLock(group.path, () =>
          fixture.controller.lockPort.withFileLock(
            (members[1] as (typeof members)[number]).path,
            async () => undefined,
          ),
        ),
      ).rejects.toThrow();
      expect(fixture.acquisitions.filter(({ policy }) => policy === 'central')).toHaveLength(1);
      expect(fixture.acquisitions.filter(({ policy }) => policy === 'compatibility')).toEqual([]);
      expect(fixture.ledgerLocks).toEqual([]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test('normalizes only authenticated missing-parent self-change before exact pair commits', async () => {
    const fixture = await missingParentExecutionFixture('commit');
    try {
      const manifestBytes = new TextEncoder().encode('version = 1\nskills = []\n');
      const manifestAfter = manifestImageForExecution(fixture.pair.file.path, manifestBytes);
      const targetLock: PortableLockV1 = Object.freeze({
        version: 1,
        hashSchemaVersion: 1,
        manifestHash: manifestAfter.semanticHash as PortableLockV1['manifestHash'],
        skills: Object.freeze([]),
      });
      const lockAfter = lockImageForExecution(fixture.pair.lockfile.path, targetLock);
      const manifestOperation = artifactOperationForExecution({
        marker: '3',
        groupMarker: '3',
        kind: 'write-manifest',
        before: absentArtifactImage('manifest', fixture.pair.file.path),
        after: manifestAfter,
      });
      const lockOperation = artifactOperationForExecution({
        marker: '4',
        groupMarker: '3',
        kind: 'write-lock',
        before: absentArtifactImage('lock', fixture.pair.lockfile.path),
        after: lockAfter,
        dependencies: [manifestOperation.operationId],
      });
      const manifestBinding = fixture.controller.bind(manifestOperation, {
        role: 'manifest',
        action: { kind: 'replace', bytes: manifestBytes },
      });
      const lockBinding = fixture.controller.bind(lockOperation, {
        role: 'lock',
        action: { kind: 'replace', lock: targetLock },
      });
      const rawPreconditions = [
        artifactPreconditionForExecution(
          fixture.authority,
          'manifest',
          manifestOperation.operationId,
          fixture.trace,
        ),
        artifactPreconditionForExecution(
          fixture.authority,
          'lock',
          lockOperation.operationId,
          fixture.trace,
        ),
      ];
      const preconditions = fixture.controller.bindPreconditions(rawPreconditions);
      const preconditionPlan = artifactPreconditionPlan(
        [manifestOperation, lockOperation],
        preconditions,
      );

      const results = await withExecutionLockHierarchy(
        fixture.controller.lockPort,
        fixture.controller.locks,
        async () => {
          const physical = await rawPreconditions[0]?.observe();
          expect(physical).not.toEqual(rawPreconditions[0]?.expected);
          expect(physical).toMatchObject({ state: 'absent', parentKind: 'directory' });
          await expect(
            validateExecutionPreconditions(preconditionPlan, preconditions),
          ).resolves.toBeUndefined();
          return [
            await executePreparedArtifactBinding(manifestBinding, manifestOperation),
            await executePreparedArtifactBinding(lockBinding, lockOperation),
          ];
        },
      );

      expect(results.map(({ outcome }) => outcome)).toEqual(['succeeded', 'succeeded']);
      expect(await readFile(fixture.pair.file.path)).toEqual(Buffer.from(manifestBytes));
      const serializedLock = serializePortableLock(targetLock);
      if (!serializedLock.ok) throw new Error('fixture lock serialization failed');
      expect(await readFile(fixture.pair.lockfile.path, 'utf8')).toBe(serializedLock.value);
      expect(await fixture.artifactCoordinator.recovery.discover()).toEqual([]);
      const central = fixture.trace.findIndex((entry) => entry.startsWith('lock:central:'));
      const scaffold = fixture.trace.findIndex((entry) => entry.startsWith('scaffold:'));
      const member = fixture.trace.findIndex((entry) => entry.startsWith('lock:compatibility:'));
      const ledger = fixture.trace.findIndex((entry) => entry.startsWith('ledger:'));
      const precondition = fixture.trace.findIndex((entry) => entry.startsWith('precondition:'));
      expect(central).toBeGreaterThanOrEqual(0);
      expect(scaffold).toBeGreaterThan(central);
      expect(member).toBeGreaterThan(scaffold);
      expect(ledger).toBeGreaterThan(member);
      expect(precondition).toBeGreaterThan(ledger);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test('cleans unconsumed scaffolds after member release and refuses metadata-tampered equivalence', async () => {
    const fixture = await missingParentExecutionFixture('refusal');
    try {
      const raw = artifactPreconditionForExecution(
        fixture.authority,
        'manifest',
        `operation:v1:${'5'.repeat(64)}`,
      );
      if (!isExpectedRevisionV1(raw.expected) || raw.expected.state !== 'absent') {
        throw new Error('fixture expected revision is invalid');
      }
      const {
        absenceDigest: _absenceDigest,
        revisionDigest: _revisionDigest,
        ...facts
      } = raw.expected;
      const tampered = createExpectedRevisionV1({
        ...facts,
        parentKind: 'directory',
        parentMetadataIdentity: `metadata:v1:${'f'.repeat(64)}`,
      });
      if (!tampered.ok) throw new Error('fixture tampered revision is invalid');
      const [precondition] = fixture.controller.bindPreconditions([
        Object.freeze({ ...raw, observe: async () => tampered.value }),
      ]);
      if (precondition === undefined) throw new Error('fixture precondition is missing');
      const preconditionPlan = artifactPreconditionPlan(
        [
          artifactOperationForExecution({
            marker: '5',
            groupMarker: '5',
            kind: 'write-manifest',
            before: absentArtifactImage('manifest', fixture.pair.file.path),
            after: manifestImageForExecution(
              fixture.pair.file.path,
              new TextEncoder().encode('version = 1\nskills = []\n'),
            ),
          }),
        ],
        [precondition],
      );

      await withExecutionLockHierarchy(
        fixture.controller.lockPort,
        fixture.controller.locks,
        async () => {
          await expect(
            validateExecutionPreconditions(preconditionPlan, [precondition]),
          ).rejects.toMatchObject({ code: 'precondition-state-changed' });
        },
      );

      expect(await fixture.runtime.pathKind(join(fixture.root, 'portable'))).toBe('absent');
      expect(await fixture.runtime.pathKind(join(fixture.root, 'generated'))).toBe('absent');
      expect(await fixture.runtime.pathKind(fixture.pair.file.path)).toBe('absent');
      expect(await fixture.runtime.pathKind(fixture.pair.lockfile.path)).toBe('absent');
      const lastMemberRelease = fixture.trace.reduce(
        (last, entry, index) => (entry.startsWith('release:compatibility:') ? index : last),
        -1,
      );
      const firstCleanup = fixture.trace.findIndex((entry) => entry.startsWith('cleanup:'));
      expect(lastMemberRelease).toBeGreaterThanOrEqual(0);
      expect(firstCleanup).toBeGreaterThan(lastMemberRelease);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test('commits manifest then lock under one exact group/member/ledger hierarchy', async () => {
    const fixture = await executionControllerFixture('sequential');
    try {
      const manifestBytes = new TextEncoder().encode(manifest(['alpha']));
      const manifestAfter = manifestImageForExecution(fixture.pair.file.path, manifestBytes);
      const contentHash = hashCanonicalInput('source-content', 1, 'alpha content');
      if (!contentHash.ok) throw new Error('fixture content hash failed');
      const mutableLockSkill = {
        name: 'alpha',
        source: 'github.com/acme/skills//alpha',
        requestedRef: null,
        resolvedSha: '3f2a1b9c0d4e5f6a7b8c9d0e1f2a3b4c5d6e7f80',
        sourcePath: 'alpha',
        contentHash: contentHash.value,
      };
      const targetLock: PortableLockV1 = {
        version: 1,
        hashSchemaVersion: 1,
        manifestHash: manifestAfter.semanticHash as PortableLockV1['manifestHash'],
        skills: [mutableLockSkill],
      };
      const lockAfter = lockImageForExecution(fixture.pair.lockfile.path, targetLock);
      const manifestOperation = artifactOperationForExecution({
        marker: 'a',
        groupMarker: 'a',
        kind: 'write-manifest',
        before: absentArtifactImage('manifest', fixture.pair.file.path),
        after: manifestAfter,
      });
      const lockOperation = artifactOperationForExecution({
        marker: 'b',
        groupMarker: 'a',
        kind: 'write-lock',
        before: absentArtifactImage('lock', fixture.pair.lockfile.path),
        after: lockAfter,
        dependencies: [manifestOperation.operationId],
      });
      const manifestBinding = fixture.controller.bind(manifestOperation, {
        role: 'manifest',
        action: { kind: 'replace', bytes: manifestBytes },
      });
      const expectedManifestBytes = new Uint8Array(manifestBytes);
      manifestBytes[0] = 0;
      const lockBinding = fixture.controller.bind(lockOperation, {
        role: 'lock',
        action: { kind: 'replace', lock: targetLock },
      });
      const serializedLock = serializePortableLock(targetLock);
      if (!serializedLock.ok) throw new Error('fixture lock serialization failed');
      mutableLockSkill.resolvedSha = '0'.repeat(40);

      const results = await withExecutionLockHierarchy(
        fixture.controller.lockPort,
        fixture.controller.locks,
        async () => [
          await executePreparedArtifactBinding(manifestBinding, manifestOperation),
          await executePreparedArtifactBinding(lockBinding, lockOperation),
        ],
      );

      expect(results.map(({ outcome }) => outcome)).toEqual(['succeeded', 'succeeded']);
      expect(fixture.controller.locks).toEqual([
        {
          rank: 'artifact-group' as const,
          key: 'artifact-group',
          path: join(fixture.artifactCoordinator.coordinationRoot, 'global'),
        },
        ...[fixture.pair.file.path, fixture.pair.lockfile.path].sort().map((path, index) => ({
          rank: 'artifact-member' as const,
          key: `artifact-member:${index}`,
          path,
        })),
        {
          rank: 'ledger' as const,
          key: 'placements-ledger',
          path: join(fixture.root, 'placements.json'),
        },
      ]);
      expect(fixture.acquisitions.filter(({ policy }) => policy === 'central')).toHaveLength(1);
      expect(fixture.acquisitions.filter(({ policy }) => policy === 'compatibility')).toEqual(
        [fixture.pair.file.path, fixture.pair.lockfile.path]
          .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
          .map((target) => ({ policy: 'compatibility', target })),
      );
      expect(fixture.ledgerLocks).toEqual([join(fixture.root, 'placements.json')]);
      expect(await readFile(fixture.pair.file.path)).toEqual(Buffer.from(expectedManifestBytes));
      expect(await readFile(fixture.pair.lockfile.path, 'utf8')).toBe(serializedLock.value);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test('rejects action-after, state-gap, and same-group dependency mismatches before writes', async () => {
    const fixture = await executionControllerFixture('bind-refusal');
    try {
      const firstBytes = new TextEncoder().encode(manifest(['alpha']));
      const firstAfter = manifestImageForExecution(fixture.pair.file.path, firstBytes);
      const wrongBytes = new TextEncoder().encode(`${manifest(['alpha'])}# wrong\n`);
      const first = artifactOperationForExecution({
        marker: 'c',
        groupMarker: 'c',
        kind: 'write-manifest',
        before: absentArtifactImage('manifest', fixture.pair.file.path),
        after: firstAfter,
      });
      expect(() =>
        fixture.controller.bind(first, {
          role: 'manifest',
          action: { kind: 'replace', bytes: wrongBytes },
        }),
      ).toThrow('manifest replacement differs from planned after image');

      const boundFirst = fixture.controller.bind(first, {
        role: 'manifest',
        action: { kind: 'replace', bytes: firstBytes },
      });
      expect(boundFirst.operationId).toBe(first.operationId);
      const gap = artifactOperationForExecution({
        marker: 'd',
        groupMarker: 'd',
        kind: 'write-manifest',
        before: absentArtifactImage('manifest', fixture.pair.file.path),
        after: firstAfter,
      });
      expect(() =>
        fixture.controller.bind(gap, {
          role: 'manifest',
          action: { kind: 'replace', bytes: firstBytes },
        }),
      ).toThrow('artifact operation chain has a state gap');

      const editRequest = {
        edits: [{ kind: 'set-default' as const, field: 'scope' as const, value: 'user' as const }],
      };
      const edited = editManifestBytes(firstBytes, editRequest);
      if (!edited.ok) throw new Error('fixture manifest edit failed');
      const missingDependency = artifactOperationForExecution({
        marker: 'e',
        groupMarker: 'c',
        kind: 'write-manifest',
        before: firstAfter,
        after: manifestImageForExecution(fixture.pair.file.path, edited.value.bytes),
      });
      expect(() =>
        fixture.controller.bind(missingDependency, {
          role: 'manifest',
          action: { kind: 'edit', request: editRequest },
        }),
      ).toThrow('same-group artifact chain lacks a direct dependency');

      const lockTarget: PortableLockV1 = Object.freeze({
        version: 1,
        hashSchemaVersion: 1,
        manifestHash: firstAfter.semanticHash as PortableLockV1['manifestHash'],
        skills: Object.freeze([]),
      });
      const lockOperation = artifactOperationForExecution({
        marker: '7',
        groupMarker: 'c',
        kind: 'write-lock',
        before: absentArtifactImage('lock', fixture.pair.lockfile.path),
        after: lockImageForExecution(fixture.pair.lockfile.path, lockTarget),
        dependencies: [first.operationId],
      });
      const opaqueRevision = hashCanonicalInput('resource', 1, 'opaque lock bytes');
      if (!opaqueRevision.ok) throw new Error('fixture opaque revision failed');
      expect(() =>
        fixture.controller.bind(lockOperation, {
          role: 'lock',
          action: {
            kind: 'replace-invalid',
            lock: lockTarget,
            expectedByteRevision: opaqueRevision.value,
          },
        }),
      ).toThrow('doctor-only lock action is not allowed');
      expect(fixture.acquisitions).toEqual([]);
      expect(fixture.ledgerLocks).toEqual([]);
      expect(await fixture.runtime.pathKind(fixture.pair.file.path)).toBe('absent');
      expect(await fixture.runtime.pathKind(fixture.pair.lockfile.path)).toBe('absent');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test('fails closed when initial physical state changes after the snapshot', async () => {
    const fixture = await executionControllerFixture('initial-change');
    try {
      const plannedBytes = new TextEncoder().encode('version = 1\nskills = []\n');
      const operation = artifactOperationForExecution({
        marker: 'f',
        groupMarker: 'f',
        kind: 'write-manifest',
        before: absentArtifactImage('manifest', fixture.pair.file.path),
        after: manifestImageForExecution(fixture.pair.file.path, plannedBytes),
      });
      const binding = fixture.controller.bind(operation, {
        role: 'manifest',
        action: { kind: 'replace', bytes: plannedBytes },
      });
      const externalBytes = 'version = 1\nskills = []\n# external\n';
      await writeFile(fixture.pair.file.path, externalBytes);

      await expect(
        withExecutionLockHierarchy(fixture.controller.lockPort, fixture.controller.locks, () =>
          executePreparedArtifactBinding(binding, operation),
        ),
      ).rejects.toThrow();
      expect(await readFile(fixture.pair.file.path, 'utf8')).toBe(externalBytes);
      expect(await fixture.runtime.pathKind(fixture.pair.lockfile.path)).toBe('absent');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test('does not advance a chained manifest write across an intervening raw edit', async () => {
    const fixture = await executionControllerFixture('between-step-change');
    try {
      const firstBytes = new TextEncoder().encode(manifest(['alpha']));
      const firstAfter = manifestImageForExecution(fixture.pair.file.path, firstBytes);
      const editRequest = {
        edits: [{ kind: 'set-default' as const, field: 'scope' as const, value: 'user' as const }],
      };
      const edited = editManifestBytes(firstBytes, editRequest);
      if (!edited.ok) throw new Error('fixture manifest edit failed');
      const first = artifactOperationForExecution({
        marker: '1',
        groupMarker: '1',
        kind: 'write-manifest',
        before: absentArtifactImage('manifest', fixture.pair.file.path),
        after: firstAfter,
      });
      const second = artifactOperationForExecution({
        marker: '2',
        groupMarker: '2',
        kind: 'write-manifest',
        before: firstAfter,
        after: manifestImageForExecution(fixture.pair.file.path, edited.value.bytes),
      });
      const firstBinding = fixture.controller.bind(first, {
        role: 'manifest',
        action: { kind: 'replace', bytes: firstBytes },
      });
      const secondBinding = fixture.controller.bind(second, {
        role: 'manifest',
        action: { kind: 'edit', request: editRequest },
      });
      const externalBytes = 'version = 1\nskills = []\n# between steps\n';

      await expect(
        withExecutionLockHierarchy(
          fixture.controller.lockPort,
          fixture.controller.locks,
          async () => {
            expect((await executePreparedArtifactBinding(firstBinding, first)).outcome).toBe(
              'succeeded',
            );
            await writeFile(fixture.pair.file.path, externalBytes);
            return executePreparedArtifactBinding(secondBinding, second);
          },
        ),
      ).rejects.toThrow();
      expect(await readFile(fixture.pair.file.path, 'utf8')).toBe(externalBytes);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test('gates a new artifact group on the prior group terminal write', async () => {
    const fixture = await executionControllerFixture('prior-group-gate');
    try {
      const manifestBytes = new TextEncoder().encode(manifest(['alpha']));
      const manifestAfter = manifestImageForExecution(fixture.pair.file.path, manifestBytes);
      const incompleteLock: PortableLockV1 = Object.freeze({
        version: 1,
        hashSchemaVersion: 1,
        manifestHash: manifestAfter.semanticHash as PortableLockV1['manifestHash'],
        skills: Object.freeze([]),
      });
      const firstManifest = artifactOperationForExecution({
        marker: '8',
        groupMarker: '8',
        kind: 'write-manifest',
        before: absentArtifactImage('manifest', fixture.pair.file.path),
        after: manifestAfter,
      });
      const firstLock = artifactOperationForExecution({
        marker: '9',
        groupMarker: '8',
        kind: 'write-lock',
        before: absentArtifactImage('lock', fixture.pair.lockfile.path),
        after: lockImageForExecution(fixture.pair.lockfile.path, incompleteLock),
        dependencies: [firstManifest.operationId],
      });
      const editRequest = {
        edits: [{ kind: 'set-default' as const, field: 'scope' as const, value: 'user' as const }],
      };
      const edited = editManifestBytes(manifestBytes, editRequest);
      if (!edited.ok) throw new Error('fixture manifest edit failed');
      const secondManifest = artifactOperationForExecution({
        marker: '0',
        groupMarker: '0',
        kind: 'write-manifest',
        before: manifestAfter,
        after: manifestImageForExecution(fixture.pair.file.path, edited.value.bytes),
      });
      const firstManifestBinding = fixture.controller.bind(firstManifest, {
        role: 'manifest',
        action: { kind: 'replace', bytes: manifestBytes },
      });
      const firstLockBinding = fixture.controller.bind(firstLock, {
        role: 'lock',
        action: { kind: 'replace', lock: incompleteLock },
      });
      const secondManifestBinding = fixture.controller.bind(secondManifest, {
        role: 'manifest',
        action: { kind: 'edit', request: editRequest },
      });

      await expect(
        withExecutionLockHierarchy(
          fixture.controller.lockPort,
          fixture.controller.locks,
          async () => {
            expect(
              (await executePreparedArtifactBinding(firstManifestBinding, firstManifest)).outcome,
            ).toBe('succeeded');
            expect(
              (await executePreparedArtifactBinding(firstLockBinding, firstLock)).outcome,
            ).toBe('failed');
            return executePreparedArtifactBinding(secondManifestBinding, secondManifest);
          },
        ),
      ).rejects.toThrow();
      expect(await readFile(fixture.pair.file.path)).toEqual(Buffer.from(manifestBytes));
      expect(await fixture.runtime.pathKind(fixture.pair.lockfile.path)).toBe('absent');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
