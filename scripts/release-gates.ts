const SHA_1 = /^[0-9a-f]{40}$/u;
const SHA_256 = /^[0-9a-f]{64}$/u;
const P17_VERSION = '1.0.0';
const P17_TAG = 'v1.0.0';

export const RELEASE_RUNNER_LABELS = [
  'ubuntu-24.04',
  'ubuntu-24.04-arm',
  'macos-15',
  'macos-15-intel',
] as const;

export const RELEASE_NATIVE_LANES = [
  'native-linux-x64',
  'native-linux-arm64',
  'native-darwin-arm64',
  'native-darwin-x64',
] as const;

export const RELEASE_ENVIRONMENTS = [
  'release-please',
  'release-candidate',
  'github-release',
  'npm',
  'homebrew',
] as const;

export const PUBLIC_COMMAND_ORDER = [
  'agents',
  'list',
  'commands',
  'status',
  'install',
  'uninstall',
  'update',
  'undo',
  'dev',
  'verify',
  'promote',
  'init',
  'export',
  'plan',
  'apply',
  'sync',
  'doctor',
  'check',
  'gc',
  'config',
  'completion',
  'version',
  'help',
] as const;

export const RELEASE_TOOL_ARCHIVE_SHA256 = {
  actionlint: {
    version: '1.7.12',
    archives: {
      'darwin-x64': '5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644',
      'darwin-arm64': 'aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f',
      'linux-x64': '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8',
      'linux-arm64': '325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6',
    },
  },
  gitleaks: {
    version: '8.21.2',
    archives: {
      'darwin-x64': '5b42c6e4b1fd693eaeb2b5b7faa5f17a1434299d4deb2de63d4b2efd7c753128',
      'darwin-arm64': 'cad3de5dc9a4d5447d967a70a4d49499c557f04db028274cc324f9ff983f6502',
      'linux-x64': '5bc41815076e6ed6ef8fbecc9d9b75bcae31f39029ceb55da08086315316e3ba',
      'linux-arm64': '654c935542c89f565aabe7bf7c6c500830f116c114f0aeb509d2460c1ac2e6da',
    },
  },
} as const;

type UnknownRecord = Record<string, unknown>;

function fail(message: string): never {
  throw new Error(message);
}

function record(value: unknown, label: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as UnknownRecord;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a nonempty string`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail(`${label} must be boolean`);
  return value;
}

function number(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${label} must be a nonnegative safe integer`);
  }
  return value as number;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    fail(`${label} must be a string array`);
  }
  return value as string[];
}

function requireExactSet(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  if (
    actual.length !== expected.length ||
    new Set(actual).size !== actual.length ||
    [...actual].toSorted().join('\0') !== [...expected].toSorted().join('\0')
  ) {
    fail(`${label} is not the exact closed set`);
  }
}

function requireSha(value: unknown, pattern: RegExp, label: string): string {
  const candidate = string(value, label);
  if (!pattern.test(candidate)) fail(`${label} is malformed`);
  return candidate;
}

export function validateP17ReleaseIdentity(input: unknown): {
  sha: string;
  tag: 'v1.0.0';
  version: '1.0.0';
} {
  const value = record(input, 'release identity');
  const githubSha = requireSha(value.githubSha, SHA_1, 'github SHA');
  if (string(value.tag, 'tag') !== P17_TAG) fail('P17 release tag must be exactly v1.0.0');
  if (requireSha(value.tagCommit, SHA_1, 'tag commit') !== githubSha) {
    fail('tag commit does not equal GitHub SHA');
  }
  if (!boolean(value.defaultBranchContainsSha, 'default branch ancestry')) {
    fail('release SHA is not on the protected default branch');
  }
  if (string(value.manifestVersion, 'manifest version') !== P17_VERSION) {
    fail('release manifest is not 1.0.0');
  }
  if (string(value.generatedVersion, 'generated version') !== P17_VERSION) {
    fail('generated documentation is not 1.0.0');
  }
  const packageVersions = strings(value.packageVersions, 'package versions');
  if (packageVersions.length !== 3 || packageVersions.some((version) => version !== P17_VERSION)) {
    fail('root/CLI/core versions are not exactly 1.0.0');
  }
  const lockVersions = strings(value.lockVersions, 'lock versions');
  if (lockVersions.length !== 2 || lockVersions.some((version) => version !== P17_VERSION)) {
    fail('workspace lock versions are not exactly 1.0.0');
  }
  const release = record(value.release, 'GitHub release');
  if (requireSha(release.targetCommitish, SHA_1, 'release target') !== githubSha) {
    fail('release target does not equal GitHub SHA');
  }
  if (boolean(release.prerelease, 'release prerelease')) fail('P17 release cannot be a prerelease');
  const draft = boolean(release.draft, 'release draft');
  const immutable = boolean(release.immutable, 'release immutable');
  if (!((draft && !immutable) || (!draft && immutable))) {
    fail('release must be either an exact draft or an exact immutable public release');
  }
  return { sha: githubSha, tag: P17_TAG, version: P17_VERSION };
}

type RetainedCandidate = Readonly<{
  artifactDigest: string;
  artifactId: string;
  bundleSha256: string;
  expiresAt: string;
  runId: string;
}>;

function retainedCandidate(value: unknown): RetainedCandidate {
  const candidate = record(value, 'retained candidate');
  const expiresAt = string(candidate.expiresAt, 'candidate expiry');
  if (!Number.isFinite(Date.parse(expiresAt))) fail('candidate expiry is invalid');
  return {
    artifactDigest: requireSha(candidate.artifactDigest, SHA_256, 'artifact digest'),
    artifactId: string(candidate.artifactId, 'artifact ID'),
    bundleSha256: requireSha(candidate.bundleSha256, SHA_256, 'candidate bundle digest'),
    expiresAt,
    runId: string(candidate.runId, 'candidate run ID'),
  };
}

export function resolveCandidateSource(
  input: unknown,
): { mode: 'build' } | { mode: 'restore'; retainedCandidate: RetainedCandidate } {
  const value = record(input, 'candidate source');
  const irreversible = boolean(value.irreversiblePublication, 'publication state');
  if (value.retainedCandidate === null) {
    if (irreversible) fail('published state has no retained exact candidate');
    return { mode: 'build' };
  }
  const candidate = retainedCandidate(value.retainedCandidate);
  const now = Date.parse(string(value.now, 'candidate recovery time'));
  if (!Number.isFinite(now) || now >= Date.parse(candidate.expiresAt)) {
    fail('retained candidate is expired');
  }
  return { mode: 'restore', retainedCandidate: candidate };
}

type ValidReceipt = Readonly<{
  candidateArtifactId: string;
  candidateBundleSha256: string;
  lane: string;
  receiptArtifactId: string;
  requiredSkips: number;
  runId: string;
  sha: string;
  status: 'passed';
  tag: 'v1.0.0';
  tests: number;
}>;

function releaseReceipt(value: unknown, label: string): ValidReceipt {
  const receipt = record(value, label);
  if (string(receipt.status, `${label} status`) !== 'passed') fail(`${label} did not pass`);
  if (string(receipt.tag, `${label} tag`) !== P17_TAG) fail(`${label} tag is not v1.0.0`);
  const tests = number(receipt.tests, `${label} tests`);
  if (tests === 0) fail(`${label} is empty`);
  const requiredSkips = number(receipt.requiredSkips, `${label} required skips`);
  if (requiredSkips !== 0) fail(`${label} has a required skip`);
  return {
    candidateArtifactId: string(receipt.candidateArtifactId, `${label} candidate artifact ID`),
    candidateBundleSha256: requireSha(
      receipt.candidateBundleSha256,
      SHA_256,
      `${label} candidate digest`,
    ),
    lane: string(receipt.lane, `${label} lane`),
    receiptArtifactId: string(receipt.receiptArtifactId, `${label} receipt artifact ID`),
    requiredSkips,
    runId: string(receipt.runId, `${label} run ID`),
    sha: requireSha(receipt.sha, SHA_1, `${label} SHA`),
    status: 'passed',
    tag: P17_TAG,
    tests,
  };
}

export function validateReleaseReceiptSet(input: unknown): {
  candidateArtifactId: string;
  candidateBundleSha256: string;
  receiptCount: 5;
  runId: string;
  sha: string;
  tag: 'v1.0.0';
} {
  const value = record(input, 'release receipts');
  const common = releaseReceipt(value.common, 'common receipt');
  if (common.lane !== 'common') fail('common receipt has the wrong lane');
  if (!Array.isArray(value.native)) fail('native receipts must be an array');
  const native = value.native.map((receipt, index) =>
    releaseReceipt(receipt, `native receipt ${index + 1}`),
  );
  requireExactSet(
    native.map((receipt) => receipt.lane),
    RELEASE_NATIVE_LANES,
    'native lanes',
  );
  const receipts = [common, ...native];
  requireExactSet(
    receipts.map((receipt) => receipt.receiptArtifactId),
    receipts.map((receipt) => receipt.receiptArtifactId),
    'receipt artifact IDs',
  );
  for (const receipt of receipts) {
    if (
      receipt.candidateArtifactId !== common.candidateArtifactId ||
      receipt.candidateBundleSha256 !== common.candidateBundleSha256 ||
      receipt.runId !== common.runId ||
      receipt.sha !== common.sha ||
      receipt.tag !== common.tag
    ) {
      fail(`${receipt.lane} is not bound to the common candidate/run/source identity`);
    }
  }
  return {
    candidateArtifactId: common.candidateArtifactId,
    candidateBundleSha256: common.candidateBundleSha256,
    receiptCount: 5,
    runId: common.runId,
    sha: common.sha,
    tag: common.tag,
  };
}

type GitHubPublicationState = 'draft-exact' | 'public-exact' | 'mismatch';
type NpmPublicationState = 'missing' | 'exact' | 'mismatch';
type TapPublicationState = 'absent' | 'open-exact' | 'merged-exact' | 'mismatch';

export function classifyPublicationState(input: unknown): {
  complete: boolean;
  mode: 'initial' | 'resume' | 'complete';
} {
  const value = record(input, 'publication state');
  const candidateRetained = boolean(value.candidateRetained, 'candidate retention');
  const github = string(value.github, 'GitHub publication') as GitHubPublicationState;
  const npm = strings(value.npm, 'npm publication') as NpmPublicationState[];
  const tap = string(value.tap, 'tap publication') as TapPublicationState;
  if (!['draft-exact', 'public-exact', 'mismatch'].includes(github)) {
    fail('unknown GitHub publication state');
  }
  if (npm.length !== 5 || npm.some((state) => !['missing', 'exact', 'mismatch'].includes(state))) {
    fail('npm publication state must close exactly five package versions');
  }
  if (!['absent', 'open-exact', 'merged-exact', 'mismatch'].includes(tap)) {
    fail('unknown tap publication state');
  }
  if (github === 'mismatch' || npm.includes('mismatch') || tap === 'mismatch') {
    fail('occupied external publication state mismatches the candidate');
  }
  const allNpmExact = npm.every((state) => state === 'exact');
  const allNpmMissing = npm.every((state) => state === 'missing');
  const anyNpmExact = npm.includes('exact');
  if (anyNpmExact && github !== 'public-exact') {
    fail('npm publication exists ahead of GitHub closure');
  }
  if (
    (tap === 'open-exact' || tap === 'merged-exact') &&
    (!allNpmExact || github !== 'public-exact')
  ) {
    fail('tap state exists ahead of GitHub and npm closure');
  }
  const irreversible = github === 'public-exact' || anyNpmExact || tap !== 'absent';
  if (irreversible && !candidateRetained)
    fail('partial publication cannot recover without candidate');
  if (github === 'public-exact' && allNpmExact && tap === 'merged-exact') {
    return { complete: true, mode: 'complete' };
  }
  if (irreversible) return { complete: false, mode: 'resume' };
  if (github !== 'draft-exact' || !allNpmMissing || tap !== 'absent') {
    fail('initial publication state is incoherent');
  }
  return { complete: false, mode: 'initial' };
}

type ReleaseTool = keyof typeof RELEASE_TOOL_ARCHIVE_SHA256;
type ReleasePlatform = keyof (typeof RELEASE_TOOL_ARCHIVE_SHA256)['actionlint']['archives'];

export function validateReleaseToolArchive(input: unknown): unknown {
  const value = record(input, 'release tool archive');
  const tool = string(value.tool, 'release tool') as ReleaseTool;
  if (!(tool in RELEASE_TOOL_ARCHIVE_SHA256)) fail('unsupported release tool');
  const policy = RELEASE_TOOL_ARCHIVE_SHA256[tool];
  if (string(value.actualVersion, 'release tool version') !== policy.version) {
    fail(`${tool} version is not exactly ${policy.version}`);
  }
  const platform = string(value.platform, 'release tool platform') as ReleasePlatform;
  if (!(platform in policy.archives)) fail(`unsupported ${tool} platform`);
  const actualDigest = requireSha(value.archiveSha256, SHA_256, 'release tool archive digest');
  const expectedDigest = (policy.archives as Record<string, string>)[platform];
  if (actualDigest !== expectedDigest) fail(`${tool} archive digest mismatch`);
  return input;
}

export function validateExternalReadiness(input: unknown): { ready: true } {
  const value = record(input, 'external readiness');
  for (const key of [
    'apple',
    'audit',
    'billing',
    'immutableReleases',
    'tapCi',
    'visibilityAuthorized',
  ] as const) {
    if (!boolean(value[key], key)) fail(`${key} readiness is absent`);
  }
  requireExactSet(
    strings(value.environments, 'release environments'),
    RELEASE_ENVIRONMENTS,
    'release environments',
  );
  requireExactSet(
    strings(value.runnerLabels, 'runner labels'),
    RELEASE_RUNNER_LABELS,
    'runner labels',
  );
  if (number(value.npmTrusts, 'npm trusted publishers') !== 5) {
    fail('exactly five npm trusted publishers are required');
  }
  return { ready: true };
}

type PublicReceipt = Readonly<{
  aliasesAdjacent: true;
  candidateBundleSha256: string;
  capabilityOrientation: true;
  channels: string[];
  cleanOwnedPrefix: true;
  commands: string[];
  completionZshValid: true;
  fleetCases: 7;
  noSourceCheckoutOnPath: true;
  readOnlyMutationExit: 4;
  requiredSkips: 0;
  runner: string;
  sha: string;
  tag: 'v1.0.0';
  upgradeUninstall: true;
  version: '1.0.0';
  writesWithinRoots: true;
}>;

function publicReceipt(value: unknown, label: string): PublicReceipt {
  const receipt = record(value, label);
  if (string(receipt.tag, `${label} tag`) !== P17_TAG) fail(`${label} tag is not v1.0.0`);
  if (string(receipt.version, `${label} version`) !== P17_VERSION) {
    fail(`${label} version is not 1.0.0`);
  }
  if (!boolean(receipt.cleanOwnedPrefix, `${label} clean prefix`))
    fail(`${label} uninstall is dirty`);
  if (!boolean(receipt.completionZshValid, `${label} zsh completion`)) {
    fail(`${label} zsh completion is invalid`);
  }
  if (!boolean(receipt.noSourceCheckoutOnPath, `${label} source PATH isolation`)) {
    fail(`${label} used the source checkout on PATH`);
  }
  for (const [key, description] of [
    ['aliasesAdjacent', 'alias adjacency'],
    ['capabilityOrientation', 'capability orientation'],
    ['upgradeUninstall', 'upgrade/uninstall lifecycle'],
    ['writesWithinRoots', 'write-root confinement'],
  ] as const) {
    if (!boolean(receipt[key], `${label} ${description}`)) fail(`${label} failed ${description}`);
  }
  if (number(receipt.fleetCases, `${label} fleet cases`) !== 7) {
    fail(`${label} did not execute the seven-case fleet matrix`);
  }
  if (number(receipt.readOnlyMutationExit, `${label} read-only mutation exit`) !== 4) {
    fail(`${label} did not refuse a read-only target with exit 4`);
  }
  if (number(receipt.requiredSkips, `${label} required skips`) !== 0) {
    fail(`${label} contains a required skip`);
  }
  const commands = strings(receipt.commands, `${label} command order`);
  if (commands.join('\0') !== PUBLIC_COMMAND_ORDER.join('\0')) {
    fail(`${label} does not contain all 23 commands in group order`);
  }
  return {
    aliasesAdjacent: true,
    candidateBundleSha256: requireSha(
      receipt.candidateBundleSha256,
      SHA_256,
      `${label} candidate digest`,
    ),
    capabilityOrientation: true,
    channels: strings(receipt.channels, `${label} channels`),
    cleanOwnedPrefix: true,
    commands,
    completionZshValid: true,
    fleetCases: 7,
    noSourceCheckoutOnPath: true,
    readOnlyMutationExit: 4,
    requiredSkips: 0,
    runner: string(receipt.runner, `${label} runner`),
    sha: requireSha(receipt.sha, SHA_1, `${label} SHA`),
    tag: P17_TAG,
    upgradeUninstall: true,
    version: P17_VERSION,
    writesWithinRoots: true,
  };
}

export function validatePublicWorkflowReceipts(input: unknown): {
  receiptCount: 4;
  version: '1.0.0';
} {
  const value = record(input, 'public workflow receipts');
  if (!Array.isArray(value.receipts)) fail('public receipts must be an array');
  const receipts = value.receipts.map((receipt, index) =>
    publicReceipt(receipt, `public receipt ${index + 1}`),
  );
  requireExactSet(
    receipts.map((receipt) => receipt.runner),
    RELEASE_RUNNER_LABELS,
    'public runner receipts',
  );
  const reference = receipts[0];
  if (reference === undefined) fail('public receipt set is empty');
  for (const receipt of receipts) {
    if (
      receipt.candidateBundleSha256 !== reference.candidateBundleSha256 ||
      receipt.sha !== reference.sha ||
      receipt.tag !== reference.tag ||
      receipt.version !== reference.version
    ) {
      fail(`${receipt.runner} public receipt has identity drift`);
    }
    const macOS = receipt.runner.startsWith('macos-');
    requireExactSet(
      receipt.channels,
      macOS ? ['direct', 'npm', 'bun', 'homebrew'] : ['direct', 'npm', 'bun'],
      `${receipt.runner} public channels`,
    );
  }
  return { receiptCount: 4, version: P17_VERSION };
}
