import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ArtifactCoordinatorPorts,
  ArtifactPairBarrier,
  ArtifactPairRecoveryRecord,
} from '../../src/artifacts/coordinator-types.ts';
import {
  commitArtifactPair,
  readCoordinatedArtifactPair,
  recoverArtifactPair,
  updateCoordinatedHumanFile,
} from '../../src/artifacts/coordinator.ts';
import { hashManifestSemantics } from '../../src/artifacts/hash.ts';
import { serializePortableLock } from '../../src/artifacts/lock.ts';
import { normalizeManifestDocument, readManifestSource } from '../../src/artifacts/manifest.ts';
import { createTestNodeArtifactCoordinatorPorts } from '../../src/artifacts/node-coordinator.ts';
import { ok } from '../../src/result.ts';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

const pairFor = (manifestPath: string, lockPath: string) =>
  Object.freeze({
    file: Object.freeze({
      token: null,
      path: manifestPath,
      portability: 'machine-bound' as const,
      portableToken: null,
    }),
    lockfile: Object.freeze({
      token: null,
      path: lockPath,
      portability: 'machine-bound' as const,
      portableToken: null,
    }),
    lockfileSource: 'sibling' as const,
  });

const interruptedHumanRecovery = async (cursor: 'prepared' | 'staging') => {
  const root = await mkdtemp(join(tmpdir(), `skillsmith-coordinator-${cursor}-recovery-`));
  roots.push(root);
  const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
  const path = join(root, 'config.toml');
  const desired = new TextEncoder().encode('tool = "codex"\n');
  let crashed = false;
  let blockCatchRecovery = false;
  const ports = Object.freeze({
    ...base,
    recovery: Object.freeze({
      ...base.recovery,
      discover: async () => {
        if (blockCatchRecovery) throw new Error('simulated process death');
        return base.recovery.discover();
      },
    }),
    afterBarrier: async (barrier: ArtifactPairBarrier) => {
      if (!crashed && barrier.kind === 'record-durable' && barrier.cursor === cursor) {
        crashed = true;
        blockCatchRecovery = true;
        throw new Error(`hard crash at ${cursor}`);
      }
    },
  });
  const interrupted = await updateCoordinatedHumanFile(ports, {
    path,
    edit: () => ok({ bytes: desired, changed: true, mode: 0o600 }),
  });
  if (interrupted.ok) throw new Error('recovery fixture did not interrupt');
  blockCatchRecovery = false;
  const [pending] = await base.recovery.discover();
  const [directory] = pending?.record.directories ?? [];
  const stage = pending?.record.objects.find((object) => object.slot === 'stage');
  if (pending === undefined || directory === undefined || stage === undefined) {
    throw new Error('invalid interrupted recovery fixture');
  }
  return Object.freeze({
    root,
    base,
    path,
    pair: pairFor(path, join(root, 'unused.lock')),
    desired,
    pending,
    directory,
    stage,
  });
};

describe('artifact coordinator', () => {
  test('atomically creates a canonical manifest/lock pair and reads only the full pair', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-coordinator-pair-'));
    roots.push(root);
    const ports = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const manifestPath = join(root, 'skillsmith.toml');
    const lockPath = join(root, 'skillsmith.lock');
    const source = 'version = 1\nskills = []\n';
    const document = readManifestSource(source);
    if (!document.ok) throw new Error('fixture manifest invalid');
    const manifest = normalizeManifestDocument(document.value);
    if (!manifest.ok) throw new Error('fixture manifest invalid');
    const pair = Object.freeze({
      file: Object.freeze({
        token: null,
        path: manifestPath,
        portability: 'machine-bound' as const,
        portableToken: null,
      }),
      lockfile: Object.freeze({
        token: null,
        path: lockPath,
        portability: 'machine-bound' as const,
        portableToken: null,
      }),
      lockfileSource: 'sibling' as const,
    });
    const committed = await commitArtifactPair(ports, {
      pair,
      manifest: { kind: 'replace', bytes: new TextEncoder().encode(source) },
      lock: {
        kind: 'replace',
        lock: Object.freeze({
          version: 1,
          hashSchemaVersion: 1,
          manifestHash: hashManifestSemantics(manifest.value),
          skills: Object.freeze([]),
        }),
      },
    });
    expect(committed.ok, committed.ok ? undefined : JSON.stringify(committed.error)).toBeTrue();
    if (!committed.ok) return;
    expect(committed.value.outcome).toBe('committed');
    expect(committed.value.manifestRevision.state).toBe('file');
    expect(committed.value.lockRevision.state).toBe('file');

    const read = await readCoordinatedArtifactPair(ports, pair);
    expect(read.ok).toBeTrue();
    if (read.ok) {
      expect(read.value.manifest.state).toBe('file');
      expect(read.value.lock.state).toBe('file');
    }
    expect(await ports.recovery.discover()).toEqual([]);
  });

  test('converges when an external writer installs the exact desired pair before fresh read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-coordinator-exact-convergence-'));
    roots.push(root);
    const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const manifestPath = join(root, 'skillsmith.toml');
    const lockPath = join(root, 'skillsmith.lock');
    const pair = pairFor(manifestPath, lockPath);
    const source = 'version = 1\nskills = []\n';
    const document = readManifestSource(source);
    if (!document.ok) throw new Error('fixture manifest invalid');
    const manifest = normalizeManifestDocument(document.value);
    if (!manifest.ok) throw new Error('fixture manifest invalid');
    const lock = Object.freeze({
      version: 1 as const,
      hashSchemaVersion: 1 as const,
      manifestHash: hashManifestSemantics(manifest.value),
      skills: Object.freeze([]),
    });
    const serialized = serializePortableLock(lock);
    if (!serialized.ok) throw new Error('fixture lock invalid');
    const manifestBytes = new TextEncoder().encode(source);
    const lockBytes = new TextEncoder().encode(serialized.value);
    let injected = false;
    const withFileLock: ArtifactCoordinatorPorts['withFileLock'] = async (
      target,
      options,
      operation,
    ) =>
      base.withFileLock(target, options, async () => {
        if (!injected && options.policy === 'compatibility') {
          injected = true;
          await writeFile(manifestPath, manifestBytes, { mode: 0o600 });
          await writeFile(lockPath, lockBytes, { mode: 0o600 });
        }
        return operation();
      });
    const ports: ArtifactCoordinatorPorts = Object.freeze({
      ...base,
      withFileLock,
    });

    const result = await commitArtifactPair(ports, {
      pair,
      manifest: { kind: 'replace', bytes: manifestBytes },
      lock: { kind: 'replace', lock },
    });

    expect(result).toMatchObject({
      ok: true,
      value: { outcome: 'unchanged', externalBytesReplayed: false },
    });
    expect(new Uint8Array(await readFile(manifestPath))).toEqual(manifestBytes);
    expect(new Uint8Array(await readFile(lockPath))).toEqual(lockBytes);
    expect(await base.recovery.discover()).toEqual([]);
  });

  test('maps a malformed lock introduced after a valid provisional read to writer conflict', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-coordinator-fresh-invalid-lock-'));
    roots.push(root);
    const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const manifestPath = join(root, 'skillsmith.toml');
    const lockPath = join(root, 'skillsmith.lock');
    const pair = pairFor(manifestPath, lockPath);
    const source = 'version = 1\nskills = []\n';
    const document = readManifestSource(source);
    if (!document.ok) throw new Error('fixture manifest invalid');
    const manifest = normalizeManifestDocument(document.value);
    if (!manifest.ok) throw new Error('fixture manifest invalid');
    const lock = Object.freeze({
      version: 1 as const,
      hashSchemaVersion: 1 as const,
      manifestHash: hashManifestSemantics(manifest.value),
      skills: Object.freeze([]),
    });
    const malformed = new TextEncoder().encode('not a portable lock\n');
    let injected = false;
    const withFileLock: ArtifactCoordinatorPorts['withFileLock'] = async (
      target,
      options,
      operation,
    ) =>
      base.withFileLock(target, options, async () => {
        if (!injected && options.policy === 'compatibility') {
          injected = true;
          await writeFile(lockPath, malformed, { mode: 0o600 });
        }
        return operation();
      });
    const ports: ArtifactCoordinatorPorts = Object.freeze({
      ...base,
      withFileLock,
    });

    const result = await commitArtifactPair(ports, {
      pair,
      manifest: { kind: 'replace', bytes: new TextEncoder().encode(source) },
      lock: { kind: 'replace', lock },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'external-writer-conflict', role: 'lock' },
    });
    expect(new Uint8Array(await readFile(lockPath))).toEqual(malformed);
    expect((await base.observe(manifestPath)).kind).toBe('absent');
    expect(await base.recovery.discover()).toEqual([]);
  });

  test('refuses lock removal while the resulting manifest still declares skills', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-coordinator-remove-lock-'));
    roots.push(root);
    const ports = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const manifestPath = join(root, 'skillsmith.toml');
    const lockPath = join(root, 'skillsmith.lock');
    const source = `version = 1
[defaults]
tools = ["codex"]
scope = "project"
[[skills]]
name = "review"
source = "github.com/acme/tools//skills/review"
`;
    const result = await commitArtifactPair(ports, {
      pair: Object.freeze({
        file: Object.freeze({
          token: null,
          path: manifestPath,
          portability: 'machine-bound' as const,
          portableToken: null,
        }),
        lockfile: Object.freeze({
          token: null,
          path: lockPath,
          portability: 'machine-bound' as const,
          portableToken: null,
        }),
        lockfileSource: 'sibling' as const,
      }),
      manifest: { kind: 'replace', bytes: new TextEncoder().encode(source) },
      lock: { kind: 'remove' },
    });

    expect(result).toMatchObject({ ok: false, error: { reason: 'invalid-request', role: 'lock' } });
    expect((await ports.observe(manifestPath)).kind).toBe('absent');
    expect((await ports.observe(lockPath)).kind).toBe('absent');
    expect(await ports.recovery.discover()).toEqual([]);
  });

  test('treats whole-manifest replace as absent-only and preserves existing human bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-coordinator-replace-existing-'));
    roots.push(root);
    const ports = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const manifestPath = join(root, 'skillsmith.toml');
    const lockPath = join(root, 'skillsmith.lock');
    const before = new TextEncoder().encode('version = 1\nskills = []\n# human trivia\n');
    await writeFile(manifestPath, before);

    const result = await commitArtifactPair(ports, {
      pair: pairFor(manifestPath, lockPath),
      manifest: {
        kind: 'replace',
        bytes: new TextEncoder().encode('version = 1\nskills = []\n'),
      },
      lock: { kind: 'remove' },
    });

    expect(result).toMatchObject({ ok: false, error: { reason: 'invalid-request' } });
    expect(new Uint8Array(await readFile(manifestPath))).toEqual(before);
    expect(await ports.recovery.discover()).toEqual([]);
  });

  test('commits a one-member human file through recovery and leaves no transaction residue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-coordinator-'));
    roots.push(root);
    const ports = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const path = join(root, 'config', 'config.toml');
    const bytes = new TextEncoder().encode('schema_version = 1\n');
    const result = await updateCoordinatedHumanFile(ports, {
      path,
      edit: () => ok(Object.freeze({ bytes, changed: true, mode: 0o600 })),
    });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.error)).toBeTrue();
    if (!result.ok) return;
    expect(result.value.outcome).toBe('committed');
    expect(new Uint8Array(await readFile(path))).toEqual(bytes);
    expect(await ports.recovery.discover()).toEqual([]);
    expect(
      (await readdir(join(root, 'config'))).filter((name) => name.startsWith('.skillsmith')),
    ).toEqual([]);
  });

  test('returns an exact coordinated no-op before allocating transaction IDs or residue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-coordinator-noop-'));
    roots.push(root);
    const ports = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const path = join(root, 'config.toml');
    let edits = 0;
    const result = await updateCoordinatedHumanFile(ports, {
      path,
      edit: () => {
        edits += 1;
        return ok(Object.freeze({ bytes: new Uint8Array(), changed: false, mode: 0o600 }));
      },
    });
    expect(result).toMatchObject({ ok: true, value: { outcome: 'unchanged' } });
    expect(edits).toBe(1);
    expect(await ports.recovery.discover()).toEqual([]);
  });

  test('rejects sensitive and redacted callback output before durable persistence', async () => {
    for (const [name, source] of [
      ['sensitive', 'api_key = "sk-example-secret-material"\n'],
      ['redacted', 'api_key = "[REDACTED]"\n'],
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), `skillsmith-coordinator-${name}-sink-`));
      roots.push(root);
      const ports = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
      const path = join(root, 'config.toml');
      const result = await updateCoordinatedHumanFile(ports, {
        path,
        edit: () => ok({ bytes: new TextEncoder().encode(source), changed: true, mode: 0o600 }),
      });

      expect(result, name).toMatchObject({
        ok: false,
        error: { reason: 'unsafe-human-edit' },
      });
      expect(JSON.stringify(result), name).not.toContain(
        name === 'sensitive' ? 'sk-example-secret-material' : '[REDACTED]',
      );
      expect((await ports.observe(path)).kind, name).toBe('absent');
      expect(await ports.recovery.discover(), name).toEqual([]);
      expect(
        (await readdir(root)).filter((entry) => entry.startsWith('.skillsmith-artifact-')),
        name,
      ).toEqual([]);
    }
  });

  test('rejects a sensitive destination path without reflecting its canary in the error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-coordinator-sensitive-path-'));
    roots.push(root);
    const ports = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const canary = 'sk-P17_SECRET_CANARY_123456789';
    const result = await updateCoordinatedHumanFile(ports, {
      path: join(root, `api_key=${canary}`),
      edit: () =>
        ok({ bytes: new TextEncoder().encode('schema_version = 1\n'), changed: true, mode: 0o600 }),
    });

    expect(result).toMatchObject({ ok: false, error: { reason: 'invalid-request' } });
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(await ports.recovery.discover()).toEqual([]);
  });

  test('refuses to persist sensitive preexisting bytes as transaction backup state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-coordinator-sensitive-backup-'));
    roots.push(root);
    const ports = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const path = join(root, 'config.toml');
    const before = new TextEncoder().encode('api_key = "sk-example-secret-material"\n');
    await writeFile(path, before);

    const result = await updateCoordinatedHumanFile(ports, {
      path,
      edit: () =>
        ok({
          bytes: new TextEncoder().encode('schema_version = 1\n'),
          changed: true,
          mode: 0o600,
        }),
    });

    expect(result).toMatchObject({ ok: false, error: { reason: 'unsafe-human-edit' } });
    expect(JSON.stringify(result)).not.toContain('sk-example-secret-material');
    expect(new Uint8Array(await readFile(path))).toEqual(before);
    expect(await ports.recovery.discover()).toEqual([]);
    expect(
      (await readdir(root)).filter((entry) => entry.startsWith('.skillsmith-artifact-')),
    ).toEqual([]);
  });

  test('advances a durable staging candidate after an exclusive-directory collision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-coordinator-collision-'));
    roots.push(root);
    const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    let createCalls = 0;
    const ports = Object.freeze({
      ...base,
      createTransactionDirectoryExclusive: async (path: string, token: string) => {
        createCalls += 1;
        if (createCalls === 1) {
          throw Object.assign(new Error('collision'), { code: 'EEXIST' });
        }
        return base.createTransactionDirectoryExclusive(path, token);
      },
    });
    const result = await updateCoordinatedHumanFile(ports, {
      path: join(root, 'config.toml'),
      edit: () =>
        ok({ bytes: new TextEncoder().encode('schema_version = 1\n'), changed: true, mode: 0o600 }),
    });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.error)).toBeTrue();
    expect(createCalls).toBe(2);
    expect(await ports.recovery.discover()).toEqual([]);
  });

  test('durably advances after a real transaction mkdir gap and preserves the unmarked collision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-coordinator-physical-collision-'));
    roots.push(root);
    let failed = false;
    const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'), {
      afterPhysicalStep: async (step) => {
        if (!failed && step.area === 'transaction' && step.step === 'directory-created') {
          failed = true;
          throw new Error('simulated process death before owner marker');
        }
      },
    });
    const advancedRecords: ArtifactPairRecoveryRecord[] = [];
    const ports = Object.freeze({
      ...base,
      recovery: Object.freeze({
        ...base.recovery,
        replace: async (record: ArtifactPairRecoveryRecord, expectedRevision: string) => {
          if (record.attempt > 1) advancedRecords.push(record);
          return base.recovery.replace(record, expectedRevision);
        },
      }),
    });
    const path = join(root, 'config.toml');

    const result = await updateCoordinatedHumanFile(ports, {
      path,
      edit: () =>
        ok({ bytes: new TextEncoder().encode('schema_version = 1\n'), changed: true, mode: 0o600 }),
    });

    expect(failed).toBeTrue();
    expect(result).toMatchObject({ ok: false, error: { reason: 'filesystem-failure' } });
    const advanced = advancedRecords.at(-1);
    if (advanced === undefined) throw new Error('prepared collision was not durably advanced');
    expect(advanced.attempt).toBe(2);
    expect(advanced.collisionPaths).toHaveLength(1);
    const collision = advanced.collisionPaths[0] as string;
    const [nextDirectory] = advanced.directories;
    expect(nextDirectory?.path).not.toBe(collision);
    expect(nextDirectory?.identity).toBeNull();
    expect(nextDirectory?.ownershipToken).not.toBe('');
    expect((await base.observe(collision)).kind).toBe('directory');
    expect((await base.observe(join(collision, 'owner'))).kind).toBe('absent');
    expect(
      nextDirectory === undefined ? 'missing' : (await base.observe(nextDirectory.path)).kind,
    ).toBe('absent');
    expect((await base.observe(path)).kind).toBe('absent');
    expect(await base.recovery.discover()).toEqual([]);

    const retried = await updateCoordinatedHumanFile(base, {
      path,
      edit: () => ok({ bytes: new Uint8Array(), changed: false, mode: 0o600 }),
    });
    expect(retried).toMatchObject({ ok: true, value: { outcome: 'unchanged' } });
    expect((await base.observe(collision)).kind).toBe('directory');
  });

  test('refuses invalid adapter IDs and pre-lock cancellation without destination residue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-coordinator-refusal-'));
    roots.push(root);
    const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const path = join(root, 'missing', 'config.toml');
    const invalidId = await updateCoordinatedHumanFile(
      Object.freeze({ ...base, nextId: () => 'not-an-internal-id' }),
      {
        path,
        edit: () => ok({ bytes: new Uint8Array([1]), changed: true, mode: 0o600 }),
      },
    );
    expect(invalidId).toMatchObject({
      ok: false,
      error: { reason: 'filesystem-failure' },
    });

    const controller = new AbortController();
    controller.abort();
    const cancelled = await updateCoordinatedHumanFile(base, {
      path,
      signal: controller.signal,
      edit: () => ok({ bytes: new Uint8Array([1]), changed: true, mode: 0o600 }),
    });
    expect(cancelled).toMatchObject({
      ok: false,
      error: { reason: 'cancelled', durableState: 'unobserved-before' },
    });
    expect((await base.observe(path)).kind).toBe('absent');
  });

  test('rolls back stage-mode, directory-sync, and no-replace permission faults without residue', async () => {
    const scenarios = ['mode', 'directory-sync', 'link-permission'] as const;
    for (const scenario of scenarios) {
      const root = await mkdtemp(join(tmpdir(), `skillsmith-coordinator-fault-${scenario}-`));
      roots.push(root);
      const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
      const path = join(root, 'config.toml');
      const before = new TextEncoder().encode('tool = "codex"\n');
      if (scenario === 'link-permission') {
        await writeFile(path, before);
        await chmod(path, 0o640);
      }
      let injected = false;
      const ports = Object.freeze({
        ...base,
        ...(scenario === 'mode'
          ? {
              setFileMode: async (target: string, mode: number) => {
                if (!injected) {
                  injected = true;
                  throw new Error('mode fault');
                }
                return base.setFileMode(target, mode);
              },
            }
          : {}),
        ...(scenario === 'directory-sync'
          ? {
              fsyncDirectory: async (target: string) => {
                if (!injected) {
                  injected = true;
                  throw new Error('directory sync fault');
                }
                return base.fsyncDirectory(target);
              },
            }
          : {}),
        ...(scenario === 'link-permission'
          ? {
              linkFileNoReplace: async (source: string, target: string) => {
                if (!injected) {
                  injected = true;
                  throw Object.assign(new Error('denied'), { code: 'EACCES' });
                }
                return base.linkFileNoReplace(source, target);
              },
            }
          : {}),
      });
      const result = await updateCoordinatedHumanFile(ports, {
        path,
        edit: () =>
          ok({
            bytes: new TextEncoder().encode('tool = "opencode"\n'),
            changed: true,
            mode: scenario === 'link-permission' ? 0o640 : 0o600,
          }),
      });
      expect(result.ok, scenario).toBeFalse();
      if (result.ok) continue;
      expect(result.error.reason, scenario).toBe(
        scenario === 'link-permission' ? 'permission-denied' : 'filesystem-failure',
      );
      expect(await base.recovery.discover(), scenario).toEqual([]);
      expect(
        (await readdir(root)).filter((name) => name.startsWith('.skillsmith-artifact-')),
        scenario,
      ).toEqual([]);
      if (scenario === 'link-permission') {
        expect(new Uint8Array(await readFile(path))).toEqual(before);
      } else {
        expect((await base.observe(path)).kind).toBe('absent');
      }
    }
  });

  test('cleans an adapter-proven partial exclusive stage write before rollback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-coordinator-partial-stage-'));
    roots.push(root);
    const ports = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'), {
      failExclusiveWriteAfterBytes: 4,
    });
    const path = join(root, 'config.toml');
    const result = await updateCoordinatedHumanFile(ports, {
      path,
      edit: () =>
        ok({ bytes: new TextEncoder().encode('tool = "codex"\n'), changed: true, mode: 0o600 }),
    });

    expect(result).toMatchObject({ ok: false, error: { reason: 'filesystem-failure' } });
    expect((await ports.observe(path)).kind).toBe('absent');
    expect(await ports.recovery.discover()).toEqual([]);
    expect(
      (await readdir(root)).filter((entry) => entry.startsWith('.skillsmith-artifact-')),
    ).toEqual([]);
  });

  test('removes a prepared record and preserves permission denial when transaction creation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-coordinator-transaction-permission-'));
    roots.push(root);
    const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const path = join(root, 'config.toml');
    const ports = Object.freeze({
      ...base,
      createTransactionDirectoryExclusive: async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      },
    });

    const result = await updateCoordinatedHumanFile(ports, {
      path,
      edit: () =>
        ok({
          bytes: new TextEncoder().encode('schema_version = 1\n'),
          changed: true,
          mode: 0o600,
        }),
    });

    expect(result).toMatchObject({ ok: false, error: { reason: 'permission-denied' } });
    expect((await base.observe(path)).kind).toBe('absent');
    expect(await base.recovery.discover()).toEqual([]);
    expect(
      (await readdir(root)).filter((entry) => entry.startsWith('.skillsmith-artifact-')),
    ).toEqual([]);
  });

  test('maps post-prepare and post-commit cancellation to exact durable states', async () => {
    for (const cursor of ['staging', 'committed'] as const) {
      const root = await mkdtemp(join(tmpdir(), `skillsmith-coordinator-cancel-${cursor}-`));
      roots.push(root);
      const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
      const path = join(root, 'config.toml');
      const controller = new AbortController();
      const ports = Object.freeze({
        ...base,
        afterBarrier: async (barrier: ArtifactPairBarrier) => {
          if (barrier.kind === 'record-durable' && barrier.cursor === cursor) controller.abort();
        },
      });
      const result = await updateCoordinatedHumanFile(ports, {
        path,
        signal: controller.signal,
        edit: () =>
          ok({
            bytes: new TextEncoder().encode('schema_version = 1\n'),
            changed: true,
            mode: 0o600,
          }),
      });
      expect(result).toMatchObject({
        ok: false,
        error: {
          reason: 'cancelled',
          durableState: cursor === 'committed' ? 'after' : 'before',
          manifestRevision: { state: cursor === 'committed' ? 'file' : 'absent' },
        },
      });
      expect((await base.observe(path)).kind).toBe(cursor === 'committed' ? 'file' : 'absent');
      expect(await base.recovery.discover()).toEqual([]);
      expect(
        (await readdir(root)).filter((name) => name.startsWith('.skillsmith-artifact-')),
      ).toEqual([]);
    }
  });

  test('honors cancellation at the second compatibility lock before the fresh pair snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-coordinator-second-lock-cancel-'));
    roots.push(root);
    const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const manifestPath = join(root, 'skillsmith.toml');
    const lockPath = join(root, 'skillsmith.lock');
    const source = 'version = 1\nskills = []\n';
    const document = readManifestSource(source);
    if (!document.ok) throw new Error('fixture manifest invalid');
    const manifest = normalizeManifestDocument(document.value);
    if (!manifest.ok) throw new Error('fixture manifest invalid');
    const lock = Object.freeze({
      version: 1 as const,
      hashSchemaVersion: 1 as const,
      manifestHash: hashManifestSemantics(manifest.value),
      skills: Object.freeze([]),
    });
    const controller = new AbortController();
    let abortedAtSecondLock = false;
    let postAbortObservations = 0;
    const ports = Object.freeze({
      ...base,
      observe: async (path: string) => {
        if (abortedAtSecondLock) postAbortObservations += 1;
        return base.observe(path);
      },
      afterBarrier: async (barrier: ArtifactPairBarrier) => {
        if (
          barrier.kind === 'lock-acquired' &&
          barrier.targetClass === 'compatibility' &&
          barrier.occurrence === 1
        ) {
          abortedAtSecondLock = true;
          controller.abort();
        }
      },
    });

    const result = await commitArtifactPair(ports, {
      pair: pairFor(manifestPath, lockPath),
      manifest: { kind: 'replace', bytes: new TextEncoder().encode(source) },
      lock: { kind: 'replace', lock },
      signal: controller.signal,
    });

    expect(abortedAtSecondLock).toBeTrue();
    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'cancelled', durableState: 'unobserved-before' },
    });
    if (result.ok) throw new Error('expected cancellation');
    expect(result.error.manifestRevision).toBeUndefined();
    expect(result.error.lockRevision).toBeUndefined();
    expect(postAbortObservations).toBe(0);
    expect((await base.observe(manifestPath)).kind).toBe('absent');
    expect((await base.observe(lockPath)).kind).toBe('absent');
    expect(await base.recovery.discover()).toEqual([]);
    expect(
      (await readdir(root)).filter((name) => name.startsWith('.skillsmith-artifact-')),
    ).toEqual([]);
  });

  test('rolls pair-verify cancellation back to exact before until committed is durable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-coordinator-pair-verify-cancel-'));
    roots.push(root);
    const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const path = join(root, 'config.toml');
    const before = new TextEncoder().encode('tool = "before"\n');
    await writeFile(path, before, { mode: 0o640 });
    await chmod(path, 0o640);
    const controller = new AbortController();
    let cancelledAtPairVerify = false;
    const ports = Object.freeze({
      ...base,
      afterBarrier: async (barrier: ArtifactPairBarrier) => {
        if (
          !cancelledAtPairVerify &&
          barrier.kind === 'record-durable' &&
          barrier.cursor === 'pair-verify'
        ) {
          cancelledAtPairVerify = true;
          controller.abort();
        }
      },
    });

    const result = await updateCoordinatedHumanFile(ports, {
      path,
      signal: controller.signal,
      edit: () =>
        ok({
          bytes: new TextEncoder().encode('tool = "after"\n'),
          changed: true,
          mode: 0o600,
        }),
    });

    expect(cancelledAtPairVerify).toBeTrue();
    expect(result).toMatchObject({
      ok: false,
      error: {
        reason: 'cancelled',
        durableState: 'before',
        manifestRevision: { state: 'file', mode: 0o640 },
      },
    });
    expect(new Uint8Array(await readFile(path))).toEqual(before);
    expect((await base.observe(path)).mode).toBe(0o640);
    expect(await base.recovery.discover()).toEqual([]);
    expect(
      (await readdir(root)).filter((name) => name.startsWith('.skillsmith-artifact-')),
    ).toEqual([]);
  });

  test('finishes committed cleanup before returning cancellation raised during cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-coordinator-cleanup-cancel-'));
    roots.push(root);
    const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const path = join(root, 'config.toml');
    const controller = new AbortController();
    let abortedDuringCleanup = false;
    const ports = Object.freeze({
      ...base,
      afterBarrier: async (barrier: ArtifactPairBarrier) => {
        if (
          !abortedDuringCleanup &&
          barrier.kind === 'record-durable' &&
          barrier.cursor === 'cleanup'
        ) {
          abortedDuringCleanup = true;
          controller.abort();
        }
      },
    });

    const result = await updateCoordinatedHumanFile(ports, {
      path,
      signal: controller.signal,
      edit: () =>
        ok({
          bytes: new TextEncoder().encode('schema_version = 1\n'),
          changed: true,
          mode: 0o600,
        }),
    });

    expect(abortedDuringCleanup).toBeTrue();
    expect(result).toMatchObject({
      ok: false,
      error: {
        reason: 'cancelled',
        durableState: 'after',
        manifestRevision: { state: 'file' },
      },
    });
    expect((await base.observe(path)).kind).toBe('file');
    expect(await base.recovery.discover()).toEqual([]);
    expect(
      (await readdir(root)).filter((name) => name.startsWith('.skillsmith-artifact-')),
    ).toEqual([]);
  });

  test('finishes automatic overlap recovery before honoring cancellation at every recovery barrier', async () => {
    const enumeration = await interruptedHumanRecovery('staging');
    let enumeratingRecovery = false;
    const recoverableBarriers: ArtifactPairBarrier[] = [];
    const enumeratingPorts = Object.freeze({
      ...enumeration.base,
      afterBarrier: async (barrier: ArtifactPairBarrier) => {
        if (barrier.kind === 'recovery-discovered') enumeratingRecovery = true;
        if (enumeratingRecovery) recoverableBarriers.push(barrier);
      },
    });
    const enumerated = await updateCoordinatedHumanFile(enumeratingPorts, {
      path: enumeration.path,
      edit: () => ok({ bytes: new Uint8Array(), changed: false, mode: 0o600 }),
    });
    expect(enumerated).toMatchObject({ ok: true, value: { outcome: 'unchanged' } });
    expect(recoverableBarriers.length).toBeGreaterThan(10);

    for (let targetIndex = 0; targetIndex < recoverableBarriers.length; targetIndex += 1) {
      const fixture = await interruptedHumanRecovery('staging');
      const controller = new AbortController();
      let recoveryStarted = false;
      let recoveryIndex = -1;
      let editCalls = 0;
      const ports = Object.freeze({
        ...fixture.base,
        afterBarrier: async (barrier: ArtifactPairBarrier) => {
          if (barrier.kind === 'recovery-discovered') recoveryStarted = true;
          if (!recoveryStarted) return;
          recoveryIndex += 1;
          if (recoveryIndex === targetIndex) controller.abort();
        },
      });

      const result = await updateCoordinatedHumanFile(ports, {
        path: fixture.path,
        signal: controller.signal,
        edit: () => {
          editCalls += 1;
          return ok({ bytes: new Uint8Array(), changed: false, mode: 0o600 });
        },
      });

      expect(controller.signal.aborted, `barrier ${targetIndex}`).toBeTrue();
      expect(result, `barrier ${targetIndex}`).toMatchObject({
        ok: false,
        error: { reason: 'cancelled', durableState: 'unobserved-before' },
      });
      expect(editCalls, `barrier ${targetIndex}`).toBe(0);
      expect((await fixture.base.observe(fixture.path)).kind, `barrier ${targetIndex}`).toBe(
        'absent',
      );
      expect(await fixture.base.recovery.discover(), `barrier ${targetIndex}`).toEqual([]);
      expect(
        (await readdir(fixture.root)).filter((name) => name.startsWith('.skillsmith-artifact-')),
        `barrier ${targetIndex}`,
      ).toEqual([]);
    }
  }, 30_000);

  test('captures and restores a last-moment external writer displaced by backup rename', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-coordinator-external-'));
    roots.push(root);
    const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const path = join(root, 'config.toml');
    const original = new TextEncoder().encode('tool = "codex"\n');
    const external = new TextEncoder().encode('tool = "external"\n');
    await writeFile(path, original);
    let displaced = false;
    const ports = Object.freeze({
      ...base,
      moveIntoOwnedTransaction: async (source: string, destination: string) => {
        if (!displaced && source === path) {
          displaced = true;
          await writeFile(source, external);
        }
        return base.moveIntoOwnedTransaction(source, destination);
      },
    });
    const result = await updateCoordinatedHumanFile(ports, {
      path,
      edit: () =>
        ok({
          bytes: new TextEncoder().encode('tool = "opencode"\n'),
          changed: true,
          mode: 0o600,
        }),
    });
    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'external-writer-conflict' },
    });
    expect(new Uint8Array(await readFile(path))).toEqual(external);
    expect(await base.recovery.discover()).toEqual([]);
    expect(
      (await readdir(root)).filter((name) => name.startsWith('.skillsmith-artifact-')),
    ).toEqual([]);
  });

  test('resumed backup moves durably capture and restore displaced writers for both roles', async () => {
    for (const role of ['manifest', 'lock'] as const) {
      const root = await mkdtemp(join(tmpdir(), `skillsmith-coordinator-resume-${role}-writer-`));
      roots.push(root);
      const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
      const manifestPath = join(root, 'skillsmith.toml');
      const lockPath = join(root, 'skillsmith.lock');
      const path = role === 'manifest' ? manifestPath : lockPath;
      const originalManifest = new TextEncoder().encode('version = 1\nskills = []\n');
      await writeFile(manifestPath, originalManifest);
      if (role === 'lock') {
        const document = readManifestSource(new TextDecoder().decode(originalManifest));
        if (!document.ok) throw new Error('fixture manifest invalid');
        const normalized = normalizeManifestDocument(document.value);
        if (!normalized.ok) throw new Error('fixture manifest invalid');
        const serialized = serializePortableLock(
          Object.freeze({
            version: 1,
            hashSchemaVersion: 1,
            manifestHash: hashManifestSemantics(normalized.value),
            skills: Object.freeze([]),
          }),
        );
        if (!serialized.ok) throw new Error('fixture lock invalid');
        await writeFile(lockPath, serialized.value);
      }
      const original = new Uint8Array(await readFile(path));
      const originalObservation = await base.observe(path);
      if (originalObservation.kind !== 'file') throw new Error('fixture file was not observed');
      let blockCatchRecovery = false;
      let interruptedAtBackup = false;
      const interrupting = Object.freeze({
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
            !interruptedAtBackup &&
            barrier.kind === 'record-durable' &&
            barrier.cursor === `${role}-backup`
          ) {
            interruptedAtBackup = true;
            blockCatchRecovery = true;
            throw new Error('hard crash before resumed backup move');
          }
        },
      });
      const interrupted =
        role === 'manifest'
          ? await updateCoordinatedHumanFile(interrupting, {
              path,
              edit: () =>
                ok({
                  bytes: new TextEncoder().encode('version = 1\nskills = []\n# desired\n'),
                  changed: true,
                  mode: 0o600,
                }),
            })
          : await commitArtifactPair(interrupting, {
              pair: pairFor(manifestPath, lockPath),
              manifest: { kind: 'keep' },
              lock: { kind: 'remove' },
            });
      expect(interrupted.ok, role).toBeFalse();
      expect(interruptedAtBackup, role).toBeTrue();
      blockCatchRecovery = false;
      const external = new TextEncoder().encode(`${role} = "external"\n`);
      const externalPath = join(root, `${role}.external`);
      let displaced = false;
      const capturedRecords: ArtifactPairRecoveryRecord[] = [];
      const resuming = Object.freeze({
        ...base,
        recovery: Object.freeze({
          ...base.recovery,
          replace: async (record: ArtifactPairRecoveryRecord, expectedRevision: string) => {
            if (
              record.disposition === 'rollback' &&
              record.rollbackTarget[role]?.state === 'file'
            ) {
              capturedRecords.push(record);
            }
            return base.recovery.replace(record, expectedRevision);
          },
        }),
        moveIntoOwnedTransaction: async (source: string, destination: string) => {
          if (!displaced && source === path && destination.endsWith(`${role}.backup`)) {
            displaced = true;
            await writeFile(externalPath, external);
            await rename(externalPath, source);
          }
          return base.moveIntoOwnedTransaction(source, destination);
        },
      });

      const resumed = await recoverArtifactPair(
        resuming,
        pairFor(manifestPath, lockPath),
        'resume',
      );

      expect(displaced, role).toBeTrue();
      expect(resumed, role).toMatchObject({
        ok: false,
        error: { reason: 'external-writer-conflict' },
      });
      const captured = capturedRecords.at(-1);
      if (captured === undefined) throw new Error(`displaced ${role} was not durably captured`);
      const target = captured.rollbackTarget[role];
      const backup = captured.objects.find(
        (object) => object.role === role && object.slot === 'backup',
      );
      expect(target, role).toMatchObject({ state: 'file' });
      if (target?.state !== 'file') throw new Error(`missing ${role} rollback target`);
      expect(target.identity, role).not.toBe(originalObservation.identity);
      expect(backup, role).toMatchObject({
        expectedDigest: target.digest,
        expectedMode: target.mode,
        identity: target.identity,
      });
      expect(new Uint8Array(await readFile(path)), role).toEqual(external);
      expect(original, role).not.toEqual(external);
      expect(await base.recovery.discover(), role).toEqual([]);
      expect(
        (await readdir(root)).filter((name) => name.startsWith('.skillsmith-artifact-')),
        role,
      ).toEqual([]);
    }
  });

  test('initial lock backup opaquely captures and restores a malformed displaced writer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-coordinator-initial-lock-writer-'));
    roots.push(root);
    const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const manifestPath = join(root, 'skillsmith.toml');
    const lockPath = join(root, 'skillsmith.lock');
    const source = 'version = 1\nskills = []\n';
    const document = readManifestSource(source);
    if (!document.ok) throw new Error('fixture manifest invalid');
    const manifest = normalizeManifestDocument(document.value);
    if (!manifest.ok) throw new Error('fixture manifest invalid');
    const serialized = serializePortableLock(
      Object.freeze({
        version: 1,
        hashSchemaVersion: 1,
        manifestHash: hashManifestSemantics(manifest.value),
        skills: Object.freeze([]),
      }),
    );
    if (!serialized.ok) throw new Error('fixture lock invalid');
    await writeFile(manifestPath, source);
    await writeFile(lockPath, serialized.value);
    const malformed = new TextEncoder().encode('not a portable lock after initial guard\n');
    const externalPath = join(root, 'external.lock');
    let displaced = false;
    const capturedRecords: ArtifactPairRecoveryRecord[] = [];
    const ports = Object.freeze({
      ...base,
      recovery: Object.freeze({
        ...base.recovery,
        replace: async (record: ArtifactPairRecoveryRecord, expectedRevision: string) => {
          if (record.disposition === 'rollback' && record.rollbackTarget.lock?.state === 'file') {
            capturedRecords.push(record);
          }
          return base.recovery.replace(record, expectedRevision);
        },
      }),
      moveIntoOwnedTransaction: async (live: string, owned: string) => {
        if (!displaced && live === lockPath && owned.endsWith('lock.backup')) {
          displaced = true;
          await writeFile(externalPath, malformed);
          await rename(externalPath, live);
        }
        return base.moveIntoOwnedTransaction(live, owned);
      },
    });

    const result = await commitArtifactPair(ports, {
      pair: pairFor(manifestPath, lockPath),
      manifest: { kind: 'keep' },
      lock: { kind: 'remove' },
    });

    expect(displaced).toBeTrue();
    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'external-writer-conflict' },
    });
    const captured = capturedRecords.at(-1);
    if (captured === undefined || captured.rollbackTarget.lock?.state !== 'file') {
      throw new Error('malformed lock backup was not durably captured');
    }
    const backup = captured.objects.find(
      (object) => object.role === 'lock' && object.slot === 'backup',
    );
    expect(backup).toMatchObject({
      expectedDigest: captured.rollbackTarget.lock.digest,
      expectedMode: captured.rollbackTarget.lock.mode,
      identity: captured.rollbackTarget.lock.identity,
    });
    expect(new Uint8Array(await readFile(lockPath))).toEqual(malformed);
    expect(new TextDecoder().decode(await readFile(manifestPath))).toBe(source);
    expect(await base.recovery.discover()).toEqual([]);
    expect(
      (await readdir(root)).filter((name) => name.startsWith('.skillsmith-artifact-')),
    ).toEqual([]);
  });

  test('durably captures and restores a writer displaced by the rollback remove move', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-coordinator-rollback-external-'));
    roots.push(root);
    const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const path = join(root, 'config.toml');
    const externalPath = join(root, 'external.toml');
    const external = new TextEncoder().encode('tool = "external"\n');
    let forceRollback = false;
    let displaced = false;
    const ports = Object.freeze({
      ...base,
      moveIntoOwnedTransaction: async (source: string, destination: string) => {
        if (
          forceRollback &&
          !displaced &&
          source === path &&
          destination.endsWith('manifest.discard')
        ) {
          displaced = true;
          await writeFile(externalPath, external);
          await rename(externalPath, source);
        }
        return base.moveIntoOwnedTransaction(source, destination);
      },
      afterBarrier: async (barrier: ArtifactPairBarrier) => {
        if (
          !forceRollback &&
          barrier.kind === 'record-durable' &&
          barrier.cursor === 'pair-verify'
        ) {
          forceRollback = true;
          throw new Error('force rollback after install');
        }
      },
    });

    const result = await updateCoordinatedHumanFile(ports, {
      path,
      edit: () =>
        ok({ bytes: new TextEncoder().encode('tool = "codex"\n'), changed: true, mode: 0o600 }),
    });

    expect(displaced).toBeTrue();
    expect(result).toMatchObject({ ok: false, error: { reason: 'external-writer-conflict' } });
    expect(new Uint8Array(await readFile(path))).toEqual(external);
    expect(await base.recovery.discover()).toEqual([]);
    expect(
      (await readdir(root)).filter((name) => name.startsWith('.skillsmith-artifact-')),
    ).toEqual([]);
  });

  test('rollback lock discard opaquely captures and restores a malformed displaced writer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-coordinator-rollback-lock-writer-'));
    roots.push(root);
    const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const manifestPath = join(root, 'skillsmith.toml');
    const lockPath = join(root, 'skillsmith.lock');
    const source = 'version = 1\nskills = []\n';
    const document = readManifestSource(source);
    if (!document.ok) throw new Error('fixture manifest invalid');
    const manifest = normalizeManifestDocument(document.value);
    if (!manifest.ok) throw new Error('fixture manifest invalid');
    const lock = Object.freeze({
      version: 1 as const,
      hashSchemaVersion: 1 as const,
      manifestHash: hashManifestSemantics(manifest.value),
      skills: Object.freeze([]),
    });
    await writeFile(manifestPath, source);
    const malformed = new TextEncoder().encode('rollback captured malformed lock\n');
    const externalPath = join(root, 'rollback-external.lock');
    let forceRollback = false;
    let displaced = false;
    const capturedRecords: ArtifactPairRecoveryRecord[] = [];
    const ports = Object.freeze({
      ...base,
      recovery: Object.freeze({
        ...base.recovery,
        replace: async (record: ArtifactPairRecoveryRecord, expectedRevision: string) => {
          if (
            record.disposition === 'rollback' &&
            record.rollbackTarget.lock?.state === 'file' &&
            record.objects.some((object) => object.role === 'lock' && object.slot === 'discard')
          ) {
            capturedRecords.push(record);
          }
          return base.recovery.replace(record, expectedRevision);
        },
      }),
      moveIntoOwnedTransaction: async (live: string, owned: string) => {
        if (forceRollback && !displaced && live === lockPath && owned.endsWith('lock.discard')) {
          displaced = true;
          await writeFile(externalPath, malformed);
          await rename(externalPath, live);
        }
        return base.moveIntoOwnedTransaction(live, owned);
      },
      afterBarrier: async (barrier: ArtifactPairBarrier) => {
        if (
          !forceRollback &&
          barrier.kind === 'record-durable' &&
          barrier.cursor === 'pair-verify'
        ) {
          forceRollback = true;
          throw new Error('force rollback after lock install');
        }
      },
    });

    const result = await commitArtifactPair(ports, {
      pair: pairFor(manifestPath, lockPath),
      manifest: { kind: 'keep' },
      lock: { kind: 'replace', lock },
    });

    expect(forceRollback).toBeTrue();
    expect(displaced).toBeTrue();
    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'external-writer-conflict' },
    });
    const captured = capturedRecords.at(-1);
    if (captured === undefined || captured.rollbackTarget.lock?.state !== 'file') {
      throw new Error('malformed lock discard was not durably captured');
    }
    const discard = captured.objects.find(
      (object) => object.role === 'lock' && object.slot === 'discard',
    );
    expect(discard).toMatchObject({
      expectedDigest: captured.rollbackTarget.lock.digest,
      expectedMode: captured.rollbackTarget.lock.mode,
      identity: captured.rollbackTarget.lock.identity,
    });
    expect(new Uint8Array(await readFile(lockPath))).toEqual(malformed);
    expect(new TextDecoder().decode(await readFile(manifestPath))).toBe(source);
    expect(await base.recovery.discover()).toEqual([]);
    expect(
      (await readdir(root)).filter((name) => name.startsWith('.skillsmith-artifact-')),
    ).toEqual([]);
  });

  test('recovery permission denial outranks the external-writer conflict that triggered it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-coordinator-recovery-permission-'));
    roots.push(root);
    const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const path = join(root, 'config.toml');
    const original = new TextEncoder().encode('tool = "codex"\n');
    const external = new TextEncoder().encode('tool = "external"\n');
    await writeFile(path, original);
    let displaced = false;
    const ports = Object.freeze({
      ...base,
      recovery: Object.freeze({
        ...base.recovery,
        discover: async () => {
          if (displaced) throw Object.assign(new Error('denied'), { code: 'EACCES' });
          return base.recovery.discover();
        },
      }),
      moveIntoOwnedTransaction: async (source: string, destination: string) => {
        if (!displaced && source === path && destination.endsWith('manifest.backup')) {
          displaced = true;
          await writeFile(source, external);
        }
        return base.moveIntoOwnedTransaction(source, destination);
      },
    });

    const result = await updateCoordinatedHumanFile(ports, {
      path,
      edit: () =>
        ok({ bytes: new TextEncoder().encode('tool = "opencode"\n'), changed: true, mode: 0o600 }),
    });

    expect(displaced).toBeTrue();
    expect(result).toMatchObject({ ok: false, error: { reason: 'permission-denied' } });
    expect((await base.recovery.discover()).length).toBe(1);
  });

  test('preserves an external file that wins immediately before no-replace install', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-coordinator-install-winner-'));
    roots.push(root);
    const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const path = join(root, 'config.toml');
    const external = new TextEncoder().encode('tool = "external"\n');
    let injected = false;
    let movedLive = 0;
    const ports = Object.freeze({
      ...base,
      linkFileNoReplace: async (source: string, destination: string) => {
        if (!injected && destination === path) {
          injected = true;
          await writeFile(destination, external);
        }
        return base.linkFileNoReplace(source, destination);
      },
      moveIntoOwnedTransaction: async (source: string, destination: string) => {
        if (source === path) movedLive += 1;
        return base.moveIntoOwnedTransaction(source, destination);
      },
    });

    const result = await updateCoordinatedHumanFile(ports, {
      path,
      edit: () =>
        ok({ bytes: new TextEncoder().encode('tool = "codex"\n'), changed: true, mode: 0o600 }),
    });

    expect(result).toMatchObject({ ok: false, error: { reason: 'external-writer-conflict' } });
    expect(new Uint8Array(await readFile(path))).toEqual(external);
    expect(movedLive).toBe(0);
    expect((await base.recovery.discover()).length).toBe(1);
  });

  test('adopts a marker-proven directory when creation returned before identity CAS', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-coordinator-adopt-'));
    roots.push(root);
    const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const path = join(root, 'config.toml');
    let injected = false;
    const ports = Object.freeze({
      ...base,
      afterBarrier: async (barrier: ArtifactPairBarrier) => {
        if (
          !injected &&
          barrier.kind === 'mutation-returned' &&
          barrier.operation === 'create-transaction-directory'
        ) {
          injected = true;
          throw new Error('returned before identity CAS');
        }
      },
    });
    const result = await updateCoordinatedHumanFile(ports, {
      path,
      edit: () =>
        ok({ bytes: new TextEncoder().encode('tool = "codex"\n'), changed: true, mode: 0o600 }),
    });
    expect(result).toMatchObject({ ok: false, error: { reason: 'filesystem-failure' } });
    expect((await base.observe(path)).kind).toBe('absent');
    expect(await base.recovery.discover()).toEqual([]);
    expect(
      (await readdir(root)).filter((name) => name.startsWith('.skillsmith-artifact-')),
    ).toEqual([]);
  });

  test('recovers the stage/live two-link gap after no-replace link returns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-coordinator-two-link-'));
    roots.push(root);
    const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const path = join(root, 'config.toml');
    let injected = false;
    const ports = Object.freeze({
      ...base,
      afterBarrier: async (barrier: ArtifactPairBarrier) => {
        if (
          !injected &&
          barrier.kind === 'mutation-returned' &&
          barrier.operation === 'link-file-no-replace'
        ) {
          injected = true;
          throw new Error('link returned before stage unlink');
        }
      },
    });
    const result = await updateCoordinatedHumanFile(ports, {
      path,
      edit: () =>
        ok({ bytes: new TextEncoder().encode('tool = "codex"\n'), changed: true, mode: 0o600 }),
    });
    expect(result).toMatchObject({ ok: false, error: { reason: 'filesystem-failure' } });
    expect((await base.observe(path)).kind).toBe('absent');
    expect(await base.recovery.discover()).toEqual([]);
    expect(
      (await readdir(root)).filter((name) => name.startsWith('.skillsmith-artifact-')),
    ).toEqual([]);
  });

  test('resumes the frozen forward state machine from a durable install two-link gap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-coordinator-resume-'));
    roots.push(root);
    const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const manifestPath = join(root, 'skillsmith.toml');
    const lockPath = join(root, 'skillsmith.lock');
    const pair = pairFor(manifestPath, lockPath);
    const source = 'version = 1\nskills = []\n';
    const document = readManifestSource(source);
    if (!document.ok) throw new Error('fixture manifest invalid');
    const manifest = normalizeManifestDocument(document.value);
    if (!manifest.ok) throw new Error('fixture manifest invalid');
    let crashed = false;
    let blockCatchRecovery = false;
    const ports = Object.freeze({
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
          !crashed &&
          barrier.kind === 'mutation-returned' &&
          barrier.operation === 'link-file-no-replace' &&
          barrier.role === 'lock'
        ) {
          crashed = true;
          blockCatchRecovery = true;
          throw new Error('hard crash after link');
        }
      },
    });
    const interrupted = await commitArtifactPair(ports, {
      pair,
      manifest: { kind: 'replace', bytes: new TextEncoder().encode(source) },
      lock: {
        kind: 'replace',
        lock: Object.freeze({
          version: 1,
          hashSchemaVersion: 1,
          manifestHash: hashManifestSemantics(manifest.value),
          skills: Object.freeze([]),
        }),
      },
    });
    expect(interrupted.ok).toBeFalse();
    blockCatchRecovery = false;

    const resumed = await recoverArtifactPair(base, pair, 'resume');
    expect(resumed).toEqual({ ok: true, value: 'finalized' });
    expect((await base.observe(manifestPath)).kind).toBe('file');
    expect((await base.observe(lockPath)).kind).toBe('file');
    expect(await base.recovery.discover()).toEqual([]);
  });

  test('explicit resume at prepared preserves the record without provisioning', async () => {
    const fixture = await interruptedHumanRecovery('prepared');

    const resumed = await recoverArtifactPair(fixture.base, fixture.pair, 'resume');

    expect(resumed).toMatchObject({ ok: false, error: { reason: 'recovery-conflict' } });
    expect((await fixture.base.observe(fixture.directory.path)).kind).toBe('absent');
    expect(await fixture.base.recovery.discover()).toEqual([fixture.pending]);
  });

  test('explicit resume at staging preserves absent, partial, and wrong candidates', async () => {
    for (const scenario of ['absent', 'partial', 'wrong'] as const) {
      const fixture = await interruptedHumanRecovery('staging');
      if (scenario === 'partial') {
        await fixture.base.writeBytesExclusive(
          fixture.stage.path,
          fixture.desired.slice(0, 4),
          fixture.stage.expectedMode,
        );
      }
      if (scenario === 'wrong') {
        await fixture.base.writeBytesExclusive(
          fixture.stage.path,
          new TextEncoder().encode('tool = "other"\n'),
          fixture.stage.expectedMode,
        );
      }

      const resumed = await recoverArtifactPair(fixture.base, fixture.pair, 'resume');

      expect(resumed, scenario).toMatchObject({
        ok: false,
        error: { reason: 'recovery-conflict' },
      });
      expect((await fixture.base.observe(fixture.stage.path)).kind, scenario).toBe(
        scenario === 'absent' ? 'absent' : 'file',
      );
      expect((await fixture.base.recovery.discover()).length, scenario).toBe(1);
    }
  });

  test('explicit resume adopts an exact staged candidate and finishes its mode', async () => {
    const fixture = await interruptedHumanRecovery('staging');
    await fixture.base.writeBytesExclusive(fixture.stage.path, fixture.desired, 0o640);
    await fixture.base.fsyncFile(fixture.stage.path);

    const resumed = await recoverArtifactPair(fixture.base, fixture.pair, 'resume');

    expect(resumed).toEqual({ ok: true, value: 'finalized' });
    const live = await fixture.base.observe(fixture.path);
    expect(live.kind).toBe('file');
    expect(live.mode).toBe(0o600);
    expect(new Uint8Array(await readFile(fixture.path))).toEqual(fixture.desired);
    expect(await fixture.base.recovery.discover()).toEqual([]);
  });

  test('explicit rollback removes a marker-proven staging partial and restores before', async () => {
    const fixture = await interruptedHumanRecovery('staging');
    await fixture.base.writeBytesExclusive(
      fixture.stage.path,
      fixture.desired.slice(0, 4),
      fixture.stage.expectedMode,
    );

    const rolledBack = await recoverArtifactPair(fixture.base, fixture.pair, 'rollback');

    expect(rolledBack).toEqual({ ok: true, value: 'rolled-back' });
    expect((await fixture.base.observe(fixture.path)).kind).toBe('absent');
    expect((await fixture.base.observe(fixture.directory.path)).kind).toBe('absent');
    expect(await fixture.base.recovery.discover()).toEqual([]);
  });

  test('automatic read recovery removes a marker-proven staging partial', async () => {
    const fixture = await interruptedHumanRecovery('staging');
    await fixture.base.writeBytesExclusive(
      fixture.stage.path,
      fixture.desired.slice(0, 4),
      fixture.stage.expectedMode,
    );

    const recovered = await readCoordinatedArtifactPair(fixture.base, fixture.pair);

    expect(recovered.ok).toBeTrue();
    if (recovered.ok) {
      expect(recovered.value.manifest.state).toBe('absent');
      expect(recovered.value.lock.state).toBe('absent');
    }
    expect(await fixture.base.recovery.discover()).toEqual([]);
  });

  test('refuses parent retargeting even when the new parent hard-links the exact installed inode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-coordinator-parent-retarget-'));
    roots.push(root);
    const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const manifestParent = join(root, 'manifest');
    const lockParent = join(root, 'lock');
    const displacedParent = join(root, 'lock-old');
    await mkdir(manifestParent);
    await mkdir(lockParent);
    const manifestPath = join(manifestParent, 'skillsmith.toml');
    const lockPath = join(lockParent, 'skillsmith.lock');
    const pair = pairFor(manifestPath, lockPath);
    const source = 'version = 1\nskills = []\n';
    const document = readManifestSource(source);
    if (!document.ok) throw new Error('fixture manifest invalid');
    const manifest = normalizeManifestDocument(document.value);
    if (!manifest.ok) throw new Error('fixture manifest invalid');
    let retargeted = false;
    const ports = Object.freeze({
      ...base,
      afterBarrier: async (barrier: ArtifactPairBarrier) => {
        if (
          !retargeted &&
          barrier.kind === 'object-verified' &&
          barrier.cursor === 'lock-install' &&
          barrier.role === 'lock'
        ) {
          retargeted = true;
          await rename(lockParent, displacedParent);
          await mkdir(lockParent);
          await link(join(displacedParent, 'skillsmith.lock'), lockPath);
        }
      },
    });
    const result = await commitArtifactPair(ports, {
      pair,
      manifest: { kind: 'replace', bytes: new TextEncoder().encode(source) },
      lock: {
        kind: 'replace',
        lock: Object.freeze({
          version: 1,
          hashSchemaVersion: 1,
          manifestHash: hashManifestSemantics(manifest.value),
          skills: Object.freeze([]),
        }),
      },
    });

    expect(result).toMatchObject({ ok: false, error: { reason: 'recovery-conflict' } });
    expect((await base.observe(lockPath)).kind).toBe('file');
    expect((await base.recovery.discover()).length).toBe(1);
  });

  test('finalizes cleanup when the transaction directory is already absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-coordinator-cleanup-gap-'));
    roots.push(root);
    const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const path = join(root, 'config.toml');
    let injected = false;
    const ports = Object.freeze({
      ...base,
      afterBarrier: async (barrier: ArtifactPairBarrier) => {
        if (
          !injected &&
          barrier.kind === 'mutation-returned' &&
          barrier.operation === 'remove-directory' &&
          barrier.cursor === 'cleanup'
        ) {
          injected = true;
          throw new Error('directory removed before cleanup record advanced');
        }
      },
    });
    const result = await updateCoordinatedHumanFile(ports, {
      path,
      edit: () =>
        ok({ bytes: new TextEncoder().encode('tool = "codex"\n'), changed: true, mode: 0o600 }),
    });
    expect(result).toMatchObject({ ok: false, error: { reason: 'filesystem-failure' } });
    expect((await base.observe(path)).kind).toBe('file');
    expect(await base.recovery.discover()).toEqual([]);
    expect(
      (await readdir(root)).filter((name) => name.startsWith('.skillsmith-artifact-')),
    ).toEqual([]);
  });

  test('preserves permission failure and committed recovery intent when cleanup stays denied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-coordinator-cleanup-permission-'));
    roots.push(root);
    const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const path = join(root, 'config.toml');
    const ports = Object.freeze({
      ...base,
      removeEmptyDirectory: async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      },
    });
    const result = await updateCoordinatedHumanFile(ports, {
      path,
      edit: () =>
        ok({ bytes: new TextEncoder().encode('tool = "codex"\n'), changed: true, mode: 0o600 }),
    });

    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'permission-denied', exitCode: 6 },
    });
    expect((await base.observe(path)).kind).toBe('file');
    expect(await base.recovery.discover()).toMatchObject([
      { record: { disposition: 'forward', cursor: 'cleanup' } },
    ]);
  });

  test('reports after-state cancellation after finishing cleanup from a cleanup mutation barrier', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-coordinator-cleanup-cancel-'));
    roots.push(root);
    const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const path = join(root, 'config.toml');
    const controller = new AbortController();
    const ports = Object.freeze({
      ...base,
      afterBarrier: async (barrier: ArtifactPairBarrier) => {
        if (
          barrier.kind === 'mutation-returned' &&
          barrier.cursor === 'cleanup' &&
          barrier.operation === 'remove-directory'
        ) {
          controller.abort();
        }
      },
    });
    const result = await updateCoordinatedHumanFile(ports, {
      path,
      signal: controller.signal,
      edit: () =>
        ok({ bytes: new TextEncoder().encode('tool = "codex"\n'), changed: true, mode: 0o600 }),
    });

    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'cancelled', exitCode: 130, durableState: 'after' },
    });
    expect((await base.observe(path)).kind).toBe('file');
    expect(await base.recovery.discover()).toEqual([]);
    expect(
      (await readdir(root)).filter((name) => name.startsWith('.skillsmith-artifact-')),
    ).toEqual([]);
  });

  test('persists every rollback write-ahead cursor before cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-coordinator-rollback-cursors-'));
    roots.push(root);
    const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const path = join(root, 'config.toml');
    const cursors: string[] = [];
    let failed = false;
    const ports = Object.freeze({
      ...base,
      fsyncFile: async (target: string) => {
        if (!failed && target.endsWith('.stage')) {
          failed = true;
          throw new Error('stage fsync fault');
        }
        return base.fsyncFile(target);
      },
      afterBarrier: async (barrier: ArtifactPairBarrier) => {
        if (
          barrier.kind === 'record-durable' &&
          (barrier.cursor.startsWith('rollback-') || barrier.cursor === 'cleanup')
        ) {
          cursors.push(barrier.cursor);
        }
      },
    });
    const result = await updateCoordinatedHumanFile(ports, {
      path,
      edit: () =>
        ok({ bytes: new TextEncoder().encode('tool = "codex"\n'), changed: true, mode: 0o600 }),
    });

    expect(result).toMatchObject({ ok: false, error: { reason: 'filesystem-failure' } });
    expect(cursors).toEqual([
      'rollback-manifest-remove',
      'rollback-manifest-restore',
      'rollback-lock-remove',
      'rollback-lock-restore',
      'rollback-verify',
      'cleanup',
    ]);
    expect(await base.recovery.discover()).toEqual([]);
  });

  test('preserves an unproven wrong stage when rollback sees a null recorded identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-coordinator-wrong-stage-'));
    roots.push(root);
    const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const path = join(root, 'config.toml');
    let crashed = false;
    const ports = Object.freeze({
      ...base,
      afterBarrier: async (barrier: ArtifactPairBarrier) => {
        if (!crashed && barrier.kind === 'record-durable' && barrier.cursor === 'prepared') {
          crashed = true;
          throw new Error('hard crash after prepared record');
        }
      },
    });
    const interrupted = await updateCoordinatedHumanFile(ports, {
      path,
      edit: () =>
        ok({ bytes: new TextEncoder().encode('tool = "codex"\n'), changed: true, mode: 0o600 }),
    });
    expect(interrupted.ok).toBeFalse();
    const [pending] = await base.recovery.discover();
    if (pending === undefined) throw new Error('missing prepared recovery fixture');
    const [directory] = pending.record.directories;
    const stage = pending.record.objects.find((object) => object.slot === 'stage');
    if (directory === undefined || stage === undefined) throw new Error('invalid recovery fixture');
    await base.createTransactionDirectoryExclusive(directory.path, directory.ownershipToken);
    const wrong = new TextEncoder().encode('wrong-but-unproven\n');
    await base.writeBytesExclusive(stage.path, wrong, stage.expectedMode);
    await base.fsyncFile(stage.path);

    const retried = await updateCoordinatedHumanFile(base, {
      path,
      edit: () => ok({ bytes: new Uint8Array(), changed: false, mode: 0o600 }),
    });
    expect(retried).toMatchObject({ ok: false, error: { reason: 'recovery-conflict' } });
    expect(new Uint8Array(await readFile(stage.path))).toEqual(wrong);
    expect((await base.recovery.discover()).length).toBe(1);
  });

  test('consumes member-lock acquisition rejection without an unhandled promise', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-coordinator-lock-rejection-'));
    roots.push(root);
    const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const pair = pairFor(join(root, 'skillsmith.toml'), join(root, 'skillsmith.lock'));
    const unhandled: unknown[] = [];
    const listener = (error: unknown) => unhandled.push(error);
    process.on('unhandledRejection', listener);
    try {
      const ports = Object.freeze({
        ...base,
        withFileLock: async <T>(
          target: string,
          options: Parameters<typeof base.withFileLock<T>>[1],
          operation: () => Promise<T>,
        ): Promise<T> => {
          if (options.policy === 'compatibility') {
            throw Object.assign(new Error('denied'), { code: 'EACCES' });
          }
          return base.withFileLock(target, options, operation);
        },
      });
      const result = await readCoordinatedArtifactPair(ports, pair);
      expect(result).toMatchObject({ ok: false, error: { reason: 'permission-denied' } });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  test('restores exact 0600, 0640, and 0644 modes after install permission failure', async () => {
    for (const mode of [0o600, 0o640, 0o644]) {
      const root = await mkdtemp(join(tmpdir(), `skillsmith-coordinator-mode-${mode}-`));
      roots.push(root);
      const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
      const path = join(root, 'config.toml');
      const before = new TextEncoder().encode('tool = "before"\n');
      await writeFile(path, before, { mode });
      await chmod(path, mode);
      let failed = false;
      const ports = Object.freeze({
        ...base,
        linkFileNoReplace: async (source: string, destination: string) => {
          if (!failed) {
            failed = true;
            throw Object.assign(new Error('denied'), { code: 'EACCES' });
          }
          return base.linkFileNoReplace(source, destination);
        },
      });
      const result = await updateCoordinatedHumanFile(ports, {
        path,
        edit: () =>
          ok({ bytes: new TextEncoder().encode('tool = "after"\n'), changed: true, mode }),
      });
      expect(result).toMatchObject({ ok: false, error: { reason: 'permission-denied' } });
      expect(new Uint8Array(await readFile(path))).toEqual(before);
      expect((await base.observe(path)).mode).toBe(mode);
      expect(await base.recovery.discover()).toEqual([]);
    }
  });

  test('preserves returned EACCES and EPERM observations instead of masking them as conflicts', async () => {
    for (const code of ['EACCES', 'EPERM'] as const) {
      const root = await mkdtemp(join(tmpdir(), `skillsmith-coordinator-observe-${code}-`));
      roots.push(root);
      const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
      const path = join(root, 'config.toml');
      const before = new TextEncoder().encode('tool = "before"\n');
      await writeFile(path, before, { mode: 0o600 });
      let denied = false;
      const ports = Object.freeze({
        ...base,
        readBytes: async (target: string) => {
          if (!denied && target.endsWith('manifest.backup')) {
            denied = true;
            throw Object.assign(new Error('denied'), { code });
          }
          return base.readBytes(target);
        },
      });

      const result = await updateCoordinatedHumanFile(ports, {
        path,
        edit: () =>
          ok({ bytes: new TextEncoder().encode('tool = "after"\n'), changed: true, mode: 0o600 }),
      });

      expect(denied).toBeTrue();
      expect(result).toMatchObject({
        ok: false,
        error: { reason: 'permission-denied', exitCode: 6 },
      });
      expect(new Uint8Array(await readFile(path))).toEqual(before);
      expect(await base.recovery.discover()).toEqual([]);
    }
  });

  test('preserves the original EACCES and EPERM when non-permission recovery also fails', async () => {
    for (const code of ['EACCES', 'EPERM'] as const) {
      const root = await mkdtemp(join(tmpdir(), `skillsmith-coordinator-precedence-${code}-`));
      roots.push(root);
      const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
      const path = join(root, 'config.toml');
      await writeFile(path, 'tool = "before"\n', { mode: 0o600 });
      let backupMoved = false;
      let denied = false;
      let blockRecovery = false;
      const ports = Object.freeze({
        ...base,
        recovery: Object.freeze({
          ...base.recovery,
          discover: async () => {
            if (blockRecovery) throw new Error('recovery unavailable');
            return base.recovery.discover();
          },
        }),
        moveIntoOwnedTransaction: async (source: string, destination: string) => {
          const moved = await base.moveIntoOwnedTransaction(source, destination);
          if (destination.endsWith('manifest.backup')) backupMoved = true;
          return moved;
        },
        fsyncDirectory: async (target: string) => {
          if (backupMoved && !denied) {
            denied = true;
            blockRecovery = true;
            throw Object.assign(new Error('denied'), { code });
          }
          return base.fsyncDirectory(target);
        },
      });

      const result = await updateCoordinatedHumanFile(ports, {
        path,
        edit: () =>
          ok({ bytes: new TextEncoder().encode('tool = "after"\n'), changed: true, mode: 0o600 }),
      });
      blockRecovery = false;

      expect(denied).toBeTrue();
      expect(result).toMatchObject({
        ok: false,
        error: { reason: 'permission-denied', exitCode: 6 },
      });
      expect((await base.recovery.discover()).length).toBe(1);
    }
  });

  test('settles every public Result API without invoking thrown accessors or Proxy handlers', async () => {
    for (const hostileKind of ['accessor', 'proxy'] as const) {
      const root = await mkdtemp(join(tmpdir(), `skillsmith-coordinator-hostile-${hostileKind}-`));
      roots.push(root);
      const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
      const path = join(root, 'config.toml');
      const pair = pairFor(path, join(root, 'skillsmith.lock'));
      let interactions = 0;
      const hostile =
        hostileKind === 'accessor'
          ? (() => {
              const value = Object.create(null) as Record<string, unknown>;
              Object.defineProperty(value, 'code', {
                get: () => {
                  interactions += 1;
                  return 'EACCES';
                },
              });
              return value;
            })()
          : new Proxy(Object.create(null) as Record<string, unknown>, {
              get: () => {
                interactions += 1;
                return 'EACCES';
              },
              getOwnPropertyDescriptor: () => {
                interactions += 1;
                return undefined;
              },
              getPrototypeOf: () => {
                interactions += 1;
                return null;
              },
              has: () => {
                interactions += 1;
                return true;
              },
              ownKeys: () => {
                interactions += 1;
                return ['code'];
              },
            });
      const ports: ArtifactCoordinatorPorts = Object.freeze({
        ...base,
        withFileLock: async () => {
          throw hostile;
        },
      });
      const invoke = [
        () =>
          commitArtifactPair(ports, {
            pair,
            manifest: { kind: 'replace', bytes: new TextEncoder().encode('version = 1\n') },
            lock: { kind: 'remove' },
          }),
        () => readCoordinatedArtifactPair(ports, pair),
        () => recoverArtifactPair(ports, pair, 'rollback'),
        () =>
          updateCoordinatedHumanFile(ports, {
            path,
            edit: () => ok({ bytes: new Uint8Array(), changed: false, mode: 0o600 }),
          }),
      ] as const;

      for (const call of invoke) {
        const result = await call();
        expect(result).toMatchObject({
          ok: false,
          error: { reason: 'filesystem-failure', exitCode: 3 },
        });
        if (!result.ok) expect(Object.isFrozen(result.error)).toBeTrue();
      }
      expect(interactions).toBe(0);
    }
  });

  test('rejects arbitrary nextId values without handler or coercion access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-coordinator-hostile-id-'));
    roots.push(root);
    const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const pair = pairFor(join(root, 'config.toml'), join(root, 'skillsmith.lock'));
    let interactions = 0;
    const hostileId = new Proxy(Object.create(null) as Record<string, unknown>, {
      get: () => {
        interactions += 1;
        return () => '0000000000000001';
      },
      getOwnPropertyDescriptor: () => {
        interactions += 1;
        return undefined;
      },
      getPrototypeOf: () => {
        interactions += 1;
        return null;
      },
      has: () => {
        interactions += 1;
        return true;
      },
      ownKeys: () => {
        interactions += 1;
        return [];
      },
    });
    const ports: ArtifactCoordinatorPorts = Object.freeze({
      ...base,
      nextId: () => hostileId as unknown as string,
    });

    const result = await readCoordinatedArtifactPair(ports, pair);

    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'filesystem-failure', exitCode: 3 },
    });
    expect(interactions).toBe(0);
  });
});
