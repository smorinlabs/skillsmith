import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '../../..');
const FIXTURES = join(import.meta.dir, '../fixtures/p2-ts08');
const CORE_MODULE = '../../../packages/core/src/index.ts';
const CONTRACTS_MODULE = '../../../packages/core/src/contracts/index.ts';
const V1_MODULE = '../../../packages/core/src/contracts/v1/index.ts';
const V2_MODULE = '../../../packages/core/src/contracts/v2/index.ts';
const V3_MODULE = '../../../packages/core/src/contracts/v3/index.ts';
const V4_MODULE = '../../../packages/core/src/contracts/v4/index.ts';
const WIRE_AUTHORITY_MODULE = '../../../packages/cli/src/contracts/wire-contracts.ts';
const SECRET_CANARY = 'P17_SECRET_CANARY';
const encoder = new TextEncoder();

type UnknownRecord = Record<PropertyKey, unknown>;
type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: Readonly<Record<string, unknown>> };
type Codec = {
  readonly descriptor: Readonly<Record<string, unknown>>;
  validate(value: unknown): Result<unknown>;
  fromDto(value: unknown): Result<unknown>;
  toDto(value: unknown): Result<unknown>;
  decode(value: Uint8Array): Result<Decoded>;
  encode(value: unknown): Result<Uint8Array>;
};
type Decoded = {
  readonly source: Readonly<Record<string, unknown>>;
  readonly model: unknown;
  readonly canonical: boolean;
  readonly migration: unknown;
};
type Registry = {
  readonly codecs: readonly Codec[];
  get(id: string, version: number): Codec | undefined;
  latest(id: string): Codec | undefined;
};
type DescriptorRegistry = {
  readonly codecs: readonly {
    readonly descriptor: { readonly id: string; readonly version: number };
  }[];
};

interface GoldenInventoryEntry {
  readonly identity: string;
  readonly id: 'manifest' | 'lock' | 'plan' | 'ledger' | 'journal';
  readonly version: 1 | 2;
  readonly syntax: 'json' | 'toml';
  readonly discriminator: Readonly<Record<string, unknown>>;
  readonly wireKind: string | null;
  readonly presentation: {
    readonly decode: 'human' | 'canonical';
    readonly encode: 'canonical' | 'compatibility';
  };
  readonly terminalLf: boolean;
  readonly unknownFields: 'reject-recursive';
  readonly migrations: readonly Readonly<Record<string, unknown>>[];
  readonly compatibility: 'conservative';
  readonly golden: {
    readonly file: string;
    readonly byteLength: number;
    readonly sha256: string;
  };
}

interface ArtifactInventory {
  readonly schemaVersion: number;
  readonly artifactCount: number;
  readonly goldenByteTotal: number;
  readonly artifacts: readonly GoldenInventoryEntry[];
}

type FuzzMutation =
  | { readonly kind: 'replace-once'; readonly from: string; readonly to: string }
  | { readonly kind: 'truncate-bytes'; readonly count: number };
interface FuzzCase {
  readonly id: string;
  readonly artifact: GoldenInventoryEntry['id'];
  readonly codecVersion: 1 | 2;
  readonly source?: string;
  readonly literalUtf8?: string;
  readonly literalHex?: string;
  readonly mutation?: FuzzMutation;
  readonly expectedReason: string;
}
interface FuzzCorpus {
  readonly schemaVersion: number;
  readonly cases: readonly FuzzCase[];
}

const inventory = JSON.parse(
  readFileSync(join(FIXTURES, 'artifact-inventory.json'), 'utf8'),
) as ArtifactInventory;
const fuzzCorpus = JSON.parse(
  readFileSync(join(FIXTURES, 'fuzz-corpus.json'), 'utf8'),
) as FuzzCorpus;

const EXPECTED_IDENTITIES = [
  'manifest@1',
  'lock@1',
  'plan@1',
  'ledger@1',
  'ledger@2',
  'journal@1',
] as const;
const EXPECTED_WIRE_IDENTITIES = [
  'agents@1',
  'agents@2',
  'apply-report@1',
  'health@1',
  'health@2',
  'commands@1',
  'commands@2',
  'config-get@1',
  'config-list@1',
  'config-set@1',
  'config-unset@1',
  'flip@2',
  'flip@3',
  'flip@4',
  'install@1',
  'init@1',
  'install@2',
  'list@2',
  'list@3',
  'plan-report@1',
  'status@1',
  'sync@1',
  'update@1',
  'uninstall@1',
  'uninstall@2',
  'verify@1',
  'error@1',
  'export@1',
  'capability-snapshot@1',
] as const;
const EXPECTED_FUZZ_IDS = [
  'manifest-future-version',
  'manifest-zero-version',
  'manifest-unknown-root',
  'manifest-unknown-nested-default',
  'manifest-truncated-table',
  'manifest-invalid-utf8',
  'lock-future-version',
  'lock-zero-version',
  'lock-unknown-root',
  'lock-unknown-nested-skill',
  'lock-noncanonical-missing-lf',
  'lock-noncanonical-key-order',
  'plan-future-version',
  'plan-zero-version',
  'plan-unknown-root',
  'plan-unknown-nested-portability',
  'plan-truncated-json',
  'plan-duplicate-version',
  'plan-noncanonical-missing-lf',
  'plan-noncanonical-indent-drift',
  'ledger-v1-unknown-nested-pair',
  'ledger-future-version',
  'ledger-zero-version',
  'ledger-unknown-root',
  'ledger-v2-private-nested-staging-path',
  'ledger-truncated-json',
  'ledger-v2-noncanonical-missing-lf',
  'ledger-v2-noncanonical-key-order',
  'journal-future-version',
  'journal-zero-version',
  'journal-unknown-root',
  'journal-private-nested-recovery-cursor',
  'journal-truncated-json',
  'journal-noncanonical-missing-lf',
  'journal-noncanonical-key-order',
] as const;
const FINAL_LF_NONCANONICAL_IDS = [
  'lock-noncanonical-key-order',
  'plan-noncanonical-indent-drift',
  'ledger-v2-noncanonical-key-order',
  'journal-noncanonical-key-order',
] as const;
const EXPECTED_GOLDENS = {
  'manifest-v1.golden.toml': {
    bytes: 387,
    sha256: 'sha256:30215174d1e74a49d90e362dc5eb3a0ddf91957b3c33d4ee09a858bd0bac08c9',
  },
  'lock-v1.golden.toml': {
    bytes: 644,
    sha256: 'sha256:6a8260a974bf7f2317f0e218fee44ea3b0be8378351bc9b12c17d2887b00e17f',
  },
  'plan-v1.golden.json': {
    bytes: 8377,
    sha256: 'sha256:c3d12a0fea80819c3a7adf5aae56386569141e5ac965301072eb8aa536e4d981',
  },
  'ledger-v1.golden.json': {
    bytes: 3456,
    sha256: 'sha256:269ea3a4e9bdfb47c7ba475314a64bf26b8d670c34058db23e4a20da2b1252cd',
  },
  'ledger-v2.golden.json': {
    bytes: 9349,
    sha256: 'sha256:0fe449f42c99dd160e49d731a1ba4374ed173652288094d95320cf5a77b6dbd2',
  },
  'journal-v1.golden.json': {
    bytes: 2381,
    sha256: 'sha256:e882ac1fbbf4e5063a876acd5a2570e43872d0e2733b312c9f858f63adaa2b72',
  },
} as const;
const EMPTY_MANIFEST = encoder.encode('version = 1\n');
const EMPTY_MANIFEST_SHA256 =
  'sha256:dbab12665d98aef021ba64953c61b0ed8a908cfb56a1c01e2fcb4b052b71a2a1';

const CONTRACT_RUNTIME_EXPORTS = ['createWireContractRegistry'] as const;
const V1_RUNTIME_EXPORTS = [
  'agentsV1Codec',
  'applyV1Codec',
  'capabilitySnapshotV1Codec',
  'commandsV1Codec',
  'configGetV1Codec',
  'configListV1Codec',
  'configSetV1Codec',
  'configUnsetV1Codec',
  'createVerifyV1Codec',
  'errorV1Codec',
  'exportV1Codec',
  'healthV1Codec',
  'initV1Codec',
  'installV1Codec',
  'planV1Codec',
  'statusV1Codec',
  'syncV1Codec',
  'updateV1Codec',
  'toAgentsV1Dto',
  'toCapabilitySnapshotV1Dto',
  'toCommandsV1Dto',
  'toConfigGetV1Dto',
  'toConfigListV1Dto',
  'toConfigSetV1Dto',
  'toConfigUnsetV1Dto',
  'toErrorV1Dto',
  'toExportV1Dto',
  'toHealthV1Dto',
  'toInitV1Dto',
  'toInstallV1Dto',
  'toStatusV1Dto',
  'toUninstallV1Dto',
  'toVerifyV1Dto',
  'uninstallV1Codec',
  'verifyV1Codec',
  'manifestV1Codec',
  'toManifestV1Dto',
  'fromManifestV1Dto',
  'lockV1Codec',
  'toLockV1Dto',
  'fromLockV1Dto',
  'savedPlanV1Codec',
  'toSavedPlanV1Dto',
  'fromSavedPlanV1Dto',
  'ledgerV1Codec',
  'toLedgerV1Dto',
  'fromLedgerV1Dto',
  'journalV1Codec',
  'toJournalV1Dto',
  'fromJournalV1Dto',
] as const;
const V2_RUNTIME_EXPORTS = [
  'agentsV2Codec',
  'commandsV2Codec',
  'flipV2Codec',
  'healthV2Codec',
  'installV2Codec',
  'listV2Codec',
  'uninstallV2Codec',
  'toFlipV2Dto',
  'toHealthV2Dto',
  'toInstallV2Dto',
  'toListV2Dto',
  'toUninstallV2Dto',
  'ledgerV2Codec',
  'toLedgerV2Dto',
  'fromLedgerV2Dto',
  'migrateLedgerV1DtoToV2Dto',
  'toAgentsV2Dto',
  'toCommandsV2Dto',
] as const;
const V3_RUNTIME_EXPORTS = ['flipV3Codec', 'listV3Codec', 'toFlipV3Dto', 'toListV3Dto'] as const;
const V4_RUNTIME_EXPORTS = ['flipV4Codec', 'toFlipV4Dto'] as const;

const rawSha256 = (bytes: Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const unwrap = <T>(result: Result<T>, label: string): T => {
  expect(result.ok, result.ok ? label : `${label}: ${JSON.stringify(result.error)}`).toBeTrue();
  if (!result.ok) throw new Error(`${label}: ${JSON.stringify(result.error)}`);
  return result.value;
};

const assertRecursivelyFrozen = (value: unknown, seen = new Set<object>()): void => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBeTrue();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && 'value' in descriptor) {
      assertRecursivelyFrozen(descriptor.value, seen);
    }
  }
};

const loadModule = async (specifier: string): Promise<Readonly<Record<string, unknown>>> =>
  (await import(specifier)) as Readonly<Record<string, unknown>>;

const requireRegistry = async (): Promise<{
  readonly core: Readonly<Record<string, unknown>>;
  readonly registry: Registry;
}> => {
  const core = await loadModule(CORE_MODULE);
  const registry = core.artifactContractRegistry as Registry | undefined;
  expect(registry, 'P17-G2-05 artifactContractRegistry is absent').toBeDefined();
  if (registry === undefined) throw new Error('P17-G2-05 artifactContractRegistry is absent');
  return { core, registry };
};

const fixtureBytes = (file: string): Uint8Array => readFileSync(join(FIXTURES, file));

const descriptorFromInventory = ({
  identity: _identity,
  golden: _golden,
  ...descriptor
}: GoldenInventoryEntry): Readonly<Record<string, unknown>> => descriptor;

const fuzzBytes = (fixture: FuzzCase): Uint8Array => {
  const sourceKinds = [fixture.source, fixture.literalUtf8, fixture.literalHex].filter(
    (value) => value !== undefined,
  );
  if (sourceKinds.length !== 1) throw new Error(`${fixture.id}: expected exactly one source`);
  let bytes =
    fixture.source !== undefined
      ? fixtureBytes(fixture.source)
      : fixture.literalUtf8 !== undefined
        ? encoder.encode(fixture.literalUtf8)
        : Buffer.from(fixture.literalHex as string, 'hex');
  if (fixture.mutation === undefined) return new Uint8Array(bytes);
  if (fixture.mutation.kind === 'truncate-bytes') {
    if (fixture.mutation.count < 1 || fixture.mutation.count >= bytes.byteLength) {
      throw new Error(`${fixture.id}: invalid truncation`);
    }
    return bytes.slice(0, bytes.byteLength - fixture.mutation.count);
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const first = text.indexOf(fixture.mutation.from);
  const second = text.indexOf(fixture.mutation.from, first + fixture.mutation.from.length);
  if (first < 0 || second >= 0) throw new Error(`${fixture.id}: replacement is not unique`);
  bytes = encoder.encode(
    `${text.slice(0, first)}${fixture.mutation.to}${text.slice(first + fixture.mutation.from.length)}`,
  );
  return bytes;
};

const jsonCanonicalBytes = (bytes: Uint8Array, terminalLf: boolean): Uint8Array => {
  const parsed = JSON.parse(new TextDecoder().decode(bytes));
  return encoder.encode(`${JSON.stringify(parsed, null, 2)}${terminalLf ? '\n' : ''}`);
};

const reverseRecordInsertion = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(reverseRecordInsertion);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, child]) => [key, reverseRecordInsertion(child)]),
  );
};

const differentlyOrderedDto = (identity: string, dto: unknown): UnknownRecord => {
  const reordered = reverseRecordInsertion(dto) as UnknownRecord;
  if (identity === 'manifest@1' || identity === 'lock@1') {
    (reordered.skills as unknown[]).reverse();
  }
  if (identity === 'plan@1') {
    const operation = (reordered.operations as UnknownRecord[])[0];
    (operation?.preconditionIds as unknown[] | undefined)?.reverse();
    (operation?.requiredCheckIds as unknown[] | undefined)?.reverse();
    const check = (reordered.checks as UnknownRecord[]).find(
      ({ kind }) => kind === 'precondition-validation',
    );
    (check?.preconditionIds as unknown[] | undefined)?.reverse();
  }
  return reordered;
};

const poisonArtifactDto = (identity: string, dto: unknown): UnknownRecord => {
  const poisoned = structuredClone(dto) as UnknownRecord;
  if (identity === 'manifest@1') {
    ((poisoned.skills as UnknownRecord[])[0] as UnknownRecord).ref = SECRET_CANARY;
  } else if (identity === 'lock@1') {
    ((poisoned.skills as UnknownRecord[])[0] as UnknownRecord).requestedRef = SECRET_CANARY;
  } else if (identity === 'plan@1') {
    poisoned.skillsmithVersion = SECRET_CANARY;
  } else if (identity === 'ledger@1' || identity === 'ledger@2') {
    poisoned.updatedAt = SECRET_CANARY;
  } else if (identity === 'journal@1') {
    (poisoned.context as UnknownRecord).command = SECRET_CANARY;
  } else {
    throw new Error(`unsupported poison fixture ${identity}`);
  }
  return poisoned;
};

const ledgerRecordOrderVariants = (dto: unknown): readonly [UnknownRecord, UnknownRecord] => {
  const left = structuredClone(dto) as UnknownRecord;
  const right = structuredClone(dto) as UnknownRecord;
  const original = left.skills as UnknownRecord;
  const review = original.review as UnknownRecord;
  const alpha = structuredClone(review) as UnknownRecord;
  const alphaTools = alpha.tools as UnknownRecord;
  for (const pair of Object.values(alphaTools) as UnknownRecord[]) {
    pair.placementPath = `${pair.placementPath as string}-alpha`;
    const journal = pair.journal as UnknownRecord | null | undefined;
    if (journal !== null && journal !== undefined) journal.txId = `${journal.txId as string}:alpha`;
  }
  left.skills = { review, alpha };
  right.skills = {
    alpha: structuredClone(alpha),
    review: structuredClone((right.skills as UnknownRecord).review),
  };
  return [left, right];
};

interface JournalPrivateProbe {
  readonly id: string;
  readonly control: UnknownRecord;
  readonly containerPath: readonly (string | number)[];
  readonly privateField: string;
}

const journalIntentFromOperation = (operation: UnknownRecord): UnknownRecord =>
  Object.fromEntries(
    [
      'operationId',
      'groupId',
      'pairId',
      'kind',
      'skill',
      'source',
      'tool',
      'scope',
      'before',
      'after',
      'mutates',
      'reversibility',
      'conflict',
    ].map((key) => [key, structuredClone(operation[key])]),
  );

const journalPrivateProbes = (): readonly JournalPrivateProbe[] => {
  const base = JSON.parse(
    readFileSync(join(FIXTURES, 'journal-v1.golden.json'), 'utf8'),
  ) as UnknownRecord;
  const plan = JSON.parse(
    readFileSync(join(FIXTURES, 'plan-v1.golden.json'), 'utf8'),
  ) as UnknownRecord;
  const operation = (plan.operations as UnknownRecord[])[0] as UnknownRecord;
  const planContentHash = (operation.after as UnknownRecord).contentHash as string;
  const digest1 = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
  const digest2 = 'sha256:2222222222222222222222222222222222222222222222222222222222222222';
  const digest3 = 'sha256:3333333333333333333333333333333333333333333333333333333333333333';
  const digest4 = 'sha256:4444444444444444444444444444444444444444444444444444444444444444';
  const portableManifest = { kind: 'portable', token: 'project:skills.toml' };
  const portableLock = { kind: 'portable', token: 'project:skills.lock' };
  const resourceRevision = (digest: string): UnknownRecord => ({ kind: 'resource', digest });
  const artifactRevision = (digest: string): UnknownRecord => ({
    kind: 'artifact-bytes',
    digest,
  });
  const ledgerBefore = structuredClone(
    ((base.actual as UnknownRecord).before as UnknownRecord[])[0],
  ) as UnknownRecord;
  const ledgerAfter = structuredClone(
    ((base.actual as UnknownRecord).after as UnknownRecord[])[0],
  ) as UnknownRecord;
  const liveBefore: UnknownRecord = {
    resourceId: 'resource:live-review',
    role: 'live',
    state: 'absent',
    repositoryRevision: null,
    placementPath: '/workspace/project/.codex/skills/review',
    liveKind: null,
    mode: null,
    symlinkTarget: null,
    contentHash: null,
  };
  const liveAfter: UnknownRecord = {
    resourceId: 'resource:live-review',
    role: 'live',
    state: 'present',
    repositoryRevision: resourceRevision(planContentHash),
    placementPath: '/workspace/project/.codex/skills/review',
    liveKind: 'symlink',
    mode: 'pinned',
    symlinkTarget: '/fixture/store/review',
    contentHash: planContentHash,
  };
  const makeJournal = (
    transactionId: string,
    intent: UnknownRecord,
    before: readonly UnknownRecord[],
    after: readonly UnknownRecord[],
    retained: readonly UnknownRecord[] = [],
  ): UnknownRecord => ({
    ...structuredClone(base),
    transactionId,
    intent,
    actual: { before, after, retained },
  });

  const installControl = makeJournal(
    'tx:private-live-control',
    journalIntentFromOperation(operation),
    [ledgerBefore, liveBefore],
    [ledgerAfter, liveAfter],
  );

  const manifestSnapshot: UnknownRecord = {
    version: 1,
    defaults: null,
    registry: null,
    skills: [],
  };
  const manifestIntent: UnknownRecord = {
    operationId: 'operation:write-manifest',
    groupId: 'group:manifest',
    pairId: null,
    kind: 'write-manifest',
    skill: null,
    source: null,
    tool: null,
    scope: null,
    before: {
      kind: 'manifest',
      location: portableManifest,
      shape: 'canonical',
      version: 1,
      byteHash: digest1,
      semanticHash: digest2,
      value: manifestSnapshot,
    },
    after: {
      kind: 'manifest',
      location: portableManifest,
      shape: 'canonical',
      version: 1,
      byteHash: digest3,
      semanticHash: digest2,
      value: manifestSnapshot,
    },
    mutates: { live: false, manifest: true, lock: false, ledger: false },
    reversibility: { kind: 'none', retentionResourceIds: [] },
    conflict: null,
  };
  const manifestControl = makeJournal(
    'tx:private-manifest-control',
    manifestIntent,
    [
      {
        resourceId: 'resource:manifest',
        role: 'manifest',
        state: 'present',
        repositoryRevision: artifactRevision(digest1),
        location: portableManifest,
        shape: 'canonical',
        version: 1,
        byteHash: digest1,
        semanticHash: digest2,
      },
    ],
    [
      {
        resourceId: 'resource:manifest',
        role: 'manifest',
        state: 'present',
        repositoryRevision: artifactRevision(digest3),
        location: portableManifest,
        shape: 'canonical',
        version: 1,
        byteHash: digest3,
        semanticHash: digest2,
      },
    ],
  );

  const lockSnapshot: UnknownRecord = {
    version: 1,
    hashSchemaVersion: 1,
    manifestHash: digest2,
    skills: [],
  };
  const lockIntent: UnknownRecord = {
    operationId: 'operation:write-lock',
    groupId: 'group:lock',
    pairId: null,
    kind: 'write-lock',
    skill: null,
    source: null,
    tool: null,
    scope: null,
    before: {
      kind: 'lock',
      location: portableLock,
      version: 1,
      canonicalHash: digest1,
      value: lockSnapshot,
    },
    after: {
      kind: 'lock',
      location: portableLock,
      version: 1,
      canonicalHash: digest3,
      value: lockSnapshot,
    },
    mutates: { live: false, manifest: false, lock: true, ledger: false },
    reversibility: { kind: 'none', retentionResourceIds: [] },
    conflict: null,
  };
  const lockControl = makeJournal(
    'tx:private-lock-control',
    lockIntent,
    [
      {
        resourceId: 'resource:lock',
        role: 'lock',
        state: 'present',
        repositoryRevision: artifactRevision(digest1),
        location: portableLock,
        version: 1,
        canonicalHash: digest1,
      },
    ],
    [
      {
        resourceId: 'resource:lock',
        role: 'lock',
        state: 'present',
        repositoryRevision: artifactRevision(digest3),
        location: portableLock,
        version: 1,
        canonicalHash: digest3,
      },
    ],
  );

  const updateIntent = journalIntentFromOperation(operation);
  updateIntent.kind = 'update';
  updateIntent.before = structuredClone(operation.after);
  updateIntent.after = structuredClone(operation.after);
  (updateIntent.source as UnknownRecord).contentHash = digest4;
  ((updateIntent.after as UnknownRecord).source as UnknownRecord).contentHash = digest4;
  (updateIntent.after as UnknownRecord).contentHash = digest4;
  updateIntent.reversibility = {
    kind: 'reversible',
    retentionResourceIds: ['resource:backup-live'],
  };
  const retainedControl = makeJournal(
    'tx:private-retained-control',
    updateIntent,
    [ledgerBefore, { ...liveAfter, repositoryRevision: resourceRevision(planContentHash) }],
    [
      ledgerAfter,
      {
        ...liveAfter,
        repositoryRevision: resourceRevision(digest4),
        contentHash: digest4,
      },
    ],
    [
      {
        resourceId: 'resource:backup-live',
        role: 'backup',
        sourceRole: 'live',
        path: '/fixture/backups/review',
        repositoryRevision: resourceRevision(planContentHash),
        contentHash: planContentHash,
        retainUntil: null,
      },
    ],
  );

  return [
    {
      id: 'live-parent-inode',
      control: installControl,
      containerPath: ['actual', 'before', 1],
      privateField: 'parentInode',
    },
    {
      id: 'live-ownership-token',
      control: installControl,
      containerPath: ['actual', 'after', 1],
      privateField: 'ownershipToken',
    },
    {
      id: 'manifest-object-slot',
      control: manifestControl,
      containerPath: ['actual', 'before', 0],
      privateField: 'objectSlot',
    },
    {
      id: 'manifest-cas-collision-path',
      control: manifestControl,
      containerPath: ['actual', 'after', 0],
      privateField: 'collisionPath',
    },
    {
      id: 'lock-transaction-directory',
      control: lockControl,
      containerPath: ['actual', 'before', 0],
      privateField: 'transactionDirectory',
    },
    {
      id: 'lock-retry-cap',
      control: lockControl,
      containerPath: ['actual', 'after', 0],
      privateField: 'retryCap',
    },
    {
      id: 'retained-ownership-token',
      control: retainedControl,
      containerPath: ['actual', 'retained', 0],
      privateField: 'ownershipToken',
    },
  ];
};

const recordAtPath = (root: UnknownRecord, path: readonly (string | number)[]): UnknownRecord => {
  let current: unknown = root;
  for (const segment of path) {
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current as UnknownRecord;
};

const typescriptFiles = (root: string): readonly string[] =>
  readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return typescriptFiles(path);
      return entry.isFile() && /\.tsx?$/u.test(entry.name) ? [path] : [];
    })
    .sort();

describe('EWP-P2-TS08 — persisted artifact codecs and compatibility', () => {
  test('EWP-P2-TS08 family 1: literal inventory and golden preguards pass independently', () => {
    expect(inventory.schemaVersion).toBe(1);
    expect(inventory.artifactCount).toBe(6);
    expect(inventory.goldenByteTotal).toBe(24_594);
    expect(inventory.artifacts.map(({ identity }) => identity)).toEqual(EXPECTED_IDENTITIES);
    expect(new Set(inventory.artifacts.map(({ identity }) => identity)).size).toBe(6);
    expect(Object.keys(EXPECTED_GOLDENS).sort()).toEqual(
      inventory.artifacts.map(({ golden }) => golden.file).sort(),
    );

    let total = 0;
    for (const entry of inventory.artifacts) {
      const expected = EXPECTED_GOLDENS[entry.golden.file as keyof typeof EXPECTED_GOLDENS];
      expect(expected, entry.identity).toBeDefined();
      const bytes = fixtureBytes(entry.golden.file);
      total += bytes.byteLength;
      expect(entry.identity).toBe(`${entry.id}@${entry.version}`);
      expect(bytes.byteLength, entry.identity).toBe(expected?.bytes);
      expect(entry.golden.byteLength, entry.identity).toBe(expected?.bytes);
      expect(rawSha256(bytes), entry.identity).toBe(expected?.sha256);
      expect(entry.golden.sha256, entry.identity).toBe(expected?.sha256);
      expect(bytes[bytes.byteLength - 1] === 0x0a, `${entry.identity} final LF`).toBe(
        entry.terminalLf,
      );
      expect(new TextDecoder().decode(bytes)).not.toContain(SECRET_CANARY);

      if (entry.syntax === 'json') {
        expect(bytes, `${entry.identity} literal JSON formatting`).toEqual(
          jsonCanonicalBytes(bytes, entry.terminalLf),
        );
        const parsed = JSON.parse(new TextDecoder().decode(bytes)) as UnknownRecord;
        expect(parsed.schemaVersion).toBe(entry.version);
        expect(parsed.kind).toBe(entry.wireKind);
      } else {
        const parsed = Bun.TOML.parse(new TextDecoder().decode(bytes)) as UnknownRecord;
        expect(parsed.version).toBe(entry.version);
      }
    }
    expect(total).toBe(inventory.goldenByteTotal);
    expect(EMPTY_MANIFEST.byteLength).toBe(12);
    expect(rawSha256(EMPTY_MANIFEST)).toBe(EMPTY_MANIFEST_SHA256);

    const manifest = Bun.TOML.parse(
      readFileSync(join(FIXTURES, 'manifest-v1.golden.toml'), 'utf8'),
    ) as UnknownRecord;
    expect(Object.keys(manifest)).toEqual(['version', 'defaults', 'registry', 'skills']);
    expect((manifest.skills as readonly UnknownRecord[]).map(({ name }) => name)).toEqual([
      'lint',
      'review',
    ]);
    const lock = Bun.TOML.parse(
      readFileSync(join(FIXTURES, 'lock-v1.golden.toml'), 'utf8'),
    ) as UnknownRecord;
    expect(Object.keys(lock)).toEqual([
      'version',
      'hash_schema_version',
      'manifest_hash',
      'skills',
    ]);
    expect((lock.skills as readonly UnknownRecord[]).map(({ name }) => name)).toEqual([
      'lint',
      'review',
    ]);

    const plan = JSON.parse(
      readFileSync(join(FIXTURES, 'plan-v1.golden.json'), 'utf8'),
    ) as UnknownRecord;
    expect(Object.keys(plan)).toEqual([
      'schemaVersion',
      'kind',
      'skillsmithVersion',
      'executorSchemaVersion',
      'hashSchemaVersion',
      'portability',
      'artifactPair',
      'manifestSemanticHash',
      'lockCanonicalHash',
      'options',
      'selection',
      'operations',
      'checks',
      'diagnostics',
      'resourcePreconditions',
      'selectionPreconditions',
      'capabilityPreconditions',
    ]);
    expect((plan.operations as readonly UnknownRecord[]).map(({ kind }) => kind)).toEqual([
      'install',
    ]);
    expect(plan.checks as readonly unknown[]).toHaveLength(5);

    const ledgerV1 = JSON.parse(
      readFileSync(join(FIXTURES, 'ledger-v1.golden.json'), 'utf8'),
    ) as UnknownRecord;
    expect(Object.keys(ledgerV1)).toEqual([
      'schemaVersion',
      'kind',
      'updatedAt',
      'skills',
      'projects',
    ]);
    expect(JSON.stringify(ledgerV1)).toContain('legacy:review-install');
    expect(JSON.stringify(ledgerV1)).toContain('legacy:lint-dev');
    const ledgerV2 = JSON.parse(
      readFileSync(join(FIXTURES, 'ledger-v2.golden.json'), 'utf8'),
    ) as UnknownRecord;
    expect(Object.keys(ledgerV2)).toEqual([
      'schemaVersion',
      'kind',
      'updatedAt',
      'skills',
      'projects',
      'projectRegistrations',
      'transactions',
      'history',
    ]);
    expect(Object.keys(ledgerV2.projectRegistrations as UnknownRecord)).toEqual([
      '/workspace/project',
    ]);
    expect(Object.keys(ledgerV2.transactions as UnknownRecord)).toEqual(['tx:migrate-ledger-live']);
    expect(ledgerV2.history as readonly unknown[]).toHaveLength(1);
    const journal = JSON.parse(
      readFileSync(join(FIXTURES, 'journal-v1.golden.json'), 'utf8'),
    ) as UnknownRecord;
    expect(Object.keys(journal)).toEqual([
      'schemaVersion',
      'kind',
      'transactionId',
      'intent',
      'context',
      'disposition',
      'phase',
      'actual',
      'updatedAt',
      'completedAt',
    ]);
    expect(journal.phase).toBe('committed');
    expect(Object.keys(journal)).not.toContain('cursor');
    expect(JSON.stringify(journal)).not.toMatch(/recovery|stagingPath|backupPath/iu);

    expect(fuzzCorpus.schemaVersion).toBe(1);
    expect(fuzzCorpus.cases).toHaveLength(EXPECTED_FUZZ_IDS.length);
    expect(fuzzCorpus.cases.map(({ id }) => id)).toEqual(EXPECTED_FUZZ_IDS);
    expect(new Set(fuzzCorpus.cases.map(({ id }) => id)).size).toBe(EXPECTED_FUZZ_IDS.length);
    expect(new Set(fuzzCorpus.cases.map(({ artifact }) => artifact))).toEqual(
      new Set(['manifest', 'lock', 'plan', 'ledger', 'journal']),
    );
    for (const fixture of fuzzCorpus.cases) {
      expect(fixture.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
      expect(['malformed', 'invalid-shape', 'unsupported-version', 'noncanonical']).toContain(
        fixture.expectedReason,
      );
      expect(() => fuzzBytes(fixture), fixture.id).not.toThrow();
    }
    expect(
      fuzzCorpus.cases
        .filter(({ expectedReason }) => expectedReason === 'noncanonical')
        .map(({ id }) => id),
    ).toEqual([
      'lock-noncanonical-missing-lf',
      'lock-noncanonical-key-order',
      'plan-noncanonical-missing-lf',
      'plan-noncanonical-indent-drift',
      'ledger-v2-noncanonical-missing-lf',
      'ledger-v2-noncanonical-key-order',
      'journal-noncanonical-missing-lf',
      'journal-noncanonical-key-order',
    ]);
    for (const id of FINAL_LF_NONCANONICAL_IDS) {
      const fixture = fuzzCorpus.cases.find((candidate) => candidate.id === id);
      expect(fixture, id).toBeDefined();
      if (fixture === undefined) continue;
      const bytes = fuzzBytes(fixture);
      expect(bytes.at(-1), `${id} preserves final LF`).toBe(0x0a);
      expect(() => {
        const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (fixture.artifact === 'lock') Bun.TOML.parse(source);
        else JSON.parse(source);
      }, `${id} remains syntactically valid`).not.toThrow();
    }
    expect(
      fuzzCorpus.cases.filter(({ id }) => /unknown-nested|private-nested/u.test(id)),
    ).toHaveLength(6);
  });

  test('EWP-P2-TS08 family 2: registry parity and artifact round trips own canonical bytes', async () => {
    const { core, registry } = await requireRegistry();
    expect(registry.codecs).toHaveLength(6);
    expect(registry.codecs.map(({ descriptor }) => descriptor)).toEqual(
      inventory.artifacts.map(descriptorFromInventory),
    );
    assertRecursivelyFrozen(registry);
    expect(core.artifactContractRegistry).toBe(registry);
    for (const [index, entry] of inventory.artifacts.entries()) {
      const codec = registry.get(entry.id, entry.version);
      expect(codec, entry.identity).toBe(registry.codecs[index]);
      expect(codec?.descriptor).toEqual(descriptorFromInventory(entry));
    }
    expect(registry.latest('manifest')).toBe(registry.get('manifest', 1));
    expect(registry.latest('ledger')).toBe(registry.get('ledger', 2));
    expect(registry.get('ledger', 3)).toBeUndefined();

    const cases = [
      ...inventory.artifacts.map((entry) => ({
        identity: entry.identity,
        id: entry.id,
        version: entry.version,
        bytes: fixtureBytes(entry.golden.file),
        terminalLf: entry.terminalLf,
      })),
      {
        identity: 'manifest@1 empty',
        id: 'manifest' as const,
        version: 1 as const,
        bytes: EMPTY_MANIFEST,
        terminalLf: true,
      },
    ];

    for (const fixture of cases) {
      const codec = registry.get(fixture.id, fixture.version);
      expect(codec, fixture.identity).toBeDefined();
      if (codec === undefined) continue;
      const mutableInput = new Uint8Array(fixture.bytes);
      const decoded = unwrap(codec.decode(mutableInput), `${fixture.identity} decode`);
      mutableInput.fill(0x78);
      assertRecursivelyFrozen(decoded.model);
      const dto = unwrap(codec.toDto(decoded.model), `${fixture.identity} toDto`);
      assertRecursivelyFrozen(dto);
      expect(codec.validate(dto).ok, `${fixture.identity} DTO validation`).toBeTrue();
      const mapped = unwrap(codec.fromDto(dto), `${fixture.identity} fromDto`);
      const encoded = unwrap(codec.encode(mapped), `${fixture.identity} encode`);
      expect(encoded, `${fixture.identity} byte parity`).toEqual(fixture.bytes);
      expect(encoded, `${fixture.identity} owned output`).not.toBe(fixture.bytes);
      expect(encoded.buffer, `${fixture.identity} non-shared output`).not.toBe(
        fixture.bytes.buffer,
      );
      expect(encoded[encoded.byteLength - 1] === 0x0a, fixture.identity).toBe(fixture.terminalLf);
    }
  });

  test('EWP-P2-TS08 family 3: ledger migration preserves facts and semantic identity', async () => {
    const { core, registry } = await requireRegistry();
    const v2 = await loadModule(V2_MODULE);
    const migrate = v2.migrateLedgerV1DtoToV2Dto;
    expect(typeof migrate, 'ledger v1-to-v2 DTO migration is absent').toBe('function');
    if (typeof migrate !== 'function') return;

    const ledgerV1Dto = JSON.parse(
      readFileSync(join(FIXTURES, 'ledger-v1.golden.json'), 'utf8'),
    ) as UnknownRecord;
    const migrated = unwrap(
      migrate(ledgerV1Dto) as Result<UnknownRecord>,
      'ledger v1-to-v2 migration',
    );
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.updatedAt).toBe(ledgerV1Dto.updatedAt);
    expect(migrated.skills).toEqual(ledgerV1Dto.skills);
    expect(migrated.projects).toEqual(ledgerV1Dto.projects);
    expect(migrated.projectRegistrations).toEqual({
      '/workspace/project': {
        consumers: [
          {
            skill: 'lint',
            tool: 'claude-code',
            placementPath: '/workspace/project/.claude/skills/lint',
            store: {
              path: '/home/fixture/.local/share/skillsmith/store/lint',
              contentHash:
                'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            },
          },
        ],
      },
    });
    expect(migrated.transactions).toEqual({});
    expect(migrated.history).toEqual([]);
    expect(JSON.stringify(migrated)).toContain('legacy:review-install');
    expect(JSON.stringify(migrated)).toContain('legacy:lint-dev');

    const ledgerV2 = registry.get('ledger', 2);
    expect(ledgerV2).toBeDefined();
    if (ledgerV2 === undefined) return;
    const migratedModel = unwrap(ledgerV2.fromDto(migrated), 'migrated ledger v2 model');
    const migratedBytes = unwrap(ledgerV2.encode(migratedModel), 'migrated ledger v2 bytes');
    const migratedRoundTrip = unwrap(ledgerV2.decode(migratedBytes), 'migrated ledger v2 decode');
    expect(migratedRoundTrip.model).toEqual(migratedModel);

    const readLedgerArtifact = core.readLedgerArtifact;
    expect(typeof readLedgerArtifact, 'ledger repository read is absent').toBe('function');
    if (typeof readLedgerArtifact !== 'function') return;
    const read = async (bytes: Uint8Array): Promise<UnknownRecord> => {
      const result = (await readLedgerArtifact(
        {
          pathKind: async () => 'file',
          readBytes: async () => new Uint8Array(bytes),
        },
        '/fixture/placements.json',
      )) as Result<UnknownRecord>;
      return unwrap(result, 'repository ledger read');
    };
    const sourceEnvelope = await read(fixtureBytes('ledger-v1.golden.json'));
    const targetEnvelope = await read(migratedBytes);
    expect(sourceEnvelope.semanticRevision).toBe(targetEnvelope.semanticRevision);
    expect((sourceEnvelope.migration as UnknownRecord).targetSemanticRevision).toBe(
      targetEnvelope.semanticRevision,
    );

    const independentV2 = unwrap(
      ledgerV2.decode(fixtureBytes('ledger-v2.golden.json')),
      'independent ledger v2 golden',
    );
    const independentDto = unwrap(ledgerV2.toDto(independentV2.model), 'ledger v2 DTO');
    const independent = independentDto as UnknownRecord;
    expect(Object.keys(independent.transactions as UnknownRecord)).toEqual([
      'tx:migrate-ledger-live',
    ]);
    expect(independent.history as readonly unknown[]).toHaveLength(1);
    expect((independent.history as readonly UnknownRecord[])[0]?.phase).toBe('committed');
  });

  test('EWP-P2-TS08 family 4: malformed and hostile inputs refuse without throwing or leaking', async () => {
    const { registry } = await requireRegistry();
    for (const fixture of fuzzCorpus.cases) {
      const codec = registry.get(fixture.artifact, fixture.codecVersion);
      expect(codec, fixture.id).toBeDefined();
      if (codec === undefined) continue;
      let result: Result<Decoded> | undefined;
      expect(() => {
        result = codec.decode(fuzzBytes(fixture));
      }, fixture.id).not.toThrow();
      expect(result?.ok, fixture.id).toBeFalse();
      if (result === undefined || result.ok) continue;
      expect(result.error.code, fixture.id).toBe('artifact-codec');
      expect(result.error.reason, fixture.id).toBe(fixture.expectedReason);
      expect(result.error.exitCode, fixture.id).toBe(3);
      expect(JSON.stringify(result.error), fixture.id).not.toContain(SECRET_CANARY);
      const path = result.error.path as readonly unknown[];
      expect(Array.isArray(path), fixture.id).toBeTrue();
      expect(path.length, fixture.id).toBeLessThanOrEqual(16);
    }

    const accessor = Object.defineProperty({}, 'schemaVersion', {
      enumerable: true,
      get() {
        throw new Error(SECRET_CANARY);
      },
    });
    const sparse = new Array(2);
    sparse[1] = 1;
    const hostiles: readonly unknown[] = [
      new Proxy(
        {},
        {
          get: () => {
            throw new Error(SECRET_CANARY);
          },
        },
      ),
      accessor,
      sparse,
      Object.create({ inherited: true }),
      1n,
      Symbol(SECRET_CANARY),
    ];
    for (const [codecIndex, codec] of registry.codecs.entries()) {
      for (const [hostileIndex, hostile] of hostiles.entries()) {
        let result: Result<unknown> | undefined;
        expect(() => {
          result = codec.validate(hostile);
        }, `${codecIndex}:${hostileIndex}`).not.toThrow();
        expect(result?.ok, `${codecIndex}:${hostileIndex}`).toBeFalse();
        if (result !== undefined && !result.ok) {
          expect(result.error.reason).toBe('invalid-shape');
          expect(JSON.stringify(result.error)).not.toContain(SECRET_CANARY);
        }
      }
    }

    for (const entry of inventory.artifacts) {
      const codec = registry.get(entry.id, entry.version);
      expect(codec, `${entry.identity} prototype-key codec`).toBeDefined();
      if (codec === undefined) continue;
      const decoded = unwrap(codec.decode(fixtureBytes(entry.golden.file)), entry.identity);
      const dto = unwrap(codec.toDto(decoded.model), `${entry.identity} prototype-key DTO`);
      const poisoned = structuredClone(dto) as UnknownRecord;
      Object.defineProperty(poisoned, '__proto__', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: { polluted: true },
      });
      const result = codec.validate(poisoned);
      expect(result.ok, `${entry.identity} prototype-key refusal`).toBeFalse();
      if (!result.ok) expect(result.error.reason).toBe('invalid-shape');
      expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    }

    for (const entry of inventory.artifacts) {
      const codec = registry.get(entry.id, entry.version);
      expect(codec, `${entry.identity} precedence codec`).toBeDefined();
      if (codec === undefined) continue;
      const decoded = unwrap(codec.decode(fixtureBytes(entry.golden.file)), entry.identity);
      const dto = unwrap(codec.toDto(decoded.model), `${entry.identity} precedence DTO`);

      const sensitiveUnknown = structuredClone(dto) as UnknownRecord;
      Object.defineProperty(sensitiveUnknown, 'ghp_P17_SECRET_CANARY_123456789', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: SECRET_CANARY,
      });
      const unknownResult = codec.validate(sensitiveUnknown);
      expect(unknownResult.ok, `${entry.identity} shape before sensitivity`).toBeFalse();
      if (!unknownResult.ok) {
        expect(unknownResult.error.reason, entry.identity).toBe('invalid-shape');
        expect(JSON.stringify(unknownResult.error), entry.identity).not.toContain(SECRET_CANARY);
      }

      const invalidDiscriminator = structuredClone(dto) as UnknownRecord;
      invalidDiscriminator[entry.syntax === 'json' ? 'schemaVersion' : 'version'] = SECRET_CANARY;
      const discriminatorResult = codec.validate(invalidDiscriminator);
      expect(discriminatorResult.ok, `${entry.identity} grammar before sensitivity`).toBeFalse();
      if (!discriminatorResult.ok) {
        expect(discriminatorResult.error.reason, entry.identity).toBe('invalid-shape');
        expect(JSON.stringify(discriminatorResult.error), entry.identity).not.toContain(
          SECRET_CANARY,
        );
      }
    }

    const journalCodec = registry.get('journal', 1);
    expect(journalCodec, 'journal private-field codec').toBeDefined();
    if (journalCodec !== undefined) {
      for (const probe of journalPrivateProbes()) {
        const control = journalCodec.validate(probe.control);
        expect(control.ok, `${probe.id} valid control`).toBeTrue();
        const poisoned = structuredClone(probe.control) as UnknownRecord;
        recordAtPath(poisoned, probe.containerPath)[probe.privateField] = 'private-mechanics';
        const result = journalCodec.validate(poisoned);
        expect(result.ok, probe.id).toBeFalse();
        if (!result.ok) {
          expect(result.error.reason, probe.id).toBe('invalid-shape');
          expect(JSON.stringify(result.error), probe.id).not.toContain('private-mechanics');
        }
      }
    }
    if (journalCodec !== undefined) {
      const decoded = unwrap(
        journalCodec.decode(fixtureBytes('journal-v1.golden.json')),
        'journal precedence decode',
      );
      const candidate = structuredClone(
        unwrap(journalCodec.toDto(decoded.model), 'journal precedence DTO'),
      ) as UnknownRecord;
      ((candidate.intent as UnknownRecord).operationId as unknown) = SECRET_CANARY;
      ((candidate.actual as UnknownRecord).after as unknown[]) = [];
      const result = journalCodec.validate(candidate);
      expect(result.ok, 'journal relationships precede sensitivity').toBeFalse();
      if (!result.ok) expect(result.error.reason).toBe('invalid-shape');
    }
    const ledgerV2Codec = registry.get('ledger', 2);
    expect(ledgerV2Codec).toBeDefined();
    if (ledgerV2Codec !== undefined) {
      const candidate = JSON.parse(
        readFileSync(join(FIXTURES, 'ledger-v2.golden.json'), 'utf8'),
      ) as UnknownRecord;
      const transactions = candidate.transactions as UnknownRecord;
      const transaction = transactions['tx:migrate-ledger-live'] as UnknownRecord;
      (transaction.context as UnknownRecord).command = SECRET_CANARY;
      ((candidate.history as UnknownRecord[])[0] as UnknownRecord).phase = 'live';
      const result = ledgerV2Codec.validate(candidate);
      expect(result.ok, 'ledger relationships precede whole-artifact sensitivity').toBeFalse();
      if (!result.ok) expect(result.error.reason).toBe('invalid-shape');
    }
  });

  test('EWP-P2-TS08 family 4b: saved-plan relationships fail closed', async () => {
    const { registry } = await requireRegistry();
    const planCodec = registry.get('plan', 1);
    expect(planCodec).toBeDefined();
    if (planCodec === undefined) return;
    const golden = JSON.parse(
      readFileSync(join(FIXTURES, 'plan-v1.golden.json'), 'utf8'),
    ) as UnknownRecord;
    const migrations = JSON.parse(
      readFileSync(join(ROOT, 'tests/ergonomics/fixtures/p2-ts06/migration-cases.json'), 'utf8'),
    ) as UnknownRecord;
    const savedMigrationPlan = migrations.savedPlan as UnknownRecord;
    const expectValid = (candidate: UnknownRecord, label: string): void => {
      const result = planCodec.validate(candidate);
      expect(result.ok, result.ok ? label : `${label}: ${JSON.stringify(result.error)}`).toBeTrue();
    };
    const expectInvalid = (candidate: UnknownRecord, label: string): void => {
      const result = planCodec.validate(candidate);
      expect(result.ok, label).toBeFalse();
      if (!result.ok) {
        expect(result.error.reason, label).toBe('invalid-shape');
        expect(JSON.stringify(result.error), label).not.toContain(SECRET_CANARY);
      }
    };
    const operationsOf = (plan: UnknownRecord): UnknownRecord[] =>
      plan.operations as UnknownRecord[];
    const resourcesOf = (plan: UnknownRecord): UnknownRecord[] =>
      plan.resourcePreconditions as UnknownRecord[];
    const warningDiagnostic = (
      correlation: UnknownRecord,
      affected: UnknownRecord = {
        skill: 'review',
        source: null,
        tool: 'codex',
        scope: 'project',
        path: null,
      },
    ): UnknownRecord => ({
      diagnosticId: 'diagnostic:relationship-probe',
      kind: 'warning',
      severity: 'warning',
      refusalClass: null,
      affected,
      correlation,
      reason: { code: 'relationship-probe', message: 'relationship probe' },
      selectionSource: 'explicit-targets',
    });

    expectValid(structuredClone(savedMigrationPlan), 'signed migration plan control');
    for (const removedId of ['precondition:manifest-semantic', 'precondition:manifest-bytes']) {
      const candidate = structuredClone(savedMigrationPlan);
      const operation = operationsOf(candidate)[0] as UnknownRecord;
      operation.preconditionIds = (operation.preconditionIds as string[]).filter(
        (id) => id !== removedId,
      );
      expectInvalid(candidate, `project migration requires ${removedId}`);
    }
    {
      const candidate = structuredClone(savedMigrationPlan);
      const bytePrecondition = resourcesOf(candidate).find(
        ({ preconditionId }) => preconditionId === 'precondition:manifest-bytes',
      ) as UnknownRecord;
      (bytePrecondition.expectedHash as UnknownRecord).digest =
        'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
      expectInvalid(candidate, 'project migration byte hash must match its before image');
    }
    {
      const candidate = structuredClone(savedMigrationPlan);
      const operation = operationsOf(candidate)[1] as UnknownRecord;
      operation.preconditionIds = ['precondition:manifest-bytes'];
      expectInvalid(candidate, 'ledger migration requires its ledger-schema precondition');
    }
    {
      const candidate = structuredClone(savedMigrationPlan);
      const ledgerPrecondition = resourcesOf(candidate).find(
        ({ preconditionId }) => preconditionId === 'precondition:ledger-schema-v1',
      ) as UnknownRecord;
      (ledgerPrecondition.expectedRevision as UnknownRecord).digest =
        'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
      expectInvalid(candidate, 'ledger migration revision must match its v1 image');
    }

    const correlated = structuredClone(golden);
    correlated.diagnostics = [
      warningDiagnostic({
        groupId: 'group:review',
        pairId: 'pair:review-codex-project',
        operationId: 'operation:install-review-codex',
      }),
    ];
    expectValid(correlated, 'fully correlated diagnostic control');
    for (const [label, correlation] of [
      [
        'missing group correlation',
        {
          groupId: 'group:missing',
          pairId: 'pair:review-codex-project',
          operationId: 'operation:install-review-codex',
        },
      ],
      [
        'missing pair correlation',
        {
          groupId: 'group:review',
          pairId: 'pair:missing',
          operationId: 'operation:install-review-codex',
        },
      ],
      [
        'missing operation correlation',
        {
          groupId: 'group:review',
          pairId: 'pair:review-codex-project',
          operationId: 'operation:missing',
        },
      ],
      [
        'pair correlation requires a group',
        {
          groupId: null,
          pairId: 'pair:review-codex-project',
          operationId: 'operation:install-review-codex',
        },
      ],
    ] as const) {
      const candidate = structuredClone(golden);
      candidate.diagnostics = [warningDiagnostic(correlation)];
      expectInvalid(candidate, label);
    }
    {
      const candidate = structuredClone(golden);
      const second = structuredClone(operationsOf(candidate)[0] as UnknownRecord);
      second.operationId = 'operation:install-review-codex-second';
      second.groupId = 'group:review-second';
      second.pairId = 'pair:review-codex-project-second';
      operationsOf(candidate).push(second);
      candidate.diagnostics = [
        warningDiagnostic({
          groupId: second.groupId,
          pairId: null,
          operationId: 'operation:install-review-codex',
        }),
      ];
      expectInvalid(candidate, 'operation correlation must agree with its group');
    }

    {
      const candidate = structuredClone(savedMigrationPlan);
      candidate.manifestSemanticHash =
        'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
      expectInvalid(candidate, 'root manifest hash binds the selected current image');
    }
    {
      const candidate = structuredClone(savedMigrationPlan);
      const migration = operationsOf(candidate)[0] as UnknownRecord;
      for (const imageKey of ['before', 'after']) {
        const image = migration[imageKey] as UnknownRecord;
        image.location = { kind: 'portable', token: 'project:other.toml' };
      }
      for (const precondition of resourcesOf(candidate)) {
        if ((precondition.resource as UnknownRecord).kind === 'manifest-bytes') {
          (precondition.resource as UnknownRecord).location = {
            kind: 'portable',
            token: 'project:other.toml',
          };
        }
      }
      candidate.manifestSemanticHash =
        'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
      expectInvalid(candidate, 'migration images cannot bypass the selected manifest pair');
    }
    {
      const candidate = structuredClone(savedMigrationPlan);
      const migration = operationsOf(candidate)[0] as UnknownRecord;
      const after = migration.after as UnknownRecord;
      after.semanticHash =
        'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
      expectInvalid(candidate, 'project migration preserves semantic identity');
    }
    {
      const candidate = structuredClone(savedMigrationPlan);
      const migration = operationsOf(candidate)[1] as UnknownRecord;
      const after = migration.after as UnknownRecord;
      after.projectRoot = { kind: 'portable', token: 'project:other-root' };
      expectInvalid(candidate, 'ledger migration preserves project identity');
    }

    {
      const candidate = structuredClone(golden);
      const selection = (candidate.selectionPreconditions as UnknownRecord[])[0] as UnknownRecord;
      const member = (selection.members as UnknownRecord[])[0] as UnknownRecord;
      (member.resourceHash as UnknownRecord).domain = 'source-content';
      expectInvalid(candidate, 'selection member hashes match their resource domains');
    }
    {
      const candidate = structuredClone(golden);
      const capabilityCheck = (candidate.checks as UnknownRecord[]).find(
        ({ kind }) => kind === 'capability',
      ) as UnknownRecord;
      capabilityCheck.capabilityPreconditionId = 'precondition:live-absent';
      expectInvalid(candidate, 'capability checks resolve within the capability family');
    }
    {
      const candidate = structuredClone(golden);
      (candidate.artifactPair as UnknownRecord).manifest = {
        kind: 'portable',
        token: '/workspace/private/skills.toml',
      };
      expectInvalid(candidate, 'portable location tags cannot hide absolute paths');
    }
    for (const token of [
      'https://example.com/skills.toml',
      '../outside/skills.toml',
      'project:../outside/skills.toml',
    ]) {
      const candidate = structuredClone(golden);
      (candidate.artifactPair as UnknownRecord).manifest = { kind: 'portable', token };
      expectInvalid(candidate, `portable location rejects URL or escape spelling: ${token}`);
    }
    {
      const candidate = structuredClone(golden);
      (candidate.artifactPair as UnknownRecord).manifest = {
        kind: 'machine-bound',
        path: 'project:relative-manifest',
      };
      candidate.portability = {
        kind: 'machine-bound',
        reasons: [
          {
            code: 'absolute-artifact-selector',
            message: 'plan binds an absolute artifact selector',
            path: 'project:relative-manifest',
            preconditionIds: ['precondition:live-absent'],
          },
        ],
      };
      expectInvalid(candidate, 'machine-bound location tags require absolute paths');
    }
    {
      const candidate = structuredClone(golden);
      const operation = operationsOf(candidate)[0] as UnknownRecord;
      const sources = [
        operation.source as UnknownRecord,
        (operation.after as UnknownRecord).source as UnknownRecord,
        ...(candidate.checks as UnknownRecord[]).flatMap((check) =>
          check.kind === 'source-resolution' || check.kind === 'content-integrity'
            ? [check.source as UnknownRecord]
            : [],
        ),
      ];
      for (const source of sources) {
        (source.identity as UnknownRecord).host = 'https://git.example.com/team/skills.git';
      }
      expectInvalid(candidate, 'portable sources require canonical credential-free identities');
    }
    {
      const candidate = structuredClone(golden);
      const source = (operationsOf(candidate)[0] as UnknownRecord).source as UnknownRecord;
      source.sourcePath = 'different/path';
      expectInvalid(candidate, 'portable source paths match canonical source identity');
    }
    const lockCodec = registry.get('lock', 1);
    expect(lockCodec).toBeDefined();
    if (lockCodec === undefined) return;
    const lockDecoded = unwrap(
      lockCodec.decode(fixtureBytes('lock-v1.golden.toml')),
      'lock relationship control decode',
    );
    const lockValue = unwrap(lockCodec.toDto(lockDecoded.model), 'lock relationship control DTO');
    const lockControl = structuredClone(golden);
    operationsOf(lockControl).push({
      operationId: 'operation:write-lock',
      groupId: 'group:write-lock',
      pairId: null,
      kind: 'write-lock',
      dependsOn: [],
      skill: null,
      source: null,
      tool: null,
      scope: null,
      before: {
        kind: 'lock',
        location: structuredClone((lockControl.artifactPair as UnknownRecord).lock),
        version: 1,
        canonicalHash: lockControl.lockCanonicalHash,
        value: lockValue,
      },
      after: {
        kind: 'lock',
        location: structuredClone((lockControl.artifactPair as UnknownRecord).lock),
        version: 1,
        canonicalHash: lockControl.lockCanonicalHash,
        value: lockValue,
      },
      reason: { code: 'write-lock', message: 'write lock' },
      selectionSource: 'explicit-targets',
      preconditionIds: [],
      requiredCheckIds: [],
      reversibility: { kind: 'none', retentionResourceIds: [] },
      mutates: { live: false, manifest: false, lock: true, ledger: false },
      conflict: null,
    });
    expectValid(lockControl, 'root lock hash control');
    {
      const candidate = structuredClone(lockControl);
      candidate.lockCanonicalHash =
        'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
      expectInvalid(candidate, 'root lock hash binds the selected current image');
    }
    {
      const candidate = structuredClone(lockControl);
      const operation = operationsOf(candidate).find(
        ({ kind }) => kind === 'write-lock',
      ) as UnknownRecord;
      (operation.before as UnknownRecord).location = {
        kind: 'portable',
        token: 'project:other.lock',
      };
      (operation.after as UnknownRecord).location = {
        kind: 'portable',
        token: 'project:other.lock',
      };
      expectInvalid(candidate, 'lock operations cannot bypass the selected artifact pair');
    }
    const absentLock = structuredClone(golden);
    absentLock.lockCanonicalHash = null;
    resourcesOf(absentLock).push({
      preconditionId: 'precondition:lock-absent',
      resource: {
        kind: 'lock',
        location: structuredClone((absentLock.artifactPair as UnknownRecord).lock),
      },
      expectedState: 'absent',
      expectedHash: {
        domain: 'lock-canonical',
        hashSchemaVersion: 1,
        digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      },
      expectedRevision: null,
    });
    expectValid(absentLock, 'null root lock hash with absent precondition control');
    {
      const candidate = structuredClone(absentLock);
      candidate.resourcePreconditions = resourcesOf(candidate).filter(
        ({ preconditionId }) => preconditionId !== 'precondition:lock-absent',
      );
      expectInvalid(candidate, 'null root lock hash requires an absent precondition');
    }
    {
      const candidate = structuredClone(absentLock);
      const precondition = resourcesOf(candidate).find(
        ({ preconditionId }) => preconditionId === 'precondition:lock-absent',
      ) as UnknownRecord;
      (precondition.resource as UnknownRecord).location = {
        kind: 'portable',
        token: 'project:other.lock',
      };
      expectInvalid(candidate, 'null root lock hash binds absence at the selected lock');
    }

    const machineReason = (code: string, message: string, path: string): UnknownRecord => ({
      code,
      message,
      path,
      preconditionIds: ['precondition:live-absent'],
    });
    const machineControl = (
      code: string,
      message: string,
      path: string,
      mutate: (plan: UnknownRecord) => void,
    ): UnknownRecord => {
      const candidate = structuredClone(golden);
      mutate(candidate);
      candidate.portability = {
        kind: 'machine-bound',
        reasons: [machineReason(code, message, path)],
      };
      return candidate;
    };
    const machineCases = [
      machineControl(
        'absolute-artifact-selector',
        'plan binds an absolute artifact selector',
        '/workspace/skills.toml',
        (plan) => {
          (plan.artifactPair as UnknownRecord).manifest = {
            kind: 'machine-bound',
            path: '/workspace/skills.toml',
          };
        },
      ),
      machineControl(
        'local-project-root',
        'plan binds a local project root',
        '/workspace/project',
        (plan) => {
          const location = { kind: 'machine-bound', path: '/workspace/project' };
          for (const operation of operationsOf(plan)) {
            for (const key of ['before', 'after']) {
              const image = operation[key] as UnknownRecord;
              const resource = image.resource as UnknownRecord;
              resource.projectRoot = structuredClone(location);
            }
          }
          for (const precondition of resourcesOf(plan)) {
            (precondition.resource as UnknownRecord).projectRoot = structuredClone(location);
          }
          for (const precondition of plan.selectionPreconditions as UnknownRecord[]) {
            for (const member of precondition.members as UnknownRecord[]) {
              (member.resource as UnknownRecord).projectRoot = structuredClone(location);
            }
          }
        },
      ),
      machineControl(
        'local-dev-source',
        'plan binds a local development source',
        '/workspace/dev-skill',
        (plan) => {
          plan.diagnostics = [
            warningDiagnostic(
              { groupId: null, pairId: null, operationId: null },
              {
                skill: null,
                source: {
                  kind: 'local-dev',
                  path: '/workspace/dev-skill',
                  contentHash:
                    'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
                },
                tool: null,
                scope: null,
                path: null,
              },
            ),
          ];
        },
      ),
      machineControl(
        'absolute-live-placement',
        'plan binds an absolute live placement',
        '/workspace/.codex/skills/review',
        (plan) => {
          const location = {
            kind: 'machine-bound',
            path: '/workspace/.codex/skills/review',
          };
          for (const operation of operationsOf(plan)) {
            for (const key of ['before', 'after']) {
              const image = operation[key] as UnknownRecord;
              (image.resource as UnknownRecord).location = structuredClone(location);
            }
          }
          for (const precondition of resourcesOf(plan)) {
            (precondition.resource as UnknownRecord).location = structuredClone(location);
          }
          for (const precondition of plan.selectionPreconditions as UnknownRecord[]) {
            for (const member of precondition.members as UnknownRecord[]) {
              (member.resource as UnknownRecord).location = structuredClone(location);
            }
          }
        },
      ),
      machineControl(
        'custom-absolute-target',
        'plan binds a custom absolute target',
        '/workspace/custom-target',
        (plan) => {
          plan.diagnostics = [
            warningDiagnostic(
              { groupId: null, pairId: null, operationId: null },
              {
                skill: null,
                source: null,
                tool: null,
                scope: null,
                path: { kind: 'machine-bound', path: '/workspace/custom-target' },
              },
            ),
          ];
        },
      ),
    ];
    for (const [index, candidate] of machineCases.entries()) {
      expectValid(candidate, `machine binding code ${index} control`);
    }
    {
      const candidate = structuredClone(savedMigrationPlan);
      const migration = operationsOf(candidate)[0] as UnknownRecord;
      for (const imageKey of ['before', 'after']) {
        const image = migration[imageKey] as UnknownRecord;
        const defaults = (image.value as UnknownRecord).defaults as UnknownRecord;
        defaults.path = '/workspace/skills';
      }
      expectInvalid(candidate, 'portable plans reject absolute manifest snapshot paths');
    }
    {
      const candidate = structuredClone(machineCases[0] as UnknownRecord);
      const reason = ((candidate.portability as UnknownRecord).reasons as UnknownRecord[])[0];
      if (reason === undefined) throw new Error('missing machine reason control');
      reason.message = 'wrong interpolated message';
      expectInvalid(candidate, 'machine reasons use fixed messages');
    }
    {
      const candidate = structuredClone(machineCases[0] as UnknownRecord);
      const reason = ((candidate.portability as UnknownRecord).reasons as UnknownRecord[])[0];
      if (reason === undefined) throw new Error('missing machine reason control');
      reason.preconditionIds = ['precondition:selection'];
      expectInvalid(candidate, 'machine reasons reference resource preconditions only');
    }
    {
      const candidate = structuredClone(machineCases[0] as UnknownRecord);
      (candidate.portability as UnknownRecord).reasons = [];
      expectInvalid(candidate, 'machine bindings require a complete reason bijection');
    }
    {
      const candidate = structuredClone(golden);
      candidate.portability = {
        kind: 'machine-bound',
        reasons: [
          machineReason(
            'absolute-artifact-selector',
            'plan binds an absolute artifact selector',
            '/workspace/extra',
          ),
        ],
      };
      expectInvalid(candidate, 'machine reasons cannot exceed the actual bindings');
    }
  });

  test('EWP-P2-TS08 family 5: determinism, canaries, docs, and parse ownership stay closed', async () => {
    const { registry } = await requireRegistry();
    for (const entry of inventory.artifacts) {
      const codec = registry.get(entry.id, entry.version);
      expect(codec, entry.identity).toBeDefined();
      if (codec === undefined) continue;
      const decoded = unwrap(
        codec.decode(fixtureBytes(entry.golden.file)),
        `${entry.identity} decode`,
      );
      const first = unwrap(codec.encode(decoded.model), `${entry.identity} first encode`);
      const second = unwrap(codec.encode(decoded.model), `${entry.identity} second encode`);
      expect(first).toEqual(second);
      expect(first).not.toBe(second);
      const dto = unwrap(codec.toDto(decoded.model), `${entry.identity} deterministic DTO`);
      const reorderedModel = unwrap(
        codec.fromDto(differentlyOrderedDto(entry.identity, dto)),
        `${entry.identity} reordered DTO`,
      );
      expect(unwrap(codec.encode(reorderedModel), `${entry.identity} reordered encode`)).toEqual(
        first,
      );

      const poisoned = poisonArtifactDto(entry.identity, dto);
      const mapped = codec.fromDto(poisoned);
      const refused = mapped.ok ? codec.encode(mapped.value) : mapped;
      expect(refused.ok, `${entry.identity} sensitive gate`).toBeFalse();
      if (!refused.ok) {
        expect(refused.error.reason, entry.identity).toBe('sensitive-content');
        expect(JSON.stringify(refused.error), entry.identity).not.toContain(SECRET_CANARY);
      }
    }

    for (const [version, file] of [
      [1, 'ledger-v1.golden.json'],
      [2, 'ledger-v2.golden.json'],
    ] as const) {
      const codec = registry.get('ledger', version);
      expect(codec, `ledger@${version} dynamic record codec`).toBeDefined();
      if (codec === undefined) continue;
      const [reviewFirst, alphaFirst] = ledgerRecordOrderVariants(
        JSON.parse(readFileSync(join(FIXTURES, file), 'utf8')),
      );
      const reviewModel = unwrap(codec.fromDto(reviewFirst), `ledger@${version} review-first`);
      const alphaModel = unwrap(codec.fromDto(alphaFirst), `ledger@${version} alpha-first`);
      const reviewBytes = unwrap(
        codec.encode(reviewModel),
        `ledger@${version} review-first encode`,
      );
      const alphaBytes = unwrap(codec.encode(alphaModel), `ledger@${version} alpha-first encode`);
      expect(reviewBytes).toEqual(alphaBytes);
      const source = new TextDecoder().decode(reviewBytes);
      expect(source.indexOf('"alpha"')).toBeLessThan(source.indexOf('"review"'));
    }

    const wireAuthority = await loadModule(WIRE_AUTHORITY_MODULE);
    const wireRegistry = wireAuthority.currentWireContractRegistry as
      | DescriptorRegistry
      | undefined;
    expect(wireRegistry, 'signed WireCodec registry is absent').toBeDefined();
    if (wireRegistry !== undefined) {
      const wireDescriptors = wireRegistry.codecs.map(({ descriptor }) => descriptor);
      const artifactDescriptors = registry.codecs.map(({ descriptor }) => descriptor);
      const combinedProductionDescriptors = [...wireDescriptors, ...artifactDescriptors];
      const generatedInventory = combinedProductionDescriptors.map(
        ({ id, version }) => `${id}@${version}`,
      );
      expect(wireDescriptors.map(({ id, version }) => `${id}@${version}`)).toEqual(
        EXPECTED_WIRE_IDENTITIES,
      );
      expect(generatedInventory).toEqual([...EXPECTED_WIRE_IDENTITIES, ...EXPECTED_IDENTITIES]);
      expect(new Set(generatedInventory).size).toBe(generatedInventory.length);
      for (const [index, descriptor] of combinedProductionDescriptors.entries()) {
        const owned =
          index < wireDescriptors.length
            ? wireRegistry.codecs[index]?.descriptor
            : registry.codecs[index - wireDescriptors.length]?.descriptor;
        expect(descriptor, `combined descriptor ${index} is derived by identity`).toBe(owned);
      }
    }

    const docs = [
      ['CHANGELOG.md', /artifact contract|persisted artifact/iu],
      ['docs/adr/0008-wire-contract-registry.md', /ArtifactCodec/u],
      ['docs/architecture.md', /artifactContractRegistry/u],
      ['packages/core/README.md', /persisted artifact|artifact codec/iu],
    ] as const;
    for (const [path, pattern] of docs) {
      const source = readFileSync(join(ROOT, path), 'utf8');
      expect(source, path).toMatch(pattern);
    }

    const parseFree = [
      'packages/core/src/artifacts/index.ts',
      'packages/core/src/artifacts/registry.ts',
      'packages/core/src/artifacts/repository.ts',
      'packages/core/src/artifacts/migration-executor.ts',
      'packages/core/src/contracts/index.d.ts',
      'packages/core/src/contracts/index.ts',
      'packages/core/src/contracts/v1/index.d.ts',
      'packages/core/src/contracts/v1/index.ts',
      'packages/core/src/contracts/v2/index.d.ts',
      'packages/core/src/contracts/v2/index.ts',
      'packages/core/src/contracts/v3/index.d.ts',
      'packages/core/src/contracts/v3/index.ts',
      'packages/core/src/place/ledger.ts',
      'packages/core/src/place/types.ts',
      'packages/core/src/public-types.ts',
    ] as const;
    for (const path of parseFree) {
      expect(existsSync(join(ROOT, path)), path).toBeTrue();
      const source = readFileSync(join(ROOT, path), 'utf8');
      expect(source, `${basename(path)} owns no JSON parser`).not.toMatch(/JSON\.parse\s*\(/u);
      expect(source, `${basename(path)} owns no JSON serializer`).not.toMatch(
        /JSON\.stringify\s*\(/u,
      );
      expect(source, `${basename(path)} owns no TOML parser`).not.toMatch(
        /(?:Bun\.TOML|smol-toml)/u,
      );
    }

    const coreSources = typescriptFiles(join(ROOT, 'packages/core/src'));
    const productionSources = [
      ...coreSources,
      ...typescriptFiles(join(ROOT, 'packages/cli/src')),
    ].sort();
    const directCodecImportOwners = productionSources.flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return /from\s+['"][^'"]*\/(?:manifest|lock|plan|ledger|journal)-codec\.ts['"]/u.test(source)
        ? [relative(ROOT, path)]
        : [];
    });
    expect(directCodecImportOwners).toEqual([
      'packages/core/src/artifacts/registry.ts',
      'packages/core/src/contracts/v1/index.ts',
      'packages/core/src/contracts/v2/index.ts',
    ]);
    const registryAssignmentOwners = productionSources.flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return /\bconst\s+artifactContractRegistry(?:\s*:[^=]+)?\s*=/u.test(source)
        ? [relative(ROOT, path)]
        : [];
    });
    expect(registryAssignmentOwners).toEqual(['packages/core/src/artifacts/registry.ts']);
    const registrySource = readFileSync(
      join(ROOT, 'packages/core/src/artifacts/registry.ts'),
      'utf8',
    );
    for (const codecName of [
      'manifestV1Codec',
      'lockV1Codec',
      'savedPlanV1Codec',
      'ledgerV1Codec',
      'ledgerV2Codec',
      'journalV1Codec',
    ]) {
      expect(registrySource.match(new RegExp(`\\b${codecName}\\b`, 'gu'))).toHaveLength(2);
    }
    const concreteCodecNames = [
      'manifestV1Codec',
      'lockV1Codec',
      'savedPlanV1Codec',
      'ledgerV1Codec',
      'ledgerV2Codec',
      'journalV1Codec',
    ] as const;
    const codecArrayOwners = productionSources.flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      const ownsAlternateArray = (source.match(/\[[\s\S]*?\]/gu) ?? []).some(
        (block) => concreteCodecNames.filter((name) => block.includes(name)).length >= 2,
      );
      return ownsAlternateArray ? [relative(ROOT, path)] : [];
    });
    expect(codecArrayOwners).toEqual(['packages/core/src/artifacts/registry.ts']);
    const identityArrayOwners = productionSources.flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      const identities =
        source.match(/['"](?:manifest@1|lock@1|plan@1|ledger@[12]|journal@1)['"]/gu) ?? [];
      return identities.length >= 2 ? [relative(ROOT, path)] : [];
    });
    expect(identityArrayOwners).toEqual([]);
    for (const path of [
      'packages/core/src/artifacts/index.ts',
      'packages/core/src/contracts/index.ts',
      'packages/core/src/contracts/index.d.ts',
      'packages/core/src/index.ts',
    ]) {
      const source = readFileSync(join(ROOT, path), 'utf8');
      for (const codecName of concreteCodecNames) {
        expect(source, `${path} cannot barrel ${codecName}`).not.toMatch(
          new RegExp(`\\b${codecName}\\b`, 'u'),
        );
      }
    }
    const namedAlternateInventoryOwners = productionSources.flatMap((path) => {
      if (relative(ROOT, path) === 'packages/core/src/artifacts/registry.ts') return [];
      const source = readFileSync(path, 'utf8');
      return /\bconst\s+\w*artifact\w*(?:descriptors|identities|inventory)\w*\s*(?::[^=]+)?=/iu.test(
        source,
      )
        ? [relative(ROOT, path)]
        : [];
    });
    expect(namedAlternateInventoryOwners).toEqual([]);
    const wireAuthoritySource = readFileSync(
      join(ROOT, 'packages/cli/src/contracts/wire-contracts.ts'),
      'utf8',
    );
    expect(wireAuthoritySource).not.toMatch(
      /artifactContractRegistry|manifestV1Codec|ledgerV2Codec/u,
    );
    expect(registrySource).not.toMatch(/currentWireContractRegistry|currentWireCodecs/u);
    const repositorySource = readFileSync(
      join(ROOT, 'packages/core/src/artifacts/repository.ts'),
      'utf8',
    );
    expect(repositorySource).not.toMatch(/\breadText\b|\bwriteText\b/u);
  });

  test('EWP-P2-TS08 family 6: public identities, compile negatives, and both registries coexist', async () => {
    const { core, registry } = await requireRegistry();
    const [contracts, v1, v2, v3, wireAuthority] = await Promise.all([
      loadModule(CONTRACTS_MODULE),
      loadModule(V1_MODULE),
      loadModule(V2_MODULE),
      loadModule(V3_MODULE),
      loadModule(WIRE_AUTHORITY_MODULE),
    ]);
    const v4Path = join(ROOT, 'packages/core/src/contracts/v4/index.ts');
    const v4 = existsSync(v4Path) ? await loadModule(V4_MODULE) : null;
    expect(Object.keys(contracts).sort()).toEqual([...CONTRACT_RUNTIME_EXPORTS].sort());
    expect(Object.keys(v1).sort()).toEqual([...V1_RUNTIME_EXPORTS].sort());
    expect(Object.keys(v2).sort()).toEqual([...V2_RUNTIME_EXPORTS].sort());
    expect(Object.keys(v3).sort()).toEqual([...V3_RUNTIME_EXPORTS].sort());
    expect(v4, 'public contracts/v4 runtime facade is absent').not.toBeNull();
    expect(Object.keys(v4 ?? {}).sort()).toEqual([...V4_RUNTIME_EXPORTS].sort());
    expect(typeof contracts.createWireContractRegistry).toBe('function');
    expect(core.artifactContractRegistry).toBe(registry);

    const wireRegistry = wireAuthority.currentWireContractRegistry as
      | (DescriptorRegistry & {
          get(
            id: string,
            version: number,
          ): { readonly descriptor: Readonly<Record<string, unknown>> } | undefined;
        })
      | undefined;
    expect(wireRegistry, 'signed WireCodec registry is absent').toBeDefined();
    if (wireRegistry !== undefined) {
      const wireIdentities = [
        [v1.agentsV1Codec, wireRegistry.get('agents', 1)],
        [v2.agentsV2Codec, wireRegistry.get('agents', 2)],
        [v1.commandsV1Codec, wireRegistry.get('commands', 1)],
        [v2.commandsV2Codec, wireRegistry.get('commands', 2)],
        [v3.flipV3Codec, wireRegistry.get('flip', 3)],
        [v4?.flipV4Codec, wireRegistry.get('flip', 4)],
        [v2.listV2Codec, wireRegistry.get('list', 2)],
        [v3.listV3Codec, wireRegistry.get('list', 3)],
        [v1.statusV1Codec, wireRegistry.get('status', 1)],
        [v1.updateV1Codec, wireRegistry.get('update', 1)],
        [v1.exportV1Codec, wireRegistry.get('export', 1)],
        [v1.initV1Codec, wireRegistry.get('init', 1)],
      ] as const;
      for (const [versioned, registered] of wireIdentities) {
        expect(versioned, 'versioned wire facade export is absent').toBeDefined();
        if (versioned === undefined) continue;
        expect(
          registered,
          `${versioned.descriptor.id}@${versioned.descriptor.version}`,
        ).toBeDefined();
        expect(registered?.descriptor).toEqual(versioned.descriptor);
      }
    }

    const identities = [
      [v1.manifestV1Codec, registry.get('manifest', 1)],
      [v1.lockV1Codec, registry.get('lock', 1)],
      [v1.savedPlanV1Codec, registry.get('plan', 1)],
      [v1.ledgerV1Codec, registry.get('ledger', 1)],
      [v2.ledgerV2Codec, registry.get('ledger', 2)],
      [v1.journalV1Codec, registry.get('journal', 1)],
    ] as const;
    for (const [versioned, registered] of identities) expect(versioned).toBe(registered);
    for (const name of [
      'readManifestArtifact',
      'readLockArtifact',
      'readSavedPlanArtifact',
      'readLedgerArtifact',
      'readJournalArtifact',
      'planProjectConfigMigration',
    ]) {
      expect(typeof core[name], name).toBe('function');
    }
    expect(core.executeProjectConfigMigration).toBeUndefined();

    const compiled = Bun.spawnSync(
      [join(ROOT, 'node_modules/.bin/tsc'), '-p', join(FIXTURES, 'tsconfig.json'), '--noEmit'],
      { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' },
    );
    const output = `${compiled.stdout.toString()}${compiled.stderr.toString()}`;
    expect(compiled.exitCode, output).toBe(0);
  }, 60_000);
});
