#!/usr/bin/env bun

import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';

type Kind =
  | 'recommendation'
  | 'phase-task'
  | 'phase-test'
  | 'command-test'
  | 'option-gate'
  | 'workflow'
  | 'command'
  | 'finding'
  | 'decision';

type InventoryItem = Pick<Entity, 'id' | 'kind' | 'title' | 'designStatus'>;

type ExecutionTarget = {
  kind: 'test' | 'static' | 'workflow' | 'distribution';
  path: string;
  selector: string;
  command: string;
};

type Entity = {
  id: string;
  kind: Kind;
  title: string;
  stateModel: 'work' | 'validation' | 'coverage';
  primaryGroup: string;
  secondaryGroups: string[];
  implements: string[];
  validatedBy: string[];
  impactedValidations: string[];
  affectedContracts: string[];
  testCommands: string[];
  ownedFiles: string[];
  status:
    | 'planned'
    | 'ready'
    | 'red'
    | 'green'
    | 'active'
    | 'passing'
    | 'failing'
    | 'skipped-required'
    | 'mapped'
    | 'validated'
    | 'reviewed'
    | 'signed-off'
    | 'failed'
    | 'blocked'
    | 'deferred';
  tier: 'required-pr' | 'supported-platform' | 'release' | 'deferred';
  plannedTarget: string;
  target: ExecutionTarget | null;
  evidence: string[];
  designStatus?: 'accepted' | 'retained';
};

type GateRecord = {
  status: 'pending' | 'passed' | 'failed' | 'blocked';
  evidence: string[];
};

type GroupStatus =
  | 'planned'
  | 'mapped'
  | 'ready'
  | 'active'
  | 'reviewed'
  | 'signed-off'
  | 'failed'
  | 'blocked'
  | 'deferred';

type Group = {
  id: string;
  phase: string;
  title: string;
  dependsOn: string[];
  status: GroupStatus;
  owner: string;
  ownedFiles: string[];
  integrationOwner: string | null;
  impactedValidations: string[];
  requiredNowValidations: string[];
  downstreamCoverage: string[];
  testCommands: string[];
  implementers: string[];
  reviewer: string | null;
  gates: Record<string, GateRecord>;
  evidence: string[];
};

type Phase = {
  id: string;
  dependsOn: string | null;
  requiredGroups: string[];
  status: 'planned' | 'active' | 'approved' | 'blocked' | 'deferred';
  entry: GateRecord;
  review: GateRecord & { reviewer: string | null };
  approval: GateRecord & { approvedBy: string | null };
  exit: GateRecord;
};

type Catalog = {
  schemaVersion: 2;
  baselineDate: '2026-07-11';
  plan: string;
  executionMap: string;
  counts: Record<Kind | 'total', number>;
  phases: Phase[];
  finalReview: GateRecord & { reviewer: string | null };
  finalApproval: GateRecord & { approvedBy: string | null };
  finalSignoff: GateRecord;
  groups: Group[];
  entities: Entity[];
};

const root = resolve(import.meta.dir, '..');
const planPath = resolve(
  root,
  'docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md',
);
const executionPath = resolve(root, 'projects/p17/EXECUTION.md');
const catalogPath = resolve(root, process.env.P17_CATALOG_PATH ?? 'projects/p17/catalog.json');
const checklistPath = resolve(root, process.env.P17_CHECKLIST_PATH ?? 'projects/p17/CHECKLIST.md');
const plan = readFileSync(planPath, 'utf8');
const execution = readFileSync(executionPath, 'utf8');

const expectedCounts: Record<Kind | 'total', number> = {
  recommendation: 34,
  'phase-task': 65,
  'phase-test': 61,
  'command-test': 157,
  'option-gate': 10,
  workflow: 16,
  command: 23,
  finding: 43,
  decision: 16,
  total: 425,
};

const gateNames = [
  'mapped',
  'ready',
  'test-first',
  'minimal-implementation',
  'targeted-green',
  'impacted-green',
  'refactor',
  'adversarial-review',
  'traceability-closure',
  'signed-off',
] as const;

function fail(message: string): never {
  throw new Error(message);
}

function matches(regex: RegExp, text: string): Array<{ id: string; title: string }> {
  return [...text.matchAll(regex)].map((match) => {
    const id = match[1];
    const title = match[2];
    if (!id || !title) fail(`malformed inventory match for ${regex.source}`);
    return { id, title: title.trim() };
  });
}

function collectInventory(): InventoryItem[] {
  const inventory: InventoryItem[] = [];
  for (const item of matches(/^### (P[0-3]-\d{2}) (.+)$/gm, plan)) {
    inventory.push({ ...item, kind: 'recommendation', designStatus: 'retained' });
  }
  for (const item of matches(
    /^- \*\*(EWP-P(?:0A|1|2|3A|3B|4A|4B|5|6)-T\d{2}):\*\* (.+)$/gm,
    plan,
  )) {
    inventory.push({ ...item, kind: 'phase-task' });
  }
  for (const item of matches(
    /^- \*\*(EWP-P(?:0A|1|2|3A|3B|4A|4B|5|6)-TS\d{2}):\*\* (.+)$/gm,
    plan,
  )) {
    inventory.push({ ...item, kind: 'phase-test' });
  }
  for (const item of matches(/^- \*\*(EWP-CMD-[A-Z]+-TS\d{2}):\*\* (.+)$/gm, plan)) {
    inventory.push({ ...item, kind: 'command-test' });
  }
  for (const item of matches(/^- \*\*(EWP-OPT-TS\d{2}):\*\* (.+)$/gm, plan)) {
    inventory.push({ ...item, kind: 'option-gate' });
  }
  for (const item of matches(/^### (EWP-WF\d{2}) (.+)$/gm, plan)) {
    inventory.push({ ...item, kind: 'workflow' });
  }
  for (const item of matches(/^#### (EWP-CF-\d{3}) — (.+)$/gm, plan)) {
    inventory.push({ ...item, kind: 'finding', designStatus: 'accepted' });
  }
  for (const item of matches(/^#### (D-\d{3}) — (.+)$/gm, plan)) {
    inventory.push({ ...item, kind: 'decision', designStatus: 'accepted' });
  }
  const commandRows = [
    ...plan.matchAll(
      /^\| (Discover|Manage|Develop|Declarative|Maintain) \| `([a-z]+)` \| (.+?) \|/gm,
    ),
  ];
  for (const row of commandRows) {
    const group = row[1];
    const command = row[2];
    const question = row[3];
    if (!group || !command || !question) fail('malformed command complexity row');
    inventory.push({
      id: `COMMAND:${command}`,
      kind: 'command',
      title: `${group} — ${question.trim()}`,
    });
  }

  const seen = new Set<string>();
  for (const item of inventory) {
    if (seen.has(item.id)) fail(`duplicate inventory definition: ${item.id}`);
    seen.add(item.id);
  }
  return inventory;
}

function parseGroups(): Group[] {
  const groups: Group[] = [];
  const rows = execution.matchAll(/^\| (P17-G[^ |]+) \| ([^|]+?) \| ([^|]+?) \| (.+?) \|$/gm);
  for (const row of rows) {
    const id = row[1];
    const phase = row[2]?.trim();
    const dependencyCell = row[3]?.trim();
    const title = row[4]?.trim();
    if (!id || !phase || !dependencyCell || !title) fail('malformed execution group row');
    const dependencies =
      dependencyCell === '—' ? [] : dependencyCell.split(',').map((item) => `P17-${item.trim()}`);
    groups.push({
      id,
      phase,
      title,
      dependsOn: dependencies,
      status: phase === '7' ? 'deferred' : 'planned',
      owner: 'root-goal',
      ownedFiles: [],
      integrationOwner: null,
      impactedValidations: [],
      requiredNowValidations: [],
      downstreamCoverage: [],
      testCommands: [],
      implementers: [],
      reviewer: null,
      gates: Object.fromEntries(
        gateNames.map((gate) => [gate, { status: 'pending', evidence: [] }]),
      ),
      evidence: [],
    });
  }
  if (groups.length !== 45) fail(`expected 45 groups, found ${groups.length}`);
  return groups;
}

const mapping = new Map<string, string>();
function map(group: string, ids: string[]): void {
  for (const id of ids) {
    if (mapping.has(id)) fail(`duplicate mapping for ${id}`);
    mapping.set(id, `P17-${group}`);
  }
}

map('G0-01', [
  'EWP-P0A-T01',
  'EWP-P0A-T06',
  'EWP-P0A-T10',
  'EWP-P0A-TS01',
  'EWP-P0A-TS06',
  'EWP-P0A-TS07',
]);
map('G0-02', [
  'EWP-P0A-T02',
  'EWP-P0A-T07',
  'EWP-P0A-T11',
  'EWP-P0A-TS02',
  'EWP-P0A-TS03',
  'EWP-P0A-TS04',
  'EWP-P0A-TS08',
]);
map('G0-03', ['EWP-P0A-T03', 'EWP-P0A-T04', 'EWP-P0A-T05']);
map('G0-04', ['EWP-P0A-T08', 'EWP-P0A-TS05']);
map('G0-05', ['EWP-P0A-T09', 'EWP-P0A-T12', 'EWP-P0A-TS09']);

map('G1-01', [
  'EWP-P1-T01',
  'EWP-P1-T02',
  'EWP-P1-T03',
  'EWP-P1-TS01',
  'EWP-P1-TS02',
  'EWP-P1-TS03',
]);
map('G1-02A', ['EWP-P1-T04', 'EWP-P1-T08', 'EWP-P1-TS06']);
map('G1-02B', ['EWP-P1-T05', 'EWP-P1-TS04']);
map('G1-02C', ['EWP-P1-T06', 'EWP-P1-T07', 'EWP-P1-TS05']);
map('G1-03', ['EWP-P1-T09', 'EWP-P1-TS07']);
map('G1-04', ['EWP-P1-T10', 'EWP-P1-TS08']);
map('G1-05', ['EWP-P1-T11', 'EWP-P1-TS09']);
map('G1-06', ['EWP-P1-T12', 'EWP-P1-TS10']);
map('G1-07', ['EWP-P1-T13', 'EWP-P1-TS11']);

map('G2-01', ['EWP-P2-T01', 'EWP-P2-T02', 'EWP-P2-TS01', 'EWP-P2-TS02']);
map('G2-02', ['EWP-P2-T03', 'EWP-P2-TS03']);
map('G2-03', ['EWP-P2-T04', 'EWP-P2-TS04', 'EWP-P2-TS07']);
map('G2-04', ['EWP-P2-T05', 'EWP-P2-TS05']);
map('G2-05', ['EWP-P2-T06', 'EWP-P2-TS06', 'EWP-P2-TS08']);

map('G3A-01', ['EWP-P3A-T02', 'EWP-P3A-T03', 'EWP-P3A-TS02', 'EWP-P3A-TS04']);
map('G3A-02', ['EWP-P3A-T01', 'EWP-P3A-T04', 'EWP-P3A-T05', 'EWP-P3A-TS01', 'EWP-P3A-TS03']);
map('G3B-01', ['EWP-P3B-T01', 'EWP-P3B-T03', 'EWP-P3B-TS01', 'EWP-P3B-TS02']);
map('G3B-02', ['EWP-P3B-T02', 'EWP-P3B-TS03']);
map('G3B-03', ['EWP-P3B-T04', 'EWP-P3B-TS04']);
map('G3B-04', ['EWP-P3B-T05', 'EWP-P3B-TS05']);
map('G3B-05', ['EWP-P3B-T06', 'EWP-P3B-TS06']);
map('G3B-06', ['EWP-P3B-T07', 'EWP-P3B-TS07']);

map('G4A-01', ['EWP-P4A-T01', 'EWP-P4A-TS01']);
map('G4A-02', ['EWP-P4A-T02', 'EWP-P4A-TS03']);
map('G4A-03', ['EWP-P4A-T04', 'EWP-P4A-TS04']);
map('G4A-04', ['EWP-P4A-T03', 'EWP-P4A-TS02']);
map('G4B-01', ['EWP-P4B-T01', 'EWP-P4B-T02', 'EWP-P4B-TS01', 'EWP-P4B-TS02', 'EWP-P4B-TS04']);
map('G4B-02', ['EWP-P4B-T03', 'EWP-P4B-T04', 'EWP-P4B-TS03', 'EWP-P4B-TS07']);
map('G4B-03', ['EWP-P4B-T05', 'EWP-P4B-TS05', 'EWP-P4B-TS06']);

map('G5-01', ['EWP-P5-T01', 'EWP-P5-T02', 'EWP-P5-TS01']);
map('G5-02', ['EWP-P5-T03', 'EWP-P5-T04', 'EWP-P5-TS02']);
map('G5-03', ['EWP-P5-T05', 'EWP-P5-TS03']);
map('G5-04', ['EWP-P5-T06', 'EWP-P5-TS04']);
map('G5-05', ['EWP-P5-TS05']);

map('G6-01', ['EWP-P6-T01', 'EWP-P6-T02', 'EWP-P6-TS01']);
map('G6-02A', ['EWP-P6-T04', 'EWP-P6-TS04', 'EWP-P6-TS05']);
map('G6-02B', ['EWP-P6-T03', 'EWP-P6-TS02']);
map('G6-03', ['EWP-P6-T05', 'EWP-P6-T06', 'EWP-P6-TS03']);
map('G6-04', ['EWP-P6-T07', 'EWP-P6-TS06']);

const recommendationGroups: Record<string, string> = {
  'P0-01': 'G1-01',
  'P0-02': 'G1-01',
  'P0-03': 'G1-01',
  'P0-04': 'G1-02B',
  'P0-05': 'G1-02C',
  'P0-06': 'G1-02A',
  'P0-07': 'G2-05',
  'P0-08': 'G2-05',
  'P1-01': 'G3A-02',
  'P1-02': 'G3A-01',
  'P1-03': 'G3A-02',
  'P1-04': 'G5-05',
  'P1-05': 'G4A-03',
  'P1-06': 'G4A-02',
  'P1-07': 'G4B-01',
  'P1-08': 'G4B-02',
  'P1-09': 'G4A-01',
  'P1-10': 'G5-01',
  'P1-11': 'G5-03',
  'P1-12': 'G6-01',
  'P2-01': 'G1-02A',
  'P2-02': 'G5-02',
  'P2-03': 'G5-04',
  'P2-04': 'G6-02B',
  'P2-05': 'G6-02A',
  'P2-06': 'G1-05',
  'P2-07': 'G3B-03',
  'P2-08': 'G6-03',
  'P3-01': 'G7-01',
  'P3-02': 'G7-01',
  'P3-03': 'G7-01',
  'P3-04': 'G7-01',
  'P3-05': 'G7-01',
  'P3-06': 'G7-01',
};
for (const [id, group] of Object.entries(recommendationGroups)) map(group, [id]);

const decisionGroups = [
  'G4B-01',
  'G4B-02',
  'G2-01',
  'G2-02',
  'G4A-02',
  'G4A-01',
  'G5-01',
  'G3A-01',
  'G3B-01',
  'G3B-03',
  'G5-02',
  'G5-04',
  'G7-01',
  'G4B-02',
  'G4B-03',
  'G6-04',
];
decisionGroups.forEach((group, index) => map(group, [`D-${String(index + 1).padStart(3, '0')}`]));

const findingGroups = [
  'G0-03',
  'G3B-01',
  'G2-01',
  'G1-02A',
  'G3B-02',
  'G3B-03',
  'G1-05',
  'G5-02',
  'G4B-02',
  'G0-02',
  'G4A-02',
  'G2-03',
  'G6-02A',
  'G6-02B',
  'G4B-02',
  'G5-04',
  'G0-04',
  'G0-05',
  'G2-01',
  'G4A-01',
  'G2-01',
  'G1-01',
  'G0-02',
  'G1-01',
  'G3B-01',
  'G3B-02',
  'G2-02',
  'G3B-03',
  'G2-05',
  'G2-03',
  'G1-01',
  'G6-02A',
  'G1-03',
  'G1-04',
  'G3B-04',
  'G1-05',
  'G1-06',
  'G1-07',
  'G0-05',
  'G2-01',
  'G4A-03',
  'G4B-02',
  'G1-02A',
];
findingGroups.forEach((group, index) =>
  map(group, [`EWP-CF-${String(index + 1).padStart(3, '0')}`]),
);

const workflowGroups = [
  'G4A-01',
  'G4A-01',
  'G4A-03',
  'G4A-02',
  'G5-03',
  'G4B-01',
  'G4B-02',
  'G4B-01',
  'G5-02',
  'G5-01',
  'G3B-03',
  'G5-04',
  'G4A-04',
  'G1-01',
  'G1-02A',
  'G6-02A',
];
workflowGroups.forEach((group, index) =>
  map(group, [`EWP-WF${String(index + 1).padStart(2, '0')}`]),
);

const optionGroups = [
  'G0-02',
  'G1-03',
  'G1-03',
  'G1-02A',
  'G6-02A',
  'G1-01',
  'G6-02A',
  'G5-05',
  'G4B-02',
  'G1-02A',
];
optionGroups.forEach((group, index) =>
  map(group, [`EWP-OPT-TS${String(index + 1).padStart(2, '0')}`]),
);

const commandGroups: Record<string, string> = {
  agents: 'G3A-02',
  list: 'G3A-02',
  commands: 'G3A-02',
  status: 'G3A-01',
  install: 'G4A-01',
  uninstall: 'G4A-01',
  update: 'G5-02',
  undo: 'G5-03',
  dev: 'G3B-01',
  verify: 'G1-05',
  promote: 'G3B-01',
  init: 'G4A-03',
  export: 'G4A-02',
  plan: 'G4B-01',
  apply: 'G4B-02',
  sync: 'G5-01',
  doctor: 'G3B-03',
  check: 'G1-02B',
  gc: 'G5-04',
  config: 'G2-01',
  completion: 'G6-02B',
  version: 'G1-03',
  help: 'G6-02A',
};
for (const [command, group] of Object.entries(commandGroups)) map(group, [`COMMAND:${command}`]);

const commandTestGroups: Record<string, string> = {
  AGENTS: 'G3A-02',
  LIST: 'G3A-02',
  COMMANDS: 'G3A-02',
  STATUS: 'G3A-01',
  INSTALL: 'G4A-01',
  UNINSTALL: 'G4A-01',
  UPDATE: 'G5-02',
  UNDO: 'G5-03',
  DEV: 'G3B-01',
  VERIFY: 'G1-05',
  PROMOTE: 'G3B-01',
  INIT: 'G4A-03',
  EXPORT: 'G4A-02',
  PLAN: 'G4B-01',
  APPLY: 'G4B-02',
  SYNC: 'G5-01',
  DOCTOR: 'G3B-03',
  CHECK: 'G1-02B',
  GC: 'G5-04',
  CONFIG: 'G2-01',
  COMPLETION: 'G6-02B',
  VERSION: 'G1-03',
  HELP: 'G6-02A',
};

function groupFor(id: string): string {
  const direct = mapping.get(id);
  if (direct) return direct;
  const commandTest = id.match(/^EWP-CMD-([A-Z]+)-TS\d{2}$/);
  if (commandTest) {
    const command = commandTest[1];
    if (!command) fail(`malformed command-test ID ${id}`);
    const group = commandTestGroups[command];
    if (group) return `P17-${group}`;
  }
  return fail(`no primary group mapping for ${id}`);
}

function tierFor(group: string): Entity['tier'] {
  if (group === 'P17-G7-01') return 'deferred';
  if (group === 'P17-G6-01' || group === 'P17-G6-04') return 'release';
  if (group === 'P17-G6-02B') return 'supported-platform';
  return 'required-pr';
}

function targetFor(item: { id: string; kind: Kind }, group: string): string {
  if (item.kind === 'phase-task') return `planned:${group}`;
  if (item.kind === 'phase-test')
    return `planned:${group}:tests/ergonomics/phase/${item.id}.test.ts#${item.id}`;
  if (item.kind === 'command-test') {
    const command = item.id.match(/^EWP-CMD-([A-Z]+)-/)?.[1]?.toLowerCase() ?? 'unknown';
    return `planned:${group}:packages/cli/tests/contracts/${command}.test.ts#${item.id}`;
  }
  if (item.kind === 'option-gate')
    return `planned:${group}:packages/cli/tests/contracts/options.test.ts#${item.id}`;
  if (item.kind === 'workflow')
    return `planned:${group}:tests/ergonomics/workflows/${item.id}.test.ts#${item.id}`;
  if (item.kind === 'command') return `surface:${item.id.slice('COMMAND:'.length)}`;
  return `coverage:${group}`;
}

function computeCounts(entities: Entity[]): Catalog['counts'] {
  const counts = Object.fromEntries(
    Object.keys(expectedCounts).map((key) => [key, 0]),
  ) as Catalog['counts'];
  for (const entity of entities) counts[entity.kind] += 1;
  counts.total = entities.length;
  return counts;
}

function stateModelFor(kind: Kind): Entity['stateModel'] {
  if (kind === 'phase-task') return 'work';
  if (['phase-test', 'command-test', 'option-gate', 'workflow'].includes(kind)) return 'validation';
  return 'coverage';
}

const validationPrefix = '(?:EWP-(?:P(?:0A|1|2|3A|3B|4A|4B|5|6)-TS|CMD-[A-Z]+-TS|OPT-TS)|EWP-WF)';

const explicitValidationOwnership: Record<string, string[]> = {
  'COMMAND:dev': [
    'EWP-CMD-DEV-TS01',
    'EWP-CMD-DEV-TS02',
    'EWP-CMD-DEV-TS03',
    'EWP-CMD-DEV-TS04',
    'EWP-CMD-DEV-TS05',
    'EWP-CMD-DEV-TS06',
    'EWP-CMD-PROMOTE-TS01',
    'EWP-CMD-PROMOTE-TS02',
    'EWP-CMD-PROMOTE-TS03',
    'EWP-CMD-PROMOTE-TS04',
    'EWP-CMD-PROMOTE-TS05',
    'EWP-CMD-PROMOTE-TS06',
    'EWP-P3B-TS01',
    'EWP-P3B-TS02',
    'EWP-WF05',
  ],
  'COMMAND:promote': [
    'EWP-CMD-DEV-TS01',
    'EWP-CMD-DEV-TS02',
    'EWP-CMD-DEV-TS03',
    'EWP-CMD-DEV-TS04',
    'EWP-CMD-DEV-TS05',
    'EWP-CMD-DEV-TS06',
    'EWP-CMD-PROMOTE-TS01',
    'EWP-CMD-PROMOTE-TS02',
    'EWP-CMD-PROMOTE-TS03',
    'EWP-CMD-PROMOTE-TS04',
    'EWP-CMD-PROMOTE-TS05',
    'EWP-CMD-PROMOTE-TS06',
    'EWP-P3B-TS01',
    'EWP-P3B-TS02',
    'EWP-WF05',
  ],
  'D-009': [
    'EWP-CMD-DEV-TS01',
    'EWP-CMD-DEV-TS02',
    'EWP-CMD-DEV-TS03',
    'EWP-CMD-DEV-TS04',
    'EWP-CMD-DEV-TS05',
    'EWP-CMD-DEV-TS06',
    'EWP-CMD-PROMOTE-TS01',
    'EWP-CMD-PROMOTE-TS02',
    'EWP-CMD-PROMOTE-TS03',
    'EWP-CMD-PROMOTE-TS04',
    'EWP-CMD-PROMOTE-TS05',
    'EWP-CMD-PROMOTE-TS06',
    'EWP-P3B-TS01',
    'EWP-P3B-TS02',
    'EWP-WF05',
  ],
  'EWP-P5-T05': [
    'EWP-CMD-DEV-TS05',
    'EWP-CMD-PROMOTE-TS05',
    'EWP-CMD-UNDO-TS01',
    'EWP-CMD-UNDO-TS02',
    'EWP-CMD-UNDO-TS03',
    'EWP-CMD-UNDO-TS04',
    'EWP-CMD-UNDO-TS05',
    'EWP-CMD-UNDO-TS06',
    'EWP-CMD-UNDO-TS07',
    'EWP-CMD-UNDO-TS08',
    'EWP-CMD-UNDO-TS09',
    'EWP-P5-TS03',
    'EWP-WF05',
  ],
  'COMMAND:config': [
    'EWP-CMD-CONFIG-TS01',
    'EWP-CMD-CONFIG-TS02',
    'EWP-CMD-CONFIG-TS03',
    'EWP-CMD-CONFIG-TS04',
    'EWP-CMD-CONFIG-TS05',
    'EWP-OPT-TS01',
    'EWP-P0A-TS05',
    'EWP-P0A-TS09',
    'EWP-P1-TS01',
    'EWP-P1-TS02',
    'EWP-P1-TS03',
    'EWP-P1-TS05',
    'EWP-P1-TS06',
    'EWP-P1-TS07',
    'EWP-P1-TS08',
    'EWP-P1-TS09',
    'EWP-P1-TS10',
    'EWP-P1-TS11',
    'EWP-P2-TS01',
    'EWP-P2-TS02',
    'EWP-WF14',
  ],
  // EWP-OPT-TS08 is a final cross-command artifact-option gate, not evidence for P1-04's bulk
  // scheduling contract merely because both close in G5-05.
  'EWP-OPT-TS08': ['EWP-OPT-TS08'],
  'EWP-P5-TS05': ['EWP-P5-TS05'],
  'EWP-P2-T04': [
    'EWP-CMD-CONFIG-TS01',
    'EWP-CMD-CONFIG-TS04',
    'EWP-P1-TS08',
    'EWP-P2-TS01',
    'EWP-P2-TS04',
    'EWP-P2-TS07',
  ],
  'EWP-P2-T05': [
    'EWP-CMD-CONFIG-TS01',
    'EWP-CMD-CONFIG-TS04',
    'EWP-P1-TS08',
    'EWP-P2-TS01',
    'EWP-P2-TS04',
    'EWP-P2-TS05',
  ],
  'P1-04': ['EWP-P5-TS05'],
  // P0-01's project-context/parser slice lands in G1-01. Output/runtime, observer diagnostics,
  // and final TTY/color behavior remain mandatory downstream instead of being falsely signed off.
  'P0-01': [
    'EWP-OPT-TS06',
    'EWP-P1-TS01',
    'EWP-P1-TS02',
    'EWP-P1-TS03',
    'EWP-P1-TS05',
    'EWP-P1-TS07',
    'EWP-P1-TS11',
    'EWP-P6-TS03',
    'EWP-WF14',
    'EWP-WF15',
  ],
  'P0-08': [
    'EWP-P1-TS01',
    'EWP-P1-TS02',
    'EWP-P1-TS03',
    'EWP-P1-TS04',
    'EWP-P1-TS05',
    'EWP-P1-TS06',
    'EWP-P1-TS07',
    'EWP-P2-TS02',
    'EWP-P2-TS06',
    'EWP-CMD-CONFIG-TS03',
    'EWP-CMD-CONFIG-TS04',
    'EWP-WF14',
  ],
};

const explicitContractOwnership: Record<string, string[]> = {
  'EWP-WF05': [
    'COMMAND:dev',
    'COMMAND:promote',
    'COMMAND:undo',
    'D-009',
    'EWP-CF-002',
    'EWP-CF-025',
    'EWP-CF-026',
    'P1-11',
  ],
  'EWP-WF09': ['COMMAND:update', 'D-011', 'EWP-CF-008', 'EWP-CF-026', 'P2-02'],
  'EWP-WF10': ['COMMAND:sync', 'D-007', 'EWP-CF-026', 'P1-10'],
  'EWP-WF15': ['EWP-CF-004', 'EWP-CF-026', 'EWP-CF-043', 'P0-06', 'P2-01'],
  'EWP-CMD-CONFIG-TS01': ['COMMAND:config', 'D-003', 'EWP-CF-012'],
  'EWP-CMD-CONFIG-TS02': ['COMMAND:config', 'D-003', 'P0-02'],
  'EWP-CMD-CONFIG-TS03': ['COMMAND:config', 'D-003', 'EWP-CF-022'],
  'EWP-CMD-CONFIG-TS04': ['COMMAND:config', 'D-003', 'EWP-CF-012', 'EWP-CF-029'],
  'EWP-CMD-CONFIG-TS05': ['COMMAND:config', 'D-003', 'P0-03'],
  'EWP-OPT-TS08': [
    'COMMAND:apply',
    'COMMAND:check',
    'COMMAND:doctor',
    'COMMAND:export',
    'COMMAND:install',
    'COMMAND:plan',
    'COMMAND:status',
    'COMMAND:sync',
    'COMMAND:uninstall',
    'COMMAND:update',
    'EWP-CF-003',
    'EWP-CF-040',
  ],
  'EWP-P2-T01': ['D-003', 'EWP-CF-003', 'EWP-CF-021', 'EWP-CF-022', 'EWP-CF-040'],
  'EWP-P2-T02': ['D-003', 'EWP-CF-019', 'EWP-CF-029', 'EWP-CF-030'],
  'EWP-P2-TS01': ['D-003', 'EWP-CF-019', 'EWP-CF-027', 'EWP-CF-029', 'EWP-CF-030'],
  'EWP-P2-TS02': ['D-003', 'EWP-CF-003', 'EWP-CF-021', 'EWP-CF-022', 'EWP-CF-040'],
};

function validationReferences(value: string): string[] {
  const references = new Set<string>();
  const direct = new RegExp(`${validationPrefix}\\d{2}`, 'g');
  for (const id of value.match(direct) ?? []) references.add(id);
  const range = new RegExp(`(${validationPrefix})(\\d{2})\\.\\.(\\d{2})`, 'g');
  for (const match of value.matchAll(range)) {
    const prefix = match[1];
    const start = Number(match[2]);
    const end = Number(match[3]);
    if (!prefix || !Number.isInteger(start) || !Number.isInteger(end) || end < start) continue;
    for (let index = start; index <= end; index += 1) {
      references.add(`${prefix}${String(index).padStart(2, '0')}`);
    }
  }
  const slash = new RegExp(`(${validationPrefix})(\\d{2})((?:/\\d{2})+)`, 'g');
  for (const match of value.matchAll(slash)) {
    const prefix = match[1];
    const suffixes = match[3]?.split('/').filter(Boolean) ?? [];
    if (!prefix) continue;
    for (const suffix of suffixes) references.add(`${prefix}${suffix}`);
  }
  return [...references].sort();
}

type FindingRelation = { validations: string[]; contracts: string[] };

const shorthandFindingCommands: Record<string, string[]> = {
  'EWP-CF-023': ['check', 'install', 'dev', 'promote', 'undo'],
  'EWP-CF-026': ['install', 'uninstall', 'dev', 'promote', 'apply', 'sync', 'update', 'undo'],
  'EWP-CF-029': [
    'config',
    'doctor',
    'init',
    'install',
    'uninstall',
    'export',
    'plan',
    'apply',
    'sync',
  ],
  'EWP-CF-030': ['install', 'export', 'plan', 'apply'],
  'EWP-CF-031': ['status', 'dev', 'promote', 'plan', 'apply', 'sync', 'update', 'undo', 'gc'],
  'EWP-CF-043': [
    'install',
    'uninstall',
    'dev',
    'promote',
    'doctor',
    'check',
    'init',
    'export',
    'plan',
    'apply',
    'sync',
    'update',
    'undo',
    'gc',
  ],
};

function findingTraceability(): Map<string, FindingRelation> {
  const relationships = new Map<string, FindingRelation>();
  const start = plan.indexOf('| Finding | Normative design retained in |');
  const end = plan.indexOf('\n#### EWP-CF-001', start);
  if (start < 0 || end < 0) fail('missing accepted-finding traceability table');
  for (const line of plan.slice(start, end).split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    const id = cells[1]?.match(/^EWP-CF-\d{3}$/)?.[0];
    const validationCell = cells[4];
    if (!id || !validationCell) continue;
    if (relationships.has(id)) fail(`duplicate finding traceability row ${id}`);
    const references = validationReferences(validationCell);
    if (references.length === 0) fail(`${id} has no validation ownership`);
    relationships.set(id, { validations: references, contracts: [] });
  }
  for (const [id, relation] of relationships) {
    const sectionStart = plan.indexOf(`\n#### ${id} —`);
    const nextSection = plan.indexOf('\n#### EWP-CF-', sectionStart + 1);
    if (sectionStart < 0) fail(`${id} lacks a detailed finding section`);
    const section = plan.slice(sectionStart, nextSection < 0 ? undefined : nextSection);
    const detailedValidationText = [
      ...section.matchAll(/^- \*\*[^*]*[Vv]alidation[^*]*:\*\*([\s\S]*?)(?=\n- \*\*|\n####)/gm),
    ]
      .map((match) => match[1] ?? '')
      .join('\n');
    const validations = [
      ...new Set([...relation.validations, ...validationReferences(detailedValidationText)]),
    ].sort();
    const commands = new Set(shorthandFindingCommands[id] ?? []);
    for (const validation of validations) {
      const command = validation.match(/^EWP-CMD-([A-Z]+)-TS\d{2}$/)?.[1]?.toLowerCase();
      if (command) commands.add(command);
    }
    for (const command of shorthandFindingCommands[id] ?? []) {
      for (const item of matches(
        new RegExp(`^- \\*\\*(EWP-CMD-${command.toUpperCase()}-TS\\d{2}):\\*\\* (.+)$`, 'gm'),
        plan,
      )) {
        validations.push(item.id);
      }
    }
    relation.validations = [...new Set(validations)].sort();
    relation.contracts = [...commands].sort().map((command) => `COMMAND:${command}`);
  }
  return relationships;
}

function createPhases(groups: Group[]): Phase[] {
  const phaseIds = ['0', '1', '2', '3', '4', '5', '6', '7'];
  return phaseIds.map((id, index) => {
    const requiredGroups = groups
      .filter((group) =>
        id === '3' || id === '4' ? group.phase.startsWith(id) : group.phase === id,
      )
      .map((group) => group.id);
    const gate = (): GateRecord => ({ status: 'pending', evidence: [] });
    return {
      id,
      dependsOn: index === 0 ? null : (phaseIds[index - 1] ?? null),
      requiredGroups,
      status: id === '7' ? 'deferred' : 'planned',
      entry: gate(),
      review: { ...gate(), reviewer: null },
      approval: { ...gate(), approvedBy: null },
      exit: gate(),
    };
  });
}

function initialize(): Catalog {
  const groups = parseGroups();
  const groupIds = new Set(groups.map((group) => group.id));
  const baseEntities = collectInventory()
    .map((item) => {
      const primaryGroup = groupFor(item.id);
      if (!groupIds.has(primaryGroup)) fail(`${item.id} maps to missing group ${primaryGroup}`);
      const tier = tierFor(primaryGroup);
      return {
        ...item,
        stateModel: stateModelFor(item.kind),
        primaryGroup,
        status: tier === 'deferred' ? 'deferred' : 'planned',
        tier,
        plannedTarget: targetFor(item, primaryGroup),
        target: null,
        evidence: [],
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const validationKinds = new Set<Kind>(['phase-test', 'command-test', 'option-gate', 'workflow']);
  const contractKinds = new Set<Kind>(['recommendation', 'command', 'finding', 'decision']);
  const validationsByGroup = new Map<string, string[]>();
  const validationsByPhase = new Map<string, string[]>();
  const contractsByGroup = new Map<string, string[]>();
  const parsedGroupById = new Map(groups.map((group) => [group.id, group]));
  const tracedFindings = findingTraceability();
  for (const item of baseEntities) {
    if (validationKinds.has(item.kind)) {
      const ids = validationsByGroup.get(item.primaryGroup) ?? [];
      ids.push(item.id);
      validationsByGroup.set(item.primaryGroup, ids);
      const phase = parsedGroupById.get(item.primaryGroup)?.phase;
      if (phase) {
        const phaseId = phase.startsWith('3') ? '3' : phase.startsWith('4') ? '4' : phase;
        const phaseIds = validationsByPhase.get(phaseId) ?? [];
        phaseIds.push(item.id);
        validationsByPhase.set(phaseId, phaseIds);
      }
    }
    if (contractKinds.has(item.kind)) {
      const ids = contractsByGroup.get(item.primaryGroup) ?? [];
      ids.push(item.id);
      contractsByGroup.set(item.primaryGroup, ids);
    }
  }
  const baseById = new Map(baseEntities.map((entity) => [entity.id, entity]));
  for (const item of baseEntities.filter((entity) => entity.kind === 'finding')) {
    const relation = tracedFindings.get(item.id);
    if (!relation) fail(`${item.id} lacks finding traceability`);
    for (const reference of relation.validations) {
      const related = baseById.get(reference);
      if (!related || !validationKinds.has(related.kind)) {
        fail(`${item.id} has invalid traceability reference ${reference}`);
      }
    }
  }
  const entities: Entity[] = baseEntities.map((item) => {
    const group = parsedGroupById.get(item.primaryGroup);
    const phaseId = group?.phase.startsWith('3')
      ? '3'
      : group?.phase.startsWith('4')
        ? '4'
        : group?.phase;
    const primaryValidations = validationsByGroup.get(item.primaryGroup) ?? [];
    const fallbackValidations =
      primaryValidations.length > 0
        ? primaryValidations
        : (validationsByPhase.get(phaseId ?? '') ?? []);
    const findingRelation = item.kind === 'finding' ? tracedFindings.get(item.id) : undefined;
    const tracedValidations = findingRelation?.validations ?? [];
    const validations =
      explicitValidationOwnership[item.id] ??
      (tracedValidations.length > 0 ? tracedValidations : fallbackValidations);
    const contracts =
      explicitContractOwnership[item.id] ??
      (item.kind === 'finding'
        ? (findingRelation?.contracts ?? [])
        : (contractsByGroup.get(item.primaryGroup) ?? []));
    const secondaryGroups = [
      ...new Set(
        [...validations, ...contracts]
          .map((id) => baseById.get(id)?.primaryGroup)
          .filter((id): id is string => Boolean(id) && id !== item.primaryGroup),
      ),
    ];
    return {
      ...item,
      secondaryGroups,
      implements: item.kind === 'phase-task' ? [...contracts] : [],
      validatedBy: validationKinds.has(item.kind) ? [item.id] : [...validations],
      impactedValidations: [...validations],
      affectedContracts: [...contracts],
      testCommands: [],
      ownedFiles: [],
    };
  });
  const dependencyClosure = (groupId: string): Set<string> => {
    const closure = new Set<string>();
    const visit = (id: string): void => {
      for (const dependency of parsedGroupById.get(id)?.dependsOn ?? []) {
        if (closure.has(dependency)) continue;
        closure.add(dependency);
        visit(dependency);
      }
    };
    visit(groupId);
    return closure;
  };
  for (const group of groups) {
    const phaseId = group.phase.startsWith('3')
      ? '3'
      : group.phase.startsWith('4')
        ? '4'
        : group.phase;
    const primary = validationsByGroup.get(group.id) ?? [];
    const traced = entities
      .filter((entity) => entity.primaryGroup === group.id)
      .flatMap((entity) => entity.impactedValidations);
    group.impactedValidations = [
      ...new Set([
        ...(primary.length > 0 ? primary : (validationsByPhase.get(phaseId) ?? [])),
        ...traced,
      ]),
    ].sort();
    const availableGroups = dependencyClosure(group.id);
    availableGroups.add(group.id);
    group.requiredNowValidations = group.impactedValidations.filter((id) => {
      const owner = baseById.get(id)?.primaryGroup;
      return Boolean(owner) && availableGroups.has(owner ?? '');
    });
    group.downstreamCoverage = group.impactedValidations.filter(
      (id) => !group.requiredNowValidations.includes(id),
    );
  }
  return {
    schemaVersion: 2,
    baselineDate: '2026-07-11',
    plan: 'docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md',
    executionMap: 'projects/p17/EXECUTION.md',
    counts: computeCounts(entities),
    phases: createPhases(groups),
    finalReview: { status: 'pending', evidence: [], reviewer: null },
    finalApproval: { status: 'pending', evidence: [], approvedBy: null },
    finalSignoff: { status: 'pending', evidence: [] },
    groups,
    entities,
  };
}

function validate(catalog: Catalog): void {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    fail('catalog root is malformed');
  }
  if (
    !Array.isArray(catalog.groups) ||
    !Array.isArray(catalog.entities) ||
    !Array.isArray(catalog.phases)
  ) {
    fail('catalog top-level records are malformed');
  }
  if (catalog.schemaVersion !== 2) fail(`unsupported catalog schema ${catalog.schemaVersion}`);
  const expected = initialize();
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  const validTiers = new Set(['required-pr', 'supported-platform', 'release', 'deferred']);
  const groupStatuses = new Set<GroupStatus>([
    'planned',
    'mapped',
    'ready',
    'active',
    'reviewed',
    'signed-off',
    'failed',
    'blocked',
    'deferred',
  ]);
  const modelStatuses: Record<Entity['stateModel'], Set<string>> = {
    work: new Set([
      'planned',
      'ready',
      'red',
      'green',
      'reviewed',
      'signed-off',
      'failed',
      'blocked',
      'deferred',
    ]),
    validation: new Set([
      'planned',
      'active',
      'passing',
      'failing',
      'skipped-required',
      'signed-off',
      'blocked',
      'deferred',
    ]),
    coverage: new Set(['planned', 'mapped', 'validated', 'signed-off', 'blocked', 'deferred']),
  };
  const gateStatuses = new Set(['pending', 'passed', 'failed', 'blocked']);
  const validationKinds = new Set<Kind>(['phase-test', 'command-test', 'option-gate', 'workflow']);
  const entityIds = new Set<string>();
  const groupIds = new Set<string>();
  const phaseIds = new Set<string>();
  const evidenceResolves = (reference: string): boolean => {
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
  const evidenceSection = (reference: string): string | null => {
    const [path, anchor] = reference.split('#', 2);
    if (!path || !anchor || !existsSync(resolve(root, path))) return null;
    const lines = readFileSync(resolve(root, path), 'utf8').split('\n');
    const slug = (heading: string): string =>
      heading
        .trim()
        .toLowerCase()
        .replace(/[`*_~]/g, '')
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');
    const start = lines.findIndex((line) => {
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      return Boolean(heading && slug(heading[2] ?? '') === anchor.toLowerCase());
    });
    if (start < 0) return null;
    const level = lines[start]?.match(/^(#{1,6})\s/)?.[1]?.length ?? 6;
    const end = lines.findIndex(
      (line, index) => index > start && (line.match(/^(#{1,6})\s/)?.[1]?.length ?? 7) <= level,
    );
    return lines.slice(start, end < 0 ? undefined : end).join('\n');
  };
  const requireEvidence = (owner: string, evidence: string[]): void => {
    if (evidence.length === 0) fail(`${owner} has state without evidence`);
    for (const reference of evidence) {
      if (!evidenceResolves(reference)) fail(`${owner} has unresolved evidence ${reference}`);
    }
  };
  const requireGate = (owner: string, gate: GateRecord, status = 'passed'): void => {
    if (gate.status !== status) fail(`${owner} must be ${status}, found ${gate.status}`);
  };
  const requireStringArray = (owner: string, value: unknown): asserts value is string[] => {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      fail(`${owner} must be an array of strings`);
    }
  };
  const requireKeys = (
    owner: string,
    value: unknown,
    required: string[],
    optional: string[] = [],
  ): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${owner} is malformed`);
    const keys = Object.keys(value).sort();
    const allowed = new Set([...required, ...optional]);
    const missing = required.filter((key) => !keys.includes(key));
    const unknown = keys.filter((key) => !allowed.has(key));
    if (missing.length > 0 || unknown.length > 0) {
      fail(
        `${owner} has malformed keys (missing: ${missing.join(', ') || 'none'}; unknown: ${unknown.join(', ') || 'none'})`,
      );
    }
  };
  const requireUnique = (owner: string, values: string[]): void => {
    if (new Set(values).size !== values.length) fail(`${owner} contains duplicate relations`);
  };
  requireKeys('catalog root', catalog, [
    'schemaVersion',
    'baselineDate',
    'plan',
    'executionMap',
    'counts',
    'phases',
    'finalReview',
    'finalApproval',
    'finalSignoff',
    'groups',
    'entities',
  ]);
  requireKeys('catalog counts', catalog.counts, Object.keys(expectedCounts));
  if (catalog.baselineDate !== '2026-07-11') fail('catalog baseline date drifted');
  if (catalog.plan !== expected.plan || catalog.executionMap !== expected.executionMap) {
    fail('catalog plan/execution-map pointers drifted from the immutable baseline');
  }
  const actualCounts = computeCounts(catalog.entities);
  for (const [kind, count] of Object.entries(expectedCounts)) {
    const key = kind as keyof Catalog['counts'];
    if (catalog.counts[key] !== count || actualCounts[key] !== count) {
      fail(`catalog count ${kind} does not equal immutable baseline ${count}`);
    }
  }

  const expectedGroups = new Map(expected.groups.map((group) => [group.id, group]));
  if (
    !same(
      catalog.groups.map((group) => group.id),
      expected.groups.map((group) => group.id),
    )
  ) {
    fail('catalog groups are missing, extra, duplicate, or out of canonical order');
  }
  const byGroup = new Map(catalog.groups.map((group) => [group.id, group]));
  if (byGroup.size !== expectedGroups.size) fail('catalog group set differs from EXECUTION.md');
  for (const group of catalog.groups) {
    if (!group || typeof group !== 'object' || typeof group.id !== 'string') {
      fail('catalog contains a malformed group record');
    }
    requireKeys(`group ${group.id}`, group, [
      'id',
      'phase',
      'title',
      'dependsOn',
      'status',
      'owner',
      'ownedFiles',
      'integrationOwner',
      'impactedValidations',
      'requiredNowValidations',
      'downstreamCoverage',
      'testCommands',
      'implementers',
      'reviewer',
      'gates',
      'evidence',
    ]);
    for (const [name, value] of [
      ['dependsOn', group.dependsOn],
      ['ownedFiles', group.ownedFiles],
      ['impactedValidations', group.impactedValidations],
      ['requiredNowValidations', group.requiredNowValidations],
      ['downstreamCoverage', group.downstreamCoverage],
      ['testCommands', group.testCommands],
      ['implementers', group.implementers],
      ['evidence', group.evidence],
    ] as const) {
      requireStringArray(`${group.id}.${name}`, value);
      requireUnique(`${group.id}.${name}`, value);
    }
    if (groupIds.has(group.id)) fail(`duplicate group ${group.id}`);
    groupIds.add(group.id);
    const baseline = expectedGroups.get(group.id);
    if (!baseline) fail(`unexpected group ${group.id}`);
    for (const key of [
      'phase',
      'title',
      'dependsOn',
      'owner',
      'impactedValidations',
      'requiredNowValidations',
      'downstreamCoverage',
    ] as const) {
      if (!same(group[key], baseline[key])) fail(`${group.id} immutable ${key} drifted`);
    }
    if (!groupStatuses.has(group.status)) fail(`${group.id} has invalid status ${group.status}`);
    requireKeys(`${group.id}.gates`, group.gates, [...gateNames]);
    for (const gateName of gateNames) {
      const gate = group.gates[gateName];
      requireKeys(`${group.id}:${gateName}`, gate, ['status', 'evidence']);
      if (!gate || !gateStatuses.has(gate.status) || !Array.isArray(gate.evidence)) {
        fail(`${group.id} has malformed gate ${gateName}`);
      }
      if (gate.status !== 'pending') requireEvidence(`${group.id}:${gateName}`, gate.evidence);
      if (
        gate.status !== 'pending' &&
        !gate.evidence.some((reference) => {
          const [path, anchor = ''] = reference.split('#', 2);
          return (
            path?.toLowerCase().includes(group.id.toLowerCase()) ||
            anchor.toLowerCase().includes(group.id.toLowerCase())
          );
        })
      ) {
        fail(`${group.id}:${gateName} evidence is not bound to the group`);
      }
    }
    let priorPassed = true;
    for (const gateName of gateNames) {
      const passed = group.gates[gateName]?.status === 'passed';
      if (passed && !priorPassed) fail(`${group.id}:${gateName} passed before an earlier gate`);
      priorPassed = priorPassed && passed;
    }
    if (group.gates['adversarial-review']?.status === 'pending' && group.reviewer !== null) {
      fail(`${group.id} pending adversarial review must not name a reviewer`);
    }
    const phaseRank = (phase: string): number => {
      const match = phase.match(/^(\d+)([A-Z])?$/);
      if (!match?.[1]) fail(`malformed phase rank ${phase}`);
      return Number(match[1]) * 100 + (match[2]?.charCodeAt(0) ?? 64) - 64;
    };
    for (const dependency of group.dependsOn) {
      if (!byGroup.has(dependency)) fail(`${group.id} depends on missing ${dependency}`);
      const dependencyGroup = byGroup.get(dependency);
      const dependencyIndex = expected.groups.findIndex((item) => item.id === dependency);
      const groupIndex = expected.groups.findIndex((item) => item.id === group.id);
      if (
        !dependencyGroup ||
        phaseRank(dependencyGroup.phase) > phaseRank(group.phase) ||
        (phaseRank(dependencyGroup.phase) === phaseRank(group.phase) &&
          (dependencyIndex < 0 || dependencyIndex >= groupIndex))
      ) {
        fail(`${group.id} depends on future group ${dependency}`);
      }
    }
    for (const validation of group.impactedValidations) {
      if (
        !catalog.entities.some(
          (entity) => entity.id === validation && validationKinds.has(entity.kind),
        )
      ) {
        fail(`${group.id} has invalid impacted validation ${validation}`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) fail(`group dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byGroup.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of groupIds) visit(id);

  const expectedEntities = new Map(expected.entities.map((entity) => [entity.id, entity]));
  if (
    !same(
      catalog.entities.map((entity) => entity.id),
      expected.entities.map((entity) => entity.id),
    )
  ) {
    fail('catalog entities are missing, extra, duplicate, or out of canonical order');
  }
  const byEntity = new Map(catalog.entities.map((entity) => [entity.id, entity]));
  if (byEntity.size !== expectedEntities.size) fail('catalog entity set differs from the plan');
  for (const entity of catalog.entities) {
    if (!entity || typeof entity !== 'object' || typeof entity.id !== 'string') {
      fail('catalog contains a malformed entity record');
    }
    requireKeys(
      `entity ${entity.id}`,
      entity,
      [
        'id',
        'kind',
        'title',
        'stateModel',
        'primaryGroup',
        'secondaryGroups',
        'implements',
        'validatedBy',
        'impactedValidations',
        'affectedContracts',
        'testCommands',
        'ownedFiles',
        'status',
        'tier',
        'plannedTarget',
        'target',
        'evidence',
      ],
      ['designStatus'],
    );
    for (const [name, value] of [
      ['secondaryGroups', entity.secondaryGroups],
      ['implements', entity.implements],
      ['validatedBy', entity.validatedBy],
      ['impactedValidations', entity.impactedValidations],
      ['affectedContracts', entity.affectedContracts],
      ['testCommands', entity.testCommands],
      ['ownedFiles', entity.ownedFiles],
      ['evidence', entity.evidence],
    ] as const) {
      requireStringArray(`${entity.id}.${name}`, value);
      requireUnique(`${entity.id}.${name}`, value);
    }
    if (entityIds.has(entity.id)) fail(`duplicate catalog entity ${entity.id}`);
    entityIds.add(entity.id);
    const baseline = expectedEntities.get(entity.id);
    if (!baseline) fail(`catalog entity not defined by plan: ${entity.id}`);
    if (
      baseline.tier !== 'deferred' &&
      (!Array.isArray(entity.validatedBy) ||
        entity.validatedBy.length === 0 ||
        !Array.isArray(entity.impactedValidations) ||
        entity.impactedValidations.length === 0)
    ) {
      fail(`${entity.id} required entity has no validation mapping`);
    }
    for (const key of [
      'kind',
      'title',
      'stateModel',
      'primaryGroup',
      'tier',
      'plannedTarget',
      'designStatus',
      'implements',
      'validatedBy',
      'secondaryGroups',
      'impactedValidations',
      'affectedContracts',
    ] as const) {
      if (!same(entity[key], baseline[key])) fail(`${entity.id} immutable ${key} drifted`);
    }
    if (!groupIds.has(entity.primaryGroup)) fail(`${entity.id} has missing primary group`);
    for (const secondary of entity.secondaryGroups) {
      if (!groupIds.has(secondary) || secondary === entity.primaryGroup) {
        fail(`${entity.id} has invalid secondary group ${secondary}`);
      }
    }
    if (!modelStatuses[entity.stateModel].has(entity.status)) {
      fail(`${entity.id} has invalid ${entity.stateModel} status ${entity.status}`);
    }
    if (!validTiers.has(entity.tier)) fail(`${entity.id} has invalid tier ${entity.tier}`);
    if (entity.status === 'deferred' && entity.tier !== 'deferred') {
      fail(`${entity.id} is deferred without deferred tier`);
    }
    if (entity.tier === 'deferred' && entity.status !== 'deferred') {
      fail(`${entity.id} deferred tier must retain deferred status`);
    }
    if (entity.tier === 'deferred' && entity.primaryGroup !== 'P17-G7-01') {
      fail(`${entity.id} is deferred outside Phase 7`);
    }
    if (entity.status === 'planned' || entity.status === 'deferred') {
      if (
        entity.target !== null ||
        entity.evidence.length > 0 ||
        entity.ownedFiles.length > 0 ||
        entity.testCommands.length > 0
      ) {
        fail(`${entity.id} ${entity.status} record must remain pristine`);
      }
    }
    for (const id of [...entity.validatedBy, ...entity.impactedValidations]) {
      const related = byEntity.get(id);
      if (!related || !validationKinds.has(related.kind))
        fail(`${entity.id} has invalid validation relation ${id}`);
    }
    for (const id of [...entity.implements, ...entity.affectedContracts]) {
      const related = byEntity.get(id);
      if (!related || related.stateModel !== 'coverage') {
        fail(`${entity.id} has invalid contract relation ${id}`);
      }
    }
    if (entity.stateModel === 'validation') {
      if (typeof entity.plannedTarget !== 'string') {
        fail(`${entity.id} planned target is malformed`);
      }
      const planned = entity.plannedTarget.match(/^planned:(P17-G[^:]+):([^#]+)#(.+)$/);
      const plannedGroup = planned?.[1];
      const plannedPath = planned?.[2];
      const plannedSelector = planned?.[3];
      if (
        plannedGroup !== entity.primaryGroup ||
        plannedSelector !== entity.id ||
        !plannedPath ||
        plannedPath.startsWith('/') ||
        relative(root, resolve(root, plannedPath)).startsWith('..') ||
        !/\.(?:ts|js|mjs|cjs|sh|yml|yaml)$/i.test(plannedPath)
      ) {
        fail(
          `${entity.id} planned target must name its phase group, executable path, and selector`,
        );
      }
    }
    if (entity.status === 'signed-off') {
      requireEvidence(entity.id, entity.evidence);
      if (byGroup.get(entity.primaryGroup)?.gates['traceability-closure']?.status !== 'passed') {
        fail(`${entity.id} signed off before group traceability closure`);
      }
    }
    if (entity.status !== 'planned' && entity.status !== 'deferred') {
      requireEvidence(entity.id, entity.evidence);
    }
    if (
      entity.stateModel === 'validation' &&
      entity.status !== 'planned' &&
      entity.status !== 'deferred'
    ) {
      const target = entity.target;
      if (!target || typeof target !== 'object') {
        fail(`${entity.id} has no executable actual target`);
      }
      requireKeys(`${entity.id} actual target`, target, ['kind', 'path', 'selector', 'command']);
      if (
        typeof target.kind !== 'string' ||
        typeof target.path !== 'string' ||
        typeof target.selector !== 'string' ||
        typeof target.command !== 'string'
      ) {
        fail(`${entity.id} has a malformed executable actual target`);
      }
      if (!['test', 'static', 'workflow', 'distribution'].includes(target.kind)) {
        fail(`${entity.id} has invalid executable target kind`);
      }
      const absoluteTarget = resolve(root, target.path);
      const repositoryRelative = relative(root, absoluteTarget);
      const realTarget = existsSync(absoluteTarget) ? realpathSync(absoluteTarget) : absoluteTarget;
      const realRepositoryRelative = relative(realpathSync(root), realTarget);
      if (
        target.path.startsWith('/') ||
        repositoryRelative.startsWith('..') ||
        realRepositoryRelative.startsWith('..') ||
        !existsSync(absoluteTarget) ||
        !lstatSync(absoluteTarget).isFile() ||
        !statSync(absoluteTarget).isFile() ||
        (!/\.(?:ts|js|mjs|cjs|sh|yml|yaml)$/i.test(target.path) && target.path !== 'justfile')
      ) {
        fail(`${entity.id} has invalid executable target path ${target.path}`);
      }
      const primaryGroup = byGroup.get(entity.primaryGroup);
      if (target.selector !== entity.id || /\s/.test(target.path) || /\s/.test(target.selector)) {
        fail(`${entity.id} target is not bound to its runnable command and selector`);
      }
      if (/[;&|<>\n\r]/.test(target.command)) {
        fail(`${entity.id} target command contains shell control syntax`);
      }
      if (target.kind === 'test' && !target.command.startsWith('bun test ')) {
        fail(`${entity.id} target command is invalid for test`);
      }
      if (
        target.kind === 'test' &&
        target.command !== `bun test ${target.path} --test-name-pattern ${target.selector}`
      ) {
        fail(
          `${entity.id} execution receipt is incomplete or does not match its target; test target command is not the exact runnable selector command`,
        );
      }
      if (target.kind !== 'test') {
        const exactScriptCommand =
          /^scripts\/[A-Za-z0-9._/-]+\.(?:ts|js|mjs|cjs|sh)$/.test(target.path) &&
          target.command === `bun run ${target.path} --check --validation ${target.selector}`;
        const exactWorkflowTest =
          target.kind === 'workflow' &&
          target.command === `bun test ${target.path} --test-name-pattern ${target.selector}`;
        const exactJustRecipe =
          target.path === 'justfile' && target.command === `just -f justfile ${target.selector}`;
        if (!exactScriptCommand && !exactWorkflowTest && !exactJustRecipe) {
          fail(`${entity.id} target command is invalid for ${target.kind}`);
        }
      }
      const targetBody = readFileSync(absoluteTarget, 'utf8');
      const executableBody = targetBody
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      const escapedSelector = entity.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const skippedSelector = new RegExp(
        `(?:test|it|describe)\\s*\\.\\s*(?:skip|todo|skipIf|todoIf)(?:\\([^\\n]*?\\))?\\s*\\([^\\n]*${escapedSelector}`,
      );
      const describeSelector = new RegExp(
        `describe\\s*\\(\\s*['\"\`]${escapedSelector}(?=['\"\`\\s:—-])`,
        'g',
      );
      const testSelector = new RegExp(
        `(?:test|it)\\s*\\(\\s*['\"\`]${escapedSelector}(?=['\"\`\\s:—-])`,
        'g',
      );
      const topLevelTestSelector = new RegExp(
        `^(?:test|it)\\s*\\(\\s*['\"\`]${escapedSelector}(?=['\"\`\\s:—-])`,
        'gm',
      );
      const describeOwners = executableBody.match(describeSelector)?.length ?? 0;
      const testOwners = executableBody.match(testSelector)?.length ?? 0;
      const topLevelTestOwners = executableBody.match(topLevelTestSelector)?.length ?? 0;
      const executableSelectorOwners =
        describeOwners + (describeOwners > 0 ? topLevelTestOwners : testOwners);
      const selectorOccurrences =
        executableBody.match(new RegExp(escapedSelector, 'g'))?.length ?? 0;
      const testDrivenCommand = target.command.startsWith('bun test ');
      const justRecipeExists =
        target.path === 'justfile' &&
        new RegExp(`^${escapedSelector.replace(/-/g, '\\-')}:`, 'm').test(executableBody);
      if (
        !executableBody.includes(target.selector) ||
        (entity.tier !== 'deferred' && skippedSelector.test(executableBody)) ||
        (testDrivenCommand && executableSelectorOwners !== 1) ||
        (!testDrivenCommand && target.path !== 'justfile' && selectorOccurrences !== 1) ||
        (target.kind !== 'test' && target.path === 'justfile' && !justRecipeExists)
      ) {
        fail(`${entity.id} selector does not name an executable target`);
      }
      const receiptReference = entity.evidence.find((reference) =>
        (reference.split('#', 2)[1] ?? '').toLowerCase().includes(entity.id.toLowerCase()),
      );
      const receipt = receiptReference ? evidenceSection(receiptReference) : null;
      if (!receipt) {
        fail(`${entity.id} lacks an execution receipt bound to its target`);
      }
      const ids = receipt.match(/^- Validation ID: `.+`$/gm) ?? [];
      const commands = receipt.match(/^- Command: `.+`$/gm) ?? [];
      const exits = receipt.match(/^- Exit status: `.+`$/gm) ?? [];
      const results = receipt.match(/^- Result: .+$/gm) ?? [];
      const revisions = receipt.match(/^- Revision: `.+`$/gm) ?? [];
      const resultLine = results[0] ?? '';
      const successful = entity.status === 'passing' || entity.status === 'signed-off';
      const honestFailure = entity.status === 'failing';
      const honestSkip = entity.status === 'skipped-required';
      const honestActive = entity.status === 'active';
      const honestBlocked = entity.status === 'blocked';
      if (
        ids.length !== 1 ||
        commands.length !== 1 ||
        exits.length !== 1 ||
        results.length !== 1 ||
        revisions.length !== 1 ||
        ids[0] !== `- Validation ID: \`${entity.id}\`` ||
        commands[0] !== `- Command: \`${target.command}\`` ||
        (successful && exits[0] !== '- Exit status: `0`') ||
        (successful &&
          (!/\bpass(?:ed|es|ing)?\b/i.test(resultLine) ||
            /\b(?:skip(?:ped|s|ping)?|fail(?:ed|s|ing)?|error(?:ed|s|ing)?|todos?|cancel(?:led|ed|s|ing)?)\b/i.test(
              resultLine.replace(/\b0\s+(?:failed|errors?|skipped|todos?|cancelled)\b/gi, ''),
            ))) ||
        (honestFailure &&
          (!/^- Exit status: `[1-9]\d*`$/.test(exits[0] ?? '') ||
            !/\b(?:fail(?:ed|s|ing)?|error(?:ed|s|ing)?)\b/i.test(resultLine))) ||
        (honestSkip &&
          (!/^- Exit status: `[1-9]\d*`$/.test(exits[0] ?? '') || !/\bskip/i.test(resultLine))) ||
        (honestActive &&
          (exits[0] !== '- Exit status: `not-run`' ||
            !/\b(?:active|pending|not[- ]run)\b/i.test(resultLine))) ||
        (honestBlocked &&
          (exits[0] !== '- Exit status: `blocked`' || !/\bblocked\b/i.test(resultLine))) ||
        (!successful && !honestFailure && !honestSkip && !honestActive && !honestBlocked) ||
        !/^- Revision: `(?:working-tree|[0-9a-f]{40})`$/.test(revisions[0] ?? '')
      ) {
        fail(`${entity.id} execution receipt is incomplete or does not match its target`);
      }
      if (
        !primaryGroup?.ownedFiles.includes(target.path) ||
        !entity.ownedFiles.includes(target.path)
      ) {
        fail(`${entity.id} executable target is not owned by both its entity and primary group`);
      }
      if (entity.status === 'signed-off' && !/^- Revision: `[0-9a-f]{40}`$/m.test(receipt)) {
        fail(`${entity.id} signed receipt is not bound to an exact revision`);
      }
      if (entity.status === 'signed-off') {
        const revision = receipt.match(/^- Revision: `([0-9a-f]{40})`$/m)?.[1];
        const commitExists = revision
          ? Bun.spawnSync(['git', 'cat-file', '-e', `${revision}^{commit}`], {
              cwd: root,
              stdout: 'ignore',
              stderr: 'ignore',
            }).exitCode === 0
          : false;
        const targetAtRevision = revision
          ? Bun.spawnSync(['git', 'cat-file', '-e', `${revision}:${target.path}`], {
              cwd: root,
              stdout: 'ignore',
              stderr: 'ignore',
            }).exitCode === 0
          : false;
        if (!commitExists || !targetAtRevision) {
          fail(`${entity.id} signed receipt revision does not contain its executable target`);
        }
        const committedTarget = Bun.spawnSync(['git', 'show', `${revision}:${target.path}`], {
          cwd: root,
          stdout: 'pipe',
          stderr: 'ignore',
        }).stdout.toString();
        const committedExecutableBody = committedTarget
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        const committedDescribeOwners =
          committedExecutableBody.match(describeSelector)?.length ?? 0;
        const committedTestOwners = committedExecutableBody.match(testSelector)?.length ?? 0;
        const committedTopLevelTestOwners =
          committedExecutableBody.match(topLevelTestSelector)?.length ?? 0;
        const committedSelectorOwners =
          committedDescribeOwners +
          (committedDescribeOwners > 0 ? committedTopLevelTestOwners : committedTestOwners);
        if (target.kind === 'test' && committedSelectorOwners !== 1) {
          fail(`${entity.id} signed receipt revision does not contain its executable selector`);
        }
      }
    }
  }

  const expectedPhases = new Map(expected.phases.map((phase) => [phase.id, phase]));
  if (
    !same(
      catalog.phases.map((phase) => phase.id),
      expected.phases.map((phase) => phase.id),
    )
  ) {
    fail('catalog phases are missing, extra, duplicate, or out of canonical order');
  }
  const byPhase = new Map(catalog.phases.map((phase) => [phase.id, phase]));
  if (byPhase.size !== expectedPhases.size) fail('catalog phase set differs from the baseline');
  for (const phase of catalog.phases) {
    if (phaseIds.has(phase.id)) fail(`duplicate phase ${phase.id}`);
    phaseIds.add(phase.id);
    requireKeys(`phase ${phase.id}`, phase, [
      'id',
      'dependsOn',
      'requiredGroups',
      'status',
      'entry',
      'review',
      'approval',
      'exit',
    ]);
    requireStringArray(`phase ${phase.id}.requiredGroups`, phase.requiredGroups);
    requireUnique(`phase ${phase.id}.requiredGroups`, phase.requiredGroups);
    requireKeys(`phase ${phase.id}.entry`, phase.entry, ['status', 'evidence']);
    requireKeys(`phase ${phase.id}.review`, phase.review, ['status', 'evidence', 'reviewer']);
    requireKeys(`phase ${phase.id}.approval`, phase.approval, ['status', 'evidence', 'approvedBy']);
    requireKeys(`phase ${phase.id}.exit`, phase.exit, ['status', 'evidence']);
    for (const [name, gate] of [
      ['entry', phase.entry],
      ['review', phase.review],
      ['approval', phase.approval],
      ['exit', phase.exit],
    ] as const) {
      requireStringArray(`phase ${phase.id}.${name}.evidence`, gate.evidence);
      requireUnique(`phase ${phase.id}.${name}.evidence`, gate.evidence);
    }
    if (phase.review.status === 'pending' && phase.review.reviewer !== null) {
      fail(`phase ${phase.id} pending review must not name a reviewer`);
    }
    if (phase.approval.status === 'pending' && phase.approval.approvedBy !== null) {
      fail(`phase ${phase.id} pending approval must not name an approver`);
    }
    const baseline = expectedPhases.get(phase.id);
    if (
      !baseline ||
      !same(phase.dependsOn, baseline.dependsOn) ||
      !same(phase.requiredGroups, baseline.requiredGroups)
    ) {
      fail(`phase ${phase.id} immutable definition drifted`);
    }
    if (!['planned', 'active', 'approved', 'blocked', 'deferred'].includes(phase.status)) {
      fail(`phase ${phase.id} has invalid status ${phase.status}`);
    }
    if (phase.id === '7' && phase.status !== 'deferred') fail('Phase 7 must remain deferred');
    if (phase.id !== '7' && phase.status === 'deferred')
      fail(`phase ${phase.id} cannot be deferred`);
    for (const gate of [phase.entry, phase.review, phase.approval, phase.exit]) {
      if (!gateStatuses.has(gate.status)) {
        fail(`phase ${phase.id} has malformed or unevidenced gate`);
      }
      if (gate.status !== 'pending') requireEvidence(`phase ${phase.id}`, gate.evidence);
    }
    if (phase.entry.status === 'passed' && phase.dependsOn) {
      const prior = byPhase.get(phase.dependsOn);
      if (prior?.exit.status !== 'passed' || prior.approval.status !== 'passed') {
        fail(`phase ${phase.id} entered before phase ${phase.dependsOn} approval/exit`);
      }
    }
    if (phase.review.status === 'passed') {
      if (phase.entry.status !== 'passed') fail(`phase ${phase.id} reviewed before entry`);
      if (!phase.review.reviewer) fail(`phase ${phase.id} review passed without reviewer`);
      const implementers = phase.requiredGroups.flatMap(
        (groupId) => byGroup.get(groupId)?.implementers ?? [],
      );
      if (implementers.includes(phase.review.reviewer)) {
        fail(`phase ${phase.id} reviewer is not independent`);
      }
      for (const groupId of phase.requiredGroups) {
        if (byGroup.get(groupId)?.status !== 'signed-off')
          fail(`phase ${phase.id} reviewed before ${groupId} sign-off`);
      }
    }
    if (phase.approval.status === 'passed') {
      const standingAuthorization = 'user-standing-authorization-2026-07-12';
      const validApprover = phase.approval.approvedBy === standingAuthorization;
      const standingEvidence = phase.approval.evidence.some(
        (reference) => reference === 'projects/p17/evidence/standing-authorization.md',
      );
      if (phase.review.status !== 'passed' || !validApprover || !standingEvidence) {
        fail(`phase ${phase.id} approval lacks passed review or canonical standing authorization`);
      }
    }
    if (phase.exit.status === 'passed' && phase.approval.status !== 'passed') {
      fail(`phase ${phase.id} exited before approval`);
    }
    const phaseGates = [phase.entry, phase.review, phase.approval, phase.exit];
    if (phase.status === 'planned' && phaseGates.some((gate) => gate.status !== 'pending')) {
      fail(`planned phase ${phase.id} has a non-pending gate`);
    }
    if (phase.status === 'active') {
      requireGate(`phase ${phase.id} entry`, phase.entry);
      if (phaseGates.slice(1).some((gate) => gate.status !== 'pending')) {
        fail(`active phase ${phase.id} has advanced, failed, or blocked closure gates`);
      }
    }
    if (phase.status === 'approved') {
      requireGate(`phase ${phase.id} entry`, phase.entry);
      requireGate(`phase ${phase.id} review`, phase.review);
      requireGate(`phase ${phase.id} approval`, phase.approval);
      requireGate(`phase ${phase.id} exit`, phase.exit);
    }
    if (phase.status === 'blocked') {
      const failureIndex = phaseGates.findIndex(
        (gate) => gate.status === 'blocked' || gate.status === 'failed',
      );
      if (failureIndex < 0) {
        fail(`blocked phase ${phase.id} has no blocked or failed gate`);
      }
      if (
        phaseGates.slice(0, failureIndex).some((gate) => gate.status !== 'passed') ||
        phaseGates.slice(failureIndex + 1).some((gate) => gate.status !== 'pending')
      ) {
        fail(`blocked phase ${phase.id} has incoherent gate order`);
      }
    }
    if (phase.status === 'deferred') {
      for (const gate of [phase.entry, phase.review, phase.approval, phase.exit]) {
        if (gate.status !== 'pending') fail(`deferred phase ${phase.id} has advanced gate`);
      }
    }
  }

  for (const group of catalog.groups) {
    const phaseId = group.phase.startsWith('3')
      ? '3'
      : group.phase.startsWith('4')
        ? '4'
        : group.phase;
    const phase = byPhase.get(phaseId);
    if (!phase) fail(`${group.id} has no phase record`);
    if (group.status === 'planned' || group.status === 'deferred') {
      if (
        group.ownedFiles.length > 0 ||
        group.testCommands.length > 0 ||
        group.implementers.length > 0 ||
        group.evidence.length > 0 ||
        group.integrationOwner !== null ||
        group.reviewer !== null
      ) {
        fail(`${group.id} ${group.status} record must remain pristine`);
      }
    }
    const availableGroups = new Set<string>([group.id]);
    const collectDependencies = (id: string): void => {
      for (const dependency of byGroup.get(id)?.dependsOn ?? []) {
        if (availableGroups.has(dependency)) continue;
        availableGroups.add(dependency);
        collectDependencies(dependency);
      }
    };
    collectDependencies(group.id);
    const partition = [...group.requiredNowValidations, ...group.downstreamCoverage].sort();
    if (!same(partition, [...group.impactedValidations].sort())) {
      fail(`${group.id} required-now/downstream coverage partition is incomplete`);
    }
    for (const validationId of group.requiredNowValidations) {
      const owner = byEntity.get(validationId)?.primaryGroup;
      if (!owner || !availableGroups.has(owner)) {
        fail(`${group.id} required-now validation ${validationId} belongs to a future group`);
      }
    }
    for (const validationId of group.downstreamCoverage) {
      const owner = byEntity.get(validationId)?.primaryGroup;
      if (!owner || availableGroups.has(owner)) {
        fail(`${group.id} downstream validation ${validationId} is not downstream`);
      }
    }
    if (group.status !== 'planned' && group.status !== 'deferred') {
      if (phase.entry.status !== 'passed')
        fail(`${group.id} advanced before phase ${phaseId} entry`);
      for (const dependency of group.dependsOn) {
        if (byGroup.get(dependency)?.status !== 'signed-off')
          fail(`${group.id} advanced before ${dependency}`);
      }
    }
    const lifecycle = gateNames.map((name) => group.gates[name]?.status ?? 'missing');
    const requireExactProgress = (passed: number): void => {
      if (
        lifecycle.slice(0, passed).some((status) => status !== 'passed') ||
        lifecycle.slice(passed).some((status) => status !== 'pending')
      ) {
        fail(`${group.id} status ${group.status} has incoherent lifecycle gates`);
      }
    };
    if (group.status === 'planned') requireExactProgress(0);
    if (group.status === 'mapped') requireExactProgress(1);
    if (['ready', 'active', 'reviewed', 'signed-off'].includes(group.status)) {
      if (
        group.ownedFiles.length === 0 ||
        group.testCommands.length === 0 ||
        group.implementers.length === 0
      ) {
        fail(`${group.id} is ${group.status} without owned files, test commands, and implementers`);
      }
    }
    if (group.status === 'ready') requireExactProgress(2);
    if (group.status === 'active') {
      const firstPending = lifecycle.indexOf('pending');
      const progress = firstPending < 0 ? lifecycle.length : firstPending;
      if (
        progress < 2 ||
        progress > 7 ||
        lifecycle.slice(0, progress).some((status) => status !== 'passed') ||
        lifecycle.slice(progress).some((status) => status !== 'pending')
      ) {
        fail(`${group.id} active status has incoherent lifecycle gates`);
      }
    }
    if (group.status === 'reviewed') requireExactProgress(8);
    if (group.status === 'deferred') {
      if (group.phase !== '7') fail(`${group.id} has invalid deferred state`);
      requireExactProgress(0);
    }
    if (group.status === 'failed' || group.status === 'blocked') {
      const expectedFailure = group.status === 'failed' ? 'failed' : 'blocked';
      const failureIndex = lifecycle.indexOf(expectedFailure);
      if (failureIndex < 0) {
        fail(`${group.id} is ${group.status} without a ${expectedFailure} gate`);
      }
      if (
        lifecycle.slice(0, failureIndex).some((status) => status !== 'passed') ||
        lifecycle.slice(failureIndex + 1).some((status) => status !== 'pending')
      ) {
        fail(`${group.id} ${group.status} status has incoherent lifecycle gates`);
      }
    }
    if (group.gates['adversarial-review']?.status === 'passed') {
      if (!group.reviewer || group.implementers.includes(group.reviewer)) {
        fail(`${group.id} adversarial review lacks an independent reviewer`);
      }
    }
    if (group.status === 'signed-off') {
      requireExactProgress(gateNames.length);
      for (const gateName of gateNames) {
        if (group.gates[gateName]?.status !== 'passed')
          fail(`${group.id} signed off before ${gateName}`);
      }
      const owned = catalog.entities.filter((entity) => entity.primaryGroup === group.id);
      for (const entity of owned) {
        if (!['signed-off', 'deferred'].includes(entity.status))
          fail(`${group.id} signed off before ${entity.id}`);
      }
    }
    if (group.gates['impacted-green']?.status === 'passed') {
      for (const validationId of group.requiredNowValidations) {
        const validation = byEntity.get(validationId);
        if (!validation || !['passing', 'signed-off'].includes(validation.status)) {
          fail(`${group.id} impacted-green passed before ${validationId} passed`);
        }
      }
    }
  }

  const entityGate: Record<string, (typeof gateNames)[number]> = {
    ready: 'ready',
    red: 'test-first',
    green: 'targeted-green',
    reviewed: 'adversarial-review',
    active: 'test-first',
    failing: 'test-first',
    passing: 'targeted-green',
    'skipped-required': 'test-first',
    mapped: 'mapped',
    validated: 'impacted-green',
    'signed-off': 'traceability-closure',
  };
  for (const entity of catalog.entities) {
    if (entity.status === 'planned' || entity.status === 'deferred') continue;
    const group = byGroup.get(entity.primaryGroup);
    if (!group) fail(`${entity.id} has no group state`);
    const phaseId = group.phase.startsWith('3')
      ? '3'
      : group.phase.startsWith('4')
        ? '4'
        : group.phase;
    if (byPhase.get(phaseId)?.entry.status !== 'passed') {
      fail(`${entity.id} advanced before phase ${phaseId} entry`);
    }
    for (const dependency of group.dependsOn) {
      if (byGroup.get(dependency)?.status !== 'signed-off') {
        fail(`${entity.id} advanced before group dependency ${dependency}`);
      }
    }
    if (entity.status === 'failed' || entity.status === 'blocked') {
      if (group.status !== entity.status) {
        fail(
          `${entity.id} ${entity.status} state disagrees with ${group.id} status ${group.status}`,
        );
      }
      if (!gateNames.some((name) => group.gates[name]?.status === entity.status)) {
        fail(`${entity.id} ${entity.status} state lacks a matching group gate`);
      }
      continue;
    }
    if (entity.status === 'skipped-required') {
      if (
        group.status !== 'failed' ||
        !gateNames.some((name) => group.gates[name]?.status === 'failed')
      ) {
        fail(`${entity.id} skipped-required state must fail its group`);
      }
      continue;
    }
    const requiredGate = entityGate[entity.status];
    if (!requiredGate || group.gates[requiredGate]?.status !== 'passed') {
      fail(
        `${entity.id} status ${entity.status} is ahead of ${group.id}:${requiredGate ?? 'unknown'}`,
      );
    }
  }

  for (const [name, gate] of [
    ['final review', catalog.finalReview],
    ['final approval', catalog.finalApproval],
    ['final sign-off', catalog.finalSignoff],
  ] as const) {
    requireKeys(
      name,
      gate,
      name === 'final review'
        ? ['status', 'evidence', 'reviewer']
        : name === 'final approval'
          ? ['status', 'evidence', 'approvedBy']
          : ['status', 'evidence'],
    );
    requireStringArray(`${name}.evidence`, gate.evidence);
    requireUnique(`${name}.evidence`, gate.evidence);
    if (!gateStatuses.has(gate.status)) fail(`${name} has invalid status ${gate.status}`);
    if (gate.status !== 'pending') requireEvidence(name, gate.evidence);
  }
  if (catalog.finalReview.status === 'pending' && catalog.finalReview.reviewer !== null) {
    fail('pending final review must not name a reviewer');
  }
  if (catalog.finalApproval.status === 'pending' && catalog.finalApproval.approvedBy !== null) {
    fail('pending final approval must not name an approver');
  }
  if (catalog.finalReview.status === 'passed') {
    if (!catalog.finalReview.reviewer) fail('final review passed without reviewer');
    const implementers = catalog.groups.flatMap((group) => group.implementers);
    if (implementers.includes(catalog.finalReview.reviewer))
      fail('final reviewer is not independent');
    for (const entity of catalog.entities) {
      if (entity.tier !== 'deferred' && entity.status !== 'signed-off') {
        fail(`final review passed before ${entity.id} sign-off`);
      }
    }
    for (const group of catalog.groups) {
      if (group.phase !== '7' && group.status !== 'signed-off') {
        fail(`final review passed before ${group.id} sign-off`);
      }
    }
    for (const phase of catalog.phases.filter((item) => item.id !== '7')) {
      if (
        phase.status !== 'approved' ||
        phase.review.status !== 'passed' ||
        phase.approval.status !== 'passed' ||
        phase.exit.status !== 'passed'
      ) {
        fail(`final review passed before phase ${phase.id} closure`);
      }
    }
  }
  if (catalog.finalApproval.status === 'passed') {
    const standingAuthorization = 'user-standing-authorization-2026-07-12';
    const validApprover = catalog.finalApproval.approvedBy === standingAuthorization;
    const standingEvidence = catalog.finalApproval.evidence.some(
      (reference) => reference === 'projects/p17/evidence/standing-authorization.md',
    );
    if (catalog.finalReview.status !== 'passed' || !validApprover || !standingEvidence) {
      fail('final approval lacks passed review or canonical standing authorization');
    }
  }
  if (catalog.finalReview.status === 'failed' || catalog.finalReview.status === 'blocked') {
    if (catalog.finalApproval.status === 'passed' || catalog.finalSignoff.status === 'passed') {
      fail('final gates advanced after failed or blocked final review');
    }
  }
  if (catalog.finalApproval.status === 'failed' || catalog.finalApproval.status === 'blocked') {
    if (catalog.finalSignoff.status === 'passed') {
      fail('final sign-off advanced after failed or blocked final approval');
    }
  }
  if (catalog.finalSignoff.status === 'passed') {
    if (catalog.finalApproval.status !== 'passed')
      fail('final sign-off passed before final approval');
    if (
      !catalog.finalSignoff.evidence.some((reference) =>
        /^projects\/p17\/evidence\/.*p14-handoff.*\.md(?:#.*)?$/i.test(reference),
      )
    ) {
      fail('final sign-off lacks explicit P14 handoff evidence');
    }
  }
}

function render(catalog: Catalog): string {
  const checked = (value: boolean) => (value ? 'x' : ' ');
  const lines = [
    '# P17 generated execution checklist',
    '',
    '> Generated from `projects/p17/catalog.json` by `bun scripts/p17-catalog.ts --write`.',
    '> Do not edit this file by hand.',
    '',
    `Tracked entities: **${catalog.counts.total}** across **${catalog.groups.length}** change groups.`,
    '',
  ];
  lines.push(
    '## Rollups',
    '',
    '### Entity kinds',
    '',
    '| Kind | Total | Signed off | Active/open | Deferred |',
    '|---|---:|---:|---:|---:|',
  );
  const kinds = Object.keys(expectedCounts).filter((kind) => kind !== 'total') as Kind[];
  for (const kind of kinds) {
    const items = catalog.entities.filter((entity) => entity.kind === kind);
    const signed = items.filter((entity) => entity.status === 'signed-off').length;
    const deferred = items.filter((entity) => entity.status === 'deferred').length;
    lines.push(
      `| ${kind} | ${items.length} | ${signed} | ${items.length - signed - deferred} | ${deferred} |`,
    );
  }
  lines.push(
    '',
    '### Phases',
    '',
    '| Phase | Groups | Entities | Signed off | Deferred |',
    '|---|---:|---:|---:|---:|',
  );
  for (const phase of catalog.phases) {
    const phaseGroups = phase.requiredGroups
      .map((id) => catalog.groups.find((group) => group.id === id))
      .filter((group): group is Group => Boolean(group));
    const ids = new Set(phaseGroups.map((group) => group.id));
    const items = catalog.entities.filter((entity) => ids.has(entity.primaryGroup));
    lines.push(
      `| ${phase.id} | ${phaseGroups.length} | ${items.length} | ${items.filter((entity) => entity.status === 'signed-off').length} | ${items.filter((entity) => entity.status === 'deferred').length} |`,
    );
  }
  lines.push('', '### Phase gates', '');
  for (const phase of catalog.phases) {
    lines.push(`#### Phase ${phase.id}`, '');
    for (const [name, gate] of [
      ['entry', phase.entry],
      ['review', phase.review],
      ['approval', phase.approval],
      ['exit', phase.exit],
    ] as const) {
      lines.push(
        `- [${checked(gate.status === 'passed')}] Phase ${phase.id}:${name} _(${gate.status})_`,
      );
    }
    lines.push('');
  }
  lines.push('### Final gates', '');
  for (const [name, gate] of [
    ['review', catalog.finalReview],
    ['approval', catalog.finalApproval],
    ['sign-off', catalog.finalSignoff],
  ] as const) {
    lines.push(`- [${checked(gate.status === 'passed')}] final:${name} _(${gate.status})_`);
  }
  lines.push('', '### Coverage indexes', '');
  for (const kind of [
    'command',
    'recommendation',
    'finding',
    'decision',
    'option-gate',
    'workflow',
  ] as Kind[]) {
    lines.push(`#### ${kind}`, '', '| ID | Primary group | Status | Tier |', '|---|---|---|---|');
    for (const entity of catalog.entities.filter((item) => item.kind === kind)) {
      lines.push(`| ${entity.id} | ${entity.primaryGroup} | ${entity.status} | ${entity.tier} |`);
    }
    lines.push('');
  }
  const entitiesByGroup = new Map<string, Entity[]>();
  for (const entity of catalog.entities) {
    const current = entitiesByGroup.get(entity.primaryGroup) ?? [];
    current.push(entity);
    entitiesByGroup.set(entity.primaryGroup, current);
  }
  for (const group of catalog.groups) {
    lines.push(`## ${group.id} — ${group.title}`, '');
    lines.push(
      `Phase: ${group.phase}; status: **${group.status}**; dependencies: ${group.dependsOn.join(', ') || 'none'}.`,
      `Required-now validations: ${group.requiredNowValidations.join(', ') || 'none'}.`,
      `Downstream coverage obligations: ${group.downstreamCoverage.join(', ') || 'none'}.`,
      '',
    );
    lines.push('### Group gates', '');
    for (const gate of gateNames) {
      const state = group.gates[gate]?.status ?? 'pending';
      lines.push(`- [${checked(state === 'passed')}] ${group.id}:${gate} _(${state})_`);
    }
    lines.push('', '### Tracked entities', '');
    for (const entity of entitiesByGroup.get(group.id) ?? []) {
      const done = entity.status === 'signed-off';
      const suffix =
        entity.status === 'deferred'
          ? ' _(deferred; outside P17 completion)_'
          : ` _(${entity.kind}; ${entity.status})_`;
      lines.push(`- [${checked(done)}] **${entity.id}** — ${entity.title}${suffix}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

const mode = Bun.argv[2] ?? '--check';
if (mode === '--init' || mode === '--reset-baseline') {
  const exists = await Bun.file(catalogPath).exists();
  if (mode === '--init' && exists)
    fail('catalog already exists; edit it in place and use --write/--check');
  if (mode === '--reset-baseline') {
    if (!exists) fail('cannot reset a missing catalog; use --init');
    const old = JSON.parse(readFileSync(catalogPath, 'utf8')) as Partial<Catalog>;
    const gateIsBaseline = (gate: Partial<GateRecord> | undefined): boolean =>
      gate?.status === 'pending' && (gate.evidence?.length ?? 0) === 0;
    const progressedGroup = (old.groups ?? []).some(
      (group) =>
        !['planned', 'deferred'].includes(group.status) ||
        group.evidence.length > 0 ||
        group.ownedFiles.length > 0 ||
        group.testCommands.length > 0 ||
        group.implementers.length > 0 ||
        group.integrationOwner !== null ||
        group.reviewer !== null ||
        gateNames.some((name) => !gateIsBaseline(group.gates[name])),
    );
    const progressedEntity = (old.entities ?? []).some(
      (entity) =>
        !['planned', 'deferred'].includes(entity.status) ||
        entity.evidence.length > 0 ||
        entity.target !== null ||
        entity.ownedFiles.length > 0 ||
        entity.testCommands.length > 0,
    );
    const progressedPhase = (old.phases ?? []).some(
      (phase) =>
        !['planned', 'deferred'].includes(phase.status) ||
        !gateIsBaseline(phase.entry) ||
        !gateIsBaseline(phase.review) ||
        !gateIsBaseline(phase.approval) ||
        !gateIsBaseline(phase.exit) ||
        phase.review.reviewer !== null ||
        phase.approval.approvedBy !== null,
    );
    const progressedFinal = [old.finalReview, old.finalApproval, old.finalSignoff].some(
      (gate) => gate && !gateIsBaseline(gate),
    );
    if (progressedGroup || progressedEntity || progressedPhase || progressedFinal) {
      fail('--reset-baseline refuses after any execution state exists');
    }
  }
  const catalog = initialize();
  validate(catalog);
  await Bun.write(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  const formatResult = Bun.spawnSync(['bunx', 'biome', 'format', '--write', catalogPath], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (formatResult.exitCode !== 0) {
    fail(`could not format generated catalog\n${formatResult.stderr.toString()}`);
  }
  await Bun.write(checklistPath, render(catalog));
  console.log(
    `${mode === '--init' ? 'initialized' : 'reset'} ${catalog.counts.total} entities across ${catalog.groups.length} groups`,
  );
} else {
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as Catalog;
  if (mode === '--sync-planned-targets') {
    const expected = initialize();
    if (
      catalog.entities.length !== expected.entities.length ||
      catalog.entities.some(
        (entity, index) =>
          entity.id !== expected.entities[index]?.id ||
          entity.kind !== expected.entities[index]?.kind,
      )
    ) {
      fail('--sync-planned-targets refuses an entity ID, kind, cardinality, or order mismatch');
    }
    const expectedById = new Map(expected.entities.map((entity) => [entity.id, entity]));
    const permittedResult = structuredClone(catalog);
    for (const entity of permittedResult.entities) {
      if (entity.stateModel !== 'validation') continue;
      const plannedTarget = expectedById.get(entity.id)?.plannedTarget;
      if (!plannedTarget) fail(`--sync-planned-targets has no baseline target for ${entity.id}`);
      entity.plannedTarget = plannedTarget;
    }
    for (const entity of catalog.entities) {
      if (entity.stateModel !== 'validation') continue;
      entity.plannedTarget = expectedById.get(entity.id)?.plannedTarget ?? entity.plannedTarget;
    }
    if (JSON.stringify(catalog) !== JSON.stringify(permittedResult)) {
      fail('--sync-planned-targets attempted to change execution state');
    }
    validate(catalog);
    await Bun.write(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
    const formatResult = Bun.spawnSync(['bunx', 'biome', 'format', '--write', catalogPath], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (formatResult.exitCode !== 0) {
      fail(`could not format synchronized catalog\n${formatResult.stderr.toString()}`);
    }
    console.log(
      `synchronized ${catalog.entities.filter((entity) => entity.stateModel === 'validation').length} planned validation targets; run bun scripts/p17-catalog.ts --write`,
    );
    process.exit(0);
  }
  validate(catalog);
  const rendered = render(catalog);
  if (mode === '--write') {
    await Bun.write(checklistPath, rendered);
    console.log(`rendered ${catalog.counts.total} entities across ${catalog.groups.length} groups`);
  } else if (mode === '--check') {
    const current = readFileSync(checklistPath, 'utf8');
    if (current !== rendered) fail('CHECKLIST.md is stale; run bun scripts/p17-catalog.ts --write');
    const required = catalog.entities.filter((entity) => entity.tier !== 'deferred').length;
    const deferred = catalog.entities.length - required;
    const validations = catalog.entities.filter(
      (entity) => entity.stateModel === 'validation',
    ).length;
    console.log(
      `valid: ${catalog.counts.total} entities (${required} required, ${deferred} deferred; ${validations} validation obligations), ${catalog.groups.length} groups, deterministic checklist`,
    );
  } else {
    fail(
      `unknown mode ${mode}; use --init, --reset-baseline, --sync-planned-targets, --write, or --check`,
    );
  }
}
