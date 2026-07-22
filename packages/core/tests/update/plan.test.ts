import { describe, expect, test } from 'bun:test';
import { type ArtifactDigest, hashManifestSemantics } from '../../src/artifacts/hash.ts';
import type { PortableLockSkillV1, PortableLockV1 } from '../../src/artifacts/lock.ts';
import type {
  NormalizedManifestDeclaration,
  NormalizedManifestV1,
} from '../../src/artifacts/types.ts';
import type {
  ExecutableOperation,
  OperationDigest,
  OperationPlan,
  OperationSource,
} from '../../src/planning/types.ts';
import {
  type PreparedUpdateExecutionPlanV1,
  type PreparedUpdatePlanBaseV1,
  createUpdateExecutionPlanV1,
  updateGroupIdV1,
} from '../../src/update/plan.ts';
import type { UpdateSelectionV1 } from '../../src/update/types.ts';

const digest = (character: string): OperationDigest =>
  `sha256:${character.repeat(64)}` as OperationDigest;

const declaration = (name: string): NormalizedManifestDeclaration => ({
  name,
  source: { host: 'fixture.invalid', repository: 'acme/skills', path: `skills/${name}` },
  ref: 'main',
  tools: ['codex'],
  scope: 'project',
  placement: 'copy',
  path: null,
});

const source = (name: string, sha: string, contentHash: OperationDigest): OperationSource => ({
  kind: 'portable',
  identity: { host: 'fixture.invalid', repository: 'acme/skills', path: `skills/${name}` },
  requestedRef: 'main',
  resolvedSha: sha.repeat(40),
  sourcePath: `skills/${name}`,
  contentHash,
});

const lockSkill = (
  name: string,
  sha: string,
  contentHash: OperationDigest,
): PortableLockSkillV1 => ({
  name,
  source: `fixture.invalid/acme/skills//skills/${name}`,
  requestedRef: 'main',
  resolvedSha: sha.repeat(40),
  sourcePath: `skills/${name}`,
  contentHash: contentHash as ArtifactDigest,
});

const lock = (
  manifest: NormalizedManifestV1,
  skills: readonly PortableLockSkillV1[],
): PortableLockV1 => ({
  version: 1,
  hashSchemaVersion: 1,
  manifestHash: hashManifestSemantics(manifest),
  skills,
});

const liveOperation = (
  name: string,
  nextSource: OperationSource,
  beforeHash: OperationDigest,
): ExecutableOperation => {
  if (nextSource.kind !== 'portable') throw new TypeError('fixture source must be portable');
  const priorSource = {
    ...nextSource,
    resolvedSha: '1'.repeat(40),
    contentHash: beforeHash,
  };
  const resource = {
    kind: 'live' as const,
    skill: name,
    tool: 'codex' as const,
    scope: 'project' as const,
    projectRoot: { kind: 'machine-bound' as const, path: '/fixture/project' },
    location: {
      kind: 'machine-bound' as const,
      path: `/fixture/project/.agents/skills/${name}`,
    },
  };
  return {
    operationId: `old-operation:${name}`,
    groupId: `old-group:${name}`,
    pairId: `old-pair:${name}`,
    kind: 'update',
    dependencyMetadata: {
      domain: 'skillsmith.operation-dependency',
      schemaVersion: 1,
      operationIds: [],
    },
    skill: name,
    source: nextSource,
    tool: 'codex',
    scope: 'project',
    before: {
      kind: 'placement',
      resource,
      classification: 'pinned',
      representation: 'copy',
      linkTarget: null,
      dangling: false,
      source: priorSource,
      contentHash: beforeHash,
    },
    after: {
      kind: 'placement',
      resource,
      classification: 'pinned',
      representation: 'copy',
      linkTarget: null,
      dangling: false,
      source: nextSource,
      contentHash: nextSource.contentHash,
    },
    reason: { code: 'desired-placement-update', message: 'fixture update' },
    selectionSource: 'explicit-all',
    preconditionIds: ['precondition:live'],
    requiredCheckIds: [],
    reversibility: { kind: 'none', retentionResourceIds: [] },
    mutates: { live: true, manifest: false, lock: false, ledger: true },
    conflict: null,
  };
};

const baseFor = (
  names: readonly string[],
): {
  base: PreparedUpdatePlanBaseV1;
  live: OperationPlan<'update'>;
  nextSources: readonly Extract<OperationSource, { kind: 'portable' }>[];
} => {
  const declarations = names.map(declaration);
  const manifest: NormalizedManifestV1 = { version: 1, skills: declarations };
  const originalSkills = names.map((name, index) =>
    lockSkill(name, String(index + 1), digest('a')),
  );
  let priorLock = lock(manifest, originalSkills);
  const transitions: unknown[] = [];
  const selections: unknown[] = [];
  const operations: ExecutableOperation[] = [];
  const nextSources: Extract<OperationSource, { kind: 'portable' }>[] = [];
  for (const [index, row] of declarations.entries()) {
    const sha = String(index + 7);
    const next = source(row.name, sha, digest(String(index + 2)));
    if (next.kind !== 'portable') throw new TypeError('fixture source must be portable');
    nextSources.push(next);
    const nextSkill = lockSkill(row.name, sha, next.contentHash);
    const nextLock = lock(
      manifest,
      priorLock.skills.map((skill) => (skill.name === row.name ? nextSkill : skill)),
    );
    transitions.push({
      skill: row.name,
      manifestBeforeBytes: new TextEncoder().encode('version = 1\n'),
      manifestAfterBytes: new TextEncoder().encode('version = 1\n'),
      manifestBefore: manifest,
      manifestAfter: manifest,
      manifestEdit: null,
      lockBefore: priorLock,
      lockAfter: nextLock,
      lockAfterSource: '',
    });
    selections.push({
      selected: { declaration: row, tools: ['codex'] },
      currentLock: priorLock.skills.find(({ name }) => name === row.name),
      currentInspection: {
        kind: 'branch',
        requestedRef: 'main',
        resolvedSha: originalSkills[index]?.resolvedSha,
      },
      proposedInspection: {
        kind: 'branch',
        requestedRef: 'main',
        resolvedSha: next.resolvedSha,
      },
      candidate: {
        skill: row.name,
        currentRequestedRef: 'main',
        proposedRequestedRef: 'main',
        resolvedSha: next.resolvedSha,
        contentHash: next.contentHash,
        kind: 'branch',
        transition: 'preserve',
        outcome: 'available',
        reason: 'fixture candidate',
      },
      source: {
        source: next,
        skillName: row.name,
        materializedDir: `/fixture/source/${row.name}`,
        cleanupDirectory: '/fixture/source',
      },
      failure: null,
    });
    operations.push(liveOperation(row.name, next, digest('a')));
    priorLock = nextLock;
  }
  const selection: UpdateSelectionV1 = {
    selectionSource: 'explicit-all',
    requestedTargets: [],
    requestedTools: [],
    selectedNames: [...names],
    unmatchedTargets: [],
    filteredNames: [],
    declarations: selections.map((entry) => (entry as { selected: unknown }).selected) as never,
  };
  const base = {
    product: {
      input: {
        observed: {
          pair: {
            file: { path: '/fixture/project/skillsmith.toml' },
            lockfile: { path: '/fixture/project/skillsmith.lock' },
          },
        },
        selectionOutcome: 'selected',
        selectedTools: ['codex'],
        selectedScopes: ['project'],
      },
    },
    observation: { desiredPlacements: [] },
    projection: {},
    update: {
      selections,
      transitions,
      manifest,
      manifestBytes: new TextEncoder().encode('version = 1\n'),
      lock: priorLock,
      lockBytes: new Uint8Array(),
      cleanup: async () => {},
    },
    selection,
  } as unknown as PreparedUpdatePlanBaseV1;
  const live = {
    command: 'update',
    operations,
    checks: [],
    diagnostics: [],
  } as unknown as OperationPlan<'update'>;
  return { base, live, nextSources };
};

const guards = {
  resourcePreconditions: [{ preconditionId: 'precondition:resource' }],
  selectionPreconditions: [{ preconditionId: 'precondition:selection' }],
  capabilityPreconditions: [{ preconditionId: 'precondition:capability' }],
};

const requirePlan = (result: ReturnType<typeof createUpdateExecutionPlanV1>) => {
  if (!result.ok) throw new Error(result.error.message);
  expect(result.ok).toBeTrue();
  return result.value;
};

describe('update execution planning', () => {
  test('derives deterministic group identity from exact skill, source, and scope', () => {
    const exact = source('review', 'a', digest('a'));
    if (exact.kind !== 'portable') throw new TypeError('fixture source must be portable');
    const first = updateGroupIdV1({ skill: 'review' }, exact, 'project');
    expect(updateGroupIdV1({ skill: 'review' }, exact, 'project')).toBe(first);
    expect(updateGroupIdV1({ skill: 'other' }, exact, 'project')).not.toBe(first);
    expect(updateGroupIdV1({ skill: 'review' }, exact, 'user')).not.toBe(first);
    expect(
      updateGroupIdV1({ skill: 'review' }, { ...exact, resolvedSha: 'b'.repeat(40) }, 'project'),
    ).not.toBe(first);
  });

  test('adds one exact artifact prefix, source check, and adapter-owned verification per pair', () => {
    const fixture = baseFor(['review']);
    const prepared = requirePlan(
      createUpdateExecutionPlanV1(fixture.base, fixture.live, guards, false),
    );
    expect(prepared.plan).toMatchObject({
      command: 'update',
      batchPolicy: 'fail-fast',
      selection: {
        source: 'explicit-all',
        all: true,
        skills: ['review'],
        tools: ['codex'],
        scopes: ['project'],
      },
    });
    expect(prepared.plan.operations.map(({ kind }) => kind)).toEqual(['write-lock', 'update']);
    const [lockOperation, liveOperation] = prepared.plan.operations;
    if (lockOperation === undefined || liveOperation === undefined) {
      throw new Error('single-group fixture did not produce its exact operation pair');
    }
    expect(lockOperation).toMatchObject({
      kind: 'write-lock',
      preconditionIds: [
        'precondition:capability',
        'precondition:resource',
        'precondition:selection',
      ],
    });
    expect(liveOperation.dependencyMetadata.operationIds).toEqual([lockOperation.operationId]);
    expect(liveOperation).toMatchObject({
      kind: 'update',
      reversibility: { kind: 'conditional' },
      conflict: null,
    });
    expect(prepared.plan.checks.map(({ kind }) => kind).toSorted()).toEqual([
      'source-resolution',
      'verification',
    ]);
    expect(prepared.plan.checks.find(({ kind }) => kind === 'verification')).toMatchObject({
      tool: 'codex',
      mode: 'static+deep',
    });
    expect(prepared.artifactActions).toEqual([
      expect.objectContaining({
        operationId: lockOperation.operationId,
        action: expect.objectContaining({
          role: 'lock',
          action: expect.objectContaining({ kind: 'replace' }),
        }),
      }),
    ]);
  });

  test('serializes colliding artifact prefixes across groups and preserves continuation policy', () => {
    const fixture = baseFor(['alpha', 'beta']);
    const prepared: PreparedUpdateExecutionPlanV1 = requirePlan(
      createUpdateExecutionPlanV1(fixture.base, fixture.live, guards, true),
    );
    expect(prepared.plan.batchPolicy).toBe('continue-on-error');
    expect(prepared.plan.operations.map(({ kind }) => kind)).toEqual([
      'write-lock',
      'update',
      'write-lock',
      'update',
    ]);
    const [firstLock, firstLive, secondLock, secondLive] = prepared.plan.operations;
    if (
      firstLock === undefined ||
      firstLive === undefined ||
      secondLock === undefined ||
      secondLive === undefined
    ) {
      throw new Error('multi-group fixture did not produce two exact operation pairs');
    }
    expect(firstLive.dependencyMetadata.operationIds).toEqual([firstLock.operationId]);
    expect(secondLock.dependencyMetadata.operationIds).toEqual([firstLock.operationId]);
    expect(secondLive.dependencyMetadata.operationIds).toEqual([
      firstLock.operationId,
      secondLock.operationId,
    ]);
    expect(prepared.artifactActions.map(({ operationId }) => operationId)).toEqual([
      firstLock.operationId,
      secondLock.operationId,
    ]);
    expect(new Set(prepared.plan.selection.groupIds).size).toBe(2);
  });
});
