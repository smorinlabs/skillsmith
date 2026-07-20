import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { classifyPlacement, listPlacements } from '../../src/agents/placement-shared.ts';
import type { ArtifactDigest } from '../../src/artifacts/hash.ts';
import { hashManifestSemantics } from '../../src/artifacts/hash.ts';
import { ledgerV1Codec } from '../../src/artifacts/ledger-codec.ts';
import { serializePortableLock } from '../../src/artifacts/lock.ts';
import { createTestNodeArtifactCoordinatorPorts } from '../../src/artifacts/node-coordinator.ts';
import type { ResourcePreconditionV1 } from '../../src/artifacts/plan-types.ts';
import { artifactContractRegistry } from '../../src/artifacts/registry.ts';
import { hashSourceContentV1, projectSourceContent } from '../../src/artifacts/source-content.ts';
import type { NormalizedManifestV1 } from '../../src/artifacts/types.ts';
import type { ProjectContext } from '../../src/context/types.ts';
import {
  createObservationEmitter,
  createOperationContext,
  noopObserver,
} from '../../src/observation/index.ts';
import {
  emptyLedgerModel,
  getLedgerPairAt,
  readLedgerState,
  withLedgerPairAt,
  writeLedger,
} from '../../src/place/ledger.ts';
import { ledgerPathOf } from '../../src/place/paths.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';
import { portError } from '../../src/ports/errors.ts';
import type { ResolvedRuntimeConfiguration, RuntimePorts } from '../../src/ports/types.ts';
import {
  createReconcileCapabilityQueriesV1,
  createReconcileCopyReplacementIntermediatePinnedV1,
  createReconcileExecutionGuardAuthorityV1,
  executeValidatedReconcilePlan,
} from '../../src/reconcile/apply-execution.ts';
import {
  prepareReconcilePlan,
  validateSavedReconcilePlan,
  validateSavedReconcilePlanValue,
} from '../../src/reconcile/apply.ts';

const roots: string[] = [];
const digest = (character: string): ArtifactDigest =>
  `sha256:${character.repeat(64)}` as ArtifactDigest;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('shared placement root classification', () => {
  test('treats direct non-directories as empty without child reads and preserves symlink failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-placement-roots-'));
    roots.push(root);
    const ports = await defaultRuntimePorts();
    const storeRoot = join(root, 'store');
    const fileRoot = join(root, 'file-root');
    await writeFile(fileRoot, 'not a directory\n');
    let childProbes = 0;
    let listCalls = 0;
    const tracked = {
      ...ports,
      pathKind: (path: string) => {
        if (path.startsWith(`${fileRoot}${sep}`)) childProbes += 1;
        return ports.pathKind(path);
      },
      listDir: (path: string) => {
        if (path === fileRoot) listCalls += 1;
        return ports.listDir(path);
      },
    };
    expect(await listPlacements(tracked, fileRoot, storeRoot)).toEqual([]);
    expect(await classifyPlacement(tracked, fileRoot, 'alpha', storeRoot)).toMatchObject({
      class: 'absent',
      dangling: false,
    });
    expect({ childProbes, listCalls }).toEqual({ childProbes: 0, listCalls: 0 });

    const directoryRoot = join(root, 'directory-root');
    await mkdir(join(directoryRoot, 'alpha'), { recursive: true });
    const directoryLink = join(root, 'directory-link');
    await symlink(directoryRoot, directoryLink, 'dir');
    expect(await listPlacements(ports, directoryLink, storeRoot)).toMatchObject([
      { skill: 'alpha', class: 'pinned' },
    ]);

    const fileLink = join(root, 'file-link');
    await symlink(fileRoot, fileLink, 'file');
    await expect(listPlacements(ports, fileLink, storeRoot)).rejects.toMatchObject({ code: 'io' });
    await expect(classifyPlacement(ports, fileLink, 'alpha', storeRoot)).rejects.toMatchObject({
      code: 'io',
    });

    const danglingLink = join(root, 'dangling-link');
    await symlink(join(root, 'missing-root'), danglingLink, 'dir');
    expect(await listPlacements(ports, danglingLink, storeRoot)).toEqual([]);
    expect(await classifyPlacement(ports, danglingLink, 'alpha', storeRoot)).toMatchObject({
      class: 'absent',
    });

    const deniedRoot = join(root, 'denied-root');
    const denied = {
      ...ports,
      pathKind: (path: string) =>
        path === deniedRoot
          ? Promise.reject(
              portError({
                capability: 'file-read',
                operation: 'pathKind',
                code: 'permission',
                context: {},
                message: 'permission denied',
              }),
            )
          : ports.pathKind(path),
    };
    await expect(listPlacements(denied, deniedRoot, storeRoot)).rejects.toMatchObject({
      code: 'permission',
    });
    await expect(classifyPlacement(denied, deniedRoot, 'alpha', storeRoot)).rejects.toMatchObject({
      code: 'permission',
    });
  });
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

const fixture = async (): Promise<
  Readonly<{
    root: string;
    ports: RuntimePorts;
    project: ProjectContext;
    configuration: ResolvedRuntimeConfiguration;
  }>
> => {
  const root = await mkdtemp(join(tmpdir(), 'skillsmith-reconcile-apply-'));
  roots.push(root);
  const home = join(root, 'home');
  await mkdir(home, { recursive: true });
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
  const manifest: NormalizedManifestV1 = {
    version: 1,
    skills: [
      {
        name: 'alpha',
        source: {
          host: 'fixture.invalid',
          repository: 'acme/skills',
          path: 'skills/alpha',
        },
        ref: null,
        tools: ['codex'],
        scope: 'user',
        placement: 'copy',
        path: null,
      },
    ],
  };
  const manifestCodec = artifactContractRegistry.get('manifest', 1);
  if (manifestCodec === undefined) throw new Error('manifest codec unavailable');
  const encodedManifest = manifestCodec.encode(manifest);
  if (!encodedManifest.ok) throw new Error(encodedManifest.error.message);
  const encodedLock = serializePortableLock({
    version: 1,
    hashSchemaVersion: 1,
    manifestHash: hashManifestSemantics(manifest),
    skills: [
      {
        name: 'alpha',
        source: 'fixture.invalid/acme/skills//skills/alpha',
        requestedRef: null,
        resolvedSha: '1'.repeat(40),
        sourcePath: 'skills/alpha',
        contentHash: digest('1'),
      },
    ],
  });
  if (!encodedLock.ok) throw new Error(encodedLock.error.message);
  await Promise.all([
    writeFile(join(root, 'skillsmith.toml'), encodedManifest.value),
    writeFile(join(root, 'skillsmith.lock'), encodedLock.value),
  ]);
  return {
    root,
    ports,
    project: {
      invocationCwd: root,
      effectiveCwd: root,
      projectRoot: root,
      projectIdentity: root,
      projectKind: 'non-git',
      discoveredConfigPath: null,
      explicitConfigPath: null,
    },
    configuration: configuration(root),
  };
};

const physicalExecutionFixture = async (
  skillNames: readonly string[] = ['alpha'],
  declaredSkillNames: readonly string[] = skillNames,
) => {
  const context = await fixture();
  const remoteSkills = new Map<string, string>();
  const contentHashes = new Map<string, ArtifactDigest>();
  for (const name of skillNames) {
    const remoteSkill = join(context.root, 'remote', 'skills', name);
    remoteSkills.set(name, remoteSkill);
    await mkdir(remoteSkill, { recursive: true });
    await writeFile(
      join(remoteSkill, 'SKILL.md'),
      `---\nname: ${name}\ndescription: physical execution fixture\n---\n`,
    );
    const projected = await projectSourceContent(context.ports, remoteSkill);
    if (!projected.ok) throw new Error(projected.error.message);
    const contentHash = hashSourceContentV1(projected.value);
    if (!contentHash.ok) throw new Error(contentHash.error.message);
    contentHashes.set(name, contentHash.value);
  }
  const manifestCodec = artifactContractRegistry.get('manifest', 1);
  if (manifestCodec === undefined) throw new Error('manifest codec unavailable');
  const reviewedManifest: NormalizedManifestV1 = {
    version: 1,
    skills: declaredSkillNames.map((name) => ({
      name,
      source: {
        host: 'fixture.invalid',
        repository: 'acme/skills',
        path: `skills/${name}`,
      },
      ref: 'reviewed-main',
      tools: ['codex'],
      scope: 'user',
      placement: 'copy',
      path: null,
    })),
  };
  const encodedManifest = manifestCodec.encode(reviewedManifest);
  if (!encodedManifest.ok) throw new Error(encodedManifest.error.message);
  await writeFile(join(context.root, 'skillsmith.toml'), encodedManifest.value);
  const encodedLock = serializePortableLock({
    version: 1,
    hashSchemaVersion: 1,
    manifestHash: hashManifestSemantics(reviewedManifest),
    skills: declaredSkillNames.map((name) => ({
      name,
      source: `fixture.invalid/acme/skills//skills/${name}`,
      requestedRef: 'reviewed-main',
      resolvedSha: '1'.repeat(40),
      sourcePath: `skills/${name}`,
      contentHash: contentHashes.get(name) as ArtifactDigest,
    })),
  });
  if (!encodedLock.ok) throw new Error(encodedLock.error.message);
  await writeFile(join(context.root, 'skillsmith.lock'), encodedLock.value);
  const prepared = await prepareReconcilePlan(
    {
      file: 'skillsmith.toml',
      tools: [],
      scope: null,
      locked: true,
      prune: false,
      check: false,
    },
    {
      ports: context.ports,
      configuration: context.configuration,
      invocationCwd: context.root,
      projectContext: context.project,
    },
  );
  if (!prepared.ok) throw new Error(prepared.error.message);
  const validated = await validateSavedReconcilePlanValue(prepared.value.projection.plan, {
    ports: context.ports,
    configuration: context.configuration,
    projectContext: context.project,
  });
  if (!validated.ok) throw new Error(validated.error.message);
  const ports: RuntimePorts = {
    ...context.ports,
    git: {
      ...context.ports.git,
      initializeFetch: async () => undefined,
      fetchRef: async () => ({ sha: '1'.repeat(40) }),
      listTree: async () =>
        skillNames.map((name) => ({ path: `skills/${name}/SKILL.md`, kind: 'blob' as const })),
      materializeTree: async ({ path }) => join(context.root, 'remote', path),
    },
  };
  const artifactCoordinator = await createTestNodeArtifactCoordinatorPorts(
    join(context.root, 'coordination'),
  );
  const observation = {
    context: createOperationContext({
      command: 'skillsmith apply',
      workflow: 'apply',
      clock: context.ports,
      id: context.ports,
    }),
    emitter: createObservationEmitter({ observer: noopObserver }),
  };
  return {
    context,
    remoteSkill: remoteSkills.get(skillNames[0] as string) as string,
    remoteSkills,
    contentHashes,
    prepared: prepared.value,
    validated: validated.value,
    ports,
    artifactCoordinator,
    observation,
  };
};

type PhysicalExecutionFixture = Awaited<ReturnType<typeof physicalExecutionFixture>>;

const seedLegacyLedgerDigest = async (
  execution: PhysicalExecutionFixture,
  name: string,
  projectRoot: string | null = null,
): Promise<void> => {
  const ledger = await readLedgerState(
    execution.context.ports,
    ledgerPathOf(execution.context.configuration.skillsmithHome as string),
  );
  if (!ledger.ok || ledger.value.state !== 'present') {
    throw new Error('physical fixture ledger is absent');
  }
  const pair = getLedgerPairAt(ledger.value.model, projectRoot, name, 'codex');
  if (pair?.pinned == null) throw new Error('physical fixture pin is absent');
  const legacyContentHash = digest('e');
  expect(legacyContentHash).not.toBe(execution.contentHashes.get(name));
  const changed = withLedgerPairAt(ledger.value.model, projectRoot, name, 'codex', {
    ...pair,
    pinned: { ...pair.pinned, contentHash: legacyContentHash },
  });
  if (!changed.ok) throw new Error(JSON.stringify(changed.error));
  const written = await writeLedger(
    execution.context.ports,
    ledgerPathOf(execution.context.configuration.skillsmithHome as string),
    changed.value,
  );
  if (!written.ok) throw new Error(JSON.stringify(written.error));
};

const preparePhysicalScopePlan = async (
  execution: PhysicalExecutionFixture,
  declarations: readonly Readonly<{ name: string; scope: 'project' | 'user' }>[],
) => {
  const reviewedManifest: NormalizedManifestV1 = {
    version: 1,
    skills: declarations.map(({ name, scope }) => ({
      name,
      source: {
        host: 'fixture.invalid',
        repository: 'acme/skills',
        path: `skills/${name}`,
      },
      ref: 'reviewed-main',
      tools: ['codex'],
      scope,
      placement: 'copy',
      path: null,
    })),
  };
  const manifestCodec = artifactContractRegistry.get('manifest', 1);
  if (manifestCodec === undefined) throw new Error('manifest codec unavailable');
  const encodedManifest = manifestCodec.encode(reviewedManifest);
  if (!encodedManifest.ok) throw new Error(encodedManifest.error.message);
  const encodedLock = serializePortableLock({
    version: 1,
    hashSchemaVersion: 1,
    manifestHash: hashManifestSemantics(reviewedManifest),
    skills: declarations.map(({ name }) => ({
      name,
      source: `fixture.invalid/acme/skills//skills/${name}`,
      requestedRef: 'reviewed-main',
      resolvedSha: '1'.repeat(40),
      sourcePath: `skills/${name}`,
      contentHash: execution.contentHashes.get(name) as ArtifactDigest,
    })),
  });
  if (!encodedLock.ok) throw new Error(encodedLock.error.message);
  await Promise.all([
    writeFile(join(execution.context.root, 'skillsmith.toml'), encodedManifest.value),
    writeFile(join(execution.context.root, 'skillsmith.lock'), encodedLock.value),
  ]);

  const prepared = await prepareReconcilePlan(
    {
      file: 'skillsmith.toml',
      tools: [],
      scope: null,
      locked: true,
      prune: false,
      check: false,
    },
    {
      ports: execution.context.ports,
      configuration: execution.context.configuration,
      invocationCwd: execution.context.root,
      projectContext: execution.context.project,
    },
  );
  if (!prepared.ok) throw new Error(prepared.error.message);
  const validated = await validateSavedReconcilePlanValue(prepared.value.projection.plan, {
    ports: execution.context.ports,
    configuration: execution.context.configuration,
    projectContext: execution.context.project,
  });
  if (!validated.ok) throw new Error(validated.error.message);
  return Object.freeze({ prepared: prepared.value, validated: validated.value });
};

describe('fresh reconciliation preparation', () => {
  test('prepares one immutable product and its exact saved projection through the shared pipeline', async () => {
    const context = await fixture();
    const prepared = await prepareReconcilePlan(
      {
        file: 'skillsmith.toml',
        tools: [],
        scope: null,
        locked: true,
        prune: false,
        check: false,
      },
      {
        ports: context.ports,
        configuration: context.configuration,
        invocationCwd: context.root,
        projectContext: context.project,
      },
    );

    expect(prepared.ok).toBeTrue();
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.value.artifactSelectionSource).toBe('explicit');
    expect(prepared.value.product.input.observed.pair).toMatchObject({
      file: { path: join(context.root, 'skillsmith.toml') },
      lockfile: { path: join(context.root, 'skillsmith.lock') },
    });
    expect(prepared.value.product.plan.operations).toHaveLength(1);
    expect(prepared.value.projection.plan.operations).toHaveLength(1);
    const liveOperation = prepared.value.product.plan.operations[0];
    const savedOperation = prepared.value.projection.plan.operations[0];
    expect(savedOperation).toMatchObject({
      kind: liveOperation?.kind,
      skill: liveOperation?.skill,
      tool: liveOperation?.tool,
      scope: liveOperation?.scope,
    });
    expect(
      prepared.value.projection.operationPreconditionIds.get(liveOperation?.operationId ?? ''),
    ).toEqual(savedOperation?.preconditionIds);
    expect(
      prepared.value.projection.operationPreconditionIds.get(savedOperation?.operationId ?? ''),
    ).toEqual(savedOperation?.preconditionIds);
    expect(savedOperation).toMatchObject({
      before: {
        kind: 'absent',
        resource: {
          kind: 'live',
          location: { kind: 'portable', token: 'skills/user/codex/alpha' },
        },
      },
    });
    expect(prepared.value.observation.resolved).toBe(prepared.value.product.input);
    expect(Object.isFrozen(prepared.value)).toBeTrue();
  });

  test('returns the signed cancellation before project, artifact, or source reads', async () => {
    const controller = new AbortController();
    controller.abort();
    const runtime = new Proxy(
      { signal: controller.signal } as Parameters<typeof prepareReconcilePlan>[1],
      {
        get: (target, property) => {
          if (property === 'signal') return target.signal;
          throw new Error(`cancelled preparation unexpectedly read runtime.${String(property)}`);
        },
      },
    );

    const prepared = await prepareReconcilePlan(
      { tools: [], scope: null, locked: false, prune: false, check: false },
      runtime,
    );

    expect(prepared).toEqual({
      ok: false,
      error: {
        code: 'plan-cancelled',
        message: 'plan was cancelled',
        exitClass: 'cancelled',
      },
    });
  });
});

describe('saved reconciliation validation', () => {
  test('remaps the exact reviewed projection without replanning and refreshes artifact byte guards', async () => {
    const context = await fixture();
    const prepared = await prepareReconcilePlan(
      {
        file: 'skillsmith.toml',
        tools: [],
        scope: null,
        locked: true,
        prune: false,
        check: false,
      },
      {
        ports: context.ports,
        configuration: context.configuration,
        invocationCwd: context.root,
        projectContext: context.project,
      },
    );
    expect(prepared.ok).toBeTrue();
    if (!prepared.ok) throw new Error(prepared.error.message);

    await appendFile(join(context.root, 'skillsmith.toml'), '# formatting-only edit\n');
    const validated = await validateSavedReconcilePlanValue(prepared.value.projection.plan, {
      ports: context.ports,
      configuration: context.configuration,
      projectContext: context.project,
    });

    if (!validated.ok) throw new Error(validated.error.message);
    expect(validated.ok).toBeTrue();
    expect(validated.value.plan.command).toBe('apply');
    expect(validated.value.plan.batchPolicy).toBe('fail-fast');
    expect(validated.value.plan.operations.map(({ operationId }) => operationId)).toEqual(
      prepared.value.projection.plan.operations.map(({ operationId }) => operationId),
    );
    expect(new Map(validated.value.resolvedTokens)).toEqual(
      new Map([
        [
          `store:${digest('1').slice('sha256:'.length)}/alpha`,
          join(context.root, 'data', 'store', 'acme', 'skills@111111111111', 'alpha'),
        ],
        ['project:skillsmith.lock', join(context.root, 'skillsmith.lock')],
        ['project:skillsmith.toml', join(context.root, 'skillsmith.toml')],
        ['skills/user/codex/alpha', join(context.root, 'home', '.agents', 'skills', 'alpha')],
      ]),
    );
    const savedBytes = prepared.value.projection.plan.resourcePreconditions.find(
      ({ expectedHash }) => expectedHash.domain === 'manifest-bytes',
    );
    const freshBytes = validated.value.guards.resourcePreconditions.find(
      ({ expectedHash }) => expectedHash.domain === 'manifest-bytes',
    );
    expect(savedBytes).toBeDefined();
    expect(freshBytes).toBeDefined();
    expect(freshBytes?.expectedRevision).not.toEqual(savedBytes?.expectedRevision);
    const storeGuard = validated.value.guards.resourcePreconditions.find(
      ({ resource }) => resource.kind === 'store',
    );
    expect(storeGuard).toMatchObject({
      resource: { kind: 'store', contentHash: digest('1') },
      expectedState: 'absent',
    });
    expect(validated.value.resolvedTokens.get(`store:${'1'.repeat(64)}/alpha`)).toContain(
      join('data', 'store', 'acme', `skills@${'1'.repeat(12)}`, 'alpha'),
    );
    expect(() =>
      (validated.value.resolvedTokens as Map<string, string>).set('project:mutated', context.root),
    ).toThrow(/immutable/u);
    expect(() =>
      Map.prototype.set.call(
        validated.value.resolvedTokens,
        'project:prototype-bypass',
        context.root,
      ),
    ).toThrow(TypeError);
    expect(validated.value.resolvedTokens.has('project:prototype-bypass')).toBeFalse();
    expect(Object.isFrozen(validated.value.guards.resourcePreconditions)).toBeTrue();
  });

  test('strict path validation preserves the decoded source and maps cancellation before reads', async () => {
    const context = await fixture();
    const prepared = await prepareReconcilePlan(
      {
        file: 'skillsmith.toml',
        tools: [],
        scope: null,
        locked: true,
        prune: false,
        check: false,
      },
      {
        ports: context.ports,
        configuration: context.configuration,
        invocationCwd: context.root,
        projectContext: context.project,
      },
    );
    if (!prepared.ok) throw new Error(prepared.error.message);
    const codec = artifactContractRegistry.get('plan', 1);
    if (codec === undefined) throw new Error('saved plan codec unavailable');
    const encoded = codec.encode(prepared.value.projection.plan);
    if (!encoded.ok) throw new Error(encoded.error.message);
    const path = join(context.root, 'review.skillsmith.plan');
    await writeFile(path, encoded.value);

    const validated = await validateSavedReconcilePlan(
      { planPath: path },
      {
        ports: context.ports,
        configuration: context.configuration,
        projectContext: context.project,
      },
    );
    if (!validated.ok) throw new Error(validated.error.message);
    expect(validated.ok).toBeTrue();
    expect(validated.value.artifact.source).toBe(new TextDecoder().decode(encoded.value));

    const controller = new AbortController();
    controller.abort();
    const cancelled = await validateSavedReconcilePlan(
      { planPath: path },
      {
        ports: new Proxy(context.ports, {
          get: () => {
            throw new Error('cancelled validation performed I/O');
          },
        }),
        configuration: context.configuration,
        projectContext: context.project,
        signal: controller.signal,
      },
    );
    expect(cancelled).toEqual({
      ok: false,
      error: {
        code: 'apply-saved-cancelled',
        message: 'saved plan validation was cancelled',
        exitClass: 'cancelled',
      },
    });
  });

  test('semantic manifest changes stale the exact authorization with regeneration guidance', async () => {
    const context = await fixture();
    const prepared = await prepareReconcilePlan(
      {
        file: 'skillsmith.toml',
        tools: [],
        scope: null,
        locked: true,
        prune: false,
        check: false,
      },
      {
        ports: context.ports,
        configuration: context.configuration,
        invocationCwd: context.root,
        projectContext: context.project,
      },
    );
    if (!prepared.ok) throw new Error(prepared.error.message);
    const current = prepared.value.observation.resolved.observed.manifest.model;
    const first = current.skills[0];
    if (first === undefined) throw new Error('manifest fixture has no skill');
    const changed: NormalizedManifestV1 = {
      ...current,
      skills: [{ ...first, placement: 'symlink' }, ...current.skills.slice(1)],
    };
    const codec = artifactContractRegistry.get('manifest', 1);
    if (codec === undefined) throw new Error('manifest codec unavailable');
    const encoded = codec.encode(changed);
    if (!encoded.ok) throw new Error(encoded.error.message);
    await writeFile(join(context.root, 'skillsmith.toml'), encoded.value);

    const validated = await validateSavedReconcilePlanValue(prepared.value.projection.plan, {
      ports: context.ports,
      configuration: context.configuration,
      projectContext: context.project,
    });
    expect(validated).toMatchObject({
      ok: false,
      error: { code: 'apply-saved-manifest-semantic', exitClass: 'state' },
    });
    if (validated.ok) throw new Error('semantic change unexpectedly remained valid');
    expect(validated.error.message).toContain('regenerate a new plan');
  });

  test('scopes manifest semantics to the original predicates and re-observes selected membership', async () => {
    const context = await fixture();
    const prepared = await prepareReconcilePlan(
      {
        file: 'skillsmith.toml',
        tools: ['codex'],
        scope: null,
        locked: true,
        prune: false,
        check: false,
      },
      {
        ports: context.ports,
        configuration: context.configuration,
        invocationCwd: context.root,
        projectContext: context.project,
      },
    );
    if (!prepared.ok) throw new Error(prepared.error.message);
    const original = await readFile(join(context.root, 'skillsmith.toml'), 'utf8');
    const unselected =
      '\n[[skills]]\nname = "beta"\nsource = "fixture.invalid/acme/skills//skills/beta"\ntools = ["opencode"]\nscope = "user"\nplacement = "copy"\n';
    await writeFile(join(context.root, 'skillsmith.toml'), `${original}${unselected}`);
    const retained = await validateSavedReconcilePlanValue(prepared.value.projection.plan, {
      ports: context.ports,
      configuration: context.configuration,
      projectContext: context.project,
    });
    expect(retained.ok).toBeTrue();

    await writeFile(
      join(context.root, 'skillsmith.toml'),
      original.replace('placement = "copy"', 'placement = "symlink"'),
    );
    expect(
      await validateSavedReconcilePlanValue(prepared.value.projection.plan, {
        ports: context.ports,
        configuration: context.configuration,
        projectContext: context.project,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'apply-saved-manifest-semantic', exitClass: 'state' },
    });

    const selectedAddition =
      '\n[[skills]]\nname = "gamma"\nsource = "fixture.invalid/acme/skills//skills/gamma"\ntools = ["codex"]\nscope = "user"\nplacement = "copy"\n';
    await writeFile(join(context.root, 'skillsmith.toml'), `${original}${selectedAddition}`);
    expect(
      await validateSavedReconcilePlanValue(prepared.value.projection.plan, {
        ports: context.ports,
        configuration: context.configuration,
        projectContext: context.project,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'apply-saved-selection-set', exitClass: 'state' },
    });
  });

  test('carries a recomputed explicit filter-noop outcome into saved execution', async () => {
    const context = await fixture();
    const prepared = await prepareReconcilePlan(
      {
        file: 'skillsmith.toml',
        tools: ['opencode'],
        scope: null,
        locked: true,
        prune: false,
        check: false,
      },
      {
        ports: context.ports,
        configuration: context.configuration,
        invocationCwd: context.root,
        projectContext: context.project,
      },
    );
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.value.projection.plan.operations).toEqual([]);

    const validated = await validateSavedReconcilePlanValue(prepared.value.projection.plan, {
      ports: context.ports,
      configuration: context.configuration,
      projectContext: context.project,
    });
    expect(validated.ok).toBeTrue();
    if (!validated.ok) throw new Error(validated.error.message);
    expect(validated.value.selectionOutcome).toBe('filter-noop');
  });

  test('observes only referenced live state while unrelated placements remain irrelevant', async () => {
    const context = await fixture();
    const prepared = await prepareReconcilePlan(
      {
        file: 'skillsmith.toml',
        tools: [],
        scope: null,
        locked: true,
        prune: false,
        check: false,
      },
      {
        ports: context.ports,
        configuration: context.configuration,
        invocationCwd: context.root,
        projectContext: context.project,
      },
    );
    if (!prepared.ok) throw new Error(prepared.error.message);
    const liveRoot = join(context.root, 'home', '.agents', 'skills');
    await mkdir(join(liveRoot, 'unrelated'), { recursive: true });
    await writeFile(
      join(liveRoot, 'unrelated', 'SKILL.md'),
      '---\nname: unrelated\ndescription: unrelated fixture\n---\n',
    );
    expect(
      (
        await validateSavedReconcilePlanValue(prepared.value.projection.plan, {
          ports: context.ports,
          configuration: context.configuration,
          projectContext: context.project,
        })
      ).ok,
    ).toBeTrue();

    await mkdir(join(liveRoot, 'alpha'), { recursive: true });
    await writeFile(
      join(liveRoot, 'alpha', 'SKILL.md'),
      '---\nname: alpha\ndescription: changed after review\n---\n',
    );
    const changed = await validateSavedReconcilePlanValue(prepared.value.projection.plan, {
      ports: context.ports,
      configuration: context.configuration,
      projectContext: context.project,
    });
    expect(changed).toMatchObject({
      ok: false,
      error: { code: 'apply-saved-live-resource', exitClass: 'state' },
    });
  });

  test('recomputes selected live inventory and rejects a newly added alternate prune placement', async () => {
    const context = await fixture();
    const manifest: NormalizedManifestV1 = {
      version: 1,
      skills: [
        {
          name: 'alpha',
          source: {
            host: 'fixture.invalid',
            repository: 'acme/skills',
            path: 'skills/alpha',
          },
          ref: null,
          tools: ['codex'],
          scope: 'user',
          placement: 'copy',
          path: null,
        },
      ],
    };
    const encodedLock = serializePortableLock({
      version: 1,
      hashSchemaVersion: 1,
      manifestHash: hashManifestSemantics(manifest),
      skills: [
        {
          name: 'alpha',
          source: 'fixture.invalid/acme/skills//skills/alpha',
          requestedRef: null,
          resolvedSha: '1'.repeat(40),
          sourcePath: 'skills/alpha',
          contentHash: digest('1'),
        },
        {
          name: 'beta',
          source: 'fixture.invalid/acme/skills//skills/beta',
          requestedRef: null,
          resolvedSha: '2'.repeat(40),
          sourcePath: 'skills/beta',
          contentHash: digest('2'),
        },
      ],
    });
    if (!encodedLock.ok) throw new Error(encodedLock.error.message);
    await writeFile(join(context.root, 'skillsmith.lock'), encodedLock.value);
    const prepared = await prepareReconcilePlan(
      {
        file: 'skillsmith.toml',
        tools: [],
        scope: null,
        locked: false,
        prune: true,
        check: false,
      },
      {
        ports: context.ports,
        configuration: context.configuration,
        invocationCwd: context.root,
        projectContext: context.project,
      },
    );
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.value.observation.prunePlacements).toMatchObject([
      { pin: { name: 'beta' }, placement: { class: 'absent' } },
    ]);

    const alternate = join(context.root, 'home', '.codex', 'skills', 'beta');
    await mkdir(alternate, { recursive: true });
    await writeFile(
      join(alternate, 'SKILL.md'),
      '---\nname: beta\ndescription: added after review\n---\n',
    );
    const validated = await validateSavedReconcilePlanValue(prepared.value.projection.plan, {
      ports: context.ports,
      configuration: context.configuration,
      projectContext: context.project,
    });
    expect(validated).toMatchObject({
      ok: false,
      error: { code: 'apply-saved-live-resource', exitClass: 'state' },
    });
  });

  test('validates exact whole-artifact before images only for manifest migration and lock write', async () => {
    const migrationContext = await fixture();
    const migrationFixtures = await Bun.file(
      join(import.meta.dir, '../../../../tests/ergonomics/fixtures/p2-ts06/migration-cases.json'),
    ).json();
    const migrationSource = migrationFixtures.projectMigrations[0]?.before;
    const migrationSemanticRevision = migrationFixtures.projectMigrations[0]?.semanticRevision;
    if (typeof migrationSource !== 'string') throw new Error('legacy migration fixture is absent');
    if (typeof migrationSemanticRevision !== 'string') {
      throw new Error('legacy migration semantic revision is absent');
    }
    await writeFile(join(migrationContext.root, 'skillsmith.toml'), migrationSource);
    const migrationLock = serializePortableLock({
      version: 1,
      hashSchemaVersion: 1,
      manifestHash: migrationSemanticRevision as ArtifactDigest,
      skills: [],
    });
    if (!migrationLock.ok) throw new Error(migrationLock.error.message);
    await writeFile(join(migrationContext.root, 'skillsmith.lock'), migrationLock.value);
    const migration = await prepareReconcilePlan(
      {
        file: 'skillsmith.toml',
        tools: [],
        scope: null,
        locked: true,
        prune: false,
        check: false,
      },
      {
        ports: migrationContext.ports,
        configuration: migrationContext.configuration,
        invocationCwd: migrationContext.root,
        projectContext: migrationContext.project,
      },
    );
    if (!migration.ok) throw new Error(migration.error.message);
    expect(migration.value.projection.plan.operations.map(({ kind }) => kind)).toContain(
      'migrate-project-config',
    );
    const migrationBaseline = await validateSavedReconcilePlanValue(
      migration.value.projection.plan,
      {
        ports: migrationContext.ports,
        configuration: migrationContext.configuration,
        projectContext: migrationContext.project,
      },
    );
    if (!migrationBaseline.ok)
      throw new Error(`migration baseline: ${migrationBaseline.error.code}`);
    await appendFile(join(migrationContext.root, 'skillsmith.toml'), '# after review\n');
    expect(
      await validateSavedReconcilePlanValue(migration.value.projection.plan, {
        ports: migrationContext.ports,
        configuration: migrationContext.configuration,
        projectContext: migrationContext.project,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'apply-saved-manifest-semantic', exitClass: 'state' },
    });

    const lockContext = await fixture();
    const manifest = lockContext.root;
    const staleLock = (manifestHash: ArtifactDigest) =>
      serializePortableLock({
        version: 1,
        hashSchemaVersion: 1,
        manifestHash,
        skills: [
          {
            name: 'alpha',
            source: 'fixture.invalid/acme/skills//skills/alpha',
            requestedRef: null,
            resolvedSha: '1'.repeat(40),
            sourcePath: 'skills/alpha',
            contentHash: digest('1'),
          },
        ],
      });
    const beforeLock = staleLock(digest('e'));
    if (!beforeLock.ok) throw new Error(beforeLock.error.message);
    await writeFile(join(manifest, 'skillsmith.lock'), beforeLock.value);
    const writeLock = await prepareReconcilePlan(
      {
        file: 'skillsmith.toml',
        tools: [],
        scope: null,
        locked: false,
        prune: false,
        check: false,
      },
      {
        ports: lockContext.ports,
        configuration: lockContext.configuration,
        invocationCwd: lockContext.root,
        projectContext: lockContext.project,
      },
    );
    if (!writeLock.ok) throw new Error(writeLock.error.message);
    expect(writeLock.value.projection.plan.operations.map(({ kind }) => kind)).toContain(
      'write-lock',
    );
    const changedLock = staleLock(digest('d'));
    if (!changedLock.ok) throw new Error(changedLock.error.message);
    await writeFile(join(lockContext.root, 'skillsmith.lock'), changedLock.value);
    expect(
      await validateSavedReconcilePlanValue(writeLock.value.projection.plan, {
        ports: lockContext.ports,
        configuration: lockContext.configuration,
        projectContext: lockContext.project,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'apply-saved-lock-canonical', exitClass: 'state' },
    });
  });

  test('maps absent and malformed saved artifacts to state without locks, prompts, or writes', async () => {
    const context = await fixture();
    const absent = await validateSavedReconcilePlan(
      { planPath: join(context.root, 'absent.skillsmith.plan') },
      {
        ports: context.ports,
        configuration: context.configuration,
        projectContext: context.project,
      },
    );
    expect(absent).toMatchObject({
      ok: false,
      error: { code: 'apply-saved-artifact', exitClass: 'state' },
    });

    const malformedPath = join(context.root, 'malformed.skillsmith.plan');
    await writeFile(malformedPath, '{"kind":"skillsmith.plan","schemaVersion":999}\n');
    const malformed = await validateSavedReconcilePlan(
      { planPath: malformedPath },
      {
        ports: context.ports,
        configuration: context.configuration,
        projectContext: context.project,
      },
    );
    expect(malformed).toMatchObject({
      ok: false,
      error: { code: 'apply-saved-schema', exitClass: 'state' },
    });

    const invalid = await validateSavedReconcilePlan(
      { planPath: '' },
      {
        ports: context.ports,
        configuration: context.configuration,
        projectContext: context.project,
      },
    );
    expect(invalid).toMatchObject({
      ok: false,
      error: { code: 'apply-saved-request', exitClass: 'usage' },
    });
  });

  test('binds absolute artifact selectors to the exact current project context', async () => {
    const context = await fixture();
    const prepared = await prepareReconcilePlan(
      {
        file: join(context.root, 'skillsmith.toml'),
        lockfile: join(context.root, 'skillsmith.lock'),
        tools: [],
        scope: null,
        locked: true,
        prune: false,
        check: false,
      },
      {
        ports: context.ports,
        configuration: context.configuration,
        invocationCwd: context.root,
        projectContext: context.project,
      },
    );
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.value.projection.plan.portability.kind).toBe('machine-bound');
    expect(
      (
        await validateSavedReconcilePlanValue(prepared.value.projection.plan, {
          ports: context.ports,
          configuration: context.configuration,
          projectContext: context.project,
        })
      ).ok,
    ).toBeTrue();

    const other = join(context.root, 'other-project');
    await mkdir(other, { recursive: true });
    const mismatched = await validateSavedReconcilePlanValue(prepared.value.projection.plan, {
      ports: context.ports,
      configuration: context.configuration,
      projectContext: {
        ...context.project,
        invocationCwd: other,
        effectiveCwd: other,
        projectRoot: other,
        projectIdentity: other,
      },
    });
    expect(mismatched).toMatchObject({
      ok: false,
      error: { code: 'apply-saved-machine-binding', exitClass: 'state' },
    });
    if (mismatched.ok) throw new Error('machine binding unexpectedly crossed project contexts');
    expect(mismatched.error.message).toMatch(/current project context|regenerate/u);

    const parent = dirname(context.root);
    const containingButDifferent = await validateSavedReconcilePlanValue(
      prepared.value.projection.plan,
      {
        ports: context.ports,
        configuration: context.configuration,
        projectContext: {
          ...context.project,
          invocationCwd: parent,
          effectiveCwd: parent,
          projectRoot: parent,
          projectIdentity: parent,
        },
      },
    );
    expect(containingButDifferent).toMatchObject({
      ok: false,
      error: { code: 'apply-saved-machine-binding', exitClass: 'state' },
    });
  });

  test('maps referenced resource permission and mid-observation cancellation exactly', async () => {
    const context = await fixture();
    const prepared = await prepareReconcilePlan(
      {
        file: 'skillsmith.toml',
        tools: [],
        scope: null,
        locked: true,
        prune: false,
        check: false,
      },
      {
        ports: context.ports,
        configuration: context.configuration,
        invocationCwd: context.root,
        projectContext: context.project,
      },
    );
    if (!prepared.ok) throw new Error(prepared.error.message);
    const storeSegment = `${sep}store${sep}`;
    const denied = await validateSavedReconcilePlanValue(prepared.value.projection.plan, {
      ports: {
        ...context.ports,
        pathKind: (path) => {
          if (path.includes(storeSegment)) {
            throw Object.assign(new Error('synthetic permission denial'), { code: 'EACCES' });
          }
          return context.ports.pathKind(path);
        },
      },
      configuration: context.configuration,
      projectContext: context.project,
    });
    expect(denied).toMatchObject({
      ok: false,
      error: { code: 'apply-saved-permission', exitClass: 'permission' },
    });

    const controller = new AbortController();
    const cancelled = await validateSavedReconcilePlanValue(prepared.value.projection.plan, {
      ports: {
        ...context.ports,
        pathKind: (path) => {
          if (path.includes(storeSegment)) {
            controller.abort();
            throw Object.assign(new Error('synthetic cancellation'), {
              code: 'ABORT_ERR',
              name: 'AbortError',
            });
          }
          return context.ports.pathKind(path);
        },
      },
      configuration: context.configuration,
      projectContext: context.project,
      signal: controller.signal,
    });
    expect(cancelled).toMatchObject({
      ok: false,
      error: { code: 'apply-saved-cancelled', exitClass: 'cancelled' },
    });
  });

  test('maps a referenced local development source observation failure to source', async () => {
    const context = await fixture();
    const localSource = join(context.root, 'home', '.agents', 'skills', 'alpha');
    await mkdir(localSource, { recursive: true });
    await writeFile(
      join(localSource, 'SKILL.md'),
      '---\nname: alpha\ndescription: local development fixture\n---\n',
    );
    const prepared = await prepareReconcilePlan(
      {
        file: 'skillsmith.toml',
        tools: [],
        scope: null,
        locked: true,
        prune: false,
        check: false,
      },
      {
        ports: context.ports,
        configuration: context.configuration,
        invocationCwd: context.root,
        projectContext: context.project,
      },
    );
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.value.projection.plan.portability).toMatchObject({
      kind: 'machine-bound',
      reasons: [{ code: 'local-dev-source', path: localSource }],
    });

    const failed = await validateSavedReconcilePlanValue(prepared.value.projection.plan, {
      ports: {
        ...context.ports,
        readFileMetadata: async (path) => {
          if (path === localSource) throw new Error('synthetic local source read failure');
          return context.ports.readFileMetadata(path);
        },
      },
      configuration: context.configuration,
      projectContext: context.project,
    });
    expect(failed).toMatchObject({
      ok: false,
      error: { code: 'apply-saved-source', exitClass: 'source' },
    });
  });
});

describe('saved reconciliation execution guard authority', () => {
  test('memoizes one exact revalidation and returns guard facts selected by exact ID', async () => {
    const context = await fixture();
    const prepared = await prepareReconcilePlan(
      {
        file: 'skillsmith.toml',
        tools: [],
        scope: null,
        locked: true,
        prune: false,
        check: false,
      },
      {
        ports: context.ports,
        configuration: context.configuration,
        invocationCwd: context.root,
        projectContext: context.project,
      },
    );
    if (!prepared.ok) throw new Error(prepared.error.message);
    let byteReads = 0;
    const ports: RuntimePorts = {
      ...context.ports,
      readBytes: async (path) => {
        byteReads += 1;
        return context.ports.readBytes(path);
      },
    };
    const validated = await validateSavedReconcilePlanValue(prepared.value.projection.plan, {
      ports,
      configuration: context.configuration,
      projectContext: context.project,
    });
    if (!validated.ok) throw new Error(validated.error.message);
    byteReads = 0;
    const authority = createReconcileExecutionGuardAuthorityV1(validated.value, {
      ports,
      configuration: context.configuration,
      projectContext: context.project,
    });
    const resource = validated.value.guards.resourcePreconditions[0];
    const selection = validated.value.guards.selectionPreconditions[0];
    const capability = validated.value.guards.capabilityPreconditions[0];
    if (resource === undefined || selection === undefined || capability === undefined) {
      throw new Error('fixture did not produce all execution guard classes');
    }

    expect(await authority.observeResource(resource, null)).toEqual({
      expectedState: resource.expectedState,
      expectedHash: resource.expectedHash,
      expectedRevision: resource.expectedRevision,
    });
    const readsAfterFirstGuard = byteReads;
    const { preconditionId: _selectionId, ...selectionFact } = selection;
    const { preconditionId: _capabilityId, ...capabilityFact } = capability;
    expect(await authority.observeSelection(selection, null)).toEqual(selectionFact);
    expect(await authority.observeCapability(capability, null)).toEqual(capabilityFact);
    expect(byteReads).toBe(readsAfterFirstGuard);
    expect(readsAfterFirstGuard).toBeGreaterThan(0);
    authority.beginValidationCycle?.();
    await authority.observeResource(resource, null);
    expect(byteReads).toBeGreaterThan(readsAfterFirstGuard);

    await expect(
      authority.observeResource(
        { ...resource, preconditionId: `${resource.preconditionId}:different` },
        null,
      ),
    ).rejects.toMatchObject({ code: 'precondition-state-changed' });
  });

  test('rejects stale state instead of echoing an expected fact', async () => {
    const context = await fixture();
    const prepared = await prepareReconcilePlan(
      {
        file: 'skillsmith.toml',
        tools: [],
        scope: null,
        locked: true,
        prune: false,
        check: false,
      },
      {
        ports: context.ports,
        configuration: context.configuration,
        invocationCwd: context.root,
        projectContext: context.project,
      },
    );
    if (!prepared.ok) throw new Error(prepared.error.message);
    const validated = await validateSavedReconcilePlanValue(prepared.value.projection.plan, {
      ports: context.ports,
      configuration: context.configuration,
      projectContext: context.project,
    });
    if (!validated.ok) throw new Error(validated.error.message);
    const authority = createReconcileExecutionGuardAuthorityV1(validated.value, {
      ports: context.ports,
      configuration: context.configuration,
      projectContext: context.project,
    });
    const resource = validated.value.guards.resourcePreconditions[0];
    if (resource === undefined) throw new Error('fixture has no resource guard');

    await appendFile(join(context.root, 'skillsmith.toml'), '# changed after approval\n');
    await expect(authority.observeResource(resource, null)).rejects.toMatchObject({
      code: 'precondition-state-changed',
    });
  });

  test('owns mutable inputs at construction without modifying caller data', async () => {
    const context = await fixture();
    const prepared = await prepareReconcilePlan(
      {
        file: 'skillsmith.toml',
        tools: [],
        scope: null,
        locked: true,
        prune: false,
        check: false,
      },
      {
        ports: context.ports,
        configuration: context.configuration,
        invocationCwd: context.root,
        projectContext: context.project,
      },
    );
    if (!prepared.ok) throw new Error(prepared.error.message);
    const validated = await validateSavedReconcilePlanValue(prepared.value.projection.plan, {
      ports: context.ports,
      configuration: context.configuration,
      projectContext: context.project,
    });
    if (!validated.ok) throw new Error(validated.error.message);
    const mutable = {
      savedPlan: structuredClone(validated.value.savedPlan),
      plan: structuredClone(validated.value.plan),
      pair: structuredClone(validated.value.pair),
      selectionOutcome: validated.value.selectionOutcome,
      resolvedTokens: new Map(validated.value.resolvedTokens),
      guards: structuredClone(validated.value.guards),
    };
    const ports = { ...context.ports };
    const runtime = {
      ports,
      configuration: structuredClone(context.configuration),
      projectContext: structuredClone(context.project),
    };
    const originalResource = structuredClone(mutable.guards.resourcePreconditions[0]);
    if (originalResource === undefined) throw new Error('fixture has no resource guard');
    const before = structuredClone(mutable);
    const authority = createReconcileExecutionGuardAuthorityV1(mutable, runtime);
    expect(mutable).toEqual(before);

    (mutable.plan as unknown as { batchPolicy: 'continue-on-error' | 'fail-fast' }).batchPolicy =
      'continue-on-error';
    (
      mutable.savedPlan.selection as unknown as {
        selectionSource: 'bounded-default' | 'explicit';
      }
    ).selectionSource = 'explicit';
    mutable.resolvedTokens.set('project:mutated', join(context.root, 'mutated'));
    (mutable.guards.resourcePreconditions as ResourcePreconditionV1[])[0] = {
      ...originalResource,
      expectedState: originalResource.expectedState === 'present' ? 'absent' : 'present',
    };
    ports.homeDir = join(context.root, 'mutated-home');
    (runtime.configuration as unknown as { skillsmithHome: string | undefined }).skillsmithHome =
      join(context.root, 'mutated-data');
    (runtime.projectContext as unknown as { effectiveCwd: string }).effectiveCwd = join(
      context.root,
      'mutated-project',
    );

    expect(await authority.observeResource(originalResource, null)).toEqual({
      expectedState: originalResource.expectedState,
      expectedHash: originalResource.expectedHash,
      expectedRevision: originalResource.expectedRevision,
    });
  });

  test('reads current physical legacy ledger bytes after memoized validation', async () => {
    const context = await fixture();
    const ledgerPath = ledgerPathOf(context.configuration.skillsmithHome as string);
    const prepared = await prepareReconcilePlan(
      {
        file: 'skillsmith.toml',
        tools: [],
        scope: null,
        locked: true,
        prune: false,
        check: false,
      },
      {
        ports: context.ports,
        configuration: context.configuration,
        invocationCwd: context.root,
        projectContext: context.project,
      },
    );
    if (!prepared.ok) throw new Error(prepared.error.message);
    const validated = await validateSavedReconcilePlanValue(prepared.value.projection.plan, {
      ports: context.ports,
      configuration: context.configuration,
      projectContext: context.project,
    });
    if (!validated.ok) throw new Error(validated.error.message);
    const ordinaryGuard = validated.value.guards.resourcePreconditions.find(
      ({ expectedState }) => expectedState === 'present',
    );
    if (ordinaryGuard === undefined) throw new Error('fixture did not produce a resource guard');
    const authority = createReconcileExecutionGuardAuthorityV1(validated.value, {
      ports: context.ports,
      configuration: context.configuration,
      projectContext: context.project,
    });
    await authority.observeResource(ordinaryGuard, null);
    await mkdir(dirname(ledgerPath), { recursive: true });
    const replacementLedger = ledgerV1Codec.encode(emptyLedgerModel('2026-07-19T00:00:01.000Z'));
    if (!replacementLedger.ok) throw new Error(replacementLedger.error.message);
    await writeFile(ledgerPath, replacementLedger.value);

    const actual = (await authority.observeLegacyLedgerBytes(
      null as never,
      ordinaryGuard,
      null,
    )) as {
      readonly expectedHash: { readonly digest: ArtifactDigest };
      readonly expectedRevision: { readonly kind: string; readonly digest: ArtifactDigest } | null;
      readonly expectedState: string;
    };
    expect(actual).toMatchObject({
      expectedState: 'present',
      expectedRevision: { kind: 'artifact-bytes' },
    });
    if (actual.expectedRevision === null) throw new Error('ledger byte revision was absent');
    expect(actual.expectedHash.digest).toBe(actual.expectedRevision.digest);
    expect(actual.expectedHash.digest).not.toBe(ordinaryGuard.expectedHash.digest);
  });
});

describe('validated reconciliation physical boundary', () => {
  test('owns the exact signed artifact pair and rejects a lock-source/path mismatch', async () => {
    const context = await fixture();
    const alternateLock = join(context.root, 'reviewed.lock');
    await writeFile(alternateLock, await readFile(join(context.root, 'skillsmith.lock')));
    const prepared = await prepareReconcilePlan(
      {
        file: 'skillsmith.toml',
        lockfile: 'reviewed.lock',
        tools: [],
        scope: null,
        locked: true,
        prune: false,
        check: false,
      },
      {
        ports: context.ports,
        configuration: context.configuration,
        invocationCwd: context.root,
        projectContext: context.project,
      },
    );
    if (!prepared.ok) throw new Error(prepared.error.message);
    const validated = await validateSavedReconcilePlanValue(prepared.value.projection.plan, {
      ports: context.ports,
      configuration: context.configuration,
      projectContext: context.project,
    });
    if (!validated.ok) throw new Error(validated.error.message);
    expect(validated.value.pair).toMatchObject({
      file: { path: join(context.root, 'skillsmith.toml') },
      lockfile: { path: alternateLock },
      lockfileSource: 'explicit',
    });

    const mismatched = structuredClone(prepared.value.projection.plan);
    (
      mismatched.artifactPair as unknown as {
        lockSource: 'explicit' | 'sibling';
      }
    ).lockSource = 'sibling';
    expect(
      await validateSavedReconcilePlanValue(mismatched, {
        ports: context.ports,
        configuration: context.configuration,
        projectContext: context.project,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'apply-saved-artifact-binding', exitClass: 'state' },
    });
  });

  test('derives exact capability queries and the copy replacement bridge', async () => {
    const execution = await physicalExecutionFixture();
    const queries = createReconcileCapabilityQueriesV1(execution.validated.guards);
    expect(queries).toEqual(
      execution.validated.guards.capabilityPreconditions.flatMap((guard) =>
        guard.scopes.map((scope) => ({
          schemaVersion: 1,
          tool: guard.tool,
          operation: guard.operation,
          scope,
        })),
      ),
    );
    expect(queries.length).toBeGreaterThan(0);
    expect(Object.isFrozen(queries)).toBeTrue();
    const operation = execution.validated.plan.operations.find(
      ({ after }) => after.kind === 'placement' && after.representation === 'copy',
    );
    if (operation?.after.kind !== 'placement') throw new Error('fixture has no copy operation');
    const snapshot = {
      storePath: join(execution.context.root, 'store', 'alpha'),
      rev: '1'.repeat(12),
      contentHash: operation.after.contentHash as ArtifactDigest,
      reused: false,
    };
    const bridge = createReconcileCopyReplacementIntermediatePinnedV1(
      snapshot,
      '1'.repeat(40),
      operation.after,
      'copy',
      '2026-07-19T00:00:00.000Z',
    );
    expect(bridge).toMatchObject({
      storePath: snapshot.storePath,
      gitSha: '1'.repeat(40),
      placement: 'symlink',
    });
    expect(Object.isFrozen(bridge)).toBeTrue();
    expect(
      createReconcileCopyReplacementIntermediatePinnedV1(
        snapshot,
        '1'.repeat(40),
        operation.after,
        'symlink',
        '2026-07-19T00:00:00.000Z',
      ),
    ).toBeNull();
  });

  test('installs successfully, preserves requested-ref provenance, and reruns idempotently', async () => {
    const execution = await physicalExecutionFixture();
    const runtime = {
      ports: execution.ports,
      configuration: execution.context.configuration,
      projectContext: execution.context.project,
      artifactCoordinator: execution.artifactCoordinator,
      observation: execution.observation,
      continueOnError: false,
    };
    const installed = await executeValidatedReconcilePlan(execution.validated, runtime);
    expect(installed.ok, JSON.stringify(installed)).toBeTrue();
    if (!installed.ok) throw new Error(installed.error.message);
    expect(installed.value).toMatchObject([{ outcome: 'succeeded' }]);
    const livePath = join(execution.context.ports.homeDir, '.agents', 'skills', 'alpha');
    expect(await execution.context.ports.pathKind(livePath)).toBe('dir');
    const firstLedger = await readLedgerState(
      execution.context.ports,
      ledgerPathOf(execution.context.configuration.skillsmithHome as string),
    );
    if (!firstLedger.ok || firstLedger.value.state !== 'present') {
      throw new Error('physical install did not persist its ledger');
    }
    const firstPair = getLedgerPairAt(firstLedger.value.model, null, 'alpha', 'codex');
    expect(firstPair).toMatchObject({
      mode: 'pinned',
      pinned: { gitSha: '1'.repeat(40), placement: 'copy' },
      origin: { refRequested: 'reviewed-main', refResolved: '1'.repeat(40) },
    });

    const unchanged = await prepareReconcilePlan(
      {
        file: 'skillsmith.toml',
        tools: [],
        scope: null,
        locked: true,
        prune: false,
        check: false,
      },
      {
        ports: execution.context.ports,
        configuration: execution.context.configuration,
        invocationCwd: execution.context.root,
        projectContext: execution.context.project,
      },
    );
    if (!unchanged.ok) throw new Error(unchanged.error.message);
    expect(unchanged.value.product.plan.operations).toHaveLength(0);
    const ledgerBeforeNoop = await readFile(
      ledgerPathOf(execution.context.configuration.skillsmithHome as string),
    );
    const validatedNoop = await validateSavedReconcilePlanValue(unchanged.value.projection.plan, {
      ports: execution.context.ports,
      configuration: execution.context.configuration,
      projectContext: execution.context.project,
    });
    if (!validatedNoop.ok) throw new Error(validatedNoop.error.message);
    expect(
      await executeValidatedReconcilePlan(validatedNoop.value, {
        ...runtime,
      }),
    ).toEqual({ ok: true, value: [] });
    expect(
      await readFile(ledgerPathOf(execution.context.configuration.skillsmithHome as string)),
    ).toEqual(ledgerBeforeNoop);
  });

  test('returns permission outcomes instead of throwing across pre-physical filesystem boundaries', async () => {
    const privateMaterial = 'synthetic-private-material::prephysical-permission::do-not-emit';
    const execute = async (
      execution: Awaited<ReturnType<typeof physicalExecutionFixture>>,
      ports: RuntimePorts,
    ) =>
      executeValidatedReconcilePlan(execution.validated, {
        ports,
        configuration: execution.context.configuration,
        projectContext: execution.context.project,
        artifactCoordinator: execution.artifactCoordinator,
        observation: execution.observation,
        continueOnError: false,
      });

    const ledgerCreate = await physicalExecutionFixture();
    const ledgerDirectory = dirname(
      ledgerPathOf(ledgerCreate.context.configuration.skillsmithHome as string),
    );
    const createDenied = await execute(ledgerCreate, {
      ...ledgerCreate.ports,
      makeDir: async (path) => {
        if (path === ledgerDirectory) {
          throw Object.assign(new Error(privateMaterial), { code: 'EACCES' });
        }
        return ledgerCreate.ports.makeDir(path);
      },
    });
    expect(createDenied).toMatchObject({
      ok: false,
      error: { code: 'reconcile-execution-permission', exitClass: 'permission' },
    });
    expect(JSON.stringify(createDenied)).not.toContain(privateMaterial);

    const ledgerRead = await physicalExecutionFixture();
    const ledgerPath = ledgerPathOf(ledgerRead.context.configuration.skillsmithHome as string);
    let physicalRead = false;
    const readDenied = await execute(ledgerRead, {
      ...ledgerRead.ports,
      makeDir: async (path) => {
        await ledgerRead.ports.makeDir(path);
        if (path === dirname(ledgerPath)) physicalRead = true;
      },
      pathKind: async (path) =>
        physicalRead && path === ledgerPath ? 'file' : ledgerRead.ports.pathKind(path),
      readBytes: async (path) => {
        if (physicalRead && path === ledgerPath) {
          throw Object.assign(new Error(privateMaterial), { code: 'EPERM' });
        }
        return ledgerRead.ports.readBytes(path);
      },
    });
    expect(readDenied).toMatchObject({
      ok: false,
      error: { code: 'apply-execution-snapshot', exitClass: 'permission' },
    });
    expect(JSON.stringify(readDenied)).not.toContain(privateMaterial);

    const storeProbe = await physicalExecutionFixture();
    let physicalProbe = false;
    const probeDenied = await execute(storeProbe, {
      ...storeProbe.ports,
      makeDir: async (path) => {
        await storeProbe.ports.makeDir(path);
        physicalProbe = true;
      },
      pathKind: async (path) => {
        if (physicalProbe && path.includes(`${sep}store${sep}`)) {
          throw Object.assign(new Error(privateMaterial), { code: 'EACCES' });
        }
        return storeProbe.ports.pathKind(path);
      },
    });
    expect(probeDenied).toMatchObject({
      ok: false,
      error: { code: 'apply-execution-snapshot', exitClass: 'permission' },
    });
    expect(JSON.stringify(probeDenied)).not.toContain(privateMaterial);

    const materialization = await physicalExecutionFixture();
    const materializeDenied = await execute(materialization, {
      ...materialization.ports,
      git: {
        ...materialization.ports.git,
        materializeTree: async () => {
          throw Object.assign(new Error(privateMaterial), { code: 'EPERM' });
        },
      },
    });
    expect(materializeDenied).toMatchObject({
      ok: false,
      error: { code: 'apply-source-resolution', exitClass: 'permission' },
    });
    expect(JSON.stringify(materializeDenied)).not.toContain(privateMaterial);
  });

  test('preserves permission and the before image when an ordinary physical commit is denied', async () => {
    const execution = await physicalExecutionFixture();
    const privateMaterial = 'synthetic-private-material::physical-permission::do-not-emit';
    const livePath = join(execution.context.ports.homeDir, '.agents', 'skills', 'alpha');
    const ports: RuntimePorts = {
      ...execution.ports,
      rename: async (from, to) => {
        if (to === livePath) {
          throw Object.assign(new Error(privateMaterial), { code: 'EACCES' });
        }
        return execution.ports.rename(from, to);
      },
    };
    const executed = await executeValidatedReconcilePlan(execution.validated, {
      ports,
      configuration: execution.context.configuration,
      projectContext: execution.context.project,
      artifactCoordinator: execution.artifactCoordinator,
      observation: execution.observation,
      continueOnError: false,
    });
    expect(executed).toMatchObject({
      ok: true,
      value: [
        {
          outcome: 'failed',
          actualBefore: execution.validated.plan.operations[0]?.before,
          actualAfter: execution.validated.plan.operations[0]?.before,
          error: { code: 'permission-denied' },
        },
      ],
    });
    expect(JSON.stringify(executed)).not.toContain(privateMaterial);
  });

  test('reports the durable after image when update backup cleanup is denied after commit', async () => {
    const execution = await physicalExecutionFixture();
    const runtime = {
      ports: execution.ports,
      configuration: execution.context.configuration,
      projectContext: execution.context.project,
      artifactCoordinator: execution.artifactCoordinator,
      observation: execution.observation,
      continueOnError: false,
    };
    const installed = await executeValidatedReconcilePlan(execution.validated, runtime);
    expect(installed).toMatchObject({ ok: true, value: [{ outcome: 'succeeded' }] });
    if (!installed.ok) throw new Error(installed.error.message);
    const currentHash = execution.contentHashes.get('alpha');
    if (currentHash === undefined) throw new Error('installed fixture has no alpha content hash');
    await seedLegacyLedgerDigest(execution, 'alpha');
    const relinkManifest: NormalizedManifestV1 = {
      version: 1,
      skills: [
        {
          name: 'alpha',
          source: {
            host: 'fixture.invalid',
            repository: 'acme/skills',
            path: 'skills/alpha',
          },
          ref: 'reviewed-main',
          tools: ['codex'],
          scope: 'user',
          placement: 'symlink',
          path: null,
        },
      ],
    };
    const manifestCodec = artifactContractRegistry.get('manifest', 1);
    if (manifestCodec === undefined) throw new Error('manifest codec unavailable');
    const encodedManifest = manifestCodec.encode(relinkManifest);
    if (!encodedManifest.ok) throw new Error(encodedManifest.error.message);
    const encodedLock = serializePortableLock({
      version: 1,
      hashSchemaVersion: 1,
      manifestHash: hashManifestSemantics(relinkManifest),
      skills: [
        {
          name: 'alpha',
          source: 'fixture.invalid/acme/skills//skills/alpha',
          requestedRef: 'reviewed-main',
          resolvedSha: '1'.repeat(40),
          sourcePath: 'skills/alpha',
          contentHash: currentHash,
        },
      ],
    });
    if (!encodedLock.ok) throw new Error(encodedLock.error.message);
    await Promise.all([
      writeFile(join(execution.context.root, 'skillsmith.toml'), encodedManifest.value),
      writeFile(join(execution.context.root, 'skillsmith.lock'), encodedLock.value),
    ]);
    const prepared = await prepareReconcilePlan(
      {
        file: 'skillsmith.toml',
        tools: [],
        scope: null,
        locked: true,
        prune: false,
        check: false,
      },
      {
        ports: execution.ports,
        configuration: execution.context.configuration,
        invocationCwd: execution.context.root,
        projectContext: execution.context.project,
      },
    );
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.value.product.plan.operations).toMatchObject([
      { kind: 'update', conflict: null },
    ]);
    const validated = await validateSavedReconcilePlanValue(prepared.value.projection.plan, {
      ports: execution.ports,
      configuration: execution.context.configuration,
      projectContext: execution.context.project,
    });
    if (!validated.ok) throw new Error(validated.error.message);
    const operation = validated.value.plan.operations[0];
    if (operation?.kind !== 'update') throw new Error('relink plan has no update operation');

    const privateMaterial = 'synthetic-private-material::cleanup-permission::do-not-emit';
    const ports: RuntimePorts = {
      ...execution.ports,
      removeTree: async (path) => {
        if (path.includes('.skillsmith-backup-alpha-')) {
          throw Object.assign(new Error(privateMaterial), { code: 'EPERM' });
        }
        return execution.ports.removeTree(path);
      },
    };
    const executed = await executeValidatedReconcilePlan(validated.value, {
      ...runtime,
      ports,
    });
    expect(executed).toMatchObject({
      ok: true,
      value: [
        {
          operationId: operation.operationId,
          outcome: 'failed',
          actualBefore: operation.before,
          actualAfter: operation.after,
          error: { code: 'permission-denied' },
        },
      ],
    });
    expect(JSON.stringify(executed)).not.toContain(privateMaterial);
    expect(
      await ports.pathKind(join(execution.context.ports.homeDir, '.agents', 'skills', 'alpha')),
    ).toBe('symlink');
  });

  test('keeps prune bounded when the replacement manifest no longer selects an owned placement', async () => {
    const execution = await physicalExecutionFixture(['alpha', 'beta'], ['alpha']);
    const runtime = {
      ports: execution.ports,
      configuration: execution.context.configuration,
      projectContext: execution.context.project,
      artifactCoordinator: execution.artifactCoordinator,
      observation: execution.observation,
      continueOnError: false,
    };
    const installed = await executeValidatedReconcilePlan(execution.validated, runtime);
    expect(installed).toMatchObject({ ok: true, value: [{ outcome: 'succeeded' }] });
    if (!installed.ok) throw new Error(installed.error.message);
    const betaHash = execution.contentHashes.get('beta');
    if (betaHash === undefined) throw new Error('removal fixture has no beta content hash');
    const retainedManifest: NormalizedManifestV1 = {
      version: 1,
      skills: [
        {
          name: 'beta',
          source: {
            host: 'fixture.invalid',
            repository: 'acme/skills',
            path: 'skills/beta',
          },
          ref: 'reviewed-main',
          tools: ['codex'],
          scope: 'user',
          placement: 'copy',
          path: null,
        },
      ],
    };
    const manifestCodec = artifactContractRegistry.get('manifest', 1);
    if (manifestCodec === undefined) throw new Error('manifest codec unavailable');
    const encodedManifest = manifestCodec.encode(retainedManifest);
    if (!encodedManifest.ok) throw new Error(encodedManifest.error.message);
    const encodedLock = serializePortableLock({
      version: 1,
      hashSchemaVersion: 1,
      manifestHash: hashManifestSemantics(retainedManifest),
      skills: [
        {
          name: 'beta',
          source: 'fixture.invalid/acme/skills//skills/beta',
          requestedRef: 'reviewed-main',
          resolvedSha: '2'.repeat(40),
          sourcePath: 'skills/beta',
          contentHash: betaHash,
        },
      ],
    });
    if (!encodedLock.ok) throw new Error(encodedLock.error.message);
    await Promise.all([
      writeFile(join(execution.context.root, 'skillsmith.toml'), encodedManifest.value),
      writeFile(join(execution.context.root, 'skillsmith.lock'), encodedLock.value),
    ]);
    const prepared = await prepareReconcilePlan(
      {
        file: 'skillsmith.toml',
        tools: ['codex'],
        scope: null,
        locked: false,
        prune: true,
        check: false,
      },
      {
        ports: execution.ports,
        configuration: execution.context.configuration,
        invocationCwd: execution.context.root,
        projectContext: execution.context.project,
      },
    );
    if (!prepared.ok) throw new Error(prepared.error.message);
    const preparedKinds = prepared.value.product.plan.operations.map(({ kind }) => kind).toSorted();
    expect(preparedKinds).toEqual(['install']);
    expect(prepared.value.observation.prunePlacements).toEqual([]);
    expect(
      await execution.ports.pathKind(
        join(execution.context.ports.homeDir, '.agents', 'skills', 'alpha'),
      ),
    ).toBe('dir');
  });

  test('reports a durable removal after-state when backup cleanup is interrupted', async () => {
    const execution = await physicalExecutionFixture(['alpha', 'beta']);
    const runtime = {
      ports: execution.ports,
      configuration: execution.context.configuration,
      projectContext: execution.context.project,
      artifactCoordinator: execution.artifactCoordinator,
      observation: execution.observation,
      continueOnError: false,
    };
    const installed = await executeValidatedReconcilePlan(execution.validated, runtime);
    expect(installed).toMatchObject({
      ok: true,
      value: [{ outcome: 'succeeded' }, { outcome: 'succeeded' }],
    });
    if (!installed.ok) throw new Error(installed.error.message);
    await seedLegacyLedgerDigest(execution, 'alpha');

    const retainedManifest: NormalizedManifestV1 = {
      version: 1,
      skills: [
        {
          name: 'beta',
          source: {
            host: 'fixture.invalid',
            repository: 'acme/skills',
            path: 'skills/beta',
          },
          ref: 'reviewed-main',
          tools: ['codex'],
          scope: 'user',
          placement: 'copy',
          path: null,
        },
      ],
    };
    const manifestCodec = artifactContractRegistry.get('manifest', 1);
    if (manifestCodec === undefined) throw new Error('manifest codec unavailable');
    const encodedManifest = manifestCodec.encode(retainedManifest);
    if (!encodedManifest.ok) throw new Error(encodedManifest.error.message);
    await writeFile(join(execution.context.root, 'skillsmith.toml'), encodedManifest.value);

    const prepared = await prepareReconcilePlan(
      {
        file: 'skillsmith.toml',
        tools: [],
        scope: null,
        locked: false,
        prune: true,
        check: false,
      },
      {
        ports: execution.ports,
        configuration: execution.context.configuration,
        invocationCwd: execution.context.root,
        projectContext: execution.context.project,
      },
    );
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.value.product.plan.operations.map(({ kind }) => kind)).toContain('remove');
    const validated = await validateSavedReconcilePlanValue(prepared.value.projection.plan, {
      ports: execution.ports,
      configuration: execution.context.configuration,
      projectContext: execution.context.project,
    });
    if (!validated.ok) throw new Error(validated.error.message);
    const removal = validated.value.plan.operations.find(({ kind }) => kind === 'remove');
    if (removal === undefined) throw new Error('prune plan has no remove operation');

    const privateMaterial = 'private removal cleanup cancellation';
    const ports: RuntimePorts = {
      ...execution.ports,
      removeTree: async (path) => {
        if (path.includes('.skillsmith-backup-alpha-')) {
          throw Object.assign(new Error(privateMaterial), { code: 'cancelled' });
        }
        return execution.ports.removeTree(path);
      },
    };
    const executed = await executeValidatedReconcilePlan(validated.value, { ...runtime, ports });
    expect(executed.ok).toBeTrue();
    if (!executed.ok) throw new Error(executed.error.message);
    const removalResult = executed.value.find(
      ({ operationId }) => operationId === removal.operationId,
    );
    expect(removalResult).toMatchObject({
      outcome: 'failed',
      actualBefore: removal.before,
      actualAfter: removal.after,
      error: { code: 'flip-failed' },
    });
    expect(JSON.stringify(executed)).not.toContain(privateMaterial);
    expect(
      await ports.pathKind(join(execution.context.ports.homeDir, '.agents', 'skills', 'alpha')),
    ).toBe('absent');
  });

  test('advances shared-parent lifecycle revisions across independent placement groups', async () => {
    const execution = await physicalExecutionFixture(['alpha', 'beta']);
    const installed = await executeValidatedReconcilePlan(execution.validated, {
      ports: execution.ports,
      configuration: execution.context.configuration,
      projectContext: execution.context.project,
      artifactCoordinator: execution.artifactCoordinator,
      observation: execution.observation,
      continueOnError: false,
    });

    expect(installed).toMatchObject({
      ok: true,
      value: [{ outcome: 'succeeded' }, { outcome: 'succeeded' }],
    });
    for (const skill of ['alpha', 'beta']) {
      expect(
        await execution.context.ports.pathKind(
          join(execution.context.ports.homeDir, '.agents', 'skills', skill),
        ),
      ).toBe('dir');
    }
    const ledger = await readLedgerState(
      execution.context.ports,
      ledgerPathOf(execution.context.configuration.skillsmithHome as string),
    );
    if (!ledger.ok || ledger.value.state !== 'present') {
      throw new Error('multi-group install did not persist its ledger');
    }
    expect(getLedgerPairAt(ledger.value.model, null, 'alpha', 'codex')).not.toBeNull();
    expect(getLedgerPairAt(ledger.value.model, null, 'beta', 'codex')).not.toBeNull();
  });

  test('advances one lifecycle cursor across a scope move followed by ordinary placement', async () => {
    const execution = await physicalExecutionFixture(['alpha', 'beta'], ['alpha']);
    const runtime = {
      ports: execution.ports,
      configuration: execution.context.configuration,
      projectContext: execution.context.project,
      artifactCoordinator: execution.artifactCoordinator,
      observation: execution.observation,
      continueOnError: false,
    };
    const seeded = await executeValidatedReconcilePlan(execution.validated, runtime);
    if (!seeded.ok) throw new Error(seeded.error.message);
    await seedLegacyLedgerDigest(execution, 'alpha');

    const prepared = await preparePhysicalScopePlan(execution, [
      { name: 'alpha', scope: 'project' },
      { name: 'beta', scope: 'project' },
    ]);
    expect(prepared.prepared.product.plan.operations.map(({ kind }) => kind)).toEqual([
      'move-scope',
      'install',
    ]);

    const applied = await executeValidatedReconcilePlan(prepared.validated, runtime);
    expect(applied).toMatchObject({
      ok: true,
      value: [{ outcome: 'succeeded' }, { outcome: 'succeeded' }],
    });
    expect(
      await execution.context.ports.pathKind(
        join(execution.context.ports.homeDir, '.agents', 'skills', 'alpha'),
      ),
    ).toBe('absent');
    expect(
      await execution.context.ports.pathKind(
        join(execution.context.root, '.agents', 'skills', 'alpha'),
      ),
    ).toBe('dir');
    expect(
      await execution.context.ports.pathKind(
        join(execution.context.root, '.agents', 'skills', 'beta'),
      ),
    ).toBe('dir');
    const ledger = await readLedgerState(
      execution.context.ports,
      ledgerPathOf(execution.context.configuration.skillsmithHome as string),
    );
    if (!ledger.ok || ledger.value.state !== 'present') {
      throw new Error('mixed move and placement did not persist its ledger');
    }
    expect(getLedgerPairAt(ledger.value.model, null, 'alpha', 'codex')).toBeNull();
    expect(
      getLedgerPairAt(ledger.value.model, execution.context.root, 'alpha', 'codex'),
    ).not.toBeNull();
    expect(
      getLedgerPairAt(ledger.value.model, execution.context.root, 'beta', 'codex'),
    ).not.toBeNull();
  });

  test('advances one lifecycle cursor across ordinary placement followed by a scope move', async () => {
    const execution = await physicalExecutionFixture(['alpha', 'beta'], ['alpha']);
    const runtime = {
      ports: execution.ports,
      configuration: execution.context.configuration,
      projectContext: execution.context.project,
      artifactCoordinator: execution.artifactCoordinator,
      observation: execution.observation,
      continueOnError: false,
    };
    const seeded = await executeValidatedReconcilePlan(execution.validated, runtime);
    if (!seeded.ok) throw new Error(seeded.error.message);
    const prepared = await preparePhysicalScopePlan(execution, [
      { name: 'alpha', scope: 'project' },
      { name: 'beta', scope: 'user' },
    ]);
    expect(prepared.prepared.product.plan.operations.map(({ kind }) => kind)).toEqual([
      'install',
      'move-scope',
    ]);

    const applied = await executeValidatedReconcilePlan(prepared.validated, runtime);
    expect(applied).toMatchObject({
      ok: true,
      value: [{ outcome: 'succeeded' }, { outcome: 'succeeded' }],
    });
    expect(
      await execution.context.ports.pathKind(
        join(execution.context.ports.homeDir, '.agents', 'skills', 'beta'),
      ),
    ).toBe('dir');
    expect(
      await execution.context.ports.pathKind(
        join(execution.context.root, '.agents', 'skills', 'alpha'),
      ),
    ).toBe('dir');
  });

  test('refuses an externally occupied mixed-plan destination before moving reviewed state', async () => {
    const execution = await physicalExecutionFixture(['alpha', 'beta'], ['alpha']);
    const runtime = {
      ports: execution.ports,
      configuration: execution.context.configuration,
      projectContext: execution.context.project,
      artifactCoordinator: execution.artifactCoordinator,
      observation: execution.observation,
      continueOnError: false,
    };
    const seeded = await executeValidatedReconcilePlan(execution.validated, runtime);
    if (!seeded.ok) throw new Error(seeded.error.message);
    const prepared = await preparePhysicalScopePlan(execution, [
      { name: 'alpha', scope: 'project' },
      { name: 'beta', scope: 'project' },
    ]);
    expect(prepared.prepared.product.plan.operations.map(({ kind }) => kind)).toEqual([
      'move-scope',
      'install',
    ]);
    const occupied = join(execution.context.root, '.agents', 'skills', 'beta');
    await mkdir(occupied, { recursive: true });
    await writeFile(
      join(occupied, 'SKILL.md'),
      '---\nname: beta\ndescription: external post-review placement\n---\n',
    );

    expect(await executeValidatedReconcilePlan(prepared.validated, runtime)).toMatchObject({
      ok: false,
      error: { code: 'apply-execution-stale', exitClass: 'state' },
    });
    expect(
      await execution.context.ports.pathKind(
        join(execution.context.ports.homeDir, '.agents', 'skills', 'alpha'),
      ),
    ).toBe('dir');
    expect(
      await execution.context.ports.pathKind(
        join(execution.context.root, '.agents', 'skills', 'alpha'),
      ),
    ).toBe('absent');
    expect(await readFile(join(occupied, 'SKILL.md'), 'utf8')).toContain(
      'external post-review placement',
    );
  });

  test('refuses sibling mutation after a move commits and before the next physical body', async () => {
    const execution = await physicalExecutionFixture(['alpha', 'beta'], ['alpha']);
    const runtime = {
      ports: execution.ports,
      configuration: execution.context.configuration,
      projectContext: execution.context.project,
      artifactCoordinator: execution.artifactCoordinator,
      observation: execution.observation,
      continueOnError: false,
    };
    const seeded = await executeValidatedReconcilePlan(execution.validated, runtime);
    if (!seeded.ok) throw new Error(seeded.error.message);
    const prepared = await preparePhysicalScopePlan(execution, [
      { name: 'alpha', scope: 'project' },
      { name: 'beta', scope: 'project' },
    ]);
    const operations = prepared.prepared.product.plan.operations;
    expect(operations.map(({ kind }) => kind)).toEqual(['move-scope', 'install']);
    expect(operations[0]?.groupId).not.toBe(operations[1]?.groupId);
    const occupied = join(execution.context.root, '.agents', 'skills', 'beta');
    let injected = false;
    const observation = {
      context: execution.observation.context,
      emitter: createObservationEmitter({
        observer: {
          observe: (event) => {
            if (
              !injected &&
              event.kind === 'operation.completed' &&
              event.operationKind === 'move-scope' &&
              event.outcome === 'success'
            ) {
              mkdirSync(occupied, { recursive: true });
              writeFileSync(
                join(occupied, 'SKILL.md'),
                '---\nname: beta\ndescription: external between-operation placement\n---\n',
              );
              injected = true;
            }
          },
        },
      }),
    };

    const applied = await executeValidatedReconcilePlan(prepared.validated, {
      ...runtime,
      observation,
    });
    expect(injected).toBeTrue();
    expect(applied).toMatchObject({
      ok: true,
      value: [
        { outcome: 'succeeded' },
        { outcome: 'failed', error: { code: 'repository-lifecycle-failed' } },
      ],
    });
    expect(
      await execution.context.ports.pathKind(
        join(execution.context.root, '.agents', 'skills', 'alpha'),
      ),
    ).toBe('dir');
    expect(await readFile(join(occupied, 'SKILL.md'), 'utf8')).toContain(
      'external between-operation placement',
    );
  });

  test('refuses stale live state before source preparation or physical writes', async () => {
    const execution = await physicalExecutionFixture();
    const livePath = join(execution.context.ports.homeDir, '.agents', 'skills', 'alpha');
    await mkdir(livePath, { recursive: true });
    await writeFile(
      join(livePath, 'SKILL.md'),
      '---\nname: alpha\ndescription: state added after validation\n---\n',
    );
    const effects: string[] = [];
    const ports: RuntimePorts = {
      ...execution.ports,
      git: {
        ...execution.ports.git,
        initializeFetch: async () => {
          effects.push('git-initialize');
        },
        fetchRef: async () => {
          effects.push('git-fetch');
          return { sha: '1'.repeat(40) };
        },
      },
      makeDir: async (path) => {
        effects.push('make-dir');
        return execution.context.ports.makeDir(path);
      },
      copyTree: async (from, to) => {
        effects.push('copy-tree');
        return execution.context.ports.copyTree(from, to);
      },
      makeSymlink: async (target, path) => {
        effects.push('make-symlink');
        return execution.context.ports.makeSymlink(target, path);
      },
      rename: async (from, to) => {
        effects.push('rename');
        return execution.context.ports.rename(from, to);
      },
      writeTextFile: async (path, value) => {
        effects.push('write');
        return execution.context.ports.writeTextFile(path, value);
      },
    };
    const executed = await executeValidatedReconcilePlan(execution.validated, {
      ports,
      configuration: execution.context.configuration,
      projectContext: execution.context.project,
      artifactCoordinator: execution.artifactCoordinator,
      observation: execution.observation,
      continueOnError: false,
    });
    expect(executed).toMatchObject({
      ok: false,
      error: { code: 'apply-execution-stale', exitClass: 'state' },
    });
    expect(effects).toEqual([]);
  });

  test('cleans materialized sources when post-materialization snapshot setup fails', async () => {
    const execution = await physicalExecutionFixture();
    const manifestPath = join(execution.context.root, 'skillsmith.toml');
    const dataDir = execution.context.configuration.skillsmithHome as string;
    expect(await execution.context.ports.pathKind(dataDir)).toBe('absent');
    let materialized = false;
    const cleaned: string[] = [];
    const ports: RuntimePorts = {
      ...execution.ports,
      git: {
        ...execution.ports.git,
        materializeTree: async () => {
          materialized = true;
          return execution.remoteSkill;
        },
      },
      readBytes: async (path) => {
        if (materialized && path === manifestPath) {
          throw new Error('synthetic post-materialization snapshot failure');
        }
        return execution.context.ports.readBytes(path);
      },
      removeTree: async (path) => {
        cleaned.push(path);
        return execution.context.ports.removeTree(path);
      },
    };
    const executed = await executeValidatedReconcilePlan(execution.validated, {
      ports,
      configuration: execution.context.configuration,
      projectContext: execution.context.project,
      artifactCoordinator: execution.artifactCoordinator,
      observation: execution.observation,
      continueOnError: false,
    });
    expect(materialized).toBeTrue();
    expect(executed).toMatchObject({
      ok: false,
      error: { code: 'apply-execution-snapshot', exitClass: 'state' },
    });
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0]).toContain('.skillsmith-apply-fetch-');
    expect(await execution.context.ports.pathKind(dataDir)).toBe('absent');
  });

  test('removes a newly bootstrapped ledger directory when its locked snapshot fails', async () => {
    const execution = await physicalExecutionFixture();
    const manifestPath = join(execution.context.root, 'skillsmith.toml');
    const dataDir = execution.context.configuration.skillsmithHome as string;
    expect(await execution.context.ports.pathKind(dataDir)).toBe('absent');
    let materialized = false;
    let postMaterializationManifestReads = 0;
    const ports: RuntimePorts = {
      ...execution.ports,
      git: {
        ...execution.ports.git,
        materializeTree: async () => {
          materialized = true;
          return execution.remoteSkill;
        },
      },
      readBytes: async (path) => {
        if (materialized && path === manifestPath) {
          postMaterializationManifestReads += 1;
          if (postMaterializationManifestReads === 2) {
            throw new Error('synthetic locked snapshot failure');
          }
        }
        return execution.context.ports.readBytes(path);
      },
    };
    const executed = await executeValidatedReconcilePlan(execution.validated, {
      ports,
      configuration: execution.context.configuration,
      projectContext: execution.context.project,
      artifactCoordinator: execution.artifactCoordinator,
      observation: execution.observation,
      continueOnError: false,
    });
    expect(materialized).toBeTrue();
    expect(postMaterializationManifestReads).toBe(2);
    expect(executed).toMatchObject({
      ok: false,
      error: { code: 'apply-execution-snapshot', exitClass: 'state' },
    });
    expect(await execution.context.ports.pathKind(dataDir)).toBe('absent');
  });

  test('cleans every accumulated source when a later materialization is stale', async () => {
    const execution = await physicalExecutionFixture(['alpha', 'beta']);
    const beta = execution.remoteSkills.get('beta');
    if (beta === undefined) throw new Error('beta fixture source is unavailable');
    await writeFile(
      join(beta, 'SKILL.md'),
      '---\nname: beta\ndescription: changed after review\n---\n',
    );
    const cleaned: string[] = [];
    const ports: RuntimePorts = {
      ...execution.ports,
      removeTree: async (path) => {
        if (path.includes('.skillsmith-apply-fetch-')) cleaned.push(path);
        return execution.context.ports.removeTree(path);
      },
    };

    const executed = await executeValidatedReconcilePlan(execution.validated, {
      ports,
      configuration: execution.context.configuration,
      projectContext: execution.context.project,
      artifactCoordinator: execution.artifactCoordinator,
      observation: execution.observation,
      continueOnError: false,
    });

    expect(executed).toMatchObject({
      ok: false,
      error: { code: 'apply-source-stale', exitClass: 'state' },
    });
    expect(new Set(cleaned).size).toBe(2);
  });

  test('cleans the current and earlier sources when later preparation is cancelled', async () => {
    const execution = await physicalExecutionFixture(['alpha', 'beta']);
    const controller = new AbortController();
    const cleaned: string[] = [];
    const ports: RuntimePorts = {
      ...execution.ports,
      git: {
        ...execution.ports.git,
        materializeTree: async (request) => {
          const materialized = await execution.ports.git.materializeTree(request);
          if (request.path === 'skills/beta') controller.abort();
          return materialized;
        },
      },
      removeTree: async (path) => {
        if (path.includes('.skillsmith-apply-fetch-')) cleaned.push(path);
        return execution.context.ports.removeTree(path);
      },
    };

    const executed = await executeValidatedReconcilePlan(execution.validated, {
      ports,
      configuration: execution.context.configuration,
      projectContext: execution.context.project,
      artifactCoordinator: execution.artifactCoordinator,
      observation: execution.observation,
      continueOnError: false,
      signal: controller.signal,
    });

    expect(executed).toMatchObject({
      ok: false,
      error: { code: 'apply-saved-cancelled', exitClass: 'cancelled' },
    });
    expect(new Set(cleaned).size).toBe(2);
  });

  test('retains completed results when sole source cleanup fails', async () => {
    const execution = await physicalExecutionFixture();
    let cleanupAttempts = 0;
    const ports: RuntimePorts = {
      ...execution.ports,
      removeTree: async (path) => {
        if (path.includes('.skillsmith-apply-fetch-')) {
          cleanupAttempts += 1;
          throw new Error('synthetic source cleanup failure');
        }
        return execution.context.ports.removeTree(path);
      },
    };
    const executed = await executeValidatedReconcilePlan(execution.validated, {
      ports,
      configuration: execution.context.configuration,
      projectContext: execution.context.project,
      artifactCoordinator: execution.artifactCoordinator,
      observation: execution.observation,
      continueOnError: false,
    });
    expect(executed).toMatchObject({
      ok: false,
      error: {
        code: 'reconcile-execution-cleanup-failed',
        exitClass: 'failure',
        results: [{ outcome: 'succeeded' }],
      },
    });
    if (executed.ok || executed.error.results === undefined) {
      throw new Error('cleanup failure did not retain execution results');
    }
    expect(cleanupAttempts).toBe(1);
    expect(Object.isFrozen(executed.error.results)).toBeTrue();
    expect(Object.isFrozen(executed.error.results[0])).toBeTrue();
  });

  test('fetches a portable source by the exact reviewed SHA', async () => {
    const context = await fixture();
    const prepared = await prepareReconcilePlan(
      {
        file: 'skillsmith.toml',
        tools: [],
        scope: null,
        locked: true,
        prune: false,
        check: false,
      },
      {
        ports: context.ports,
        configuration: context.configuration,
        invocationCwd: context.root,
        projectContext: context.project,
      },
    );
    if (!prepared.ok) throw new Error(prepared.error.message);
    const validated = await validateSavedReconcilePlanValue(prepared.value.projection.plan, {
      ports: context.ports,
      configuration: context.configuration,
      projectContext: context.project,
    });
    if (!validated.ok) throw new Error(validated.error.message);
    const source = validated.value.plan.operations.find(
      (operation) => operation.source?.kind === 'portable',
    )?.source;
    if (source?.kind !== 'portable') throw new Error('fixture has no portable source');
    let fetchedRef: string | null | undefined;
    const ports: RuntimePorts = {
      ...context.ports,
      git: {
        ...context.ports.git,
        initializeFetch: async () => undefined,
        fetchRef: async (request) => {
          fetchedRef = request.ref;
          throw new Error('synthetic bounded fetch stop');
        },
      },
    };

    const executed = await executeValidatedReconcilePlan(validated.value, {
      ports,
      configuration: context.configuration,
      projectContext: context.project,
      artifactCoordinator: null as never,
      observation: null as never,
      continueOnError: false,
    });

    expect(executed).toMatchObject({
      ok: false,
      error: { code: 'apply-source-resolution', exitClass: 'source' },
    });
    expect(fetchedRef).toBe(source.resolvedSha);
    expect(fetchedRef).not.toBe(source.requestedRef);
  });

  test('refuses conflicts and underived scheduler policy before physical runtime access', async () => {
    const context = await fixture();
    const prepared = await prepareReconcilePlan(
      {
        file: 'skillsmith.toml',
        tools: [],
        scope: null,
        locked: true,
        prune: false,
        check: false,
      },
      {
        ports: context.ports,
        configuration: context.configuration,
        invocationCwd: context.root,
        projectContext: context.project,
      },
    );
    if (!prepared.ok) throw new Error(prepared.error.message);
    const validated = await validateSavedReconcilePlanValue(prepared.value.projection.plan, {
      ports: context.ports,
      configuration: context.configuration,
      projectContext: context.project,
    });
    if (!validated.ok) throw new Error(validated.error.message);
    const conflicted = structuredClone(validated.value);
    const operation = conflicted.plan.operations[0];
    if (operation?.after.kind !== 'placement')
      throw new Error('fixture has no placement operation');
    (
      operation as unknown as {
        conflict: NonNullable<(typeof operation)['conflict']>;
      }
    ).conflict = {
      class: 'destination-exists',
      normal: 'refuse',
      forced: 'backup-and-replace',
      target: operation.after.resource,
      backup: 'required',
    };
    let physicalReads = 0;
    const runtime = new Proxy(
      { signal: undefined, continueOnError: false },
      {
        get: (target, property) => {
          if (property === 'signal' || property === 'continueOnError') return target[property];
          physicalReads += 1;
          throw new Error(`unexpected physical runtime read: ${String(property)}`);
        },
      },
    ) as unknown as Parameters<typeof executeValidatedReconcilePlan>[1];

    expect(await executeValidatedReconcilePlan(conflicted, runtime)).toMatchObject({
      ok: false,
      error: { code: 'apply-execution-conflict', exitClass: 'state' },
    });
    expect(physicalReads).toBe(0);

    const continueRuntime = new Proxy(
      { signal: undefined, continueOnError: true },
      {
        get: (target, property) => {
          if (property === 'signal' || property === 'continueOnError') return target[property];
          physicalReads += 1;
          throw new Error(`unexpected physical runtime read: ${String(property)}`);
        },
      },
    ) as unknown as Parameters<typeof executeValidatedReconcilePlan>[1];
    expect(await executeValidatedReconcilePlan(validated.value, continueRuntime)).toMatchObject({
      ok: false,
      error: { code: 'apply-execution-plan', exitClass: 'state' },
    });
    expect(physicalReads).toBe(0);
  });
});
