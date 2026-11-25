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
});
