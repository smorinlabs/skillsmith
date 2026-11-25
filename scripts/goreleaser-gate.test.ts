import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import * as runner from './run-test-files-serial';

// EWP-P6-TS01 families 3, 5, 6, 7 and 9 build a real GoReleaser snapshot candidate. A machine
// without goreleaser skips them with a stated reason; CI sets SKILLSMITH_REQUIRE_GORELEASER=1,
// under which a missing goreleaser runs the families and fails them instead of skipping.

const ROOT = resolve(import.meta.dir, '..');
const TS01 = 'tests/ergonomics/phase/EWP-P6-TS01.test.ts';
const REQUIRE = 'SKILLSMITH_REQUIRE_GORELEASER';

type Gate = (probes: {
  goreleaser?: () => string | null;
  env?: Readonly<Record<string, string | undefined>>;
}) => boolean;
const gate = (): Gate => {
  const value = (runner as Record<string, unknown>).goreleaserCandidateBuildEnabled;
  expect(typeof value, 'goreleaserCandidateBuildEnabled must exist').toBe('function');
  return value as Gate;
};

const pathWithoutGoreleaser = (): string =>
  (process.env.PATH ?? '')
    .split(delimiter)
    .filter((entry) => entry && !existsSync(join(entry, 'goreleaser')))
    .join(delimiter);

const runFamily3 = (required: boolean) => {
  const env: Record<string, string | undefined> = { ...process.env, PATH: pathWithoutGoreleaser() };
  delete env[REQUIRE];
  if (required) env[REQUIRE] = '1';
  const result = Bun.spawnSync(
    [process.execPath, 'test', `./${TS01}`, '--test-name-pattern', 'family 3:'],
    { cwd: ROOT, env, stdout: 'pipe', stderr: 'pipe', timeout: 120_000 },
  );
  return {
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}\n${result.stderr.toString()}`,
  };
};

describe('GoReleaser candidate-build gate', () => {
  test('the gate skips only when goreleaser is absent and not required', () => {
    const enabled = gate();
    expect(enabled({ goreleaser: () => '/usr/local/bin/goreleaser', env: {} })).toBe(true);
    expect(enabled({ goreleaser: () => null, env: {} })).toBe(false);
    expect(enabled({ goreleaser: () => null, env: { [REQUIRE]: '1' } })).toBe(true);
    expect(enabled({ goreleaser: () => null, env: { [REQUIRE]: '0' } })).toBe(false);
    const broken = () => {
      throw new Error('probe boom');
    };
    expect(enabled({ goreleaser: broken, env: {} })).toBe(false);
    expect(enabled({ goreleaser: broken, env: { [REQUIRE]: '1' } })).toBe(true);
  });

  test('the runner expects five TS01 skips only when the gate is closed', () => {
    const file = (runner as Record<string, unknown>).ENV_GORELEASER_SKIP_FILE;
    const count = (runner as Record<string, unknown>).ENV_GORELEASER_SKIP_COUNT;
    expect(file).toBe(TS01);
    expect(count).toBe(5);
    const closed = runner.resolveAllowedSkips({ goreleaser: () => null, env: {} } as never);
    expect(closed.get(TS01)).toBe(5);
    const present = runner.resolveAllowedSkips({ goreleaser: () => '/bin/goreleaser' } as never);
    expect(present.get(TS01)).toBe(0);
    const required = runner.resolveAllowedSkips({
      goreleaser: () => null,
      env: { [REQUIRE]: '1' },
    } as never);
    expect(required.get(TS01)).toBe(0);
    expect(runner.PINNED_CAPABILITY_SKIPS.get(TS01)).toBe(0);
  });

  test('without goreleaser, a local run skips family 3 and names the missing tool', () => {
    const result = runFamily3(false);
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toMatch(/\b1 skip\b/u);
    expect(result.output).toMatch(/\b0 pass\b/u);
    expect(result.output).toContain('goreleaser is not on PATH');
  }, 120_000);

  test(`with ${REQUIRE}=1, a missing goreleaser fails family 3 instead of skipping it`, () => {
    const result = runFamily3(true);
    expect(result.exitCode, result.output).not.toBe(0);
    expect(result.output).toMatch(/\b1 fail\b/u);
    expect(result.output).not.toMatch(/\b1 skip\b/u);
    expect(result.output).toContain('exact GoReleaser and npm tools must be installed');
  }, 120_000);

  test('CI test shards require goreleaser', () => {
    const ci = Bun.YAML.parse(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')) as {
      jobs: Record<string, { steps?: { name?: string; env?: Record<string, unknown> }[] }>;
    };
    const step = ci.jobs['test-shard']?.steps?.find((item) => item.name === 'Run test shard');
    expect(step?.env?.[REQUIRE]).toBe('1');
  });

  test('TS01 gates exactly the five candidate-build families', () => {
    const source = readFileSync(join(ROOT, TS01), 'utf8');
    const gated = [
      ...source.matchAll(/test\.skipIf\(!CANDIDATE_BUILD_ENABLED\)\(\s*'(family \d+):/gu),
    ].map((match) => match[1]);
    expect(gated).toEqual(['family 3', 'family 5', 'family 6', 'family 7', 'family 9']);
  });
});
