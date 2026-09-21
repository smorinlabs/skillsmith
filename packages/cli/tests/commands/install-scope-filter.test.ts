import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { InstallDeps, InstallRecord, SkillSmithError, VerifyReport } from '@skillsmith/core';
import { VERIFIED_AGAINST, ok, resolveRuntimeConfiguration, runInstall } from '@skillsmith/core';
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

// A tool with no placement roots in the install scope (muse in project
// scope) cannot install there: default selection drops it silently, explicit
// requests refuse per source. install-exit-codes.test.ts pins exit codes;
// this file pins the scope filter itself.
const NOW = '2026-07-08T00:00:00Z';
const msg = (e: SkillSmithError): string => ('message' in e ? e.message : e.code);

const detectAll: InstallDeps['detect'] = async (_env, tool) =>
  ok<InstallRecord[]>([
    { path: `/usr/local/bin/${tool}`, version: '1.0.0', installMethod: 'unknown' },
  ]);

const makeVerifyReport = (path: string, tool: string): VerifyReport =>
  ({
    schemaVersion: 1,
    target: { path, kind: 'skill' },
    requested: { tools: [tool], modes: ['static'], strict: false, explicitTools: true },
    verifiedAgainst: VERIFIED_AGAINST,
    summary: { verdict: 'pass', verified: [tool], failed: [], skipped: [], counts: {} },
    tools: [],
  }) as unknown as VerifyReport;

const passVerify: InstallDeps['verify'] = async (_env, opts) => {
  const tool = opts.tools?.[0] ?? 'claude-code';
  return ok(makeVerifyReport(opts.path, tool));
};

let txN = 0;
const installDeps = (): InstallDeps => ({
  verify: passVerify,
  detect: detectAll,
  now: () => NOW,
  newTxId: () => (0x20000000 + txN++).toString(16).slice(-8),
  transport: fixture.transport,
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

describe('install scope filter', () => {
  test('default tools in project scope skip muse without refusing', async () => {
    const r = await runInstall(
      f.env,
      {
        sources: [fsSource],
        scope: 'project',
        cwd: f.project,
        configuration: resolveRuntimeConfiguration(f.envVars),
      },
      installDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.summary.installed).toBe(2);
    expect(r.value.summary.refused).toBe(0);
    expect(r.value.results.map((result) => result.tool).sort()).toEqual(['claude-code', 'codex']);
    expect(r.value.requested.tools).toEqual(['claude-code', 'codex']);
    expect(acquireExitCode(r.value)).toBe(0);
  });

  test('explicit muse in project scope refuses per source', async () => {
    const r = await runInstall(
      f.env,
      {
        sources: [fsSource],
        scope: 'project',
        cwd: f.project,
        tools: ['muse'],
        configuration: resolveRuntimeConfiguration(f.envVars),
      },
      installDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.summary.installed).toBe(0);
    expect(r.value.summary.refused).toBe(1);
    expect(r.value.results).toHaveLength(1);
    expect(r.value.results[0]?.tool).toBe('muse');
    expect(r.value.results[0]?.action).toBe('refused');
    expect(r.value.results[0]?.reason).toBe('muse does not manage project scope');
    expect(acquireExitCode(r.value)).toBe(2);
  });

  test('default tools in user scope still include muse', async () => {
    const r = await runInstall(
      f.env,
      {
        sources: [fsSource],
        scope: 'user',
        cwd: f.base,
        configuration: resolveRuntimeConfiguration(f.envVars),
      },
      installDeps(),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(r.value.summary.installed).toBe(3);
    expect(r.value.results.map((result) => result.tool).sort()).toEqual([
      'claude-code',
      'codex',
      'muse',
    ]);
    expect(acquireExitCode(r.value)).toBe(0);
  });
});
