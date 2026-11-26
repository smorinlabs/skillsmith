import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  LIVE_RELEASE_SUITES,
  LIVE_RELEASE_TEST_NAME_PATTERN,
  isReleasePlatformPackage,
  liveReleaseEvidence,
  packageLaneTools,
} from './release-check.ts';

const ROOT = resolve(import.meta.dir, '..');
const LIVE_FILE = 'packages/core/tests/verify/live-e2e.test.ts';
const OUTER = 'verify live e2e (real claude/codex/muse/agy CLIs)';

const suite = (name: string, tests: number, skipped: number, failures = 0): string =>
  `<testsuite name="${name}" file="${LIVE_FILE}" line="1" tests="${tests}" assertions="${tests}" failures="${failures}" skipped="${skipped}" time="0" hostname="host">`;

const report = (...suites: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" tests="15">\n${suites.join('\n')}\n</testsuites>`;

// The shape the common lane sees in CI: the name filter runs the two named suites and reports
// the Muse and Antigravity suites as skipped.
const ciShape = (): string =>
  report(
    suite(LIVE_FILE, 15, 7),
    suite(OUTER, 15, 7),
    suite('claude-code', 5, 0),
    suite('codex', 3, 0),
    suite('muse', 3, 3),
    suite('antigravity', 4, 4),
  );

async function toolFreeLiveReport(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'skillsmith-release-check-test-'));
  try {
    const outfile = join(root, 'live.xml');
    const bun = Bun.which('bun');
    if (bun === null) throw new Error('bun is not on PATH');
    const run = Bun.spawnSync(
      [bun, 'test', LIVE_FILE, '--reporter=junit', `--reporter-outfile=${outfile}`],
      { cwd: ROOT, env: { HOME: root, PATH: '/usr/bin:/bin' }, stdout: 'pipe', stderr: 'pipe' },
    );
    if (run.exitCode !== 0) throw new Error(`live suite listing failed: ${run.stderr.toString()}`);
    return await readFile(outfile, 'utf8');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

describe('release-check real-tool evidence', () => {
  test('counts only the named Claude Code and Codex suites', () => {
    expect(liveReleaseEvidence(ciShape())).toBe(8);
  });

  test('rejects a skipped, failed, resized, missing, or duplicated named suite', () => {
    const swap = (from: string, to: string): string => ciShape().replace(from, to);
    expect(() => liveReleaseEvidence(swap(suite('codex', 3, 0), suite('codex', 3, 3)))).toThrow(
      'skipped or failed codex',
    );
    expect(() =>
      liveReleaseEvidence(swap(suite('claude-code', 5, 0), suite('claude-code', 5, 0, 1))),
    ).toThrow('skipped or failed claude-code');
    expect(() =>
      liveReleaseEvidence(swap(suite('claude-code', 5, 0), suite('claude-code', 4, 0))),
    ).toThrow('ran 4 claude-code tests; expected 5');
    expect(() => liveReleaseEvidence(swap(suite('codex', 3, 0), ''))).toThrow('has 0 codex suites');
    expect(() =>
      liveReleaseEvidence(
        swap(suite('codex', 3, 0), `${suite('codex', 3, 0)}\n${suite('codex', 3, 0)}`),
      ),
    ).toThrow('has 2 codex suites');
  });

  test('the declared suite sizes match live-e2e.test.ts, and a tool-free run is rejected', async () => {
    const xml = await toolFreeLiveReport();
    for (const [name] of LIVE_RELEASE_SUITES)
      expect(xml).toContain(`<testsuite name="${name}" file="${LIVE_FILE}"`);
    for (const [name, expected] of LIVE_RELEASE_SUITES) {
      const fragment = xml.match(new RegExp(`<testsuite name="${name}"[^>]*>`))?.[0] ?? '';
      expect(fragment).toContain(`tests="${expected}"`);
    }
    expect(() => liveReleaseEvidence(xml)).toThrow('skipped or failed claude-code');
  });

  test('the name filter selects the Claude Code and Codex tests only', () => {
    const filter = new RegExp(LIVE_RELEASE_TEST_NAME_PATTERN);
    expect(filter.test(`${OUTER} claude-code static: dummytest`)).toBe(true);
    expect(filter.test(`${OUTER} codex deep: dummytest`)).toBe(true);
    expect(filter.test(`${OUTER} muse static: dummytest`)).toBe(false);
    expect(filter.test(`${OUTER} antigravity static: dummytest`)).toBe(false);
  });
});

describe('release-check package lanes', () => {
  test('the stub registry tolerates only the release platform packages', () => {
    for (const id of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'])
      expect(isReleasePlatformPackage(`@smorinlabs/skillsmith-${id}`)).toBe(true);
    expect(isReleasePlatformPackage('@smorinlabs/skillsmith')).toBe(false);
    expect(isReleasePlatformPackage('@smorinlabs/skillsmith-windows-x64')).toBe(false);
    expect(isReleasePlatformPackage('left-pad')).toBe(false);
  });

  test('both package lanes put git on the private PATH', () => {
    expect(packageLaneTools('npm')).toEqual(['sh', 'git', 'node', 'npm']);
    expect(packageLaneTools('bun')).toEqual(['sh', 'bun', 'git']);
  });
});
