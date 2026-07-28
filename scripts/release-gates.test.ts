import { describe, expect, test } from 'bun:test';

const SHA = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);

const loadGates = async (): Promise<Record<string, unknown>> =>
  (await import('./release-gates.ts')) as Record<string, unknown>;

const requireGate = (
  module: Readonly<Record<string, unknown>>,
  name: string,
): ((input: unknown) => unknown) => {
  const gate = module[name];
  expect(typeof gate, `${name} must be an executable public release-gate seam`).toBe('function');
  if (typeof gate !== 'function') throw new Error(`${name} is absent`);
  return gate as (input: unknown) => unknown;
};

const receipt = (lane: string, receiptArtifactId: string) => ({
  candidateArtifactId: 'candidate-17',
  candidateBundleSha256: DIGEST,
  receiptArtifactId,
  runId: '44',
  sha: SHA,
  status: 'passed',
  tag: 'v1.0.0',
  tests: 1,
  requiredSkips: 0,
  lane,
});

describe('release gate behavioral contracts', () => {
  test('accepts only the exact P17 v1.0.0 tag, source, versions, generated state, and release state', async () => {
    const validate = requireGate(await loadGates(), 'validateP17ReleaseIdentity');
    const valid = {
      defaultBranchContainsSha: true,
      generatedVersion: '1.0.0',
      githubSha: SHA,
      lockVersions: ['1.0.0', '1.0.0'],
      manifestVersion: '1.0.0',
      packageVersions: ['1.0.0', '1.0.0', '1.0.0'],
      release: { draft: true, immutable: false, prerelease: false, targetCommitish: SHA },
      tag: 'v1.0.0',
      tagCommit: SHA,
    };
    expect(validate(valid)).toEqual({ sha: SHA, tag: 'v1.0.0', version: '1.0.0' });
    for (const invalid of [
      { ...valid, tag: 'v0.8.0' },
      { ...valid, tag: 'v1.0.0-rc.1' },
      { ...valid, generatedVersion: '0.7.0' },
      { ...valid, lockVersions: ['0.7.0', '0.7.0'] },
      { ...valid, defaultBranchContainsSha: false },
      { ...valid, release: { ...valid.release, targetCommitish: 'c'.repeat(40) } },
    ]) {
      expect(() => validate(invalid), JSON.stringify(invalid)).toThrow();
    }
  });

  test('selects exactly one initial build or retained candidate and never rebuilds after publication', async () => {
    const resolveSource = requireGate(await loadGates(), 'resolveCandidateSource');
    expect(resolveSource({ irreversiblePublication: false, retainedCandidate: null })).toEqual({
      mode: 'build',
    });
    const retainedCandidate = {
      artifactDigest: DIGEST,
      artifactId: 'candidate-17',
      bundleSha256: DIGEST,
      expiresAt: '2026-10-26T00:00:00Z',
      runId: '44',
    };
    expect(
      resolveSource({
        irreversiblePublication: true,
        now: '2026-07-28T00:00:00Z',
        retainedCandidate,
      }),
    ).toEqual({ mode: 'restore', retainedCandidate });
    expect(() =>
      resolveSource({ irreversiblePublication: true, retainedCandidate: null }),
    ).toThrow();
    expect(() =>
      resolveSource({
        irreversiblePublication: true,
        now: '2026-10-27T00:00:00Z',
        retainedCandidate,
      }),
    ).toThrow();
  });

  test('closes one common and four unique native same-candidate receipts under an aggregate', async () => {
    const validate = requireGate(await loadGates(), 'validateReleaseReceiptSet');
    const valid = {
      common: receipt('common', 'receipt-common'),
      native: [
        receipt('native-linux-x64', 'receipt-linux-x64'),
        receipt('native-linux-arm64', 'receipt-linux-arm64'),
        receipt('native-darwin-arm64', 'receipt-darwin-arm64'),
        receipt('native-darwin-x64', 'receipt-darwin-x64'),
      ],
    };
    expect(validate(valid)).toMatchObject({ candidateBundleSha256: DIGEST, receiptCount: 5 });
    expect(() => validate({ ...valid, native: valid.native.slice(1) })).toThrow();
    expect(() =>
      validate({ ...valid, native: [...valid.native.slice(0, -1), valid.native[0]] }),
    ).toThrow();
    expect(() =>
      validate({
        ...valid,
        native: valid.native.map((value, index) =>
          index === 0 ? { ...value, candidateBundleSha256: 'c'.repeat(64) } : value,
        ),
      }),
    ).toThrow();
  });

  test('classifies GitHub, npm, and tap missing/exact/mismatch recovery without false atomicity', async () => {
    const classify = requireGate(await loadGates(), 'classifyPublicationState');
    expect(
      classify({
        candidateRetained: true,
        github: 'draft-exact',
        npm: Array.from({ length: 5 }, () => 'missing'),
        tap: 'absent',
      }),
    ).toEqual({ mode: 'initial', complete: false });
    expect(
      classify({
        candidateRetained: true,
        github: 'public-exact',
        npm: Array.from({ length: 5 }, () => 'exact'),
        tap: 'open-exact',
      }),
    ).toEqual({ mode: 'resume', complete: false });
    expect(
      classify({
        candidateRetained: true,
        github: 'public-exact',
        npm: Array.from({ length: 5 }, () => 'exact'),
        tap: 'merged-exact',
      }),
    ).toEqual({ mode: 'complete', complete: true });
    expect(
      classify({
        candidateRetained: true,
        github: 'public-exact',
        npm: ['exact', 'exact', 'missing', 'missing', 'missing'],
        tap: 'absent',
      }),
    ).toEqual({ mode: 'resume', complete: false });
    for (const invalid of [
      { candidateRetained: true, github: 'mismatch', npm: ['missing'], tap: 'absent' },
      { candidateRetained: true, github: 'draft-exact', npm: ['mismatch'], tap: 'absent' },
      {
        candidateRetained: true,
        github: 'draft-exact',
        npm: ['exact', 'missing', 'missing', 'missing', 'missing'],
        tap: 'absent',
      },
      {
        candidateRetained: false,
        github: 'public-exact',
        npm: Array.from({ length: 5 }, () => 'exact'),
        tap: 'open-exact',
      },
      {
        candidateRetained: false,
        github: 'public-exact',
        npm: ['exact', 'exact', 'missing', 'missing', 'missing'],
        tap: 'absent',
      },
    ]) {
      expect(() => classify(invalid), JSON.stringify(invalid)).toThrow();
    }
  });

  test('accepts only the exact version and official archive digest for release tools', async () => {
    const validate = requireGate(await loadGates(), 'validateReleaseToolArchive');
    const valid = {
      actualVersion: '1.7.12',
      archiveSha256: '325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6',
      platform: 'linux-arm64',
      tool: 'actionlint',
    };
    expect(validate(valid)).toEqual(valid);
    expect(() => validate({ ...valid, actualVersion: '1.7.11' })).toThrow();
    expect(() => validate({ ...valid, archiveSha256: DIGEST })).toThrow();
    expect(() => validate({ ...valid, platform: 'windows-x64' })).toThrow();
  });

  test('requires every external authority and audit receipt before publication readiness', async () => {
    const validate = requireGate(await loadGates(), 'validateExternalReadiness');
    const valid = {
      apple: true,
      audit: true,
      billing: true,
      environments: ['release-please', 'release-candidate', 'github-release', 'npm', 'homebrew'],
      immutableReleases: true,
      npmTrusts: 5,
      runnerLabels: ['ubuntu-24.04', 'ubuntu-24.04-arm', 'macos-15', 'macos-15-intel'],
      tapCi: true,
      visibilityAuthorized: true,
    };
    expect(validate(valid)).toEqual({ ready: true });
    for (const key of ['apple', 'audit', 'billing', 'immutableReleases', 'tapCi'] as const) {
      expect(() => validate({ ...valid, [key]: false }), key).toThrow();
    }
    expect(() => validate({ ...valid, npmTrusts: 4 })).toThrow();
    expect(() => validate({ ...valid, runnerLabels: valid.runnerLabels.slice(1) })).toThrow();
  });
});
