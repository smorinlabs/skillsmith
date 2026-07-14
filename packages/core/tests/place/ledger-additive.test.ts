import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describeLedgerV1Migration,
  fromLedgerV2Dto,
  ledgerV1Codec,
  ledgerV2Codec,
  migrateLedgerV1DtoToV2Dto,
  toLedgerV1Dto,
} from '../../src/artifacts/ledger-codec.ts';
import type { LedgerV1Dto, LedgerV2Dto } from '../../src/artifacts/ledger-types.ts';
import type { SkillSmithError } from '../../src/errors.ts';
import {
  deletePairAt,
  emptyLedger,
  getPair,
  getPairAt,
  readLedger,
  setPair,
  setPairAt,
  writeLedger,
} from '../../src/place/ledger.ts';
import type { OriginRecord, PairRecord, PinnedRecord } from '../../src/place/types.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';
import type { RuntimePorts } from '../../src/ports/types.ts';

const P12_GOLDEN = join(import.meta.dir, '..', 'fixtures', 'place', 'ledger.golden.json');
const INSTALL_GOLDEN = join(
  import.meta.dir,
  '..',
  'fixtures',
  'place',
  'ledger-install.golden.json',
);
const CONTRACT_FIXTURES = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests',
  'ergonomics',
  'fixtures',
);

const msg = (e: SkillSmithError): string => ('message' in e ? e.message : e.code);

const origin = (): OriginRecord => ({
  source: 'smorinlabs/smorinlabs-harness/factor-scan',
  host: 'github.com',
  repo: 'smorinlabs/smorinlabs-harness',
  skillPath: 'plugins/factor-harness/skills/factor-scan',
  refRequested: null,
  refResolved: '3f2a1b9c0d4e5f6a7b8c9d0e1f2a3b4c5d6e7f80',
  pin: false,
  installedAt: '2026-07-07T00:00:00Z',
});

const pinned = (placement?: 'symlink' | 'copy'): PinnedRecord => ({
  storePath: '/store/owner/repo@abc123abc123/skill',
  rev: 'abc123abc123',
  gitSha: 'abc123abc123abc123abc123abc123abc123abcd',
  dirty: false,
  contentHash: 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  snapshotAt: '2026-07-07T00:00:00Z',
  verify: 'passed',
  ...(placement ? { placement } : {}),
});

const installPair = (path: string, placement: 'symlink' | 'copy'): PairRecord => ({
  placementPath: path,
  mode: 'pinned',
  dev: null,
  pinned: pinned(placement),
  origin: origin(),
  journal: null,
});

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

describe('artifact ledger codecs', () => {
  test('v1 compatibility and v2 canonical codecs reproduce the contract goldens', async () => {
    const v1Bytes = new Uint8Array(
      await readFile(join(CONTRACT_FIXTURES, 'p2-ts08', 'ledger-v1.golden.json')),
    );
    const v2Bytes = new Uint8Array(
      await readFile(join(CONTRACT_FIXTURES, 'p2-ts08', 'ledger-v2.golden.json')),
    );
    const v1 = unwrap(ledgerV1Codec.decode(v1Bytes));
    const v2 = unwrap(ledgerV2Codec.decode(v2Bytes));
    expect(unwrap(ledgerV1Codec.encode(v1.model))).toEqual(v1Bytes);
    expect(unwrap(ledgerV2Codec.encode(v2.model))).toEqual(v2Bytes);
    expect(v1Bytes.at(-1)).not.toBe(0x0a);
    expect(v2Bytes.at(-1)).toBe(0x0a);
    expect(Object.isFrozen(v1.model)).toBe(true);
    expect(Object.isFrozen(v2.model)).toBe(true);
  });

  test('pure v1 migration matches the exact DTO, revisions, and retained-journal identities', async () => {
    const fixtureSource = await readFile(
      join(CONTRACT_FIXTURES, 'p2-ts06', 'migration-cases.json'),
      'utf8',
    );
    const fixtures = (
      JSON.parse(fixtureSource) as {
        ledgerMigrations: readonly {
          id: string;
          before: string;
          after: string;
          sourceByteRevision: string;
          targetByteRevision: string;
          semanticRevision: string;
          preservedLegacyJournals: readonly unknown[];
        }[];
      }
    ).ledgerMigrations;
    for (const fixture of fixtures) {
      const dto = JSON.parse(fixture.before) as LedgerV1Dto;
      const snapshot = structuredClone(dto);
      const migrated = unwrap(migrateLedgerV1DtoToV2Dto(dto));
      const metadata = unwrap(
        describeLedgerV1Migration(new TextEncoder().encode(fixture.before), dto),
      );
      expect(dto, fixture.id).toEqual(snapshot);
      expect(`${JSON.stringify(migrated, null, 2)}\n`, fixture.id).toBe(fixture.after);
      expect(String(metadata.sourceByteRevision), fixture.id).toBe(fixture.sourceByteRevision);
      expect(String(metadata.targetByteRevision), fixture.id).toBe(fixture.targetByteRevision);
      expect(String(metadata.sourceSemanticRevision), fixture.id).toBe(fixture.semanticRevision);
      expect(String(metadata.targetSemanticRevision), fixture.id).toBe(fixture.semanticRevision);
      expect(metadata.targetCanonicalSource, fixture.id).toBe(fixture.after);
      expect(metadata.preservedLegacyJournals as readonly unknown[], fixture.id).toEqual(
        fixture.preservedLegacyJournals,
      );
    }
  });

  test('v2 permits normalized dynamic tools but enforces registrations and journal placement', async () => {
    const golden = JSON.parse(
      await readFile(join(CONTRACT_FIXTURES, 'p2-ts08', 'ledger-v2.golden.json'), 'utf8'),
    ) as LedgerV2Dto;
    const dynamic = structuredClone(golden) as LedgerV2Dto;
    const sample = dynamic.skills.review?.tools.codex;
    if (sample === undefined) throw new Error('ledger golden lacks sample pair');
    (dynamic.skills as Record<string, { tools: Record<string, typeof sample> }>).dynamic = {
      tools: { 'kilo-code': sample },
    };
    const model = unwrap(fromLedgerV2Dto(dynamic));
    expect(unwrap(ledgerV2Codec.toDto(model)).skills.dynamic?.tools['kilo-code']).toEqual(sample);
    expect(toLedgerV1Dto(model).ok).toBe(false);

    const registrationMismatch = structuredClone(golden) as LedgerV2Dto;
    const registration = registrationMismatch.projectRegistrations['/workspace/project'];
    if (registration === undefined) throw new Error('ledger golden lacks project registration');
    (registration.consumers[0] as { placementPath: string }).placementPath = '/wrong';
    expect(fromLedgerV2Dto(registrationMismatch).ok).toBe(false);

    const committedInFlight = structuredClone(golden) as LedgerV2Dto;
    const committed = committedInFlight.history[0];
    if (committed === undefined) throw new Error('ledger golden lacks history journal');
    (committedInFlight.transactions as Record<string, typeof committed>)[committed.transactionId] =
      committed;
    expect(fromLedgerV2Dto(committedInFlight).ok).toBe(false);

    const liveInHistory = structuredClone(golden) as LedgerV2Dto;
    const live = liveInHistory.transactions['tx:migrate-ledger-live'];
    if (live === undefined) throw new Error('ledger golden lacks live journal');
    (liveInHistory.history as (typeof live)[]).push(live);
    expect(fromLedgerV2Dto(liveInHistory).ok).toBe(false);
  });
});

describe('additive schema — golden round trips', () => {
  let env: RuntimePorts;
  let base: string;
  beforeEach(async () => {
    env = await defaultRuntimePorts();
    base = await mkdtemp(join(tmpdir(), 'skillsmith-ledger-add-'));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test('the P12 golden still parses unchanged (additive proof)', async () => {
    const r = await readLedger(env, P12_GOLDEN);
    if (!r.ok) throw new Error(msg(r.error));
    expect(getPair(r.value, 'factor-scan', 'claude-code')?.mode).toBe('pinned');
  });

  test('the install golden reads OK and round-trips (origin, placement, projects)', async () => {
    const read = await readLedger(env, INSTALL_GOLDEN);
    if (!read.ok) throw new Error(msg(read.error));
    const user = getPairAt(read.value, null, 'factor-scan', 'claude-code');
    expect(user?.pinned?.placement).toBe('symlink');
    expect(user?.origin?.repo).toBe('smorinlabs/smorinlabs-harness');
    expect(user?.origin?.skillPath).toBe('plugins/factor-harness/skills/factor-scan');
    expect(user?.origin?.refRequested).toBeNull();

    const proj = getPairAt(read.value, '/Users/alice/c/team-repo', 'factor-scan', 'claude-code');
    expect(proj?.pinned?.placement).toBe('copy');
    expect(proj?.origin?.refRequested).toBe('v1.0.0');

    const p = join(base, 'placements.json');
    const w = await writeLedger(env, p, read.value);
    if (!w.ok) throw new Error(msg(w.error));
    const back = await readLedger(env, p);
    if (!back.ok) throw new Error(msg(back.error));
    expect(back.value.skills).toEqual(read.value.skills);
    expect(back.value.projects).toEqual(read.value.projects);
  });
});

describe('additive schema — codec locks', () => {
  let env: RuntimePorts;
  let base: string;
  beforeEach(async () => {
    env = await defaultRuntimePorts();
    base = await mkdtemp(join(tmpdir(), 'skillsmith-ledger-add-'));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const writeAndRead = async (raw: unknown): Promise<ReturnType<typeof readLedger>> => {
    const p = join(base, 'placements.json');
    await writeFile(p, JSON.stringify(raw));
    return readLedger(env, p);
  };

  test("rejects pinned.placement 'link'", async () => {
    const l = emptyLedger('2026-07-07T00:00:00Z');
    setPair(l, 'alpha', 'claude-code', {
      placementPath: '/x',
      mode: 'pinned',
      dev: null,
      pinned: { ...pinned(), placement: 'link' } as unknown as PinnedRecord,
      journal: null,
    });
    const r = await writeAndRead(l);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('ledger-error');
  });

  test("rejects journal.op 'update'", async () => {
    const l = {
      schemaVersion: 1,
      kind: 'skillsmith.placements',
      updatedAt: 'x',
      skills: {
        alpha: {
          tools: {
            'claude-code': {
              placementPath: '/x',
              mode: 'pinned',
              dev: null,
              pinned: pinned(),
              journal: {
                op: 'update',
                txId: 'deadbeef',
                phase: 'prepared',
                startedAt: 'x',
                completedAt: null,
                before: { mode: 'absent' },
                stagingPath: '/s',
                backupPath: '/b',
              },
            },
          },
        },
      },
    };
    const r = await writeAndRead(l);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('ledger-error');
  });

  test("accepts before { mode: 'absent' } (fresh-install journal)", async () => {
    const l = {
      schemaVersion: 1,
      kind: 'skillsmith.placements',
      updatedAt: 'x',
      skills: {
        alpha: {
          tools: {
            'claude-code': {
              placementPath: '/x',
              mode: 'pinned',
              dev: null,
              pinned: pinned('copy'),
              origin: origin(),
              journal: {
                op: 'install',
                txId: 'deadbeef',
                phase: 'live',
                startedAt: 'x',
                completedAt: null,
                before: { mode: 'absent' },
                stagingPath: '/s',
                backupPath: '/b',
              },
            },
          },
        },
      },
    };
    const r = await writeAndRead(l);
    if (!r.ok) throw new Error(msg(r.error));
    expect(getPair(r.value, 'alpha', 'claude-code')?.journal?.op).toBe('install');
  });

  test('rejects projects subtree with an unknown tool key', async () => {
    const l = {
      schemaVersion: 1,
      kind: 'skillsmith.placements',
      updatedAt: 'x',
      skills: {},
      projects: {
        '/Users/alice/c/team-repo': {
          skills: {
            alpha: {
              tools: {
                'kilo-code': installPair('/x', 'copy'),
              },
            },
          },
        },
      },
    };
    const r = await writeAndRead(l);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('ledger-error');
  });

  test('rejects unknown fields recursively instead of stripping them', async () => {
    const rootUnknown = {
      ...emptyLedger('2026-07-07T00:00:00Z'),
      ignoredByTheLegacyParser: true,
    };
    const pairUnknown = {
      schemaVersion: 1,
      kind: 'skillsmith.placements',
      updatedAt: '2026-07-07T00:00:00Z',
      skills: {
        alpha: {
          tools: {
            codex: {
              ...installPair('/x', 'copy'),
              ignoredByTheLegacyParser: true,
            },
          },
        },
      },
    };
    for (const candidate of [rootUnknown, pairUnknown]) {
      const r = await writeAndRead(candidate);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('ledger-error');
    }
  });
});

describe('scoped accessors', () => {
  test('getPairAt(null) === getPair; setPair writes the user tree', () => {
    const l = emptyLedger('2026-07-07T00:00:00Z');
    const rec = installPair('/home/.claude/skills/alpha', 'symlink');
    setPair(l, 'alpha', 'claude-code', rec);
    expect(getPairAt(l, null, 'alpha', 'claude-code')).toEqual(rec);
    expect(getPair(l, 'alpha', 'claude-code')).toEqual(rec);
  });

  test('setPairAt with a project key creates the projects subtree on demand', () => {
    const l = emptyLedger('2026-07-07T00:00:00Z');
    const key = '/Users/alice/c/team-repo';
    const rec = installPair('/Users/alice/c/team-repo/.claude/skills/alpha', 'copy');
    setPairAt(l, key, 'alpha', 'claude-code', rec);
    expect(getPairAt(l, key, 'alpha', 'claude-code')).toEqual(rec);
    // user tree untouched
    expect(getPairAt(l, null, 'alpha', 'claude-code')).toBeNull();
    expect(l.projects?.[key]?.skills.alpha?.tools['claude-code']).toEqual(rec);
  });

  test('deletePairAt prunes empty tools/skills/projects containers', () => {
    const l = emptyLedger('2026-07-07T00:00:00Z');
    const key = '/Users/alice/c/team-repo';
    setPairAt(l, key, 'alpha', 'claude-code', installPair('/p/alpha', 'copy'));
    deletePairAt(l, key, 'alpha', 'claude-code');
    expect(getPairAt(l, key, 'alpha', 'claude-code')).toBeNull();
    // the empty project container is pruned entirely
    expect(l.projects?.[key]).toBeUndefined();
  });

  test('deletePairAt in the user tree prunes the empty skill entry', () => {
    const l = emptyLedger('2026-07-07T00:00:00Z');
    setPair(l, 'alpha', 'claude-code', installPair('/u/alpha', 'symlink'));
    deletePairAt(l, null, 'alpha', 'claude-code');
    expect(getPair(l, 'alpha', 'claude-code')).toBeNull();
    expect(l.skills.alpha).toBeUndefined();
  });

  test('deletePairAt keeps sibling tools/skills intact', () => {
    const l = emptyLedger('2026-07-07T00:00:00Z');
    const key = '/Users/alice/c/team-repo';
    setPairAt(l, key, 'alpha', 'claude-code', installPair('/p/alpha', 'copy'));
    setPairAt(l, key, 'alpha', 'codex', installPair('/p/alpha-cx', 'copy'));
    setPairAt(l, key, 'beta', 'claude-code', installPair('/p/beta', 'copy'));
    deletePairAt(l, key, 'alpha', 'claude-code');
    expect(getPairAt(l, key, 'alpha', 'codex')).not.toBeNull();
    expect(getPairAt(l, key, 'beta', 'claude-code')).not.toBeNull();
    expect(l.projects?.[key]).toBeDefined();
  });
});
