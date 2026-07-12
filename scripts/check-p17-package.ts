#!/usr/bin/env bun

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const repository = 'smorinlabs/skillsmith';
const bootstrap =
  '/goal Execute P17 completely by reading and following projects/P17-GOAL.md as the canonical objective and completion contract, applying the recorded standing human approval without additional review pauses and marking complete only after all referenced gates and final sign-off pass.';
const preparationBranch = 'agent/p17-execution-package';
const linkFiles = [
  'projects/P17-skillsmith-ergonomics-and-declarative-workflow.md',
  'projects/P17-GOAL.md',
  'projects/p17/PREP.md',
  'projects/p17/EXECUTION.md',
  'projects/p17/CHECKLIST.md',
  'projects/p17/evidence/README.md',
  'projects/p17/evidence/preparation-review.md',
  'research/topics/codex-persistent-goal/DECISION.md',
  'research/topics/codex-persistent-goal/00-landscape.md',
  'research/topics/codex-persistent-goal/prompts/00-landscape.prompt.md',
  'research/topics/codex-persistent-goal/prompts/00-landscape.framing.md',
  'research/reference/codex-persistent-goal-2026-07-11.md',
];
const canonicalFiles = [
  '.project-harness/project-harness.config.json',
  'AGENTS.md',
  'CLAUDE.md',
  'PROJECTS.md',
  'docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md',
  'justfile',
  'package.json',
  'projects/p17/catalog.json',
  'research/CLAUDE.md',
  'scripts/check-p17-package.ts',
  'scripts/p17-catalog.test.ts',
  'scripts/p17-catalog.ts',
  ...linkFiles,
];

function fail(message: string): never {
  throw new Error(message);
}

function text(path: string): string {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) fail(`missing required P17 artifact: ${path}`);
  return readFileSync(absolute, 'utf8');
}

function run(command: string[]): string {
  const result = Bun.spawnSync(command, { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0) fail(`${command.join(' ')} failed\n${stdout}${stderr}`);
  return stdout.trim();
}

function json<T>(command: string[]): T {
  const output = run(command);
  try {
    return JSON.parse(output) as T;
  } catch {
    return fail(`${command.join(' ')} returned invalid JSON`);
  }
}

function jsonItems<T>(endpoint: string): T[] {
  const command = ['gh', 'api', '--paginate', endpoint, '--jq', '.[]'];
  const output = run(command);
  if (!output) return [];
  return output.split(/\r?\n/).map((line, index) => {
    try {
      return JSON.parse(line) as T;
    } catch {
      return fail(`${command.join(' ')} returned invalid JSON on item ${index + 1}`);
    }
  });
}

function checkLinks(path: string): number {
  const body = text(path);
  let checked = 0;
  for (const match of body.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const link = match[1];
    if (!link) fail(`${path} contains a malformed Markdown link`);
    const raw = link.trim().replace(/^<|>$/g, '');
    if (/^(?:https?:|mailto:)/.test(raw) || raw.startsWith('#')) continue;
    const withoutAnchor = raw.split('#', 1).at(0)?.split('?', 1).at(0) ?? '';
    if (!withoutAnchor) continue;
    if (!existsSync(resolve(dirname(resolve(root, path)), withoutAnchor))) {
      fail(`${path} has unresolved link ${raw}`);
    }
    checked += 1;
  }
  return checked;
}

function requireCanonicalGitState(): void {
  const files = [...new Set(canonicalFiles)];
  run(['git', 'ls-files', '--error-unmatch', '--', ...files]);
  run(['git', 'diff', '--exit-code', '--', ...files]);
  run(['git', 'diff', '--cached', '--exit-code', '--', ...files]);
}

type Gate = { status?: string; evidence?: string[] };
type Catalog = {
  counts?: { total?: number };
  groups?: Array<{
    phase?: string;
    status?: string;
    gates?: Record<string, Gate>;
    implementers?: string[];
    reviewer?: string | null;
  }>;
  phases?: Array<{
    id?: string;
    status?: string;
    entry?: Gate;
    review?: Gate & { reviewer?: string | null };
    approval?: Gate & { approvedBy?: string | null };
    exit?: Gate;
  }>;
  entities?: Array<{ status?: string; tier?: string }>;
  finalReview?: Gate & { reviewer?: string | null };
  finalApproval?: Gate & { approvedBy?: string | null };
  finalSignoff?: Gate;
};

function terminalP17(catalog: Catalog): boolean {
  const entities = catalog.entities ?? [];
  const groups = catalog.groups ?? [];
  const phases = catalog.phases ?? [];
  const requiredEntities = entities.every(
    (entity) => entity.tier === 'deferred' || entity.status === 'signed-off',
  );
  const requiredGroups = groups.every((group) => {
    if (group.phase === '7') return group.status === 'deferred';
    return (
      group.status === 'signed-off' &&
      Object.values(group.gates ?? {}).every(
        (gate) => gate.status === 'passed' && (gate.evidence?.length ?? 0) > 0,
      ) &&
      Boolean(group.reviewer) &&
      !(group.implementers ?? []).includes(group.reviewer ?? '')
    );
  });
  const requiredPhases = Array.from({ length: 7 }, (_, index) => String(index)).every((id) => {
    const phase = phases.find((item) => item.id === id);
    return (
      phase?.status === 'approved' &&
      phase.entry?.status === 'passed' &&
      phase.review?.status === 'passed' &&
      Boolean(phase.review.reviewer) &&
      phase.approval?.status === 'passed' &&
      phase.approval.approvedBy === 'user' &&
      phase.exit?.status === 'passed'
    );
  });
  const phase7 = phases.find((phase) => phase.id === '7')?.status === 'deferred';
  const final =
    catalog.finalReview?.status === 'passed' &&
    Boolean(catalog.finalReview.reviewer) &&
    catalog.finalApproval?.status === 'passed' &&
    catalog.finalApproval.approvedBy === 'user' &&
    catalog.finalSignoff?.status === 'passed' &&
    (catalog.finalSignoff.evidence ?? []).some((value) =>
      /^projects\/p17\/evidence\/.*p14-handoff.*\.md(?:#.*)?$/i.test(value),
    );
  return requiredEntities && requiredGroups && requiredPhases && phase7 && final;
}

const mode = Bun.argv[2] ?? '--check';
if (!['--check', '--pr-openable', '--merge-ready', '--final'].includes(mode)) {
  fail(`unknown mode ${mode}; use --check, --pr-openable, --merge-ready, or --final`);
}

const project = text(
  process.env.P17_PROJECT_PATH ?? 'projects/P17-skillsmith-ergonomics-and-declarative-workflow.md',
);
const projectLines = project.split('\n');
if (projectLines[2] !== '**References**')
  fail('P17 References block is not the first body section');
const labels = [...project.matchAll(/^- \*\*([^:]+):\*\* /gm)].map((match) => match[1]);
const expectedLabels = [
  'Trunk',
  'Design',
  'Plan',
  'Goal',
  'Execution',
  'Preparation',
  'Catalog',
  'Checklist',
  'Evidence',
];
if (JSON.stringify(labels) !== JSON.stringify(expectedLabels)) {
  fail(`P17 References labels/order mismatch: ${labels.join(', ')}`);
}

const config = JSON.parse(text('.project-harness/project-harness.config.json')) as Record<
  string,
  unknown
>;
if (
  config.init_done !== true ||
  config.projects_md_done !== true ||
  config.agents_md_done !== true ||
  config.claude_md_done !== true ||
  config.planning_system !== 'superpowers' ||
  config.references_block_nudged !== true
) {
  fail('project-harness bootstrap is incomplete');
}
const planningPaths = config.planning_paths as { plans?: string[]; specs?: string[] } | undefined;
if (
  JSON.stringify(planningPaths?.plans) !==
    JSON.stringify(['~/.claude/plans/', 'docs/superpowers/plans/']) ||
  JSON.stringify(planningPaths?.specs) !== JSON.stringify(['docs/superpowers/specs/'])
) {
  fail('project-harness Superpowers planning paths drifted');
}

const plan = text('docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md');
const phaseCatalog = JSON.parse(text('projects/p17/catalog.json')) as {
  groups: Array<{ id: string; status: string }>;
  phases: Array<{
    id: string;
    requiredGroups: string[];
    review: { status: string };
    approval: { status: string };
    exit: { status: string };
  }>;
};
const phase0 = phaseCatalog.phases.find((phase) => phase.id === '0');
if (!phase0) fail('catalog has no Phase 0 record');
const phase0GroupsSigned = phase0.requiredGroups.every(
  (id) => phaseCatalog.groups.find((group) => group.id === id)?.status === 'signed-off',
);
const phase0Marker =
  `**Phase 0 execution:** groups=${phase0GroupsSigned ? 'signed-off' : 'incomplete'}; ` +
  `review=${phase0.review.status}; approval=${phase0.approval.status}; exit=${phase0.exit.status}.`;
const phase0Markers = [...plan.matchAll(/^> (\*\*Phase 0 execution:\*\* .+)$/gm)].map(
  (match) => match[1],
);
if (phase0Markers.length !== 1 || phase0Markers[0] !== phase0Marker) {
  fail('plan must contain exactly one Phase 0 execution marker matching catalog');
}
if (plan.includes('no planning gate remains open'))
  fail('plan retains stale all-gates-closed language');
for (const stage of [
  'Cross-command consistency.',
  'Artifact consistency.',
  'Command-surface complexity.',
  'Overall architecture and quality.',
  'Documentation-drift closure.',
  'Final executable structural check, adversarial review, and approval.',
]) {
  if (!plan.includes(stage)) fail(`plan is missing required closure stage: ${stage}`);
}

for (const path of [
  'projects/P17-GOAL.md',
  'research/topics/codex-persistent-goal/00-landscape.md',
  'research/topics/codex-persistent-goal/DECISION.md',
  'research/reference/codex-persistent-goal-2026-07-11.md',
]) {
  const lines = text(path)
    .split('\n')
    .filter((line) => line.startsWith('/goal '));
  if (lines.length !== 1 || lines[0] !== bootstrap) {
    fail(`${path} must contain exactly the canonical one-sentence goal bootstrap`);
  }
}
if (
  !text('projects/P17-GOAL.md').includes(
    'Do not add a token\nbudget unless the user explicitly requests one.',
  )
) {
  fail('goal does not preserve explicit-only token budget policy');
}

const prep = text(process.env.P17_PREP_PATH ?? 'projects/p17/PREP.md');
const expectedPrepCounts: Record<string, number> = {
  A: 8,
  B: 8,
  C: 8,
  D: 14,
  E: 10,
  F: 10,
  G: 9,
  H: 9,
  I: 10,
};
const prepDefinitions = [...prep.matchAll(/^- \[([ x])\] \*\*(P17-PREP-([A-I])(\d{2})):\*\*/gm)];
const prepById = new Map<string, { checked: boolean; section: string }>();
for (const definition of prepDefinitions) {
  const id = definition[2];
  const section = definition[3];
  if (!id || !section) fail(`malformed preparation checklist definition: ${definition[0]}`);
  if (prepById.has(id)) fail(`duplicate preparation checklist definition ${id}`);
  prepById.set(id, { checked: definition[1] === 'x', section });
}
for (const line of prep.split('\n')) {
  if (
    line.includes('P17-PREP-') &&
    line.trimStart().startsWith('- [') &&
    !/^- \[([ x])\] \*\*P17-PREP-[A-I]\d{2}:\*\*/.test(line)
  ) {
    fail(`malformed preparation checklist line: ${line}`);
  }
}
const expectedPrepTotal = Object.values(expectedPrepCounts).reduce((sum, value) => sum + value, 0);
if (prepById.size !== expectedPrepTotal) {
  fail(`expected ${expectedPrepTotal} canonical prep definitions, found ${prepById.size}`);
}
for (const [section, count] of Object.entries(expectedPrepCounts)) {
  for (let index = 1; index <= count; index += 1) {
    const id = `P17-PREP-${section}${String(index).padStart(2, '0')}`;
    if (!prepById.has(id)) fail(`missing preparation ID ${id}`);
  }
}

const prepStatus = prep.match(/^\*\*Status:\*\* (.+)$/m)?.[1] ?? '';
const preparationPr = prep.match(/^\*\*Preparation PR:\*\* (.+)$/m)?.[1] ?? '';
const requiredPrepChecked = [...prepById].every(([id, item]) => {
  const required = item.section !== 'I' || Number(id.slice(-2)) <= 3;
  return !required || item.checked;
});
const reviewBody = text(
  process.env.P17_REVIEW_PATH ?? 'projects/p17/evidence/preparation-review.md',
);
const reviewIds = [...reviewBody.matchAll(/^### (P17-(?:PREP-RV|AR|QR|BR)-F\d+) /gm)].map(
  (match) => match[1] ?? '',
);
const expectedReviewIds = [
  ...Array.from({ length: 11 }, (_, index) => `P17-PREP-RV-F${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 6 }, (_, index) => `P17-AR-F${index + 12}`),
  'P17-QR-F18',
  'P17-QR-F19',
  'P17-BR-F20',
];
const stableReviewSet =
  new Set(reviewIds).size === reviewIds.length &&
  JSON.stringify(reviewIds) === JSON.stringify(expectedReviewIds) &&
  expectedReviewIds.every((id, index) => {
    const start = reviewBody.indexOf(`### ${id} `);
    const nextId = expectedReviewIds[index + 1];
    const end = nextId ? reviewBody.indexOf(`### ${nextId} `, start + 1) : reviewBody.length;
    const section = reviewBody.slice(start, end < 0 ? undefined : end);
    const dispositions = [...section.matchAll(/^- \*\*Disposition:\*\* (.+)$/gm)].map(
      (match) => match[1] ?? '',
    );
    return (
      dispositions.length === 1 &&
      /(?:corrected|verified|non-blocking)/i.test(dispositions[0] ?? '')
    );
  });
const reviewClosed =
  /^\*\*Status:\*\* closed$/m.test(reviewBody) &&
  /^\*\*Re-review result:\*\* passed$/m.test(reviewBody) &&
  !/\b(?:pending|awaiting|unresolved|corrections in progress)\b/i.test(reviewBody) &&
  stableReviewSet;
const summaryRows = [...prep.matchAll(/^\| (?!Area |---)([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)];
const summaryAreas = [
  'Goal research',
  'Project mechanics',
  'Consolidated plan',
  'Execution decomposition',
  'Catalog/checklist',
  'Group protocol',
  'Goal prompt',
  'Adversarial review',
  'PR/merge',
  'Handoff',
] as const;
const summary = new Map(summaryRows.map((row) => [row[1]?.trim() ?? '', row[3]?.trim() ?? '']));
const evidenceReferenceResolves = (reference: string): boolean => {
  if (reference.startsWith('https://')) {
    try {
      new URL(reference);
      return true;
    } catch {
      return false;
    }
  }
  const [path, anchor] = reference.split('#', 2);
  if (!path || !existsSync(resolve(root, path))) return false;
  if (!anchor) return true;
  const body = readFileSync(resolve(root, path), 'utf8');
  const slug = (heading: string): string =>
    heading
      .trim()
      .toLowerCase()
      .replace(/[`*_~]/g, '')
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');
  return [...body.matchAll(/^#{1,6}\s+(.+)$/gm)].some(
    (match) => slug(match[1] ?? '') === anchor.toLowerCase(),
  );
};
const summaryComplete =
  summary.size === summaryAreas.length &&
  summaryAreas.every((area) => {
    const evidenceCell = summary.get(area);
    if (!evidenceCell || /\bpending\b/i.test(evidenceCell)) return false;
    const parts = evidenceCell.split(';').map((part) => part.trim());
    const references = parts.filter(
      (part) => part.startsWith('https://') || /^[.\w-]+\//.test(part),
    );
    if (references.length === 0 || !references.every(evidenceReferenceResolves)) return false;
    if (area === 'PR/merge') return parts.includes('live gate: --merge-ready then --final');
    if (area === 'Handoff') {
      return parts.includes('manual next step: deliver bootstrap after --final');
    }
    return true;
  });
const prepOpenable =
  prepStatus === 'pr-openable' && requiredPrepChecked && reviewClosed && summaryComplete;

const catalog = JSON.parse(text('projects/p17/catalog.json')) as Catalog;
if (catalog.counts?.total !== 425) fail(`catalog total is ${catalog.counts?.total}, expected 425`);
if (catalog.groups?.length !== 45) {
  fail(`catalog group count is ${catalog.groups?.length}, expected 45`);
}
if (catalog.phases?.length !== 8) fail('catalog phase count is not 8');

const projectTaskDefinitions = [
  ...project.matchAll(/^- \[([ x])\] \[(P17-(?:T0[1-7]|TS0[1-2]))\] /gm),
];
const expectedProjectTasks = [
  'P17-TS01',
  ...Array.from({ length: 7 }, (_, index) => `P17-T0${index + 1}`),
  'P17-TS02',
];
if (projectTaskDefinitions.length !== expectedProjectTasks.length) {
  fail('P17 executive task set is incomplete');
}
const taskState = new Map(projectTaskDefinitions.map((item) => [item[2], item[1] === 'x']));
for (const id of expectedProjectTasks) if (!taskState.has(id)) fail(`missing executive task ${id}`);
const taskValues = [...taskState.values()];
const expectedTrunkGlyph = taskValues.every(Boolean) ? 'x' : taskValues.some(Boolean) ? '~' : ' ';
const trunkGlyph = text(process.env.P17_TRUNK_PATH ?? 'PROJECTS.md').match(
  /^- \[([ x~?-])\] \*\*P17\*\* — /m,
)?.[1];
if (trunkGlyph !== expectedTrunkGlyph) {
  fail(`P17 trunk glyph ${trunkGlyph ?? 'missing'} disagrees with executive task progress`);
}
for (let phase = 0; phase <= 6; phase += 1) {
  const approved = catalog.phases?.find((item) => item.id === String(phase))?.status === 'approved';
  if ((taskState.get(`P17-T0${phase + 1}`) ?? false) !== approved) {
    fail(`P17 executive phase ${phase} checkbox disagrees with catalog approval`);
  }
}
if ((taskState.get('P17-TS01') ?? false) !== prepOpenable) {
  fail('P17-TS01 must be checked if and only if the preparation package is PR-openable');
}
if ((taskState.get('P17-TS02') ?? false) !== terminalP17(catalog)) {
  fail('P17-TS02 disagrees with the complete final catalog/approval/P14 predicate');
}

const packageJson = JSON.parse(text('package.json')) as { scripts?: Record<string, string> };
if (packageJson.scripts?.['check:p17'] !== 'bun scripts/check-p17-package.ts --pr-openable') {
  fail('package.json check:p17 registration drifted');
}
if (!packageJson.scripts?.check?.includes('bun run check:p17')) {
  fail('package.json check does not invoke check:p17');
}
const just = text('justfile');
if (!/^p17-check:\n\s+bun run check:p17$/m.test(just) || !/^check:.*\bp17-check\b/m.test(just)) {
  fail('justfile P17 gate registration drifted');
}

let links = 0;
for (const path of linkFiles) links += checkLinks(path);
for (const path of new Set(canonicalFiles)) {
  const body = text(path);
  if (!body.endsWith('\n')) fail(`${path} is missing final newline`);
  const badLine = body.split('\n').findIndex((line) => /[ \t]+$/.test(line));
  if (badLine >= 0) fail(`${path}:${badLine + 1} has trailing whitespace`);
}
const catalogResult = run(['bun', 'scripts/p17-catalog.ts', '--check']);
run(['git', 'diff', '--check']);
if (!statSync(resolve(root, 'projects/p17/catalog.json')).isFile()) {
  fail('catalog is not a regular file');
}

if (mode !== '--check') {
  if (!prepOpenable) fail(`${mode} requires the complete pr-openable preparation state`);
  if (preparationPr !== 'pending' && !/^#[1-9]\d*$/.test(preparationPr)) {
    fail('Preparation PR must be pending or a canonical #N');
  }
}

type Check = { name?: string; status?: string; conclusion?: string };
type PullRequest = {
  number: number;
  state: string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string;
  mergedAt?: string | null;
  mergeCommit?: { oid?: string } | null;
  statusCheckRollup?: Check[];
  url: string;
};

function prNumber(): number {
  const match = preparationPr.match(/^#([1-9]\d*)$/);
  if (!match) fail(`${mode} requires a committed Preparation PR: #N`);
  return Number(match[1]);
}

function requireChecks(pr: PullRequest): void {
  const checks = pr.statusCheckRollup ?? [];
  if (checks.length === 0) fail(`PR #${pr.number} has no completed CI checks`);
  const requiredNames = [
    'build-test (macos-latest)',
    'build-test (ubuntu-latest)',
    'lint-pr-title',
  ];
  for (const name of requiredNames) {
    const matching = checks.filter(
      (item) => item.name === name || item.name?.endsWith(` / ${name}`),
    );
    if (matching.length !== 1) {
      fail(`PR #${pr.number} required check ${name} is missing or duplicated`);
    }
    const check = matching[0];
    if (!check || check.conclusion !== 'SUCCESS') {
      fail(`PR #${pr.number} required check ${name} is not successful`);
    }
  }
  for (const check of checks) {
    const outcome = check.conclusion ?? check.status ?? '';
    if (['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STALE'].includes(outcome)) {
      fail(`PR #${pr.number} check ${check.name ?? 'unknown'} is ${outcome || 'unfinished'}`);
    }
  }
}

function requirePrAllowlist(number: number): void {
  const allowed = new Set(canonicalFiles);
  const files = jsonItems<{ filename: string }>(
    `repos/${repository}/pulls/${number}/files?per_page=100`,
  );
  const changed = files.map((file) => file.filename);
  if (changed.length === 0) fail(`PR #${number} has no changed files`);
  const unexpected = changed.filter((path) => !allowed.has(path));
  if (unexpected.length > 0) {
    fail(`PR #${number} contains files outside the reviewed P17 package: ${unexpected.join(', ')}`);
  }
  const missing = [...allowed].filter((path) => !changed.includes(path));
  if (missing.length > 0) {
    fail(`PR #${number} omits reviewed P17 package files: ${missing.join(', ')}`);
  }
}

function isGraphqlRateLimit(error: unknown): boolean {
  const message = String(error);
  return /graphql_rate_limit|["']?(?:type|code)["']?\s*:\s*["']?RATE_LIMIT|\brate limit (?:already )?exceeded\b|\bexceeded a secondary rate limit\b/i.test(
    message,
  );
}

function requireReviewClosure(
  number: number,
  { allowMergedEvidenceFallback }: { allowMergedEvidenceFallback: boolean },
): void {
  const [owner, name] = repository.split('/');
  if (!owner || !name) fail('malformed canonical GitHub repository');
  const query =
    'query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{isResolved}pageInfo{hasNextPage endCursor}}}}}';
  let cursor: string | null = null;
  do {
    const command = [
      'gh',
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      '-F',
      `owner=${owner}`,
      '-F',
      `name=${name}`,
      '-F',
      `number=${number}`,
    ];
    if (cursor) command.push('-F', `cursor=${cursor}`);
    let result: {
      data?: {
        repository?: {
          pullRequest?: {
            reviewThreads?: {
              nodes?: Array<{ isResolved: boolean }>;
              pageInfo?: { hasNextPage: boolean; endCursor: string | null };
            };
          };
        };
      };
    };
    try {
      result = json<{
        data?: {
          repository?: {
            pullRequest?: {
              reviewThreads?: {
                nodes?: Array<{ isResolved: boolean }>;
                pageInfo?: { hasNextPage: boolean; endCursor: string | null };
              };
            };
          };
        };
      }>(command);
    } catch (error) {
      const rateLimited = isGraphqlRateLimit(error);
      if (rateLimited && allowMergedEvidenceFallback && reviewClosed) {
        console.warn(
          'warning: GitHub GraphQL rate limit exhausted; --final accepted the merged PR with the committed closed preparation-review ledger',
        );
        return;
      }
      if (rateLimited) {
        fail(
          'GitHub GraphQL rate limit exhausted; --merge-ready requires a live review-thread query. Retry after the GraphQL quota resets.',
        );
      }
      const comments = jsonItems<{ id: number }>(
        `repos/${repository}/pulls/${number}/comments?per_page=100`,
      );
      if (comments.length > 0) {
        fail(
          `cannot query GitHub review-thread closure; REST found ${comments.length} review comments but does not expose thread resolution: ${String(error)}`,
        );
      }
      return;
    }
    const threads = result.data?.repository?.pullRequest?.reviewThreads;
    if ((threads?.nodes ?? []).some((thread) => !thread.isResolved)) {
      fail(`PR #${number} has unresolved review threads`);
    }
    cursor = threads?.pageInfo?.hasNextPage ? (threads.pageInfo.endCursor ?? null) : null;
    if (threads?.pageInfo?.hasNextPage && !cursor) {
      fail('GitHub review-thread pagination stalled');
    }
  } while (cursor);
}

function readPr(number: number): PullRequest {
  const pull = json<{
    number: number;
    state: string;
    draft: boolean;
    base: { ref: string };
    head: { ref: string; sha: string };
    mergeable: boolean | null;
    mergeable_state: string;
    merged_at: string | null;
    merge_commit_sha: string | null;
    html_url: string;
  }>(['gh', 'api', `repos/${repository}/pulls/${number}`]);
  const checkResponse = json<{
    check_runs: Array<{ name: string; status: string; conclusion: string | null }>;
  }>(['gh', 'api', `repos/${repository}/commits/${pull.head.sha}/check-runs?per_page=100`]);
  const reviews = jsonItems<{
    user?: { login?: string };
    state?: string;
    submitted_at?: string;
  }>(`repos/${repository}/pulls/${number}/reviews?per_page=100`);
  const latestReviews = new Map<string, string>();
  for (const review of reviews) {
    const login = review.user?.login;
    const state = review.state?.toUpperCase();
    if (login && state && state !== 'COMMENTED') latestReviews.set(login, state);
  }
  const reviewDecision = [...latestReviews.values()].includes('CHANGES_REQUESTED')
    ? 'CHANGES_REQUESTED'
    : '';
  return {
    number: pull.number,
    state: pull.merged_at ? 'MERGED' : pull.state.toUpperCase(),
    isDraft: pull.draft,
    baseRefName: pull.base.ref,
    headRefName: pull.head.ref,
    headRefOid: pull.head.sha,
    mergeable:
      pull.mergeable === true ? 'MERGEABLE' : pull.mergeable === false ? 'CONFLICTING' : 'UNKNOWN',
    mergeStateStatus: pull.mergeable_state.toUpperCase(),
    reviewDecision,
    mergedAt: pull.merged_at,
    mergeCommit: pull.merge_commit_sha ? { oid: pull.merge_commit_sha } : null,
    statusCheckRollup: checkResponse.check_runs.map((check) => ({
      name: check.name,
      status: check.status.toUpperCase(),
      conclusion: check.conclusion?.toUpperCase(),
    })),
    url: pull.html_url,
  };
}

if (mode === '--merge-ready') {
  requireCanonicalGitState();
  const number = prNumber();
  const pr = readPr(number);
  const head = run(['git', 'rev-parse', 'HEAD']);
  const branch = run(['git', 'branch', '--show-current']);
  if (
    pr.state !== 'OPEN' ||
    pr.isDraft ||
    pr.baseRefName !== 'main' ||
    pr.headRefName !== preparationBranch ||
    branch !== preparationBranch
  ) {
    fail(`PR #${number} is not the open non-draft PR for ${branch} -> main`);
  }
  if (pr.headRefOid !== head) fail(`PR #${number} head does not equal local HEAD`);
  if (pr.mergeable !== 'MERGEABLE') fail(`PR #${number} is not mergeable: ${pr.mergeable}`);
  if (pr.mergeStateStatus !== 'CLEAN') {
    fail(`PR #${number} branch-protection merge state is ${pr.mergeStateStatus}`);
  }
  if (['CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(pr.reviewDecision)) {
    fail(`PR #${number} has unsatisfied review decision ${pr.reviewDecision}`);
  }
  requireChecks(pr);
  requireReviewClosure(number, { allowMergedEvidenceFallback: false });
  requirePrAllowlist(number);
  console.log(`merge-ready: PR #${number} exact head ${head}; CI/reviews closed; ${pr.url}`);
  process.exit(0);
}

if (mode === '--final') {
  requireCanonicalGitState();
  const number = prNumber();
  const pr = readPr(number);
  if (pr.state !== 'MERGED' || !pr.mergedAt || !pr.mergeCommit?.oid) {
    fail(`PR #${number} is not confirmed merged`);
  }
  if (pr.baseRefName !== 'main' || pr.headRefName !== preparationBranch) {
    fail(`PR #${number} is not the P17 preparation branch -> main PR`);
  }
  if (['CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(pr.reviewDecision)) {
    fail(`PR #${number} has unsatisfied review decision ${pr.reviewDecision}`);
  }
  requireChecks(pr);
  requireReviewClosure(number, { allowMergedEvidenceFallback: true });
  requirePrAllowlist(number);
  const branch = run(['git', 'branch', '--show-current']);
  const head = run(['git', 'rev-parse', 'HEAD']);
  const originMain = run(['git', 'rev-parse', 'origin/main']);
  const remoteMain = run(['git', 'ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0];
  if (branch !== 'main' || head !== originMain || originMain !== remoteMain) {
    fail('final requires fresh local main exactly equal to fetched and remote origin/main');
  }
  run(['git', 'merge-base', '--is-ancestor', pr.mergeCommit.oid, 'origin/main']);
  console.log(
    `final: PR #${number} merged at ${pr.mergedAt}; ${pr.mergeCommit.oid} is on current origin/main; package tracked and clean`,
  );
  process.exit(0);
}

const label =
  mode === '--pr-openable'
    ? 'pr-openable'
    : 'structurally valid; preparation/PR/merge readiness was not asserted';
console.log(`${label}: ${prepById.size} prep IDs, ${links} local links, ${catalogResult}`);
