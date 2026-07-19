import { hashManifestSemantics } from '../../../../packages/core/src/artifacts/hash.ts';
import {
  type PortableLockV1,
  serializePortableLock,
} from '../../../../packages/core/src/artifacts/lock.ts';
import {
  normalizeManifestDocument,
  readManifestSource,
} from '../../../../packages/core/src/artifacts/manifest.ts';
import {
  type CurrentMutatorOperationPlan,
  type ExecutableOperation,
  type OperationDigest,
  type OperationImage,
  type OperationSource,
  createOperationGroupId,
  createOperationId,
  createOperationPairId,
} from '../../../../packages/core/src/planning/index.ts';

export const FIXTURE_CANARY = 'p4a-ts02-fixture-v1';

export const FEATURE_FAMILIES = Object.freeze([
  'preflight-zero-write',
  'deterministic-planning',
  'install-partial-pairs',
  'install-saving-groups',
  'uninstall-partial-pairs',
  'multi-declaration-uninstall',
  'collision-failures',
  'crash-handoff',
  'lock-only-recovery',
  'promote-compatibility',
  'cancellation-and-exit',
  'reporting-and-help',
] as const);

export const REQUIRED_COMPATIBILITY_SELECTORS = Object.freeze([
  'EWP-CMD-INSTALL-TS08',
  'EWP-CMD-UNINSTALL-TS04',
  'EWP-CMD-UNINSTALL-TS07',
  'EWP-P3B-TS03',
  'EWP-P3B-TS05',
  'EWP-CMD-PROMOTE-TS04',
  'EWP-CMD-PROMOTE-TS06',
] as const);

export const COLLISION_CASES = Object.freeze([
  {
    id: 'install-prefix-unavailable-fail-fast',
    policy: 'fail-fast',
    failure: 'prefix-lock',
    expectedLater: 'skipped-after-failure',
  },
  {
    id: 'install-prefix-unavailable-continue',
    policy: 'continue-on-error',
    failure: 'prefix-lock',
    expectedLater: 'skipped-after-failure',
  },
  {
    id: 'install-prefix-durable-pair-failure-fail-fast',
    policy: 'fail-fast',
    failure: 'live-pair',
    expectedLater: 'skipped-after-failure',
  },
  {
    id: 'install-prefix-durable-pair-failure-continue',
    policy: 'continue-on-error',
    failure: 'live-pair',
    expectedLater: 'succeeded',
  },
] as const);

export const LOCK_HANDOFF_CASES = Object.freeze([
  { id: 'explicit-reduced', selectedBy: 'explicit', outcome: 'repair' },
  { id: 'explicit-final', selectedBy: 'explicit', outcome: 'repair' },
  { id: 'bounded-sibling-reduced', selectedBy: 'bounded-owner', outcome: 'repair' },
  { id: 'bounded-sibling-final', selectedBy: 'bounded-owner', outcome: 'repair' },
  { id: 'history-free-final', selectedBy: 'explicit', outcome: 'refuse' },
  { id: 'pending-final', selectedBy: 'explicit', outcome: 'refuse' },
  { id: 'rollback-final', selectedBy: 'explicit', outcome: 'refuse' },
  { id: 'superseded-final', selectedBy: 'explicit', outcome: 'refuse' },
  { id: 'intent-actual-mismatch', selectedBy: 'explicit', outcome: 'refuse' },
  { id: 'selected-pair-disagreement', selectedBy: 'explicit', outcome: 'refuse' },
  { id: 'split-owner', selectedBy: 'ambiguous', outcome: 'refuse' },
  { id: 'requested-ref-drift', selectedBy: 'explicit', outcome: 'refuse' },
  { id: 'resolved-sha-drift', selectedBy: 'explicit', outcome: 'refuse' },
  { id: 'content-hash-drift', selectedBy: 'explicit', outcome: 'refuse' },
  { id: 'unrelated-lock-drift', selectedBy: 'explicit', outcome: 'refuse' },
] as const);

export const CRASH_POINTS = Object.freeze([
  'after-manifest',
  'after-lock',
  'after-live-pair',
] as const);

export const manifestSource = (names: readonly string[]): string =>
  `${[
    '# retained top-level comment',
    'version = 1',
    '',
    '[defaults]',
    'scope = "user"',
    'tools = ["claude-code"]',
    '',
    ...names.flatMap((name, index) => [
      `# retained declaration comment ${index + 1}`,
      '[[skills]]',
      `name = "${name}"`,
      `source = "fixture.invalid/acme/skills//skills/${name}"`,
      'tools = ["claude-code"]',
      'scope = "user"',
      'placement = "symlink"',
      '',
    ]),
  ].join('\n')}\n`;

export const normalizeManifest = (source: string) => {
  const document = readManifestSource(source);
  if (!document.ok) throw new Error(document.error.message);
  const normalized = normalizeManifestDocument(document.value);
  if (!normalized.ok) throw new Error(normalized.error.message);
  return normalized.value;
};

export const lockSourceFor = (
  source: string,
  resolvedSha: string,
  contentHash: `sha256:${string}` = `sha256:${'a'.repeat(64)}`,
): string => {
  const manifest = normalizeManifest(source);
  const lock: PortableLockV1 = {
    version: 1,
    hashSchemaVersion: 1,
    manifestHash: hashManifestSemantics(manifest),
    skills: manifest.skills
      .map((skill) => ({
        name: skill.name,
        source: `${skill.source.host}/${skill.source.repository}//${skill.source.path}`,
        requestedRef: skill.ref,
        resolvedSha,
        sourcePath: skill.source.path,
        contentHash,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
  const serialized = serializePortableLock(lock);
  if (!serialized.ok) throw new Error(serialized.error.message);
  return serialized.value;
};

const CONTENT_HASH = `sha256:${'a'.repeat(64)}` as OperationDigest;
const OTHER_HASH = `sha256:${'b'.repeat(64)}` as OperationDigest;
const SOURCE: OperationSource = {
  kind: 'portable',
  identity: { host: 'fixture.invalid', repository: 'acme/skills', path: 'skills/alpha' },
  requestedRef: null,
  resolvedSha: 'c'.repeat(40),
  sourcePath: 'skills/alpha',
  contentHash: CONTENT_HASH,
};

const groupIdFor = (skill: string): string =>
  createOperationGroupId({
    domain: 'skillsmith.operation-group-identity',
    schemaVersion: 1,
    command: 'install',
    skill,
    source: { ...SOURCE, identity: { ...SOURCE.identity, path: `skills/${skill}` } },
    scope: 'user',
    target: null,
  });

const liveOperation = (skill: string, dependencies: readonly string[]): ExecutableOperation => {
  const groupId = groupIdFor(skill);
  const source = { ...SOURCE, identity: { ...SOURCE.identity, path: `skills/${skill}` } };
  const resource = {
    kind: 'live' as const,
    skill,
    tool: 'codex' as const,
    scope: 'user' as const,
    projectRoot: null,
    location: { kind: 'portable' as const, token: `skills/user/codex/${skill}` },
  };
  const pairId = createOperationPairId({
    domain: 'skillsmith.operation-pair-identity',
    schemaVersion: 1,
    groupId,
    tool: 'codex',
    resource,
  });
  const before: OperationImage = { kind: 'absent', resource };
  const after: OperationImage = {
    kind: 'placement',
    resource,
    classification: 'pinned',
    representation: 'copy',
    linkTarget: null,
    dangling: false,
    source,
    contentHash: CONTENT_HASH,
  };
  return {
    operationId: createOperationId({
      domain: 'skillsmith.operation-identity',
      schemaVersion: 1,
      groupId,
      pairId,
      kind: 'install',
      skill,
      source,
      tool: 'codex',
      scope: 'user',
    }),
    groupId,
    pairId,
    kind: 'install',
    dependencyMetadata: {
      domain: 'skillsmith.operation-dependency',
      schemaVersion: 1,
      operationIds: dependencies,
    },
    skill,
    source,
    tool: 'codex',
    scope: 'user',
    before,
    after,
    reason: { code: 'install-selected', message: 'Selected by the TS02 collision fixture.' },
    selectionSource: 'explicit-targets',
    preconditionIds: ['precondition:v1:p4a-ts02'],
    requiredCheckIds: [],
    reversibility: { kind: 'none', retentionResourceIds: [] },
    mutates: { live: true, manifest: false, lock: false, ledger: true },
    conflict: null,
  };
};

const artifactOperation = (
  skill: string,
  kind: 'write-manifest' | 'write-lock',
  dependencies: readonly string[],
): ExecutableOperation => {
  const groupId = groupIdFor(skill);
  const manifestLocation = { kind: 'portable' as const, token: 'artifacts/skillsmith.toml' };
  const lockLocation = { kind: 'portable' as const, token: 'artifacts/skillsmith.lock' };
  const manifest = { version: 1 as const, defaults: null, registry: null, skills: [] };
  const before: OperationImage =
    kind === 'write-manifest'
      ? { kind: 'absent', resource: { kind: 'manifest-bytes', location: manifestLocation } }
      : { kind: 'absent', resource: { kind: 'lock', location: lockLocation } };
  const after: OperationImage =
    kind === 'write-manifest'
      ? {
          kind: 'manifest',
          location: manifestLocation,
          shape: 'canonical',
          version: 1,
          byteHash: OTHER_HASH,
          semanticHash: CONTENT_HASH,
          value: manifest,
        }
      : {
          kind: 'lock',
          location: lockLocation,
          version: 1,
          canonicalHash: OTHER_HASH,
          value: {
            version: 1,
            hashSchemaVersion: 1,
            manifestHash: CONTENT_HASH,
            skills: [],
          },
        };
  return {
    operationId: createOperationId({
      domain: 'skillsmith.operation-identity',
      schemaVersion: 1,
      groupId,
      pairId: null,
      kind,
      skill: null,
      source: null,
      tool: null,
      scope: null,
    }),
    groupId,
    pairId: null,
    kind,
    dependencyMetadata: {
      domain: 'skillsmith.operation-dependency',
      schemaVersion: 1,
      operationIds: dependencies,
    },
    skill: null,
    source: null,
    tool: null,
    scope: null,
    before,
    after,
    reason: { code: `${kind}-required`, message: `${kind} required by the TS02 fixture.` },
    selectionSource: 'explicit-targets',
    preconditionIds: ['precondition:v1:p4a-ts02'],
    requiredCheckIds: [],
    reversibility: { kind: 'none', retentionResourceIds: [] },
    mutates:
      kind === 'write-manifest'
        ? { live: false, manifest: true, lock: false, ledger: false }
        : { live: false, manifest: false, lock: true, ledger: false },
    conflict: null,
  };
};

export interface CollisionPlanFixture {
  readonly plan: CurrentMutatorOperationPlan;
  readonly alphaManifestId: string;
  readonly alphaLockId: string;
  readonly alphaLiveId: string;
  readonly betaLiveId: string;
}

export const collisionPlan = (
  batchPolicy: CurrentMutatorOperationPlan['batchPolicy'],
): CollisionPlanFixture => {
  const candidateSkills = ['alpha', 'beta'] as const;
  const [prefixSkill, dependentSkill] = [...candidateSkills].sort((left, right) => {
    const leftGroup = liveOperation(left, []).groupId;
    const rightGroup = liveOperation(right, []).groupId;
    return leftGroup < rightGroup ? -1 : leftGroup > rightGroup ? 1 : 0;
  });
  const manifest = artifactOperation(prefixSkill, 'write-manifest', []);
  const lock = artifactOperation(prefixSkill, 'write-lock', [manifest.operationId]);
  const alpha = liveOperation(prefixSkill, [lock.operationId]);
  const beta = liveOperation(dependentSkill, [lock.operationId]);
  return {
    plan: {
      domain: 'skillsmith.operation-plan',
      schemaVersion: 1,
      command: 'install',
      selection: {
        source: 'explicit-targets',
        skills: [prefixSkill, dependentSkill],
        tools: ['codex'],
        scopes: ['user'],
      },
      batchPolicy,
      operations: [manifest, lock, alpha, beta],
      checks: [],
      diagnostics: [],
    },
    alphaManifestId: manifest.operationId,
    alphaLockId: lock.operationId,
    alphaLiveId: alpha.operationId,
    betaLiveId: beta.operationId,
  };
};

export interface RollingCollisionPlanFixture {
  readonly plan: CurrentMutatorOperationPlan;
  readonly firstLockId: string;
  readonly middleLiveId: string;
  readonly laterLockId: string;
  readonly laterLiveId: string;
}

export const rollingCollisionPlan = (
  batchPolicy: CurrentMutatorOperationPlan['batchPolicy'],
): RollingCollisionPlanFixture => {
  const firstManifest = artifactOperation('epsilon', 'write-manifest', []);
  const firstLock = artifactOperation('epsilon', 'write-lock', [firstManifest.operationId]);
  const firstLive = liveOperation('epsilon', [firstLock.operationId]);
  const middleLive = liveOperation('skill-0', [firstLock.operationId]);
  const laterManifest = artifactOperation('alpha', 'write-manifest', [firstLock.operationId]);
  const laterLock = artifactOperation('alpha', 'write-lock', [
    firstLock.operationId,
    laterManifest.operationId,
  ]);
  const laterLive = liveOperation('alpha', [firstLock.operationId, laterLock.operationId]);
  return {
    plan: {
      domain: 'skillsmith.operation-plan',
      schemaVersion: 1,
      command: 'install',
      selection: {
        source: 'explicit-targets',
        skills: ['epsilon', 'skill-0', 'alpha'],
        tools: ['codex'],
        scopes: ['user'],
      },
      batchPolicy,
      operations: [
        firstManifest,
        firstLock,
        firstLive,
        middleLive,
        laterManifest,
        laterLock,
        laterLive,
      ],
      checks: [],
      diagnostics: [],
    },
    firstLockId: firstLock.operationId,
    middleLiveId: middleLive.operationId,
    laterLockId: laterLock.operationId,
    laterLiveId: laterLive.operationId,
  };
};
