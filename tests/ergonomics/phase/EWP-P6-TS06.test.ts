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

type BoundaryStep = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
};
type BoundaryWorkflow = {
  on: Record<
    string,
    {
      branches?: string[];
      inputs?: Record<string, { type?: string; default?: boolean; required?: boolean }>;
    } | null
  >;
  permissions: Record<string, unknown>;
  jobs: Record<
    string,
    {
      permissions?: Record<string, string>;
      environment?: unknown;
      uses?: string;
      if?: string;
      steps?: BoundaryStep[];
      strategy?: { matrix?: { include?: { runner?: string }[] } };
    }
  >;
};

const ORDINARY_NPM_INSTALL = `npm_prefix="$RUNNER_TEMP/skillsmith-ordinary-npm-12.0.1"
npm install --global --prefix "$npm_prefix" --engine-strict --ignore-scripts --no-audit --no-fund npm@12.0.1
echo "$npm_prefix/bin" >> "$GITHUB_PATH"`;

function boundary(condition: unknown, diagnostic: string): asserts condition {
  if (!condition) throw new Error(diagnostic);
}

const assertAutomaticReleaseBoundary = (
  product: BoundaryWorkflow,
  qualification: BoundaryWorkflow,
): void => {
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  boundary(
    record(product) && record(product.on) && record(product.permissions) && record(product.jobs),
    'automatic workflow shape invalid',
  );
  boundary(
    Object.keys(product.on).toSorted().join(',') === 'pull_request,push' &&
      product.on.push?.branches?.join(',') === 'main',
    'automatic workflow triggers changed',
  );
  boundary(Object.keys(product.permissions).length === 0, 'automatic workflow authority changed');
  const productText = JSON.stringify(product);
  boundary(
    !/\$\{\{[^}]*\bsecrets(?:\.|\[)/u.test(productText),
    'automatic CI cannot access release secrets',
  );
  boundary(
    !productText.includes('P17_G6_01_HOMEBREW_RECEIPT'),
    'Homebrew qualification is not automatic',
  );
  const installers: { job: string; step: BoundaryStep }[] = [];
  for (const [name, job] of Object.entries(product.jobs)) {
    boundary(record(job), 'automatic job shape invalid');
    boundary(
      !job.uses?.includes('release-qualification'),
      'automatic CI cannot invoke release qualification',
    );
    boundary(
      record(job.permissions) && JSON.stringify(job.permissions) === '{"contents":"read"}',
      'automatic jobs must have contents:read only',
    );
    boundary(job.environment === undefined, 'automatic jobs cannot enter release environments');
    boundary(job.uses === undefined && Array.isArray(job.steps), 'automatic job shape invalid');
    for (const step of job.steps) {
      boundary(record(step), 'automatic step shape invalid');
      if (step.uses?.startsWith('goreleaser/goreleaser-action')) {
        installers.push({ job: name, step });
      }
      const command = step.run ?? '';
      boundary(
        !command.includes('release-qualification'),
        'automatic CI cannot invoke release qualification',
      );
      boundary(!/\bnpm\s+publish\b/u.test(command), 'automatic npm publication is forbidden');
      boundary(
        !/\bgoreleaser\s+(?:release|build)\b/u.test(command),
        'automatic GoReleaser execution is forbidden',
      );
      boundary(
        ![
          /\bgh\s+release\s+(?:create|upload|edit|delete)\b/u,
          /\bjust\s+release-check\b/u,
          /\b(?:bun|node)\s+(?:run\s+)?\S*(?:build-release|release-check)\.[jt]s\b/u,
          /\bbun\s+run\s+(?:build:release|release-check)\b/u,
        ].some((pattern) => pattern.test(command)),
        'automatic release execution is forbidden',
      );
    }
  }
  boundary(
    Object.keys(product.jobs).toSorted().join(',') ===
      'agent-environments,lint-pr-title,native-receipt,ordinary-check',
    'automatic job roster changed',
  );
  boundary(installers.length === 1, 'exactly one ordinary GoReleaser installer required');
  const installer = installers[0];
  boundary(
    installer.job === 'ordinary-check',
    'GoReleaser installer must belong to ordinary-check',
  );
  boundary(
    installer.step.uses === 'goreleaser/goreleaser-action@f06c13b6b1a9625abc9e6e439d9c05a8f2190e94',
    'ordinary GoReleaser action pin changed',
  );
  boundary(record(installer.step.with), 'ordinary GoReleaser inputs missing');
  boundary(
    installer.step.with['install-only'] === true,
    'ordinary GoReleaser install-only must be boolean true',
  );
  boundary(installer.step.with.version === 'v2.17.1', 'ordinary GoReleaser version changed');
  boundary(
    Object.keys(installer.step.with).toSorted().join(',') === 'install-only,version' &&
      installer.step.env === undefined,
    'ordinary GoReleaser has execution inputs',
  );
  const ordinary = product.jobs['ordinary-check'].steps ?? [];
  const node = ordinary.findIndex(
    (step) => step.name === 'Set up Node for pinned release-test npm',
  );
  const npm = ordinary.findIndex(
    (step) => step.name === 'Install pinned release-test npm in owned prefix',
  );
  const versions = ordinary.findIndex(
    (step) => step.name === 'Check exact release-test tool versions before canonical gate',
  );
  const canonical = ordinary.findIndex((step) => step.run === 'just check');
  boundary(
    node >= 0 &&
      ordinary[node].uses === 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020' &&
      ordinary[node].with?.['node-version'] === '24',
    'ordinary Node prerequisite changed',
  );
  boundary(
    npm >= 0 && ordinary[npm].run?.trim() === ORDINARY_NPM_INSTALL,
    'ordinary npm must use exact owned installer',
  );
  boundary(
    node < npm &&
      npm < versions &&
      ordinary.indexOf(installer.step) < versions &&
      versions < canonical &&
      versions >= 0 &&
      canonical >= 0,
    'ordinary prerequisites must precede canonical gate',
  );
  boundary(
    record(qualification) &&
      record(qualification.on) &&
      record(qualification.permissions) &&
      record(qualification.jobs),
    'qualification workflow shape invalid',
  );
  boundary(
    Object.keys(qualification.on).join(',') === 'workflow_dispatch',
    'qualification must require workflow_dispatch',
  );
  const resume = qualification.on.workflow_dispatch?.inputs?.resume_release_qualification;
  boundary(
    resume?.type === 'boolean' && resume.required === true,
    'qualification resume must require boolean input',
  );
  boundary(resume.default === false, 'qualification resume must default false');
  boundary(Object.keys(qualification.permissions).length === 0, 'qualification authority changed');
  boundary(
    Object.keys(qualification.jobs).join(',') === 'candidate-cask',
    'qualification job roster changed',
  );
  const candidate = qualification.jobs['candidate-cask'];
  boundary(
    candidate?.if ===
      "${{ github.event_name == 'workflow_dispatch' && inputs.resume_release_qualification }}",
    'qualification job requires explicit resume guard',
  );
  boundary(
    JSON.stringify(candidate.permissions) === '{"contents":"read"}',
    'qualification authority changed',
  );
  boundary(
    candidate.strategy?.matrix?.include
      ?.map((lane) => lane.runner)
      .toSorted()
      .join(',') === 'macos-15,macos-15-intel',
    'qualification native matrix changed',
  );
  boundary(
    candidate.steps?.some(
      (step) =>
        step.env?.P17_G6_01_HOMEBREW_RECEIPT === '1' &&
        step.run?.includes('EWP-P6-TS01.*Homebrew supported-platform'),
    ),
    'qualification Homebrew selector changed',
  );
  boundary(
    !/npm\s+publish|gh\s+release\s+upload|TAP_/u.test(JSON.stringify(qualification)),
    'qualification publication is forbidden',
  );
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

  test('family 1: automatic product CI keeps native smoke but release qualification is explicit opt-in', async () => {
    const ci = await source('.github/workflows/ci.yml');
    expect(ci).not.toContain('P17_G6_01_HOMEBREW_RECEIPT');
    expect(ci).toContain('run: just check');
    expect(ci).toContain('Host-native build and smoke');
    for (const runner of ['ubuntu-24.04-arm', 'macos-15', 'macos-15-intel']) {
      expect(ci).toContain(runner);
    }
    const qualificationSource = await source('.github/workflows/release-qualification.yml');
    const product = Bun.YAML.parse(ci) as BoundaryWorkflow;
    const qualification = Bun.YAML.parse(qualificationSource) as BoundaryWorkflow;
    expect(() => assertAutomaticReleaseBoundary(product, qualification)).not.toThrow();

    const steps = (workflow: BoundaryWorkflow): BoundaryStep[] =>
      workflow.jobs['ordinary-check'].steps ?? [];
    const installerIndex = steps(product).findIndex((step) => step.uses?.startsWith('goreleaser/'));
    const npmIndex = steps(product).findIndex(
      (step) => step.name === 'Install pinned release-test npm in owned prefix',
    );
    const installer = (workflow: BoundaryWorkflow): BoundaryStep => steps(workflow)[installerIndex];
    const resume = (workflow: BoundaryWorkflow) =>
      workflow.on.workflow_dispatch?.inputs?.resume_release_qualification ?? {};
    const controls: {
      name: string;
      mutate: (product: BoundaryWorkflow, qualification: BoundaryWorkflow) => void;
      diagnostic: string;
    }[] = [
      ...[undefined, false, 'true'].map((value) => ({
        name: `install-only ${String(value)}`,
        mutate: (workflow: BoundaryWorkflow) => {
          const inputs = installer(workflow).with ?? {};
          installer(workflow).with =
            value === undefined
              ? Object.fromEntries(Object.entries(inputs).filter(([key]) => key !== 'install-only'))
              : { ...inputs, 'install-only': value };
        },
        diagnostic: 'ordinary GoReleaser install-only must be boolean true',
      })),
      {
        name: 'wrong action pin',
        mutate: (p) => {
          installer(p).uses = `goreleaser/goreleaser-action@${SHA}`;
        },
        diagnostic: 'ordinary GoReleaser action pin changed',
      },
      {
        name: 'wrong version',
        mutate: (p) => {
          installer(p).with = { 'install-only': true, version: 'v0.0.0' };
        },
        diagnostic: 'ordinary GoReleaser version changed',
      },
      ...['args', 'token'].map((key) => ({
        name: `execution input ${key}`,
        mutate: (p: BoundaryWorkflow) => {
          installer(p).with = { ...installer(p).with, [key]: 'constructed-control' };
        },
        diagnostic: 'ordinary GoReleaser has execution inputs',
      })),
      {
        name: 'duplicate installer',
        mutate: (p) => {
          steps(p).push(structuredClone(installer(p)));
        },
        diagnostic: 'exactly one ordinary GoReleaser installer required',
      },
      {
        name: 'moved installer',
        mutate: (p) => {
          p.jobs['native-receipt'].steps?.push(steps(p).splice(installerIndex, 1)[0]);
        },
        diagnostic: 'GoReleaser installer must belong to ordinary-check',
      },
      {
        name: 'npm publication',
        mutate: (p) => {
          steps(p)[npmIndex].run = 'npm publish';
        },
        diagnostic: 'automatic npm publication is forbidden',
      },
      {
        name: 'GoReleaser execution',
        mutate: (p) => {
          steps(p).push({ run: 'goreleaser release' });
        },
        diagnostic: 'automatic GoReleaser execution is forbidden',
      },
      {
        name: 'qualification reusable job',
        mutate: (p) => {
          p.jobs['qualification-control'] = {
            permissions: { contents: 'read' },
            uses: './.github/workflows/release-qualification.yml',
          };
        },
        diagnostic: 'automatic CI cannot invoke release qualification',
      },
      {
        name: 'qualification dispatch',
        mutate: (p) => {
          steps(p).push({ run: 'gh workflow run release-qualification.yml' });
        },
        diagnostic: 'automatic CI cannot invoke release qualification',
      },
      {
        name: 'write authority',
        mutate: (p) => {
          p.jobs['ordinary-check'].permissions = { contents: 'write' };
        },
        diagnostic: 'automatic jobs must have contents:read only',
      },
      {
        name: 'privileged environment',
        mutate: (p) => {
          p.jobs['ordinary-check'].environment = 'release-candidate';
        },
        diagnostic: 'automatic jobs cannot enter release environments',
      },
      {
        name: 'release secret',
        mutate: (p) => {
          installer(p).env = { TOKEN: '${{ secrets.NPM_TOKEN }}' };
        },
        diagnostic: 'automatic CI cannot access release secrets',
      },
      {
        name: 'automatic Homebrew qualification',
        mutate: (p) => {
          installer(p).env = { P17_G6_01_HOMEBREW_RECEIPT: '1' };
        },
        diagnostic: 'Homebrew qualification is not automatic',
      },
      {
        name: 'automatic qualification trigger',
        mutate: (_p, q) => {
          q.on.push = { branches: ['main'] };
        },
        diagnostic: 'qualification must require workflow_dispatch',
      },
      {
        name: 'default-enabled qualification',
        mutate: (_p, q) => {
          resume(q).default = true;
        },
        diagnostic: 'qualification resume must default false',
      },
      {
        name: 'unguarded qualification',
        mutate: (_p, q) => {
          q.jobs['candidate-cask'] = Object.fromEntries(
            Object.entries(q.jobs['candidate-cask']).filter(([key]) => key !== 'if'),
          );
        },
        diagnostic: 'qualification job requires explicit resume guard',
      },
    ];
    for (const control of controls) {
      const mutatedProduct = structuredClone(product);
      const mutatedQualification = structuredClone(qualification);
      control.mutate(mutatedProduct, mutatedQualification);
      expect(
        () => assertAutomaticReleaseBoundary(mutatedProduct, mutatedQualification),
        control.name,
      ).toThrow(control.diagnostic);
    }
    for (const runner of ['macos-15', 'macos-15-intel'])
      expect(qualificationSource).toContain(runner);
    expect(qualificationSource).toContain("P17_G6_01_HOMEBREW_RECEIPT: '1'");
    expect(qualificationSource).toContain('EWP-P6-TS01.*Homebrew supported-platform');
    expect(qualificationSource).not.toMatch(/npm publish|gh release upload|contents: write|TAP_/u);
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

  test('family 8: post-uninstall assertion stops when the cask remains registered', async () => {
    const workflow = await source('.github/workflows/release.yml');
    const assertion = workflow.match(
      /test ! -e "\$brew_binary"\n([\s\S]*?)\n\s*channels='\["direct","npm","bun","homebrew"\]'/u,
    )?.[1];
    expect(assertion, 'exercise the actual workflow assertion, not a copied repair').toBeDefined();
    if (assertion === undefined) throw new Error('post-uninstall assertion is absent');

    for (const status of [0, 1]) {
      // A shell function intercepts the only command under test; no Homebrew is run.
      const child = Bun.spawnSync(
        [
          'bash',
          '--noprofile',
          '--norc',
          '-e',
          '-o',
          'pipefail',
          '-c',
          `brew() {
            if [[ "$#" != 3 || "$1" != list || "$2" != --cask || "$3" != skillsmith ]]; then
              exit 97
            fi
            return ${status}
          }
          ${assertion}
          echo assertion-completed`,
        ],
        { env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, timeout: 2_000 },
      );
      expect(child.exitCode, `brew list status ${status}`).toBe(status === 0 ? 1 : 0);
      expect(child.stdout.toString()).toBe(status === 0 ? '' : 'assertion-completed\n');
      expect(child.stderr.toString()).toBe(
        status === 0 ? 'skillsmith cask remains installed after uninstall\n' : '',
      );
    }
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
      source('.github/workflows/release-qualification.yml'),
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
