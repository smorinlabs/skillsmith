import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ArtifactDigest, hashManifestSemantics } from '../../src/artifacts/hash.ts';
import { serializePortableLock } from '../../src/artifacts/lock.ts';
import { normalizeManifestDocument, readManifestSource } from '../../src/artifacts/manifest.ts';
import type { ProjectContext } from '../../src/context/types.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';
import type { RuntimePorts } from '../../src/ports/types.ts';
import { prepareUpdateArtifactsV1 } from '../../src/update/artifacts.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const MANIFEST = `${[
  'version = 1',
  '',
  '[[skills]]',
  'name = "review"',
  'source = "fixture.invalid/acme/skills//skills/review"',
  'ref = "main"',
  'tools = ["codex"]',
  'scope = "project"',
  'placement = "copy"',
  '',
].join('\n')}\n`;

const normalizedManifest = (source: string) => {
  const parsed = readManifestSource(source);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const normalized = normalizeManifestDocument(parsed.value);
  if (!normalized.ok) throw new Error(normalized.error.message);
  return normalized.value;
};

const lockFor = (manifestSource: string): string => {
  const lock = serializePortableLock({
    version: 1,
    hashSchemaVersion: 1,
    manifestHash: hashManifestSemantics(normalizedManifest(manifestSource)),
    skills: [
      {
        name: 'review',
        source: 'fixture.invalid/acme/skills//skills/review',
        requestedRef: 'main',
        resolvedSha: 'a'.repeat(40),
        sourcePath: 'skills/review',
        contentHash: `sha256:${'b'.repeat(64)}` as ArtifactDigest,
      },
    ],
  });
  if (!lock.ok) throw new Error(lock.error.message);
  return lock.value;
};

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillsmith-update-artifacts-'));
  roots.push(root);
  const projectRoot = join(root, 'project');
  const manifestPath = join(projectRoot, 'skillsmith.toml');
  const lockPath = join(projectRoot, 'skillsmith.lock');
  await mkdir(projectRoot, { recursive: true });
  const lock = lockFor(MANIFEST);
  await Promise.all([writeFile(manifestPath, MANIFEST), writeFile(lockPath, lock)]);
  const base = await defaultRuntimePorts();
  const ports: RuntimePorts = {
    ...base,
    homeDir: join(root, 'home'),
    xdg: {
      config: join(root, 'xdg', 'config'),
      data: join(root, 'xdg', 'data'),
      cache: join(root, 'xdg', 'cache'),
    },
  };
  const project: ProjectContext = {
    invocationCwd: projectRoot,
    effectiveCwd: projectRoot,
    projectRoot,
    projectIdentity: projectRoot,
    projectKind: 'git',
    discoveredConfigPath: manifestPath,
    explicitConfigPath: null,
  };
  return { root, projectRoot, manifestPath, lockPath, lock, ports, project };
};

describe('update artifact preparation', () => {
  test('selects, clones, parses, and correlates one discovered or explicit pair', async () => {
    const selected = await fixture();
    const discovered = await prepareUpdateArtifactsV1(selected.ports, selected.project, {
      file: null,
      lockfile: null,
    });
    expect(discovered).toMatchObject({
      ok: true,
      value: {
        selectionSource: 'discovered-project',
        pair: {
          file: { path: selected.manifestPath },
          lockfile: { path: selected.lockPath },
          lockfileSource: 'sibling',
        },
        manifest: { version: 1, skills: [{ name: 'review', ref: 'main' }] },
        lock: { version: 1, skills: [{ name: 'review', resolvedSha: 'a'.repeat(40) }] },
      },
    });
    if (!discovered.ok) return;
    const expectedManifest = new TextEncoder().encode(MANIFEST);
    const expectedLock = new TextEncoder().encode(selected.lock);
    expect(discovered.value.manifestBytes).toEqual(expectedManifest);
    expect(discovered.value.lockBytes).toEqual(expectedLock);
    expectedManifest.fill(0);
    expectedLock.fill(0);
    expect(new TextDecoder().decode(discovered.value.manifestBytes)).toBe(MANIFEST);
    expect(new TextDecoder().decode(discovered.value.lockBytes)).toBe(selected.lock);

    const explicit = await prepareUpdateArtifactsV1(selected.ports, selected.project, {
      file: './skillsmith.toml',
      lockfile: './skillsmith.lock',
    });
    expect(explicit).toMatchObject({
      ok: true,
      value: {
        selectionSource: 'explicit',
        pair: { lockfileSource: 'explicit' },
      },
    });
  });

  test('classifies invalid UTF-8, malformed models, incoherence, and read failures', async () => {
    const invalidUtf8 = await fixture();
    await writeFile(invalidUtf8.manifestPath, new Uint8Array([0xff]));
    expect(
      await prepareUpdateArtifactsV1(invalidUtf8.ports, invalidUtf8.project, {
        file: null,
        lockfile: null,
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'update-manifest-invalid', exitClass: 'state' }),
    });

    const malformedLock = await fixture();
    await writeFile(malformedLock.lockPath, 'version = nope\n');
    expect(
      await prepareUpdateArtifactsV1(malformedLock.ports, malformedLock.project, {
        file: null,
        lockfile: null,
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'update-lock-invalid', exitClass: 'state' }),
    });

    const incoherent = await fixture();
    await writeFile(incoherent.manifestPath, MANIFEST.replace('ref = "main"', 'ref = "next"'));
    expect(
      await prepareUpdateArtifactsV1(incoherent.ports, incoherent.project, {
        file: null,
        lockfile: null,
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'update-artifact-incoherent', exitClass: 'state' }),
    });

    const unreadable = await fixture();
    const ports: RuntimePorts = {
      ...unreadable.ports,
      readBytes: async () => {
        throw new Error('fixture read failure');
      },
    };
    expect(
      await prepareUpdateArtifactsV1(ports, unreadable.project, {
        file: null,
        lockfile: null,
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'update-artifact-unreadable', exitClass: 'state' }),
    });

    const denied = await fixture();
    const permission = Object.assign(new Error('fixture permission denial'), { code: 'EACCES' });
    expect(
      await prepareUpdateArtifactsV1(
        { ...denied.ports, readBytes: async () => Promise.reject(permission) },
        denied.project,
        { file: null, lockfile: null },
      ),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'update-artifact-permission',
        exitClass: 'permission',
      }),
    });
  });
});
