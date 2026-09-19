import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ledgerV2Codec } from '../../src/artifacts/ledger-codec.ts';
import type { LedgerModel } from '../../src/artifacts/ledger-types.ts';
import type { SkillSmithError } from '../../src/errors.ts';
import {
  emptyLedger,
  emptyLedgerModel,
  getLedgerPairAt,
  getPair,
  ledgerModelForMutation,
  readLedger,
  readLedgerState,
  setPair,
  withLedgerLock,
  withLedgerPairAt,
  writeLedger,
} from '../../src/place/ledger.ts';
import { ledgerPathOf } from '../../src/place/paths.ts';
import { runPromote } from '../../src/place/run.ts';
import type { DevRecord, LedgerFile, PinnedRecord } from '../../src/place/types.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';
import type { RuntimePorts } from '../../src/ports/types.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../fixtures/place/fleet.ts';

const GOLDEN = join(import.meta.dir, '..', 'fixtures', 'place', 'ledger.golden.json');
const V2_GOLDEN = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests',
  'ergonomics',
  'fixtures',
  'p2-ts08',
  'ledger-v2.golden.json',
);

const msg = (e: SkillSmithError): string => ('message' in e ? e.message : e.code);

const devRecord = (): DevRecord => ({
  sourcePath: '/src/skill',
  resolvedPath: '/src/skill',
  repoRoot: '/src',
  sourceRelPath: 'skill',
  remote: 'owner/repo',
  recordedAt: '2026-07-07T00:00:00Z',
});

const pinnedRecord = (): PinnedRecord => ({
  storePath: '/store/owner/repo@abc123abc123/skill',
  rev: 'abc123abc123',
  gitSha: 'abc123abc123abc123abc123abc123abc123abcd',
  dirty: false,
  contentHash: 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  snapshotAt: '2026-07-07T00:00:00Z',
  verify: 'passed',
});

// Helpers mirroring the run layer's lossless flip updates (D5).
const applyPromote = (l: LedgerFile, skill: string, tool: 'claude-code' | 'codex'): void => {
  const prev = getPair(l, skill, tool);
  setPair(l, skill, tool, {
    placementPath: '/home/.claude/skills/skill',
    mode: 'pinned',
    dev: prev?.dev ?? null,
    pinned: pinnedRecord(),
    journal: prev?.journal ?? null,
  });
};
const applyDemote = (l: LedgerFile, skill: string, tool: 'claude-code' | 'codex'): void => {
  const prev = getPair(l, skill, tool);
  setPair(l, skill, tool, {
    placementPath: '/home/.claude/skills/skill',
    mode: 'dev',
    dev: devRecord(),
    pinned: prev?.pinned ?? null,
    journal: prev?.journal ?? null,
  });
};

describe('readLedger', () => {
  let env: RuntimePorts;
  let base: string;
  beforeEach(async () => {
    env = await defaultRuntimePorts();
    base = await mkdtemp(join(tmpdir(), 'skillsmith-ledger-'));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test('absent path → emptyLedger', async () => {
    const r = await readLedger(env, join(base, 'missing.json'));
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.schemaVersion).toBe(1);
    expect(r.value.kind).toBe('skillsmith.placements');
    expect(r.value.skills).toEqual({});
  });

  test('existing empty/whitespace file → fixed ledger error (never missing)', async () => {
    const p = join(base, 'placements.json');
    await writeFile(p, '   \n  ');
    const r = await readLedger(env, p);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('ledger-error');
      expect(msg(r.error)).not.toContain('JSON');
    }
  });

  test('truncated JSON → ledger-error (never regenerate)', async () => {
    const p = join(base, 'placements.json');
    await writeFile(p, '{"schemaVersion":1');
    const r = await readLedger(env, p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('ledger-error');
  });

  test('invalid UTF-8 inside JSON is corrupt at the exact-byte facade boundary', async () => {
    const p = join(base, 'placements.json');
    await writeFile(
      p,
      Buffer.concat([
        Buffer.from('{"schemaVersion":1,"kind":"skillsmith.placements","updatedAt":"', 'utf8'),
        Buffer.from([0xc3, 0x28]),
        Buffer.from('","skills":{}}', 'utf8'),
      ]),
    );
    const r = await readLedger(env, p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('ledger-error');
  });

  test('valid JSON but wrong shape → ledger-error', async () => {
    const p = join(base, 'placements.json');
    await writeFile(
      p,
      '{"schemaVersion":2,"kind":"skillsmith.placements","updatedAt":"x","skills":{}}',
    );
    const r = await readLedger(env, p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('ledger-error');
  });

  test('valid v2 exposes a safe legacy pair view without permitting a downgrade write', async () => {
    const p = join(base, 'placements.json');
    await writeFile(
      p,
      `${JSON.stringify(
        {
          schemaVersion: 2,
          kind: 'skillsmith.placements',
          updatedAt: '2026-07-14T00:00:00Z',
          skills: {},
          projects: {},
          projectRegistrations: {},
          transactions: {},
          history: [],
        },
        null,
        2,
      )}\n`,
    );
    const r = await readLedger(env, p);
    expect(r).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        kind: 'skillsmith.placements',
        updatedAt: '2026-07-14T00:00:00Z',
        skills: {},
      },
    });
    if (!r.ok) return;
    const before = await readFile(p);
    expect((await writeLedger(env, p, r.value)).ok).toBeFalse();
    expect(await readFile(p)).toEqual(before);
  });

  test('G3B-03: canonical state reads v2 and absence without consulting the clock', async () => {
    const absentCalls: string[] = [];
    const absent = await readLedgerState(
      {
        pathKind: async () => 'absent',
        readBytes: async () => {
          absentCalls.push('readBytes');
          return new Uint8Array();
        },
      },
      join(base, 'missing-v2.json'),
    );
    expect(absent).toEqual({
      ok: true,
      value: {
        state: 'absent',
        sourceVersion: null,
        bytes: null,
        byteRevision: null,
        semanticRevision: null,
        model: null,
      },
    });
    expect(absentCalls).toEqual([]);

    const p = join(base, 'placements-v2.json');
    await writeFile(p, await readFile(V2_GOLDEN));
    const present = await readLedgerState(env, p);
    if (!present.ok || present.value.state !== 'present') throw new Error('missing v2 state');
    expect(present.value.sourceVersion).toBe(2);
    expect(present.value.model.transactions).not.toEqual({});
    expect(Object.isFrozen(present.value.model)).toBeTrue();
  });

  test('future versions produce a fixed upgrade-required error without parser details', async () => {
    const p = join(base, 'placements.json');
    await writeFile(
      p,
      JSON.stringify({
        schemaVersion: 3,
        kind: 'skillsmith.placements',
        updatedAt: 'future',
        skills: {},
      }),
    );
    const r = await readLedger(env, p);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('ledger-error');
      expect(msg(r.error)).toContain('upgrade');
      expect(msg(r.error)).not.toContain('schemaVersion');
    }
  });

  test('valid v1 returns a mutable compatibility clone', async () => {
    const r = await readLedger(env, GOLDEN);
    if (!r.ok) throw new Error(msg(r.error));
    expect(Object.isFrozen(r.value)).toBe(false);
    expect(Object.isFrozen(r.value.skills)).toBe(false);
    r.value.skills.alpha = { tools: {} };
    expect(r.value.skills.alpha).toEqual({ tools: {} });
  });
});

describe('golden ledger', () => {
  let env: RuntimePorts;
  let base: string;
  beforeEach(async () => {
    env = await defaultRuntimePorts();
    base = await mkdtemp(join(tmpdir(), 'skillsmith-ledger-'));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test('reads v1 compatibly and writes its normalized model only as canonical v2', async () => {
    const read = await readLedgerState(env, GOLDEN);
    if (!read.ok || read.value.state !== 'present') throw new Error('missing v1 ledger');
    expect(read.value.sourceVersion).toBe(1);
    const p = join(base, 'placements.json');
    const w = await writeLedger(env, p, read.value.model);
    expect(w.ok).toBe(true);
    const back = await readLedgerState(env, p);
    if (!back.ok || back.value.state !== 'present') throw new Error('missing written ledger');
    expect(back.value.sourceVersion).toBe(2);
    expect(back.value.model.skills).toEqual(read.value.model.skills);
    expect(back.value.model.projects).toEqual(read.value.model.projects);
    expect(back.value.model.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('writeLedger', () => {
  let env: RuntimePorts;
  let base: string;
  beforeEach(async () => {
    env = await defaultRuntimePorts();
    base = await mkdtemp(join(tmpdir(), 'skillsmith-ledger-'));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test('G3B-03: writes the complete canonical v2 model without a lossy v1 projection', async () => {
    const decodedFixture = ledgerV2Codec.decode(new Uint8Array(await readFile(V2_GOLDEN)));
    if (!decodedFixture.ok) throw new Error('invalid v2 ledger fixture');
    const model = decodedFixture.value.model;
    const snapshot = structuredClone(model);
    const writtenAt = '2026-07-15T12:00:00.000Z';
    const p = join(base, 'placements.json');
    const writer = writeLedger as unknown as (
      ports: RuntimePorts,
      path: string,
      ledger: LedgerModel,
    ) => ReturnType<typeof writeLedger>;

    const result = await writer({ ...env, wallNowIso: () => writtenAt }, p, model);

    expect(result.ok).toBe(true);
    expect(model).toEqual(snapshot);
    const writtenBytes = new Uint8Array(await readFile(p));
    expect(writtenBytes.at(-1)).toBe(0x0a);
    const decodedWritten = ledgerV2Codec.decode(writtenBytes);
    if (!decodedWritten.ok) throw new Error('writer did not emit canonical ledger v2');
    expect(decodedWritten.value.source).toEqual({ kind: 'version', version: 2 });
    expect(decodedWritten.value.model).toEqual({ ...snapshot, updatedAt: writtenAt });
  });

  test('is atomic: no *.tmp-* sibling remains and content parses', async () => {
    const p = join(base, 'placements.json');
    const l = withLedgerPairAt(
      emptyLedgerModel('2026-07-07T00:00:00Z'),
      null,
      'alpha',
      'claude-code',
      {
        placementPath: '/x',
        mode: 'dev',
        dev: devRecord(),
        pinned: null,
        journal: null,
      },
    );
    if (!l.ok) throw new Error(msg(l.error));
    const w = await writeLedger(env, p, l.value);
    expect(w.ok).toBe(true);
    const siblings = await readdir(dirname(p));
    expect(siblings.some((n) => n.includes('.tmp-'))).toBe(false);
    const source = await env.readText(p);
    expect(source.endsWith('\n')).toBe(true);
    expect(Object.keys(JSON.parse(source))).toEqual([
      'schemaVersion',
      'kind',
      'updatedAt',
      'skills',
      'projects',
      'projectRegistrations',
      'transactions',
      'history',
    ]);
    const back = await readLedgerState(env, p);
    if (!back.ok || back.value.state !== 'present') throw new Error('missing written ledger');
    expect(getLedgerPairAt(back.value.model, null, 'alpha', 'claude-code')?.dev?.remote).toBe(
      'owner/repo',
    );
  });

  test('refuses legacy and malformed runtime values before every write-side effect', async () => {
    for (const candidate of [{ ...emptyLedger('2026-07-14T00:00:00Z'), unknown: true }, null]) {
      const calls: string[] = [];
      const r = await writeLedger(
        {
          wallNowIso: () => {
            calls.push('wallNowIso');
            return 'never-used';
          },
          nextId: () => {
            calls.push('nextId');
            return 'never-used';
          },
          writeTextFile: async () => {
            calls.push('writeTextFile');
          },
          fsyncFile: async () => {
            calls.push('fsyncFile');
          },
          rename: async () => {
            calls.push('rename');
          },
          fsyncDir: async () => {
            calls.push('fsyncDir');
          },
          removeTree: async () => {
            calls.push('removeTree');
          },
        },
        '/fixture/placements.json',
        candidate as LedgerFile,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('ledger-error');
      expect(calls).toEqual([]);
    }
  });
});

describe('withLedgerLock', () => {
  let f: FixtureFleet;
  beforeEach(async () => {
    f = await buildFixtureFleet();
  });
  afterEach(async () => {
    await destroyFixtureFleet(f);
  });

  test('creates parent dir + empty file, and nested read→mutate→write works', async () => {
    const p = join(f.data, 'nested', 'placements.json');
    const r = await withLedgerLock(f.env, p, async () => {
      const read = await readLedgerState(f.env, p);
      if (!read.ok) throw new Error(msg(read.error));
      const l = withLedgerPairAt(
        ledgerModelForMutation(read.value, '2026-07-15T00:00:00.000Z'),
        null,
        'alpha',
        'claude-code',
        {
          placementPath: '/x',
          mode: 'dev',
          dev: devRecord(),
          pinned: null,
          journal: null,
        },
      );
      if (!l.ok) throw new Error(msg(l.error));
      const w = await writeLedger(f.env, p, l.value);
      if (!w.ok) throw new Error(msg(w.error));
      return 'done';
    });
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value).toBe('done');
    expect(await f.env.pathKind(dirname(p))).toBe('dir');
    const back = await readLedgerState(f.env, p);
    if (!back.ok || back.value.state !== 'present') throw new Error('missing written ledger');
    expect(getLedgerPairAt(back.value.model, null, 'alpha', 'claude-code')?.mode).toBe('dev');
  });

  test('uses the fleet ledger path and defaults empty on first use', async () => {
    const p = ledgerPathOf(f.data);
    const r = await withLedgerLock(f.env, p, async () => (await readLedger(f.env, p)).ok);
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value).toBe(true);
  });

  test('projects committed logical history for read-only legacy phase inspection', async () => {
    const promoted = await runPromote(
      f.env,
      {
        targets: ['alpha'],
        tools: ['claude-code'],
        cwd: f.home,
        configuration: f.configuration,
        noVerify: true,
      },
      {
        now: () => '2026-07-15T00:00:00.000Z',
        newTxId: () => 'aabbccdd',
        verify: async () => {
          throw new Error('read-only ledger projection invoked verification');
        },
      },
    );
    expect(promoted.ok).toBeTrue();
    const path = ledgerPathOf(f.data);
    const before = await readFile(path);
    const projected = await readLedger(f.env, path);
    if (!projected.ok) throw new Error(msg(projected.error));

    expect(getPair(projected.value, 'alpha', 'claude-code')?.journal).toMatchObject({
      op: 'promote',
      txId: 'aabbccdd',
      phase: 'committed',
      completedAt: '2026-07-15T00:00:00.000Z',
    });
    expect((await writeLedger(f.env, path, projected.value)).ok).toBeFalse();
    expect(await readFile(path)).toEqual(before);
  });

  test('G3B-02: forwards cancellation to the historical ledger target lock', async () => {
    const p = ledgerPathOf(f.data);
    const controller = new AbortController();
    const request = Object.freeze({ signal: controller.signal });
    let acquiredPath: string | undefined;
    let acquiredRequest: unknown;
    const withFileLock = async <T>(
      path: string,
      operation: () => Promise<T>,
      options?: unknown,
    ): Promise<T> => {
      acquiredPath = path;
      acquiredRequest = options;
      return operation();
    };
    const env: RuntimePorts = { ...f.env, withFileLock };
    const signalAwareWithLedgerLock = withLedgerLock as <T>(
      ports: RuntimePorts,
      path: string,
      operation: () => Promise<T>,
      options?: Readonly<{ signal?: AbortSignal }>,
    ) => ReturnType<typeof withLedgerLock<T>>;

    const r = await signalAwareWithLedgerLock(env, p, async () => 'done', request);
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value).toBe('done');
    expect(acquiredPath).toBe(p);
    expect(acquiredRequest).toBe(request);
  });

  test('G3B-02: preserves lock-port cancellation instead of relabelling it as contention', async () => {
    const p = ledgerPathOf(f.data);
    const cancellation = Object.assign(new Error('ledger lock wait cancelled'), {
      code: 'ABORT_ERR',
    });
    const env: RuntimePorts = {
      ...f.env,
      withFileLock: async () => {
        throw cancellation;
      },
    };
    const r = await withLedgerLock(env, p, async () => 'unreachable');

    expect(r).toMatchObject({ ok: false, error: { code: 'cancelled' } });
  });
});

describe('losslessness (D5) at the record level', () => {
  test('promote retains dev; symmetric demote retains pinned', () => {
    const l = emptyLedger('2026-07-07T00:00:00Z');
    // start: a dev-mode pair
    setPair(l, 'alpha', 'claude-code', {
      placementPath: '/home/.claude/skills/skill',
      mode: 'dev',
      dev: devRecord(),
      pinned: null,
      journal: null,
    });
    applyPromote(l, 'alpha', 'claude-code');
    const afterPromote = getPair(l, 'alpha', 'claude-code');
    expect(afterPromote?.mode).toBe('pinned');
    expect(afterPromote?.pinned).not.toBeNull();
    expect(afterPromote?.dev).not.toBeNull(); // dev retained across promote

    applyDemote(l, 'alpha', 'claude-code');
    const afterDemote = getPair(l, 'alpha', 'claude-code');
    expect(afterDemote?.mode).toBe('dev');
    expect(afterDemote?.dev).not.toBeNull();
    expect(afterDemote?.pinned).not.toBeNull(); // pinned retained across demote
  });
});

describe('codec enum locks', () => {
  let env: RuntimePorts;
  let base: string;
  beforeEach(async () => {
    env = await defaultRuntimePorts();
    base = await mkdtemp(join(tmpdir(), 'skillsmith-ledger-'));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test("rejects pinned.verify 'failed'", async () => {
    const l = emptyLedger('2026-07-07T00:00:00Z');
    const bad = { ...pinnedRecord(), verify: 'failed' };
    (l.skills as Record<string, unknown>).alpha = {
      tools: {
        'claude-code': {
          placementPath: '/x',
          mode: 'pinned',
          dev: null,
          pinned: bad,
          journal: null,
        },
      },
    };
    const p = join(base, 'placements.json');
    await writeFile(p, JSON.stringify(l));
    const r = await readLedger(env, p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('ledger-error');
  });

  test("rejects mode 'installed'", async () => {
    const p = join(base, 'placements.json');
    const l = {
      schemaVersion: 1,
      kind: 'skillsmith.placements',
      updatedAt: 'x',
      skills: {
        alpha: {
          tools: {
            'claude-code': {
              placementPath: '/x',
              mode: 'installed',
              dev: null,
              pinned: null,
              journal: null,
            },
          },
        },
      },
    };
    await writeFile(p, JSON.stringify(l));
    const r = await readLedger(env, p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('ledger-error');
  });
});
