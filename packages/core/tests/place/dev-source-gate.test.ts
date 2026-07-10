import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { readlink, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { SkillSmithError } from '../../src/errors.ts';
import { getPair, readLedger } from '../../src/place/ledger.ts';
import { ledgerPathOf } from '../../src/place/paths.ts';
import { runDev } from '../../src/place/run.ts';
import type { LedgerFile } from '../../src/place/types.ts';
import type { VerifyOptions } from '../../src/verify/run.ts';
import {
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

setDefaultTimeout(20_000);

const msg = (e: SkillSmithError): string => ('message' in e ? e.message : e.code);

// PRD D2: create AND adopt gate on static verify by default. A gate failure is a
// `refused`-style failure with exit contribution 1 (flip-failed) and NOTHING written —
// no symlink, no ledger record. `--no-verify` skips the gate; `--strict` upgrades
// warnings/inconclusive to blocking. Deep is never requested here (promote keeps its own gate).
describe('dev --source — verify gate (create)', () => {
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

  const expectNothingWritten = async (skill: string): Promise<void> => {
    expect(await f.env.pathKind(join(claudeRoot(), skill))).toBe('absent');
    expect(getPair(await readLedgerOf(), skill, 'claude-code')).toBeNull();
  };

  test('verdict=pass: gate runs once and the placement is created', async () => {
    const calls: VerifyOptions[] = [];
    const r = await runDev(
      f.env,
      opts({ targets: ['beta'], tools: ['claude-code'], source: resolve(f.betaSrc) }),
      cannedFlipDeps('pass', calls),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(actionV2(r.value.results[0])).toBe('created');
    expect(calls).toHaveLength(1);
  });

  test('verdict=warn (default): proceeds — created', async () => {
    const r = await runDev(
      f.env,
      opts({ targets: ['beta'], tools: ['claude-code'], source: resolve(f.betaSrc) }),
      cannedFlipDeps('warn'),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(actionV2(r.value.results[0])).toBe('created');
  });

  test('verdict=warn under --strict: blocked, nothing written', async () => {
    const r = await runDev(
      f.env,
      opts({ targets: ['beta'], tools: ['claude-code'], source: resolve(f.betaSrc), strict: true }),
      cannedFlipDeps('warn'),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const result = r.value.results[0];
    expect(actionV2(result)).toBe('failed');
    expect(result?.error?.code).toBe('flip-failed');
    await expectNothingWritten('beta');
  });

  test('verdict=fail: blocked (exit-1 class), nothing written', async () => {
    const r = await runDev(
      f.env,
      opts({ targets: ['beta'], tools: ['claude-code'], source: resolve(f.betaSrc) }),
      cannedFlipDeps('fail'),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const result = r.value.results[0];
    expect(actionV2(result)).toBe('failed');
    expect(result?.error?.code).toBe('flip-failed');
    await expectNothingWritten('beta');
  });

  test('verdict=inconclusive (default): proceeds — created', async () => {
    const r = await runDev(
      f.env,
      opts({ targets: ['beta'], tools: ['claude-code'], source: resolve(f.betaSrc) }),
      cannedFlipDeps('inconclusive'),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(actionV2(r.value.results[0])).toBe('created');
  });

  test('verdict=inconclusive under --strict: blocked, nothing written', async () => {
    const r = await runDev(
      f.env,
      opts({ targets: ['beta'], tools: ['claude-code'], source: resolve(f.betaSrc), strict: true }),
      cannedFlipDeps('inconclusive'),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(actionV2(r.value.results[0])).toBe('failed');
    await expectNothingWritten('beta');
  });

  test('--no-verify: gate skipped entirely, placement created', async () => {
    const calls: VerifyOptions[] = [];
    const r = await runDev(
      f.env,
      opts({
        targets: ['beta'],
        tools: ['claude-code'],
        source: resolve(f.betaSrc),
        noVerify: true,
      }),
      cannedFlipDeps('fail', calls), // would block if it ran
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(actionV2(r.value.results[0])).toBe('created');
    expect(calls).toHaveLength(0);
  });

  test('the create gate is static-only: a codex create never requests deep (D2)', async () => {
    const calls: VerifyOptions[] = [];
    const r = await runDev(
      f.env,
      opts({ targets: ['alpha'], tools: ['codex'], source: resolve(f.alphaSrc) }),
      passFlipDeps(calls),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(actionV2(r.value.results[0])).toBe('created');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tools).toEqual(['codex']);
    expect(calls[0]?.deep).toBeFalsy();
  });
});

describe('dev --source — verify gate (adopt)', () => {
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

  test('adopt blocked on gate failure: no record written, symlink untouched', async () => {
    const source = resolve(f.betaSrc);
    await symlink(source, join(claudeRoot(), 'beta'));

    const r = await runDev(
      f.env,
      opts({ targets: ['beta'], tools: ['claude-code'], source }),
      cannedFlipDeps('fail'),
    );
    if (!r.ok) throw new Error(msg(r.error));
    const result = r.value.results[0];
    expect(actionV2(result)).toBe('failed');
    expect(result?.error?.code).toBe('flip-failed');

    expect(await readlink(join(claudeRoot(), 'beta'))).toBe(source);
    const ledgerRes = await readLedger(f.env, ledgerPathOf(f.data));
    if (!ledgerRes.ok) throw new Error(msg(ledgerRes.error));
    expect(getPair(ledgerRes.value, 'beta', 'claude-code')).toBeNull();
  });

  test('adopt with --no-verify: gate skipped, record written', async () => {
    const source = resolve(f.betaSrc);
    await symlink(source, join(claudeRoot(), 'beta'));

    const calls: VerifyOptions[] = [];
    const r = await runDev(
      f.env,
      opts({ targets: ['beta'], tools: ['claude-code'], source, noVerify: true }),
      cannedFlipDeps('fail', calls),
    );
    if (!r.ok) throw new Error(msg(r.error));
    expect(actionV2(r.value.results[0])).toBe('adopted');
    expect(calls).toHaveLength(0);
  });
});
