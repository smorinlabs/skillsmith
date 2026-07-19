import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestNodeArtifactCoordinatorPorts } from '../../src/artifacts/node-coordinator.ts';
import { type PlanWriterPorts, writeSavedPlan } from '../../src/artifacts/plan-writer.ts';
import { portError } from '../../src/ports/errors.ts';

const roots: string[] = [];
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'skillsmith-plan-writer-'));
  roots.push(root);
  const base = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
  const ports: PlanWriterPorts = { ...base, rename };
  return { root, path: join(root, 'review.skillsmith.plan'), ports };
};

const residue = async (root: string): Promise<string[]> =>
  (await readdir(root)).filter((name) => name.includes('.skillsmith-plan-'));

describe('saved plan writer', () => {
  test('creates owner-only output and refuses to overwrite existing bytes by default', async () => {
    const state = await fixture();
    const created = await writeSavedPlan(state.ports, {
      path: state.path,
      bytes: bytes('first\n'),
      force: false,
    });
    expect(created).toEqual({
      ok: true,
      value: { path: state.path, disposition: 'created', mode: '0600' },
    });
    expect(await readFile(state.path, 'utf8')).toBe('first\n');
    expect((await stat(state.path)).mode & 0o777).toBe(0o600);

    const refused = await writeSavedPlan(state.ports, {
      path: state.path,
      bytes: bytes('second\n'),
      force: false,
    });
    expect(refused).toMatchObject({ ok: false, error: { reason: 'exists', exitClass: 'usage' } });
    expect(await readFile(state.path, 'utf8')).toBe('first\n');
    expect(await residue(state.root)).toEqual([]);
  });

  test('force atomically replaces only a regular-file target and removes bounded staging state', async () => {
    const state = await fixture();
    await writeFile(state.path, 'old\n', { mode: 0o644 });
    const replaced = await writeSavedPlan(state.ports, {
      path: state.path,
      bytes: bytes('new\n'),
      force: true,
    });
    expect(replaced).toEqual({
      ok: true,
      value: { path: state.path, disposition: 'replaced', mode: '0600' },
    });
    expect(await readFile(state.path, 'utf8')).toBe('new\n');
    expect((await stat(state.path)).mode & 0o777).toBe(0o600);
    expect(await residue(state.root)).toEqual([]);
  });

  test('a post-publication create failure restores absence and removes staging state', async () => {
    const state = await fixture();
    const ports: PlanWriterPorts = {
      ...state.ports,
      fsyncFile: async (path) => {
        if (path === state.path)
          throw Object.assign(new Error('fixture fsync failure'), { code: 'EIO' });
        return state.ports.fsyncFile(path);
      },
    };
    const result = await writeSavedPlan(ports, {
      path: state.path,
      bytes: bytes('new\n'),
      force: false,
    });
    expect(result).toMatchObject({ ok: false, error: { reason: 'write-failed' } });
    expect((await state.ports.observe(state.path)).kind).toBe('absent');
    expect(await residue(state.root)).toEqual([]);
  });

  test('a post-replacement failure restores prior bytes and cleans the rollback link', async () => {
    const state = await fixture();
    await writeFile(state.path, 'old\n', { mode: 0o640 });
    let targetSyncs = 0;
    const ports: PlanWriterPorts = {
      ...state.ports,
      fsyncFile: async (path) => {
        if (path === state.path && targetSyncs++ === 0) {
          throw Object.assign(new Error('fixture fsync failure'), { code: 'EIO' });
        }
        return state.ports.fsyncFile(path);
      },
    };
    const result = await writeSavedPlan(ports, {
      path: state.path,
      bytes: bytes('new\n'),
      force: true,
    });
    expect(result).toMatchObject({ ok: false, error: { reason: 'write-failed' } });
    expect(await readFile(state.path, 'utf8')).toBe('old\n');
    expect(await residue(state.root)).toEqual([]);
  });

  test('replacement has no fallible durability step after deleting its rollback link', async () => {
    const state = await fixture();
    await writeFile(state.path, 'old\n', { mode: 0o640 });
    let directorySyncs = 0;
    const ports: PlanWriterPorts = {
      ...state.ports,
      fsyncDirectory: async (path) => {
        directorySyncs += 1;
        if (directorySyncs > 2) {
          throw Object.assign(new Error('unsafe post-cleanup fsync'), { code: 'EIO' });
        }
        return state.ports.fsyncDirectory(path);
      },
    };
    const result = await writeSavedPlan(ports, {
      path: state.path,
      bytes: bytes('new\n'),
      force: true,
    });
    expect(result).toMatchObject({ ok: true, value: { disposition: 'replaced' } });
    expect(directorySyncs).toBe(2);
    expect(await readFile(state.path, 'utf8')).toBe('new\n');
    expect(await residue(state.root)).toEqual([]);
  });

  test('canonical permission failures remain exit 6 across observation, stage, publish, and durability', async () => {
    for (const phase of ['observe', 'stage', 'publish', 'durability'] as const) {
      const state = await fixture();
      const denied = () =>
        Promise.reject(
          portError({
            capability: 'file-write',
            operation: `fixture-${phase}`,
            code: 'permission',
            message: 'synthetic permission denial',
            context: {},
          }),
        );
      const ports: PlanWriterPorts = {
        ...state.ports,
        ...(phase === 'observe' ? { observe: denied as PlanWriterPorts['observe'] } : {}),
        ...(phase === 'stage'
          ? { writeBytesExclusive: denied as PlanWriterPorts['writeBytesExclusive'] }
          : {}),
        ...(phase === 'publish'
          ? { linkFileNoReplace: denied as PlanWriterPorts['linkFileNoReplace'] }
          : {}),
        ...(phase === 'durability'
          ? {
              fsyncFile: async (path) =>
                path === state.path ? denied() : state.ports.fsyncFile(path),
            }
          : {}),
      };
      const result = await writeSavedPlan(ports, {
        path: state.path,
        bytes: bytes('new\n'),
        force: false,
      });
      expect(result, phase).toMatchObject({
        ok: false,
        error: { reason: 'permission-denied', exitClass: 'permission' },
      });
      expect((await state.ports.observe(state.path)).kind, phase).toBe('absent');
      expect(await residue(state.root), phase).toEqual([]);
    }
  });

  test('canonical cancellation is preserved instead of becoming a generic writer failure', async () => {
    const state = await fixture();
    const ports: PlanWriterPorts = {
      ...state.ports,
      writeBytesExclusive: async () => {
        throw portError({
          capability: 'file-write',
          operation: 'fixture-stage',
          code: 'cancelled',
          message: 'synthetic cancellation',
          context: {},
        });
      },
    };
    const result = await writeSavedPlan(ports, {
      path: state.path,
      bytes: bytes('new\n'),
      force: false,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'cancelled', exitClass: 'cancelled' },
    });
    expect(await residue(state.root)).toEqual([]);
  });

  test('cancellation after staging removes the exact temporary file and publishes nothing', async () => {
    const state = await fixture();
    const controller = new AbortController();
    const ports: PlanWriterPorts = {
      ...state.ports,
      writeBytesExclusive: async (...args) => {
        await state.ports.writeBytesExclusive(...args);
        controller.abort();
      },
    };
    const result = await writeSavedPlan(ports, {
      path: state.path,
      bytes: bytes('new\n'),
      force: false,
      signal: controller.signal,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'cancelled', exitClass: 'cancelled' },
    });
    expect((await state.ports.observe(state.path)).kind).toBe('absent');
    expect(await residue(state.root)).toEqual([]);
  });

  test('cancellation after replacement publication restores prior bytes without residue', async () => {
    const state = await fixture();
    await writeFile(state.path, 'old\n', { mode: 0o640 });
    const controller = new AbortController();
    const ports: PlanWriterPorts = {
      ...state.ports,
      rename: async (from, to) => {
        await state.ports.rename(from, to);
        if (to === state.path) controller.abort();
      },
    };
    const result = await writeSavedPlan(ports, {
      path: state.path,
      bytes: bytes('new\n'),
      force: true,
      signal: controller.signal,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { reason: 'cancelled', exitClass: 'cancelled' },
    });
    expect(await readFile(state.path, 'utf8')).toBe('old\n');
    expect(await residue(state.root)).toEqual([]);
  });
});
