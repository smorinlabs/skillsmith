import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { join, resolve } from 'node:path';
import { runInstall, runUninstall } from '../../src/acquire/run.ts';
import type { InstallDeps, InstallOptions } from '../../src/acquire/types.ts';
import type { InstallRecord } from '../../src/agents/types.ts';
import type { SkillSmithError } from '../../src/errors.ts';
import { getPairAt, readLedger } from '../../src/place/ledger.ts';
import { ledgerPathOf } from '../../src/place/paths.ts';
import { runDev, runPromote, runRollback } from '../../src/place/run.ts';
import { contentHashOf } from '../../src/place/store.ts';
import type { FlipDeps, FlipOptions } from '../../src/place/types.ts';
import { ok } from '../../src/result.ts';
import { VERIFIED_AGAINST, type VerifyReport } from '../../src/verify/types.ts';
import {
  type RemoteFixture,
  buildRemoteFixture,
  destroyRemoteFixture,
} from '../fixtures/acquire/remote.ts';
import { hermeticGitEnv } from '../fixtures/git-env.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../fixtures/place/fleet.ts';

// PRD §10 acceptance, scenario 4 (install <-> dev/promote/rollback/uninstall round trip) driven
// through the REAL public entry points of BOTH modules (acquire's runInstall/runUninstall and
// place's runDev/runPromote/runRollback) against the SAME hermetic ledger — this is what makes it
// an "interop" test rather than a duplicate of store-linked-flip.test.ts (which hand-seeds the
// ledger to isolate the D9 mechanics). Here the pair genuinely originates from a fetched `file://`
// remote via runInstall, proving the two modules agree on the on-disk/ledger contract they share.
setDefaultTimeout(60_000);

const NOW = '2026-07-08T00:00:00Z';
const msg = (e: SkillSmithError): string => ('message' in e ? e.message : e.code);
const CLAUDE_ONLY = ['claude-code'] as const;

const detectClaudeOnly: InstallDeps['detect'] = async (_env, tool) =>
  tool === 'claude-code'
    ? ok<InstallRecord[]>([
        { path: '/usr/local/bin/claude-code', version: '1.0.0', installMethod: 'unknown' },
      ])
    : ok<InstallRecord[]>([]);

const passVerify: InstallDeps['verify'] = async (_env, opts) => {
  const tools = opts.tools ?? [];
  const tool = tools[0] ?? 'claude-code';
  const report: VerifyReport = {
    schemaVersion: 1,
    target: { path: opts.path, kind: 'skill' },
    requested: {
      tools: [...tools],
      modes: opts.deep ? ['static', 'deep'] : ['static'],
      strict: opts.strict ?? false,
      explicitTools: true,
    },
    verifiedAgainst: VERIFIED_AGAINST,
    summary: {
      verdict: 'pass',
      verified: [tool],
      failed: [],
      skipped: [],
      counts: { error: 0, warning: 0, info: 0 },
    },
    tools: [
      {
        tool,
        available: true,
        toolVersion: '1.0.0',
        versionDrift: false,
        skipReason: null,
        verdict: 'pass',
        modes: [],
      },
    ],
  };
  return ok(report);
};

let installN = 0;
const installDeps = (): InstallDeps => ({
  verify: passVerify,
  detect: detectClaudeOnly,
  transport: fixture.transport,
  now: () => NOW,
  newTxId: () => (0x10000000 + installN++).toString(16).slice(-8),
});

let flipN = 0;
// dev/promote/rollback all run with `noVerify: true` in these tests — the verify gate itself is
// Task 3/8's concern; a `verify` that throws is a canary that guards against a silent gate re-run.
const flipDeps = (): FlipDeps => ({
  now: () => NOW,
  newTxId: () => (0x50000000 + flipN++).toString(16).slice(-8),
  verify: async () => {
    throw new Error('verify should not run under --no-verify');
  },
});

let uninstallN = 0;
const uninstallDeps = () => ({
  now: () => NOW,
  newTxId: () => (0x40000000 + uninstallN++).toString(16).slice(-8),
});

const runGit = (cwd: string, args: string[]): void => {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: hermeticGitEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(result.stderr)}`);
  }
};

const commitAll = (checkout: string, message: string): void => {
  runGit(checkout, [
    '-c',
    'user.email=fixture@skillsmith.test',
    '-c',
    'user.name=fixture',
    '-c',
    'commit.gpgsign=false',
    'add',
    '-A',
  ]);
  runGit(checkout, [
    '-c',
    'user.email=fixture@skillsmith.test',
    '-c',
    'user.name=fixture',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    message,
  ]);
};

let fixture: RemoteFixture;
beforeAll(async () => {
  fixture = await buildRemoteFixture();
});
afterAll(async () => {
  await destroyRemoteFixture(fixture);
});

let f: FixtureFleet;
let fsSource: string;
beforeEach(async () => {
  f = await buildFixtureFleet();
  fsSource = `${fixture.multiSource}//plugins/fh/skills/factor-scan`;
});
afterEach(async () => {
  await destroyFixtureFleet(f);
});

const claudeLink = (): string => join(f.home, '.claude', 'skills', 'factor-scan');
const led = async () => {
  const r = await readLedger(f.env, ledgerPathOf(f.data));
  if (!r.ok) throw new Error(msg(r.error));
  return r.value;
};
const pair = async () => getPairAt(await led(), null, 'factor-scan', 'claude-code');
// The dev source used throughout: multiWork's real, on-disk factor-scan checkout (a genuine git
// working tree — `runDev`'s provenance resolution needs a real repo to classify git-clean/dirty).
const devSourcePath = (): string =>
  resolve(fixture.multiWork, 'plugins', 'fh', 'skills', 'factor-scan');

describe('interop round-trip — PRD scenario 4 at USER scope (O1: user-scope only in v0.6.0)', () => {
  test('install -> dev --source -> edit+promote (D9 re-pin) -> noop -> rollback -> uninstall --force retains both store revs', async () => {
    const installOpts: InstallOptions = {
      sources: [fsSource],
      tools: CLAUDE_ONLY,
      cwd: f.base,
      configuration: f.configuration,
    };

    // --- 1. runInstall -> store symlink placement ---
    const ins = await runInstall(f.env, installOpts, installDeps());
    if (!ins.ok) throw new Error(msg(ins.error));
    expect(ins.value.results[0]?.action).toBe('installed');
    expect(ins.value.results[0]?.placement).toBe('symlink');
    expect(await f.env.pathKind(claudeLink())).toBe('symlink');

    const p1 = await pair();
    if (!p1?.pinned || !p1.origin) throw new Error('expected a pinned+origin pair after install');
    const storeR1 = p1.pinned.storePath;
    const revR1 = p1.pinned.rev;
    const originalOrigin = p1.origin;
    const originalPinned = p1.pinned;
    expect(await f.env.readLink(claudeLink())).toBe(storeR1);
    expect(originalOrigin.repo.includes('/')).toBe(true);
    expect(originalOrigin.skillPath).toBe('plugins/fh/skills/factor-scan');

    // --- 2. runDev --source <checkout> -> live is a dev symlink; pinned + origin retained ---
    const devSrc = devSourcePath();
    const flipOpts = (o: Partial<FlipOptions> = {}): FlipOptions => ({
      targets: ['factor-scan'],
      tools: CLAUDE_ONLY,
      noVerify: true,
      cwd: f.home,
      configuration: f.configuration,
      ...o,
    });
    const d1 = await runDev(f.env, flipOpts({ source: devSrc }), flipDeps());
    if (!d1.ok) throw new Error(msg(d1.error));
    expect(d1.value.results[0]?.action).toBe('flipped');
    expect(await f.env.pathKind(claudeLink())).toBe('symlink');
    expect(await f.env.readLink(claudeLink())).toBe(devSrc);

    const p2 = await pair();
    expect(p2?.mode).toBe('dev');
    expect(p2?.pinned).toEqual(originalPinned); // retained verbatim
    expect(p2?.origin).toEqual(originalOrigin); // retained verbatim

    // --- 3. edit + commit in multiWork, then runPromote -> store symlink AGAIN (D9), new rev,
    //     origin retained verbatim, pinned.placement: 'symlink' ---
    await Bun.write(
      join(fixture.multiWork, 'plugins', 'fh', 'skills', 'factor-scan', 'SKILL.md'),
      '---\nname: factor-scan\ndescription: Fixture skill v2.\n---\n\n# factor-scan v2\n',
    );
    commitAll(fixture.multiWork, 'fixture: factor-scan v2');

    const pr1 = await runPromote(f.env, flipOpts(), flipDeps());
    if (!pr1.ok) throw new Error(msg(pr1.error));
    expect(pr1.value.results[0]?.action).toBe('updated');
    expect(await f.env.pathKind(claudeLink())).toBe('symlink');
    const storeR2 = pr1.value.results[0]?.store?.path;
    if (!storeR2) throw new Error('expected a store path on the re-pin result');
    expect(storeR2).not.toBe(storeR1);
    expect(await f.env.readLink(claudeLink())).toBe(storeR2);

    const p3 = await pair();
    expect(p3?.mode).toBe('pinned');
    expect(p3?.pinned?.placement).toBe('symlink');
    expect(p3?.pinned?.rev).not.toBe(revR1);
    expect(p3?.origin).toEqual(originalOrigin); // retained verbatim, unchanged by the dev-mode edit
    // D9's re-pin runs an 'install'-shaped swap under the hood (a fresh store symlink), which
    // nulls the journal at its terminal write — unlike a plain promote/dev swap, which leaves a
    // committed record at rest (see step 5 below).
    expect(p3?.journal).toBeNull();
    const revR2 = p3?.pinned?.rev;
    const contentHashR2 = p3?.pinned?.contentHash;
    if (!revR2 || !contentHashR2) throw new Error('expected a pinned rev/contentHash after re-pin');

    // --- 4. runPromote again (source unedited since step 3) -> lossless noop, rev unchanged.
    //     (Exercised via the store-linked class: live is still the re-pinned store symlink from
    //     step 3 — the same "second promote in a row" shape scenario 4's PRD text describes. A
    //     further `runDev` here would flip live back to a literal dev symlink, and — because
    //     `runRollback` is direction-agnostic per the pair's CURRENT mode (D10) — that would make
    //     step 5 below converge dev->pinned instead of the pinned->dev "dev symlink restored"
    //     outcome PRD scenario 4 calls for. So the lossless check runs here, before the rollback,
    //     against the mode the pair is actually in.) ---
    const pr2 = await runPromote(f.env, flipOpts(), flipDeps());
    if (!pr2.ok) throw new Error(msg(pr2.error));
    expect(pr2.value.results[0]?.action).toBe('noop');
    const p4 = await pair();
    expect(p4?.pinned?.rev).toBe(revR2); // lossless: unchanged

    // --- 5. runRollback (op promote) -> dev symlink restored byte-identically ---
    const rb = await runRollback(f.env, { ...flipOpts(), op: 'promote' }, flipDeps());
    if (!rb.ok) throw new Error(msg(rb.error));
    expect(rb.value.results[0]?.action).toBe('rolled-back');
    expect(await f.env.pathKind(claudeLink())).toBe('symlink');
    expect(await f.env.readLink(claudeLink())).toBe(devSrc); // literal target, byte-identical

    const p5 = await pair();
    expect(p5?.mode).toBe('dev');
    // A plain flip's commit leaves a committed journal record at rest (an audit trail) rather
    // than nulling it — only install/uninstall's terminal write nulls/deletes it (P12 shape).
    expect(p5?.journal?.phase).toBe('committed');

    // --- 6. runUninstall --force (dev-mode) -> placement gone, pair gone, BOTH store revs
    //     still on disk with matching content hashes (store immortality) ---
    const un = await runUninstall(
      f.env,
      {
        targets: ['factor-scan'],
        tools: CLAUDE_ONLY,
        force: true,
        cwd: f.base,
        configuration: f.configuration,
      },
      uninstallDeps(),
    );
    if (!un.ok) throw new Error(msg(un.error));
    expect(un.value.results[0]?.action).toBe('removed');
    expect(await f.env.pathKind(claudeLink())).toBe('absent');
    const afterUninstall = await led();
    expect(getPairAt(afterUninstall, null, 'factor-scan', 'claude-code')).toBeNull();

    expect(await f.env.pathKind(storeR1)).not.toBe('absent');
    expect(await f.env.pathKind(storeR2)).not.toBe('absent');
    const h1 = await contentHashOf(f.env, storeR1);
    const h2 = await contentHashOf(f.env, storeR2);
    if (!h1.ok) throw new Error(msg(h1.error));
    if (!h2.ok) throw new Error(msg(h2.error));
    expect(h1.value).toBe(originalPinned.contentHash);
    expect(h2.value).toBe(contentHashR2);
    expect(h1.value).not.toBe(h2.value); // genuinely different content, not just a different label

    // the dev checkout itself is never touched by uninstall
    expect(await f.env.pathKind(join(devSrc, 'SKILL.md'))).toBe('file');
  }, 60_000);
});

describe('interop round-trip — PRD scenario 5 (deliberate up/downgrade via --force --ref)', () => {
  test('install at HEAD -> --force --ref v1.0.0 (downgrade) -> --force back to HEAD (upgrade); both store entries coexist', async () => {
    const baseOpts: InstallOptions = {
      sources: [fsSource],
      tools: CLAUDE_ONLY,
      cwd: f.base,
      configuration: f.configuration,
    };

    const r1 = await runInstall(f.env, baseOpts, installDeps());
    if (!r1.ok) throw new Error(msg(r1.error));
    expect(r1.value.results[0]?.action).toBe('installed');
    const p1 = await pair();
    if (!p1?.pinned) throw new Error('expected a pinned pair after install');
    expect(p1.pinned.rev).toBe(fixture.multiHead.slice(0, 12));
    const storeHead = p1.pinned.storePath;

    const r2 = await runInstall(f.env, { ...baseOpts, force: true, ref: 'v1.0.0' }, installDeps());
    if (!r2.ok) throw new Error(msg(r2.error));
    expect(r2.value.results[0]?.action).toBe('updated');
    const p2 = await pair();
    if (!p2?.pinned || !p2.origin) throw new Error('expected a pinned+origin pair after downgrade');
    expect(p2.pinned.rev).toBe(fixture.multiTagSha.slice(0, 12));
    expect(p2.origin.refRequested).toBe('v1.0.0');
    expect(p2.origin.refResolved).toBe(fixture.multiTagSha);
    const storeTag = p2.pinned.storePath;
    expect(storeTag).not.toBe(storeHead);

    const r3 = await runInstall(f.env, { ...baseOpts, force: true }, installDeps());
    if (!r3.ok) throw new Error(msg(r3.error));
    expect(r3.value.results[0]?.action).toBe('updated');
    const p3 = await pair();
    expect(p3?.pinned?.rev).toBe(fixture.multiHead.slice(0, 12));
    expect(p3?.pinned?.storePath).toBe(storeHead); // re-converges to the SAME (immortal) store entry

    // Both store entries coexist on disk with genuinely different content (v1.0.0 predates the
    // commit that added factor-scan/bin/run.sh).
    expect(await f.env.pathKind(storeHead)).not.toBe('absent');
    expect(await f.env.pathKind(storeTag)).not.toBe('absent');
    expect(await f.env.pathKind(join(storeHead, 'bin', 'run.sh'))).toBe('file');
    expect(await f.env.pathKind(join(storeTag, 'bin', 'run.sh'))).toBe('absent');
  });
});
