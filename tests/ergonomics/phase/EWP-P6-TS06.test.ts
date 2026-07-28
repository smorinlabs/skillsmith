import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..', '..');
const SHA = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);

const source = (path: string): Promise<string> => readFile(resolve(ROOT, path), 'utf8');
const loadGates = async (): Promise<Record<string, unknown>> =>
  (await import('../../../scripts/release-gates.ts')) as Record<string, unknown>;
const requireGate = (
  module: Readonly<Record<string, unknown>>,
  name: string,
): ((input: unknown) => unknown) => {
  const gate = module[name];
  expect(typeof gate, `${name} must be executable rather than prose-only`).toBe('function');
  if (typeof gate !== 'function') throw new Error(`${name} is absent`);
  return gate as (input: unknown) => unknown;
};

const jobBlock = (workflow: string, name: string, nextName: string): string => {
  const start = workflow.indexOf(`  ${name}:`);
  const end = workflow.indexOf(`  ${nextName}:`, start + 1);
  expect(start, `${name} job must exist`).toBeGreaterThanOrEqual(0);
  expect(end, `${nextName} job must follow ${name}`).toBeGreaterThan(start);
  return workflow.slice(start, end);
};

describe('EWP-P6-TS06', () => {
  test('family 1: canonical local, CI, and pre-push gates execute the exact serial runner once', async () => {
    const [justfile, ci, hooks, packageJson] = await Promise.all([
      source('justfile'),
      source('.github/workflows/ci.yml'),
      source('lefthook.yml'),
      source('package.json'),
    ]);
    expect(justfile).toContain('release-check lane:');
    expect(justfile.match(/scripts\/run-test-files-serial\.ts/gu)).toHaveLength(1);
    expect(ci).toContain('run: just check');
    expect(ci).toContain('just-version: 1.50.0');
    expect(ci).toContain('ubuntu-24.04-arm');
    expect(ci).toContain('macos-15-intel');
    expect(hooks).toContain('bun scripts/run-test-files-serial.ts');
    expect(packageJson).toContain('"test:terminal"');
  });

  test('family 2: Release Please uses its protected App, exact v1.0.0, and derived-file sync', async () => {
    const [workflow, config] = await Promise.all([
      source('.github/workflows/release-please.yml'),
      source('release-please-config.json'),
    ]);
    expect(workflow).toContain('environment: release-please');
    expect(workflow).toContain(
      'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1',
    );
    expect(workflow).toContain(
      'googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7',
    );
    expect(workflow).toContain('bun install --ignore-scripts');
    expect(workflow).toContain('generate-command-reference.ts --write');
    expect(workflow).toContain('Release-As: 1.0.0');
    expect(config).toContain('"draft": true');
  });

  test('family 3: the tag guard rejects every identity other than exact P17 v1.0.0', async () => {
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
    expect(validate(valid)).toMatchObject({ tag: 'v1.0.0', version: '1.0.0' });
    expect(() => validate({ ...valid, tag: 'v0.8.0' })).toThrow();
    expect(() => validate({ ...valid, githubSha: 'c'.repeat(40) })).toThrow();
    expect(() => validate({ ...valid, generatedVersion: '0.7.0' })).toThrow();
    const workflow = await source('.github/workflows/release.yml');
    expect(workflow).toContain('test "$GITHUB_REF" = "refs/tags/$RELEASE_TAG"');
    expect(workflow).toContain('test "$sha" = "$GITHUB_SHA"');
  });

  test('family 4: Apple-only initial build and credential-free retained recovery are exclusive', async () => {
    const [workflow, goreleaser, adapter] = await Promise.all([
      source('.github/workflows/release.yml'),
      source('.goreleaser.yaml'),
      source('scripts/release-artifacts.ts'),
    ]);
    const resolveSource = requireGate(await loadGates(), 'resolveCandidateSource');
    expect(resolveSource({ irreversiblePublication: false, retainedCandidate: null })).toEqual({
      mode: 'build',
    });
    expect(workflow).toContain('environment: release-candidate');
    expect(workflow).toContain('retained-candidate');
    expect(workflow).toContain('retention-days: 90');
    expect(workflow).toContain('bun scripts/build-release.ts --target all --mode release');
    expect(adapter).toContain("'--skip=publish,announce'");
    expect(goreleaser).toContain('notarize:');
    expect(goreleaser).toContain('wait: true');
  });

  test('family 5: one common and four native same-candidate receipts close through always aggregate', async () => {
    const [workflow, releaseCheck] = await Promise.all([
      source('.github/workflows/release.yml'),
      source('scripts/release-check.ts'),
    ]);
    const validate = requireGate(await loadGates(), 'validateReleaseReceiptSet');
    const receipt = (lane: string, receiptArtifactId: string) => ({
      candidateArtifactId: 'candidate-17',
      candidateBundleSha256: DIGEST,
      candidateMetadataSha256: 'c'.repeat(64),
      lane,
      receiptArtifactId,
      requiredSkips: 0,
      runId: '44',
      sha: SHA,
      status: 'passed',
      tag: 'v1.0.0',
      tests: 1,
      version: '1.0.0',
    });
    const native = [
      receipt('native-linux-x64', 'linux-x64'),
      receipt('native-linux-arm64', 'linux-arm64'),
      receipt('native-darwin-arm64', 'darwin-arm64'),
      receipt('native-darwin-x64', 'darwin-x64'),
    ];
    expect(validate({ common: receipt('common', 'common'), native })).toMatchObject({
      receiptCount: 5,
    });
    expect(() =>
      validate({ common: receipt('common', 'common'), native: native.slice(1) }),
    ).toThrow();
    expect(workflow).toContain('if: ${{ always() }}');
    expect(workflow).toContain('candidateMetadataSha256');
    expect(releaseCheck).toContain('candidate metadata SHA-256 mismatch');
    expect(releaseCheck).toContain("['brew', '--prefix']");
    expect(releaseCheck).not.toContain("runChecked(['skillsmith', 'version']");
    for (const label of ['ubuntu-24.04', 'ubuntu-24.04-arm', 'macos-15', 'macos-15-intel']) {
      expect(workflow, label).toContain(label);
    }
  });

  test('family 6: real Claude and Codex execute named nonempty zero-skip candidate selectors', async () => {
    const workflow = await source('.github/workflows/release.yml');
    expect(workflow).toContain('@anthropic-ai/claude-code@2.1.202');
    expect(workflow).toContain('@openai/codex@0.142.5');
    expect(workflow).toContain('SKILLSMITH_E2E:');
    expect(workflow).toContain('release-candidate compatibility');
    expect(workflow).toContain('requiredSkips');
  });

  test('family 7: all authority preflights succeed before the sole publication-ready aggregate', async () => {
    const workflow = await source('.github/workflows/release.yml');
    for (const job of [
      'github-preflight:',
      'npm-preflight:',
      'homebrew-preflight:',
      'publication-ready:',
    ]) {
      expect(workflow, job).toContain(job);
    }
    expect(workflow).toContain('environment: github-release');
    expect(workflow).toContain('environment: npm');
    expect(workflow).toContain('environment: homebrew');
    expect(workflow).toMatch(/needs:.*publication-ready/u);
    expect(workflow).toContain('PUBLIC_AUDIT_APPROVED_SHA');
    expect(workflow).toContain('PUBLIC_VISIBILITY_AUTHORIZED_SHA');
    expect(workflow).toContain('ACTIONS_ID_TOKEN_REQUEST_URL');
    expect(workflow).toContain('npm ping');
    expect(workflow).toContain('validatePublicationReadiness');
    expect(workflow).toContain('git rev-list --count');
    expect(workflow).toContain('candidateMetadataSha256');
    const githubPreflight = jobBlock(workflow, 'github-preflight', 'npm-preflight');
    expect(githubPreflight).not.toContain('contents: write');
    expect(githubPreflight).not.toContain('attestations: write');
  });

  test('family 8: publication recovery closes GitHub, five npm packages, and tap merged state', async () => {
    const classify = requireGate(await loadGates(), 'classifyPublicationState');
    expect(
      classify({
        candidateRetained: true,
        github: 'public-exact',
        npm: Array.from({ length: 5 }, () => 'exact'),
        tap: 'merged-exact',
      }),
    ).toEqual({ mode: 'complete', complete: true });
    expect(() =>
      classify({
        candidateRetained: false,
        github: 'public-exact',
        npm: Array.from({ length: 5 }, () => 'exact'),
        tap: 'open-exact',
      }),
    ).toThrow();
    const workflow = await source('.github/workflows/release.yml');
    expect(workflow).toContain('gh attestation verify');
    expect(workflow).toContain('npm registry state is unavailable');
    expect(workflow).toContain('occupied Homebrew cask mismatches the candidate');
    expect(() =>
      classify({
        candidateRetained: true,
        github: 'public-exact',
        npm: ['exact', 'exact', 'mismatch', 'missing', 'missing'],
        tap: 'absent',
      }),
    ).toThrow();
  });

  test('family 9: executable external readiness refuses every missing authority or public audit', async () => {
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
    expect(() => validate({ ...valid, billing: false })).toThrow();
    expect(() => validate({ ...valid, audit: false })).toThrow();
    expect(() => validate({ ...valid, visibilityAuthorized: false })).toThrow();
    expect(() => validate({ ...valid, npmTrusts: 4 })).toThrow();
  });

  test('family 10: ADR, docs, action pins, and exact verified tool installers stay coherent', async () => {
    const [adr, docs, gitleaks, actionlint, dependabot, ...workflows] = await Promise.all([
      source('docs/adr/0010-release-validation-and-publication.md'),
      source('docs/releases.md'),
      source('scripts/install-gitleaks.sh'),
      source('scripts/install-actionlint.sh'),
      source('.github/dependabot.yml'),
      source('.github/workflows/ci.yml'),
      source('.github/workflows/commitlint.yml'),
      source('.github/workflows/release-please.yml'),
      source('.github/workflows/release.yml'),
    ]);
    expect(adr).toContain('Accepted');
    expect(adr).toContain('candidate');
    expect(docs).toContain('v1.0.0');
    expect(gitleaks).toContain('5bc41815076e6ed6ef8fbecc9d9b75bcae31f39029ceb55da08086315316e3ba');
    expect(actionlint).toContain(
      '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8',
    );
    expect(gitleaks).not.toContain('brew install gitleaks');
    expect(actionlint).not.toContain('actionlint/main/');
    expect(dependabot).toContain('package-ecosystem: github-actions');
    for (const workflow of workflows) {
      const references = [...workflow.matchAll(/uses:\s+[^\s@]+@([^\s#]+)/gu)];
      expect(references.length).toBeGreaterThan(0);
      for (const reference of references) expect(reference[1]).toMatch(/^[0-9a-f]{40}$/u);
    }
  });
});
