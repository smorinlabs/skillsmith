import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ArtifactDigest, hashManifestSemantics } from '../../src/artifacts/hash.ts';
import { type PortableLockV1, hashPortableLock } from '../../src/artifacts/lock.ts';
import { artifactContractRegistry } from '../../src/artifacts/registry.ts';
import type { NormalizedManifestV1 } from '../../src/artifacts/types.ts';
import type { OperationDigest } from '../../src/planning/types.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';
import type { ResolvedRuntimeConfiguration, RuntimePorts } from '../../src/ports/types.ts';
import { observeReconcileInput } from '../../src/reconcile/observe.ts';
import { createReconcilePlan } from '../../src/reconcile/plan.ts';
import { createSavedPlan, createSavedPlanProjection } from '../../src/reconcile/saved.ts';
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
        sourceVersion: 1,
        currentVersion: 1,
        source: 'version = 1\n',
        byteLength: 12,
        byteRevision: digest('a'),
        semanticRevision: hashManifestSemantics(model),
        model,
        canonical: true,
        migration: null,
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
      lockCanonicalHash: lockHash.value,
    });
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
    expect(saved.value.portability).toMatchObject({
      kind: 'machine-bound',
      reasons: [
        { code: 'absolute-artifact-selector', path: join(state.root, 'skillsmith.lock') },
        { code: 'absolute-artifact-selector', path: join(state.root, 'skillsmith.toml') },
      ],
    });
    if (saved.value.portability.kind !== 'machine-bound') {
      throw new Error('absolute selector fixture must be machine-bound');
    }
    const resourcesById = new Map(
      saved.value.resourcePreconditions.map((precondition) => [
        precondition.preconditionId,
        precondition.resource,
      ]),
    );
    for (const reason of saved.value.portability.reasons) {
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
        skills: ['alpha'],
        tools: ['codex'],
        scopes: ['user'],
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
