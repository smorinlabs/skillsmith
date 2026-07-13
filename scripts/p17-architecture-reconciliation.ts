#!/usr/bin/env bun

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ARTIFACT_PATH = new URL(
  '../projects/p17/reviews/P17-G0-03-reconciliation.json',
  import.meta.url,
);
const ROOT = resolve(import.meta.dir, '..');
const CATALOG_PATH = resolve(ROOT, 'projects/p17/catalog.json');
const PLAN_PATH = 'docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md';

type JsonObject = Record<string, unknown>;

type ArtifactContract = {
  file: string;
  responsibility: string;
  portable: boolean | 'conditional';
  commitPolicy: string;
  writerAuthority: string;
  owns: string[];
  forbids: string[];
};

const ARTIFACTS: Record<string, ArtifactContract> = {
  manifest: {
    file: 'skillsmith.toml',
    responsibility: 'portable-desired-state-and-project-defaults',
    portable: true,
    commitPolicy: 'commit-for-projects',
    writerAuthority: 'lossless-manifest-writer',
    owns: ['desired-state', 'project-defaults'],
    forbids: [
      'portable-resolution',
      'reviewed-operations',
      'local-placement-state',
      'machine-local-config-defaults',
    ],
  },
  lock: {
    file: 'skillsmith.lock',
    responsibility: 'portable-exact-resolution-and-content-identity',
    portable: true,
    commitPolicy: 'commit-for-projects',
    writerAuthority: 'canonical-lock-writer',
    owns: ['portable-resolution', 'source-paths', 'content-hashes'],
    forbids: ['desired-state', 'project-defaults', 'reviewed-operations', 'local-placement-state'],
  },
  plan: {
    file: 'skillsmith.plan',
    responsibility: 'reviewed-operations-and-state-preconditions',
    portable: 'conditional',
    commitPolicy: 'never',
    writerAuthority: 'saved-plan-writer',
    owns: ['reviewed-operations', 'state-preconditions'],
    forbids: ['desired-state', 'project-defaults', 'portable-resolution', 'local-placement-state'],
  },
  ledger: {
    file: 'placements.json',
    responsibility: 'machine-local-placement-and-recovery-state',
    portable: false,
    commitPolicy: 'never',
    writerAuthority: 'transaction-ledger-writer',
    owns: ['local-placement-state', 'store-paths', 'dev-paths', 'recovery-journals'],
    forbids: ['desired-state', 'project-defaults', 'portable-resolution', 'reviewed-operations'],
  },
};

const ARTIFACT_IDS = ['manifest', 'lock', 'plan', 'ledger'];
const PHASE_IDS = ['phase-2', 'phase-3a', 'phase-3b', 'phase-4a', 'phase-4b'];
const PHASE_NAMES = [
  'portable-artifact-foundation',
  'correlated-inspection',
  'shared-planning-and-transaction-primitives',
  'desired-state-lifecycle-integration',
  'declarative-plan-and-apply',
];
const FACTOR_BUCKETS = [
  'good-precedent',
  'following-bad-precedent',
  'broken-precedent',
  'new-pattern-introduced',
];
const QUALITY_AXES = [
  'contradictions',
  'duplicate-semantics',
  'unreachable-states',
  'unclear-defaults',
  'command-count-excess',
];
const CF001_CONTRACTS = [
  'Section 10 Phase 2 -> 3A -> 3B -> 4A -> 4B',
  'EWP-P2-TS01..05',
  'EWP-P3B-TS01..03',
  'EWP-P4A-TS01..03',
  'EWP-P4B-TS01..06',
  'EWP-WF03',
  'EWP-WF13',
];
const pointer = (anchor: string): JsonObject => ({ path: PLAN_PATH, anchor });
const FACTORS: Record<string, JsonObject> = {
  'good-precedent': {
    action: 'retain',
    facts: ['pure-planning', 'preview-before-mutation'],
    evidencePointers: [pointer('9-shared-application-and-planning-architecture')],
  },
  'following-bad-precedent': {
    action: 'replace-before-extension',
    facts: ['command-specific-planning', 'command-specific-transactions'],
    evidencePointers: [
      pointer(
        'ewp-cf-001-correct-phase-dependencies-before-extending-command-specific-orchestration',
      ),
    ],
  },
  'broken-precedent': {
    action: 'repair-single-migration-authority',
    facts: ['legacy-config-manifest-name-collision', 'single-phase-2-migration'],
    evidencePointers: [
      pointer('ewp-cf-029-define-the-legacy-project-config-to-manifest-transition'),
    ],
  },
  'new-pattern-introduced': {
    action: 'introduce-separated-portability-boundary',
    facts: ['portable-manifest-lock', 'conditionally-portable-plan', 'local-ledger'],
    evidencePointers: [pointer('2-canonical-state-and-artifact-model')],
  },
};
const QUALITY: Record<string, JsonObject> = {
  contradictions: {
    result: 'artifact-and-phase-authorities-consistent',
    facts: ['four-exclusive-artifact-roles', 'ordered-phase-prerequisites'],
    evidencePointers: [pointer('2-canonical-state-and-artifact-model')],
  },
  'duplicate-semantics': {
    result: 'state-concepts-have-distinct-owners',
    facts: ['config-not-manifest', 'manifest-not-lock', 'plan-not-ledger'],
    evidencePointers: [pointer('133-artifact-consistency')],
  },
  'unreachable-states': {
    result: 'every-phase-consumes-completed-prerequisites',
    facts: [
      'phase-2-before-phase-3a',
      'phase-3a-before-phase-3b',
      'phase-3b-before-phase-4a',
      'phase-4a-before-phase-4b',
    ],
    evidencePointers: [pointer('10-named-implementation-phases-and-slices')],
  },
  'unclear-defaults': {
    result: 'artifact-policy-is-explicit',
    facts: [
      'portability-explicit',
      'commit-policy-explicit',
      'writer-authority-explicit',
      'forbidden-content-explicit',
    ],
    evidencePointers: [pointer('2-canonical-state-and-artifact-model')],
  },
  'command-count-excess': {
    result: 'no-command-introduced',
    facts: ['existing-command-boundary-retained', 'independent-discoverability-required'],
    evidencePointers: [pointer('132-cross-command-consistency')],
  },
};
const DRIFT: Record<string, JsonObject> = {
  'P17-G0-03-D01': {
    classification: 'broken-precedent',
    disposition: 'classified-downstream',
    subject: 'core-no-io-side-effects-wording',
    target:
      'core-domain-logic-uses-injected-capability-ports-with-no-direct-cli-output-or-process-policy',
    downstreamOwner: 'P17-G0-04',
    evidencePointers: [
      { path: 'CLAUDE.md', line: 7, contains: 'No CLI deps, no I/O side effects.' },
    ],
  },
  'P17-G0-03-D02': {
    classification: 'broken-precedent',
    disposition: 'classified-downstream',
    subject: 'architecture-no-io-side-effects-wording',
    target:
      'core-domain-logic-uses-injected-capability-ports-with-no-direct-cli-output-or-process-policy',
    downstreamOwner: 'P17-G0-04',
    evidencePointers: [{ path: 'docs/architecture.md', line: 46, contains: 'no I/O side effects' }],
  },
  'EWP-CF-033': {
    classification: 'following-bad-precedent',
    disposition: 'accepted-architecture-contract',
    subject: 'command-local-application-runtime',
    target: 'application-service-boundary',
    downstreamOwner: 'P17-G1-03',
    evidencePointers: [
      pointer('ewp-cf-033-add-an-application-service-boundary-behind-every-cli-command'),
    ],
  },
  'EWP-CF-034': {
    classification: 'following-bad-precedent',
    disposition: 'accepted-architecture-contract',
    subject: 'overbroad-scan-environment',
    target: 'capability-scoped-ports',
    downstreamOwner: 'P17-G1-04',
    evidencePointers: [
      pointer('ewp-cf-034-replace-the-growing-scanenv-interface-with-capability-scoped-ports'),
    ],
  },
  'EWP-CF-035': {
    classification: 'following-bad-precedent',
    disposition: 'accepted-architecture-contract',
    subject: 'mutable-state-and-monolithic-runners',
    target: 'immutable-snapshots-pure-planners-and-domain-repositories',
    downstreamOwner: 'P17-G3B-04',
    evidencePointers: [
      pointer('ewp-cf-035-separate-immutable-state-snapshots-pure-planning-and-repository-writes'),
    ],
  },
  'EWP-CF-036': {
    classification: 'broken-precedent',
    disposition: 'accepted-architecture-contract',
    subject: 'duplicated-tool-capability-policy',
    target: 'adapter-registry-capability-authority',
    downstreamOwner: 'P17-G1-05',
    evidencePointers: [
      pointer('ewp-cf-036-make-the-tool-adapter-registry-the-executable-capability-authority'),
    ],
  },
  'EWP-CF-037': {
    classification: 'following-bad-precedent',
    disposition: 'accepted-architecture-contract',
    subject: 'duplicated-wire-shapes',
    target: 'versioned-codec-authority',
    downstreamOwner: 'P17-G1-06',
    evidencePointers: [pointer('ewp-cf-037-make-codecs-the-canonical-wire-contract-authority')],
  },
  'EWP-CF-038': {
    classification: 'following-bad-precedent',
    disposition: 'accepted-architecture-contract',
    subject: 'uncorrelated-free-form-observation',
    target: 'typed-operation-scoped-observability',
    downstreamOwner: 'P17-G1-07',
    evidencePointers: [pointer('ewp-cf-038-add-operation-scoped-structured-observability')],
  },
  'EWP-CF-039': {
    classification: 'broken-precedent',
    disposition: 'accepted-architecture-contract',
    subject: 'prose-only-validation-ownership',
    target: 'executable-release-blocking-validation-catalog',
    downstreamOwner: 'P17-G0-05',
    evidencePointers: [
      pointer('ewp-cf-039-make-every-planned-validation-executable-and-release-blocking'),
    ],
  },
};

const TOP_LEVEL_FIELDS = [
  'schemaVersion',
  'kind',
  'groupId',
  'artifacts',
  'dependencyOrder',
  'factorReview',
  'qualityScan',
  'architectureDrift',
  'cf001',
];
const ARTIFACT_FIELDS = [
  'id',
  'file',
  'responsibility',
  'portable',
  'commitPolicy',
  'writerAuthority',
  'owns',
  'forbids',
];
const PHASE_FIELDS = ['id', 'name', 'dependsOn'];
const FACTOR_FIELDS = ['bucket', 'disposition', 'action', 'facts', 'evidencePointers'];
const REVIEW_FIELDS = ['id', 'axis', 'disposition', 'result', 'facts', 'evidencePointers'];
const DRIFT_FIELDS = [
  'id',
  'classification',
  'disposition',
  'subject',
  'target',
  'downstreamOwner',
  'evidencePointers',
];
const CF001_FIELDS = ['findingId', 'contractLinks', 'downstreamValidations'];

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const objects = (value: unknown): JsonObject[] =>
  Array.isArray(value) ? value.filter(isObject) : [];

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const equalArray = (actual: unknown, expected: readonly string[]): boolean =>
  Array.isArray(actual) &&
  actual.length === expected.length &&
  actual.every((value, index) => value === expected[index]);

const exactIds = (rows: JsonObject[], key: string, expected: readonly string[]): boolean =>
  equalArray(
    rows.map((row) => row[key]),
    expected,
  );

const equalValue = (actual: unknown, expected: unknown): boolean =>
  JSON.stringify(actual) === JSON.stringify(expected);

const validateFields = (
  value: JsonObject,
  expected: readonly string[],
  label: string,
  diagnostics: string[],
): void => {
  if (!equalArray(Object.keys(value), expected)) {
    diagnostics.push(`${label} fields must equal: ${expected.join(', ')}`);
  }
};

const reportDuplicates = (
  values: unknown[],
  label: (value: string) => string,
  diagnostics: string[],
): void => {
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    if (seen.has(value)) diagnostics.push(label(value));
    seen.add(value);
  }
};

type ValidationOptions = {
  catalog?: unknown;
  evidenceFiles?: Record<string, string>;
};

let cachedCatalog: unknown;
const defaultCatalog = (): unknown => {
  cachedCatalog ??= JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
  return cachedCatalog;
};

const markdownAnchors = (content: string): Set<string> => {
  const anchors = new Set<string>();
  for (const match of content.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    anchors.add(
      match[1]
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .trim()
        .replace(/\s+/g, '-'),
    );
  }
  return anchors;
};

const verifyPointers = (
  pointers: unknown,
  label: string,
  options: ValidationOptions,
  diagnostics: string[],
): void => {
  for (const evidence of objects(pointers)) {
    const path = typeof evidence.path === 'string' ? evidence.path : '';
    let content: string;
    try {
      content = options.evidenceFiles?.[path] ?? readFileSync(resolve(ROOT, path), 'utf8');
    } catch {
      diagnostics.push(`${label} evidence path ${path || '<missing>'} is unreadable`);
      continue;
    }
    if (typeof evidence.anchor === 'string' && !markdownAnchors(content).has(evidence.anchor)) {
      diagnostics.push(`${label} evidence anchor ${path}#${evidence.anchor} does not exist`);
    }
    if (typeof evidence.line === 'number') {
      const line = content.split(/\r?\n/)[evidence.line - 1] ?? '';
      if (typeof evidence.contains !== 'string' || !line.includes(evidence.contains)) {
        diagnostics.push(
          `${label} evidence ${path}:${evidence.line} does not contain ${String(evidence.contains)}`,
        );
      }
    }
  }
};

const catalogDownstream = (catalog: unknown): unknown => {
  if (!isObject(catalog)) return undefined;
  return objects(catalog.groups).find((group) => group.id === 'P17-G0-03')?.downstreamCoverage;
};

export const validateArchitectureReconciliation = (
  value: unknown,
  options: ValidationOptions = {},
): string[] => {
  const diagnostics: string[] = [];
  if (!isObject(value)) return ['reconciliation must be a JSON object'];

  validateFields(value, TOP_LEVEL_FIELDS, 'reconciliation', diagnostics);

  if (value.schemaVersion !== 1) diagnostics.push('schemaVersion must be 1');
  if (value.kind !== 'skillsmith.p17.architecture-reconciliation') {
    diagnostics.push('kind must be skillsmith.p17.architecture-reconciliation');
  }
  if (value.groupId !== 'P17-G0-03') diagnostics.push('groupId must be P17-G0-03');

  const artifactRows = objects(value.artifacts);
  reportDuplicates(
    artifactRows.map((row) => row.id),
    (id) => `artifact ID ${id} is duplicated`,
    diagnostics,
  );
  if (!exactIds(artifactRows, 'id', ARTIFACT_IDS)) {
    diagnostics.push(`artifacts must contain the exact artifact IDs: ${ARTIFACT_IDS.join(', ')}`);
  }

  const ownership = new Map<string, string>();
  const authorities = new Map<string, string>();
  for (const row of artifactRows) {
    const id = typeof row.id === 'string' ? row.id : '<invalid>';
    validateFields(row, ARTIFACT_FIELDS, `artifact ${id}`, diagnostics);
    const contract = ARTIFACTS[id];
    if (!contract) continue;
    if (row.file !== contract.file)
      diagnostics.push(`artifact ${id} must use file ${contract.file}`);
    if (row.portable !== contract.portable)
      diagnostics.push(`artifact ${id} portable value is incorrect`);
    if (row.commitPolicy !== contract.commitPolicy) {
      diagnostics.push(`artifact ${id} commitPolicy must be ${contract.commitPolicy}`);
    }
    if (row.writerAuthority !== contract.writerAuthority) {
      diagnostics.push(`artifact ${id} writerAuthority must be ${contract.writerAuthority}`);
    }
    if (row.responsibility !== contract.responsibility)
      diagnostics.push(`artifact ${id} responsibility must be ${contract.responsibility}`);
    if (!equalArray(row.owns, contract.owns)) {
      diagnostics.push(`artifact ${id} owns must equal: ${contract.owns.join(', ')}`);
    }
    if (!equalArray(row.forbids, contract.forbids)) {
      diagnostics.push(`artifact ${id} forbids must equal: ${contract.forbids.join(', ')}`);
    }

    const authority = typeof row.writerAuthority === 'string' ? row.writerAuthority : '';
    if (authority) {
      if (authorities.has(authority)) {
        diagnostics.push(`writer authority ${authority} is assigned to multiple artifacts`);
      }
      authorities.set(authority, id);
    }

    const owns = strings(row.owns);
    const forbids = new Set(strings(row.forbids));
    for (const fact of owns) {
      if (ownership.has(fact))
        diagnostics.push(`responsibility ${fact} is owned by multiple artifacts`);
      ownership.set(fact, id);
      if (forbids.has(fact)) diagnostics.push(`artifact ${id} owns and forbids ${fact}`);
    }
  }

  const phases = objects(value.dependencyOrder);
  reportDuplicates(
    phases.map((row) => row.id),
    (id) => `dependency phase ${id} is duplicated`,
    diagnostics,
  );
  if (!exactIds(phases, 'id', PHASE_IDS)) {
    diagnostics.push(`dependencyOrder must be exactly ${PHASE_IDS.join(' -> ')}`);
  }
  for (let index = 0; index < phases.length; index += 1) {
    const phase = phases[index];
    const id = typeof phase.id === 'string' ? phase.id : `<index-${index}>`;
    validateFields(phase, PHASE_FIELDS, `phase ${id}`, diagnostics);
    if (index < PHASE_NAMES.length && phase.name !== PHASE_NAMES[index]) {
      diagnostics.push(`phase ${id} name must be ${PHASE_NAMES[index]}`);
    }
    const expected = index === 0 ? [] : [PHASE_IDS[index - 1]];
    if (!equalArray(phase.dependsOn, expected)) {
      diagnostics.push(`phase ${id} must depend exactly on ${expected[0] ?? 'nothing'}`);
    }
  }

  const factorRows = objects(value.factorReview);
  reportDuplicates(
    factorRows.map((row) => row.bucket),
    (bucket) => `factor bucket ${bucket} is duplicated`,
    diagnostics,
  );
  if (!exactIds(factorRows, 'bucket', FACTOR_BUCKETS)) {
    diagnostics.push(`factorReview must contain the exact buckets: ${FACTOR_BUCKETS.join(', ')}`);
  }
  for (const row of factorRows) {
    const bucket = typeof row.bucket === 'string' ? row.bucket : '<invalid>';
    validateFields(row, FACTOR_FIELDS, `factor bucket ${bucket}`, diagnostics);
    if (row.disposition !== 'closed')
      diagnostics.push(`factor bucket ${bucket} disposition must be closed`);
    const expected = FACTORS[bucket];
    if (expected) {
      for (const field of ['action', 'facts', 'evidencePointers']) {
        if (!equalValue(row[field], expected[field]))
          diagnostics.push(`factor bucket ${bucket} ${field} contradicts the canonical authority`);
      }
    }
    verifyPointers(row.evidencePointers, `factor bucket ${bucket}`, options, diagnostics);
  }

  const qualityRows = objects(value.qualityScan);
  reportDuplicates(
    qualityRows.map((row) => row.id),
    (id) => `quality finding ${id} is duplicated`,
    diagnostics,
  );
  if (!exactIds(qualityRows, 'axis', QUALITY_AXES)) {
    diagnostics.push(`qualityScan must contain the exact axes: ${QUALITY_AXES.join(', ')}`);
  }
  for (let index = 0; index < qualityRows.length; index += 1) {
    const row = qualityRows[index];
    const expectedId = `P17-G0-03-Q${String(index + 1).padStart(2, '0')}`;
    const id = typeof row.id === 'string' ? row.id : '<invalid>';
    validateFields(row, REVIEW_FIELDS, `quality finding ${id}`, diagnostics);
    if (row.id !== expectedId)
      diagnostics.push(`quality axis ${row.axis} must use ID ${expectedId}`);
    if (row.disposition !== 'closed')
      diagnostics.push(`quality finding ${id} disposition must be closed`);
    const expected = QUALITY[String(row.axis)];
    if (expected) {
      for (const field of ['result', 'facts', 'evidencePointers']) {
        if (!equalValue(row[field], expected[field]))
          diagnostics.push(`quality finding ${id} ${field} contradicts the canonical authority`);
      }
    }
    verifyPointers(row.evidencePointers, `quality finding ${id}`, options, diagnostics);
  }

  const driftRows = objects(value.architectureDrift);
  reportDuplicates(
    driftRows.map((row) => row.id),
    (id) => `architecture drift ${id} is duplicated`,
    diagnostics,
  );
  if (!exactIds(driftRows, 'id', Object.keys(DRIFT))) {
    diagnostics.push(`architectureDrift must contain exact IDs: ${Object.keys(DRIFT).join(', ')}`);
  }
  for (const row of driftRows) {
    const id = typeof row.id === 'string' ? row.id : '<invalid>';
    validateFields(row, DRIFT_FIELDS, `architecture drift ${id}`, diagnostics);
    const expected = DRIFT[id];
    if (expected) {
      for (const field of [
        'classification',
        'disposition',
        'subject',
        'target',
        'downstreamOwner',
        'evidencePointers',
      ]) {
        if (!equalValue(row[field], expected[field])) {
          diagnostics.push(`architecture drift ${id} ${field} contradicts the canonical authority`);
        }
      }
    }
    verifyPointers(row.evidencePointers, `architecture drift ${id}`, options, diagnostics);
  }

  if (!isObject(value.cf001)) {
    diagnostics.push('cf001 must be an object');
  } else {
    validateFields(value.cf001, CF001_FIELDS, 'cf001', diagnostics);
    if (value.cf001.findingId !== 'EWP-CF-001')
      diagnostics.push('cf001.findingId must be EWP-CF-001');
    if (!equalArray(value.cf001.contractLinks, CF001_CONTRACTS)) {
      diagnostics.push('cf001.contractLinks must equal the canonical CF-001 contract set');
    }
    const downstream = catalogDownstream(options.catalog ?? defaultCatalog());
    if (!Array.isArray(downstream)) {
      diagnostics.push('catalog lacks P17-G0-03 downstreamCoverage');
    } else if (!equalValue(value.cf001.downstreamValidations, downstream)) {
      diagnostics.push('cf001.downstreamValidations must exactly equal G0-03 downstreamCoverage');
    }
  }

  return diagnostics;
};

const main = async (): Promise<void> => {
  if (Bun.argv.length !== 3 || Bun.argv[2] !== '--check') {
    console.error('usage: bun scripts/p17-architecture-reconciliation.ts --check');
    process.exitCode = 2;
    return;
  }

  let parsed: unknown;
  let catalog: unknown;
  try {
    parsed = await Bun.file(ARTIFACT_PATH).json();
    catalog = await Bun.file(CATALOG_PATH).json();
  } catch (error) {
    console.error(`P17-G0-03 reconciliation could not be read: ${String(error)}`);
    process.exitCode = 1;
    return;
  }

  const diagnostics = validateArchitectureReconciliation(parsed, { catalog });
  if (diagnostics.length > 0) {
    for (const diagnostic of diagnostics) console.error(`P17-G0-03: ${diagnostic}`);
    process.exitCode = 1;
    return;
  }

  console.log('P17-G0-03 architecture reconciliation: passed');
};

if (import.meta.main) await main();
