import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, readlink, symlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { SkillSmithError } from '../../src/errors.ts';
import { emptyLedger, getPair, readLedger, setPair, writeLedger } from '../../src/place/ledger.ts';
import { ledgerPathOf } from '../../src/place/paths.ts';
import { runDev } from '../../src/place/run.ts';
import type { DevRecord, LedgerFile } from '../../src/place/types.ts';
import {
  DEV_SOURCE_NOW,
  type DevSourceFlipOptions,
  actionV2,
  codexDefaultSkillsDestFor,
  makeSkillSource,
  passFlipDeps,
  summaryV2,
} from '../fixtures/place/dev-source.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../fixtures/place/fleet.ts';

// Each test builds a fixture fleet (real `git init`) and creates resolve provenance via real
// `git` subprocess calls — same allowance as run.test.ts.
setDefaultTimeout(20_000);

const NOW = DEV_SOURCE_NOW;
const msg = (e: SkillSmithError): string => ('message' in e ? e.message : e.code);

const devRecordOf = (sourcePath: string): DevRecord => ({
  sourcePath,
  resolvedPath: sourcePath,
  repoRoot: null,
  sourceRelPath: null,
  remote: null,
  recordedAt: NOW,
});

describe('dev --source — state machine S1-S6 (P13 PRD)', () => {
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
    envVars: f.envVars,
    ...o,
  });

  const claudeRoot = (): string => join(f.home, '.claude', 'skills');
  const codexLegacyRoot = (): string => join(f.home, '.codex', 'skills');

  const readLedgerOf = async (): Promise<LedgerFile> => {
    const r = await readLedger(f.env, ledgerPathOf(f.data));
    if (!r.ok) throw new Error(msg(r.error));
    return r.value;
  };

  // ---------------------------------------------------------------------------------------------
  // S1 — absent placement: validate source -> verify gate -> symlink -> ledger dev record
  // ---------------------------------------------------------------------------------------------

  test('S1 (claude-code): absent placement -> created symlink + dev-only ledger record', async () => {
    const source = resolve(f.betaSrc); // 'beta' has no claude-code placement in the fixture fleet
    const r = await runDev(
      f.env,
      opts({ targets: ['beta'], tools: ['claude-code'], source }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const result = r.value.results[0];
    expect(actionV2(result)).toBe('created');
    expect(result?.placementPath).toBe(join(claudeRoot(), 'beta'));
    expect(summaryV2(r.value).created).toBe(1);

    expect(await f.env.pathKind(join(claudeRoot(), 'beta'))).toBe('symlink');
    expect(await readlink(join(claudeRoot(), 'beta'))).toBe(source);

    const pair = getPair(await readLedgerOf(), 'beta', 'claude-code');
    expect(pair?.mode).toBe('dev');
    expect(pair?.dev?.sourcePath).toBe(source);
    expect(pair?.dev?.resolvedPath).toBe(source);
    // Dev-only record: no pin, no journal, no origin (PRD ledger-record shape).
    expect(pair?.pinned ?? null).toBeNull();
    expect(pair?.journal ?? null).toBeNull();
    expect(pair?.origin).toBeUndefined();
  });

  test('S1 (codex): created at the T0-pinned default destination, not the legacy root', async () => {
    const source = resolve(f.alphaSrc); // 'alpha' has no codex placement in the fixture fleet
    const r = await runDev(
      f.env,
      opts({ targets: ['alpha'], tools: ['codex'], source }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const result = r.value.results[0];
    expect(actionV2(result)).toBe('created');

    const expectedPath = join(codexDefaultSkillsDestFor(f.home), 'alpha');
    expect(result?.placementPath).toBe(expectedPath);
    expect(await f.env.pathKind(expectedPath)).toBe('symlink');
    expect(await f.env.pathKind(join(codexLegacyRoot(), 'alpha'))).toBe('absent');

    const pair = getPair(await readLedgerOf(), 'alpha', 'codex');
    expect(pair?.placementPath).toBe(expectedPath);
    expect(pair?.mode).toBe('dev');
  });

  test('S1 (no --tool): creates for both default tools, in the fixed tool order', async () => {
    const source = await makeSkillSource(f.base, 'delta');
    const r = await runDev(f.env, opts({ targets: ['delta'], source }), passFlipDeps());
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results).toHaveLength(2);
    expect(r.value.results[0]?.tool).toBe('claude-code');
    expect(actionV2(r.value.results[0])).toBe('created');
    expect(r.value.results[1]?.tool).toBe('codex');
    expect(actionV2(r.value.results[1])).toBe('created');
    expect(summaryV2(r.value).created).toBe(2);

    expect(await f.env.pathKind(join(claudeRoot(), 'delta'))).toBe('symlink');
    expect(await f.env.pathKind(join(codexDefaultSkillsDestFor(f.home), 'delta'))).toBe('symlink');
  });

  test('S1 records git provenance in the dev record, like promote adoption', async () => {
    const source = resolve(f.betaSrc);
    const r = await runDev(
      f.env,
      opts({ targets: ['beta'], tools: ['claude-code'], source }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(actionV2(r.value.results[0])).toBe('created');

    const pair = getPair(await readLedgerOf(), 'beta', 'claude-code');
    expect(pair?.dev?.repoRoot).not.toBeNull();
    expect(pair?.dev?.remote).toBe('smorinlabs/fixture-harness');
    expect(pair?.dev?.sourceRelPath).toBe(join('plugins', 'fh', 'skills', 'beta'));
  });

  test('S1 from a non-git source records null repoRoot/remote (schema tolerates it)', async () => {
    const source = resolve(f.gammaSrc);
    const r = await runDev(
      f.env,
      opts({ targets: ['gamma'], tools: ['claude-code'], source }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(actionV2(r.value.results[0])).toBe('created');

    const pair = getPair(await readLedgerOf(), 'gamma', 'claude-code');
    expect(pair?.dev?.repoRoot).toBeNull();
    expect(pair?.dev?.remote).toBeNull();
    expect(pair?.dev?.sourceRelPath).toBeNull();
  });

  // ---------------------------------------------------------------------------------------------
  // S2 — matching hand-made symlink, not in the ledger: adopt (record-only, disk untouched)
  // ---------------------------------------------------------------------------------------------

  test('S2 (claude-code): matching unrecorded symlink -> adopted, record-only', async () => {
    const source = resolve(f.betaSrc);
    await symlink(source, join(claudeRoot(), 'beta'));

    const r = await runDev(
      f.env,
      opts({ targets: ['beta'], tools: ['claude-code'], source }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const result = r.value.results[0];
    expect(actionV2(result)).toBe('adopted');
    expect(summaryV2(r.value).adopted).toBe(1);

    // Disk untouched: still the same symlink, same literal target.
    expect(await f.env.pathKind(join(claudeRoot(), 'beta'))).toBe('symlink');
    expect(await readlink(join(claudeRoot(), 'beta'))).toBe(source);

    const pair = getPair(await readLedgerOf(), 'beta', 'claude-code');
    expect(pair?.mode).toBe('dev');
    expect(pair?.dev?.sourcePath).toBe(source);
    expect(pair?.pinned ?? null).toBeNull();
    expect(pair?.journal ?? null).toBeNull();
  });

  test('S2 (codex): simulated crash state (symlink present, no record) -> re-run adopts and converges', async () => {
    // D3 crash contract: create writes symlink first, ledger second; a crash between the two
    // leaves exactly this state. Re-running the same command must adopt (S2), not fail.
    const source = await makeSkillSource(f.base, 'epsilon');
    const dest = codexDefaultSkillsDestFor(f.home);
    await mkdir(dest, { recursive: true });
    await symlink(source, join(dest, 'epsilon'));

    const r = await runDev(
      f.env,
      opts({ targets: ['epsilon'], tools: ['codex'], source }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(actionV2(r.value.results[0])).toBe('adopted');

    const pair = getPair(await readLedgerOf(), 'epsilon', 'codex');
    expect(pair?.mode).toBe('dev');
    expect(pair?.dev?.sourcePath).toBe(source);
  });

  // ---------------------------------------------------------------------------------------------
  // S3 — recorded and matching: noop
  // ---------------------------------------------------------------------------------------------

  test('S3: recorded + matching -> noop; created/adopted counters stay 0', async () => {
    const source = resolve(f.alphaSrc); // fixture fleet already has ~/.claude/skills/alpha -> alphaSrc
    const ledger = emptyLedger(NOW);
    setPair(ledger, 'alpha', 'claude-code', {
      placementPath: join(claudeRoot(), 'alpha'),
      mode: 'dev',
      dev: devRecordOf(source),
      pinned: null,
      journal: null,
    });
    const w = await writeLedger(f.env, ledgerPathOf(f.data), ledger);
    if (!w.ok) throw new Error(msg(w.error));

    const r = await runDev(
      f.env,
      opts({ targets: ['alpha'], tools: ['claude-code'], source }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(actionV2(r.value.results[0])).toBe('noop');
    expect(summaryV2(r.value).noop).toBe(1);
    expect(summaryV2(r.value).created).toBe(0);
    expect(summaryV2(r.value).adopted).toBe(0);
  });

  // ---------------------------------------------------------------------------------------------
  // S4 — symlink target != resolved source: refuse, never silently repoint
  // ---------------------------------------------------------------------------------------------

  test('S4: mismatched symlink target -> refused (exit-2 class), disk and ledger untouched', async () => {
    const linkTarget = resolve(f.betaSrc);
    await symlink(linkTarget, join(claudeRoot(), 'mismatch'));

    const r = await runDev(
      f.env,
      opts({ targets: ['mismatch'], tools: ['claude-code'], source: resolve(f.alphaSrc) }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const result = r.value.results[0];
    expect(actionV2(result)).toBe('refused');
    expect(result?.error?.code).toBe('flip-refused');

    // Never silently repointed; no record written for the pair.
    expect(await readlink(join(claudeRoot(), 'mismatch'))).toBe(linkTarget);
    expect(getPair(await readLedgerOf(), 'mismatch', 'claude-code')).toBeNull();
  });

  test("S4 refusal on one tool does not stop the other tool's pair (P12 independence)", async () => {
    const source = await makeSkillSource(f.base, 'indy');
    // claude-code: mismatched hand-made symlink; codex: absent -> should still create.
    await symlink(resolve(f.betaSrc), join(claudeRoot(), 'indy'));

    const r = await runDev(f.env, opts({ targets: ['indy'], source }), passFlipDeps());
    if (!r.ok) throw new Error(msg(r.error));
    const claude = r.value.results.find((res) => res.tool === 'claude-code');
    const codex = r.value.results.find((res) => res.tool === 'codex');
    expect(actionV2(claude)).toBe('refused');
    expect(actionV2(codex)).toBe('created');
    expect(summaryV2(r.value).created).toBe(1);
    expect(summaryV2(r.value).refused).toBe(1);
  });

  // ---------------------------------------------------------------------------------------------
  // S5 — pinned placement: unchanged P12 flip behavior; recorded-source mismatch refuses
  // ---------------------------------------------------------------------------------------------

  test('S5a: pinned with no recorded source + --source -> P12 flip (not create/adopt)', async () => {
    const r = await runDev(
      f.env,
      opts({ targets: ['copied'], tools: ['claude-code'], source: resolve(f.alphaSrc) }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(actionV2(r.value.results[0])).toBe('flipped');
    expect(summaryV2(r.value).flipped).toBe(1);
    expect(summaryV2(r.value).created).toBe(0);
    expect(summaryV2(r.value).adopted).toBe(0);
    expect(await f.env.pathKind(join(claudeRoot(), 'copied'))).toBe('symlink');
  });

  // PRD S5: "recorded-source mismatch -> refuse". NOTE: this pins a behavior CHANGE from P12,
  // whose spec (§4.2) and test (run.test.ts "--source disagreeing with the recorded source wins")
  // let --source win and update the record. T3 must reconcile that existing test with this row.
  test('S5b: pinned with a recorded source that mismatches --source -> refused', async () => {
    const ledger = emptyLedger(NOW);
    setPair(ledger, 'copied', 'claude-code', {
      placementPath: join(claudeRoot(), 'copied'),
      mode: 'pinned',
      dev: devRecordOf(resolve(f.betaSrc)),
      pinned: null,
      journal: null,
    });
    const w = await writeLedger(f.env, ledgerPathOf(f.data), ledger);
    if (!w.ok) throw new Error(msg(w.error));

    const r = await runDev(
      f.env,
      opts({ targets: ['copied'], tools: ['claude-code'], source: resolve(f.alphaSrc) }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const result = r.value.results[0];
    expect(actionV2(result)).toBe('refused');
    expect(result?.error?.code).toBe('flip-refused');
    expect(await f.env.pathKind(join(claudeRoot(), 'copied'))).toBe('dir');
  });

  // ---------------------------------------------------------------------------------------------
  // S6 — foreign object at the placement path: refuse
  // ---------------------------------------------------------------------------------------------

  test('S6: a regular file at the placement path -> refused (foreign object), file untouched', async () => {
    await writeFile(join(claudeRoot(), 'filey'), 'not a skill\n');

    const r = await runDev(
      f.env,
      opts({ targets: ['filey'], tools: ['claude-code'], source: resolve(f.alphaSrc) }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const result = r.value.results[0];
    expect(actionV2(result)).toBe('refused');
    expect(result?.error?.code).toBe('flip-refused');
    expect(await f.env.pathKind(join(claudeRoot(), 'filey'))).toBe('file');
  });
});

describe('dev --source — resolution, --dest, dual-location, warnings (P13 PRD)', () => {
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
    envVars: f.envVars,
    ...o,
  });

  const claudeRoot = (): string => join(f.home, '.claude', 'skills');

  const readLedgerOf = async (): Promise<LedgerFile> => {
    const r = await readLedger(f.env, ledgerPathOf(f.data));
    if (!r.ok) throw new Error(msg(r.error));
    return r.value;
  };

  test('a relative --source is resolved to an absolute path before any use or recording', async () => {
    await makeSkillSource(f.base, 'zeta');
    const expected = resolve(f.base, 'srcs', 'zeta');

    const r = await runDev(
      f.env,
      opts({
        targets: ['zeta'],
        tools: ['claude-code'],
        source: join('srcs', 'zeta'),
        cwd: f.base,
      }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(actionV2(r.value.results[0])).toBe('created');

    expect(await readlink(join(claudeRoot(), 'zeta'))).toBe(expected);
    const pair = getPair(await readLedgerOf(), 'zeta', 'claude-code');
    expect(pair?.dev?.sourcePath).toBe(expected);
    expect(pair?.dev?.resolvedPath).toBe(expected);
    expect(isAbsolute(pair?.dev?.sourcePath ?? '')).toBe(true);
  });

  test('--dest overrides the created placement location; recorded placementPath reflects it', async () => {
    const dest = join(f.base, 'custom-skills');
    await mkdir(dest, { recursive: true });
    const source = resolve(f.betaSrc);

    const r = await runDev(
      f.env,
      opts({ targets: ['beta'], tools: ['claude-code'], source, dest }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const result = r.value.results[0];
    expect(actionV2(result)).toBe('created');
    expect(result?.placementPath).toBe(join(dest, 'beta'));

    expect(await f.env.pathKind(join(dest, 'beta'))).toBe('symlink');
    expect(await f.env.pathKind(join(claudeRoot(), 'beta'))).toBe('absent');

    const pair = getPair(await readLedgerOf(), 'beta', 'claude-code');
    expect(pair?.placementPath).toBe(join(dest, 'beta'));
  });

  test('codex dual-location: present in both roots -> refused, nothing created or recorded', async () => {
    // 'dup' is a real dir in BOTH codex roots in the fixture fleet.
    const source = await makeSkillSource(f.base, 'dup');
    const r = await runDev(
      f.env,
      opts({ targets: ['dup'], tools: ['codex'], source }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const result = r.value.results[0];
    expect(actionV2(result)).toBe('refused');
    expect(result?.reason).toContain('.agents/skills');
    expect(result?.reason).toContain('.codex/skills');
    expect(summaryV2(r.value).created).toBe(0);
    expect(getPair(await readLedgerOf(), 'dup', 'codex')).toBeNull();
  });

  test('codex legacy-root-only symlink: adopted in place — never a second symlink in the current root', async () => {
    // 'legacy-only' is a hand-made symlink to alphaSrc in ~/.codex/skills only. Creating a second
    // placement at the modern default would violate the never-two-codex-locations rule (D1).
    const source = resolve(f.alphaSrc);
    const legacyPath = join(f.home, '.codex', 'skills', 'legacy-only');

    const r = await runDev(
      f.env,
      opts({ targets: ['legacy-only'], tools: ['codex'], source }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const result = r.value.results[0];
    expect(actionV2(result)).toBe('adopted');
    expect(result?.placementPath).toBe(legacyPath);

    expect(await f.env.pathKind(join(codexDefaultSkillsDestFor(f.home), 'legacy-only'))).toBe(
      'absent',
    );
    const pair = getPair(await readLedgerOf(), 'legacy-only', 'codex');
    expect(pair?.placementPath).toBe(legacyPath);
  });

  test('source basename != placement name -> warning on the result, not a refusal', async () => {
    const source = resolve(f.alphaSrc); // basename 'alpha', placement name 'renamed'
    const r = await runDev(
      f.env,
      opts({ targets: ['renamed'], tools: ['claude-code'], source }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const result = r.value.results[0];
    expect(actionV2(result)).toBe('created');
    expect(result?.reason ?? '').toMatch(/basename/i);
  });
});

describe('dev --source — idempotency, dry-run, ledger-shape legality (P13 PRD)', () => {
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
    envVars: f.envVars,
    ...o,
  });

  const claudeRoot = (): string => join(f.home, '.claude', 'skills');

  test('idempotent: S1 create, then an identical re-run -> S3 noop', async () => {
    const source = resolve(f.betaSrc);
    const first = await runDev(
      f.env,
      opts({ targets: ['beta'], tools: ['claude-code'], source }),
      passFlipDeps(),
    );
    if (!first.ok) throw new Error(msg(first.error));
    expect(actionV2(first.value.results[0])).toBe('created');

    const second = await runDev(
      f.env,
      opts({ targets: ['beta'], tools: ['claude-code'], source }),
      passFlipDeps(),
    );
    if (!second.ok) throw new Error(msg(second.error));
    expect(actionV2(second.value.results[0])).toBe('noop');
    expect(summaryV2(second.value).created).toBe(0);
    expect(await readlink(join(claudeRoot(), 'beta'))).toBe(source);
  });

  test('--dry-run predicts created without writing (no symlink, no ledger)', async () => {
    const source = resolve(f.betaSrc);
    const r = await runDev(
      f.env,
      opts({ targets: ['beta'], tools: ['claude-code'], source, dryRun: true }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.dryRun).toBe(true);
    expect(actionV2(r.value.results[0])).toBe('created');

    expect(await f.env.pathKind(join(claudeRoot(), 'beta'))).toBe('absent');
    expect(await f.env.pathKind(ledgerPathOf(f.data))).toBe('absent');
  });

  test('--dry-run predicts adopted for a matching unrecorded symlink, writes nothing', async () => {
    const source = resolve(f.betaSrc);
    await symlink(source, join(claudeRoot(), 'beta'));

    const r = await runDev(
      f.env,
      opts({ targets: ['beta'], tools: ['claude-code'], source, dryRun: true }),
      passFlipDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(actionV2(r.value.results[0])).toBe('adopted');
    expect(await f.env.pathKind(ledgerPathOf(f.data))).toBe('absent');
  });

  test('a dev-only pair with pinned/journal keys omitted is a legal ledger shape', async () => {
    // PRD: S1/S2 write the dev record with "no pinned and no journal field — a new legal shape".
    const placementPath = join(claudeRoot(), 'iota');
    const raw = {
      schemaVersion: 1,
      kind: 'skillsmith.placements',
      updatedAt: NOW,
      skills: {
        iota: {
          tools: {
            'claude-code': {
              placementPath,
              mode: 'dev',
              dev: {
                sourcePath: resolve(f.alphaSrc),
                resolvedPath: resolve(f.alphaSrc),
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

    const r = await readLedger(f.env, ledgerPathOf(f.data));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const pair = getPair(r.value, 'iota', 'claude-code');
      expect(pair?.mode).toBe('dev');
      expect(pair?.pinned ?? null).toBeNull();
      expect(pair?.journal ?? null).toBeNull();
    }
  });
});
