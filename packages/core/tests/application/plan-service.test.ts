import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPlanApplication } from '../../src/application/plan-service.ts';
import type { CurrentApplicationContext, InteractionPort } from '../../src/application/types.ts';
import { type ArtifactDigest, hashManifestSemantics } from '../../src/artifacts/hash.ts';
import { serializePortableLock } from '../../src/artifacts/lock.ts';
import { artifactContractRegistry } from '../../src/artifacts/registry.ts';
import type {
  NormalizedManifestDeclaration,
  NormalizedManifestV1,
} from '../../src/artifacts/types.ts';
import {
  createObservationEmitter,
  createOperationContext,
  noopObserver,
} from '../../src/observation/index.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';
import { portError } from '../../src/ports/errors.ts';
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

const interaction: InteractionPort = {
  mode: 'noninteractive',
  choose: async () => ({ status: 'refused', reason: 'not used by plan' }),
  confirm: async () => ({ status: 'refused', reason: 'not used by plan' }),
};

const applicationFixture = async (
  declarations: readonly NormalizedManifestDeclaration[],
): Promise<
  Readonly<{
    root: string;
    context: CurrentApplicationContext;
    manifestPath: string;
  }>
> => {
  const root = await mkdtemp(join(tmpdir(), 'skillsmith-plan-application-'));
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
  const manifest: NormalizedManifestV1 = { version: 1, skills: [...declarations] };
  const lock = {
    version: 1 as const,
    hashSchemaVersion: 1 as const,
    manifestHash: hashManifestSemantics(manifest),
    skills: declarations.map((row, index) => ({
      name: row.name,
      source: `${row.source.host}/${row.source.repository}//${row.source.path ?? '.'}`,
      requestedRef: row.ref,
      resolvedSha: String(index + 1).repeat(40),
      sourcePath: row.source.path ?? '.',
      contentHash: digest(String(index + 1)),
    })),
  };
  const manifestCodec = artifactContractRegistry.get('manifest', 1);
  if (manifestCodec === undefined) throw new Error('manifest codec unavailable');
  const encodedManifest = manifestCodec.encode(manifest);
  if (!encodedManifest.ok) throw new Error(encodedManifest.error.message);
  const encodedLock = serializePortableLock(lock);
  if (!encodedLock.ok) throw new Error(encodedLock.error.message);
  const manifestPath = join(root, 'skillsmith.toml');
  await Promise.all([
    writeFile(manifestPath, encodedManifest.value),
    writeFile(join(root, 'skillsmith.lock'), encodedLock.value),
  ]);
  return {
    root,
    manifestPath,
    context: {
      observation: {
        context: createOperationContext({
          command: 'skillsmith plan',
          workflow: 'plan',
          clock: {
            wallNowIso: () => '2026-07-19T00:00:00.000Z',
            monotonicMilliseconds: () => 0,
          },
          id: { nextId: () => 'plan-application-test' },
        }),
        emitter: createObservationEmitter({ observer: noopObserver }),
      },
      ports,
      artifactCoordinator: {} as CurrentApplicationContext['artifactCoordinator'],
      configuration: configuration(root),
      interaction,
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

const poisonedContext = (): CurrentApplicationContext =>
  new Proxy({} as CurrentApplicationContext, {
    get: (_target, property) => {
      throw new Error(`invalid plan request unexpectedly read context.${String(property)}`);
    },
  });

describe('plan application service', () => {
  test('rejects positional, artifact, scope, output, and tool errors before context reads', async () => {
    const requests = [
      { arguments: ['unexpected'], options: {} },
      { arguments: [], options: { lockfile: 'skillsmith.lock' } },
      { arguments: [], options: { out: '-' } },
      { arguments: [], options: { scope: 'user', user: true } },
      { arguments: [], options: { scope: 'system' } },
      { arguments: [], options: { tool: ['unknown-tool'] } },
      { arguments: [], options: { check: true, out: 'review.plan' } },
      { arguments: [], options: { check: true, force: true } },
      { arguments: [], options: { force: true } },
    ] as const;

    for (const request of requests) {
      const outcome = await runPlanApplication(request, poisonedContext());
      expect(outcome.exitClass, JSON.stringify(request)).toBe('usage');
      expect(outcome.report).toEqual({ result: null });
      expect(outcome.mutation).toMatchObject({ kind: 'none', changed: 0 });
    }
  });

  test('rejects duplicate tools and invalid singular scalars with exact eager usage diagnostics', async () => {
    const scalarRows = [
      ['file', '--file', 'path'],
      ['lockfile', '--lockfile', 'path'],
      ['scope', '--scope', 'value'],
      ['out', '--out', 'path'],
    ] as const;
    const rows: ReadonlyArray<{
      readonly options: Readonly<Record<string, unknown>>;
      readonly code: string;
      readonly message: string;
    }> = [
      {
        options: { tool: ['codex', 'codex'] },
        code: 'plan-tool-duplicate',
        message: '--tool must not repeat the same tool',
      },
      ...scalarRows.flatMap(([key, flag, noun]) =>
        ['', null].map((value) => ({
          options: { [key]: value },
          code: `plan-${key}-invalid`,
          message: `${flag} requires a non-empty ${noun}`,
        })),
      ),
    ];

    for (const row of rows) {
      const result = await runPlanApplication(
        { arguments: [], options: row.options },
        poisonedContext(),
      );
      expect(result).toMatchObject({
        exitClass: 'usage',
        report: { result: null },
        diagnostics: [{ code: row.code, severity: 'error', message: row.message }],
        mutation: { kind: 'none', changed: 0 },
      });
    }
  });

  test('returns production cancellation before discovery while preserving usage precedence', async () => {
    const controller = new AbortController();
    controller.abort();
    const context = new Proxy({ signal: controller.signal } as CurrentApplicationContext, {
      get: (target, property) => {
        if (property === 'signal') return target.signal;
        throw new Error(`cancelled plan unexpectedly read context.${String(property)}`);
      },
    });
    const cancelled = await runPlanApplication({ arguments: [], options: {} }, context);
    expect(cancelled).toMatchObject({
      exitClass: 'cancelled',
      report: { result: null },
      diagnostics: [{ code: 'plan-cancelled', severity: 'error' }],
      mutation: { kind: 'none', changed: 0 },
    });

    const usage = await runPlanApplication({ arguments: ['unexpected'], options: {} }, context);
    expect(usage.exitClass).toBe('usage');
  });

  test('preserves artifact selector permission failures through the application boundary', async () => {
    const fixture = await applicationFixture([declaration('alpha', 'codex', 'user')]);
    const basePathKind = fixture.context.ports.pathKind;
    const context: CurrentApplicationContext = {
      ...fixture.context,
      ports: {
        ...fixture.context.ports,
        pathKind: async (path) => {
          if (path === fixture.manifestPath) {
            throw portError({
              capability: 'file-read',
              operation: 'pathKind',
              code: 'permission',
              message: 'pathKind EACCES',
              context: { path },
            });
          }
          return basePathKind(path);
        },
      },
    };

    const result = await runPlanApplication(
      { arguments: [], options: { file: fixture.manifestPath } },
      context,
    );

    expect(result).toMatchObject({
      exitClass: 'permission',
      report: { result: null },
      diagnostics: [
        {
          code: 'artifact-selector-unresolvable',
          severity: 'error',
          message: 'artifact selector permission denied',
        },
      ],
      mutation: { kind: 'none', changed: 0 },
    });
  });

  test('classifies a hostile output-alias inspection throw as state without inspecting it', async () => {
    const fixture = await applicationFixture([declaration('alpha', 'codex', 'user')]);
    const outputPath = join(fixture.root, 'review.plan');
    const basePathKind = fixture.context.ports.pathKind;
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('hostile throw must remain opaque');
        },
        get: () => {
          throw new Error('hostile throw must remain opaque');
        },
      },
    );
    const context: CurrentApplicationContext = {
      ...fixture.context,
      ports: {
        ...fixture.context.ports,
        pathKind: async (path) => {
          if (path === outputPath) throw hostile;
          return basePathKind(path);
        },
      },
    };

    const result = await runPlanApplication(
      {
        arguments: [],
        options: { file: fixture.manifestPath, locked: true, out: 'review.plan' },
      },
      context,
    );

    expect(result).toMatchObject({
      exitClass: 'state',
      report: { result: null },
      diagnostics: [
        {
          code: 'plan-output-inspection',
          severity: 'error',
          message: 'saved plan output aliases could not be inspected safely',
        },
      ],
      mutation: { kind: 'none', changed: 0 },
    });
  });

  test('reports the complete execution-bound operation precondition projection', async () => {
    const fixture = await applicationFixture([declaration('alpha', 'codex', 'user')]);
    const result = await runPlanApplication(
      { arguments: [], options: { file: fixture.manifestPath, locked: true } },
      fixture.context,
    );
    expect(result.exitClass).toBe('success');
    const operation = result.report.result?.operations[0];
    expect(operation).toBeDefined();
    const preconditionIds = operation?.preconditionIds ?? [];
    expect(preconditionIds.length).toBeGreaterThan(3);
    expect(new Set(preconditionIds).size).toBe(preconditionIds.length);
  });

  test('preserves a state refusal and affected path for preview and --out without writing', async () => {
    const fixture = await applicationFixture([declaration('alpha', 'codex', 'project')]);
    const opposite = join(fixture.context.ports.homeDir, '.agents', 'skills', 'alpha');
    await mkdir(opposite, { recursive: true });
    await writeFile(join(opposite, 'SKILL.md'), '# Unmanaged opposite scope\n');

    for (const options of [
      { file: fixture.manifestPath },
      { file: fixture.manifestPath, out: 'review.plan' },
    ]) {
      const result = await runPlanApplication({ arguments: [], options }, fixture.context);
      expect(result.exitClass, JSON.stringify(options)).toBe('state');
      expect(result.diagnostics, JSON.stringify(options)).toMatchObject([
        { code: 'plan-opposite-placement-unmanaged', severity: 'error' },
      ]);
      expect(result.report.result, JSON.stringify(options)).toMatchObject({
        state: 'refused',
        operations: [],
        diagnostics: [
          {
            kind: 'refuse',
            refusalClass: 'state',
            affected: { path: { kind: 'machine-bound', path: opposite } },
          },
        ],
        savedOutput: null,
      });
    }
    expect(await Bun.file(join(fixture.root, 'review.plan')).exists()).toBeFalse();
  });

  test('uses deterministic numeric precedence for mixed state and capability refusals', async () => {
    const fixture = await applicationFixture([
      declaration('alpha', 'codex', 'project'),
      declaration('beta', 'kilo-code', 'user'),
    ]);
    const opposite = join(fixture.context.ports.homeDir, '.agents', 'skills', 'alpha');
    await mkdir(opposite, { recursive: true });
    await writeFile(join(opposite, 'SKILL.md'), '# Unmanaged opposite scope\n');

    const result = await runPlanApplication(
      { arguments: [], options: { file: fixture.manifestPath, out: 'mixed.plan' } },
      fixture.context,
    );
    expect(result.exitClass).toBe('capability');
    expect(result.diagnostics.map(({ code }) => code).toSorted()).toEqual([
      'plan-capability-unavailable',
      'plan-opposite-placement-unmanaged',
    ]);
    expect(result.report.result).toMatchObject({ state: 'refused', savedOutput: null });
    expect(await Bun.file(join(fixture.root, 'mixed.plan')).exists()).toBeFalse();
  });
});
