import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectRetainedExecutionFailure } from '../../src/application/apply-service.ts';
import { type ArtifactDigest, hashManifestSemantics } from '../../src/artifacts/hash.ts';
import { serializePortableLock } from '../../src/artifacts/lock.ts';
import { createTestNodeArtifactCoordinatorPorts } from '../../src/artifacts/node-coordinator.ts';
import type { SavedPlanV1 } from '../../src/artifacts/plan-types.ts';
import { artifactContractRegistry } from '../../src/artifacts/registry.ts';
import type {
  NormalizedManifestDeclaration,
  NormalizedManifestV1,
} from '../../src/artifacts/types.ts';
import { applyV1Codec } from '../../src/contracts/v1/apply.ts';
import {
  type CurrentApplicationContext,
  type InteractionPort,
  prepareReconcilePlan,
  runApplyApplication,
  runPlanApplication,
} from '../../src/index.ts';
import {
  createObservationEmitter,
  createOperationContext,
  noopObserver,
} from '../../src/observation/index.ts';
import type { OperationExecutionResult } from '../../src/planning/types.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';
import type { ResolvedRuntimeConfiguration, RuntimePorts } from '../../src/ports/types.ts';

const roots: string[] = [];
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
  name: string,
  tool: 'codex' | 'kilo-code',
  scope: 'user' | 'project',
): NormalizedManifestDeclaration => ({
  name,
  source: { host: 'fixture.invalid', repository: 'acme/skills', path: `skills/${name}` },
  ref: null,
  tools: [tool],
  scope,
  placement: 'copy',
  path: null,
});

const forbiddenInteraction = new Proxy({} as InteractionPort, {
  get: (_target, property) => {
    if (property === 'mode') return 'noninteractive';
    throw new Error(`fresh non-execution mode unexpectedly read interaction.${String(property)}`);
  },
});

const applicationFixture = async (
  declarations: readonly NormalizedManifestDeclaration[],
  options: Readonly<{ writeLock?: boolean }> = {},
): Promise<
  Readonly<{
    root: string;
    manifestPath: string;
    lockPath: string;
    expectedLockSource: string;
    unrestrictedPorts: RuntimePorts;
    context: CurrentApplicationContext;
  }>
> => {
  const root = await mkdtemp(join(tmpdir(), 'skillsmith-apply-application-'));
  roots.push(root);
  const home = join(root, 'home');
  await mkdir(home, { recursive: true });
  const base = await defaultRuntimePorts();
  const unrestricted: RuntimePorts = {
    ...base,
    homeDir: home,
    xdg: {
      config: join(root, 'xdg', 'config'),
      data: join(root, 'xdg', 'data'),
      cache: join(root, 'xdg', 'cache'),
    },
  };
  const forbiddenPorts = new Set<PropertyKey>([
    'makeDir',
    'writeTextFile',
    'makeSymlink',
    'rename',
    'copyTree',
    'removeTree',
    'fsyncFile',
    'fsyncDir',
    'setFileMode',
    'withFileLock',
  ]);
  const ports = new Proxy(unrestricted, {
    get: (target, property, receiver) => {
      if (forbiddenPorts.has(property)) {
        return () => {
          throw new Error(`fresh non-execution mode unexpectedly used ports.${String(property)}`);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const manifest: NormalizedManifestV1 = { version: 1, skills: [...declarations] };
  const manifestCodec = artifactContractRegistry.get('manifest', 1);
  if (manifestCodec === undefined) throw new Error('manifest codec unavailable');
  const encodedManifest = manifestCodec.encode(manifest);
  if (!encodedManifest.ok) throw new Error(encodedManifest.error.message);
  const encodedLock = serializePortableLock({
    version: 1,
    hashSchemaVersion: 1,
    manifestHash: hashManifestSemantics(manifest),
    skills: declarations.map((row, index) => ({
      name: row.name,
      source: `${row.source.host}/${row.source.repository}//${row.source.path ?? '.'}`,
      requestedRef: row.ref,
      resolvedSha: String(index + 1).repeat(40),
      sourcePath: row.source.path ?? '.',
      contentHash: digest(String(index + 1)),
    })),
  });
  if (!encodedLock.ok) throw new Error(encodedLock.error.message);
  const manifestPath = join(root, 'skillsmith.toml');
  const lockPath = join(root, 'skillsmith.lock');
  await Promise.all([
    writeFile(manifestPath, encodedManifest.value),
    ...(options.writeLock === false ? [] : [writeFile(lockPath, encodedLock.value)]),
  ]);
  return {
    root,
    manifestPath,
    lockPath,
    expectedLockSource: encodedLock.value,
    unrestrictedPorts: unrestricted,
    context: {
      observation: {
        context: createOperationContext({
          command: 'skillsmith apply',
          workflow: 'apply',
          clock: {
            wallNowIso: () => '2026-07-19T00:00:00.000Z',
            monotonicMilliseconds: () => 0,
          },
          id: { nextId: () => 'apply-application-test' },
        }),
        emitter: createObservationEmitter({ observer: noopObserver }),
      },
      ports,
      artifactCoordinator: new Proxy({} as CurrentApplicationContext['artifactCoordinator'], {
        get: (_target, property) => {
          throw new Error(
            `fresh non-execution mode unexpectedly read artifactCoordinator.${String(property)}`,
          );
        },
      }),
      configuration: configuration(root),
      interaction: forbiddenInteraction,
      invocationCwd: root,
      globalOptions: {},
      projectContext: {
        invocationCwd: root,
        effectiveCwd: root,
        projectRoot: root,
        projectIdentity: root,
        projectKind: 'non-git',
        discoveredConfigPath: null,
        explicitConfigPath: null,
      },
    },
  };
};

const exactPlanProjection = (report: unknown) => {
  const value = report as Record<string, unknown>;
  return {
    artifactPair: value.artifactPair,
    selection: value.selection,
    operations: value.operations,
    checks: value.checks,
    diagnostics: value.diagnostics,
  };
};

const writeReviewedPlan = async (
  fixture: Awaited<ReturnType<typeof applicationFixture>>,
  selection: Readonly<{
    tools: readonly ('claude-code' | 'codex' | 'kilo-code' | 'opencode')[];
    scope: 'user' | 'project' | null;
  }> = { tools: [], scope: null },
): Promise<
  Readonly<{
    path: string;
    plan: SavedPlanV1;
  }>
> => {
  if (fixture.context.projectContext === undefined) {
    throw new Error('saved apply fixture requires project context');
  }
  const prepared = await prepareReconcilePlan(
    {
      file: 'skillsmith.toml',
      lockfile: 'skillsmith.lock',
      tools: selection.tools,
      scope: selection.scope,
      locked: true,
      prune: false,
      check: false,
    },
    {
      ports: fixture.context.ports,
      configuration: fixture.context.configuration,
      invocationCwd: fixture.root,
      projectContext: fixture.context.projectContext,
    },
  );
  if (!prepared.ok) throw new Error(prepared.error.message);
  const codec = artifactContractRegistry.get('plan', 1);
  if (codec === undefined) throw new Error('saved plan codec unavailable');
  const encoded = codec.encode(prepared.value.projection.plan);
  if (!encoded.ok) throw new Error(encoded.error.message);
  const path = join(fixture.root, 'review.skillsmith.plan');
  await writeFile(path, encoded.value);
  return { path, plan: prepared.value.projection.plan };
};

const poisonedContext = (): CurrentApplicationContext =>
  new Proxy({} as CurrentApplicationContext, {
    get: (_target, property) => {
      throw new Error(`apply preflight unexpectedly read context.${String(property)}`);
    },
  });

describe('apply application shell', () => {
  test('closes positional, scalar, tool, scope, mode, and saved-plan relations before context reads', async () => {
    const requests = [
      { arguments: ['manifest.toml'], options: {} },
      { arguments: [], options: { file: '' } },
      { arguments: [], options: { plan: null } },
      { arguments: [], options: { tool: 'codex' } },
      { arguments: [], options: { tool: ['codex', 'codex'] } },
      { arguments: [], options: { tool: ['unknown'] } },
      { arguments: [], options: { scope: 'system' } },
      { arguments: [], options: { scope: 'user', project: true } },
      { arguments: [], options: { lockfile: 'skillsmith.lock' } },
      { arguments: [], options: { dryRun: true, check: true } },
      { arguments: [], options: { yes: true, dryRun: true } },
      { arguments: [], options: { plan: 'review.plan', yes: true } },
      { arguments: [], options: { plan: 'review.plan', tool: ['codex'] } },
      { arguments: [], options: { plan: 'review.plan', continueOnError: true } },
    ] as const;

    for (const request of requests) {
      const outcome = await runApplyApplication(request, poisonedContext());
      expect(outcome.exitClass, JSON.stringify(request)).toBe('usage');
      expect(outcome.report).toEqual({ result: null });
      expect(outcome.mutation).toMatchObject({ kind: 'none', changed: 0 });
      expect(outcome.diagnostics).toHaveLength(1);
    }
  });

  test('validates saved dry-run and check without replanning, prompting, locks, writes, or local-path disclosure', async () => {
    const fixture = await applicationFixture([declaration('alpha', 'codex', 'user')]);
    const saved = await writeReviewedPlan(fixture);
    const before = await Promise.all([
      readFile(fixture.manifestPath),
      readFile(fixture.lockPath),
      readFile(saved.path),
    ]);

    const dryRun = await runApplyApplication(
      { arguments: [], options: { plan: saved.path, dryRun: true } },
      fixture.context,
    );
    const check = await runApplyApplication(
      { arguments: [], options: { plan: saved.path, check: true } },
      fixture.context,
    );

    expect(dryRun.exitClass).toBe('success');
    expect(check.exitClass).toBe('drift');
    expect(dryRun.report.result).not.toBeNull();
    expect(check.report.result).not.toBeNull();
    if (dryRun.report.result === null || check.report.result === null) {
      throw new Error('valid saved projection unexpectedly missing');
    }
    for (const report of [dryRun.report.result, check.report.result]) {
      expect(report.operations as readonly unknown[]).toEqual(
        saved.plan.operations as readonly unknown[],
      );
      expect(report.checks as readonly unknown[]).toEqual(saved.plan.checks as readonly unknown[]);
      expect(report.diagnostics as readonly unknown[]).toEqual(
        saved.plan.diagnostics as readonly unknown[],
      );
      expect(report.operations.map(({ operationId }) => operationId)).toEqual(
        saved.plan.operations.map(({ operationId }) => operationId),
      );
      expect(report).toMatchObject({
        state: 'ready',
        artifactPair: null,
        savedPlan: {
          path: 'review.skillsmith.plan',
          portability: 'portable',
          executorSchemaVersion: 1,
          hashSchemaVersion: 1,
        },
        project: { effectiveCwd: '<saved-plan>', root: null, identity: null },
        approval: { required: false, outcome: 'prior-authorization' },
        validation: { outcome: 'valid', replanned: false },
        results: [],
      });
      expect(JSON.stringify(report)).not.toContain(fixture.root);
      expect(applyV1Codec.validate(report).ok).toBeTrue();
    }
    expect(dryRun.mutation).toEqual({
      kind: 'preview',
      planned: saved.plan.operations.length,
      changed: 0,
      unchanged: 0,
      failed: 0,
    });
    expect(check.mutation).toEqual({
      kind: 'none',
      planned: 0,
      changed: 0,
      unchanged: 0,
      failed: 0,
    });
    expect(
      await Promise.all([
        readFile(fixture.manifestPath),
        readFile(fixture.lockPath),
        readFile(saved.path),
      ]),
    ).toEqual(before);
  });

  test('returns success for a valid empty saved check', async () => {
    const fixture = await applicationFixture([]);
    const saved = await writeReviewedPlan(fixture);
    const checked = await runApplyApplication(
      { arguments: [], options: { plan: saved.path, check: true } },
      fixture.context,
    );

    expect(saved.plan.operations).toEqual([]);
    expect(checked).toMatchObject({
      exitClass: 'success',
      report: {
        result: {
          mode: 'saved-check',
          state: 'ready',
          operations: [],
          approval: { required: false, outcome: 'prior-authorization' },
          validation: { outcome: 'valid', replanned: false },
        },
      },
      mutation: { kind: 'none', planned: 0, changed: 0 },
    });
  });

  test('retains saved filter-to-zero predicates and outcome without widening selection', async () => {
    const fixture = await applicationFixture([declaration('alpha', 'codex', 'user')]);
    const saved = await writeReviewedPlan(fixture, { tools: ['opencode'], scope: 'project' });
    const checked = await runApplyApplication(
      { arguments: [], options: { plan: saved.path, check: true } },
      fixture.context,
    );

    expect(saved.plan.operations).toEqual([]);
    expect(checked).toMatchObject({
      exitClass: 'success',
      report: {
        result: {
          mode: 'saved-check',
          state: 'ready',
          selection: {
            selectionOutcome: 'filter-noop',
            requestedTools: ['opencode'],
            requestedScope: 'project',
            skills: [],
            tools: ['opencode'],
            scopes: ['project'],
          },
          operations: [],
          validation: { outcome: 'valid', replanned: false },
        },
      },
    });
  });

  test('maps stale saved authorization before the temporary saved execution shell', async () => {
    const fixture = await applicationFixture([declaration('alpha', 'codex', 'user')]);
    const saved = await writeReviewedPlan(fixture);
    const manifest = await readFile(fixture.manifestPath, 'utf8');
    const changed = manifest.replace('placement = "copy"', 'placement = "symlink"');
    expect(changed).not.toBe(manifest);
    await writeFile(fixture.manifestPath, changed);

    for (const options of [
      { plan: saved.path, dryRun: true },
      { plan: saved.path, check: true },
      { plan: saved.path },
    ]) {
      const rejected = await runApplyApplication({ arguments: [], options }, fixture.context);
      expect(rejected).toMatchObject({
        report: { result: null },
        exitClass: 'state',
        diagnostics: [
          {
            code: 'apply-saved-manifest-semantic',
            severity: 'error',
          },
        ],
        mutation: { kind: 'none', planned: 0, changed: 0 },
      });
      expect(rejected.diagnostics[0]?.message).toContain('regenerate a new plan');
    }
  });

  test('executes an empty saved authorization without prompting or physical mutation', async () => {
    const fixture = await applicationFixture([]);
    const saved = await writeReviewedPlan(fixture);
    const result = await runApplyApplication(
      { arguments: [], options: { plan: saved.path } },
      fixture.context,
    );

    expect(result).toMatchObject({
      report: {
        result: {
          mode: 'saved-execute',
          state: 'completed',
          operations: [],
          results: [],
          approval: { required: false, outcome: 'prior-authorization' },
          validation: { outcome: 'valid', replanned: false },
        },
      },
      exitClass: 'success',
      diagnostics: [],
      mutation: { kind: 'none', planned: 0, changed: 0 },
    });
  });

  test('projects fresh dry-run and check from the exact plan product without prompt, lock, or write', async () => {
    const fixture = await applicationFixture([declaration('alpha', 'codex', 'user')]);
    const common = { file: fixture.manifestPath, lockfile: fixture.lockPath, locked: true };
    const before = await Promise.all([readFile(fixture.manifestPath), readFile(fixture.lockPath)]);
    const plan = await runPlanApplication({ arguments: [], options: common }, fixture.context);
    const planCheck = await runPlanApplication(
      { arguments: [], options: { ...common, check: true } },
      fixture.context,
    );
    const dryRun = await runApplyApplication(
      { arguments: [], options: { ...common, dryRun: true } },
      fixture.context,
    );
    const check = await runApplyApplication(
      { arguments: [], options: { ...common, check: true } },
      fixture.context,
    );

    expect(plan.exitClass).toBe('success');
    expect(planCheck.exitClass).toBe('drift');
    expect(dryRun.exitClass).toBe('success');
    expect(check.exitClass).toBe('drift');
    const planReport = plan.report.result;
    const planCheckReport = planCheck.report.result;
    const dryRunReport = dryRun.report.result;
    const checkReport = check.report.result;
    expect(planReport).not.toBeNull();
    expect(planCheckReport).not.toBeNull();
    expect(dryRunReport).not.toBeNull();
    expect(checkReport).not.toBeNull();
    if (
      planReport === null ||
      planCheckReport === null ||
      dryRunReport === null ||
      checkReport === null
    ) {
      throw new Error('fresh plan projection unexpectedly missing');
    }
    expect(exactPlanProjection(planCheckReport)).toEqual(exactPlanProjection(planReport));
    expect(exactPlanProjection(dryRunReport)).toEqual(exactPlanProjection(planReport));
    expect(exactPlanProjection(checkReport)).toEqual(exactPlanProjection(planReport));
    expect(dryRunReport).toMatchObject({
      mode: 'fresh-dry-run',
      state: 'ready',
      approval: { required: false, outcome: 'not-required' },
      validation: { outcome: 'not-run', replanned: false },
      results: [],
    });
    expect(checkReport).toMatchObject({
      mode: 'fresh-check',
      state: 'ready',
      approval: { required: false, outcome: 'not-required' },
      validation: { outcome: 'not-run', replanned: false },
      results: [],
    });
    expect(applyV1Codec.validate(dryRunReport).ok).toBeTrue();
    expect(applyV1Codec.validate(checkReport).ok).toBeTrue();
    expect(dryRun.mutation).toEqual({
      kind: 'preview',
      planned: dryRunReport.operations.length,
      changed: 0,
      unchanged: 0,
      failed: 0,
    });
    expect(check.mutation).toEqual({
      kind: 'none',
      planned: 0,
      changed: 0,
      unchanged: 0,
      failed: 0,
    });
    expect(await Promise.all([readFile(fixture.manifestPath), readFile(fixture.lockPath)])).toEqual(
      before,
    );
  });

  test('projects a late non-directory placement-root failure into the strict check report', async () => {
    const fixture = await applicationFixture([declaration('alpha', 'codex', 'user')]);
    const placementRoot = join(fixture.root, 'home', '.agents', 'skills');
    let placementRootReads = 0;
    const context: CurrentApplicationContext = {
      ...fixture.context,
      ports: {
        ...fixture.context.ports,
        pathKind: async (path) => {
          if (path === placementRoot) {
            placementRootReads += 1;
            if (placementRootReads > 1) return 'file';
          }
          return fixture.unrestrictedPorts.pathKind(path);
        },
      },
    };

    const checked = await runApplyApplication(
      {
        arguments: [],
        options: {
          file: fixture.manifestPath,
          lockfile: fixture.lockPath,
          locked: true,
          check: true,
        },
      },
      context,
    );
    const reportedOperation = checked.report.result?.operations[0];
    if (reportedOperation === undefined) throw new Error('root failure report has no operation');

    expect(placementRootReads).toBeGreaterThan(1);
    expect(checked).toMatchObject({
      exitClass: 'failure',
      report: {
        result: {
          mode: 'fresh-check',
          state: 'refused',
          diagnostics: [
            {
              kind: 'conflict',
              severity: 'error',
              refusalClass: 'state',
              affected: {
                skill: 'alpha',
                tool: 'codex',
                scope: 'user',
                path: { kind: 'machine-bound', path: join(placementRoot, 'alpha') },
              },
              correlation: {
                groupId: reportedOperation.groupId,
                pairId: reportedOperation.pairId,
                operationId: reportedOperation.operationId,
              },
              reason: { code: 'apply-placement-root-not-directory' },
            },
          ],
          summary: { diagnostics: 1, diagnosticKinds: { conflict: 1 } },
        },
      },
      diagnostics: [{ code: 'apply-placement-root-not-directory', severity: 'error' }],
    });
    expect(checked.report.result).not.toBeNull();
    if (checked.report.result === null) return;
    expect(
      applyV1Codec.validate(checked.report.result),
      JSON.stringify(checked.report.result.diagnostics),
    ).toMatchObject({ ok: true });
  });

  test('preserves a sole absent-to-empty write-lock across every fresh projection', async () => {
    const fixture = await applicationFixture([], { writeLock: false });
    const common = { file: fixture.manifestPath, lockfile: fixture.lockPath };
    const plan = await runPlanApplication({ arguments: [], options: common }, fixture.context);
    const planCheck = await runPlanApplication(
      { arguments: [], options: { ...common, check: true } },
      fixture.context,
    );
    const dryRun = await runApplyApplication(
      { arguments: [], options: { ...common, dryRun: true } },
      fixture.context,
    );
    const check = await runApplyApplication(
      { arguments: [], options: { ...common, check: true } },
      fixture.context,
    );

    expect([plan.exitClass, planCheck.exitClass, dryRun.exitClass, check.exitClass]).toEqual([
      'success',
      'drift',
      'success',
      'drift',
    ]);
    const reports = [
      plan.report.result,
      planCheck.report.result,
      dryRun.report.result,
      check.report.result,
    ];
    expect(reports.every((report) => report !== null)).toBeTrue();
    const planReport = reports[0];
    if (planReport === null || planReport === undefined) {
      throw new Error('missing-lock projection unexpectedly missing');
    }
    expect(planReport.operations).toMatchObject([
      {
        kind: 'write-lock',
        before: { kind: 'absent' },
        after: { kind: 'lock', value: { skills: [] } },
      },
    ]);
    for (const report of reports.slice(1)) {
      if (report === null) throw new Error('missing-lock projection unexpectedly missing');
      expect(exactPlanProjection(report)).toEqual(exactPlanProjection(planReport));
    }
    expect(dryRun.mutation).toMatchObject({ kind: 'preview', planned: 1, changed: 0 });
    expect(check.mutation).toMatchObject({ kind: 'none', planned: 0, changed: 0 });
  });

  test('approves and executes a sole absent-to-empty write-lock', async () => {
    const fixture = await applicationFixture([], { writeLock: false });
    const confirmations: Parameters<InteractionPort['confirm']>[0][] = [];
    const context: CurrentApplicationContext = {
      ...fixture.context,
      ports: fixture.unrestrictedPorts,
      artifactCoordinator: await createTestNodeArtifactCoordinatorPorts(
        join(fixture.root, 'coordination'),
      ),
      interaction: {
        mode: 'interactive',
        choose: async () => ({ status: 'refused', reason: 'choice is unused by apply' }),
        confirm: async (request) => {
          confirmations.push(request);
          return { status: 'resolved', value: true };
        },
      },
    };
    const outcome = await runApplyApplication(
      {
        arguments: [],
        options: { file: fixture.manifestPath, lockfile: fixture.lockPath },
      },
      context,
    );

    expect(outcome).toMatchObject({
      exitClass: 'success',
      report: {
        result: {
          mode: 'fresh-execute',
          state: 'completed',
          operations: [{ kind: 'write-lock', before: { kind: 'absent' } }],
          results: [{ outcome: 'succeeded' }],
          approval: { required: true, outcome: 'approved' },
          validation: { outcome: 'valid', replanned: false },
        },
      },
      mutation: { kind: 'applied', planned: 1, changed: 1, unchanged: 0, failed: 0 },
    });
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]?.preview?.operationIds).toEqual(
      outcome.report.result?.operations.map(({ operationId }) => operationId),
    );
    expect(await readFile(fixture.lockPath, 'utf8')).toBe(fixture.expectedLockSource);
    expect(outcome.report.result).not.toBeNull();
    if (outcome.report.result === null) throw new Error('write-lock report unexpectedly missing');
    expect(applyV1Codec.validate(outcome.report.result).ok).toBeTrue();
  });

  test('keeps an already-present empty lock a true no-op without prompt or write', async () => {
    const fixture = await applicationFixture([]);
    const lockBefore = await readFile(fixture.lockPath);
    const outcome = await runApplyApplication(
      {
        arguments: [],
        options: { file: fixture.manifestPath, lockfile: fixture.lockPath, locked: true },
      },
      fixture.context,
    );

    expect(outcome).toMatchObject({
      exitClass: 'success',
      report: {
        result: {
          mode: 'fresh-execute',
          state: 'completed',
          operations: [],
          results: [],
          approval: { required: false, outcome: 'not-required' },
          validation: { outcome: 'not-run', replanned: false },
        },
      },
      mutation: { kind: 'none', planned: 0, changed: 0, unchanged: 0, failed: 0 },
    });
    expect(outcome.report.result).not.toBeNull();
    if (outcome.report.result === null) throw new Error('no-op apply report unexpectedly missing');
    expect(applyV1Codec.validate(outcome.report.result).ok).toBeTrue();
    expect(await readFile(fixture.lockPath)).toEqual(lockBefore);
  });

  test('validates a changing fresh plan before presenting its exact approval preview', async () => {
    const fixture = await applicationFixture([declaration('alpha', 'codex', 'user')]);
    const confirmations: Parameters<InteractionPort['confirm']>[0][] = [];
    const context: CurrentApplicationContext = {
      ...fixture.context,
      interaction: {
        mode: 'interactive',
        choose: async () => ({ status: 'refused', reason: 'choice is not used by apply' }),
        confirm: async (request) => {
          confirmations.push(request);
          return { status: 'refused', reason: 'fixture refused the reviewed operations' };
        },
      },
    };
    const before = await Promise.all([readFile(fixture.manifestPath), readFile(fixture.lockPath)]);
    const outcome = await runApplyApplication(
      {
        arguments: [],
        options: {
          file: fixture.manifestPath,
          lockfile: fixture.lockPath,
          locked: true,
        },
      },
      context,
    );

    expect(outcome).toMatchObject({
      exitClass: 'usage',
      report: {
        result: {
          mode: 'fresh-execute',
          state: 'refused',
          approval: { required: true, outcome: 'refused' },
          validation: { outcome: 'valid', replanned: false },
          results: [],
        },
      },
      diagnostics: [
        {
          code: 'apply-approval-required',
          severity: 'error',
        },
      ],
      mutation: { kind: 'none', planned: 0, changed: 0 },
    });
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]).toMatchObject({
      id: 'skillsmith.apply.confirm',
      preview: { kind: 'exact-operation-preview', command: 'apply' },
    });
    expect(confirmations[0]?.preview?.operationIds).toEqual(
      outcome.report.result?.operations.map(({ operationId }) => operationId),
    );
    expect(await Promise.all([readFile(fixture.manifestPath), readFile(fixture.lockPath)])).toEqual(
      before,
    );
  });

  test('reports fresh pre-approval staleness without claiming a prompt occurred', async () => {
    const fixture = await applicationFixture([declaration('alpha', 'codex', 'user')]);
    const originalManifest = await readFile(fixture.manifestPath, 'utf8');
    const changedManifest = originalManifest.replace('placement = "copy"', 'placement = "symlink"');
    expect(changedManifest).not.toBe(originalManifest);
    let manifestReads = 0;
    let confirmations = 0;
    const context: CurrentApplicationContext = {
      ...fixture.context,
      ports: {
        ...fixture.context.ports,
        readBytes: async (path) => {
          if (path === fixture.manifestPath) {
            manifestReads += 1;
            if (manifestReads > 1) return new TextEncoder().encode(changedManifest);
          }
          return fixture.context.ports.readBytes(path);
        },
      },
      interaction: {
        mode: 'interactive',
        choose: async () => ({ status: 'refused', reason: 'choice is unused' }),
        confirm: async () => {
          confirmations += 1;
          return { status: 'refused', reason: 'confirmation must not run for stale work' };
        },
      },
    };

    const rejected = await runApplyApplication(
      {
        arguments: [],
        options: {
          file: fixture.manifestPath,
          lockfile: fixture.lockPath,
          locked: true,
        },
      },
      context,
    );

    expect(rejected).toMatchObject({
      exitClass: 'state',
      report: {
        result: {
          mode: 'fresh-execute',
          state: 'refused',
          approval: { required: false, outcome: 'not-required' },
          validation: { outcome: 'stale', replanned: false },
          results: [],
        },
      },
      diagnostics: [{ code: 'apply-saved-manifest-semantic', severity: 'error' }],
      mutation: { kind: 'none', planned: 0, changed: 0, failed: 0 },
    });
    expect(manifestReads).toBeGreaterThan(1);
    expect(confirmations).toBe(0);
    expect(rejected.report.result).not.toBeNull();
    if (rejected.report.result === null) return;
    expect(applyV1Codec.validate(rejected.report.result).ok).toBeTrue();
  });

  test('projects retained mutation results when only post-execution source cleanup fails', async () => {
    const fixture = await applicationFixture([declaration('alpha', 'codex', 'user')]);
    const preview = await runApplyApplication(
      {
        arguments: [],
        options: {
          file: fixture.manifestPath,
          lockfile: fixture.lockPath,
          locked: true,
          dryRun: true,
        },
      },
      fixture.context,
    );
    const report = preview.report.result;
    const operation = report?.operations[0];
    if (report === null || operation === undefined) {
      throw new Error('cleanup projection fixture has no operation');
    }
    const results: readonly OperationExecutionResult[] = [
      {
        operationId: operation.operationId,
        outcome: 'succeeded',
        actualBefore: operation.before as OperationExecutionResult['actualBefore'],
        actualAfter: operation.after as OperationExecutionResult['actualAfter'],
        force: null,
        error: null,
      },
    ];
    const cleanupFailure = {
      code: 'reconcile-execution-cleanup-failed',
      message: 'reconciliation source cleanup did not complete',
      exitClass: 'failure',
      results,
    } as const;
    const projected = projectRetainedExecutionFailure(
      {
        ...report,
        mode: 'fresh-execute',
        options: { ...report.options, dryRun: false },
      },
      { required: true, outcome: 'approved' },
      cleanupFailure,
      'retry cleanup',
    );

    expect(projected).toMatchObject({
      exitClass: 'failure',
      report: {
        result: {
          state: 'completed',
          approval: { required: true, outcome: 'approved' },
          results: [{ operationId: operation.operationId, outcome: 'succeeded' }],
          diagnostics: [
            {
              kind: 'conflict',
              severity: 'error',
              refusalClass: 'state',
              reason: { code: 'reconcile-execution-cleanup-failed' },
            },
          ],
          summary: {
            diagnostics: 1,
            diagnosticKinds: { conflict: 1 },
            succeeded: 1,
            failed: 0,
          },
        },
      },
      diagnostics: [{ code: 'reconcile-execution-cleanup-failed', severity: 'error' }],
      mutation: { kind: 'applied', planned: 1, changed: 1, unchanged: 0, failed: 0 },
    });
    expect(projected?.report.result).not.toBeNull();
    if (projected?.report.result === null || projected === null) return;
    expect(applyV1Codec.validate(projected.report.result)).toMatchObject({ ok: true });

    const permissionCleanupFailure = {
      code: 'reconcile-execution-cleanup-failed',
      message: 'reconciliation cleanup was denied after commit',
      exitClass: 'permission',
      results: [
        {
          operationId: operation.operationId,
          outcome: 'failed',
          actualBefore: operation.before as OperationExecutionResult['actualBefore'],
          actualAfter: operation.after as OperationExecutionResult['actualAfter'],
          force: null,
          error: {
            code: 'permission-denied',
            message: 'the operation committed but cleanup was denied',
            remediation: 'retry cleanup',
          },
        },
      ],
    } as const;
    const permissionAfterCommit = projectRetainedExecutionFailure(
      {
        ...report,
        mode: 'fresh-execute',
        options: { ...report.options, dryRun: false },
      },
      { required: true, outcome: 'approved' },
      permissionCleanupFailure,
      'retry cleanup',
    );
    expect(permissionAfterCommit).toMatchObject({
      exitClass: 'permission',
      report: {
        result: {
          state: 'partial',
          results: [{ operationId: operation.operationId, outcome: 'failed' }],
          summary: { succeeded: 0, failed: 1 },
        },
      },
      mutation: { kind: 'applied', planned: 1, changed: 1, unchanged: 0, failed: 1 },
    });
    if (permissionAfterCommit === null || permissionAfterCommit.report.result === null) return;
    expect(applyV1Codec.validate(permissionAfterCommit.report.result)).toMatchObject({ ok: true });
  });

  test('preserves real refusal precedence over check drift and the execution shell', async () => {
    const fixture = await applicationFixture([
      declaration('alpha', 'codex', 'project'),
      declaration('beta', 'kilo-code', 'user'),
    ]);
    const opposite = join(fixture.root, 'home', '.agents', 'skills', 'alpha');
    await mkdir(opposite, { recursive: true });
    await writeFile(join(opposite, 'SKILL.md'), '# Unmanaged opposite scope\n');

    for (const options of [{ dryRun: true }, { check: true }, { yes: true }]) {
      const outcome = await runApplyApplication(
        {
          arguments: [],
          options: {
            file: fixture.manifestPath,
            lockfile: fixture.lockPath,
            ...options,
          },
        },
        fixture.context,
      );
      expect(outcome.exitClass, JSON.stringify(options)).toBe('capability');
      expect(outcome.report.result, JSON.stringify(options)).toMatchObject({
        state: 'refused',
        approval: { required: false, outcome: 'not-required' },
        validation: { outcome: 'not-run', replanned: false },
        results: [],
      });
      expect(
        outcome.diagnostics.map(({ code }) => code).toSorted(),
        JSON.stringify(options),
      ).toEqual(['plan-capability-unavailable', 'plan-opposite-placement-unmanaged']);
      expect(outcome.report.result).not.toBeNull();
      if (outcome.report.result === null)
        throw new Error('refused apply report unexpectedly missing');
      expect(applyV1Codec.validate(outcome.report.result).ok).toBeTrue();
    }
  });

  test('retains usage precedence over cancellation and cancels valid requests', async () => {
    const controller = new AbortController();
    controller.abort();
    const context = new Proxy({ signal: controller.signal } as CurrentApplicationContext, {
      get: (target, property) => {
        if (property === 'signal') return target.signal;
        throw new Error(`cancelled apply unexpectedly read context.${String(property)}`);
      },
    });

    expect(
      (await runApplyApplication({ arguments: ['unexpected'], options: {} }, context)).exitClass,
    ).toBe('usage');
    expect(
      (await runApplyApplication({ arguments: [], options: { plan: 'review.plan' } }, context))
        .exitClass,
    ).toBe('cancelled');
  });
});
