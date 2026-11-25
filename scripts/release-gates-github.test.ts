import { describe, expect, test } from 'bun:test';
import * as gates from './release-gates';

// GitHub-only variants for v1.0.0 (P24). The all-channel validators stay for the first signed
// release; these variants accept only the GitHub channel and reject any deferred channel.

const SHA = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);
type Gate = (input: unknown) => unknown;
const gate = (name: string): Gate => {
  const value = (gates as Record<string, unknown>)[name];
  expect(typeof value, `${name} must exist`).toBe('function');
  return value as Gate;
};

const external = {
  audit: true,
  billing: true,
  environments: ['release-please', 'release-candidate', 'github-release'],
  immutableReleases: true,
  runnerLabels: ['ubuntu-24.04', 'ubuntu-24.04-arm', 'macos-15', 'macos-15-intel'],
  visibilityAuthorized: true,
};
const identity = {
  candidateArtifactId: 'candidate-17',
  candidateBundleSha256: DIGEST,
  candidateMetadataSha256: 'c'.repeat(64),
  sha: SHA,
  tag: 'v1.0.0',
  version: '1.0.0',
};
const githubPreflight = (state: string) => ({
  ...identity,
  channel: 'github',
  state,
  status: 'passed',
});

const publicReceipt = (runner: string) => ({
  ...identity,
  aliasesAdjacent: true,
  attestationVerified: true,
  capabilityOrientation: true,
  channelBinarySha256: { direct: DIGEST },
  channels: ['direct'],
  cleanOwnedPrefix: true,
  commands: [...gates.PUBLIC_COMMAND_ORDER],
  completionZshValid: true,
  directChecksumVerified: true,
  directUninstall: true,
  fleetCases: 7,
  noSourceCheckoutOnPath: true,
  noToolDiagnosis: true,
  readOnlyMutationExit: 4,
  requiredSkips: 0,
  runner,
  writesWithinRoots: true,
});
const receipts = () =>
  ['ubuntu-24.04', 'ubuntu-24.04-arm', 'macos-15', 'macos-15-intel'].map(publicReceipt);

describe('GitHub-only release gates', () => {
  test('external readiness needs three environments and rejects deferred authorities', () => {
    const validate = gate('validateGithubOnlyExternalReadiness');
    expect(validate(external)).toEqual({ ready: true });
    for (const key of ['audit', 'billing', 'immutableReleases', 'visibilityAuthorized'])
      expect(() => validate({ ...external, [key]: false }), key).toThrow();
    expect(() =>
      validate({ ...external, environments: [...external.environments, 'npm'] }),
    ).toThrow();
    expect(() => validate({ ...external, runnerLabels: external.runnerLabels.slice(1) })).toThrow();
    for (const deferred of [{ apple: true }, { tapCi: true }, { npmTrusts: 5 }])
      expect(() => validate({ ...external, ...deferred })).toThrow('deferred');
  });

  test('publication state has one GitHub channel', () => {
    const classify = gate('classifyGithubOnlyPublicationState');
    expect(classify({ candidateRetained: true, github: 'draft-exact' })).toEqual({
      complete: false,
      mode: 'initial',
    });
    expect(classify({ candidateRetained: true, github: 'public-exact' })).toEqual({
      complete: true,
      mode: 'complete',
    });
    expect(() => classify({ candidateRetained: false, github: 'public-exact' })).toThrow();
    expect(() => classify({ candidateRetained: true, github: 'mismatch' })).toThrow();
    expect(() =>
      classify({ candidateRetained: true, github: 'draft-exact', npm: [], tap: 'absent' }),
    ).toThrow('deferred');
  });

  test('publication readiness accepts exactly the GitHub preflight', () => {
    const validate = gate('validateGithubOnlyPublicationReadiness');
    expect(
      validate({ candidateRetained: true, external, preflights: [githubPreflight('draft-exact')] }),
    ).toMatchObject({ ...identity, mode: 'initial', status: 'passed' });
    expect(() =>
      validate({
        candidateRetained: true,
        external,
        preflights: [
          githubPreflight('draft-exact'),
          { ...identity, channel: 'npm', states: [], status: 'passed' },
        ],
      }),
    ).toThrow();
    expect(() => validate({ candidateRetained: true, external, preflights: [] })).toThrow();
    expect(() =>
      validate({
        candidateRetained: true,
        external: { ...external, apple: true },
        preflights: [githubPreflight('draft-exact')],
      }),
    ).toThrow('deferred');
  });

  test('public receipts prove only the direct channel on all four runners', () => {
    const validate = gate('validateGithubOnlyPublicReceipts');
    expect(validate({ receipts: receipts() })).toEqual({ receiptCount: 4, version: '1.0.0' });
    const mutate = (change: Record<string, unknown>) =>
      receipts().map((receipt, index) => (index === 0 ? { ...receipt, ...change } : receipt));
    expect(() =>
      validate({
        receipts: mutate({
          channels: ['direct', 'npm'],
          channelBinarySha256: { direct: DIGEST, npm: DIGEST },
        }),
      }),
    ).toThrow();
    expect(() => validate({ receipts: mutate({ directUninstall: false }) })).toThrow();
    expect(() => validate({ receipts: mutate({ requiredSkips: 1 }) })).toThrow();
    expect(() => validate({ receipts: receipts().slice(1) })).toThrow();
  });
});
