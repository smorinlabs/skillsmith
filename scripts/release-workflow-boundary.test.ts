import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Structural checks on the parsed release workflow. Substring checks alone would also pass for
// a disabled or rewired job, so every assertion here reads the parsed job graph, and each
// mutation control proves the assertion rejects the defect it names.

const ROOT = resolve(import.meta.dir, '..');
const source = (path: string): Promise<string> => readFile(resolve(ROOT, path), 'utf8');

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
};
type Job = {
  needs?: string | string[];
  if?: string;
  environment?: unknown;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps?: Step[];
};
type Workflow = { jobs: Record<string, Job> };

const parse = (text: string): Workflow => Bun.YAML.parse(text) as Workflow;
const clone = (workflow: Workflow): Workflow => structuredClone(workflow);

function boundary(condition: unknown, diagnostic: string): asserts condition {
  if (!condition) throw new Error(diagnostic);
}

const job = (workflow: Workflow, name: string): Job => {
  const found = workflow.jobs[name];
  boundary(found !== undefined, `${name} job is absent`);
  return found;
};
const needs = (value: Job): string[] =>
  value.needs === undefined ? [] : Array.isArray(value.needs) ? value.needs : [value.needs];
const commands = (value: Job): string =>
  (value.steps ?? []).map((step) => step.run ?? '').join('\n');
const permissions = (value: Job): string =>
  JSON.stringify(Object.fromEntries(Object.entries(value.permissions ?? {}).toSorted()));

// Commands that create, change, or delete GitHub state.
const MUTATING_GITHUB = [
  /\bgh\s+release\s+(?:upload|edit|delete|create)\b/u,
  /\bgh\s+api\b[^\n]*(?:\s-X\s*|\s--method\s+)(?!GET\b)/u,
  /\bgh\s+api\b[^\n]*\s(?:-f|-F|--field|--raw-field|--input)\s/u,
];

// The draft-release read needs contents:write, because GitHub lists draft releases only to
// tokens with push access. Jobs holding it may run no repository code and no mutation.
const DRAFT_READERS = ['release-lookup', 'github-preflight'] as const;

function assertDraftLookupBoundary(workflow: Workflow, text: string): void {
  boundary(!text.includes('releases/tags/'), 'releases/tags/ cannot read a draft release');
  const lookup = job(workflow, 'release-lookup');
  boundary(needs(lookup).includes('guard'), 'release-lookup must follow the source guard');
  boundary(permissions(lookup) === '{"contents":"write"}', 'release-lookup authority changed');
  boundary(lookup.environment === undefined, 'release-lookup cannot enter an environment');
  const lookupCommands = commands(lookup);
  boundary(
    /gh api --paginate "repos\/\$GITHUB_REPOSITORY\/releases\?per_page=100"/u.test(lookupCommands),
    'release-lookup must list releases',
  );
  boundary(/\bsleep\s+10\b/u.test(lookupCommands), 'release-lookup must wait between attempts');
  boundary(
    /-ge 6\b/u.test(lookupCommands),
    'release-lookup retries must be bounded at six attempts',
  );
  boundary(
    lookup.outputs?.['release-id'] !== undefined && lookup.outputs['candidate-mode'] !== undefined,
    'release-lookup must publish the release ID and candidate mode',
  );
  for (const name of DRAFT_READERS) {
    const reader = job(workflow, name);
    for (const step of reader.steps ?? []) {
      boundary(
        step.uses === undefined ||
          /^actions\/(?:download|upload)-artifact@[0-9a-f]{40}$/u.test(step.uses),
        `${name} cannot run repository or third-party actions`,
      );
      const command = step.run ?? '';
      boundary(
        !/\b(?:bun|just|node|npm|npx)\b/u.test(command),
        `${name} cannot run repository code`,
      );
      boundary(!/\.\/scripts\/|scripts\//u.test(command), `${name} cannot run repository scripts`);
      for (const pattern of MUTATING_GITHUB) {
        boundary(!pattern.test(command), `${name} cannot change GitHub state`);
      }
    }
    boundary(reader.permissions?.contents === 'write', `${name} needs the draft-read privilege`);
    boundary(reader.permissions?.attestations !== 'write', `${name} cannot write attestations`);
    boundary(reader.permissions?.['id-token'] === undefined, `${name} cannot mint OIDC tokens`);
  }
  const guard = job(workflow, 'guard');
  boundary(permissions(guard) === '{"contents":"read"}', 'guard authority changed');
  boundary(!/\bgh\s/u.test(commands(guard)), 'guard runs repository code and cannot call gh');
  for (const name of ['candidate', 'retained-candidate', 'candidate-source']) {
    const consumer = job(workflow, name);
    boundary(needs(consumer).includes('release-lookup'), `${name} must follow release-lookup`);
    boundary(
      !JSON.stringify(consumer).includes('needs.guard.outputs.candidate-mode'),
      `${name} must read the candidate mode from release-lookup`,
    );
  }
  for (const name of ['github-preflight', 'github-publish']) {
    const consumer = job(workflow, name);
    boundary(needs(consumer).includes('release-lookup'), `${name} must follow release-lookup`);
    boundary(
      commands(consumer).includes('releases/$RELEASE_ID'),
      `${name} must address the release by ID`,
    );
  }
}

function assertImmutableReleaseBoundary(workflow: Workflow, text: string): void {
  boundary(
    !text.includes('immutable-releases'),
    'the immutable-releases endpoint needs Administration read, which a workflow token lacks',
  );
  const publish = commands(job(workflow, 'github-publish'));
  const published = publish.indexOf('--draft=false');
  const asserted = publish.search(/--jq \.immutable\)" = 'true'/u);
  boundary(published >= 0, 'github-publish must publish the draft');
  boundary(asserted > published, 'github-publish must assert immutability after publication');
}

// Steps the CI test shards run before the canonical gate; the common release lane runs the
// same canonical gate at the tag, so it needs the same prerequisites.
const PARITY_STEPS = [
  { label: 'credential scanners', pattern: /\.\/scripts\/install-trufflehog\.sh/u },
  { label: 'actionlint', pattern: /\.\/scripts\/install-actionlint\.sh/u },
  { label: 'ordinary agent tools', pattern: /bun scripts\/install-ci-agent-tools\.ts --root /u },
  { label: 'agent bindings', pattern: /for name in claude codex kilo opencode muse agy; do/u },
  { label: 'release-test npm', pattern: /npm@12\.0\.1/u },
  { label: 'tool versions', pattern: /assertReleaseToolVersions\(versions\)/u },
  { label: 'capability pin', pattern: /envCapabilitiesPinned: true/u },
];

function assertCommonLaneParity(ci: Workflow, release: Workflow): void {
  const shard = job(ci, 'test-shard');
  const common = job(release, 'common');
  const goreleaser = (value: Job): unknown =>
    (value.steps ?? []).find((step) => step.uses?.startsWith('goreleaser/goreleaser-action@'))
      ?.with;
  for (const { label, pattern } of PARITY_STEPS) {
    boundary(pattern.test(commands(shard)), `ci test-shard lost its ${label} step`);
    boundary(pattern.test(commands(common)), `common release lane lacks the ${label} step`);
  }
  boundary(
    JSON.stringify(goreleaser(common)) === JSON.stringify(goreleaser(shard)),
    'common release lane must install the CI GoReleaser version (install-only)',
  );
  const ordinary = (value: Job): string | undefined =>
    commands(value).match(/echo "ORDINARY_AGENT_PREFIX=[^"]+"/u)?.[0];
  const requireGoreleaser = (value: Job): unknown =>
    (value.steps ?? []).find((step) =>
      /run-test-files-shard\.ts|just release-check common/u.test(step.run ?? ''),
    )?.env?.SKILLSMITH_REQUIRE_GORELEASER;
  boundary(
    requireGoreleaser(common) === '1' && requireGoreleaser(shard) === '1',
    'common release lane must require goreleaser like the CI test shards',
  );
  boundary(
    ordinary(common) !== undefined && ordinary(common) === ordinary(shard),
    'common release lane must export the same ORDINARY_AGENT_PREFIX',
  );
  const order = [
    'install-ci-agent-tools',
    'assertReleaseToolVersions',
    'just release-check common',
  ];
  const positions = order.map((needle) =>
    (common.steps ?? []).findIndex((step) => (step.run ?? '').includes(needle)),
  );
  boundary(
    positions.every(
      (position, index) => position >= 0 && (index === 0 || position > (positions[index - 1] ?? 0)),
    ),
    'common release lane must install and check tools before the canonical gate',
  );
}

// The GitHub-only v1.0.0 graph (P24). npm-preflight, homebrew-preflight, npm-publish and
// homebrew-publish were deleted, not disabled; ADR 0011 links their last form for restoration.
const GITHUB_ONLY_GRAPH: Record<
  string,
  { needs: string[]; permissions: string; environment?: string }
> = {
  guard: { needs: [], permissions: '{"contents":"read"}' },
  'release-lookup': { needs: ['guard'], permissions: '{"contents":"write"}' },
  candidate: {
    needs: ['guard', 'release-lookup'],
    permissions: '{"contents":"read"}',
    environment: 'release-candidate',
  },
  'retained-candidate': {
    needs: ['guard', 'release-lookup'],
    permissions: '{"actions":"read","contents":"read"}',
  },
  'candidate-source': {
    needs: ['guard', 'release-lookup', 'candidate', 'retained-candidate'],
    permissions: '{"actions":"read","contents":"read"}',
  },
  common: {
    needs: ['guard', 'candidate-source'],
    permissions: '{"actions":"read","contents":"read"}',
  },
  native: {
    needs: ['guard', 'candidate-source'],
    permissions: '{"actions":"read","contents":"read"}',
  },
  'validation-aggregate': {
    needs: ['guard', 'common', 'native'],
    permissions: '{"actions":"read","contents":"read"}',
  },
  'github-preflight': {
    needs: ['guard', 'release-lookup', 'candidate-source', 'validation-aggregate'],
    permissions: '{"actions":"read","attestations":"read","contents":"write"}',
    environment: 'github-release',
  },
  'publication-ready': {
    needs: ['guard', 'candidate-source', 'validation-aggregate', 'github-preflight'],
    permissions: '{"actions":"read","contents":"read"}',
  },
  'github-publish': {
    needs: ['guard', 'release-lookup', 'candidate-source', 'publication-ready'],
    permissions: '{"actions":"read","attestations":"write","contents":"write","id-token":"write"}',
    environment: 'github-release',
  },
  'public-validation': {
    needs: ['guard', 'candidate-source', 'github-publish'],
    permissions: '{"actions":"read","attestations":"read","contents":"read"}',
  },
  'public-aggregate': {
    needs: ['guard', 'public-validation'],
    permissions: '{"actions":"read","contents":"read"}',
  },
};
const ATTESTATION_VARS = [
  'BILLING_READY_SHA',
  'ENVIRONMENTS_READY_SHA',
  'PUBLIC_AUDIT_APPROVED_SHA',
  'PUBLIC_VISIBILITY_AUTHORIZED_SHA',
  'RUNNER_MATRIX_READY_SHA',
];

function assertGithubOnlyGraph(workflow: Workflow, text: string): void {
  const names = Object.keys(workflow.jobs).toSorted();
  boundary(
    names.join(',') === Object.keys(GITHUB_ONLY_GRAPH).toSorted().join(','),
    `release job roster changed: ${names.join(',')}`,
  );
  for (const [name, expected] of Object.entries(GITHUB_ONLY_GRAPH)) {
    const actual = job(workflow, name);
    boundary(
      needs(actual).toSorted().join(',') === expected.needs.toSorted().join(','),
      `${name} needs changed`,
    );
    boundary(permissions(actual) === expected.permissions, `${name} permissions changed`);
    boundary(actual.environment === expected.environment, `${name} environment changed`);
    const conditions = [
      actual.if,
      ...(actual.steps ?? []).map((step) => (step as { if?: unknown }).if),
    ];
    boundary(
      !conditions.some(
        (condition) =>
          condition === false || /^\s*(?:\$\{\{\s*)?false\b/u.test(String(condition ?? '')),
      ),
      `${name} is disabled instead of deleted`,
    );
  }
  boundary(!/\$\{\{[^}]*\bsecrets(?:\.|\[)/u.test(text), 'the GitHub-only release uses no secrets');
  const vars = [...new Set([...text.matchAll(/\bvars\.([A-Z0-9_]+)/gu)].map((match) => match[1]))];
  boundary(
    vars.toSorted().join(',') === ATTESTATION_VARS.join(','),
    `attestation variables changed: ${vars.join(',')}`,
  );
  boundary(!/\bnpm\s+publish\b/u.test(text), 'npm publication is deferred');
  boundary(!/\bbrew\s+(?:install|upgrade|uninstall)\b/u.test(text), 'Homebrew is deferred');
  boundary(
    !/environment:\s*(?:npm|homebrew)\b/u.test(text),
    'npm and Homebrew environments are deferred',
  );
}

// The guard regenerates the command reference, which imports workspace packages. Bun resolves
// them only after an install, so the locked install must precede that check.
function assertGuardInstallsWorkspace(workflow: Workflow): void {
  const steps = job(workflow, 'guard').steps ?? [];
  const install = steps.findIndex((step) =>
    /^\s*bun install --frozen-lockfile --ignore-scripts\s*$/mu.test(step.run ?? ''),
  );
  const reference = steps.findIndex((step) =>
    (step.run ?? '').includes('scripts/generate-command-reference.ts --check'),
  );
  boundary(reference >= 0, 'guard must check the generated command reference');
  boundary(
    install >= 0 && install < reference,
    'guard must install the locked workspace before checking the command reference',
  );
}

// Exactly one of the candidate jobs runs, so the other is always skipped. GitHub's implicit
// success() skips a job when any ancestor was skipped, even through an always() job, so every
// downstream job needs an explicit condition on its own direct needs.
const EXCLUSIVE_CANDIDATES = ['candidate', 'retained-candidate'] as const;

function assertSkippedCandidateDoesNotPropagate(workflow: Workflow): void {
  const ancestors = (name: string, seen = new Set<string>()): Set<string> => {
    for (const parent of needs(job(workflow, name))) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      ancestors(parent, seen);
    }
    return seen;
  };
  for (const [name, value] of Object.entries(workflow.jobs)) {
    const upstream = ancestors(name);
    if (!EXCLUSIVE_CANDIDATES.some((candidate) => upstream.has(candidate))) continue;
    const condition = String(value.if ?? '');
    if (/\balways\(\)/u.test(condition)) continue;
    boundary(
      condition.includes('!cancelled()'),
      `${name} must not rely on implicit success() below a skipped candidate job`,
    );
    for (const parent of needs(value))
      boundary(
        condition.includes(`needs.${parent}.result == 'success'`),
        `${name} must require ${parent} to succeed`,
      );
  }
}

// Release jobs check out no repository before publishing, so gh cannot infer the target
// repository; every gh release command names it explicitly.
function assertGhReleaseNamesRepository(workflow: Workflow): void {
  for (const [name, value] of Object.entries(workflow.jobs))
    for (const line of commands(value).split('\n'))
      if (/\bgh\s+release\s+\w+/u.test(line))
        boundary(
          line.includes('--repo "$GITHUB_REPOSITORY"'),
          `${name} runs gh release without --repo: ${line.trim()}`,
        );
}

// Public validation runs the released binary on clean hosted runners. The Ubuntu images do not
// ship zsh; the JSON agents report lists every supported tool, so only tools with installations
// count as detected; and doctor needs git, which a stub-only PATH would otherwise hide.
function assertPublicValidationRunnerAssumptions(workflow: Workflow): void {
  const publicJob = job(workflow, 'public-validation');
  const steps = publicJob.steps ?? [];
  const zshCheck = steps.findIndex((step) => /\bzsh -n\b/u.test(step.run ?? ''));
  boundary(zshCheck >= 0, 'public-validation must syntax-check the zsh completion');
  const zshInstall = steps.findIndex(
    (step) =>
      /apt-get install\b[^\n]*\bzsh\b/u.test(step.run ?? '') &&
      String(step.if ?? '').includes("runner.os == 'Linux'"),
  );
  boundary(
    zshInstall >= 0 && zshInstall < zshCheck,
    'public-validation must install zsh on Linux runners before the completion check',
  );
  const script = commands(publicJob);
  boundary(
    !/\.detections \| length/u.test(script),
    'public-validation must count only detected tools, not every listed tool',
  );
  boundary(
    script.includes('select(.installations | length > 0)'),
    'public-validation must count tools that have installations',
  );
  boundary(
    script.includes('ln -s "$(command -v git)" "$root/fleet/git"'),
    'public-validation fleet PATH must provide git',
  );
}

describe('release workflow boundary', () => {
  test('the draft release is resolved once by ID, by a job that cannot run code or mutate', async () => {
    const text = await source('.github/workflows/release.yml');
    const workflow = parse(text);
    expect(() => assertDraftLookupBoundary(workflow, text)).not.toThrow();

    const mutations: [string, (copy: Workflow) => string | undefined][] = [
      ['releases/tags/', () => `${text}\n# releases/tags/v1.0.0`],
      [
        'release-lookup authority changed',
        (copy) => {
          job(copy, 'release-lookup').permissions = { contents: 'write', actions: 'write' };
          return undefined;
        },
      ],
      [
        'github-preflight cannot change GitHub state',
        (copy) => {
          job(copy, 'github-preflight').steps?.push({ run: 'gh release upload "$RELEASE_TAG" x' });
          return undefined;
        },
      ],
      [
        'release-lookup cannot change GitHub state',
        (copy) => {
          job(copy, 'release-lookup').steps?.push({
            run: 'gh api -X PATCH "repos/$GITHUB_REPOSITORY/releases/$id" -F draft=false',
          });
          return undefined;
        },
      ],
      [
        'github-preflight cannot run repository code',
        (copy) => {
          job(copy, 'github-preflight').steps?.push({ run: 'bun scripts/release-gates.ts' });
          return undefined;
        },
      ],
      [
        'release-lookup cannot run repository or third-party actions',
        (copy) => {
          job(copy, 'release-lookup').steps?.unshift({ uses: 'actions/checkout@v7' });
          return undefined;
        },
      ],
      [
        'github-preflight cannot write attestations',
        (copy) => {
          const preflight = job(copy, 'github-preflight');
          preflight.permissions = { ...preflight.permissions, attestations: 'write' };
          return undefined;
        },
      ],
      [
        'guard authority changed',
        (copy) => {
          job(copy, 'guard').permissions = { contents: 'write' };
          return undefined;
        },
      ],
      [
        'release-lookup must wait between attempts',
        (copy) => {
          for (const step of job(copy, 'release-lookup').steps ?? [])
            step.run = step.run?.replace(/sleep 10/gu, 'true');
          return undefined;
        },
      ],
      [
        'candidate must read the candidate mode from release-lookup',
        (copy) => {
          job(copy, 'candidate').if = "needs.guard.outputs.candidate-mode == 'build'";
          return undefined;
        },
      ],
    ];
    for (const [diagnostic, mutate] of mutations) {
      const copy = clone(workflow);
      const mutatedText = mutate(copy) ?? text;
      expect(() => assertDraftLookupBoundary(copy, mutatedText), diagnostic).toThrow(diagnostic);
    }
  });

  test('immutability is asserted on the release after publication, not probed with an admin API', async () => {
    const text = await source('.github/workflows/release.yml');
    const workflow = parse(text);
    expect(() => assertImmutableReleaseBoundary(workflow, text)).not.toThrow();
    expect(() =>
      assertImmutableReleaseBoundary(workflow, `${text}\n# repos/x/immutable-releases`),
    ).toThrow('immutable-releases');
    const copy = clone(workflow);
    for (const step of job(copy, 'github-publish').steps ?? [])
      step.run = step.run?.replace(/--jq \.immutable\)" = 'true'/gu, "--jq .draft)\" = 'false'");
    expect(() => assertImmutableReleaseBoundary(copy, text)).toThrow('assert immutability');
  });

  test('the common release lane installs the CI test-shard prerequisites before the gate', async () => {
    const [ciText, releaseText] = await Promise.all([
      source('.github/workflows/ci.yml'),
      source('.github/workflows/release.yml'),
    ]);
    const ci = parse(ciText);
    const release = parse(releaseText);
    expect(() => assertCommonLaneParity(ci, release)).not.toThrow();
    const withoutTools = clone(release);
    const common = job(withoutTools, 'common');
    common.steps = common.steps?.filter(
      (step) => !(step.run ?? '').includes('install-ci-agent-tools'),
    );
    expect(() => assertCommonLaneParity(ci, withoutTools)).toThrow('ordinary agent tools');
    const oldGoreleaser = clone(release);
    for (const step of job(oldGoreleaser, 'common').steps ?? [])
      if (step.uses?.startsWith('goreleaser/goreleaser-action@'))
        step.with = { ...step.with, version: 'v2.17.1' };
    expect(() => assertCommonLaneParity(ci, oldGoreleaser)).toThrow('GoReleaser');
    const noPin = clone(release);
    const pinned = job(noPin, 'common');
    pinned.steps = pinned.steps?.filter(
      (step) => !(step.run ?? '').includes('envCapabilitiesPinned'),
    );
    expect(() => assertCommonLaneParity(ci, noPin)).toThrow('capability pin');
    const optional = clone(release);
    for (const step of job(optional, 'common').steps ?? [])
      if (step.env?.SKILLSMITH_REQUIRE_GORELEASER)
        step.env.SKILLSMITH_REQUIRE_GORELEASER = undefined;
    expect(() => assertCommonLaneParity(ci, optional)).toThrow('require goreleaser');
  });

  test('the guard installs the locked workspace before checking the command reference', async () => {
    const workflow = parse(await source('.github/workflows/release.yml'));
    expect(() => assertGuardInstallsWorkspace(workflow)).not.toThrow();
    const missing = clone(workflow);
    const guard = job(missing, 'guard');
    guard.steps = guard.steps?.filter((step) => !(step.run ?? '').includes('bun install'));
    expect(() => assertGuardInstallsWorkspace(missing)).toThrow('install the locked workspace');
  });

  test('a skipped candidate job does not skip the jobs after candidate-source', async () => {
    const workflow = parse(await source('.github/workflows/release.yml'));
    expect(() => assertSkippedCandidateDoesNotPropagate(workflow)).not.toThrow();
    for (const name of [
      'common',
      'native',
      'github-preflight',
      'github-publish',
      'public-validation',
    ]) {
      const implicit = clone(workflow);
      job(implicit, name).if = undefined;
      expect(() => assertSkippedCandidateDoesNotPropagate(implicit)).toThrow(
        `${name} must not rely on implicit success()`,
      );
    }
    const partial = clone(workflow);
    job(partial, 'common').if = "${{ !cancelled() && needs.guard.result == 'success' }}";
    expect(() => assertSkippedCandidateDoesNotPropagate(partial)).toThrow(
      'common must require candidate-source to succeed',
    );
  });

  test('every gh release command names the repository', async () => {
    const workflow = parse(await source('.github/workflows/release.yml'));
    expect(() => assertGhReleaseNamesRepository(workflow)).not.toThrow();
    const unnamed = clone(workflow);
    for (const step of job(unnamed, 'github-publish').steps ?? [])
      step.run = step.run?.replace(' --repo "$GITHUB_REPOSITORY" --draft=false', ' --draft=false');
    expect(() => assertGhReleaseNamesRepository(unnamed)).toThrow('github-publish runs gh release');
  });

  test('public validation matches what the hosted runners and the binary provide', async () => {
    const workflow = parse(await source('.github/workflows/release.yml'));
    expect(() => assertPublicValidationRunnerAssumptions(workflow)).not.toThrow();
    const noZsh = clone(workflow);
    const publicJob = job(noZsh, 'public-validation');
    publicJob.steps = publicJob.steps?.filter((step) => !/apt-get/u.test(step.run ?? ''));
    expect(() => assertPublicValidationRunnerAssumptions(noZsh)).toThrow('install zsh');
    const listed = clone(workflow);
    for (const step of job(listed, 'public-validation').steps ?? [])
      step.run = step.run?.replaceAll(
        '[.detections[] | select(.installations | length > 0)] | length',
        '.detections | length',
      );
    expect(() => assertPublicValidationRunnerAssumptions(listed)).toThrow('count only detected');
    const noGit = clone(workflow);
    for (const step of job(noGit, 'public-validation').steps ?? [])
      step.run = step.run?.replace('ln -s "$(command -v git)" "$root/fleet/git"', ':');
    expect(() => assertPublicValidationRunnerAssumptions(noGit)).toThrow('provide git');
  });

  test('the job graph is exactly the GitHub-only release, with deferred jobs deleted', async () => {
    const text = await source('.github/workflows/release.yml');
    const workflow = parse(text);
    expect(() => assertGithubOnlyGraph(workflow, text)).not.toThrow();
    const mutations: [string, (copy: Workflow) => string | undefined][] = [
      [
        'release job roster changed',
        (copy) => {
          copy.jobs['npm-publish'] = { needs: ['github-publish'], steps: [{ run: 'true' }] };
          return undefined;
        },
      ],
      [
        'public-validation needs changed',
        (copy) => {
          job(copy, 'public-validation').needs = ['guard', 'candidate-source'];
          return undefined;
        },
      ],
      [
        'github-preflight is disabled instead of deleted',
        (copy) => {
          job(copy, 'github-preflight').if = 'false';
          return undefined;
        },
      ],
      [
        'the GitHub-only release uses no secrets',
        () => `${text}\n# \${{ secrets.MACOS_SIGN_P12 }}`,
      ],
      ['attestation variables changed', () => `${text}\n# \${{ vars.TAP_CASK_CI_READY_SHA }}`],
      ['npm publication is deferred', () => `${text}\n# npm publish --access public`],
      ['npm and Homebrew environments are deferred', () => `${text}\n# environment: npm`],
      [
        'github-publish permissions changed',
        (copy) => {
          job(copy, 'github-publish').permissions = { contents: 'write' };
          return undefined;
        },
      ],
    ];
    for (const [diagnostic, mutate] of mutations) {
      const copy = clone(workflow);
      const mutatedText = mutate(copy) ?? text;
      expect(() => assertGithubOnlyGraph(copy, mutatedText), diagnostic).toThrow(diagnostic);
    }
  });
});
