import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashManifestSemantics } from '../../src/artifacts/hash.ts';
import { fromLedgerV1Dto, ledgerV1Codec } from '../../src/artifacts/ledger-codec.ts';
import { type PortableLockV1, serializePortableLock } from '../../src/artifacts/lock.ts';
import { normalizeManifestDocument, readManifestSource } from '../../src/artifacts/manifest.ts';
import type { ResolvedArtifactPair } from '../../src/artifacts/pair.ts';
import type { ProjectContext } from '../../src/context/types.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';
import { observePlanArtifacts } from '../../src/reconcile/observe.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillsmith-plan-observe-'));
  roots.push(root);
  const file = join(root, 'skillsmith.toml');
  const lockfile = join(root, 'skillsmith.lock');
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
    file: { token: null, path: file, portability: 'machine-bound', portableToken: null },
    lockfile: {
      token: null,
      path: lockfile,
      portability: 'machine-bound',
      portableToken: null,
    },
    lockfileSource: 'sibling',
  };
  return { root, file, lockfile, project, pair, ports: await defaultRuntimePorts() };
};

const emptyArtifacts = () => {
  const source = 'version = 1\n';
  const document = readManifestSource(source);
  if (!document.ok) throw new Error(document.error.message);
  const normalized = normalizeManifestDocument(document.value);
  if (!normalized.ok) throw new Error(normalized.error.message);
  const lock: PortableLockV1 = {
    version: 1,
    hashSchemaVersion: 1,
    manifestHash: hashManifestSemantics(normalized.value),
    skills: [],
  };
  const encoded = serializePortableLock(lock);
  if (!encoded.ok) throw new Error(encoded.error.message);
  return { source, lock: encoded.value };
};

describe('plan artifact observation', () => {
  test('returns a current immutable manifest/lock relationship from canonical bytes', async () => {
    const state = await setup();
    const artifacts = emptyArtifacts();
    await writeFile(state.file, artifacts.source);
    await writeFile(state.lockfile, artifacts.lock);
    const observed = await observePlanArtifacts(state.ports, state.project, state.pair);
    expect(observed.ok).toBeTrue();
    if (!observed.ok) throw new Error(observed.error.message);
    expect(observed.value.relationship).toEqual({ state: 'current' });
    expect(observed.value.manifest).toMatchObject({
      state: 'present',
      artifact: 'manifest',
      canonical: true,
    });
    expect(observed.value.lock).toMatchObject({ state: 'present', artifact: 'lock' });
    expect(Object.isFrozen(observed.value)).toBeTrue();
  });

  test('classifies an absent lock without manufacturing persisted state', async () => {
    const state = await setup();
    await writeFile(state.file, emptyArtifacts().source);
    const observed = await observePlanArtifacts(state.ports, state.project, state.pair);
    expect(observed.ok).toBeTrue();
    if (!observed.ok) throw new Error(observed.error.message);
    expect(observed.value.lock).toEqual({ state: 'absent', artifact: 'lock', migration: null });
    expect(observed.value.relationship).toEqual({ state: 'missing-lock' });
  });

  test('observes a canonical v1 ledger and its pure migration description', async () => {
    const state = await setup();
    const artifacts = emptyArtifacts();
    await writeFile(state.file, artifacts.source);
    await writeFile(state.lockfile, artifacts.lock);
    const ledgerPath = join(state.root, 'placements.json');
    const model = fromLedgerV1Dto({
      schemaVersion: 1,
      kind: 'skillsmith.placements',
      updatedAt: '2026-07-19T00:00:00.000Z',
      skills: {},
    });
    expect(model.ok).toBeTrue();
    if (!model.ok) throw new Error(model.error.message);
    const encoded = ledgerV1Codec.encode(model.value);
    expect(encoded.ok).toBeTrue();
    if (!encoded.ok) throw new Error(encoded.error.message);
    await writeFile(ledgerPath, encoded.value);

    const observed = await observePlanArtifacts(state.ports, state.project, state.pair, {
      ledgerPath,
    });
    expect(observed.ok).toBeTrue();
    if (!observed.ok) throw new Error(observed.error.message);
    expect(observed.value.ledger).toMatchObject({
      state: 'present',
      sourceVersion: 1,
      migration: { kind: 'ledger-v1-to-v2', fromSchemaVersion: 1, toSchemaVersion: 2 },
    });
  });

  test('rejects absent desired state and noncanonical lock bytes as artifact state', async () => {
    const absent = await setup();
    const absentResult = await observePlanArtifacts(absent.ports, absent.project, absent.pair);
    expect(absentResult).toMatchObject({
      ok: false,
      error: { code: 'plan-manifest-absent', exitClass: 'state' },
    });

    const noncanonical = await setup();
    const artifacts = emptyArtifacts();
    await writeFile(noncanonical.file, artifacts.source);
    await writeFile(noncanonical.lockfile, `${artifacts.lock} `);
    const noncanonicalResult = await observePlanArtifacts(
      noncanonical.ports,
      noncanonical.project,
      noncanonical.pair,
    );
    expect(noncanonicalResult).toMatchObject({
      ok: false,
      error: { code: 'plan-noncanonical', exitClass: 'state' },
    });
  });
});
