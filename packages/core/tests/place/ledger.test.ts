import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SkillSmithError } from '../../src/errors.ts';
import {
  emptyLedger,
  getPair,
  readLedger,
  setPair,
  withLedgerLock,
  writeLedger,
} from '../../src/place/ledger.ts';
import { ledgerPathOf } from '../../src/place/paths.ts';
import type { DevRecord, LedgerFile, PinnedRecord } from '../../src/place/types.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';
import type { RuntimePorts } from '../../src/ports/types.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../fixtures/place/fleet.ts';

const GOLDEN = join(import.meta.dir, '..', 'fixtures', 'place', 'ledger.golden.json');

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

  test('empty/whitespace file → emptyLedger', async () => {
    const p = join(base, 'placements.json');
    await writeFile(p, '   \n  ');
    const r = await readLedger(env, p);
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.skills).toEqual({});
  });

  test('truncated JSON → ledger-error (never regenerate)', async () => {
    const p = join(base, 'placements.json');
    await writeFile(p, '{"schemaVersion":1');
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

  test('reads OK and round-trips through writeLedger', async () => {
    const read = await readLedger(env, GOLDEN);
    if (!read.ok) throw new Error(msg(read.error));
    const p = join(base, 'placements.json');
    const w = await writeLedger(env, p, read.value);
    expect(w.ok).toBe(true);
    const back = await readLedger(env, p);
    if (!back.ok) throw new Error(msg(back.error));
    // updatedAt is writer-owned (re-stamped on every write); the payload round-trips.
    expect(back.value.schemaVersion).toBe(read.value.schemaVersion);
    expect(back.value.kind).toBe(read.value.kind);
    expect(back.value.skills).toEqual(read.value.skills);
    expect(back.value.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
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

  test('is atomic: no *.tmp-* sibling remains and content parses', async () => {
    const p = join(base, 'placements.json');
    const l = emptyLedger('2026-07-07T00:00:00Z');
    setPair(l, 'alpha', 'claude-code', {
      placementPath: '/x',
      mode: 'dev',
      dev: devRecord(),
      pinned: null,
      journal: null,
    });
    const w = await writeLedger(env, p, l);
    expect(w.ok).toBe(true);
    const siblings = await readdir(dirname(p));
    expect(siblings.some((n) => n.includes('.tmp-'))).toBe(false);
    const back = await readLedger(env, p);
    if (!back.ok) throw new Error(msg(back.error));
    expect(getPair(back.value, 'alpha', 'claude-code')?.dev?.remote).toBe('owner/repo');
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
      const read = await readLedger(f.env, p);
      if (!read.ok) throw new Error(msg(read.error));
      const l = read.value;
      setPair(l, 'alpha', 'claude-code', {
        placementPath: '/x',
        mode: 'dev',
        dev: devRecord(),
        pinned: null,
        journal: null,
      });
      const w = await writeLedger(f.env, p, l);
      if (!w.ok) throw new Error(msg(w.error));
      return 'done';
    });
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value).toBe('done');
    expect(await f.env.pathKind(dirname(p))).toBe('dir');
    const back = await readLedger(f.env, p);
    if (!back.ok) throw new Error(msg(back.error));
    expect(getPair(back.value, 'alpha', 'claude-code')?.mode).toBe('dev');
  });

  test('uses the fleet ledger path and defaults empty on first use', async () => {
    const p = ledgerPathOf(f.data);
    const r = await withLedgerLock(f.env, p, async () => (await readLedger(f.env, p)).ok);
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value).toBe(true);
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

describe('zod enum locks', () => {
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
