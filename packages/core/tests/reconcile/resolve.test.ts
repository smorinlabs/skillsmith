import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InstallSourceTransport } from '../../src/acquire/types.ts';
import { type ArtifactDigest, hashManifestSemantics } from '../../src/artifacts/hash.ts';
import { serializePortableLock } from '../../src/artifacts/lock.ts';
import type { ResolvedArtifactPair } from '../../src/artifacts/pair.ts';
import type { ProjectContext } from '../../src/context/types.ts';
import { cancelledError, permissionDeniedError } from '../../src/errors.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';
import { portError } from '../../src/ports/errors.ts';
import type { ResolvedRuntimeConfiguration } from '../../src/ports/types.ts';
import { observePlanArtifacts } from '../../src/reconcile/observe.ts';
import { resolvePlanInput } from '../../src/reconcile/resolve.ts';
import { err, ok } from '../../src/result.ts';

const roots: string[] = [];
const SHA = 'a'.repeat(40);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const manifest = (skills: readonly Readonly<{ name: string; tool?: string }>[] = []) =>
  `${[
    'version = 1',
    '',
    ...skills.flatMap((skill) => [
      '[[skills]]',
      `name = "${skill.name}"`,
      `source = "fixture.invalid/acme/skills//skills/${skill.name}"`,
      `tools = ["${skill.tool ?? 'codex'}"]`,
      'scope = "user"',
      'placement = "copy"',
      '',
    ]),
  ].join('\n')}\n`;

const setup = async (skills: readonly Readonly<{ name: string; tool?: string }>[] = []) => {
  const root = await mkdtemp(join(tmpdir(), 'skillsmith-plan-resolve-'));
  roots.push(root);
  const manifestPath = join(root, 'skillsmith.toml');
  const lockPath = join(root, 'skillsmith.lock');
  await writeFile(manifestPath, manifest(skills));
  const project: ProjectContext = {
    invocationCwd: root,
    effectiveCwd: root,
    projectRoot: root,
    projectIdentity: root,
    projectKind: 'non-git',
    discoveredConfigPath: null,
    explicitConfigPath: null,
  };
  const pair: ResolvedArtifactPair = {
    file: {
      token: './skillsmith.toml',
      path: manifestPath,
      portability: 'portable',
      portableToken: './skillsmith.toml',
    },
    lockfile: {
      token: null,
      path: lockPath,
      portability: 'portable',
      portableToken: './skillsmith.lock',
    },
    lockfileSource: 'sibling',
  };
  const ports = { ...(await defaultRuntimePorts()), homeDir: root };
  const observed = await observePlanArtifacts(ports, project, pair);
  expect(observed.ok).toBeTrue();
  if (!observed.ok) throw new Error(observed.error.message);
  return { root, ports, project, pair, observed: observed.value };
};

const transport = (calls: string[]): InstallSourceTransport => ({
  resolveRef: async () => ok(null),
  fetchRepo: async (_ports, options) => {
    calls.push(`fetch:${options.fetchDir}`);
    await mkdir(options.fetchDir, { recursive: true });
    return ok({ sha: SHA });
  },
  listSkills: async () => ok({ candidates: [{ path: 'skills/alpha', name: 'alpha' }], scanned: 1 }),
  materializeSkill: async (_ports, fetchDirectory, skillPath) => {
    calls.push(`materialize:${skillPath}`);
    const directory = join(fetchDirectory, 'tree', skillPath);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), '# Alpha\n');
    return ok(directory);
  },
});

const request = {
  tools: [] as const,
  scope: null,
  locked: false,
  prune: false,
  check: false,
};

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

describe('plan source resolution', () => {
  test.each(['root-only', 'root-and-other', 'root-and-same-name', 'missing-root'])(
    'saved root identity remains exact for %s',
    async (layout) => {
      const state = await setup([{ name: 'skills' }]);
      await writeFile(
        state.pair.file.path,
        manifest([{ name: 'skills' }]).replace(
          'fixture.invalid/acme/skills//skills/skills',
          'fixture.invalid/acme/skills',
        ),
      );
      const observed = await observePlanArtifacts(state.ports, state.project, state.pair);
      if (!observed.ok) throw new Error(observed.error.message);
      const candidates = [
        ...(layout === 'missing-root' ? [] : [{ path: '', name: '' }]),
        ...(layout === 'root-only'
          ? []
          : [
              {
                path: layout === 'root-and-other' ? 'skills/other' : 'skills/skills',
                name: layout === 'root-and-other' ? 'other' : 'skills',
              },
            ]),
      ];
      const calls: string[] = [];
      const result = await resolvePlanInput(observed.value, request, {
        ports: state.ports,
        configuration: configuration(state.root),
        transport: {
          ...transport(calls),
          listSkills: async () => ok({ candidates, scanned: candidates.length }),
        },
      });
      expect(result.ok).toBe(layout !== 'missing-root');
      if (result.ok) {
        expect(result.value.declarations[0]?.lock?.sourcePath).toBe('.');
        expect(calls).toContain('materialize:');
      } else expect(calls.some((c) => c.startsWith('materialize:'))).toBe(false);
    },
  );

  test('resolves a selected missing pin, hashes immutable content, and cleans temporary state', async () => {
    const state = await setup([{ name: 'alpha' }]);
    const calls: string[] = [];
    const result = await resolvePlanInput(state.observed, request, {
      ports: state.ports,
      configuration: configuration(state.root),
      transport: transport(calls),
    });
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.declarations).toHaveLength(1);
    const [declaration] = result.value.declarations;
    expect(declaration).toBeDefined();
    if (declaration === undefined) throw new Error('missing resolved declaration');
    expect(declaration.lock).toMatchObject({
      name: 'alpha',
      source: 'fixture.invalid/acme/skills//skills/alpha',
      resolvedSha: SHA,
      sourcePath: 'skills/alpha',
      contentHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(result.value.replacementLock?.skills).toEqual([declaration.lock]);
    expect(calls).toHaveLength(2);
    const fetchDirectory = calls[0]?.slice('fetch:'.length);
    expect(fetchDirectory).toBeDefined();
    if (fetchDirectory !== undefined) {
      expect((await state.ports.pathKind(fetchDirectory)).toString()).toBe('absent');
    }
    expect(await state.ports.pathKind(join(state.root, 'data'))).toBe('absent');
    expect(await state.ports.listDir(state.root)).toEqual(['skillsmith.toml']);
  });

  test('--locked refuses before invoking source transport', async () => {
    const state = await setup([{ name: 'alpha' }]);
    const calls: string[] = [];
    const result = await resolvePlanInput(
      state.observed,
      { ...request, locked: true },
      {
        ports: state.ports,
        configuration: configuration(state.root),
        transport: transport(calls),
      },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'plan-locked-state', exitClass: 'state' },
    });
    expect(calls).toEqual([]);
  });

  test('maps pre-aborted and dependency cancellation to exit 130 without source work', async () => {
    const preAborted = await setup([{ name: 'alpha' }]);
    const controller = new AbortController();
    controller.abort();
    const calls: string[] = [];
    const before = await resolvePlanInput(preAborted.observed, request, {
      ports: preAborted.ports,
      configuration: configuration(preAborted.root),
      transport: transport(calls),
      signal: controller.signal,
    });
    expect(before).toMatchObject({
      ok: false,
      error: { code: 'plan-cancelled', exitClass: 'cancelled' },
    });
    expect(calls).toEqual([]);

    const dependency = await setup([{ name: 'alpha' }]);
    const cancelledTransport: InstallSourceTransport = {
      ...transport([]),
      fetchRepo: async () => err(cancelledError('fixture cancellation')),
    };
    const during = await resolvePlanInput(dependency.observed, request, {
      ports: dependency.ports,
      configuration: configuration(dependency.root),
      transport: cancelledTransport,
    });
    expect(during).toMatchObject({
      ok: false,
      error: { code: 'plan-cancelled', exitClass: 'cancelled' },
    });
    expect(await dependency.ports.pathKind(join(dependency.root, 'data'))).toBe('absent');
    expect(await dependency.ports.listDir(dependency.root)).toEqual(['skillsmith.toml']);
  });

  test('projection cancellation removes the exact temporary source directory without residue', async () => {
    const state = await setup([{ name: 'alpha' }]);
    const calls: string[] = [];
    const result = await resolvePlanInput(state.observed, request, {
      ports: {
        ...state.ports,
        readBytes: async (path) => {
          if (path.includes(join('tree', 'skills', 'alpha'))) {
            throw portError({
              capability: 'file-read',
              operation: 'fixture-read-cancelled',
              code: 'cancelled',
              message: 'fixture projection cancellation',
              context: {},
            });
          }
          return state.ports.readBytes(path);
        },
      },
      configuration: configuration(state.root),
      transport: transport(calls),
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'plan-cancelled', exitClass: 'cancelled' },
    });
    const fetchDirectory = calls[0]?.slice('fetch:'.length);
    expect(fetchDirectory).toBeDefined();
    if (fetchDirectory !== undefined) {
      expect(await state.ports.pathKind(fetchDirectory)).toBe('absent');
    }
    expect(await state.ports.pathKind(join(state.root, 'data'))).toBe('absent');
    expect(await state.ports.listDir(state.root)).toEqual(['skillsmith.toml']);
  });

  test('keeps source permission failures distinct from network/source failures', async () => {
    const state = await setup([{ name: 'alpha' }]);
    const permissionTransport: InstallSourceTransport = {
      ...transport([]),
      fetchRepo: async () => err(permissionDeniedError('fixture permission')),
    };
    const result = await resolvePlanInput(state.observed, request, {
      ports: state.ports,
      configuration: configuration(state.root),
      transport: permissionTransport,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'plan-source-permission', exitClass: 'permission' },
    });
  });

  test('retains materialized source read permissions across every projection read capability', async () => {
    for (const [operation, failure] of [
      ['readFileMetadata', Object.assign(new Error('fixture metadata denial'), { code: 'EACCES' })],
      ['listDir', Object.assign(new Error('fixture listing denial'), { code: 'EPERM' })],
      [
        'readBytes',
        portError({
          capability: 'file-read',
          operation: 'fixture-readBytes',
          code: 'permission',
          message: 'fixture byte denial',
          context: {},
        }),
      ],
    ] as const) {
      const state = await setup([{ name: 'alpha' }]);
      const deniedPath = (path: string) => path.includes(join('tree', 'skills', 'alpha'));
      const ports = {
        ...state.ports,
        ...(operation === 'readFileMetadata'
          ? {
              readFileMetadata: async (path: string) => {
                if (deniedPath(path)) throw failure;
                return state.ports.readFileMetadata(path);
              },
            }
          : {}),
        ...(operation === 'listDir'
          ? {
              listDir: async (path: string) => {
                if (deniedPath(path)) throw failure;
                return state.ports.listDir(path);
              },
            }
          : {}),
        ...(operation === 'readBytes'
          ? {
              readBytes: async (path: string) => {
                if (deniedPath(path)) throw failure;
                return state.ports.readBytes(path);
              },
            }
          : {}),
      };
      const calls: string[] = [];
      const result = await resolvePlanInput(state.observed, request, {
        ports,
        configuration: configuration(state.root),
        transport: transport(calls),
      });
      expect(result, operation).toMatchObject({
        ok: false,
        error: { code: 'plan-source-permission', exitClass: 'permission' },
      });
      const fetchDirectory = calls[0]?.slice('fetch:'.length);
      expect(fetchDirectory, operation).toBeDefined();
      if (fetchDirectory !== undefined) {
        expect(await state.ports.pathKind(fetchDirectory), operation).toBe('absent');
      }
    }
  });

  test('projection cancellation and permission outrank a secondary cleanup failure', async () => {
    for (const [failure, expected] of [
      [
        portError({
          capability: 'file-read',
          operation: 'fixture-read-cancelled',
          code: 'cancelled',
          message: 'fixture projection cancellation',
          context: {},
        }),
        { code: 'plan-cancelled', exitClass: 'cancelled' },
      ],
      [
        portError({
          capability: 'file-read',
          operation: 'fixture-read-permission',
          code: 'permission',
          message: 'fixture projection permission',
          context: {},
        }),
        { code: 'plan-source-permission', exitClass: 'permission' },
      ],
    ] as const) {
      const state = await setup([{ name: 'alpha' }]);
      let cleanupAttempts = 0;
      const result = await resolvePlanInput(state.observed, request, {
        ports: {
          ...state.ports,
          readBytes: async (path) => {
            if (path.includes(join('tree', 'skills', 'alpha'))) throw failure;
            return state.ports.readBytes(path);
          },
          removeTree: async () => {
            cleanupAttempts += 1;
            throw Object.assign(new Error('fixture cleanup failure'), { code: 'EIO' });
          },
        },
        configuration: configuration(state.root),
        transport: transport([]),
      });
      expect(result).toMatchObject({ ok: false, error: expected });
      expect(cleanupAttempts).toBe(1);
    }
  });

  test('--locked requires a current complete whole pair before applying any selection filter', async () => {
    const state = await setup([
      { name: 'alpha', tool: 'codex' },
      { name: 'beta', tool: 'claude-code' },
    ]);
    const alpha = state.observed.manifest.model.skills.find((skill) => skill.name === 'alpha');
    expect(alpha).toBeDefined();
    if (alpha === undefined) throw new Error('missing alpha declaration');
    const encoded = serializePortableLock({
      version: 1,
      hashSchemaVersion: 1,
      manifestHash: hashManifestSemantics(state.observed.manifest.model),
      skills: [
        {
          name: alpha.name,
          source: `${alpha.source.host}/${alpha.source.repository}//${alpha.source.path}`,
          requestedRef: alpha.ref,
          resolvedSha: SHA,
          sourcePath: alpha.source.path ?? '.',
          contentHash: `sha256:${'b'.repeat(64)}` as ArtifactDigest,
        },
      ],
    });
    expect(encoded.ok).toBeTrue();
    if (!encoded.ok) throw new Error(encoded.error.message);
    await writeFile(state.pair.lockfile.path, encoded.value);
    const observed = await observePlanArtifacts(state.ports, state.project, state.pair);
    expect(observed.ok).toBeTrue();
    if (!observed.ok) throw new Error(observed.error.message);

    for (const selection of [
      { label: 'unbounded', tools: [] as const, scope: null },
      { label: 'bounded-tool', tools: ['codex'] as const, scope: null },
      { label: 'bounded-scope', tools: [] as const, scope: 'user' as const },
      { label: 'filter-to-zero', tools: ['opencode'] as const, scope: null },
    ]) {
      const calls: string[] = [];
      const result = await resolvePlanInput(
        observed.value,
        { ...request, tools: selection.tools, scope: selection.scope, locked: true },
        {
          ports: state.ports,
          configuration: configuration(state.root),
          transport: transport(calls),
        },
      );
      expect(result, selection.label).toMatchObject({
        ok: false,
        error: { code: 'plan-locked-state', exitClass: 'state' },
      });
      expect(calls, selection.label).toEqual([]);
    }

    const unlockedCalls: string[] = [];
    const unlocked = await resolvePlanInput(
      observed.value,
      { ...request, tools: ['codex'], locked: false },
      {
        ports: state.ports,
        configuration: configuration(state.root),
        transport: transport(unlockedCalls),
      },
    );
    expect(unlocked.ok).toBeTrue();
    if (!unlocked.ok) throw new Error(unlocked.error.message);
    expect(unlocked.value).toMatchObject({
      selectedSkills: ['alpha'],
      selectionOutcome: 'selected',
      replacementLock: null,
    });
    expect(unlockedCalls).toEqual([]);
  });

  test('refuses a selected pin refresh that would discard an undeclared retained pin', async () => {
    const state = await setup([{ name: 'alpha', tool: 'codex' }]);
    const alpha = state.observed.manifest.model.skills.find((skill) => skill.name === 'alpha');
    expect(alpha).toBeDefined();
    if (alpha === undefined) throw new Error('missing alpha declaration');
    const encoded = serializePortableLock({
      version: 1,
      hashSchemaVersion: 1,
      manifestHash: hashManifestSemantics(state.observed.manifest.model),
      skills: [
        {
          name: alpha.name,
          source: `${alpha.source.host}/${alpha.source.repository}//${alpha.source.path}`,
          requestedRef: 'stale-ref',
          resolvedSha: 'c'.repeat(40),
          sourcePath: alpha.source.path ?? '.',
          contentHash: `sha256:${'c'.repeat(64)}` as ArtifactDigest,
        },
        {
          name: 'orphan',
          source: 'fixture.invalid/acme/skills//skills/orphan',
          requestedRef: null,
          resolvedSha: 'd'.repeat(40),
          sourcePath: 'skills/orphan',
          contentHash: `sha256:${'d'.repeat(64)}` as ArtifactDigest,
        },
      ],
    });
    expect(encoded.ok).toBeTrue();
    if (!encoded.ok) throw new Error(encoded.error.message);
    await writeFile(state.pair.lockfile.path, encoded.value);
    const observed = await observePlanArtifacts(state.ports, state.project, state.pair);
    expect(observed.ok).toBeTrue();
    if (!observed.ok) throw new Error(observed.error.message);

    for (const prune of [false, true]) {
      const calls: string[] = [];
      const result = await resolvePlanInput(
        observed.value,
        { ...request, tools: ['codex'], prune },
        {
          ports: state.ports,
          configuration: configuration(state.root),
          transport: transport(calls),
        },
      );
      expect(result, `prune=${prune}`).toMatchObject({
        ok: false,
        error: { code: 'plan-lock-retained-pins', exitClass: 'state' },
      });
      expect(calls, `prune=${prune}`).toHaveLength(2);
    }
  });

  test('keeps prune-only retained-pin handling available when no selected pin needs refresh', async () => {
    const state = await setup([{ name: 'alpha', tool: 'codex' }]);
    const alpha = state.observed.manifest.model.skills.find((skill) => skill.name === 'alpha');
    expect(alpha).toBeDefined();
    if (alpha === undefined) throw new Error('missing alpha declaration');
    const encoded = serializePortableLock({
      version: 1,
      hashSchemaVersion: 1,
      manifestHash: hashManifestSemantics(state.observed.manifest.model),
      skills: [
        {
          name: alpha.name,
          source: `${alpha.source.host}/${alpha.source.repository}//${alpha.source.path}`,
          requestedRef: alpha.ref,
          resolvedSha: SHA,
          sourcePath: alpha.source.path ?? '.',
          contentHash: `sha256:${'b'.repeat(64)}` as ArtifactDigest,
        },
        {
          name: 'orphan',
          source: 'fixture.invalid/acme/skills//skills/orphan',
          requestedRef: null,
          resolvedSha: 'd'.repeat(40),
          sourcePath: 'skills/orphan',
          contentHash: `sha256:${'d'.repeat(64)}` as ArtifactDigest,
        },
      ],
    });
    expect(encoded.ok).toBeTrue();
    if (!encoded.ok) throw new Error(encoded.error.message);
    await writeFile(state.pair.lockfile.path, encoded.value);
    const observed = await observePlanArtifacts(state.ports, state.project, state.pair);
    expect(observed.ok).toBeTrue();
    if (!observed.ok) throw new Error(observed.error.message);

    const calls: string[] = [];
    const result = await resolvePlanInput(
      observed.value,
      { ...request, tools: ['codex'], prune: true },
      {
        ports: state.ports,
        configuration: configuration(state.root),
        transport: transport(calls),
      },
    );
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value).toMatchObject({
      selectedSkills: ['alpha'],
      selectionOutcome: 'selected',
      replacementLock: null,
    });
    expect(calls).toEqual([]);
  });

  test('filter-to-zero never resolves or widens into a lock rewrite', async () => {
    const state = await setup([{ name: 'alpha', tool: 'codex' }]);
    const calls: string[] = [];
    const result = await resolvePlanInput(
      state.observed,
      { ...request, tools: ['claude-code'] },
      {
        ports: state.ports,
        configuration: configuration(state.root),
        transport: transport(calls),
      },
    );
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value).toMatchObject({
      declarations: [],
      selectionOutcome: 'filter-noop',
      replacementLock: null,
    });
    expect(calls).toEqual([]);
  });
});
