import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runUninstall } from '../../src/acquire/run.ts';
import type { UninstallDeps } from '../../src/acquire/types.ts';
import type { SkillSmithError } from '../../src/errors.ts';
import { getPair, readLedger, setPair, writeLedger } from '../../src/place/ledger.ts';
import { ledgerPathOf } from '../../src/place/paths.ts';
import { runDev, runPromote, runRollback } from '../../src/place/run.ts';
import type { LedgerFile, PairRecord } from '../../src/place/types.ts';
import type { RuntimePorts } from '../../src/ports/types.ts';
import { canonicalFixtureLedger } from '../fixtures/place/canonical-ledger.ts';
import {
  DEV_SOURCE_NOW,
  type DevSourceFlipOptions,
  actionV2,
  cannedFlipDeps,
  passFlipDeps,
} from '../fixtures/place/dev-source.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../fixtures/place/fleet.ts';

// P13-T6b: regression coverage for the seven BLOCKING adversarial-review findings (BF-1..BF-7).
// Each block first reproduces the exact bug scenario the reviewer named.
setDefaultTimeout(20_000);

const NOW = DEV_SOURCE_NOW;
const msg = (e: SkillSmithError): string => ('message' in e ? e.message : e.code);

let uninstallCtr = 0;
const uninstallDeps = (): UninstallDeps => {
  const start = uninstallCtr++;
  let n = 0;
  return {
    now: () => NOW,
    newTxId: () => (0x60000000 + start * 1000 + n++).toString(16).slice(-8),
  };
};

describe('P13-T6b review regressions', () => {
  let f: FixtureFleet;
  beforeEach(async () => {
    f = await buildFixtureFleet();
  });
  afterEach(async () => {
    await destroyFixtureFleet(f);
  });

  const opts = (o: Partial<DevSourceFlipOptions> = {}): DevSourceFlipOptions => ({
    targets: [],
    cwd: f.home,
    configuration: f.configuration,
    ...o,
  });
  const claudeRoot = (): string => join(f.home, '.claude', 'skills');
  const readLedgerOf = async (): Promise<LedgerFile> => {
    const r = await readLedger(f.env, ledgerPathOf(f.data));
    if (!r.ok) throw new Error(msg(r.error));
    return r.value;
  };
  const rawLedger = async (): Promise<unknown> =>
    JSON.parse(await f.env.readText(ledgerPathOf(f.data)));

  // -------------------------------------------------------------------------------------------
  // BF-1 — --dest safety + lifecycle
  // -------------------------------------------------------------------------------------------

  test("BF-1(a): a '.' name target is refused, never classifies the skills ROOT", async () => {
    const r = await runDev(
      f.env,
      opts({ targets: ['.'], tools: ['claude-code'], source: resolve(f.betaSrc) }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(actionV2(r.value.results[0])).toBe('refused');
    // The claude skills root itself is still a directory, not replaced by a symlink.
    expect(await f.env.pathKind(claudeRoot())).toBe('dir');
  });

  test("BF-1(a): a '..' name target is refused", async () => {
    const r = await runDev(
      f.env,
      opts({ targets: ['..'], tools: ['claude-code'], source: resolve(f.betaSrc) }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(actionV2(r.value.results[0])).toBe('refused');
  });

  test('BF-1(b): a relative --dest is resolved absolute; recorded placementPath is absolute + contained', async () => {
    await mkdir(join(f.base, 'custom-skills'), { recursive: true });
    const r = await runDev(
      f.env,
      opts({
        targets: ['beta'],
        tools: ['claude-code'],
        source: resolve(f.betaSrc),
        dest: 'custom-skills',
        cwd: f.base,
      }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const expected = join(resolve(f.base, 'custom-skills'), 'beta');
    expect(actionV2(r.value.results[0])).toBe('created');
    expect(r.value.results[0]?.placementPath).toBe(expected);
    const pair = getPair(await readLedgerOf(), 'beta', 'claude-code');
    expect(pair?.placementPath).toBe(expected);
  });

  test('BF-1(c): --dest create refuses when a standard-root placement already exists (no duplicate)', async () => {
    // 'alpha' already has a claude-code dev symlink in the standard root.
    const dest = join(f.base, 'custom-skills');
    await mkdir(dest, { recursive: true });
    const r = await runDev(
      f.env,
      opts({ targets: ['alpha'], tools: ['claude-code'], source: resolve(f.betaSrc), dest }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(actionV2(r.value.results[0])).toBe('refused');
    // Nothing created at the custom dest.
    expect(await f.env.pathKind(join(dest, 'alpha'))).toBe('absent');
  });

  test('BF-1(c): --dest create for codex refuses when a legacy-root placement exists (existing codex placement not ignored)', async () => {
    // 'legacy-only' is a hand-made codex symlink in ~/.codex/skills only.
    const dest = join(f.base, 'custom-skills');
    await mkdir(dest, { recursive: true });
    const r = await runDev(
      f.env,
      opts({ targets: ['legacy-only'], tools: ['codex'], source: resolve(f.alphaSrc), dest }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(actionV2(r.value.results[0])).toBe('refused');
    expect(await f.env.pathKind(join(dest, 'legacy-only'))).toBe('absent');
  });

  test('BF-1(d): a --dest-created placement is found by a later promote (name resolver, ledger source of truth)', async () => {
    const dest = join(f.base, 'custom-skills');
    await mkdir(dest, { recursive: true });
    const created = await runDev(
      f.env,
      opts({ targets: ['beta'], tools: ['claude-code'], source: resolve(f.betaSrc), dest }),
      passFlipDeps(),
    );
    if (!created.ok) throw new Error(msg(created.error));
    expect(actionV2(created.value.results[0])).toBe('created');

    // promote <name> must locate the custom-location placement via the ledger, not the std root.
    const promoted = await runPromote(
      f.env,
      opts({ targets: ['beta'], tools: ['claude-code'] }),
      passFlipDeps(),
    );
    if (!promoted.ok) throw new Error(msg(promoted.error));
    expect(promoted.value.results[0]?.action).toBe('flipped');
    expect(promoted.value.results[0]?.placementPath).toBe(join(dest, 'beta'));
  });

  test('BF-1(d): a --dest-created dev pair is removed by uninstall <name> (name resolver locates the custom symlink)', async () => {
    const dest = join(f.base, 'custom-skills');
    await mkdir(dest, { recursive: true });
    const created = await runDev(
      f.env,
      opts({ targets: ['beta'], tools: ['claude-code'], source: resolve(f.betaSrc), dest }),
      passFlipDeps(),
    );
    if (!created.ok) throw new Error(msg(created.error));
    expect(actionV2(created.value.results[0])).toBe('created');

    // A dev-CREATED pair has no retained pin, so uninstall removes the custom symlink without --force.
    // Pre-fix the name resolver missed the custom location and treated it as a 'stale' record-only
    // delete, orphaning the live symlink.
    const un = await runUninstall(
      f.env,
      { targets: ['beta'], tools: ['claude-code'], cwd: f.home, configuration: f.configuration },
      uninstallDeps(),
    );
    if (!un.ok) throw new Error(msg(un.error));
    expect(un.value.results[0]?.action).toBe('removed');
    expect(un.value.results[0]?.before?.mode).toBe('dev');
    expect(await f.env.pathKind(join(dest, 'beta'))).toBe('absent');
    expect(getPair(await readLedgerOf(), 'beta', 'claude-code')).toBeNull();
  });

  test('BF-1(d): a --dest-created placement is found by a later promote via its PATH target', async () => {
    const dest = join(f.base, 'custom-skills');
    await mkdir(dest, { recursive: true });
    const created = await runDev(
      f.env,
      opts({ targets: ['beta'], tools: ['claude-code'], source: resolve(f.betaSrc), dest }),
      passFlipDeps(),
    );
    if (!created.ok) throw new Error(msg(created.error));
    const promoted = await runPromote(
      f.env,
      opts({ targets: [join(dest, 'beta')] }),
      passFlipDeps(),
    );
    if (!promoted.ok) throw new Error(msg(promoted.error));
    expect(promoted.value.results[0]?.action).toBe('flipped');
  });

  test('BF-1(e): an explicit ABSENT path target with --source routes to create', async () => {
    const target = join(claudeRoot(), 'newby'); // absent placement path under a known root
    const r = await runDev(
      f.env,
      opts({ targets: [target], source: resolve(f.betaSrc) }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(actionV2(r.value.results[0])).toBe('created');
    expect(await f.env.pathKind(target)).toBe('symlink');
  });

  test('BF-1(f): core runDev refuses --dest without --source and --dest with != 1 tool', async () => {
    const noSource = await runDev(
      f.env,
      opts({ targets: ['beta'], tools: ['claude-code'], dest: join(f.base, 'c') }),
      passFlipDeps(),
    );
    expect(noSource.ok).toBe(false);
    if (!noSource.ok) expect(noSource.error.code).toBe('flip-refused');

    const twoTools = await runDev(
      f.env,
      opts({ targets: ['beta'], source: resolve(f.betaSrc), dest: join(f.base, 'c') }),
      passFlipDeps(),
    );
    expect(twoTools.ok).toBe(false);
  });

  test('BF-1(f): core runRollback refuses --source / --dest', async () => {
    const r = await runRollback(
      f.env,
      {
        ...opts({ targets: ['beta'], tools: ['claude-code'], source: resolve(f.betaSrc) }),
        op: 'dev',
      },
      passFlipDeps(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('flip-refused');
  });

  // -------------------------------------------------------------------------------------------
  // BF-2 — omitted-field ledger shape
  // -------------------------------------------------------------------------------------------

  test('BF-2: S1 create omits pinned and settles its physical shadow into logical history', async () => {
    const r = await runDev(
      f.env,
      opts({ targets: ['beta'], tools: ['claude-code'], source: resolve(f.betaSrc) }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(actionV2(r.value.results[0])).toBe('created');
    const raw = (await rawLedger()) as {
      skills: { beta: { tools: { 'claude-code': Record<string, unknown> } } };
      transactions: Record<string, unknown>;
      history: Array<Record<string, unknown>>;
    };
    const rec = raw.skills.beta.tools['claude-code'];
    expect(Object.hasOwn(rec, 'pinned')).toBe(false);
    expect(Object.hasOwn(rec, 'journal')).toBe(true);
    expect(rec.journal).toBeNull();
    expect(Object.keys(raw.transactions)).toEqual([]);
    expect(raw.history).toHaveLength(1);
    expect(raw.history[0]).toMatchObject({
      disposition: 'forward',
      phase: 'committed',
      intent: { kind: 'link-dev', skill: 'beta', tool: 'claude-code' },
    });
  });

  // Seed a RAW omitted-field record (undefined, NOT explicit null) directly on disk.
  const seedRawDevOnly = async (skill: string, src: string): Promise<void> => {
    const raw = {
      schemaVersion: 1,
      kind: 'skillsmith.placements',
      updatedAt: NOW,
      skills: {
        [skill]: {
          tools: {
            'claude-code': {
              placementPath: join(claudeRoot(), skill),
              mode: 'dev',
              dev: {
                sourcePath: src,
                resolvedPath: src,
                repoRoot: null,
                sourceRelPath: null,
                remote: null,
                recordedAt: NOW,
              },
            },
          },
        },
      },
    };
    await f.env.makeDir(f.data);
    await f.env.writeTextFile(ledgerPathOf(f.data), JSON.stringify(raw, null, 2));
  };

  test('BF-2: uninstall of a RAW omitted-pinned dev record removes (does NOT demand --force)', async () => {
    const src = resolve(f.betaSrc);
    await symlink(src, join(claudeRoot(), 'rawskill'));
    await seedRawDevOnly('rawskill', src);

    const r = await runUninstall(
      f.env,
      {
        targets: ['rawskill'],
        tools: ['claude-code'],
        cwd: f.home,
        configuration: f.configuration,
      },
      uninstallDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results[0]?.action).toBe('removed');
    expect(await f.env.pathKind(join(claudeRoot(), 'rawskill'))).toBe('absent');
  });

  test('BF-2: --rollback --all does NOT select a RAW omitted-field dev-only pair', async () => {
    const src = resolve(f.betaSrc);
    await symlink(src, join(claudeRoot(), 'rawskill'));
    await seedRawDevOnly('rawskill', src);

    const r = await runRollback(
      f.env,
      { ...opts({ all: true, tools: ['claude-code'] }), op: 'dev' },
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    // A dev-only pair has no pinned state to invert — it must not be planned at all.
    expect(r.value.results.some((res) => res.skill === 'rawskill')).toBe(false);
  });

  // -------------------------------------------------------------------------------------------
  // BF-3 — lexical source equality
  // -------------------------------------------------------------------------------------------

  test('BF-3: a trailing-slash --source re-run is S3 noop, not an S4 mismatch refusal', async () => {
    const src = resolve(f.betaSrc);
    const first = await runDev(
      f.env,
      opts({ targets: ['beta'], tools: ['claude-code'], source: src }),
      passFlipDeps(),
    );
    if (!first.ok) throw new Error(msg(first.error));
    expect(actionV2(first.value.results[0])).toBe('created');

    const second = await runDev(
      f.env,
      opts({ targets: ['beta'], tools: ['claude-code'], source: `${src}/` }),
      passFlipDeps(),
    );
    if (!second.ok) throw new Error(msg(second.error));
    expect(actionV2(second.value.results[0])).toBe('noop');
  });

  test('BF-3: a `..`-bearing --source that canonicalizes to the same dir is S3 noop, not S4', async () => {
    const src = resolve(f.betaSrc);
    const first = await runDev(
      f.env,
      opts({ targets: ['beta'], tools: ['claude-code'], source: src }),
      passFlipDeps(),
    );
    if (!first.ok) throw new Error(msg(first.error));
    const dotdot = join(src, '..', 'beta');
    const second = await runDev(
      f.env,
      opts({ targets: ['beta'], tools: ['claude-code'], source: dotdot }),
      passFlipDeps(),
    );
    if (!second.ok) throw new Error(msg(second.error));
    expect(actionV2(second.value.results[0])).toBe('noop');
  });

  test('BF-3: S5b tolerates a relative recorded dev source (compares dev.resolvedPath)', async () => {
    // A P12-era pinned pair whose recorded dev.sourcePath is RELATIVE but resolvedPath is absolute.
    const abs = resolve(f.alphaSrc);
    const l = await readLedgerOf();
    setPair(l, 'copied', 'claude-code', {
      placementPath: join(claudeRoot(), 'copied'),
      mode: 'pinned',
      dev: {
        sourcePath: 'some/relative/alpha', // relative, resolves wrong against f.home
        resolvedPath: abs,
        repoRoot: null,
        sourceRelPath: null,
        remote: null,
        recordedAt: NOW,
      },
      pinned: null,
    });
    const w = await writeLedger(f.env, ledgerPathOf(f.data), canonicalFixtureLedger(l));
    if (!w.ok) throw new Error(msg(w.error));

    // --source that MATCHES the recorded resolvedPath must NOT be treated as a redirect (no refuse).
    const r = await runDev(
      f.env,
      opts({ targets: ['copied'], tools: ['claude-code'], source: abs }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(actionV2(r.value.results[0])).not.toBe('refused');
  });

  // -------------------------------------------------------------------------------------------
  // BF-4 — foreign directories
  // -------------------------------------------------------------------------------------------

  test('BF-4: a foreign dir (no SKILL.md, no ledger pair) is refused, not hand-copy-replaced (real)', async () => {
    await mkdir(join(claudeRoot(), 'foreigndir'), { recursive: true });
    await writeFile(join(claudeRoot(), 'foreigndir', 'README.txt'), 'not a skill\n');
    const r = await runDev(
      f.env,
      opts({ targets: ['foreigndir'], tools: ['claude-code'], source: resolve(f.betaSrc) }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(actionV2(r.value.results[0])).toBe('refused');
    // Still a real dir — never replaced by a symlink.
    expect(await f.env.pathKind(join(claudeRoot(), 'foreigndir'))).toBe('dir');
  });

  test('BF-4: a foreign dir is refused in --dry-run too (matches the real refusal)', async () => {
    await mkdir(join(claudeRoot(), 'foreigndir'), { recursive: true });
    const r = await runDev(
      f.env,
      opts({
        targets: ['foreigndir'],
        tools: ['claude-code'],
        source: resolve(f.betaSrc),
        dryRun: true,
      }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(actionV2(r.value.results[0])).toBe('refused');
  });

  // -------------------------------------------------------------------------------------------
  // BF-5 — classify→act races + clobber
  // -------------------------------------------------------------------------------------------

  test('BF-5(a): create publishes with a no-clobber symlink — an EEXIST at the final path refuses', async () => {
    const src = resolve(f.betaSrc);
    const live = join(claudeRoot(), 'racy');
    // Env whose makeSymlink at the final path fails EEXIST, as if a concurrent create won the race
    // between the absent-check and the publish. The old rename-based publish would have clobbered.
    const racingEnv: RuntimePorts = {
      ...f.env,
      makeSymlink: async (target, linkPath) => {
        if (linkPath === live) {
          const e = new Error('EEXIST: file already exists') as Error & { code: string };
          e.code = 'EEXIST';
          throw e;
        }
        return f.env.makeSymlink(target, linkPath);
      },
    };
    const r = await runDev(
      racingEnv,
      opts({ targets: ['racy'], tools: ['claude-code'], source: src }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(actionV2(r.value.results[0])).toBe('refused');
    expect(r.value.results[0]?.reason ?? '').toMatch(/concurrently/);
    // No ledger record written for a refused create.
    expect(getPair(await readLedgerOf(), 'racy', 'claude-code')).toBeNull();
  });

  test('BF-5(b): adopt re-reads the live symlink and refuses if it was retargeted after classification', async () => {
    const src = resolve(f.betaSrc);
    const other = resolve(f.alphaSrc);
    const live = join(claudeRoot(), 'retarget');
    await symlink(src, live); // classification sees src (== --source)

    // readLink returns the real target on the FIRST read (classification) but a different target on
    // the adopt re-read — modeling a concurrent retarget between classify and record.
    let reads = 0;
    const flakyEnv: RuntimePorts = {
      ...f.env,
      readLink: async (p) => {
        if (p === live) {
          reads += 1;
          return reads <= 1 ? src : other;
        }
        return f.env.readLink(p);
      },
    };
    const r = await runDev(
      flakyEnv,
      opts({ targets: ['retarget'], tools: ['claude-code'], source: src }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(actionV2(r.value.results[0])).toBe('refused');
    expect(getPair(await readLedgerOf(), 'retarget', 'claude-code')).toBeNull();
  });

  test('BF-5(c): a matching dev symlink over a retained pinned/origin pair refuses, never discards the pin', async () => {
    const src = resolve(f.betaSrc);
    const live = join(claudeRoot(), 'pinnedghost');
    await symlink(src, live); // disk is a dev symlink to src (== --source)
    // Ledger pair still records a pinned copy + origin (a manually-replaced placement).
    const l = await readLedgerOf();
    const rec: PairRecord = {
      placementPath: live,
      mode: 'pinned',
      dev: null,
      pinned: {
        storePath: join(f.data, 'store', 'x', 'y@abc', 'pinnedghost'),
        rev: 'abcdef012345',
        gitSha: null,
        dirty: false,
        contentHash: `sha256:${'a'.repeat(64)}`,
        snapshotAt: NOW,
        verify: 'passed',
      },
      origin: {
        source: 'owner/repo/pinnedghost',
        host: 'github.com',
        repo: 'owner/repo',
        skillPath: 'pinnedghost',
        refRequested: null,
        refResolved: 'a'.repeat(40),
        pin: false,
        installedAt: NOW,
      },
    };
    setPair(l, 'pinnedghost', 'claude-code', rec);
    const w = await writeLedger(f.env, ledgerPathOf(f.data), canonicalFixtureLedger(l));
    if (!w.ok) throw new Error(msg(w.error));

    const r = await runDev(
      f.env,
      opts({ targets: ['pinnedghost'], tools: ['claude-code'], source: src }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(actionV2(r.value.results[0])).toBe('refused');
    // The retained pinned record is untouched.
    const pair = getPair(await readLedgerOf(), 'pinnedghost', 'claude-code');
    expect(pair?.pinned?.rev).toBe('abcdef012345');
  });

  test('BF-5(d): a dev symlink whose ledger dev record disagrees with the disk refuses (mode+source agreement)', async () => {
    const src = resolve(f.betaSrc);
    const live = join(claudeRoot(), 'disagree');
    await symlink(src, live); // disk points at src (== --source)
    const l = await readLedgerOf();
    setPair(l, 'disagree', 'claude-code', {
      placementPath: live,
      mode: 'dev',
      dev: {
        sourcePath: resolve(f.alphaSrc), // ledger records a DIFFERENT source than the disk
        resolvedPath: resolve(f.alphaSrc),
        repoRoot: null,
        sourceRelPath: null,
        remote: null,
        recordedAt: NOW,
      },
    });
    const w = await writeLedger(f.env, ledgerPathOf(f.data), canonicalFixtureLedger(l));
    if (!w.ok) throw new Error(msg(w.error));

    const r = await runDev(
      f.env,
      opts({ targets: ['disagree'], tools: ['claude-code'], source: src }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(actionV2(r.value.results[0])).toBe('refused');
  });

  test('BF-5(e): S1 create refuses rather than overwrite a stale existing ledger pair', async () => {
    // A lingering pinned pair for 'ghost' whose live placement is absent (disk removed manually).
    const l = await readLedgerOf();
    setPair(l, 'ghost', 'claude-code', {
      placementPath: join(claudeRoot(), 'ghost'),
      mode: 'pinned',
      dev: null,
      pinned: {
        storePath: join(f.data, 'store', 'x', 'y@abc', 'ghost'),
        rev: 'deadbeef0001',
        gitSha: null,
        dirty: false,
        contentHash: `sha256:${'b'.repeat(64)}`,
        snapshotAt: NOW,
        verify: 'passed',
      },
    });
    const w = await writeLedger(f.env, ledgerPathOf(f.data), canonicalFixtureLedger(l));
    if (!w.ok) throw new Error(msg(w.error));

    const r = await runDev(
      f.env,
      opts({ targets: ['ghost'], tools: ['claude-code'], source: resolve(f.betaSrc) }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(actionV2(r.value.results[0])).toBe('refused');
    expect(await f.env.pathKind(join(claudeRoot(), 'ghost'))).toBe('absent');
    // The stale pinned record is not overwritten by a dev-only record.
    expect(getPair(await readLedgerOf(), 'ghost', 'claude-code')?.pinned?.rev).toBe('deadbeef0001');
  });

  // -------------------------------------------------------------------------------------------
  // BF-6 — dry-run divergence
  // -------------------------------------------------------------------------------------------

  test('BF-6: --dry-run refuses a missing source dir (matches the real refusal), does not predict created', async () => {
    const r = await runDev(
      f.env,
      opts({
        targets: ['beta'],
        tools: ['claude-code'],
        source: join(f.base, 'does-not-exist'),
        dryRun: true,
      }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(actionV2(r.value.results[0])).toBe('refused');
    expect(r.value.summary.created).toBe(0);
  });

  test('BF-6: a directory named SKILL.md is not a usable skill source (refused, real + dry-run)', async () => {
    const badSrc = join(f.base, 'srcs', 'skilldir');
    await mkdir(join(badSrc, 'SKILL.md'), { recursive: true }); // SKILL.md is a DIRECTORY
    for (const dryRun of [false, true]) {
      const r = await runDev(
        f.env,
        opts({ targets: ['skilldir'], tools: ['claude-code'], source: badSrc, dryRun }),
        passFlipDeps(),
      );
      if (!r.ok) throw new Error(msg(r.error));
      expect(actionV2(r.value.results[0])).toBe('refused');
    }
  });

  // -------------------------------------------------------------------------------------------
  // BF-7(a) — gate failure must leave NO placements.json (R2: target-lock, realpath:false, D2 "nothing written")
  // -------------------------------------------------------------------------------------------

  test('BF-7(a): a gate failure on a fresh home leaves NO placements.json in the data dir', async () => {
    const ledgerPath = ledgerPathOf(f.data);
    expect(await f.env.pathKind(ledgerPath)).toBe('absent');
    const r = await runDev(
      f.env,
      opts({ targets: ['beta'], tools: ['claude-code'], source: resolve(f.betaSrc) }),
      cannedFlipDeps('fail'), // verify gate blocks -> failed, nothing written
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(actionV2(r.value.results[0])).toBe('failed');
    // D2: no ledger materialized. R2: the lock targets placements.json directly (realpath:false), so
    // proper-lockfile's mkdir lock DIR is placements.json.lock and the ledger FILE is never written.
    expect(await f.env.pathKind(ledgerPath)).toBe('absent');
  });
});
