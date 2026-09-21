import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ArtifactDigest,
  hashManifestBytes,
  hashManifestSemantics,
} from '../../src/artifacts/hash.ts';
import type { LedgerModel, LedgerPairV1Dto } from '../../src/artifacts/ledger-types.ts';
import type { PortableLockSkillV1, PortableLockV1 } from '../../src/artifacts/lock.ts';
import { hashSourceContentV1, projectSourceContent } from '../../src/artifacts/source-content.ts';
import type {
  NormalizedManifestDeclaration,
  NormalizedManifestV1,
} from '../../src/artifacts/types.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';
import type { ResolvedRuntimeConfiguration, RuntimePorts } from '../../src/ports/types.ts';
import { observeReconcileInput } from '../../src/reconcile/observe.ts';
import { createReconcilePlan } from '../../src/reconcile/plan.ts';
import { createSavedPlan } from '../../src/reconcile/saved.ts';
import type {
  ObservedPlanArtifacts,
  ResolvedPlanDeclaration,
  ResolvedPlanInput,
} from '../../src/reconcile/types.ts';

const roots: string[] = [];
const SHA = 'a'.repeat(40);
const digest = (character: string): ArtifactDigest =>
  `sha256:${character.repeat(64)}` as ArtifactDigest;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const configuration = (root: string): ResolvedRuntimeConfiguration => ({
  configLayer: {},
  explicitConfigPath: undefined,
  skillsmithHome: join(root, 'data'),
  claudeConfigDir: undefined,
  claudePolicySkillsDisabled: false,
  claudeManagedSettingsPath: undefined,
  codexHome: undefined,
  kiloExternalSkillsDisabled: false,
  opencodeConfigDir: undefined,
  opencodeClaudeSkillsDisabled: false,
  forceColor: false,
  noColor: true,
  journalPause: undefined,
});

const declaration = (
  tool: 'codex' | 'kilo-code' = 'codex',
  placement: 'copy' | 'symlink' = 'copy',
): NormalizedManifestDeclaration => ({
  name: tool === 'codex' ? 'alpha' : 'beta',
  source: {
    host: 'fixture.invalid',
    repository: 'acme/skills',
    path: `skills/${tool === 'codex' ? 'alpha' : 'beta'}`,
  },
  ref: null,
  tools: [tool],
  scope: 'user',
  placement,
  path: null,
});

const pinFor = (
  row: NormalizedManifestDeclaration,
  contentHash: PortableLockSkillV1['contentHash'],
): PortableLockSkillV1 => ({
  name: row.name,
  source: `${row.source.host}/${row.source.repository}//${row.source.path}`,
  requestedRef: null,
  resolvedSha: SHA,
  sourcePath: row.source.path ?? '.',
  contentHash,
});

const storePathFor = (
  root: string,
  row: NormalizedManifestDeclaration,
  pin: PortableLockSkillV1,
): string =>
  join(root, 'data', 'store', 'acme', `skills@${pin.resolvedSha.slice(0, 12)}`, row.name);

const pairFor = (
  row: NormalizedManifestDeclaration,
  pin: PortableLockSkillV1,
  placementPath: string,
  storePath: string,
  placement: 'copy' | 'symlink' = row.placement,
): LedgerPairV1Dto => ({
  placementPath,
  mode: 'pinned',
  dev: null,
  pinned: {
    storePath,
    rev: pin.resolvedSha.slice(0, 12),
    gitSha: pin.resolvedSha,
    dirty: false,
    contentHash: pin.contentHash,
    snapshotAt: '2026-07-19T00:00:00.000Z',
    verify: 'passed',
    placement,
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

const withPinnedContentHash = (
  pair: LedgerPairV1Dto,
  contentHash: ArtifactDigest,
): LedgerPairV1Dto => {
  if (pair.pinned == null) throw new Error('fixture pair lacks a pin');
  return { ...pair, pinned: { ...pair.pinned, contentHash } };
};

const ledgerFor = (
  root: string,
  entries: readonly Readonly<{
    scope: 'user' | 'project';
    row: NormalizedManifestDeclaration;
    tool: 'claude-code' | 'codex' | 'kilo-code';
    pair: LedgerPairV1Dto;
  }>[],
): LedgerModel => {
  const user: Record<string, { tools: Record<string, LedgerPairV1Dto> }> = {};
  const project: Record<string, { tools: Record<string, LedgerPairV1Dto> }> = {};
  for (const entry of entries) {
    const tree = entry.scope === 'user' ? user : project;
    const skill = tree[entry.row.name] ?? { tools: {} };
    skill.tools[entry.tool] = entry.pair;
    tree[entry.row.name] = skill;
  }
  return {
    updatedAt: '2026-07-19T00:00:00.000Z',
    skills: user,
    projects: Object.keys(project).length === 0 ? {} : { [root]: { skills: project } },
    projectRegistrations: {},
    transactions: {},
    history: [],
  };
};

const withLedger = (
  input: ResolvedPlanInput,
  root: string,
  model: LedgerModel,
): ResolvedPlanInput => ({
  ...input,
  observed: {
    ...input.observed,
    ledgerPath: join(root, 'placements.json'),
    ledger: {
      state: 'present',
      artifact: 'ledger',
      sourceVersion: 2,
      currentVersion: 2,
      source: '{}\n',
      byteLength: 3,
      byteRevision: digest('7'),
      semanticRevision: digest('8'),
      model,
      canonical: true,
      migration: null,
    },
  },
});

const productInput = (
  root: string,
  rows: readonly ResolvedPlanDeclaration[],
  replacementLock: PortableLockV1 | null = null,
): ResolvedPlanInput => {
  const model: NormalizedManifestV1 = { version: 1, skills: rows.map((row) => row.declaration) };
  const lock: PortableLockV1 = {
    version: 1,
    hashSchemaVersion: 1,
    manifestHash: hashManifestSemantics(model),
    skills: rows.map((row) => row.lock),
  };
  const byteDigest = digest('b');
  const observed: ObservedPlanArtifacts = {
    project: {
      invocationCwd: root,
      effectiveCwd: root,
      projectRoot: root,
      projectIdentity: root,
      projectKind: 'non-git',
      discoveredConfigPath: null,
      explicitConfigPath: null,
    },
    pair: {
      file: {
        token: './skillsmith.toml',
        path: join(root, 'skillsmith.toml'),
        portability: 'portable',
        portableToken: './skillsmith.toml',
      },
      lockfile: {
        token: null,
        path: join(root, 'skillsmith.lock'),
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
      byteRevision: byteDigest,
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
      source: 'version = 1\n',
      byteLength: 12,
      byteRevision: byteDigest,
      semanticRevision: byteDigest,
      model: lock,
      canonical: true,
      migration: null,
    },
    relationship: { state: 'current' },
  };
  return {
    observed,
    request: { tools: [], scope: null, locked: true, prune: false, check: false },
    declarations: rows,
    selectedSkills: rows.map((row) => row.declaration.name),
    selectedTools: rows.map((row) => row.tool),
    selectedScopes: [...new Set(rows.map((row) => row.declaration.scope))].sort(),
    selectionOutcome: 'selected',
    replacementLock,
  };
};

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillsmith-reconcile-plan-'));
  roots.push(root);
  const base = await defaultRuntimePorts();
  const ports: RuntimePorts = {
    ...base,
    homeDir: join(root, 'home'),
    xdg: {
      config: join(root, 'xdg', 'config'),
      data: join(root, 'xdg', 'data'),
      cache: join(root, 'xdg', 'cache'),
    },
  };
  return { root, ports, configuration: configuration(root) };
};

const contentHash = async (ports: RuntimePorts, path: string): Promise<ArtifactDigest> => {
  const projected = await projectSourceContent(ports, path);
  expect(projected.ok).toBeTrue();
  if (!projected.ok) throw new Error(projected.error.message);
  const hashed = hashSourceContentV1(projected.value);
  expect(hashed.ok).toBeTrue();
  if (!hashed.ok) throw new Error(hashed.error.message);
  return hashed.value;
};

const reconcile = async (
  input: ResolvedPlanInput,
  runtime: Readonly<{ ports: RuntimePorts; configuration: ResolvedRuntimeConfiguration }>,
) => {
  const observed = await observeReconcileInput(input, runtime);
  expect(observed.ok).toBeTrue();
  if (!observed.ok) throw new Error(observed.error.message);
  return createReconcilePlan(observed.value);
};

describe('desired/current plan reconciliation', () => {
  test('plans install for absence and preserves the declared representation', async () => {
    const state = await fixture();
    const row = declaration('codex', 'symlink');
    const resolved: ResolvedPlanDeclaration = {
      declaration: row,
      tool: 'codex',
      lock: pinFor(row, digest('c')),
    };
    const observed = await observeReconcileInput(productInput(state.root, [resolved]), state);
    expect(observed.ok).toBeTrue();
    if (!observed.ok) throw new Error(observed.error.message);
    expect(Object.isFrozen(observed.value)).toBeTrue();
    expect(Object.isFrozen(observed.value.desiredPlacements)).toBeTrue();
    const result = createReconcilePlan(observed.value);
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.plan.operations).toHaveLength(1);
    expect(result.value.plan.operations[0]).toMatchObject({
      kind: 'install',
      before: { kind: 'absent' },
      after: {
        kind: 'placement',
        classification: 'pinned',
        representation: 'symlink',
        linkTarget: { kind: 'machine-bound' },
      },
    });
    expect(result.value.plan.checks.map(({ kind }) => kind).toSorted()).toEqual([
      'capability',
      'content-integrity',
    ]);
    expect(result.value.plan.operations[0]?.requiredCheckIds).toHaveLength(2);
  });

  test('orders a visible v1 ledger migration before ledger-governed convergence', async () => {
    const state = await fixture();
    const row = declaration('codex', 'copy');
    const resolved: ResolvedPlanDeclaration = {
      declaration: row,
      tool: 'codex',
      lock: pinFor(row, digest('c')),
    };
    const input = productInput(state.root, [resolved]);
    const sourceByteRevision = digest('e');
    const semanticRevision = digest('f');
    const targetByteRevision = digest('1');
    const result = await reconcile(
      {
        ...input,
        observed: {
          ...input.observed,
          ledgerPath: join(state.root, 'placements.json'),
          ledger: {
            state: 'present',
            artifact: 'ledger',
            sourceVersion: 1,
            currentVersion: 2,
            source: '{}',
            byteLength: 2,
            byteRevision: sourceByteRevision,
            semanticRevision,
            model: {
              updatedAt: '2026-07-19T00:00:00.000Z',
              skills: {},
              projects: {},
              projectRegistrations: {},
              transactions: {},
              history: [],
            },
            canonical: true,
            migration: {
              kind: 'ledger-v1-to-v2',
              fromSchemaVersion: 1,
              toSchemaVersion: 2,
              sourceByteRevision,
              sourceSemanticRevision: semanticRevision,
              targetSemanticRevision: semanticRevision,
              targetByteRevision,
              targetCanonicalSource: '{}\n',
              preservedLegacyJournals: [],
            },
          },
        },
      },
      state,
    );
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.plan.operations.map(({ kind }) => kind)).toEqual([
      'migrate-ledger',
      'install',
    ]);
    expect(result.value.plan.operations[0]).toMatchObject({
      before: { kind: 'ledger', schemaVersion: 1, byteHash: sourceByteRevision },
      after: { kind: 'ledger', schemaVersion: 2, byteHash: targetByteRevision },
    });
    const saved = createSavedPlan(result.value);
    expect(saved.ok).toBeTrue();
    if (!saved.ok) throw new Error(saved.error.message);
    expect(saved.value.operations[0]?.preconditionIds).toContain(
      saved.value.resourcePreconditions.find(({ resource }) => resource.kind === 'ledger-schema')
        ?.preconditionId,
    );
  });

  test('previews an exact legacy project-config migration without changing bytes', async () => {
    const state = await fixture();
    const row = declaration('codex', 'copy');
    const resolved: ResolvedPlanDeclaration = {
      declaration: row,
      tool: 'codex',
      lock: pinFor(row, digest('c')),
    };
    const input = productInput(state.root, [resolved]);
    const semanticRevision = input.observed.manifest.semanticRevision;
    if (semanticRevision === null) throw new Error('fixture manifest lacks semantic revision');
    const resultSource = 'version = 1\n';
    const resultByteRevision = digest('2');
    const expectedOperationByteHash = hashManifestBytes(input.observed.manifest.source);
    const resultOperationByteHash = hashManifestBytes(resultSource);
    expect(expectedOperationByteHash).not.toBe(input.observed.manifest.byteRevision);
    expect(resultOperationByteHash).not.toBe(resultByteRevision);
    const result = await reconcile(
      {
        ...input,
        observed: {
          ...input.observed,
          manifest: {
            ...input.observed.manifest,
            sourceVersion: 'legacy',
            canonical: false,
            migration: {
              kind: 'migrate-project-config',
              from: 'legacy',
              toVersion: 1,
              expectedByteRevision: input.observed.manifest.byteRevision,
              expectedSemanticRevision: semanticRevision,
              resultByteRevision,
              resultSemanticRevision: semanticRevision,
              resultSource,
              createsLockfile: false,
            },
          },
        },
      },
      state,
    );
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.plan.operations.map(({ kind }) => kind)).toEqual([
      'migrate-project-config',
      'install',
    ]);
    expect(result.value.plan.operations[0]).toMatchObject({
      before: {
        kind: 'manifest',
        shape: 'legacy',
        byteHash: expectedOperationByteHash,
      },
      after: {
        kind: 'manifest',
        shape: 'canonical',
        byteHash: resultOperationByteHash,
      },
    });
    expect(createSavedPlan(result.value).ok).toBeTrue();
  });

  test('emits noop for byte-identical converged copy and update after content drift', async () => {
    const state = await fixture();
    const live = join(state.ports.homeDir, '.agents', 'skills', 'alpha');
    await mkdir(live, { recursive: true });
    await writeFile(join(live, 'SKILL.md'), '# Alpha\n');
    const row = declaration();
    const resolved: ResolvedPlanDeclaration = {
      declaration: row,
      tool: 'codex',
      lock: pinFor(row, await contentHash(state.ports, live)),
    };
    const storePath = join(
      state.root,
      'data',
      'store',
      'acme',
      `skills@${SHA.slice(0, 12)}`,
      'alpha',
    );
    await mkdir(storePath, { recursive: true });
    await writeFile(join(storePath, 'SKILL.md'), '# Alpha\n');
    const convergedPair = pairFor(row, resolved.lock, live, storePath);
    const ownedInput = withLedger(
      productInput(state.root, [resolved]),
      state.root,
      ledgerFor(state.root, [
        {
          scope: 'user',
          row,
          tool: 'codex',
          pair: withPinnedContentHash(convergedPair, digest('9')),
        },
      ]),
    );
    const converged = await reconcile(ownedInput, state);
    expect(converged.ok).toBeTrue();
    if (!converged.ok) throw new Error(converged.error.message);
    expect(converged.value.plan.operations).toEqual([]);
    expect(converged.value.plan.diagnostics).toMatchObject([{ kind: 'noop' }]);

    await writeFile(join(live, 'SKILL.md'), '# Drifted\n');
    const drifted = await reconcile(ownedInput, state);
    expect(drifted.ok).toBeTrue();
    if (!drifted.ok) throw new Error(drifted.error.message);
    expect(drifted.value.plan.operations).toMatchObject([
      { kind: 'update', before: { kind: 'placement' }, after: { kind: 'placement' } },
    ]);
  });

  test('classifies unmanaged and modified managed targets with exact before images and preconditions', async () => {
    const state = await fixture();
    const live = join(state.ports.homeDir, '.agents', 'skills', 'alpha');
    await mkdir(live, { recursive: true });
    await writeFile(join(live, 'SKILL.md'), '# Local\n');
    const liveHash = await contentHash(state.ports, live);
    const row = declaration();
    const lockedHash = digest('c');
    const resolved: ResolvedPlanDeclaration = {
      declaration: row,
      tool: 'codex',
      lock: pinFor(row, lockedHash),
    };

    const unmanaged = await reconcile(productInput(state.root, [resolved]), state);
    expect(unmanaged.ok).toBeTrue();
    if (!unmanaged.ok) throw new Error(unmanaged.error.message);
    expect(unmanaged.value.plan.operations).toMatchObject([
      {
        kind: 'update',
        before: { classification: 'unmanaged', contentHash: liveHash },
        conflict: { class: 'unmanaged-target', normal: 'refuse', backup: 'required' },
      },
    ]);
    expect(unmanaged.value.plan.operations[0]?.preconditionIds.length).toBeGreaterThanOrEqual(2);
    expect(
      unmanaged.value.plan.operations[0]?.preconditionIds.every((id) =>
        /^precondition:v1:[0-9a-f]{64}$/u.test(id),
      ),
    ).toBeTrue();

    const storePath = storePathFor(state.root, row, resolved.lock);
    const managedInput = withLedger(
      productInput(state.root, [resolved]),
      state.root,
      ledgerFor(state.root, [
        {
          scope: 'user',
          row,
          tool: 'codex',
          pair: pairFor(row, resolved.lock, live, storePath),
        },
      ]),
    );
    const modified = await reconcile(managedInput, state);
    expect(modified.ok).toBeTrue();
    if (!modified.ok) throw new Error(modified.error.message);
    expect(modified.value.plan.operations).toMatchObject([
      {
        kind: 'update',
        before: { classification: 'pinned', contentHash: liveHash },
        conflict: { class: 'modified-managed-target', normal: 'refuse', backup: 'required' },
      },
    ]);
  });

  test('uses update for relinking and repair for a ledger-owned broken link', async () => {
    const state = await fixture();
    const live = join(state.ports.homeDir, '.agents', 'skills', 'alpha');
    await mkdir(live, { recursive: true });
    await writeFile(join(live, 'SKILL.md'), '# Alpha\n');
    const hash = await contentHash(state.ports, live);
    const row = declaration('codex', 'symlink');
    const resolved: ResolvedPlanDeclaration = {
      declaration: row,
      tool: 'codex',
      lock: pinFor(row, hash),
    };
    const storePath = join(
      state.root,
      'data',
      'store',
      'acme',
      `skills@${SHA.slice(0, 12)}`,
      'alpha',
    );
    await mkdir(storePath, { recursive: true });
    await writeFile(join(storePath, 'SKILL.md'), '# Alpha\n');
    const input = withLedger(
      productInput(state.root, [resolved]),
      state.root,
      ledgerFor(state.root, [
        {
          scope: 'user',
          row,
          tool: 'codex',
          pair: pairFor(row, resolved.lock, live, storePath, 'copy'),
        },
      ]),
    );
    const relink = await reconcile(input, state);
    expect(relink.ok).toBeTrue();
    if (!relink.ok) throw new Error(relink.error.message);
    expect(relink.value.plan.operations).toMatchObject([
      { kind: 'update', reason: { code: 'desired-placement-relink' } },
    ]);

    await rm(live, { recursive: true, force: true });
    await symlink(storePath, live);
    await rm(storePath, { recursive: true, force: true });
    const broken = await reconcile(
      withLedger(
        productInput(state.root, [resolved]),
        state.root,
        ledgerFor(state.root, [
          {
            scope: 'user',
            row,
            tool: 'codex',
            pair: pairFor(row, resolved.lock, live, storePath, 'symlink'),
          },
        ]),
      ),
      state,
    );
    expect(broken.ok).toBeTrue();
    if (!broken.ok) throw new Error(broken.error.message);
    expect(broken.value.plan.operations).toMatchObject([
      { kind: 'repair', before: { dangling: true }, reason: { code: 'desired-placement-repair' } },
    ]);
  });

  test('moves an unambiguous ledger-owned opposite-scope placement', async () => {
    const state = await fixture();
    const userLive = join(state.ports.homeDir, '.agents', 'skills', 'alpha');
    await mkdir(userLive, { recursive: true });
    await writeFile(join(userLive, 'SKILL.md'), '# Alpha\n');
    const hash = await contentHash(state.ports, userLive);
    const row = { ...declaration(), scope: 'project' as const };
    const resolved: ResolvedPlanDeclaration = {
      declaration: row,
      tool: 'codex',
      lock: pinFor(row, hash),
    };
    const storePath = join(
      state.root,
      'data',
      'store',
      'acme',
      `skills@${SHA.slice(0, 12)}`,
      'alpha',
    );
    const input = withLedger(
      productInput(state.root, [resolved]),
      state.root,
      ledgerFor(state.root, [
        {
          scope: 'user',
          row,
          tool: 'codex',
          pair: withPinnedContentHash(
            pairFor(row, resolved.lock, userLive, storePath),
            digest('9'),
          ),
        },
      ]),
    );
    const result = await reconcile(input, state);
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.plan.operations).toMatchObject([
      {
        kind: 'move-scope',
        scope: 'project',
        before: { resource: { scope: 'user', location: { path: userLive } } },
        after: { resource: { scope: 'project' } },
      },
    ]);
    expect(result.value.plan.operations[0]?.preconditionIds).toHaveLength(5);
  });

  test('moves an exact ledger-owned custom opposite-scope placement', async () => {
    const state = await fixture();
    const customUserLive = join(state.ports.homeDir, 'team-skills', 'alpha');
    await mkdir(customUserLive, { recursive: true });
    await writeFile(join(customUserLive, 'SKILL.md'), '# Alpha\n');
    const hash = await contentHash(state.ports, customUserLive);
    const desired = { ...declaration(), scope: 'project' as const };
    const row: ResolvedPlanDeclaration = {
      declaration: desired,
      tool: 'codex',
      lock: pinFor(desired, hash),
    };
    const input = withLedger(
      productInput(state.root, [row]),
      state.root,
      ledgerFor(state.root, [
        {
          scope: 'user',
          row: desired,
          tool: 'codex',
          pair: pairFor(
            desired,
            row.lock,
            customUserLive,
            storePathFor(state.root, desired, row.lock),
          ),
        },
      ]),
    );

    const result = await reconcile(input, state);
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.plan.operations).toMatchObject([
      {
        kind: 'move-scope',
        before: { resource: { scope: 'user', location: { path: customUserLive } } },
        after: { resource: { scope: 'project' } },
      },
    ]);
    expect(result.value.machineBoundLivePaths).toEqual([customUserLive]);
  });

  test('refuses unmanaged, modified, wrong-source, and duplicate opposite-scope shadows', async () => {
    const cases = [
      { kind: 'unmanaged', reasonCode: 'plan-opposite-placement-unmanaged' },
      { kind: 'modified', reasonCode: 'plan-opposite-placement-modified' },
      { kind: 'wrong-source', reasonCode: 'plan-opposite-placement-source-changed' },
      { kind: 'duplicate', reasonCode: 'plan-opposite-placement-ambiguous' },
    ] as const;

    for (const selected of cases) {
      const state = await fixture();
      const userLive = join(state.ports.homeDir, '.agents', 'skills', 'alpha');
      await mkdir(userLive, { recursive: true });
      await writeFile(join(userLive, 'SKILL.md'), '# Alpha\n');
      if (selected.kind === 'duplicate') {
        const legacyLive = join(state.ports.homeDir, '.codex', 'skills', 'alpha');
        await mkdir(legacyLive, { recursive: true });
        await writeFile(join(legacyLive, 'SKILL.md'), '# Alpha\n');
      }
      const hash = await contentHash(state.ports, userLive);
      const desired = { ...declaration(), scope: 'project' as const };
      const row: ResolvedPlanDeclaration = {
        declaration: desired,
        tool: 'codex',
        lock: pinFor(desired, selected.kind === 'modified' ? digest('c') : hash),
      };
      let input = productInput(state.root, [row]);
      if (selected.kind === 'modified' || selected.kind === 'wrong-source') {
        const storePath = storePathFor(state.root, desired, row.lock);
        const pair = pairFor(desired, row.lock, userLive, storePath);
        if (pair.origin === undefined) throw new Error('fixture pair lacks origin');
        const selectedPair: LedgerPairV1Dto =
          selected.kind === 'wrong-source'
            ? { ...pair, origin: { ...pair.origin, repo: 'other/skills' } }
            : pair;
        input = withLedger(
          input,
          state.root,
          ledgerFor(state.root, [
            {
              scope: 'user',
              row: desired,
              tool: 'codex',
              pair: selectedPair,
            },
          ]),
        );
      }

      const observed = await observeReconcileInput(input, state);
      expect(observed.ok, selected.kind).toBeTrue();
      if (!observed.ok) throw new Error(observed.error.message);
      const refused = observed.value.desiredPlacements[0];
      expect(refused, selected.kind).toMatchObject({
        state: 'refused',
        refusalClass: 'state',
        reasonCode: selected.reasonCode,
        path: userLive,
      });
      if (refused?.state !== 'refused') throw new Error('expected an observed refusal');
      expect(Object.isFrozen(refused.evidence), selected.kind).toBeTrue();
      expect(refused.evidence.length, selected.kind).toBeGreaterThanOrEqual(2);

      const result = createReconcilePlan(observed.value);
      expect(result.ok, selected.kind).toBeTrue();
      if (!result.ok) throw new Error(result.error.message);
      expect(result.value.plan.operations, selected.kind).toEqual([]);
      expect(result.value.plan.diagnostics, selected.kind).toMatchObject([
        {
          kind: 'refuse',
          refusalClass: 'state',
          affected: { path: { kind: 'machine-bound', path: userLive } },
          reason: { code: selected.reasonCode },
        },
      ]);
      expect(result.value.resourcePreconditions.length, selected.kind).toBeGreaterThanOrEqual(4);
      expect(
        result.value.resourcePreconditions.some(
          ({ resource, expectedState }) =>
            resource.kind === 'live' && resource.scope === 'project' && expectedState === 'absent',
        ),
        selected.kind,
      ).toBeTrue();
      expect(
        result.value.resourcePreconditions.some(
          ({ resource, expectedState }) =>
            resource.kind === 'live' && resource.scope === 'user' && expectedState === 'present',
        ),
        selected.kind,
      ).toBeTrue();
    }
  });

  test('observes signed custom user/project roots and saves their exact paths as machine-bound', async () => {
    for (const selected of [
      { scope: 'user' as const, path: '~/custom-skills', base: 'home' as const },
      { scope: 'user' as const, path: 'custom-skills', base: 'cwd' as const },
      { scope: 'project' as const, path: './custom-skills', base: 'project' as const },
      { scope: 'project' as const, path: 'custom-skills', base: 'project' as const },
    ]) {
      const state = await fixture();
      const nestedCwd = join(state.root, 'packages', 'client');
      await mkdir(nestedCwd, { recursive: true });
      const desired = { ...declaration(), scope: selected.scope, path: selected.path };
      const row = {
        declaration: desired,
        tool: 'codex' as const,
        lock: pinFor(desired, digest('d')),
      };
      const baseInput = productInput(state.root, [row]);
      const input: ResolvedPlanInput = {
        ...baseInput,
        observed: {
          ...baseInput.observed,
          project: { ...baseInput.observed.project, effectiveCwd: nestedCwd },
        },
      };
      const expectedBase =
        selected.base === 'home'
          ? state.ports.homeDir
          : selected.base === 'cwd'
            ? nestedCwd
            : state.root;
      const observed = await observeReconcileInput(input, {
        ports: state.ports,
        configuration: state.configuration,
      });
      expect(observed.ok).toBeTrue();
      if (!observed.ok) throw new Error(observed.error.message);
      const placement = observed.value.desiredPlacements[0];
      expect(placement).toMatchObject({
        state: 'observed',
        binding: 'custom',
        placement: {
          root: join(expectedBase, 'custom-skills'),
        },
      });

      const planned = createReconcilePlan(observed.value);
      expect(planned.ok).toBeTrue();
      if (!planned.ok) throw new Error(planned.error.message);
      const livePath = join(expectedBase, 'custom-skills', 'alpha');
      expect(planned.value.machineBoundLivePaths).toEqual([livePath]);
      const saved = createSavedPlan(planned.value);
      if (!saved.ok) throw new Error(saved.error.message);
      expect(saved.ok).toBeTrue();
      expect(saved.value.operations[0]?.after).toMatchObject({
        kind: 'placement',
        resource: { location: { kind: 'machine-bound', path: livePath } },
      });
      expect(saved.value.portability).toMatchObject({
        kind: 'machine-bound',
        reasons: [{ code: 'absolute-live-placement', path: livePath }],
      });
    }
  });

  test('classifies custom and standard target ambiguity as state with exact affected path', async () => {
    const state = await fixture();
    const desired = { ...declaration(), path: '~/custom-skills' };
    const row: ResolvedPlanDeclaration = {
      declaration: desired,
      tool: 'codex',
      lock: pinFor(desired, digest('d')),
    };
    const customLive = join(state.ports.homeDir, 'custom-skills', 'alpha');
    const standardLive = join(state.ports.homeDir, '.agents', 'skills', 'alpha');
    for (const path of [customLive, standardLive]) {
      await mkdir(path, { recursive: true });
      await writeFile(join(path, 'SKILL.md'), '# Ambiguous\n');
    }

    const observed = await observeReconcileInput(productInput(state.root, [row]), state);
    expect(observed.ok).toBeTrue();
    if (!observed.ok) throw new Error(observed.error.message);
    expect(observed.value.desiredPlacements).toMatchObject([
      {
        state: 'refused',
        refusalClass: 'state',
        reasonCode: 'plan-placement-ambiguous',
        path: customLive,
        evidence: [{ placement: { path: customLive } }, { placement: { path: standardLive } }],
      },
    ]);
    const result = createReconcilePlan(observed.value);
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.plan.operations).toEqual([]);
    expect(result.value.machineBoundLivePaths).toEqual([customLive]);
    expect(result.value.plan.diagnostics).toMatchObject([
      {
        kind: 'refuse',
        refusalClass: 'state',
        affected: { path: { path: customLive } },
        reason: { code: 'plan-placement-ambiguous' },
      },
    ]);
  });

  test('retains supported operations beside explicit read-only capability refusal', async () => {
    const state = await fixture();
    const codex = declaration('codex');
    const kilo = declaration('kilo-code');
    const rows: ResolvedPlanDeclaration[] = [
      { declaration: codex, tool: 'codex', lock: pinFor(codex, digest('c')) },
      {
        declaration: kilo,
        tool: 'kilo-code',
        lock: pinFor(kilo, digest('d')),
      },
    ];
    const result = await reconcile(productInput(state.root, rows), state);
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.plan.operations).toMatchObject([{ tool: 'codex', kind: 'install' }]);
    expect(result.value.plan.diagnostics).toMatchObject([
      {
        kind: 'refuse',
        refusalClass: 'capability',
        affected: { tool: 'kilo-code', path: null },
        reason: { code: 'plan-capability-unavailable' },
      },
    ]);
  });

  test('refuses a muse project declaration the adapter does not manage', async () => {
    const state = await fixture();
    const base = declaration('codex');
    const museProject: NormalizedManifestDeclaration = {
      ...base,
      name: 'gamma',
      source: { ...base.source, path: 'skills/gamma' },
      tools: ['muse'],
      scope: 'project',
    };
    const rows: ResolvedPlanDeclaration[] = [
      { declaration: museProject, tool: 'muse', lock: pinFor(museProject, digest('e')) },
    ];
    const result = await reconcile(productInput(state.root, rows), state);
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.plan.operations).toEqual([]);
    expect(result.value.plan.diagnostics).toMatchObject([
      {
        kind: 'refuse',
        refusalClass: 'capability',
        affected: { tool: 'muse', path: null },
        reason: { code: 'plan-placement-scope-unsupported' },
      },
    ]);
  });

  test('prunes only a lock-owned managed placement with matching observed content', async () => {
    const state = await fixture();
    const live = join(state.ports.homeDir, '.agents', 'skills', 'orphan');
    await mkdir(live, { recursive: true });
    await writeFile(join(live, 'SKILL.md'), '# Orphan\n');
    const alpha = declaration('codex');
    const orphan: NormalizedManifestDeclaration = {
      ...alpha,
      name: 'orphan',
      source: { ...alpha.source, path: 'skills/orphan' },
    };
    const alphaRow: ResolvedPlanDeclaration = {
      declaration: alpha,
      tool: 'codex',
      lock: pinFor(alpha, digest('c')),
    };
    const orphanPin = pinFor(orphan, await contentHash(state.ports, live));
    const base = productInput(state.root, [alphaRow]);
    const baseLock = base.observed.lock;
    expect(baseLock.state).toBe('present');
    if (baseLock.state !== 'present') throw new Error('missing fixture lock');
    const lockModel = {
      ...baseLock.model,
      skills: [...baseLock.model.skills, orphanPin],
    };
    const ownedPair = withPinnedContentHash(
      pairFor(orphan, orphanPin, live, storePathFor(state.root, orphan, orphanPin)),
      digest('9'),
    );
    const input: ResolvedPlanInput = withLedger(
      {
        ...base,
        request: { ...base.request, prune: true },
        observed: {
          ...base.observed,
          relationship: {
            state: 'stale',
            facts: [{ reason: 'extra-entry', name: 'orphan', field: 'skills.name' }],
          },
          lock: {
            ...baseLock,
            state: 'present',
            model: lockModel,
          },
        },
      },
      state.root,
      ledgerFor(state.root, [{ scope: 'user', row: orphan, tool: 'codex', pair: ownedPair }]),
    );
    const result = await reconcile(input, state);
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.plan.operations).toMatchObject([
      { kind: 'install', skill: 'alpha' },
      { kind: 'remove', skill: 'orphan', before: { kind: 'placement' }, after: { kind: 'absent' } },
    ]);

    const mismatched: ResolvedPlanInput = {
      ...input,
      observed: {
        ...input.observed,
        lock: {
          ...baseLock,
          state: 'present',
          model: {
            ...lockModel,
            skills: [alphaRow.lock, { ...orphanPin, contentHash: digest('f') }],
          },
        },
      },
    };
    const protectedResult = await reconcile(mismatched, state);
    expect(protectedResult.ok).toBeTrue();
    if (!protectedResult.ok) throw new Error(protectedResult.error.message);
    expect(
      protectedResult.value.plan.operations.some((operation) => operation.kind === 'remove'),
    ).toBeFalse();

    const { ledger: _ledger, ...observedWithoutLedger } = input.observed;
    const lockOnly = await reconcile({ ...input, observed: observedWithoutLedger }, state);
    expect(lockOnly.ok).toBeTrue();
    if (!lockOnly.ok) throw new Error(lockOnly.error.message);
    expect(
      lockOnly.value.plan.operations.some((operation) => operation.kind === 'remove'),
    ).toBeFalse();

    const ownedOrigin = ownedPair.origin;
    if (ownedOrigin === undefined) throw new Error('owned prune pair lacks fixture origin');
    const wrongSourcePair: LedgerPairV1Dto = {
      ...ownedPair,
      origin: {
        ...ownedOrigin,
        source: 'https://fixture.invalid/other/skills//skills/orphan',
        repo: 'other/skills',
      },
    };
    const excludedLedgers = [
      ledgerFor(state.root, [{ scope: 'user', row: orphan, tool: 'codex', pair: wrongSourcePair }]),
      ledgerFor(state.root, [{ scope: 'project', row: orphan, tool: 'codex', pair: ownedPair }]),
      ledgerFor(state.root, [{ scope: 'user', row: orphan, tool: 'kilo-code', pair: ownedPair }]),
    ];
    for (const excludedLedger of excludedLedgers) {
      const excluded = await reconcile(withLedger(input, state.root, excludedLedger), state);
      expect(excluded.ok).toBeTrue();
      if (!excluded.ok) throw new Error(excluded.error.message);
      expect(
        excluded.value.plan.operations.some((operation) => operation.kind === 'remove'),
      ).toBeFalse();
    }

    const beta: NormalizedManifestDeclaration = {
      ...alpha,
      name: 'beta',
      source: { ...alpha.source, path: 'skills/beta' },
      tools: ['claude-code'],
      scope: 'project',
    };
    const betaRow: ResolvedPlanDeclaration = {
      declaration: beta,
      tool: 'claude-code',
      lock: pinFor(beta, digest('e')),
    };
    const mixedBase = productInput(state.root, [alphaRow, betaRow]);
    const mixedLock = mixedBase.observed.lock;
    if (mixedLock.state !== 'present') throw new Error('missing mixed fixture lock');
    const cartesian = withLedger(
      {
        ...mixedBase,
        request: { ...mixedBase.request, prune: true },
        observed: {
          ...mixedBase.observed,
          relationship: {
            state: 'stale',
            facts: [{ reason: 'extra-entry', name: 'orphan', field: 'skills.name' }],
          },
          lock: {
            ...mixedLock,
            model: { ...mixedLock.model, skills: [...mixedLock.model.skills, orphanPin] },
          },
        },
      },
      state.root,
      ledgerFor(state.root, [{ scope: 'project', row: orphan, tool: 'codex', pair: ownedPair }]),
    );
    const cartesianResult = await reconcile(cartesian, state);
    expect(cartesianResult.ok).toBeTrue();
    if (!cartesianResult.ok) throw new Error(cartesianResult.error.message);
    expect(
      cartesianResult.value.plan.operations.some(
        (operation) => operation.kind === 'remove' && operation.skill === 'orphan',
      ),
    ).toBeFalse();
  });

  test('keeps undeclared live placements visible without granting removal authority', async () => {
    const state = await fixture();
    const canary = join(state.ports.homeDir, '.agents', 'skills', 'canary');
    await mkdir(canary, { recursive: true });
    await writeFile(join(canary, 'SKILL.md'), '# Unmanaged canary\n');
    const alpha = declaration('codex');
    const row: ResolvedPlanDeclaration = {
      declaration: alpha,
      tool: 'codex',
      lock: pinFor(alpha, digest('c')),
    };

    for (const prune of [false, true]) {
      const input = productInput(state.root, [row]);
      const result = await reconcile({ ...input, request: { ...input.request, prune } }, state);
      expect(result.ok).toBeTrue();
      if (!result.ok) throw new Error(result.error.message);
      expect(
        result.value.plan.operations.some(
          (operation) => operation.kind === 'remove' && operation.skill === 'canary',
        ),
      ).toBeFalse();
      expect(result.value.plan.diagnostics).toContainEqual(
        expect.objectContaining({
          kind: 'warning',
          severity: 'warning',
          refusalClass: null,
          affected: expect.objectContaining({
            skill: 'canary',
            tool: 'codex',
            scope: 'user',
            path: { kind: 'machine-bound', path: canary },
          }),
          reason: expect.objectContaining({ code: 'plan-undeclared-placement-preserved' }),
        }),
      );
    }
  });
});
