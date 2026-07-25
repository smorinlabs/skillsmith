import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CLI_ENTRYPOINT } from '../../../packages/cli/tests/fixtures/cli.ts';
import type { CurrentApplicationContext } from '../../../packages/core/src/application/types.ts';
import type {
  ArtifactCoordinatorPorts,
  ArtifactPairBarrier,
} from '../../../packages/core/src/artifacts/coordinator-types.ts';
import { updateCoordinatedHumanFile } from '../../../packages/core/src/artifacts/coordinator.ts';
import {
  hashCanonicalInput,
  hashManifestBytes,
} from '../../../packages/core/src/artifacts/hash.ts';
import { planInitManifest } from '../../../packages/core/src/artifacts/init.ts';
import { createTestNodeArtifactCoordinatorPorts } from '../../../packages/core/src/artifacts/node-coordinator.ts';
import { prepareInitOperationPlan } from '../../../packages/core/src/init/plan.ts';
import { executePreparedInit, observeInitManifest } from '../../../packages/core/src/init/run.ts';
import {
  createObservationEmitter,
  createOperationContext,
  noopObserver,
} from '../../../packages/core/src/observation/index.ts';
import { ok } from '../../../packages/core/src/result.ts';
import { hermeticGitEnv } from '../../../packages/core/tests/fixtures/git-env.ts';

setDefaultTimeout(30_000);

type UnknownRecord = Record<string, unknown>;

const runCli = async (
  cwd: string,
  env: Record<string, string | undefined>,
  args: readonly string[],
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const process = Bun.spawn(['bun', CLI_ENTRYPOINT, ...args], {
    cwd,
    env: hermeticGitEnv(env),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await process.exited;
  return {
    exitCode,
    stdout: await new Response(process.stdout).text(),
    stderr: await new Response(process.stderr).text(),
  };
};

const report = (
  product: { readonly exitCode: number; readonly stdout: string; readonly stderr: string },
  label: string,
): UnknownRecord => {
  expect(product.exitCode, `${label}\n${product.stdout}\n${product.stderr}`).toBe(0);
  return JSON.parse(product.stdout) as UnknownRecord;
};

const observation = Object.freeze({
  context: createOperationContext({
    command: 'skillsmith phase init test',
    workflow: 'phase-init-test',
    clock: {
      wallNowIso: () => '2026-07-18T00:00:00.000Z',
      monotonicMilliseconds: () => 0,
    },
    id: { nextId: () => 'phase-init-operation' },
  }),
  emitter: createObservationEmitter({ observer: noopObserver }),
});

const executionContext = (
  artifactCoordinator: ArtifactCoordinatorPorts,
): CurrentApplicationContext =>
  ({ artifactCoordinator, ports: {}, observation }) as unknown as CurrentApplicationContext;

const prepareReplacement = async (artifactCoordinator: ArtifactCoordinatorPorts, path: string) => {
  const observed = await observeInitManifest(executionContext(artifactCoordinator), path);
  expect(observed.ok).toBeTrue();
  if (!observed.ok || observed.value.state !== 'file') throw new Error('missing phase fixture');
  const skeleton = { defaults: { tools: ['codex'] as const } };
  const classification = planInitManifest({
    skeleton,
    current: { state: 'present', bytes: observed.value.bytes },
    legacyIntent: { requireMatch: [] },
    force: true,
  });
  expect(classification.ok).toBeTrue();
  if (!classification.ok) throw new Error(classification.error.message);
  return prepareInitOperationPlan({
    request: {
      tools: ['codex'],
      explicitTools: true,
      toolSource: 'explicit',
      scope: null,
      explicitScope: false,
      file: path,
      force: true,
    },
    dryRun: false,
    defaults: { tools: ['codex'], scope: null, path: null, registryDefault: null },
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

describe('EWP-P4A-TS04', () => {
  test('init preview/execution identity changes only one manifest and never its sibling lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-p4a-ts04-'));
    const cwd = join(root, 'work');
    const home = join(root, 'home');
    const config = join(root, 'config');
    const data = join(root, 'data');
    const cache = join(root, 'cache');
    const manifest = join(cwd, 'skillsmith.toml');
    const lock = join(cwd, 'skillsmith.lock');
    await Promise.all(
      [cwd, home, config, data, cache].map((path) => mkdir(path, { recursive: true })),
    );
    const cleanEnv = { ...process.env };
    cleanEnv.SKILLSMITH_CONFIG = undefined;
    const env = {
      ...cleanEnv,
      HOME: home,
      XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: data,
      XDG_CACHE_HOME: cache,
      SKILLSMITH_HOME: join(data, 'skillsmith'),
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CODEX_HOME: join(home, '.codex'),
      CI: '1',
      NO_COLOR: '1',
    };
    const args = ['init', '--file', manifest, '--tool', 'codex', '--json'] as const;

    try {
      const preview = report(
        await runCli(cwd, env, [...args.slice(0, -1), '--dry-run', '--json']),
        'phase init preview',
      );
      expect(Bun.file(manifest).size).toBe(0);
      expect(Bun.file(lock).size).toBe(0);

      const executed = report(await runCli(cwd, env, args), 'phase init execution');
      expect(preview.result).toEqual(executed.result);
      expect(await readFile(manifest, 'utf8')).toContain('tools = ["codex"]');
      expect(Bun.file(lock).size).toBe(0);
      expect(executed).toMatchObject({
        kind: 'skillsmith.init',
        artifactSelection: { manifestPath: manifest, lockPath: lock },
        summary: { changed: 1, unchanged: 0 },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('legacy, noop, opaque replacement, and future refusal preserve all non-manifest bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-p4a-ts04-matrix-'));
    const cwd = join(root, 'work');
    const home = join(root, 'home');
    const config = join(root, 'config');
    const data = join(root, 'data');
    const cache = join(root, 'cache');
    await Promise.all(
      [cwd, home, config, data, cache].map((path) => mkdir(path, { recursive: true })),
    );
    const cleanEnv = { ...process.env };
    cleanEnv.SKILLSMITH_CONFIG = undefined;
    const env = {
      ...cleanEnv,
      HOME: home,
      XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: data,
      XDG_CACHE_HOME: cache,
      SKILLSMITH_HOME: join(data, 'skillsmith'),
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CODEX_HOME: join(home, '.codex'),
      CI: '1',
      NO_COLOR: '1',
    };
    const lock = join(cwd, 'skillsmith.lock');
    const live = join(cwd, 'live.canary');
    const ledger = join(data, 'skillsmith', 'placements.json');
    await mkdir(join(data, 'skillsmith'), { recursive: true });
    await writeFile(lock, 'lock-canary\n');
    await writeFile(live, 'live-canary\n');
    await writeFile(ledger, 'ledger-canary\n');

    try {
      const legacy = join(cwd, 'legacy.toml');
      await writeFile(legacy, 'tool = "codex"\nscope = "project"\n');
      expect(
        report(
          await runCli(cwd, env, [
            'init',
            '--file',
            legacy,
            '--tool',
            'codex',
            '--scope',
            'project',
            '--json',
          ]),
          'legacy',
        ).result,
      ).toMatchObject({ action: 'migrate-project-config', before: { shape: 'legacy' } });

      const noop = report(
        await runCli(cwd, env, [
          'init',
          '--file',
          legacy,
          '--tool',
          'codex',
          '--scope',
          'project',
          '--json',
        ]),
        'canonical noop',
      );
      expect(noop).toMatchObject({ result: { action: 'noop' }, summary: { unchanged: 1 } });

      const opaque = join(cwd, 'opaque.toml');
      const opaqueBytes = Uint8Array.from([0xff, 0xfe, 0xfd]);
      await writeFile(opaque, opaqueBytes);
      const opaqueRefusal = await runCli(cwd, env, ['init', '--file', opaque, '--json']);
      expect(opaqueRefusal.exitCode).toBe(3);
      expect(JSON.parse(opaqueRefusal.stdout)).toMatchObject({
        kind: 'error',
        code: 'init-existing-manifest',
      });
      expect(new Uint8Array(await readFile(opaque))).toEqual(opaqueBytes);
      expect(
        report(
          await runCli(cwd, env, ['init', '--file', opaque, '--force', '--json']),
          'opaque replacement',
        ).result,
      ).toMatchObject({ action: 'replace-manifest', before: { shape: 'malformed' } });

      const future = join(cwd, 'future.toml');
      await writeFile(future, 'version = 2\n');
      const futureResult = await runCli(cwd, env, ['init', '--file', future, '--force', '--json']);
      expect(futureResult.exitCode).toBe(3);
      expect(JSON.parse(futureResult.stdout)).toMatchObject({
        kind: 'error',
        code: 'init-future-manifest',
      });
      expect(await readFile(future, 'utf8')).toBe('version = 2\n');
      expect(await readFile(lock, 'utf8')).toBe('lock-canary\n');
      expect(await readFile(live, 'utf8')).toBe('live-canary\n');
      expect(await readFile(ledger, 'utf8')).toBe('ledger-canary\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('snapshot and operation digest domains stay separate while a same-byte inode writer loses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-p4a-ts04-writer-'));
    try {
      const coordinator = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
      const project = join(root, 'project');
      await mkdir(project);
      const manifest = join(project, 'skillsmith.toml');
      const source = new TextEncoder().encode('version = 1\n');
      await writeFile(manifest, source, { mode: 0o600 });
      const prepared = await prepareReplacement(coordinator, manifest);
      const operation = prepared.plan.operations[0];
      expect(operation).toBeDefined();
      if (operation === undefined || operation.before.kind !== 'manifest') return;
      const manifestDigest = hashManifestBytes(source);
      if (prepared.result.before.state !== 'present' || prepared.observed.state !== 'file') return;
      expect(operation.before.byteHash).toBe(manifestDigest);
      expect(operation.before.byteHash).toBe(prepared.result.before.byteHash);
      expect(operation.before.byteHash).not.toBe(prepared.observed.resourceDigest);

      const peer = join(project, 'peer.toml');
      await writeFile(peer, source, { mode: 0o600 });
      await rename(peer, manifest);
      expect(await executePreparedInit(executionContext(coordinator), prepared)).toMatchObject({
        ok: false,
        error: { code: 'init-precondition-changed', exitClass: 'state' },
      });
      expect(new Uint8Array(await readFile(manifest))).toEqual(source);
      expect(await coordinator.recovery.discover()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('an interrupted opaque replacement converges through signed recovery with no residue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-p4a-ts04-recovery-'));
    try {
      const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
      const manifest = join(root, 'skillsmith.toml');
      const canary = 'P17_PHASE_OPAQUE_RECOVERY_CANARY';
      const before = Uint8Array.from([0xff, 0xfe, ...new TextEncoder().encode(canary)]);
      const desired = new TextEncoder().encode('version = 1\n');
      await writeFile(manifest, before, { mode: 0o640 });
      const digest = hashCanonicalInput('resource', 1, before);
      expect(digest.ok).toBeTrue();
      if (!digest.ok) return;

      let blockCatchRecovery = false;
      let interrupted = false;
      const crashing = Object.freeze({
        ...base,
        recovery: Object.freeze({
          ...base.recovery,
          discover: async () => {
            if (blockCatchRecovery) throw new Error('simulated process death');
            return base.recovery.discover();
          },
        }),
        afterBarrier: async (barrier: ArtifactPairBarrier) => {
          if (
            !interrupted &&
            barrier.kind === 'record-durable' &&
            barrier.cursor === 'manifest-install'
          ) {
            interrupted = true;
            blockCatchRecovery = true;
            throw new Error('hard crash after opaque backup');
          }
        },
      });
      const request = {
        path: manifest,
        opaqueManifestBackup: { expectedResourceDigest: digest.value },
        edit: () => ok({ bytes: desired, changed: true as const, mode: 0o640 }),
      };
      const first = await updateCoordinatedHumanFile(crashing, request);
      expect(first.ok).toBeFalse();
      expect(interrupted).toBeTrue();
      expect(JSON.stringify(first)).not.toContain(canary);

      blockCatchRecovery = false;
      const resumed = await updateCoordinatedHumanFile(base, request);
      expect(resumed).toMatchObject({ ok: true });
      expect(new Uint8Array(await readFile(manifest))).toEqual(desired);
      expect((await base.observe(manifest)).mode).toBe(0o640);
      expect(await base.recovery.discover()).toEqual([]);
      expect(JSON.stringify(resumed)).not.toContain(canary);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
