import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { join } from 'node:path';
import {
  createRelevantCapabilitySnapshotV1,
  toCapabilityPreconditionsV1,
} from '../../../packages/core/src/agents/capabilities.ts';
import type { Placement } from '../../../packages/core/src/agents/placement-shared.ts';
import { toolRegistry } from '../../../packages/core/src/agents/registry.ts';
import {
  type ArtifactDigest,
  hashManifestSemantics,
} from '../../../packages/core/src/artifacts/hash.ts';
import type {
  LedgerModel,
  LedgerPairV1Dto,
} from '../../../packages/core/src/artifacts/ledger-types.ts';
import type {
  PortableLockSkillV1,
  PortableLockV1,
} from '../../../packages/core/src/artifacts/lock.ts';
import { artifactContractRegistry } from '../../../packages/core/src/artifacts/registry.ts';
import type {
  NormalizedManifestDeclaration,
  NormalizedManifestV1,
} from '../../../packages/core/src/artifacts/types.ts';
import { createReconcilePlan } from '../../../packages/core/src/reconcile/plan.ts';
import { createSavedPlan } from '../../../packages/core/src/reconcile/saved.ts';
import type {
  ObservedDesiredPlacement,
  ObservedPrunePlacement,
  ObservedReconcileInput,
  ReconcilePlanProduct,
  ResolvedPlanDeclaration,
  ResolvedPlanInput,
} from '../../../packages/core/src/reconcile/types.ts';
import {
  OPERATION_MATRIX,
  createPlanFixture,
  destroyPlanFixture,
  jsonReport,
  runPlanCli,
} from '../fixtures/p4b-plan/cases.ts';
import { SYNTHETIC_OPERATION_ROWS } from '../fixtures/p4b-plan/goldens.ts';

setDefaultTimeout(60_000);

type UnknownRecord = Record<string, unknown>;

const records = (value: unknown): readonly UnknownRecord[] =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is UnknownRecord =>
          typeof entry === 'object' && entry !== null && !Array.isArray(entry),
      )
    : [];

const ROOT = '/fixture/p4b-plan-matrix';
const SHA = 'a'.repeat(40);
const digest = (character: string): ArtifactDigest =>
  `sha256:${character.repeat(64)}` as ArtifactDigest;

const declaration = (
  name = 'alpha',
  options: Readonly<{
    scope?: 'user' | 'project';
    placement?: 'copy' | 'symlink';
  }> = {},
): NormalizedManifestDeclaration => ({
  name,
  source: { host: 'fixture.invalid', repository: 'acme/skills', path: `skills/${name}` },
  ref: null,
  tools: ['codex'],
  scope: options.scope ?? 'user',
  placement: options.placement ?? 'copy',
  path: null,
});

const pinFor = (
  row: NormalizedManifestDeclaration,
  contentHash: PortableLockSkillV1['contentHash'] = digest('c'),
): PortableLockSkillV1 => ({
  name: row.name,
  source: `${row.source.host}/${row.source.repository}//${row.source.path ?? '.'}`,
  requestedRef: row.ref,
  resolvedSha: SHA,
  sourcePath: row.source.path ?? '.',
  contentHash,
});

const resolvedRow = (
  row: NormalizedManifestDeclaration,
  contentHash: PortableLockSkillV1['contentHash'] = digest('c'),
): ResolvedPlanDeclaration => ({ declaration: row, tool: 'codex', lock: pinFor(row, contentHash) });

const placement = (
  skill: string,
  scope: 'user' | 'project',
  placementClass: Placement['class'],
  options: Readonly<{ symlinkTarget?: string | null; dangling?: boolean }> = {},
): Placement => {
  const root = join(ROOT, 'live', scope, 'codex');
  return {
    skill,
    root,
    path: join(root, skill),
    class: placementClass,
    symlinkTarget: options.symlinkTarget ?? null,
    dangling: options.dangling ?? false,
  };
};

const storePathFor = (skill: string): string =>
  join(ROOT, 'store', 'acme', `skills@${SHA.slice(0, 12)}`, skill);

const pairFor = (
  row: NormalizedManifestDeclaration,
  pin: PortableLockSkillV1,
  live: Placement,
  representation: 'copy' | 'symlink' = row.placement,
): LedgerPairV1Dto => ({
  placementPath: live.path,
  mode: 'pinned',
  dev: null,
  pinned: {
    storePath: storePathFor(row.name),
    rev: pin.resolvedSha.slice(0, 12),
    gitSha: pin.resolvedSha,
    dirty: false,
    contentHash: pin.contentHash,
    snapshotAt: '2026-07-19T00:00:00.000Z',
    verify: 'passed',
    placement: representation,
  },
  origin: {
    source: `https://${row.source.host}/${row.source.repository}//${row.source.path ?? '.'}`,
    host: row.source.host,
    repo: row.source.repository,
    skillPath: row.source.path ?? '.',
    refRequested: pin.requestedRef,
    refResolved: pin.resolvedSha,
    pin: true,
    installedAt: '2026-07-19T00:00:00.000Z',
  },
});

const emptyLedger = (): LedgerModel => ({
  updatedAt: '2026-07-19T00:00:00.000Z',
  skills: {},
  projects: {},
  projectRegistrations: {},
  transactions: {},
  history: [],
});

const ledgerWith = (
  entries: readonly Readonly<{
    row: NormalizedManifestDeclaration;
    pair: LedgerPairV1Dto;
    scope: 'user' | 'project';
  }>[],
): LedgerModel => {
  const user: Record<string, { tools: Record<string, LedgerPairV1Dto> }> = {};
  const project: Record<string, { tools: Record<string, LedgerPairV1Dto> }> = {};
  for (const entry of entries) {
    const tree = entry.scope === 'user' ? user : project;
    tree[entry.row.name] = { tools: { codex: entry.pair } };
  }
  return {
    ...emptyLedger(),
    skills: user,
    projects: Object.keys(project).length === 0 ? {} : { [ROOT]: { skills: project } },
  };
};

const baseInput = (
  rows: readonly ResolvedPlanDeclaration[],
  options: Readonly<{
    lockSkills?: readonly PortableLockSkillV1[];
    replacementLock?: PortableLockV1 | null;
    prune?: boolean;
    selectionOutcome?: 'selected' | 'filter-noop';
  }> = {},
): ResolvedPlanInput => {
  const model: NormalizedManifestV1 = {
    version: 1,
    skills: rows.map(({ declaration: row }) => row),
  };
  const lock: PortableLockV1 = {
    version: 1,
    hashSchemaVersion: 1,
    manifestHash: hashManifestSemantics(model),
    skills: [...(options.lockSkills ?? rows.map(({ lock: row }) => row))].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
  };
  const scopes = [...new Set(rows.map(({ declaration: row }) => row.scope))].sort();
  return {
    observed: {
      project: {
        invocationCwd: ROOT,
        effectiveCwd: ROOT,
        projectRoot: ROOT,
        projectIdentity: ROOT,
        projectKind: 'non-git',
        discoveredConfigPath: null,
        explicitConfigPath: null,
      },
      pair: {
        file: {
          token: './skillsmith.toml',
          path: join(ROOT, 'skillsmith.toml'),
          portability: 'portable',
          portableToken: './skillsmith.toml',
        },
        lockfile: {
          token: null,
          path: join(ROOT, 'skillsmith.lock'),
          portability: 'portable',
          portableToken: './skillsmith.lock',
        },
        lockfileSource: 'sibling',
      },
      manifest: {
        state: 'present',
        artifact: 'manifest',
        sourceVersion: 1,
        currentVersion: 1,
        source: 'version = 1\n',
        byteLength: 12,
        byteRevision: digest('1'),
        semanticRevision: hashManifestSemantics(model),
        model,
        canonical: true,
        migration: null,
      },
      lock: {
        state: 'present',
        artifact: 'lock',
        sourceVersion: 1,
        currentVersion: 1,
        source: '{}\n',
        byteLength: 3,
        byteRevision: digest('2'),
        semanticRevision: digest('3'),
        model: lock,
        canonical: true,
        migration: null,
      },
      relationship: { state: 'current' },
    },
    request: {
      tools: [],
      scope: null,
      locked: options.replacementLock == null,
      prune: options.prune ?? false,
      check: false,
    },
    declarations: rows,
    selectedSkills: rows.map(({ declaration: row }) => row.name).sort(),
    selectedTools: rows.length === 0 ? [] : ['codex'],
    selectedScopes: scopes,
    selectionOutcome: options.selectionOutcome ?? 'selected',
    replacementLock: options.replacementLock ?? null,
  };
};

const withLedger = (
  input: ResolvedPlanInput,
  model: LedgerModel,
  migration: NonNullable<
    Extract<ResolvedPlanInput['observed']['ledger'], { state: 'present' }>['migration']
  > | null = null,
): ResolvedPlanInput => ({
  ...input,
  observed: {
    ...input.observed,
    ledgerPath: join(ROOT, 'placements.json'),
    ledger: {
      state: 'present',
      artifact: 'ledger',
      sourceVersion: migration?.kind === 'ledger-v1-to-v2' ? 1 : 2,
      currentVersion: 2,
      source: '{}\n',
      byteLength: 3,
      byteRevision: migration?.sourceByteRevision ?? digest('4'),
      semanticRevision: migration?.sourceSemanticRevision ?? digest('5'),
      model,
      canonical: true,
      migration,
    },
  },
});

const capabilityPreconditions = (input: ResolvedPlanInput) =>
  toCapabilityPreconditionsV1(
    createRelevantCapabilitySnapshotV1(
      toolRegistry,
      input.selectedTools.flatMap((tool) =>
        input.selectedScopes.map((scope) => ({
          schemaVersion: 1 as const,
          tool,
          operation: 'plan' as const,
          scope,
        })),
      ),
    ),
  );

const observation = (
  resolved: ResolvedPlanInput,
  desiredPlacements: readonly ObservedDesiredPlacement[] = [],
  prunePlacements: readonly ObservedPrunePlacement[] = [],
): ObservedReconcileInput => ({
  resolved,
  storeRoot: join(ROOT, 'store'),
  desiredPlacements,
  prunePlacements,
  undeclaredPlacements: [],
  capabilityPreconditions: capabilityPreconditions(resolved),
});

const desired = (
  row: ResolvedPlanDeclaration,
  current: Placement,
  options: Readonly<{
    contentHash?: ArtifactDigest | null;
    ledgerPair?: LedgerPairV1Dto | null;
    storeState?: 'absent' | 'present' | 'invalid';
    storeContentHash?: ArtifactDigest | null;
    opposite?: Extract<ObservedDesiredPlacement, { state: 'observed' }>['opposite'];
  }> = {},
): Extract<ObservedDesiredPlacement, { state: 'observed' }> => ({
  state: 'observed',
  row,
  placement: current,
  contentHash: options.contentHash ?? null,
  ledgerPair: options.ledgerPair ?? null,
  store: {
    path: storePathFor(row.declaration.name),
    state: options.storeState ?? 'absent',
    contentHash: options.storeContentHash ?? null,
  },
  opposite: options.opposite ?? null,
});

const EXPECTED_MATRIX = Object.freeze([
  ['install', 'desired-placement-absent', 'absent', 'placement'],
  ['update', 'desired-placement-update', 'placement', 'placement'],
  ['update', 'desired-placement-relink', 'placement', 'placement'],
  ['repair', 'desired-placement-repair', 'placement', 'placement'],
  ['remove', 'prune-lock-owned-placement', 'placement', 'absent'],
  ['move-scope', 'desired-placement-move-scope', 'placement', 'placement'],
  ['write-lock', 'portable-lock-stale', 'lock', 'lock'],
  ['migrate-project-config', 'migrate-project-config', 'manifest', 'manifest'],
  ['migrate-ledger', 'migrate-ledger', 'ledger', 'ledger'],
] as const);

const matrixObservation = (): ObservedReconcileInput => {
  const install = resolvedRow(declaration('install'));
  const update = resolvedRow(declaration('update'));
  const relink = resolvedRow(declaration('relink', { placement: 'symlink' }));
  const repair = resolvedRow(declaration('repair', { placement: 'symlink' }));
  const move = resolvedRow(declaration('move', { scope: 'project' }));
  const rows = [install, update, relink, repair, move].sort((left, right) =>
    left.declaration.name.localeCompare(right.declaration.name),
  );

  const updateLive = placement('update', 'user', 'pinned');
  const relinkLive = placement('relink', 'user', 'pinned');
  const repairLive = placement('repair', 'user', 'store-linked', {
    symlinkTarget: storePathFor('repair'),
    dangling: true,
  });
  const moveLive = placement('move', 'user', 'pinned');
  const updatePair = pairFor(update.declaration, update.lock, updateLive);
  const relinkPair = pairFor(relink.declaration, relink.lock, relinkLive, 'copy');
  const repairPair = pairFor(repair.declaration, repair.lock, repairLive, 'symlink');
  const movePair = pairFor(move.declaration, move.lock, moveLive);
  const orphan = declaration('orphan');
  const orphanPin = pinFor(orphan, digest('d'));
  const orphanLive = placement('orphan', 'user', 'pinned');
  const orphanPair = pairFor(orphan, orphanPin, orphanLive);

  const manifestModel: NormalizedManifestV1 = {
    version: 1,
    skills: rows.map(({ declaration: row }) => row),
  };
  const replacementLock: PortableLockV1 = {
    version: 1,
    hashSchemaVersion: 1,
    manifestHash: hashManifestSemantics(manifestModel),
    skills: rows.map(({ lock }) => lock),
  };
  const base = baseInput(rows, {
    lockSkills: [...replacementLock.skills, orphanPin],
    replacementLock,
    prune: true,
  });
  const semanticRevision = base.observed.manifest.semanticRevision;
  if (semanticRevision === null) throw new Error('matrix manifest lacks semantic revision');
  const migrated = withLedger(
    {
      ...base,
      observed: {
        ...base.observed,
        manifest: {
          ...base.observed.manifest,
          sourceVersion: 'legacy',
          canonical: false,
          migration: {
            kind: 'migrate-project-config',
            from: 'legacy',
            toVersion: 1,
            expectedByteRevision: base.observed.manifest.byteRevision,
            expectedSemanticRevision: semanticRevision,
            resultByteRevision: digest('6'),
            resultSemanticRevision: semanticRevision,
            resultSource: 'version = 1\n',
            createsLockfile: false,
          },
        },
      },
    },
    ledgerWith([
      { row: update.declaration, pair: updatePair, scope: 'user' },
      { row: relink.declaration, pair: relinkPair, scope: 'user' },
      { row: repair.declaration, pair: repairPair, scope: 'user' },
      { row: move.declaration, pair: movePair, scope: 'user' },
      { row: orphan, pair: orphanPair, scope: 'user' },
    ]),
    {
      kind: 'ledger-v1-to-v2',
      fromSchemaVersion: 1,
      toSchemaVersion: 2,
      sourceByteRevision: digest('7'),
      sourceSemanticRevision: digest('8'),
      targetSemanticRevision: digest('8'),
      targetByteRevision: digest('9'),
      targetCanonicalSource: '{}\n',
      preservedLegacyJournals: [],
    },
  );

  return observation(
    migrated,
    [
      desired(install, placement('install', 'user', 'absent')),
      desired(update, updateLive, {
        contentHash: digest('d'),
        ledgerPair: updatePair,
        storeState: 'present',
        storeContentHash: update.lock.contentHash,
      }),
      desired(relink, relinkLive, {
        contentHash: relink.lock.contentHash,
        ledgerPair: relinkPair,
        storeState: 'present',
        storeContentHash: relink.lock.contentHash,
      }),
      desired(repair, repairLive, { ledgerPair: repairPair }),
      desired(move, placement('move', 'project', 'absent'), {
        opposite: {
          scope: 'user',
          placement: moveLive,
          contentHash: move.lock.contentHash,
          ledgerPair: movePair,
        },
      }),
    ],
    [
      {
        pin: orphanPin,
        tool: 'codex',
        scope: 'user',
        placement: orphanLive,
        duplicateReason: null,
        contentHash: orphanPin.contentHash,
        ledgerPair: orphanPair,
      },
    ],
  );
};

const noopObservation = (): ObservedReconcileInput => {
  const row = resolvedRow(declaration());
  const live = placement('alpha', 'user', 'pinned');
  const pair = pairFor(row.declaration, row.lock, live);
  const input = withLedger(
    baseInput([row]),
    ledgerWith([{ row: row.declaration, pair, scope: 'user' }]),
  );
  return observation(input, [
    desired(row, live, {
      contentHash: row.lock.contentHash,
      ledgerPair: pair,
      storeState: 'present',
      storeContentHash: row.lock.contentHash,
    }),
  ]);
};

const savedBytes = (product: ReconcilePlanProduct, label: string): Uint8Array => {
  const saved = createSavedPlan(product);
  if (!saved.ok) throw new Error(`${label}: ${saved.error.message}`);
  expect(saved.ok, `${label}: saved plan projection`).toBeTrue();
  const codec = artifactContractRegistry.get('plan', 1);
  expect(codec).toBeDefined();
  if (codec === undefined) throw new Error('saved-plan v1 codec unavailable');
  const encoded = codec.encode(saved.value);
  expect(encoded.ok).toBeTrue();
  if (!encoded.ok) throw new Error(encoded.error.message);

  const operationIds = new Set(saved.value.operations.map(({ operationId }) => operationId));
  const checkIds = new Set(saved.value.checks.map(({ checkId }) => checkId));
  const preconditionIds = new Set([
    ...saved.value.resourcePreconditions.map(({ preconditionId }) => preconditionId),
    ...saved.value.selectionPreconditions.map(({ preconditionId }) => preconditionId),
    ...saved.value.capabilityPreconditions.map(({ preconditionId }) => preconditionId),
  ]);
  for (const operation of saved.value.operations) {
    expect(operation.dependsOn.every((id) => operationIds.has(id))).toBeTrue();
    expect(operation.preconditionIds.every((id) => preconditionIds.has(id))).toBeTrue();
    expect(operation.requiredCheckIds.every((id) => checkIds.has(id))).toBeTrue();
  }
  for (const check of saved.value.checks) {
    expect(check.operationIds.every((id) => operationIds.has(id))).toBeTrue();
  }
  return encoded.value;
};

describe('EWP-P4B-TS01', () => {
  test('executes the reachable reconciliation matrix with stable order, IDs, images, and refs', () => {
    const observed = matrixObservation();
    const first = createReconcilePlan(observed);
    const second = createReconcilePlan(observed);
    expect(first.ok).toBeTrue();
    expect(second.ok).toBeTrue();
    if (!first.ok || !second.ok) return;

    expect(second.value.plan.operations.map(({ operationId }) => operationId)).toEqual(
      first.value.plan.operations.map(({ operationId }) => operationId),
    );
    expect(new Set(first.value.plan.operations.map(({ operationId }) => operationId)).size).toBe(
      EXPECTED_MATRIX.length,
    );
    const writeLock = first.value.plan.operations.find(({ kind }) => kind === 'write-lock');
    expect(writeLock).toBeDefined();
    for (const operation of first.value.plan.operations.filter(({ mutates }) => mutates.live)) {
      expect(operation.dependencyMetadata.operationIds).toContain(writeLock?.operationId);
    }
    for (const [kind, reason, before, after] of EXPECTED_MATRIX) {
      const operation = first.value.plan.operations.find(
        (candidate) => candidate.kind === kind && candidate.reason.code === reason,
      );
      expect(operation, `${reason}: real reconciler operation`).toBeDefined();
      expect(operation?.before.kind, `${reason}: exact before image`).toBe(before);
      expect(operation?.after.kind, `${reason}: exact after image`).toBe(after);
    }
    expect(savedBytes(second.value, 'matrix')).toEqual(savedBytes(first.value, 'matrix'));

    const noops = [
      ['empty', observation(baseInput([], { selectionOutcome: 'filter-noop' }))],
      ['converged', noopObservation()],
    ] as const;
    for (const [label, input] of noops) {
      const left = createReconcilePlan(input);
      const right = createReconcilePlan(input);
      expect(left.ok, label).toBeTrue();
      expect(right.ok, label).toBeTrue();
      if (!left.ok || !right.ok) continue;
      expect(left.value.plan.operations, `${label}: no mutations`).toEqual([]);
      expect(left.value.plan.diagnostics.map(({ kind }) => kind)).toEqual(['noop']);
      expect(right.value.plan.diagnostics).toEqual(left.value.plan.diagnostics);
      expect(savedBytes(right.value, label)).toEqual(savedBytes(left.value, label));
    }
  });

  test('keeps CLI report bytes deterministic and adapts through the canonical injected seam', async () => {
    expect(OPERATION_MATRIX).toEqual([
      'empty',
      'install',
      'update',
      'remove',
      'move-scope',
      'adapt',
      'migrate-project-config',
      'migrate-ledger',
      'noop',
    ]);
    expect(SYNTHETIC_OPERATION_ROWS.map((row) => row.kind)).toEqual([
      'install',
      'update',
      'remove',
      'move-scope',
      'adapt',
      'migrate-project-config',
      'migrate-ledger',
    ]);

    const fixture = await createPlanFixture([
      { name: 'zulu', tool: 'codex' },
      { name: 'alpha', tool: 'claude-code' },
    ]);
    try {
      const args = ['plan', '--file', fixture.manifest, '--locked', '--json'] as const;
      const first = await runPlanCli(fixture, args);
      const second = await runPlanCli(fixture, args);
      expect(first.exitCode).toBe(0);
      expect(second).toEqual(first);
      const report = jsonReport(first, 0, 'phase planner matrix');
      const operations = records(report.operations);
      expect(operations.map((row) => row.kind)).toEqual(['install', 'install']);
      expect(operations.map((row) => row.skill)).toEqual(['alpha', 'zulu']);
      expect(new Set(operations.map((row) => row.operationId)).size).toBe(operations.length);

      const renderer = await import('../../../packages/cli/src/output/plan-human.ts').catch(
        () => null,
      );
      expect(
        renderer,
        'plan renderer must accept canonical synthetic operation fixtures',
      ).not.toBeNull();
      if (renderer === null) return;
      expect(typeof renderer.renderPlanOperationHuman).toBe('function');
      for (const row of SYNTHETIC_OPERATION_ROWS) {
        expect(renderer.renderPlanOperationHuman(row as never)).toContain(row.kind);
      }
    } finally {
      await destroyPlanFixture(fixture);
    }
  });
});
