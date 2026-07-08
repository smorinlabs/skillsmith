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
import { lstat, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { runInstall } from '../../src/acquire/run.ts';
import { parseSource } from '../../src/acquire/source.ts';
import type { CandidateSkill, InstallDeps, InstallOptions } from '../../src/acquire/types.ts';
import type { InstallRecord } from '../../src/agents/types.ts';
import type { ExecResult, ScanEnv } from '../../src/env/types.ts';
import type { SkillSmithError } from '../../src/errors.ts';
import { getPairAt, readLedger, writeLedger } from '../../src/place/ledger.ts';
import { ledgerPathOf } from '../../src/place/paths.ts';
import type { Journal } from '../../src/place/types.ts';
import { ok } from '../../src/result.ts';
import { VERIFIED_AGAINST, type VerifyReport } from '../../src/verify/types.ts';
import {
  type RemoteFixture,
  buildRemoteFixture,
  destroyRemoteFixture,
} from '../fixtures/acquire/remote.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../fixtures/place/fleet.ts';

setDefaultTimeout(60_000);

const NOW = '2026-07-08T00:00:00Z';
const msg = (e: SkillSmithError): string => ('message' in e ? e.message : e.code);

const detectBoth: InstallDeps['detect'] = async (_env, tool) =>
  ok<InstallRecord[]>([
    { path: `/usr/local/bin/${tool}`, version: '1.0.0', installMethod: 'unknown' },
  ]);

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

const makeDeps = (over: Partial<InstallDeps> = {}): InstallDeps => {
  let n = 0;
  return {
    verify: passVerify,
    detect: detectBoth,
    now: () => NOW,
    newTxId: () => (0x10000000 + n++).toString(16).slice(-8),
    ...over,
  };
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
let userOpts: InstallOptions;
beforeEach(async () => {
  f = await buildFixtureFleet();
  fsSource = `${fixture.multiUrl}//plugins/fh/skills/factor-scan`;
  userOpts = { sources: [fsSource], cwd: f.base, envVars: f.envVars };
});
afterEach(async () => {
  await destroyFixtureFleet(f);
});

const claudeRoot = (): string => join(f.home, '.claude', 'skills');
const agentsRoot = (): string => join(f.home, '.agents', 'skills');
const legacyRoot = (): string => join(f.home, '.codex', 'skills');
const led = async () => {
  const r = await readLedger(f.env, ledgerPathOf(f.data));
  if (!r.ok) throw new Error(msg(r.error));
  return r.value;
};
const fetchDirs = async (): Promise<readonly string[]> => {
  const dir = join(f.data, '.fetch');
  if ((await f.env.pathKind(dir)) === 'absent') return [];
  return f.env.listDir(dir);
};

describe('runInstall — fresh install', () => {
  test('symlink placement into both tool roots, full origin, shared store, exec + symlink preserved', async () => {
    const r = await runInstall(f.env, userOpts, makeDeps());
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.summary.installed).toBe(2);

    const claudeLink = join(claudeRoot(), 'factor-scan');
    const agentsLink = join(agentsRoot(), 'factor-scan');
    expect(await f.env.pathKind(claudeLink)).toBe('symlink');
    expect(await f.env.pathKind(agentsLink)).toBe('symlink');

    const ledger = await led();
    const ccPair = getPairAt(ledger, null, 'factor-scan', 'claude-code');
    const cxPair = getPairAt(ledger, null, 'factor-scan', 'codex');
    expect(ccPair?.pinned?.placement).toBe('symlink');
    expect(cxPair?.pinned?.placement).toBe('symlink');
    expect(await readlink(claudeLink)).toBe(ccPair?.pinned?.storePath as string);

    // full origin: unclamped repo (multi-segment), literal source, resolved HEAD, HEAD => null ref
    const expectedRepo = parseSource(fsSource).ok
      ? (parseSource(fsSource) as { ok: true; value: { repoPath: string } }).value.repoPath
      : '';
    expect(ccPair?.origin?.repo).toBe(expectedRepo);
    expect(ccPair?.origin?.repo.includes('/')).toBe(true);
    expect(ccPair?.origin?.source).toBe(fsSource);
    expect(ccPair?.origin?.skillPath).toBe('plugins/fh/skills/factor-scan');
    expect(ccPair?.origin?.refRequested).toBeNull();
    expect(ccPair?.origin?.refResolved).toBe(fixture.multiHead);
    expect(ccPair?.pinned?.gitSha).toBe(fixture.multiHead);
    expect(ccPair?.pinned?.rev).toBe(fixture.multiHead.slice(0, 12));

    // store entry preserves exec bit + relative symlink
    const storePath = ccPair?.pinned?.storePath as string;
    const runStat = await lstat(join(storePath, 'bin', 'run.sh'));
    expect((runStat.mode & 0o100) !== 0).toBe(true);
    const linkStat = await lstat(join(storePath, 'link.md'));
    expect(linkStat.isSymbolicLink()).toBe(true);
    expect(await readlink(join(storePath, 'link.md'))).toBe('SKILL.md');

    // store shared: first tool fresh (reused false), second reuses
    const cc = r.value.results.find((x) => x.tool === 'claude-code');
    const cx = r.value.results.find((x) => x.tool === 'codex');
    expect(cc?.store?.reused).toBe(false);
    expect(cx?.store?.reused).toBe(true);
    expect(cx?.store?.path).toBe(cc?.store?.path);
    expect(await fetchDirs()).toEqual([]);
  });

  test('--direct → real dir placements, placement copy, content matches store entry', async () => {
    const r = await runInstall(f.env, { ...userOpts, direct: true }, makeDeps());
    if (!r.ok) throw new Error(msg(r.error));
    const claudeDir = join(claudeRoot(), 'factor-scan');
    expect(await f.env.pathKind(claudeDir)).toBe('dir');
    const ledger = await led();
    const pair = getPairAt(ledger, null, 'factor-scan', 'claude-code');
    expect(pair?.pinned?.placement).toBe('copy');
    const r1 = r.value.results.find((x) => x.tool === 'claude-code');
    expect(r1?.placement).toBe('copy');
    expect(await f.env.pathKind(join(claudeDir, 'SKILL.md'))).toBe('file');
  });
});

describe('runInstall — idempotence / update / repair', () => {
  test('idempotent re-run → both noop; --force same rev → updated', async () => {
    const r1 = await runInstall(f.env, userOpts, makeDeps());
    if (!r1.ok) throw new Error(msg(r1.error));
    expect(r1.value.summary.installed).toBe(2);

    const r2 = await runInstall(f.env, userOpts, makeDeps());
    if (!r2.ok) throw new Error(msg(r2.error));
    expect(r2.value.summary.noop).toBe(2);
    expect(r2.value.results[0]?.reason).toContain('already installed');

    const r3 = await runInstall(f.env, { ...userOpts, force: true }, makeDeps());
    if (!r3.ok) throw new Error(msg(r3.error));
    expect(r3.value.summary.updated).toBe(2);
  });

  test('--ref v1.0.0 --force → updated at the tag rev (deliberate downgrade)', async () => {
    const r1 = await runInstall(f.env, userOpts, makeDeps());
    if (!r1.ok) throw new Error(msg(r1.error));
    const r2 = await runInstall(f.env, { ...userOpts, ref: 'v1.0.0', force: true }, makeDeps());
    if (!r2.ok) throw new Error(msg(r2.error));
    expect(r2.value.summary.updated).toBe(2);
    const ledger = await led();
    const pair = getPairAt(ledger, null, 'factor-scan', 'claude-code');
    expect(pair?.pinned?.rev).toBe(fixture.multiTagSha.slice(0, 12));
    expect(pair?.origin?.refRequested).toBe('v1.0.0');
    expect(pair?.origin?.refResolved).toBe(fixture.multiTagSha);
  });

  test('--direct re-install over an existing copy (dir→dir) is routed as a kind change → updated', async () => {
    const r1 = await runInstall(f.env, { ...userOpts, direct: true }, makeDeps());
    if (!r1.ok) throw new Error(msg(r1.error));
    expect(r1.value.summary.installed).toBe(2);
    const claudeDir = join(claudeRoot(), 'factor-scan');
    expect(await f.env.pathKind(claudeDir)).toBe('dir');

    // re-install --direct --force: live is a real dir, new build is a copy (dir) — the engine would
    // reject a same-kind dir→dir replace, so the run layer routes it via a store-symlink intermediate.
    const r2 = await runInstall(f.env, { ...userOpts, direct: true, force: true }, makeDeps());
    if (!r2.ok) throw new Error(msg(r2.error));
    expect(r2.value.summary.updated).toBe(2);
    // ends as a real dir copy, fully committed (no journal), no residue
    expect(await f.env.pathKind(claudeDir)).toBe('dir');
    expect(await f.env.pathKind(join(claudeDir, 'SKILL.md'))).toBe('file');
    const ledger = await led();
    const pair = getPairAt(ledger, null, 'factor-scan', 'claude-code');
    expect(pair?.pinned?.placement).toBe('copy');
    expect(pair?.journal).toBeNull();
    const residue = (await f.env.listDir(claudeRoot())).filter((n) => n.startsWith('.skillsmith-'));
    expect(residue).toEqual([]);
  });

  test('repaired: ledger pair deleted, placement intact → repaired with no placement mutation', async () => {
    const r1 = await runInstall(f.env, userOpts, makeDeps());
    if (!r1.ok) throw new Error(msg(r1.error));
    const claudeLink = join(claudeRoot(), 'factor-scan');
    const before = await lstat(claudeLink);
    const beforeTarget = await readlink(claudeLink);

    // delete the ledger pairs, leave placements intact on disk
    const ledger = await led();
    Reflect.deleteProperty(ledger.skills, 'factor-scan');
    const w = await writeLedger(f.env, ledgerPathOf(f.data), ledger);
    if (!w.ok) throw new Error(msg(w.error));

    const r2 = await runInstall(f.env, userOpts, makeDeps());
    if (!r2.ok) throw new Error(msg(r2.error));
    expect(r2.value.summary.repaired).toBe(2);

    // placement untouched (same target), no staging/backup residue
    const after = await lstat(claudeLink);
    expect(await readlink(claudeLink)).toBe(beforeTarget);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    const residue = (await f.env.listDir(claudeRoot())).filter((n) => n.startsWith('.skillsmith-'));
    expect(residue).toEqual([]);
    // record rewritten
    const ledger2 = await led();
    expect(getPairAt(ledger2, null, 'factor-scan', 'claude-code')?.origin?.refResolved).toBe(
      fixture.multiHead,
    );
  });
});

describe('runInstall — scope', () => {
  test('project scope inside a work tree; pair keyed by realpath; user tree untouched', async () => {
    const r = await runInstall(
      f.env,
      { sources: [fsSource], cwd: f.project, envVars: f.envVars },
      makeDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.requested.scope).toBe('project');
    expect(r.value.requested.explicitScope).toBe(false);

    expect(await f.env.pathKind(join(f.project, '.claude', 'skills', 'factor-scan'))).toBe(
      'symlink',
    );
    const ledger = await led();
    expect(getPairAt(ledger, f.projectReal, 'factor-scan', 'claude-code')?.mode).toBe('pinned');
    expect(getPairAt(ledger, null, 'factor-scan', 'claude-code')).toBeNull();
  });

  test('default scope is user outside a work tree', async () => {
    const r = await runInstall(f.env, userOpts, makeDeps());
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.requested.scope).toBe('user');
  });

  test('shadowing: user then project install of the same skill → refused; --force proceeds', async () => {
    const u = await runInstall(f.env, userOpts, makeDeps());
    if (!u.ok) throw new Error(msg(u.error));

    const p = await runInstall(
      f.env,
      { sources: [fsSource], cwd: f.project, envVars: f.envVars },
      makeDeps(),
    );
    if (!p.ok) throw new Error(msg(p.error));
    expect(p.value.results.every((x) => x.action === 'refused')).toBe(true);
    expect(p.value.results[0]?.reason).toContain('shadow');
    expect(p.value.results[0]?.error?.code).toBe('flip-refused');

    const pf = await runInstall(
      f.env,
      { sources: [fsSource], cwd: f.project, envVars: f.envVars, force: true },
      makeDeps(),
    );
    if (!pf.ok) throw new Error(msg(pf.error));
    expect(pf.value.results.every((x) => x.action === 'installed')).toBe(true);
    expect(pf.value.results[0]?.reason ?? '').toContain('shadow');
  });
});

describe('runInstall — codex legacy conflict (D15)', () => {
  test('legacy skill present → codex refused even under --force; claude-code proceeds', async () => {
    await f.env.makeDir(join(legacyRoot(), 'factor-scan'));
    await f.env.writeTextFile(
      join(legacyRoot(), 'factor-scan', 'SKILL.md'),
      '---\nname: factor-scan\n---\n',
    );
    const r = await runInstall(f.env, { ...userOpts, force: true }, makeDeps());
    if (!r.ok) throw new Error(msg(r.error));
    const cx = r.value.results.find((x) => x.tool === 'codex');
    const cc = r.value.results.find((x) => x.tool === 'claude-code');
    expect(cx?.action).toBe('refused');
    expect(cx?.error?.code).toBe('flip-refused');
    expect(cx?.reason).toContain('legacy');
    expect(cx?.reason).toContain('uninstall');
    expect(cc?.action).toBe('installed');
  });
});

describe('runInstall — tool detection', () => {
  test('explicit --tool codex undetected → refused + tool-unavailable with install hint', async () => {
    const detect: InstallDeps['detect'] = async (_env, tool) =>
      tool === 'codex'
        ? ok<InstallRecord[]>([])
        : ok<InstallRecord[]>([{ path: '/x', version: '1', installMethod: 'unknown' }]);
    const r = await runInstall(f.env, { ...userOpts, tools: ['codex'] }, makeDeps({ detect }));
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results.every((x) => x.action === 'refused')).toBe(true);
    expect(r.value.results[0]?.error?.code).toBe('tool-unavailable');
    expect(r.value.results[0]?.reason).toContain('npm install -g @openai/codex');
  });

  test('auto mode installs only the one detected tool, silently', async () => {
    const detect: InstallDeps['detect'] = async (_env, tool) =>
      tool === 'claude-code'
        ? ok<InstallRecord[]>([{ path: '/x', version: '1', installMethod: 'unknown' }])
        : ok<InstallRecord[]>([]);
    const r = await runInstall(f.env, userOpts, makeDeps({ detect }));
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results.length).toBe(1);
    expect(r.value.results[0]?.tool).toBe('claude-code');
    expect(r.value.results[0]?.action).toBe('installed');
  });
});

describe('runInstall — resolution ambiguity', () => {
  test('bare multi repo (3 skills) without pick → refused with 3 //path candidates', async () => {
    const r = await runInstall(
      f.env,
      { sources: [fixture.multiUrl], cwd: f.base, envVars: f.envVars },
      makeDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results.length).toBe(1);
    const res = r.value.results[0];
    expect(res?.action).toBe('refused');
    expect(res?.error?.code).toBe('flip-refused');
    expect(res?.skill).toBeNull();
    expect(res?.candidates?.length).toBe(3);
    expect(res?.candidates?.every((c) => c.includes('//'))).toBe(true);
  });

  test('scripted pick resolves the ambiguity and installs the chosen skill', async () => {
    const pick = async (cands: readonly CandidateSkill[]): Promise<CandidateSkill | null> =>
      cands.find((c) => c.path === 'plugins/fh/skills/factor-scan') ?? null;
    const r = await runInstall(
      f.env,
      { sources: [fixture.multiUrl], cwd: f.base, envVars: f.envVars },
      makeDeps({ pick }),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.summary.installed).toBe(2);
    expect(r.value.results[0]?.skill).toBe('factor-scan');
  });
});

describe('runInstall — batch semantics', () => {
  test('a parse failure refuses the whole invocation pre-I/O (resolution 3)', async () => {
    const r = await runInstall(
      f.env,
      { sources: ['onepart', fsSource], cwd: f.base, envVars: f.envVars },
      makeDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const bad = r.value.results.find((x) => x.source === 'onepart');
    const good = r.value.results.find((x) => x.source === fsSource);
    expect(bad?.action).toBe('refused');
    expect(good?.action).toBe('skipped');
    expect(good?.reason).toBe('fail-fast');
    // pre-I/O: nothing fetched, no ledger file
    expect(await f.env.pathKind(ledgerPathOf(f.data))).toBe('absent');
    expect(await fetchDirs()).toEqual([]);
  });

  test('[valid, bad-fetch] → first installs, second failed exit-5 class', async () => {
    const bad = `file:///nonexistent/${Math.random().toString(36).slice(2)}.git//x`;
    const r = await runInstall(
      f.env,
      { sources: [fsSource, bad], cwd: f.base, envVars: f.envVars },
      makeDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results.some((x) => x.source === fsSource && x.action === 'installed')).toBe(
      true,
    );
    const badRes = r.value.results.find((x) => x.source === bad);
    expect(badRes?.action).toBe('failed');
    expect(badRes?.error?.code).toBe('source-unresolvable');
  });

  test('[bad-fetch, valid] without continueOnError → later source skipped/fail-fast', async () => {
    const bad = `file:///nonexistent/${Math.random().toString(36).slice(2)}.git//x`;
    const r = await runInstall(
      f.env,
      { sources: [bad, fsSource], cwd: f.base, envVars: f.envVars },
      makeDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results.find((x) => x.source === bad)?.action).toBe('failed');
    const good = r.value.results.filter((x) => x.source === fsSource);
    expect(good.every((x) => x.action === 'skipped' && x.reason === 'fail-fast')).toBe(true);
  });

  test('continueOnError attempts every source', async () => {
    const bad = `file:///nonexistent/${Math.random().toString(36).slice(2)}.git//x`;
    const r = await runInstall(
      f.env,
      { sources: [bad, fsSource], cwd: f.base, envVars: f.envVars, continueOnError: true },
      makeDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results.find((x) => x.source === bad)?.action).toBe('failed');
    expect(r.value.summary.installed).toBe(2);
  });
});

describe('runInstall — fetch elision', () => {
  test('re-install of a stored SHA succeeds offline (fetch forbidden)', async () => {
    const shaSource = `${fixture.multiUrl}//plugins/fh/skills/factor-scan@${fixture.multiTagSha}`;
    // seed: install online at the tag SHA
    const seed = await runInstall(
      f.env,
      { sources: [shaSource], cwd: f.base, envVars: f.envVars },
      makeDeps(),
    );
    if (!seed.ok) throw new Error(msg(seed.error));

    // uninstall-shaped removal of the placement dirs (leave the ledger + store intact)
    await f.env.removeTree(join(claudeRoot(), 'factor-scan'));
    await f.env.removeTree(join(agentsRoot(), 'factor-scan'));

    // fetch-forbidding env: any git 'fetch' fails hard
    const noFetch: ScanEnv = {
      ...f.env,
      exec: async (cmd, args, opts): Promise<ExecResult> => {
        if (args.includes('fetch')) {
          return { code: 128, stdout: '', stderr: 'fetch forbidden by test', timedOut: false };
        }
        return f.env.exec(cmd, args, opts);
      },
    };

    const r = await runInstall(
      noFetch,
      { sources: [shaSource], cwd: f.base, envVars: f.envVars },
      makeDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results.every((x) => x.action === 'installed' || x.action === 'updated')).toBe(
      true,
    );
    expect(await f.env.pathKind(join(claudeRoot(), 'factor-scan'))).not.toBe('absent');
    const cc = r.value.results.find((x) => x.tool === 'claude-code');
    expect(cc?.store?.reused).toBe(true);
  });
});

describe('runInstall — unresolved journal (Global Constraint #6)', () => {
  test('same-op install re-run RESUMES the interrupted install to completion (not refused)', async () => {
    const r1 = await runInstall(
      f.env,
      { sources: [fsSource], tools: ['claude-code'], cwd: f.base, envVars: f.envVars },
      makeDeps(),
    );
    if (!r1.ok) throw new Error(msg(r1.error));
    const live = join(claudeRoot(), 'factor-scan');
    expect(await f.env.pathKind(live)).toBe('symlink'); // materialized store symlink

    // Plant an uncommitted install journal at phase 'live' (crashed just before the terminal write):
    // the placement is already published; resume must only commit (null the journal).
    const ledger = await led();
    const pair = getPairAt(ledger, null, 'factor-scan', 'claude-code');
    if (!pair) throw new Error('expected a seeded pair');
    const journal: Journal = {
      op: 'install',
      txId: 'deadbeef',
      phase: 'live',
      startedAt: NOW,
      completedAt: null,
      before: { mode: 'absent' },
      stagingPath: join(claudeRoot(), '.skillsmith-staging-factor-scan-deadbeef'),
      backupPath: join(claudeRoot(), '.skillsmith-backup-factor-scan-deadbeef'),
    };
    pair.journal = journal;
    const w = await writeLedger(f.env, ledgerPathOf(f.data), ledger);
    if (!w.ok) throw new Error(msg(w.error));

    const r2 = await runInstall(
      f.env,
      { sources: [fsSource], tools: ['claude-code'], cwd: f.base, envVars: f.envVars },
      makeDeps(),
    );
    if (!r2.ok) throw new Error(msg(r2.error));
    const res = r2.value.results.find((x) => x.tool === 'claude-code');
    expect(res?.action).toBe('installed'); // RESUMED to completion, NOT refused
    expect(res?.error).toBeUndefined();

    const after = await led();
    expect(getPairAt(after, null, 'factor-scan', 'claude-code')?.journal).toBeNull();
    expect(await f.env.pathKind(live)).toBe('symlink');
  });

  test('a DIFFERENT interrupted op (promote) → refused, naming the JOURNAL op, not install', async () => {
    const r1 = await runInstall(
      f.env,
      { sources: [fsSource], tools: ['claude-code'], cwd: f.base, envVars: f.envVars },
      makeDeps(),
    );
    if (!r1.ok) throw new Error(msg(r1.error));

    const ledger = await led();
    const pair = getPairAt(ledger, null, 'factor-scan', 'claude-code');
    if (!pair) throw new Error('expected a seeded pair');
    const journal: Journal = {
      op: 'promote',
      txId: 'deadbeef',
      phase: 'staged',
      startedAt: NOW,
      completedAt: null,
      before: { mode: 'dev', symlinkTarget: '/src/factor-scan', liveKind: 'symlink' },
      stagingPath: join(claudeRoot(), '.skillsmith-staging-factor-scan-deadbeef'),
      backupPath: join(claudeRoot(), '.skillsmith-backup-factor-scan-deadbeef'),
    };
    pair.journal = journal;
    const w = await writeLedger(f.env, ledgerPathOf(f.data), ledger);
    if (!w.ok) throw new Error(msg(w.error));

    const r2 = await runInstall(
      f.env,
      { sources: [fsSource], tools: ['claude-code'], cwd: f.base, envVars: f.envVars },
      makeDeps(),
    );
    if (!r2.ok) throw new Error(msg(r2.error));
    const res = r2.value.results.find((x) => x.tool === 'claude-code');
    expect(res?.action).toBe('refused');
    expect(res?.error?.code).toBe('flip-refused'); // exit-2 contribution
    const reason = res?.reason ?? '';
    expect(reason).toContain('promote --rollback'); // names the JOURNAL's op
    expect(reason).not.toContain('install --rollback');
    expect(reason).not.toContain("re-run 'skillsmith install"); // does not claim install completes it
  });
});

describe('runInstall — dry run', () => {
  test('no lock, no ledger write, fetch cleaned, actions predicted', async () => {
    const r = await runInstall(f.env, { ...userOpts, dryRun: true }, makeDeps());
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.dryRun).toBe(true);
    expect(r.value.results.every((x) => x.action === 'installed')).toBe(true);
    // no placements, no ledger file, fetch cleaned
    expect(await f.env.pathKind(join(claudeRoot(), 'factor-scan'))).toBe('absent');
    expect(await f.env.pathKind(ledgerPathOf(f.data))).toBe('absent');
    expect(await fetchDirs()).toEqual([]);
  });
});
