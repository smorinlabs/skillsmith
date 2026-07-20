import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ArtifactDigest,
  hashCanonicalInput,
  hashManifestSemantics,
} from '../../src/artifacts/hash.ts';
import { type PortableLockV1, hashPortableLock } from '../../src/artifacts/lock.ts';
import type { SavedPlanV1 } from '../../src/artifacts/plan-types.ts';
import { artifactContractRegistry } from '../../src/artifacts/registry.ts';
import type { NormalizedManifestV1 } from '../../src/artifacts/types.ts';
import type { OperationDigest } from '../../src/planning/types.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';
import type { ResolvedRuntimeConfiguration, RuntimePorts } from '../../src/ports/types.ts';
import { observeReconcileInput } from '../../src/reconcile/observe.ts';
import { createReconcilePlan } from '../../src/reconcile/plan.ts';
import {
  createSavedPlan,
  createSavedPlanProjection,
  createSavedPlanScopedArtifactFacts,
} from '../../src/reconcile/saved.ts';
import type { ResolvedPlanInput } from '../../src/reconcile/types.ts';

const roots: string[] = [];
const digest = (character: string): ArtifactDigest =>
  `sha256:${character.repeat(64)}` as ArtifactDigest;
const operationDigest = (character: string): OperationDigest => `sha256:${character.repeat(64)}`;

const validatesAsSavedPlan = (value: unknown): boolean =>
  artifactContractRegistry.get('plan', 1)?.toDto(value).ok === true;

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

const fixture = async (
  portable: boolean,
  withOperation = false,
  missingLock = false,
  scope: 'user' | 'project' = 'user',
  legacyLedger = false,
  legacyManifest = false,
) => {
  const root = await mkdtemp(join(tmpdir(), 'skillsmith-saved-plan-'));
  roots.push(root);
  const base = await defaultRuntimePorts();
  const ports: RuntimePorts = { ...base, homeDir: join(root, 'home') };
  const declaration = {
    name: 'alpha',
    source: { host: 'fixture.invalid', repository: 'acme/skills', path: 'skills/alpha' },
    ref: null,
    tools: ['codex'] as const,
    scope,
    placement: 'copy' as const,
    path: null,
  };
  const model: NormalizedManifestV1 = {
    version: 1,
    skills: withOperation ? [declaration] : [],
  };
  const pin = {
    name: 'alpha',
    source: 'fixture.invalid/acme/skills//skills/alpha',
    requestedRef: null,
    resolvedSha: 'd'.repeat(40),
    sourcePath: 'skills/alpha',
    contentHash: digest('d'),
  };
  const lock: PortableLockV1 = {
    version: 1,
    hashSchemaVersion: 1,
    manifestHash: hashManifestSemantics(model),
    skills: withOperation ? [pin] : [],
  };
  const input: ResolvedPlanInput = {
    observed: {
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
          token: portable ? './skillsmith.toml' : join(root, 'skillsmith.toml'),
          path: join(root, 'skillsmith.toml'),
          portability: portable ? 'portable' : 'machine-bound',
          portableToken: portable ? './skillsmith.toml' : null,
        },
        lockfile: {
          token: portable ? null : join(root, 'skillsmith.lock'),
          path: join(root, 'skillsmith.lock'),
          portability: portable ? 'portable' : 'machine-bound',
          portableToken: portable ? './skillsmith.lock' : null,
        },
        lockfileSource: 'sibling',
      },
      manifest: {
        state: 'present',
        artifact: 'manifest',
        sourceVersion: legacyManifest ? 'legacy' : 1,
        currentVersion: 1,
        source: 'version = 1\n',
        byteLength: 12,
        byteRevision: digest('a'),
        semanticRevision: hashManifestSemantics(model),
        model,
        canonical: !legacyManifest,
        migration: legacyManifest
          ? {
              kind: 'migrate-project-config' as const,
              from: 'legacy' as const,
              toVersion: 1 as const,
              expectedByteRevision: digest('a'),
              expectedSemanticRevision: hashManifestSemantics(model),
              resultByteRevision: digest('2'),
              resultSemanticRevision: hashManifestSemantics(model),
              resultSource: 'version = 1\n',
              createsLockfile: false,
            }
          : null,
      },
      lock: missingLock
        ? { state: 'absent', artifact: 'lock', migration: null }
        : {
            state: 'present',
            artifact: 'lock',
            sourceVersion: 1,
            currentVersion: 1,
            source: 'version = 1\n',
            byteLength: 12,
            byteRevision: digest('b'),
            semanticRevision: digest('c'),
            model: lock,
            canonical: true,
            migration: null,
          },
      relationship: missingLock ? { state: 'missing-lock' } : { state: 'current' },
      ...(legacyLedger
        ? {
            ledgerPath: join(root, 'placements.json'),
            ledger: {
              state: 'present' as const,
              artifact: 'ledger' as const,
              sourceVersion: 1 as const,
              currentVersion: 2 as const,
              source: '{}',
              byteLength: 2,
              byteRevision: digest('e'),
              semanticRevision: digest('f'),
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
                kind: 'ledger-v1-to-v2' as const,
                fromSchemaVersion: 1 as const,
                toSchemaVersion: 2 as const,
                sourceByteRevision: digest('e'),
                sourceSemanticRevision: digest('f'),
                targetSemanticRevision: digest('f'),
                targetByteRevision: digest('1'),
                targetCanonicalSource: '{}\n',
                preservedLegacyJournals: [],
              },
            },
          }
        : {}),
    },
    request: { tools: [], scope: null, locked: !missingLock, prune: false, check: false },
    declarations: withOperation ? [{ declaration, tool: 'codex', lock: pin }] : [],
    selectedSkills: withOperation ? ['alpha'] : [],
    selectedTools: withOperation ? ['codex'] : [],
    selectedScopes: withOperation ? [scope] : [],
    selectionOutcome: 'selected',
    replacementLock: missingLock ? lock : null,
  };
  const observed = await observeReconcileInput(input, {
    ports,
    configuration: configuration(root),
  });
  expect(observed.ok).toBeTrue();
  if (!observed.ok) throw new Error(observed.error.message);
  const planned = createReconcilePlan(observed.value);
  expect(planned.ok).toBeTrue();
  if (!planned.ok) throw new Error(planned.error.message);
  return { root, lock, product: planned.value };
};

const scopedFixture = () => {
  const manifest: NormalizedManifestV1 = {
    version: 1,
    skills: [
      {
        name: 'alpha',
        source: { host: 'fixture.invalid', repository: 'acme/alpha', path: 'skills/alpha' },
        ref: 'main',
        tools: ['kilo-code', 'codex'],
        scope: 'user',
        placement: 'copy',
        path: null,
      },
      {
        name: 'beta',
        source: { host: 'fixture.invalid', repository: 'acme/beta', path: 'skills/beta' },
        ref: 'main',
        tools: ['opencode'],
        scope: 'project',
        placement: 'symlink',
        path: null,
      },
    ],
  };
  const pin = (name: string, character: 'a' | 'b' | 'c') => ({
    name,
    source: `fixture.invalid/acme/${name}//skills/${name}`,
    requestedRef: 'main',
    resolvedSha: character.repeat(40),
    sourcePath: `skills/${name}`,
    contentHash: digest(character),
  });
  const lock: PortableLockV1 = {
    version: 1,
    hashSchemaVersion: 1,
    manifestHash: digest('f'),
    skills: [pin('alpha', 'a'), pin('beta', 'b'), pin('orphan', 'c')],
  };
  return { manifest, lock };
};

const scopedFacts = (
  manifest: NormalizedManifestV1,
  lock: PortableLockV1 | null,
  predicates: Parameters<typeof createSavedPlanScopedArtifactFacts>[0]['predicates'],
  prune = false,
) => {
  const result = createSavedPlanScopedArtifactFacts({ manifest, lock, predicates, prune });
  expect(result.ok).toBeTrue();
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

describe('saved scoped artifact facts', () => {
  const predicates = { skills: [], tools: ['codex'] as const, scopes: ['user'] as const };

  test('changes for selected rows but ignores declaration edits outside both predicates', () => {
    const state = scopedFixture();
    const baseline = scopedFacts(state.manifest, state.lock, predicates);
    expect(baseline).toMatchObject({
      selectedSkills: ['alpha'],
      selectedTools: ['codex'],
      selectedScopes: ['user'],
      selectionOutcome: 'selected',
    });
    const beta = state.manifest.skills[1];
    const alpha = state.manifest.skills[0];
    if (alpha === undefined || beta === undefined) throw new Error('missing scoped fixture row');

    const unrelated = scopedFacts(
      { ...state.manifest, skills: [alpha, { ...beta, ref: 'unrelated-edit' }] },
      state.lock,
      predicates,
    );
    expect(unrelated).toEqual(baseline);

    const unrelatedTool = scopedFacts(
      { ...state.manifest, skills: [{ ...alpha, tools: ['codex'] }, beta] },
      state.lock,
      predicates,
    );
    expect(unrelatedTool).toEqual(baseline);

    const selected = scopedFacts(
      { ...state.manifest, skills: [{ ...alpha, placement: 'symlink' }, beta] },
      state.lock,
      predicates,
    );
    expect(selected.scopedManifestSemanticHash).not.toBe(baseline.scopedManifestSemanticHash);
  });

  test('treats tool and scope independently and fingerprints a newly matching row', () => {
    const state = scopedFixture();
    const baseline = scopedFacts(state.manifest, state.lock, predicates);
    const alpha = state.manifest.skills[0];
    const beta = state.manifest.skills[1];
    if (alpha === undefined || beta === undefined) throw new Error('missing scoped fixture row');

    const toolOnly = scopedFacts(
      { ...state.manifest, skills: [alpha, { ...beta, tools: ['codex'] }] },
      state.lock,
      predicates,
    );
    const scopeOnly = scopedFacts(
      { ...state.manifest, skills: [alpha, { ...beta, scope: 'user' }] },
      state.lock,
      predicates,
    );
    expect(toolOnly).toEqual(baseline);
    expect(scopeOnly).toEqual(baseline);

    const newlyMatching = scopedFacts(
      {
        ...state.manifest,
        skills: [alpha, { ...beta, tools: ['codex'], scope: 'user' }],
      },
      state.lock,
      predicates,
    );
    expect(newlyMatching.scopedManifestSemanticHash).not.toBe(baseline.scopedManifestSemanticHash);
    expect(newlyMatching.scopedLockCanonicalHash).not.toBe(baseline.scopedLockCanonicalHash);
  });

  test('scopes lock pins and binds the complete orphan-pin set only for prune', () => {
    const state = scopedFixture();
    const baseline = scopedFacts(state.manifest, state.lock, predicates);
    const changedBetaLock = {
      ...state.lock,
      skills: state.lock.skills.map((pin) =>
        pin.name === 'beta' ? { ...pin, contentHash: digest('d') } : pin,
      ),
    };
    expect(scopedFacts(state.manifest, changedBetaLock, predicates)).toEqual(baseline);

    const changedAlphaLock = {
      ...state.lock,
      skills: state.lock.skills.map((pin) =>
        pin.name === 'alpha' ? { ...pin, contentHash: digest('e') } : pin,
      ),
    };
    expect(
      scopedFacts(state.manifest, changedAlphaLock, predicates).scopedLockCanonicalHash,
    ).not.toBe(baseline.scopedLockCanonicalHash);

    const pruneBaseline = scopedFacts(state.manifest, state.lock, predicates, true);
    const changedOrphanLock = {
      ...state.lock,
      skills: state.lock.skills.map((pin) =>
        pin.name === 'orphan' ? { ...pin, contentHash: digest('d') } : pin,
      ),
    };
    expect(
      scopedFacts(state.manifest, changedOrphanLock, predicates, true).scopedLockCanonicalHash,
    ).not.toBe(pruneBaseline.scopedLockCanonicalHash);
    expect(scopedFacts(state.manifest, changedOrphanLock, predicates)).toEqual(baseline);

    const alpha = state.manifest.skills[0];
    if (alpha === undefined) throw new Error('missing scoped fixture row');
    expect(
      scopedFacts({ ...state.manifest, skills: [alpha] }, state.lock, predicates, true)
        .scopedLockCanonicalHash,
    ).not.toBe(pruneBaseline.scopedLockCanonicalHash);
  });

  test('wildcards bind all rows and canonical ordering is deterministic', () => {
    const state = scopedFixture();
    const wildcard = { skills: [], tools: [], scopes: [] } as const;
    const baseline = scopedFacts(state.manifest, state.lock, wildcard);
    expect(baseline).toMatchObject({
      selectedSkills: ['alpha', 'beta'],
      selectedTools: ['codex', 'kilo-code', 'opencode'],
      selectedScopes: ['project', 'user'],
      selectionOutcome: 'selected',
    });
    const reordered = scopedFacts(
      {
        ...state.manifest,
        skills: [...state.manifest.skills]
          .reverse()
          .map((row) => ({ ...row, tools: [...row.tools].reverse() })),
      },
      { ...state.lock, skills: [...state.lock.skills].reverse() },
      wildcard,
    );
    expect(reordered).toEqual(baseline);

    const beta = state.manifest.skills[1];
    const alpha = state.manifest.skills[0];
    if (alpha === undefined || beta === undefined) throw new Error('missing scoped fixture row');
    expect(
      scopedFacts(
        { ...state.manifest, skills: [alpha, { ...beta, ref: 'wildcard-edit' }] },
        state.lock,
        wildcard,
      ).scopedManifestSemanticHash,
    ).not.toBe(baseline.scopedManifestSemanticHash);
  });

  test('retains explicit predicates for filter-noop and keeps an empty wildcard selected', () => {
    const state = scopedFixture();
    const noMatch = scopedFacts(state.manifest, state.lock, {
      skills: [],
      tools: ['claude-code'],
      scopes: ['project'],
    });
    expect(noMatch).toMatchObject({
      selectedSkills: [],
      selectedTools: ['claude-code'],
      selectedScopes: ['project'],
      selectionOutcome: 'filter-noop',
    });

    const emptyWildcard = scopedFacts({ version: 1, skills: [] }, state.lock, {
      skills: [],
      tools: [],
      scopes: [],
    });
    expect(emptyWildcard).toMatchObject({
      selectedSkills: [],
      selectedTools: [],
      selectedScopes: [],
      selectionOutcome: 'selected',
    });
  });
});

describe('saved plan projection', () => {
  test('tokenizes a portable project pair and contains no local absolute path', async () => {
    const state = await fixture(true);
    const saved = createSavedPlan(state.product);
    expect(saved.ok).toBeTrue();
    if (!saved.ok) throw new Error(saved.error.message);
    const lockHash = hashPortableLock(state.lock);
    expect(lockHash.ok).toBeTrue();
    if (!lockHash.ok) throw new Error(lockHash.error.message);
    expect(saved.value).toMatchObject({
      portability: { kind: 'portable', reasons: [] },
      artifactPair: {
        manifest: { kind: 'portable', token: 'project:skillsmith.toml' },
        lock: { kind: 'portable', token: 'project:skillsmith.lock' },
      },
      manifestSemanticHash: state.product.input.observed.manifest.semanticRevision,
      lockCanonicalHash: lockHash.value,
    });
    const scopedManifest = saved.value.resourcePreconditions.find(
      ({ expectedHash }) => expectedHash.domain === 'manifest-semantic',
    );
    const scopedLock = saved.value.resourcePreconditions.find(
      ({ expectedHash }) => expectedHash.domain === 'lock-canonical',
    );
    expect(scopedManifest?.expectedHash.digest).not.toBe(saved.value.manifestSemanticHash);
    expect(scopedLock?.expectedHash.digest).not.toBe(saved.value.lockCanonicalHash);
    expect(JSON.stringify(saved.value)).not.toContain(state.root);
    expect(validatesAsSavedPlan(saved.value)).toBeTrue();
  });

  test('encodes identical project-scoped plans byte-for-byte across different roots', async () => {
    const first = await fixture(true, true, false, 'project');
    const second = await fixture(true, true, false, 'project');
    const firstSaved = createSavedPlan(first.product);
    const secondSaved = createSavedPlan(second.product);
    expect(firstSaved.ok).toBeTrue();
    expect(secondSaved.ok).toBeTrue();
    if (!firstSaved.ok) throw new Error(firstSaved.error.message);
    if (!secondSaved.ok) throw new Error(secondSaved.error.message);

    const codec = artifactContractRegistry.get('plan', 1);
    expect(codec).toBeDefined();
    if (codec === undefined) throw new Error('missing saved plan codec');
    const firstBytes = codec.encode(firstSaved.value);
    const secondBytes = codec.encode(secondSaved.value);
    expect(firstBytes.ok).toBeTrue();
    expect(secondBytes.ok).toBeTrue();
    if (!firstBytes.ok) throw new Error(firstBytes.error.message);
    if (!secondBytes.ok) throw new Error(secondBytes.error.message);

    expect(firstSaved.value).toEqual(secondSaved.value);
    expect(firstBytes.value).toEqual(secondBytes.value);
    expect(JSON.stringify(firstSaved.value)).not.toContain(first.root);
    expect(JSON.stringify(secondSaved.value)).not.toContain(second.root);
  });

  test('round-trips capability scopes in their signed domain order', async () => {
    const state = await fixture(true, true);
    const saved = createSavedPlan(state.product);
    expect(saved.ok).toBeTrue();
    if (!saved.ok) throw new Error(saved.error.message);
    const capability = saved.value.capabilityPreconditions[0];
    if (capability === undefined) throw new Error('saved plan capability guard is missing');
    const scopes = ['user', 'project'] as const;
    const expectedHash = hashCanonicalInput(
      'capability',
      1,
      JSON.stringify([
        'skillsmith-capability-precondition',
        1,
        capability.tool,
        capability.operation,
        capability.capabilityVersion,
        true,
        scopes,
      ]),
    );
    if (!expectedHash.ok) throw new Error(expectedHash.error.message);
    const codec = artifactContractRegistry.get('plan', 1);
    if (codec === undefined) throw new Error('saved plan codec unavailable');
    const decoded = codec.toDto({
      ...saved.value,
      capabilityPreconditions: [
        { ...capability, scopes: ['project', 'user'], expectedHash: expectedHash.value },
      ],
    });
    expect(decoded.ok).toBeTrue();
    if (!decoded.ok) throw new Error(decoded.error.message);
    const roundTripped = (decoded.value as SavedPlanV1).capabilityPreconditions[0];
    expect(roundTripped?.scopes).toEqual(scopes);
    expect(
      roundTripped === undefined
        ? null
        : hashCanonicalInput(
            'capability',
            1,
            JSON.stringify([
              'skillsmith-capability-precondition',
              1,
              roundTripped.tool,
              roundTripped.operation,
              roundTripped.capabilityVersion,
              true,
              roundTripped.scopes,
            ]),
          ),
    ).toEqual({ ok: true, value: expectedHash.value });
  });

  test('tokenizes standard user and project refusal paths and messages identically across roots', async () => {
    const first = await fixture(true);
    const second = await fixture(true);
    const withWarnings = (state: Awaited<ReturnType<typeof fixture>>) => ({
      ...state.product,
      plan: {
        ...state.product.plan,
        diagnostics: (['user', 'project'] as const).map((scope, index) => {
          const path =
            scope === 'user'
              ? join(state.root, 'home', '.agents', 'skills', `${scope}-orphan`)
              : join(state.root, '.agents', 'skills', `${scope}-orphan`);
          return {
            diagnosticId: `diagnostic:v1:${String(index + 1).repeat(64)}`,
            kind: 'refuse' as const,
            severity: 'error' as const,
            refusalClass: 'state' as const,
            affected: {
              skill: `${scope}-orphan`,
              source: null,
              tool: 'codex' as const,
              scope,
              path: {
                kind: 'machine-bound' as const,
                path,
              },
            },
            correlation: { groupId: null, pairId: null, operationId: null },
            reason: {
              code: 'plan-standard-placement-refusal',
              message: `Standard placement at ${path} requires review.`,
            },
            selectionSource: 'bounded-default' as const,
          };
        }),
      },
    });
    const firstSaved = createSavedPlan(withWarnings(first));
    const secondSaved = createSavedPlan(withWarnings(second));
    expect(firstSaved.ok).toBeTrue();
    expect(secondSaved.ok).toBeTrue();
    if (!firstSaved.ok) throw new Error(firstSaved.error.message);
    if (!secondSaved.ok) throw new Error(secondSaved.error.message);

    expect(firstSaved.value).toEqual(secondSaved.value);
    expect(firstSaved.value.portability).toEqual({ kind: 'portable', reasons: [] });
    expect(firstSaved.value.diagnostics.map(({ affected }) => affected.path)).toEqual(
      expect.arrayContaining([
        { kind: 'portable', token: 'skills/user/codex/user-orphan' },
        { kind: 'portable', token: 'skills/project/codex/project-orphan' },
      ]),
    );
    expect(JSON.stringify(firstSaved.value)).not.toContain(first.root);
    expect(JSON.stringify(secondSaved.value)).not.toContain(second.root);
  });

  test('retains explicit absolute artifact selectors as exact machine bindings', async () => {
    const state = await fixture(false);
    const saved = createSavedPlan(state.product);
    expect(saved.ok).toBeTrue();
    if (!saved.ok) throw new Error(saved.error.message);
    expect(saved.value.portability).toMatchObject({ kind: 'machine-bound' });
    if (saved.value.portability.kind !== 'machine-bound') {
      throw new Error('absolute selector fixture must be machine-bound');
    }
    const resourcesById = new Map(
      saved.value.resourcePreconditions.map((precondition) => [
        precondition.preconditionId,
        precondition.resource,
      ]),
    );
    const absoluteReasons = saved.value.portability.reasons.filter(
      ({ code }) => code === 'absolute-artifact-selector',
    );
    expect(absoluteReasons).toMatchObject([
      { path: join(state.root, 'skillsmith.lock') },
      { path: join(state.root, 'skillsmith.toml') },
    ]);
    for (const reason of absoluteReasons) {
      expect(reason.preconditionIds.length).toBeGreaterThan(0);
      expect(
        reason.preconditionIds
          .map((id) => resourcesById.get(id))
          .every(
            (resource) =>
              (resource?.kind === 'manifest-bytes' || resource?.kind === 'lock') &&
              resource.location.kind === 'machine-bound' &&
              resource.location.path === reason.path,
          ),
      ).toBeTrue();
    }
    const projectReason = saved.value.portability.reasons.find(
      ({ code }) => code === 'local-project-root',
    );
    expect(projectReason).toMatchObject({ path: state.root });
    expect(
      projectReason?.preconditionIds
        .map((id) => resourcesById.get(id))
        .every(
          (resource) =>
            resource?.kind === 'project-context' &&
            resource.root.kind === 'machine-bound' &&
            resource.root.path === state.root,
        ),
    ).toBeTrue();
    expect(validatesAsSavedPlan(saved.value)).toBeTrue();
  });

  test('uses signed user tokens for a discovered default pair outside the project', async () => {
    const state = await fixture(false);
    const product = {
      ...state.product,
      input: {
        ...state.product.input,
        observed: {
          ...state.product.input.observed,
          artifactPortableTokens: {
            manifest: 'user:skillsmith.toml',
            lock: 'user:skillsmith.lock',
          },
        },
      },
    };
    const saved = createSavedPlan(product);
    expect(saved.ok).toBeTrue();
    if (!saved.ok) throw new Error(saved.error.message);
    expect(saved.value).toMatchObject({
      portability: { kind: 'portable', reasons: [] },
      artifactPair: {
        manifest: { kind: 'portable', token: 'user:skillsmith.toml' },
        lock: { kind: 'portable', token: 'user:skillsmith.lock' },
      },
    });
    expect(JSON.stringify(saved.value)).not.toContain(state.root);
  });

  test('binds each operation to scoped resource, selection, and capability preconditions', async () => {
    const state = await fixture(true, true);
    const saved = createSavedPlan(state.product);
    expect(saved.ok).toBeTrue();
    if (!saved.ok) throw new Error(saved.error.message);
    expect(saved.value.operations).toHaveLength(1);
    expect(saved.value.resourcePreconditions.map(({ resource }) => resource.kind)).toContain(
      'live',
    );
    expect(saved.value.resourcePreconditions.map(({ resource }) => resource.kind)).toContain(
      'ledger',
    );
    expect(saved.value.resourcePreconditions.map(({ resource }) => resource.kind)).toContain(
      'store',
    );
    expect(saved.value.selectionPreconditions).toMatchObject([
      {
        domain: 'selection-set',
        selectionSource: 'bounded-default',
        skills: [],
        tools: [],
        scopes: [],
      },
    ]);
    expect(saved.value.capabilityPreconditions).toMatchObject([
      { domain: 'capability', tool: 'codex', operation: 'plan', scopes: ['user'] },
    ]);
    expect(saved.value.checks.map(({ kind }) => kind).toSorted()).toEqual([
      'capability',
      'content-integrity',
    ]);
    const known = new Set(
      [
        ...saved.value.resourcePreconditions,
        ...saved.value.selectionPreconditions,
        ...saved.value.capabilityPreconditions,
      ].map(({ preconditionId }) => preconditionId),
    );
    expect(saved.value.operations[0]?.preconditionIds.every((id) => known.has(id))).toBeTrue();
    expect(
      saved.value.resourcePreconditions.every(({ preconditionId }) => known.has(preconditionId)),
    ).toBeTrue();
    expect(saved.value.capabilityPreconditions).toEqual(
      state.product.capabilityPreconditions.map((precondition) => ({
        ...precondition,
        scopes: [...precondition.scopes],
      })),
    );
    expect(validatesAsSavedPlan(saved.value)).toBeTrue();
  });

  test('exposes the exact validated operation precondition projection for report parity', async () => {
    const state = await fixture(true, true);
    const projection = createSavedPlanProjection(state.product);
    const saved = createSavedPlan(state.product);
    expect(projection.ok).toBeTrue();
    expect(saved.ok).toBeTrue();
    if (!projection.ok) throw new Error(projection.error.message);
    if (!saved.ok) throw new Error(saved.error.message);

    expect(projection.value.plan).toEqual(saved.value);
    for (const operation of projection.value.plan.operations) {
      expect(projection.value.operationPreconditionIds.get(operation.operationId)).toEqual(
        operation.preconditionIds,
      );
    }
  });

  test('reuses the root absent-lock precondition for a write-lock-only projection', async () => {
    const state = await fixture(true, false, true);
    expect(state.product.plan.operations).toMatchObject([{ kind: 'write-lock' }]);

    const projection = createSavedPlanProjection(state.product);
    expect(projection.ok).toBeTrue();
    if (!projection.ok) throw new Error(projection.error.message);

    const lockPreconditions = projection.value.plan.resourcePreconditions.filter(
      ({ resource }) => resource.kind === 'lock',
    );
    expect(lockPreconditions).toMatchObject([
      { expectedState: 'absent', expectedHash: { domain: 'lock-canonical' } },
    ]);
    expect(projection.value.plan.operations[0]?.preconditionIds).toContain(
      lockPreconditions[0]?.preconditionId,
    );
  });

  test('keeps one reviewed lock identity across a committed manifest migration replan', async () => {
    const combined = await fixture(true, false, true, 'user', false, true);
    const lockOnly = await fixture(true, false, true);
    expect(combined.product.plan.operations.map(({ kind }) => kind)).toEqual([
      'migrate-project-config',
      'write-lock',
    ]);
    const migration = combined.product.plan.operations[0];
    const combinedLock = combined.product.plan.operations[1];
    if (migration === undefined || combinedLock === undefined) {
      throw new Error('combined artifact group is incomplete');
    }
    expect(combinedLock.groupId).toBe(migration.groupId);
    expect(combinedLock.dependencyMetadata.operationIds).toEqual([migration.operationId]);

    const combinedProjection = createSavedPlanProjection(combined.product);
    const lockOnlyProjection = createSavedPlanProjection(lockOnly.product);
    expect(combinedProjection.ok).toBeTrue();
    expect(lockOnlyProjection.ok).toBeTrue();
    if (!combinedProjection.ok) throw new Error(combinedProjection.error.message);
    if (!lockOnlyProjection.ok) throw new Error(lockOnlyProjection.error.message);

    const reviewedLock = combinedProjection.value.plan.operations.find(
      ({ kind }) => kind === 'write-lock',
    );
    const replannedLock = lockOnlyProjection.value.plan.operations.find(
      ({ kind }) => kind === 'write-lock',
    );
    expect(replannedLock?.groupId).toBe(reviewedLock?.groupId);
    expect(replannedLock?.operationId).toBe(reviewedLock?.operationId);
  });

  test('retains the ledger-schema guard and adds a same-resource execution guard', async () => {
    const state = await fixture(true, true, false, 'user', true);
    const projection = createSavedPlanProjection(state.product);
    expect(projection.ok).toBeTrue();
    if (!projection.ok) throw new Error(projection.error.message);

    const migration = projection.value.plan.operations.find(
      ({ kind }) => kind === 'migrate-ledger',
    );
    expect(migration).toBeDefined();
    const schemaGuard = projection.value.plan.resourcePreconditions.find(
      ({ resource }) => resource.kind === 'ledger-schema',
    );
    const executionGuards = projection.value.plan.resourcePreconditions.filter(
      ({ resource }) => resource.kind === 'ledger' && resource.projectRoot === null,
    );
    const executionGuard = executionGuards[0];
    expect(executionGuards).toHaveLength(1);
    expect(schemaGuard).toMatchObject({
      expectedState: 'present',
      expectedRevision: { kind: 'artifact-bytes', digest: digest('e') },
    });
    expect(executionGuard).toMatchObject({
      expectedState: 'present',
      expectedRevision: { kind: 'artifact-bytes', digest: digest('e') },
    });
    expect(migration?.preconditionIds).toContain(schemaGuard?.preconditionId);
    expect(migration?.preconditionIds).toContain(executionGuard?.preconditionId);
    expect(validatesAsSavedPlan(projection.value.plan)).toBeTrue();
  });

  test('adds a distinct null-root migration guard beside project-scoped ledger facts', async () => {
    const state = await fixture(true, true, false, 'project', true);
    const projection = createSavedPlanProjection(state.product);
    expect(projection.ok).toBeTrue();
    if (!projection.ok) throw new Error(projection.error.message);

    const migration = projection.value.plan.operations.find(
      ({ kind }) => kind === 'migrate-ledger',
    );
    const referencedGuards = projection.value.plan.resourcePreconditions.filter(
      ({ preconditionId }) => migration?.preconditionIds.includes(preconditionId),
    );
    expect(referencedGuards).toContainEqual(
      expect.objectContaining({ resource: { kind: 'ledger', projectRoot: null } }),
    );
    expect(projection.value.plan.resourcePreconditions).toContainEqual(
      expect.objectContaining({
        resource: {
          kind: 'ledger',
          projectRoot: { kind: 'portable', token: 'project:root' },
        },
      }),
    );
    expect(validatesAsSavedPlan(projection.value.plan)).toBeTrue();
  });

  test('records machine bindings carried only by warning diagnostics', async () => {
    const state = await fixture(true);
    const livePath = join(state.root, 'home', '.agents', 'skills', 'orphan');
    const localSourcePath = join(state.root, 'local-source');
    const product = {
      ...state.product,
      machineBoundLivePaths: [...state.product.machineBoundLivePaths, livePath],
      plan: {
        ...state.product.plan,
        diagnostics: [
          {
            diagnosticId: `diagnostic:v1:${'e'.repeat(64)}`,
            kind: 'warning' as const,
            severity: 'warning' as const,
            refusalClass: null,
            affected: {
              skill: 'orphan',
              source: {
                kind: 'local-dev' as const,
                path: localSourcePath,
                contentHash: operationDigest('e'),
              },
              tool: 'codex' as const,
              scope: 'user' as const,
              path: { kind: 'machine-bound' as const, path: livePath },
            },
            correlation: { groupId: null, pairId: null, operationId: null },
            reason: {
              code: 'plan-undeclared-placement-preserved',
              message: 'Undeclared live placement is preserved.',
            },
            selectionSource: 'bounded-default' as const,
          },
        ],
      },
    };

    const saved = createSavedPlan(product);
    expect(saved.ok).toBeTrue();
    if (!saved.ok) throw new Error(saved.error.message);
    expect(saved.value.portability).toEqual({
      kind: 'machine-bound',
      reasons: [
        {
          code: 'absolute-live-placement',
          message: 'plan binds an absolute live placement',
          path: livePath,
          preconditionIds: expect.any(Array),
        },
        {
          code: 'local-dev-source',
          message: 'plan binds a local development source',
          path: localSourcePath,
          preconditionIds: expect.any(Array),
        },
      ],
    });
    const resourcesById = new Map(
      saved.value.resourcePreconditions.map((precondition) => [
        precondition.preconditionId,
        precondition.resource,
      ]),
    );
    if (saved.value.portability.kind !== 'machine-bound') {
      throw new Error('warning-only fixture must be machine-bound');
    }
    for (const reason of saved.value.portability.reasons) {
      const resources = reason.preconditionIds.map((id) => resourcesById.get(id));
      if (reason.code === 'absolute-live-placement') {
        expect(
          resources.every(
            (resource) =>
              resource?.kind === 'live' &&
              resource.skill === 'orphan' &&
              resource.tool === 'codex' &&
              resource.scope === 'user' &&
              resource.projectRoot === null &&
              resource.location.kind === 'machine-bound' &&
              resource.location.path === livePath,
          ),
        ).toBeTrue();
      } else if (reason.code === 'local-dev-source') {
        expect(resources.every((resource) => resource?.kind === 'store')).toBeTrue();
        expect(resources).toContainEqual({ kind: 'store', contentHash: digest('e') });
      } else {
        throw new Error(`unexpected warning reason '${reason.code}'`);
      }
    }
    expect(validatesAsSavedPlan(saved.value)).toBeTrue();
  });

  test('refuses an unrepresentable path-only machine binding without inventing a resource', async () => {
    const state = await fixture(true);
    const path = join(state.root, 'custom-target');
    const product = {
      ...state.product,
      plan: {
        ...state.product.plan,
        diagnostics: [
          {
            diagnosticId: `diagnostic:v1:${'d'.repeat(64)}`,
            kind: 'warning' as const,
            severity: 'warning' as const,
            refusalClass: null,
            affected: {
              skill: null,
              source: null,
              tool: null,
              scope: null,
              path: { kind: 'machine-bound' as const, path },
            },
            correlation: { groupId: null, pairId: null, operationId: null },
            reason: {
              code: 'plan-custom-target-warning',
              message: 'Custom target remains machine-bound.',
            },
            selectionSource: 'bounded-default' as const,
          },
        ],
      },
    };

    expect(createSavedPlan(product)).toEqual({
      ok: false,
      error: {
        code: 'plan-machine-binding-precondition',
        message: `machine binding 'custom-absolute-target:${path}' has no corresponding resource precondition`,
        exitClass: 'state',
      },
    });
  });

  test('records machine bindings carried only by check sources', async () => {
    const state = await fixture(true, true);
    const operation = state.product.plan.operations[0];
    expect(operation).toBeDefined();
    if (operation === undefined) throw new Error('missing fixture operation');
    const localSourcePath = join(state.root, 'check-source');
    const product = {
      ...state.product,
      plan: {
        ...state.product.plan,
        checks: [
          ...state.product.plan.checks,
          {
            checkId: `check:v1:${'f'.repeat(64)}`,
            blocking: true as const,
            kind: 'content-integrity' as const,
            operationIds: [operation.operationId] as const,
            source: {
              kind: 'local-dev' as const,
              path: localSourcePath,
              contentHash: operationDigest('f'),
            },
            expectedContentHash: operationDigest('f'),
          },
        ],
      },
    };

    const saved = createSavedPlan(product);
    expect(saved.ok).toBeTrue();
    if (!saved.ok) throw new Error(saved.error.message);
    expect(saved.value.portability).toMatchObject({
      kind: 'machine-bound',
      reasons: [{ code: 'local-dev-source', path: localSourcePath }],
    });
    if (saved.value.portability.kind !== 'machine-bound') {
      throw new Error('check-only local source fixture must be machine-bound');
    }
    const resourceById = new Map(
      saved.value.resourcePreconditions.map((precondition) => [
        precondition.preconditionId,
        precondition.resource,
      ]),
    );
    const reasonResources = saved.value.portability.reasons[0]?.preconditionIds.map((id) =>
      resourceById.get(id),
    );
    expect(reasonResources?.every((resource) => resource?.kind === 'store')).toBeTrue();
    expect(reasonResources).toContainEqual({ kind: 'store', contentHash: digest('f') });
    expect(validatesAsSavedPlan(saved.value)).toBeTrue();
  });
});
