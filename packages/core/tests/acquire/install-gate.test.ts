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
import { join } from 'node:path';
import { runInstall } from '../../src/acquire/run.ts';
import type { InstallDeps, InstallOptions } from '../../src/acquire/types.ts';
import type { InstallRecord } from '../../src/agents/types.ts';
import type { ScanEnv } from '../../src/env/types.ts';
import type { SkillSmithError } from '../../src/errors.ts';
import { readLedger } from '../../src/place/ledger.ts';
import { ledgerPathOf } from '../../src/place/paths.ts';
import type { FlipTool } from '../../src/place/types.ts';
import { ok } from '../../src/result.ts';
import type { VerifyOptions } from '../../src/verify/run.ts';
import {
  type SummaryVerdict,
  VERIFIED_AGAINST,
  type VerifyReport,
} from '../../src/verify/types.ts';
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

interface VerifyCall {
  path: string;
  tools: readonly string[];
  deep: boolean;
}

const detectBoth: InstallDeps['detect'] = async (_env, tool) =>
  ok<InstallRecord[]>([
    { path: `/usr/local/bin/${tool}`, version: '1.0.0', installMethod: 'unknown' },
  ]);

const cannedVerify =
  (verdict: SummaryVerdict, calls: VerifyCall[]): InstallDeps['verify'] =>
  async (_env: ScanEnv, opts: VerifyOptions) => {
    const tools = opts.tools ?? [];
    calls.push({ path: opts.path, tools, deep: opts.deep ?? false });
    const tool = (tools[0] ?? 'claude-code') as FlipTool;
    const report: VerifyReport = {
      schemaVersion: 1,
      target: { path: opts.path, kind: 'skill' },
      requested: {
        tools: [...tools] as FlipTool[],
        modes: opts.deep ? ['static', 'deep'] : ['static'],
        strict: opts.strict ?? false,
        explicitTools: true,
      },
      verifiedAgainst: VERIFIED_AGAINST,
      summary: {
        verdict,
        verified: verdict === 'pass' || verdict === 'warn' ? [tool] : [],
        failed: verdict === 'fail' ? [tool] : [],
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
          verdict,
          modes: [],
        },
      ],
    };
    return ok(report);
  };

let txN = 0;
const makeDeps = (verify: InstallDeps['verify']): InstallDeps => ({
  verify,
  detect: detectBoth,
  now: () => NOW,
  newTxId: () => (0x10000000 + txN++).toString(16).slice(-8),
});

let fixture: RemoteFixture;

beforeAll(async () => {
  fixture = await buildRemoteFixture();
});
afterAll(async () => {
  await destroyRemoteFixture(fixture);
});

describe('runInstall — verify gate matrix', () => {
  let f: FixtureFleet;
  let source: string;
  let baseOpts: InstallOptions;

  beforeEach(async () => {
    f = await buildFixtureFleet();
    source = `${fixture.multiUrl}//plugins/fh/skills/factor-scan`;
    baseOpts = {
      sources: [source],
      cwd: f.base, // outside any work tree → user scope
      envVars: f.envVars,
    };
  });
  afterEach(async () => {
    await destroyFixtureFleet(f);
  });

  const claudeRoot = (): string => join(f.home, '.claude', 'skills');
  const agentsRoot = (): string => join(f.home, '.agents', 'skills');

  const fetchDirs = async (): Promise<readonly string[]> => {
    const dir = join(f.data, '.fetch');
    if ((await f.env.pathKind(dir)) === 'absent') return [];
    return f.env.listDir(dir);
  };

  test('pass, default → both tools installed, gate passed/static', async () => {
    const calls: VerifyCall[] = [];
    const r = await runInstall(f.env, baseOpts, makeDeps(cannedVerify('pass', calls)));
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results.every((x) => x.action === 'installed')).toBe(true);
    for (const res of r.value.results) {
      expect(res.verify).toEqual({ gate: 'passed', verdict: 'pass', mode: 'static' });
    }
    expect(await fetchDirs()).toEqual([]);
  });

  test('fail, default → both tools failed (blocked), ledger + roots untouched, fetch cleaned', async () => {
    const calls: VerifyCall[] = [];
    const r = await runInstall(f.env, baseOpts, makeDeps(cannedVerify('fail', calls)));
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results.every((x) => x.action === 'failed')).toBe(true);
    for (const res of r.value.results) {
      expect(res.verify?.gate).toBe('failed');
      expect(res.error?.code).toBe('flip-failed');
    }
    // nothing placed; ledger has no skills entries
    expect(await f.env.pathKind(join(claudeRoot(), 'factor-scan'))).toBe('absent');
    expect(await f.env.pathKind(join(agentsRoot(), 'factor-scan'))).toBe('absent');
    const led = await readLedger(f.env, ledgerPathOf(f.data));
    if (!led.ok) throw new Error(msg(led.error));
    expect(led.value.skills['factor-scan']).toBeUndefined();
    expect(await fetchDirs()).toEqual([]);
  });

  test('warn, default → installed with gate warned', async () => {
    const calls: VerifyCall[] = [];
    const r = await runInstall(f.env, baseOpts, makeDeps(cannedVerify('warn', calls)));
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results.every((x) => x.action === 'installed')).toBe(true);
    expect(r.value.results[0]?.verify?.gate).toBe('warned');
  });

  test('warn, strict → failed', async () => {
    const calls: VerifyCall[] = [];
    const r = await runInstall(
      f.env,
      { ...baseOpts, strict: true },
      makeDeps(cannedVerify('warn', calls)),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.results.every((x) => x.action === 'failed')).toBe(true);
  });

  test('inconclusive, default → installed with a notice; strict → failed', async () => {
    const c1: VerifyCall[] = [];
    const r1 = await runInstall(f.env, baseOpts, makeDeps(cannedVerify('inconclusive', c1)));
    if (!r1.ok) throw new Error(msg(r1.error));
    expect(r1.value.results.every((x) => x.action === 'installed')).toBe(true);
    expect(r1.value.results[0]?.verify?.gate).toBe('inconclusive');
    expect(r1.value.results[0]?.reason ?? '').toContain('inconclusive');

    const f2 = await buildFixtureFleet();
    try {
      const c2: VerifyCall[] = [];
      const r2 = await runInstall(
        f2.env,
        { sources: [source], cwd: f2.base, envVars: f2.envVars, strict: true },
        makeDeps(cannedVerify('inconclusive', c2)),
      );
      if (!r2.ok) throw new Error(msg(r2.error));
      expect(r2.value.results.every((x) => x.action === 'failed')).toBe(true);
    } finally {
      await destroyFixtureFleet(f2);
    }
  });

  test('noVerify → installed, verify not called, JSON verify null, pinned verify skipped', async () => {
    const calls: VerifyCall[] = [];
    const r = await runInstall(
      f.env,
      { ...baseOpts, noVerify: true },
      makeDeps(cannedVerify('pass', calls)),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(calls.length).toBe(0);
    expect(r.value.results.every((x) => x.action === 'installed')).toBe(true);
    expect(r.value.results[0]?.verify).toBeNull();
    const led = await readLedger(f.env, ledgerPathOf(f.data));
    if (!led.ok) throw new Error(msg(led.error));
    expect(led.value.skills['factor-scan']?.tools['claude-code']?.pinned?.verify).toBe('skipped');
  });

  test('deep → codex called deep:true (mode static+deep); claude-code never deep (mode static)', async () => {
    const calls: VerifyCall[] = [];
    const r = await runInstall(
      f.env,
      { ...baseOpts, deep: true },
      makeDeps(cannedVerify('pass', calls)),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const claudeCall = calls.find((c) => c.tools[0] === 'claude-code');
    const codexCall = calls.find((c) => c.tools[0] === 'codex');
    expect(claudeCall?.deep).toBe(false);
    expect(codexCall?.deep).toBe(true);
    const claudeRes = r.value.results.find((x) => x.tool === 'claude-code');
    const codexRes = r.value.results.find((x) => x.tool === 'codex');
    expect(claudeRes?.verify?.mode).toBe('static');
    expect(codexRes?.verify?.mode).toBe('static+deep');
  });
});
