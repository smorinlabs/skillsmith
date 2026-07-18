import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CurrentApplicationContext } from '../../src/application/types.ts';
import type { ArtifactCoordinatorPorts } from '../../src/artifacts/coordinator-types.ts';
import { hashCanonicalInput } from '../../src/artifacts/hash.ts';
import { planInitManifest } from '../../src/artifacts/init.ts';
import { createTestNodeArtifactCoordinatorPorts } from '../../src/artifacts/node-coordinator.ts';
import { prepareInitOperationPlan } from '../../src/init/plan.ts';
import { executePreparedInit, observeInitManifest } from '../../src/init/run.ts';
import type { InitArtifactSelection, InitDefaults, InitRequest } from '../../src/init/types.ts';
import {
  createObservationEmitter,
  createOperationContext,
  noopObserver,
} from '../../src/observation/index.ts';

const encoder = new TextEncoder();
const observation = Object.freeze({
  context: createOperationContext({
    command: 'skillsmith init test',
    workflow: 'init-test',
    clock: {
      wallNowIso: () => '2026-01-01T00:00:00.000Z',
      monotonicMilliseconds: () => 0,
    },
    id: { nextId: () => 'init-test-operation' },
  }),
  emitter: createObservationEmitter({ observer: noopObserver }),
});

const executionContext = (
  artifactCoordinator: ArtifactCoordinatorPorts,
  signal?: AbortSignal,
): CurrentApplicationContext =>
  ({
    artifactCoordinator,
    ports: {},
    observation,
    ...(signal === undefined ? {} : { signal }),
  }) as unknown as CurrentApplicationContext;

const prepareFilesystemInit = async (
  artifactCoordinator: ArtifactCoordinatorPorts,
  path: string,
  options: Readonly<{ tools?: readonly ['codex']; force: boolean }>,
) => {
  const observed = await observeInitManifest(executionContext(artifactCoordinator), path);
  expect(observed.ok).toBeTrue();
  if (!observed.ok) throw new Error(observed.error.code);
  const skeleton = options.tools === undefined ? {} : { defaults: { tools: options.tools } };
  const classification = planInitManifest({
    skeleton,
    current:
      observed.value.state === 'absent'
        ? { state: 'absent' }
        : { state: 'present', bytes: observed.value.bytes },
    legacyIntent: { requireMatch: [] },
    force: options.force,
  });
  expect(classification.ok).toBeTrue();
  if (!classification.ok) throw new Error(classification.error.message);
  return prepareInitOperationPlan({
    request: {
      tools: options.tools ?? [],
      explicitTools: options.tools !== undefined,
      toolSource: options.tools === undefined ? 'none' : 'explicit',
      scope: null,
      explicitScope: false,
      file: path,
      force: options.force,
    },
    dryRun: false,
    defaults: {
      tools: options.tools ?? null,
      scope: null,
      path: null,
      registryDefault: null,
    },
    selection: {
      outcome: 'selected',
      selectedBy: 'explicit-file',
      manifestPath: path,
      lockPath: join(dirname(path), 'skillsmith.lock'),
      lockSource: 'sibling',
    },
    skeleton,
    classification: classification.value,
    observed: observed.value,
  });
};

describe('init runtime observation', () => {
  test('owns ordinary bytes in the resource digest domain without parsing them', async () => {
    const original = Uint8Array.from([0xff, 0xfe, 0xfd]);
    const context = {
      artifactCoordinator: {
        observe: async () => ({
          kind: 'file',
          mode: 0o640,
          identity: 'inode',
          linkCount: 1,
          parent: { state: 'present', path: '/work', identity: 'parent' },
        }),
        readBytes: async () => original,
      },
    } as unknown as CurrentApplicationContext;
    const observed = await observeInitManifest(context, '/work/opaque.toml');
    expect(observed.ok).toBeTrue();
    if (!observed.ok || observed.value.state !== 'file') return;
    const expected = hashCanonicalInput('resource', 1, original);
    expect(expected.ok).toBeTrue();
    if (!expected.ok) return;
    expect(observed.value.resourceDigest).toBe(expected.value);
    expect(observed.value.mode).toBe(0o640);
    original.fill(0);
    expect(observed.value.bytes).toEqual(Uint8Array.from([0xff, 0xfe, 0xfd]));
  });

  test('refuses aliases and non-files before reading bytes', async () => {
    let reads = 0;
    const context = {
      artifactCoordinator: {
        observe: async () => ({
          kind: 'symlink',
          mode: 0o777,
          identity: 'link',
          linkCount: 1,
          parent: { state: 'present', path: '/work', identity: 'parent' },
        }),
        readBytes: async () => {
          reads += 1;
          return new Uint8Array();
        },
      },
    } as unknown as CurrentApplicationContext;
    expect(await observeInitManifest(context, '/work/link.toml')).toMatchObject({
      ok: false,
      error: { code: 'init-invalid-file-kind', exitClass: 'state' },
    });
    expect(reads).toBe(0);
  });

  test('preserves an execution observation permission failure through shared preconditions', async () => {
    const path = '/work/skillsmith.toml';
    const request: InitRequest = Object.freeze({
      tools: Object.freeze([]),
      explicitTools: false,
      toolSource: 'none',
      scope: null,
      explicitScope: false,
      file: path,
      force: false,
    });
    const defaults: InitDefaults = Object.freeze({
      tools: null,
      scope: null,
      path: null,
      registryDefault: null,
    });
    const selection: InitArtifactSelection = Object.freeze({
      outcome: 'selected',
      selectedBy: 'explicit-file',
      manifestPath: path,
      lockPath: '/work/skillsmith.lock',
      lockSource: 'sibling',
    });
    const classification = planInitManifest({
      skeleton: {},
      current: { state: 'absent' },
      legacyIntent: { requireMatch: [] },
      force: false,
    });
    expect(classification.ok).toBeTrue();
    if (!classification.ok) return;
    const prepared = prepareInitOperationPlan({
      request,
      dryRun: false,
      defaults,
      selection,
      skeleton: {},
      classification: classification.value,
      observed: {
        state: 'absent',
        parent: { state: 'present', path: '/work', identity: 'parent' },
      },
    });
    const context = {
      artifactCoordinator: {
        observe: async () => {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        },
      },
      ports: {},
      observation: {},
    } as unknown as CurrentApplicationContext;

    expect(await executePreparedInit(context, prepared)).toMatchObject({
      ok: false,
      error: { code: 'init-observation-permission', exitClass: 'permission' },
    });
  });

  test('classifies observation disappearance, permission, cancellation, and generic I/O', async () => {
    const cases = [
      { code: 'ENOENT', expectedCode: 'init-observation-changed', exitClass: 'state' },
      { code: 'ESTALE', expectedCode: 'init-observation-changed', exitClass: 'state' },
      { code: 'EACCES', expectedCode: 'init-observation-permission', exitClass: 'permission' },
      { code: 'EPERM', expectedCode: 'init-observation-permission', exitClass: 'permission' },
      { code: 'EIO', expectedCode: 'init-observation-failed', exitClass: 'failure' },
      { code: 'ABORT_ERR', expectedCode: 'init-cancelled', exitClass: 'cancelled' },
    ] as const;
    for (const item of cases) {
      const context = {
        artifactCoordinator: {
          observe: async () => {
            throw Object.assign(new Error('safe fixture error'), { code: item.code });
          },
        },
      } as unknown as CurrentApplicationContext;
      expect(await observeInitManifest(context, '/work/skillsmith.toml'), item.code).toMatchObject({
        ok: false,
        error: { code: item.expectedCode, exitClass: item.exitClass },
      });
    }
  });

  test('refuses same-byte inode replacement and absent-target parent replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-init-revision-'));
    try {
      const ports = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
      const project = join(root, 'project');
      await mkdir(project);
      const path = join(project, 'skillsmith.toml');
      const source = encoder.encode('version = 1\n');
      await writeFile(path, source, { mode: 0o600 });
      const prepared = await prepareFilesystemInit(ports, path, {
        tools: ['codex'],
        force: true,
      });
      const before = await ports.observe(path);
      const peer = join(project, 'peer.toml');
      await writeFile(peer, source, { mode: 0o600 });
      await rename(peer, path);
      const replaced = await ports.observe(path);
      expect(replaced.identity).not.toBe(before.identity);

      expect(await executePreparedInit(executionContext(ports), prepared)).toMatchObject({
        ok: false,
        error: { code: 'init-precondition-changed', exitClass: 'state' },
      });
      expect(new Uint8Array(await readFile(path))).toEqual(source);

      const absentPath = join(project, 'absent.toml');
      const absent = await prepareFilesystemInit(ports, absentPath, { force: false });
      const displaced = join(root, 'displaced-project');
      await rename(project, displaced);
      await mkdir(project);
      expect(await executePreparedInit(executionContext(ports), absent)).toMatchObject({
        ok: false,
        error: { code: 'init-precondition-changed', exitClass: 'state' },
      });
      expect(await Bun.file(absentPath).exists()).toBeFalse();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('accepts only the coordinator-owned missing-parent materialization transition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-init-missing-parent-'));
    try {
      const ports = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
      const path = join(root, 'missing', 'nested', 'skillsmith.toml');
      const prepared = await prepareFilesystemInit(ports, path, { force: false });
      expect(prepared.observed).toMatchObject({
        state: 'absent',
        parent: { state: 'missing', missingSegments: ['missing', 'nested'] },
      });
      expect(await executePreparedInit(executionContext(ports), prepared)).toEqual({
        ok: true,
        value: 'succeeded',
      });
      expect(await readFile(path, 'utf8')).toBe('version = 1\n');
      expect(await ports.recovery.discover()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('distinguishes precommit cancellation from cancellation after durable commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-init-cancellation-'));
    try {
      const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
      const project = join(root, 'project');
      await mkdir(project);

      const beforePath = join(project, 'before.toml');
      const before = await prepareFilesystemInit(base, beforePath, { force: false });
      const precommit = new AbortController();
      precommit.abort();
      expect(
        await executePreparedInit(executionContext(base, precommit.signal), before),
      ).toMatchObject({
        ok: false,
        error: { code: 'init-cancelled', exitClass: 'cancelled', durableState: 'before' },
      });
      expect(await Bun.file(beforePath).exists()).toBeFalse();

      const afterPath = join(project, 'after.toml');
      const after = await prepareFilesystemInit(base, afterPath, { force: false });
      const committed = new AbortController();
      const ports = Object.freeze({
        ...base,
        afterBarrier: async (barrier: Parameters<NonNullable<typeof base.afterBarrier>>[0]) => {
          if (barrier.kind === 'record-durable' && barrier.cursor === 'committed') {
            committed.abort();
          }
        },
      });
      expect(
        await executePreparedInit(executionContext(ports, committed.signal), after),
      ).toMatchObject({
        ok: false,
        error: { code: 'init-cancelled', exitClass: 'cancelled', durableState: 'after' },
      });
      expect(await readFile(afterPath, 'utf8')).toBe('version = 1\n');
      expect(await base.recovery.discover()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
