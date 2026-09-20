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
import { dirname, join } from 'node:path';
import type {
  FlipDeps,
  InstallDeps,
  InstallOptions,
  InstallRecord,
  RuntimePorts,
  SkillSmithError,
} from '@skillsmith/core';
import {
  VERIFIED_AGAINST,
  ok,
  resolveRuntimeConfiguration,
  runInstall,
  runUninstall,
} from '@skillsmith/core';
import type { VerifyReport } from '@skillsmith/core';
import {
  readLedgerState,
  withoutLedgerPairAt,
  writeLedger,
} from '../../../core/src/place/ledger.ts';
import { ledgerPathOf, resolveDataDir } from '../../../core/src/place/paths.ts';
import { runDev } from '../../../core/src/place/run.ts';
import {
  type RemoteFixture,
  buildRemoteFixture,
  destroyRemoteFixture,
} from '../../../core/tests/fixtures/acquire/remote.ts';
import {
  type FixtureFleet,
  buildFixtureFleet,
  destroyFixtureFleet,
} from '../../../core/tests/fixtures/place/fleet.ts';
import { acquireExitCode } from '../../src/util/acquire-exit.ts';
import { exitCodeForError } from '../../src/util/exit-codes.ts';

// Drives `runInstall`/`runUninstall` + `acquireExitCode` across every §13 exit-code table row —
// mirrors flip-exit-codes.test.ts's shape (one row, one assertion of the FINAL exit code) but for
// the acquisition verbs. Rows that are pure pre-flight (grammar rejection, `--ref` with two
// sources, an explicitly undetected tool, a corrupt ledger) need no fixture/fetch at all; the
// fetch-dependent rows use safe fixture HTTPS identities with an injected trusted transport. This
// also closes the Task-9
// coverage gap noted in the brief: install.test.ts previously had no hermetic real-flow smoke.
setDefaultTimeout(60_000);

const NOW = '2026-07-08T00:00:00Z';
const msg = (e: SkillSmithError): string => ('message' in e ? e.message : e.code);
const CLAUDE_ONLY = ['claude-code'] as const;

const detectBoth: InstallDeps['detect'] = async (_env, tool) =>
  tool === 'muse'
    ? ok<InstallRecord[]>([])
    : ok<InstallRecord[]>([
        { path: `/usr/local/bin/${tool}`, version: '1.0.0', installMethod: 'unknown' },
      ]);

const detectClaudeOnly: InstallDeps['detect'] = async (_env, tool) =>
  tool === 'claude-code'
    ? ok<InstallRecord[]>([
        { path: '/usr/local/bin/claude-code', version: '1.0.0', installMethod: 'unknown' },
      ])
    : ok<InstallRecord[]>([]);

const detectNone: InstallDeps['detect'] = async () => ok<InstallRecord[]>([]);

const makeVerifyReport = (path: string, verdict: 'pass' | 'fail', tool: string): VerifyReport => ({
  schemaVersion: 1,
  target: { path, kind: 'skill' },
  requested: {
    tools: [tool] as ('claude-code' | 'codex')[],
    modes: ['static'],
    strict: false,
    explicitTools: true,
  },
  verifiedAgainst: VERIFIED_AGAINST,
  summary: {
    verdict,
    verified: verdict === 'pass' ? [tool] : [],
    failed: verdict === 'fail' ? [tool] : [],
    skipped: [],
    counts: { error: 0, warning: 0, info: verdict === 'fail' ? 1 : 0 },
  } as VerifyReport['summary'],
  tools: [
    {
      tool: tool as 'claude-code' | 'codex',
      available: true,
      toolVersion: '1.0.0',
      versionDrift: false,
      skipReason: null,
      verdict,
      modes: [],
    },
  ],
});

const passVerify: InstallDeps['verify'] = async (_env, opts) => {
  const tool = opts.tools?.[0] ?? 'claude-code';
  return ok(makeVerifyReport(opts.path, 'pass', tool));
};

const failVerify: InstallDeps['verify'] = async (_env, opts) => {
  const tool = opts.tools?.[0] ?? 'claude-code';
  return ok(makeVerifyReport(opts.path, 'fail', tool));
};

let txN = 0;
const installDeps = (
  detect: InstallDeps['detect'] = detectBoth,
  verify: InstallDeps['verify'] = passVerify,
): InstallDeps => ({
  verify,
  detect,
  now: () => NOW,
  newTxId: () => (0x10000000 + txN++).toString(16).slice(-8),
  transport: fixture.transport,
});

let unTxN = 0;
const uninstallDeps = () => ({
  now: () => NOW,
  newTxId: () => (0x40000000 + unTxN++).toString(16).slice(-8),
});

// F-fetch elision (run.ts's tryElide) trusts an existing store entry without re-hashing it against
// a fresh fetch — by design, so a plain reinstall of the same SHA never re-detects a tampered store
// entry that way. To exercise the REAL integrity check (a fresh fetch compared against the corrupt
// entry) this forces `ls-remote` to fail, which is `resolveRefViaLsRemote`'s documented fallback
// ("a miss or an `ls-remote` failure is `ok(null)`... callers fall back to the full fetch").
const blockLsRemote = (env: RuntimePorts): RuntimePorts => ({
  ...env,
  git: {
    ...env.git,
    resolveRemoteRef: async () => null,
  },
});

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

describe('install/uninstall exit-code table (§13)', () => {
  test('fresh install, both tools detected -> exit 0', async () => {
    const r = await runInstall(
      f.env,
      { sources: [fsSource], cwd: f.base, configuration: resolveRuntimeConfiguration(f.envVars) },
      installDeps(detectBoth),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.summary.installed).toBe(2);
    expect(acquireExitCode(r.value)).toBe(0);
  });

  test('idempotent re-run (noop) -> exit 0', async () => {
    const opts: InstallOptions = {
      sources: [fsSource],
      tools: CLAUDE_ONLY,
      cwd: f.base,
      configuration: resolveRuntimeConfiguration(f.envVars),
    };
    const r1 = await runInstall(f.env, opts, installDeps(detectClaudeOnly));
    if (!r1.ok) throw new Error(msg(r1.error));
    const r2 = await runInstall(f.env, opts, installDeps(detectClaudeOnly));
    if (!r2.ok) throw new Error(msg(r2.error));
    expect(r2.value.results[0]?.action).toBe('noop');
    expect(acquireExitCode(r2.value)).toBe(0);
  });

  test('repaired (ledger pair missing, placement intact) -> exit 0', async () => {
    const opts: InstallOptions = {
      sources: [fsSource],
      tools: CLAUDE_ONLY,
      cwd: f.base,
      configuration: resolveRuntimeConfiguration(f.envVars),
    };
    const r1 = await runInstall(f.env, opts, installDeps(detectClaudeOnly));
    if (!r1.ok) throw new Error(msg(r1.error));
    // drop the ledger's skills entry, leave the placement on disk untouched
    const ledgerPath = ledgerPathOf(resolveDataDir(f.env, resolveRuntimeConfiguration(f.envVars)));
    const ledgerRes = await readLedgerState(f.env, ledgerPath);
    if (!ledgerRes.ok || ledgerRes.value.state !== 'present') {
      throw new Error('installed ledger is absent');
    }
    const withoutPair = withoutLedgerPairAt(
      ledgerRes.value.model,
      null,
      'factor-scan',
      'claude-code',
    );
    if (!withoutPair.ok) throw new Error(msg(withoutPair.error));
    const w = await writeLedger(f.env, ledgerPath, withoutPair.value);
    if (!w.ok) throw new Error(msg(w.error));

    const r2 = await runInstall(f.env, opts, installDeps(detectClaudeOnly));
    if (!r2.ok) throw new Error(msg(r2.error));
    expect(r2.value.results[0]?.action).toBe('repaired');
    expect(acquireExitCode(r2.value)).toBe(0);
  });

  test('verify gateFail install -> exit 1', async () => {
    const r = await runInstall(
      f.env,
      {
        sources: [fsSource],
        tools: CLAUDE_ONLY,
        cwd: f.base,
        configuration: resolveRuntimeConfiguration(f.envVars),
      },
      installDeps(detectClaudeOnly, failVerify),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results[0]?.action).toBe('failed');
    expect(acquireExitCode(r.value)).toBe(1);
  });

  test('store integrity tamper (pre-seed entry, corrupt a file, reinstall same SHA) -> exit 1', async () => {
    const opts: InstallOptions = {
      sources: [fsSource],
      tools: CLAUDE_ONLY,
      cwd: f.base,
      configuration: resolveRuntimeConfiguration(f.envVars),
    };
    const seed = await runInstall(f.env, opts, installDeps(detectClaudeOnly));
    if (!seed.ok) throw new Error(msg(seed.error));
    const storePath = seed.value.results[0]?.store?.path;
    if (!storePath) throw new Error('expected a store path on the seed install');
    await f.env.writeTextFile(join(storePath, 'SKILL.md'), '---\nname: tampered\n---\nCORRUPTED\n');

    const r = await runInstall(blockLsRemote(f.env), opts, installDeps(detectClaudeOnly));
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results[0]?.action).toBe('failed');
    expect(r.value.results[0]?.reason).toContain('store integrity violation');
    expect(acquireExitCode(r.value)).toBe(1);
  });

  test('grammar reject (`factor-scan` one-part) -> exit 2', async () => {
    const r = await runInstall(
      f.env,
      {
        sources: ['factor-scan'],
        cwd: f.base,
        configuration: resolveRuntimeConfiguration(f.envVars),
      },
      installDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results[0]?.action).toBe('refused');
    expect(acquireExitCode(r.value)).toBe(2);
  });

  test('R2 ambiguity, no pick -> exit 2', async () => {
    const r = await runInstall(
      f.env,
      {
        sources: [fixture.multiSource],
        cwd: f.base,
        configuration: resolveRuntimeConfiguration(f.envVars),
      },
      installDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results[0]?.action).toBe('refused');
    expect(r.value.results[0]?.candidates?.length).toBeGreaterThan(1);
    expect(acquireExitCode(r.value)).toBe(2);
  });

  test('shadowing without --force -> exit 2', async () => {
    const userIns = await runInstall(
      f.env,
      {
        sources: [fsSource],
        tools: CLAUDE_ONLY,
        cwd: f.base,
        configuration: resolveRuntimeConfiguration(f.envVars),
      },
      installDeps(detectClaudeOnly),
    );
    if (!userIns.ok) throw new Error(msg(userIns.error));
    const r = await runInstall(
      f.env,
      {
        sources: [fsSource],
        tools: CLAUDE_ONLY,
        cwd: f.project,
        configuration: resolveRuntimeConfiguration(f.envVars),
      },
      installDeps(detectClaudeOnly),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results[0]?.action).toBe('refused');
    expect(r.value.results[0]?.reason).toContain('shadow');
    expect(acquireExitCode(r.value)).toBe(2);
  });

  test('codex legacy conflict -> exit 2', async () => {
    const legacyRoot = join(f.home, '.codex', 'skills');
    await f.env.makeDir(join(legacyRoot, 'factor-scan'));
    await f.env.writeTextFile(
      join(legacyRoot, 'factor-scan', 'SKILL.md'),
      '---\nname: factor-scan\n---\n',
    );

    const r = await runInstall(
      f.env,
      {
        sources: [fsSource],
        tools: ['codex'],
        cwd: f.base,
        configuration: resolveRuntimeConfiguration(f.envVars),
      },
      installDeps(detectBoth),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results[0]?.action).toBe('refused');
    expect(r.value.results[0]?.reason).toContain('legacy');
    expect(acquireExitCode(r.value)).toBe(2);
  });

  test('--ref with two sources -> exit 2', async () => {
    const r = await runInstall(
      f.env,
      {
        sources: ['acme/repo', 'acme/other'],
        ref: 'v1.0.0',
        cwd: f.base,
        configuration: resolveRuntimeConfiguration(f.envVars),
      },
      installDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results.every((x) => x.action === 'refused')).toBe(true);
    expect(acquireExitCode(r.value)).toBe(2);
  });

  test('corrupt ledger (`{"schemaVersion":` truncated) -> install exit 3', async () => {
    const ledgerPath = ledgerPathOf(resolveDataDir(f.env, resolveRuntimeConfiguration(f.envVars)));
    await f.env.makeDir(dirname(ledgerPath));
    await f.env.writeTextFile(ledgerPath, '{"schemaVersion":');

    const r = await runInstall(
      f.env,
      {
        sources: ['acme/repo'],
        cwd: f.base,
        configuration: resolveRuntimeConfiguration(f.envVars),
      },
      installDeps(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('ledger-error');
      expect(exitCodeForError(r.error)).toBe(3);
    }
  });

  test('corrupt ledger -> uninstall exit 3 too (any op)', async () => {
    const ledgerPath = ledgerPathOf(resolveDataDir(f.env, resolveRuntimeConfiguration(f.envVars)));
    await f.env.makeDir(dirname(ledgerPath));
    await f.env.writeTextFile(ledgerPath, '{"schemaVersion":');

    const r = await runUninstall(
      f.env,
      { targets: ['whatever'], cwd: f.base, configuration: resolveRuntimeConfiguration(f.envVars) },
      uninstallDeps(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('ledger-error');
      expect(exitCodeForError(r.error)).toBe(3);
    }
  });

  test('explicit --tool codex, detect -> [] -> exit 4', async () => {
    const r = await runInstall(
      f.env,
      {
        sources: ['acme/repo'],
        tools: ['codex'],
        cwd: f.base,
        configuration: resolveRuntimeConfiguration(f.envVars),
      },
      installDeps(detectNone),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results[0]?.action).toBe('refused');
    expect(r.value.results[0]?.error?.code).toBe('tool-unavailable');
    expect(acquireExitCode(r.value)).toBe(4);
  });

  test('unreachable URL / bad ref / zero-match name -> exit 5', async () => {
    const zeroMatch = `${fixture.multiSource}/totally-not-a-real-skill-name`;
    const r = await runInstall(
      f.env,
      {
        sources: [zeroMatch],
        tools: CLAUDE_ONLY,
        cwd: f.base,
        configuration: resolveRuntimeConfiguration(f.envVars),
      },
      installDeps(detectClaudeOnly),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results[0]?.action).toBe('failed');
    expect(r.value.results[0]?.error?.code).toBe('source-unresolvable');
    expect(acquireExitCode(r.value)).toBe(5);
  });

  test('uninstall U2 ambiguity (found in user AND project, no --scope/--all-scopes) -> exit 2', async () => {
    const opts: InstallOptions = {
      sources: [fsSource],
      tools: CLAUDE_ONLY,
      cwd: f.base,
      configuration: resolveRuntimeConfiguration(f.envVars),
    };
    const u = await runInstall(f.env, opts, installDeps(detectClaudeOnly));
    if (!u.ok) throw new Error(msg(u.error));
    const p = await runInstall(
      f.env,
      { ...opts, cwd: f.project, force: true },
      installDeps(detectClaudeOnly),
    );
    if (!p.ok) throw new Error(msg(p.error));

    const r = await runUninstall(
      f.env,
      {
        targets: ['factor-scan'],
        tools: CLAUDE_ONLY,
        cwd: f.project,
        configuration: resolveRuntimeConfiguration(f.envVars),
      },
      uninstallDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results[0]?.action).toBe('refused');
    expect(acquireExitCode(r.value)).toBe(2);
  });

  test('uninstall U3 dev-mode without --force -> exit 2', async () => {
    const opts: InstallOptions = {
      sources: [fsSource],
      tools: CLAUDE_ONLY,
      cwd: f.base,
      configuration: resolveRuntimeConfiguration(f.envVars),
    };
    const ins = await runInstall(f.env, opts, installDeps(detectClaudeOnly));
    if (!ins.ok) throw new Error(msg(ins.error));
    const unusedVerify: FlipDeps['verify'] = async () => {
      throw new Error('verify should not run under --no-verify');
    };
    const d = await runDev(
      f.env,
      {
        targets: ['factor-scan'],
        tools: CLAUDE_ONLY,
        source: f.gammaSrc,
        noVerify: true,
        cwd: f.base,
        configuration: resolveRuntimeConfiguration(f.envVars),
      },
      { now: () => NOW, newTxId: () => 'aaaaaaaa', verify: unusedVerify },
    );
    if (!d.ok) throw new Error(msg(d.error));

    const r = await runUninstall(
      f.env,
      {
        targets: ['factor-scan'],
        tools: CLAUDE_ONLY,
        cwd: f.base,
        configuration: resolveRuntimeConfiguration(f.envVars),
      },
      uninstallDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results[0]?.action).toBe('refused');
    expect(r.value.results[0]?.reason).toContain('dev mode');
    expect(acquireExitCode(r.value)).toBe(2);
  });

  test('uninstall unmanaged placement without --force -> exit 2', async () => {
    const r = await runUninstall(
      f.env,
      {
        targets: ['copied'],
        tools: CLAUDE_ONLY,
        cwd: f.base,
        configuration: resolveRuntimeConfiguration(f.envVars),
      },
      uninstallDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results[0]?.action).toBe('refused');
    expect(acquireExitCode(r.value)).toBe(2);
  });

  test('uninstall: absent everywhere -> exit 0', async () => {
    const r = await runUninstall(
      f.env,
      {
        targets: ['totally-unknown-skill'],
        cwd: f.base,
        configuration: resolveRuntimeConfiguration(f.envVars),
      },
      uninstallDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results[0]?.action).toBe('noop');
    expect(acquireExitCode(r.value)).toBe(0);
  });

  test('mixed batch: one installed + one refused -> exit 2 (max rule, with and without --continue-on-error)', async () => {
    // `fixture.multiSource` bare (whole-repo, R2-ambiguous: 3 skills) must be a DIFFERENT repo than
    // the
    // one installed first — F-fetch elision (tryElide) trusts an already-installed (repo, sha) pair
    // and would otherwise resolve the bare source straight to that one skill (a 'noop', not R2).
    const singleSource = `${fixture.singleSource}//tools/deep/skills/lint`;
    const sources = [singleSource, fixture.multiSource];

    const withoutCoe = await runInstall(
      f.env,
      {
        sources,
        tools: CLAUDE_ONLY,
        cwd: f.base,
        configuration: resolveRuntimeConfiguration(f.envVars),
      },
      installDeps(detectClaudeOnly),
    );
    if (!withoutCoe.ok) throw new Error(msg(withoutCoe.error));
    expect(withoutCoe.value.results.some((x) => x.action === 'installed')).toBe(true);
    expect(withoutCoe.value.results.some((x) => x.action === 'refused')).toBe(true);
    expect(acquireExitCode(withoutCoe.value)).toBe(2);

    const f2 = await buildFixtureFleet();
    try {
      const withCoe = await runInstall(
        f2.env,
        {
          sources,
          tools: CLAUDE_ONLY,
          cwd: f2.base,
          configuration: resolveRuntimeConfiguration(f2.envVars),
          continueOnError: true,
        },
        installDeps(detectClaudeOnly),
      );
      if (!withCoe.ok) throw new Error(msg(withCoe.error));
      expect(withCoe.value.results.some((x) => x.action === 'installed')).toBe(true);
      expect(withCoe.value.results.some((x) => x.action === 'refused')).toBe(true);
      expect(acquireExitCode(withCoe.value)).toBe(2);
    } finally {
      await destroyFixtureFleet(f2);
    }
  });
});
