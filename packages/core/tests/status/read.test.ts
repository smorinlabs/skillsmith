import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  hashCanonicalInput,
  hashManifestBytes,
  hashManifestSemantics,
  parseArtifactDigest,
} from '../../src/artifacts/hash.ts';
import { validateJournalV1DtoShape } from '../../src/artifacts/journal-codec.ts';
import type { LogicalJournalV1Dto } from '../../src/artifacts/journal-types.ts';
import { fromLedgerV2Dto, ledgerV2Codec } from '../../src/artifacts/ledger-codec.ts';
import type {
  LedgerModel,
  LedgerPairV1Dto,
  LedgerV2Dto,
} from '../../src/artifacts/ledger-types.ts';
import { type PortableLockV1, serializePortableLock } from '../../src/artifacts/lock.ts';
import { manifestV1Codec } from '../../src/artifacts/manifest-codec.ts';
import type { ArtifactReadResult } from '../../src/artifacts/repository.ts';
import type { NormalizedManifestV1 } from '../../src/artifacts/types.ts';
import { resolveRuntimeConfiguration } from '../../src/config/runtime.ts';
import type { ProjectContext } from '../../src/context/types.ts';
import { toStatusV1Dto } from '../../src/contracts/v1/status.ts';
import type {
  FileMetadata,
  FileMetadataReadPort,
  InventoryReadPorts,
  ResolvedRuntimeConfiguration,
} from '../../src/ports/types.ts';
import type { Result } from '../../src/result.ts';
import {
  type StatusJoinInput,
  type StatusLiveInput,
  type StatusRetentionProbeInput,
  joinStatus,
  planStatusRetention,
} from '../../src/status/join.ts';
import type { StatusReadRequest, StatusReport } from '../../src/status/types.ts';

type StatusReader = (
  ports: InventoryReadPorts & FileMetadataReadPort,
  request: Readonly<{
    projectContext: ProjectContext;
    projectPlacement:
      | Readonly<{ state: 'unselected' }>
      | Readonly<{
          state: 'selected';
          source: 'shared-project' | 'explicit-non-git';
          canonicalCwd: string;
          root: string;
          identity: string;
        }>;
    configuration: ResolvedRuntimeConfiguration;
    targets: readonly string[];
    tools: readonly ('claude-code' | 'codex' | 'kilo-code' | 'opencode')[];
    toolSelectionSource: 'explicit' | 'effective-config' | 'unbounded-default';
    scopes: readonly ('system' | 'user' | 'project' | 'managed')[];
    scopeSelectionSource: 'explicit' | 'unbounded-default';
    selectionSource: 'explicit-targets' | 'bounded-default';
    artifactSelection:
      | Readonly<{ state: 'unselected'; reason: 'live-only-scope' }>
      | Readonly<{
          state: 'selected';
          source: 'explicit' | 'discovered-project' | 'project-default' | 'user-default';
          manifestPath: string;
          lockPath: string;
          lockSource: 'sibling' | 'explicit';
        }>;
    signal?: AbortSignal;
  }>,
) => Promise<Result<StatusReportShape, StatusReadErrorShape>>;

interface StatusReadErrorShape {
  readonly code: 'status-read';
  readonly reason: string;
  readonly exitClass: string;
  readonly message: string;
}

interface StatusReportShape {
  readonly selection: {
    readonly source: string;
    readonly targets: readonly string[];
    readonly tools: readonly string[];
    readonly toolSource: string;
    readonly scopes: readonly string[];
    readonly scopeSource: string;
    readonly outcome: string;
    readonly reason: string | null;
  };
  readonly artifacts: {
    readonly state: string;
    readonly relationship?: { readonly state: string };
  };
  readonly context: {
    readonly effectiveCwd: string;
  };
  readonly entries: readonly {
    readonly name: string;
    readonly convergence: string;
    readonly placements: readonly {
      readonly classification: string;
      readonly brokenReason: string | null;
      readonly verification: string;
      readonly live: { readonly state: string };
      readonly journal:
        | { readonly state: 'none' }
        | {
            readonly state: string;
            readonly transactionId: string;
            readonly retention: readonly {
              readonly state: string;
              readonly repositoryRevision: { readonly state: string };
            }[];
          };
      readonly facts: readonly { readonly code: string; readonly impact: string }[];
    }[];
  }[];
  readonly summary: {
    readonly entries: number;
    readonly converged: number;
    readonly drifting: number;
    readonly migrationPending: boolean;
  };
}

const ROOT = '/repo';
const HOME = '/home/status';
const MANIFEST_PATH = join(ROOT, 'skillsmith.toml');
const LOCK_PATH = join(ROOT, 'skillsmith.lock');
const DATA_ROOT = join(HOME, '.local', 'share', 'skillsmith');
const LEDGER_PATH = join(DATA_ROOT, 'placements.json');
const CODEX_ROOT = join(HOME, '.agents', 'skills');
const SHA = '3f2a1b9c0d4e5f6a7b8c9d0e1f2a3b4c5d6e7f80';
const CONTENT_HASH = (() => {
  const parsed = parseArtifactDigest(
    'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  );
  if (!parsed.ok) throw new Error('invalid status fixture content hash');
  return parsed.value;
})();
const STATUS_MODULE: string = '../../src/status/index.ts';

const loadReader = async (): Promise<StatusReader> => {
  let loaded: unknown;
  try {
    loaded = await import(STATUS_MODULE);
  } catch {
    throw new Error('missing G3A-01 status authority');
  }
  const readStatus = (loaded as { readonly readStatus?: unknown }).readStatus;
  if (typeof readStatus !== 'function') throw new Error('missing G3A-01 status authority');
  return readStatus as StatusReader;
};

const unwrap = <T, E>(result: Result<T, E>, label: string): T => {
  if (!result.ok) throw new Error(`${label} failed`);
  return result.value;
};

const projectContext: ProjectContext = Object.freeze({
  invocationCwd: ROOT,
  effectiveCwd: ROOT,
  projectRoot: ROOT,
  projectIdentity: ROOT,
  projectKind: 'git',
  discoveredConfigPath: MANIFEST_PATH,
  explicitConfigPath: null,
});

const configuration = resolveRuntimeConfiguration({});

const request = (
  artifactSelection:
    | Readonly<{ state: 'unselected'; reason: 'live-only-scope' }>
    | Readonly<{
        state: 'selected';
        source: 'explicit' | 'discovered-project' | 'project-default' | 'user-default';
        manifestPath: string;
        lockPath: string;
        lockSource: 'sibling' | 'explicit';
      }> = Object.freeze({
    state: 'selected',
    source: 'explicit',
    manifestPath: MANIFEST_PATH,
    lockPath: LOCK_PATH,
    lockSource: 'sibling',
  }),
) =>
  Object.freeze({
    projectContext,
    projectPlacement: Object.freeze({
      state: 'selected' as const,
      source: 'shared-project' as const,
      canonicalCwd: ROOT,
      root: ROOT,
      identity: ROOT,
    }),
    configuration,
    targets: Object.freeze([]),
    tools: Object.freeze(['codex'] as const),
    toolSelectionSource: 'explicit' as const,
    scopes: Object.freeze(['user'] as const),
    scopeSelectionSource: 'explicit' as const,
    selectionSource: 'bounded-default' as const,
    artifactSelection,
  });

const liveOnlyRequest = (scope: 'system' | 'managed' = 'system'): Readonly<StatusReadRequest> => ({
  ...request(),
  scopes: Object.freeze([scope]),
  scopeSelectionSource: 'explicit',
  artifactSelection: Object.freeze({ state: 'unselected', reason: 'live-only-scope' }),
});

const pairFor = (name: string): LedgerPairV1Dto => ({
  placementPath: join(CODEX_ROOT, name),
  mode: 'pinned',
  dev: null,
  pinned: {
    storePath: join(DATA_ROOT, 'store', `acme-skills@${SHA.slice(0, 12)}`, name),
    rev: SHA,
    gitSha: SHA,
    dirty: false,
    contentHash: CONTENT_HASH,
    snapshotAt: '2026-07-14T00:00:00.000Z',
    verify: 'passed',
    placement: 'copy',
  },
  origin: {
    source: `github.com/acme/skills//${name}`,
    host: 'github.com',
    repo: 'acme/skills',
    skillPath: name,
    refRequested: null,
    refResolved: SHA,
    pin: true,
    installedAt: '2026-07-14T00:00:00.000Z',
  },
  journal: null,
});

const artifactBytes = (names: readonly string[]): ReadonlyMap<string, Uint8Array> => {
  const manifest: NormalizedManifestV1 = {
    version: 1,
    skills: names.map((name) => ({
      name,
      source: { host: 'github.com', repository: 'acme/skills', path: name },
      ref: null,
      tools: ['codex'],
      scope: 'user',
      placement: 'copy',
      path: `~/.agents/skills/${name}`,
    })),
  };
  const lock: PortableLockV1 = {
    version: 1,
    hashSchemaVersion: 1,
    manifestHash: hashManifestSemantics(manifest),
    skills: names.map((name) => ({
      name,
      source: `github.com/acme/skills//${name}`,
      requestedRef: null,
      resolvedSha: SHA,
      sourcePath: name,
      contentHash: CONTENT_HASH,
    })),
  };
  const skills = Object.fromEntries(
    names.map((name) => [name, { tools: { codex: pairFor(name) } }] as const),
  );
  const ledgerDto: LedgerV2Dto = {
    schemaVersion: 2,
    kind: 'skillsmith.placements',
    updatedAt: '2026-07-14T00:00:00.000Z',
    skills,
    projects: {},
    projectRegistrations: {},
    transactions: {},
    history: [],
  };
  const ledger = unwrap(fromLedgerV2Dto(ledgerDto), 'ledger model');
  const manifestSource = unwrap(manifestV1Codec.encode(manifest), 'manifest encoding');
  const lockSource = new TextEncoder().encode(unwrap(serializePortableLock(lock), 'lock encoding'));
  const ledgerSource = unwrap(ledgerV2Codec.encode(ledger), 'ledger encoding');
  return new Map([
    [MANIFEST_PATH, manifestSource],
    [LOCK_PATH, lockSource],
    [LEDGER_PATH, ledgerSource],
  ]);
};

interface ReadFixtureOptions {
  readonly names?: readonly string[];
  readonly listing?: readonly string[];
  readonly bytes?: ReadonlyMap<string, Uint8Array>;
  readonly pathKind?: (path: string) => Promise<'absent' | 'file' | 'dir' | 'symlink'>;
}

const readPorts = (options: ReadFixtureOptions = {}): InventoryReadPorts & FileMetadataReadPort => {
  const names = options.names ?? [];
  const bytes = options.bytes ?? new Map<string, Uint8Array>();
  const livePaths = new Set(names.map((name) => join(CODEX_ROOT, name)));
  const skillFiles = new Set(names.map((name) => join(CODEX_ROOT, name, 'SKILL.md')));
  const kindOf = async (path: string): Promise<'absent' | 'file' | 'dir' | 'symlink'> => {
    if (bytes.has(path) || skillFiles.has(path)) return 'file';
    if (path === CODEX_ROOT || livePaths.has(path)) return 'dir';
    return 'absent';
  };
  return {
    homeDir: HOME,
    executableSearchPath: Object.freeze([]),
    platform: 'linux',
    xdg: Object.freeze({
      config: join(HOME, '.config'),
      data: join(HOME, '.local', 'share'),
      cache: join(HOME, '.cache'),
    }),
    fileExists: async (path) => (await (options.pathKind ?? kindOf)(path)) !== 'absent',
    pathKind: options.pathKind ?? kindOf,
    realpath: async (path) => path,
    listDir: async (path) =>
      path === CODEX_ROOT ? Object.freeze([...(options.listing ?? names)]) : Object.freeze([]),
    readText: async (path) =>
      new TextDecoder().decode(await readPortsBytes(path, bytes, skillFiles)),
    readBytes: async (path) => readPortsBytes(path, bytes, skillFiles),
    readLink: async () => {
      throw new Error('unexpected symlink read');
    },
    isExecutable: async () => false,
    modifiedAt: async () => null,
    readFileMetadata: async (path): Promise<FileMetadata> => {
      const kind = await (options.pathKind ?? kindOf)(path);
      return Object.freeze({
        kind,
        mode: kind === 'absent' ? null : kind === 'dir' ? 0o755 : 0o644,
        identity: kind === 'absent' ? null : `fixture:${path}`,
      });
    },
  };
};

const readPortsBytes = async (
  path: string,
  bytes: ReadonlyMap<string, Uint8Array>,
  skillFiles: ReadonlySet<string>,
): Promise<Uint8Array> => {
  const stored = bytes.get(path);
  if (stored !== undefined) return new Uint8Array(stored);
  if (skillFiles.has(path)) return new TextEncoder().encode('# Fixture skill\n');
  throw new Error('unexpected fixture read');
};

const expectDeepFrozen = (value: unknown, seen = new Set<object>()): void => {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBeTrue();
  for (const nested of Object.values(value)) expectDeepFrozen(nested, seen);
};

const hostileValues = (): ReadonlyArray<
  readonly [label: string, value: unknown, accesses: () => number]
> => {
  let getterAccesses = 0;
  const accessor = Object.create(null) as object;
  Object.defineProperty(accessor, 'message', {
    get() {
      getterAccesses += 1;
      throw new Error('hostile getter was invoked');
    },
  });
  let coercionAccesses = 0;
  const coercion = {
    toString(): string {
      coercionAccesses += 1;
      throw new Error('hostile coercion was invoked');
    },
    [Symbol.toPrimitive](): string {
      coercionAccesses += 1;
      throw new Error('hostile primitive coercion was invoked');
    },
  };
  let proxyAccesses = 0;
  const proxy = new Proxy(Object.create(null) as object, {
    get() {
      proxyAccesses += 1;
      throw new Error('hostile proxy get was invoked');
    },
    getOwnPropertyDescriptor() {
      proxyAccesses += 1;
      throw new Error('hostile proxy descriptor was invoked');
    },
  });
  return [
    ['Error', new Error('status-reader-secret-canary'), () => 0],
    ['primitive', 'status-reader-secret-canary', () => 0],
    ['accessor', accessor, () => getterAccesses],
    ['coercion', coercion, () => coercionAccesses],
    ['proxy', proxy, () => proxyAccesses],
  ];
};

const statusRequest = (
  overrides: Partial<StatusReadRequest> = {},
): Readonly<StatusReadRequest> => ({
  ...request(Object.freeze({ state: 'unselected', reason: 'live-only-scope' })),
  ...overrides,
});

const selectedArtifactRequest = (
  overrides: Partial<StatusReadRequest> = {},
): Readonly<StatusReadRequest> =>
  statusRequest({
    artifactSelection: {
      state: 'selected',
      source: 'discovered-project',
      manifestPath: MANIFEST_PATH,
      lockPath: LOCK_PATH,
      lockSource: 'sibling',
    },
    ...overrides,
  });

const artifactPresent = <T>(
  artifact: 'manifest' | 'lock' | 'ledger',
  model: T,
  sourceVersion: 1 | 2,
): ArtifactReadResult<T> => ({
  state: 'present',
  artifact,
  sourceVersion,
  currentVersion: artifact === 'ledger' ? 2 : 1,
  source: '',
  byteLength: 0,
  byteRevision: CONTENT_HASH,
  semanticRevision: CONTENT_HASH,
  model,
  canonical: true,
  migration: null,
});

const emptyLedgerModel = (overrides: Partial<LedgerModel> = {}): LedgerModel => ({
  updatedAt: '2026-07-14T00:00:00.000Z',
  skills: {},
  projects: {},
  projectRegistrations: {},
  transactions: {},
  history: [],
  ...overrides,
});

const manifestModel = (names: readonly string[]): NormalizedManifestV1 => ({
  version: 1,
  skills: names.map((name) => ({
    name,
    source: { host: 'github.com', repository: 'acme/skills', path: name },
    ref: null,
    tools: ['codex'],
    scope: 'user',
    placement: 'copy',
    path: `~/.agents/skills/${name}`,
  })),
});

const lockModel = (names: readonly string[], manifest: NormalizedManifestV1): PortableLockV1 => ({
  version: 1,
  hashSchemaVersion: 1,
  manifestHash: hashManifestSemantics(manifest),
  skills: names.map((name) => ({
    name,
    source: `github.com/acme/skills//${name}`,
    requestedRef: null,
    resolvedSha: SHA,
    sourcePath: name,
    contentHash: CONTENT_HASH,
  })),
});

const liveInput = (
  name: string,
  path: string,
  scope: 'user' | 'project' = 'user',
): StatusLiveInput => ({
  name,
  tool: 'codex',
  scope,
  projectIdentity: scope === 'project' ? ROOT : null,
  path,
  observation: {
    path,
    realpath: path,
    nodeKind: 'directory',
    linkTarget: null,
    skillFile: 'valid',
  },
  physicalClass: 'directory',
  brokenReason: null,
});

interface LogicalJournalOptions {
  readonly name: string;
  readonly path: string;
  readonly transactionId: string;
  readonly tool?: 'codex' | 'claude-code';
  readonly scope?: 'user' | 'project';
  readonly projectRoot?: string | null;
  readonly phase?: LogicalJournalV1Dto['phase'];
  readonly updatedAt?: string;
  readonly retained?: LogicalJournalV1Dto['actual']['retained'];
  readonly reversibility?: LogicalJournalV1Dto['intent']['reversibility'];
}

const logicalJournal = (options: LogicalJournalOptions): LogicalJournalV1Dto => {
  const projectRoot =
    options.projectRoot === null || options.projectRoot === undefined
      ? null
      : ({ kind: 'machine-bound', path: options.projectRoot } as const);
  const resource = {
    kind: 'live' as const,
    skill: options.name,
    tool: options.tool ?? 'codex',
    scope: options.scope ?? 'user',
    projectRoot,
    location: { kind: 'machine-bound' as const, path: options.path },
  };
  const actual = {
    resourceId: `resource:${options.name}:live`,
    role: 'live' as const,
    state: 'present' as const,
    repositoryRevision: { kind: 'resource' as const, digest: CONTENT_HASH },
    placementPath: options.path,
    liveKind: 'directory' as const,
    mode: 'pinned' as const,
    symlinkTarget: null,
    contentHash: CONTENT_HASH,
  };
  const ledgerActual = {
    resourceId: `resource:${options.name}:ledger`,
    role: 'ledger' as const,
    state: 'present' as const,
    repositoryRevision: { kind: 'artifact-bytes' as const, digest: CONTENT_HASH },
    schemaVersion: 2 as const,
    semanticHash: CONTENT_HASH,
  };
  const phase = options.phase ?? 'live';
  return {
    schemaVersion: 1,
    kind: 'skillsmith.transaction-journal',
    transactionId: options.transactionId,
    intent: {
      operationId: `operation:${options.transactionId}`,
      groupId: `group:${options.transactionId}`,
      pairId: `pair:${options.name}:${options.tool ?? 'codex'}`,
      kind: 'repair',
      skill: options.name,
      source: {
        kind: 'portable',
        identity: { host: 'github.com', repository: 'acme/skills', path: options.name },
        requestedRef: null,
        resolvedSha: SHA,
        sourcePath: options.name,
        contentHash: CONTENT_HASH,
      },
      tool: options.tool ?? 'codex',
      scope: options.scope ?? 'user',
      before: {
        kind: 'placement',
        resource,
        classification: 'pinned',
        representation: 'copy',
        linkTarget: null,
        dangling: false,
        source: null,
        contentHash: CONTENT_HASH,
      },
      after: {
        kind: 'placement',
        resource,
        classification: 'pinned',
        representation: 'copy',
        linkTarget: null,
        dangling: false,
        source: null,
        contentHash: CONTENT_HASH,
      },
      mutates: { live: true, manifest: false, lock: false, ledger: true },
      reversibility: options.reversibility ?? {
        kind: 'none',
        retentionResourceIds: [],
      },
      conflict: null,
    },
    context: {
      parentOperationId: null,
      command: 'skillsmith:apply',
      workflow: `workflow:${options.transactionId}`,
      attempt: 1,
      startedAt: '2026-07-14T00:00:00.000Z',
    },
    disposition: 'forward',
    phase,
    actual: {
      before: [actual, ledgerActual],
      after: [actual, ledgerActual],
      retained: options.retained ?? [],
    },
    updatedAt: options.updatedAt ?? '2026-07-14T00:00:01.000Z',
    completedAt: phase === 'committed' ? '2026-07-14T00:00:02.000Z' : null,
  };
};

const retainedResource = (
  path: string,
  repositoryKind: 'artifact-bytes' | 'resource' = 'resource',
): LogicalJournalV1Dto['actual']['retained'][number] => ({
  resourceId: `resource:retained:${path}`,
  role: 'backup',
  sourceRole: 'live',
  path,
  repositoryRevision: { kind: repositoryKind, digest: CONTENT_HASH },
  contentHash: CONTENT_HASH,
  retainUntil: null,
});

const journalLedgerBytes = (
  journals: readonly LogicalJournalV1Dto[],
): ReadonlyMap<string, Uint8Array> => {
  for (const journal of journals) {
    const validated = validateJournalV1DtoShape(journal);
    if (!validated.ok) {
      throw new Error(
        `journal ${journal.transactionId} invalid: ${JSON.stringify(validated.error)}`,
      );
    }
  }
  const model = emptyLedgerModel({
    transactions: Object.fromEntries(
      journals
        .filter((journal) => journal.phase !== 'committed')
        .map((journal) => [journal.transactionId, journal]),
    ),
    history: journals.filter((journal) => journal.phase === 'committed'),
  });
  const encoded = ledgerV2Codec.encode(model);
  if (!encoded.ok)
    throw new Error(`journal ledger encoding failed: ${JSON.stringify(encoded.error)}`);
  return new Map([[LEDGER_PATH, encoded.value]]);
};

const joinInput = (overrides: Partial<StatusJoinInput> = {}): StatusJoinInput => ({
  homeDir: HOME,
  request: statusRequest(),
  manifest: null,
  lock: null,
  ledger: { state: 'absent', artifact: 'ledger', migration: null },
  ledgerPath: LEDGER_PATH,
  live: [],
  retention: [],
  ...overrides,
});

const unwrapJoin = (input: StatusJoinInput) => {
  const result = joinStatus(input);
  if (!result.ok) throw new Error(`unexpected join selection error: ${result.error.reason}`);
  return result.value;
};

const relationshipOf = (report: StatusReport) => {
  if (report.artifacts.state !== 'selected') throw new Error('expected selected artifacts');
  return report.artifacts.relationship;
};

describe('G3A-01 focused status reader', () => {
  test('owns a recursively immutable and permutation-stable converged product', async () => {
    const readStatus = await loadReader();
    const names = ['alpha', 'beta'] as const;
    const bytes = artifactBytes(names);
    const forward = await readStatus(
      readPorts({ names, listing: ['alpha', 'beta'], bytes }),
      request(),
    );
    const reverse = await readStatus(
      readPorts({ names: [...names].reverse(), listing: ['beta', 'alpha'], bytes }),
      request(),
    );
    expect(forward.ok).toBeTrue();
    expect(reverse.ok).toBeTrue();
    if (!forward.ok || !reverse.ok) throw new Error('expected converged status products');

    expect(reverse.value).toEqual(forward.value);
    expect(forward.value.entries.map((entry) => entry.name)).toEqual(['alpha', 'beta']);
    expect(forward.value.artifacts.relationship?.state).toBe('current');
    expect(forward.value.summary).toEqual({
      entries: 2,
      converged: 2,
      drifting: 0,
      migrationPending: false,
    });
    for (const entry of forward.value.entries) {
      expect(entry.convergence).toBe('converged');
      expect(entry.placements).toHaveLength(1);
      expect(entry.placements[0]?.classification).toBe('pinned');
      expect(entry.placements[0]?.verification).toBe('passed');
      expect(entry.placements[0]?.facts).toContainEqual(
        expect.objectContaining({ code: 'verify-passed', impact: 'info' }),
      );
    }
    expectDeepFrozen(forward.value);
  });

  test('uses only the focused read boundary for an all-absent live-only product', async () => {
    const readStatus = await loadReader();
    const forbidden = new Set([
      'makeDir',
      'writeTextFile',
      'makeSymlink',
      'rename',
      'copyTree',
      'removeTree',
      'fsyncFile',
      'fsyncDir',
      'withFileLock',
      'exec',
      'runVersion',
      'git',
      'http',
      'wallNowIso',
      'epochMilliseconds',
      'monotonicMilliseconds',
      'nextId',
    ]);
    const forbiddenReads: string[] = [];
    const ports = new Proxy(readPorts(), {
      get(target, property, receiver) {
        if (typeof property === 'string' && forbidden.has(property)) {
          forbiddenReads.push(property);
          throw new Error(`forbidden status capability: ${property}`);
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const result = await readStatus(ports, liveOnlyRequest());
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error('expected all-absent status product');
    expect(result.value.entries).toEqual([]);
    expect(result.value.selection).toMatchObject({
      source: 'bounded-default',
      tools: ['codex'],
      toolSource: 'explicit',
      scopes: ['system'],
      scopeSource: 'explicit',
      outcome: 'selected',
      reason: null,
    });
    expect(result.value.summary).toEqual({
      entries: 0,
      converged: 0,
      drifting: 0,
      migrationPending: false,
    });
    expect(forbiddenReads).toEqual([]);
    expectDeepFrozen(result.value);
  });

  test('maps hostile primary read throwables to one fixed secret-safe failure', async () => {
    const readStatus = await loadReader();
    for (const [label, thrown, accesses] of hostileValues()) {
      const result = await readStatus(
        readPorts({
          pathKind: async (path) => {
            if (path === MANIFEST_PATH) throw thrown;
            return 'absent';
          },
        }),
        request(),
      );
      expect(result.ok, label).toBeFalse();
      if (result.ok) throw new Error('expected primary read failure');
      expect(result.error, label).toEqual({
        code: 'status-read',
        reason: 'observation-failed',
        exitClass: 'failure',
        message: 'status observation failed',
      });
      expect(JSON.stringify(result.error), label).not.toContain('status-reader-secret-canary');
      expect(accesses(), label).toBe(0);
      expectDeepFrozen(result.error);
    }
  });

  test('preserves native cancellation through every primary artifact pathKind/readBytes boundary and live observation', async () => {
    const readStatus = await loadReader();
    const bytes = artifactBytes(['alpha']);
    for (const [artifactPath, operation] of [
      [MANIFEST_PATH, 'pathKind'],
      [MANIFEST_PATH, 'readBytes'],
      [LOCK_PATH, 'pathKind'],
      [LOCK_PATH, 'readBytes'],
      [LEDGER_PATH, 'pathKind'],
      [LEDGER_PATH, 'readBytes'],
    ] as const) {
      const base = readPorts({ bytes });
      const cancelled = new DOMException('primary cancellation canary', 'AbortError');
      const result = await readStatus(
        {
          ...base,
          pathKind: async (path) => {
            if (operation === 'pathKind' && path === artifactPath) throw cancelled;
            return base.pathKind(path);
          },
          readBytes: async (path) => {
            if (operation === 'readBytes' && path === artifactPath) throw cancelled;
            return base.readBytes(path);
          },
        },
        request(),
      );
      expect(result, `${artifactPath}:${operation}`).toEqual({
        ok: false,
        error: {
          code: 'status-read',
          reason: 'cancelled',
          exitClass: 'cancelled',
          message: 'status read was cancelled',
        },
      });
      expect(JSON.stringify(result)).not.toContain('primary cancellation canary');
    }

    const liveBase = readPorts();
    const live = await readStatus(
      {
        ...liveBase,
        listDir: async (path) => {
          if (path === CODEX_ROOT) throw new DOMException('live cancellation canary', 'AbortError');
          return liveBase.listDir(path);
        },
      },
      request(),
    );
    expect(live).toMatchObject({ ok: false, error: { reason: 'cancelled' } });
    expect(JSON.stringify(live)).not.toContain('live cancellation canary');
  });

  test('does not trust a frozen structural spoof of an internally owned status error', async () => {
    const readStatus = await loadReader();
    const spoof = Object.freeze({
      code: 'status-read',
      reason: 'permission-denied',
      exitClass: 'permission',
      message: 'status-reader-spoof-canary',
    });
    const base = readPorts();
    const result = await readStatus(
      {
        ...base,
        listDir: async (path) => {
          if (path === CODEX_ROOT) throw spoof;
          return Object.freeze([]);
        },
      },
      request(),
    );
    expect(result.ok).toBeFalse();
    if (result.ok) throw new Error('expected structural spoof to be rejected');
    expect(result.error).toEqual({
      code: 'status-read',
      reason: 'observation-failed',
      exitClass: 'failure',
      message: 'status observation failed',
    });
    expect(JSON.stringify(result.error)).not.toContain('status-reader-spoof-canary');
  });

  test('rejects every request discriminator family before any port access', async () => {
    const readStatus = await loadReader();
    const liveOnly = liveOnlyRequest();
    const selectedArtifact = request().artifactSelection;
    if (selectedArtifact.state !== 'selected')
      throw new Error('expected selected artifact fixture');
    const invalidRequests: ReadonlyArray<readonly [string, unknown]> = [
      ['tool source', { ...liveOnly, toolSelectionSource: 'unknown' }],
      ['scope source', { ...liveOnly, scopeSelectionSource: 'unknown' }],
      ['selection source', { ...liveOnly, selectionSource: 'unknown' }],
      [
        'project kind',
        { ...liveOnly, projectContext: { ...liveOnly.projectContext, projectKind: 'unknown' } },
      ],
      [
        'placement state',
        { ...liveOnly, projectPlacement: { ...liveOnly.projectPlacement, state: 'unknown' } },
      ],
      [
        'placement source',
        {
          ...liveOnly,
          projectPlacement: {
            state: 'selected',
            source: 'unknown',
            root: ROOT,
            identity: ROOT,
          },
        },
      ],
      ['artifact state', { ...liveOnly, artifactSelection: { state: 'unknown' } }],
      [
        'artifact source',
        { ...liveOnly, artifactSelection: { ...selectedArtifact, source: 'unknown' } },
      ],
      [
        'lock source',
        { ...liveOnly, artifactSelection: { ...selectedArtifact, lockSource: 'unknown' } },
      ],
      [
        'artifact path collision',
        {
          ...liveOnly,
          artifactSelection: { ...selectedArtifact, lockPath: selectedArtifact.manifestPath },
        },
      ],
      ['target/source mismatch', { ...liveOnly, targets: ['alpha'] }],
      [
        'hostile request proxy',
        new Proxy(Object.create(null) as object, {
          get() {
            throw new Error('hostile request getter');
          },
        }),
      ],
    ];
    for (const [label, invalidRequest] of invalidRequests) {
      let portAccesses = 0;
      const ports = new Proxy(readPorts(), {
        get(target, property, receiver) {
          portAccesses += 1;
          return Reflect.get(target, property, receiver);
        },
      });
      const result = await readStatus(ports, invalidRequest as never);
      expect(result.ok, label).toBeFalse();
      if (result.ok) throw new Error(`expected invalid request: ${label}`);
      expect(result.error, label).toEqual({
        code: 'status-read',
        reason: 'invalid-request',
        exitClass: 'usage',
        message: 'status request is invalid',
      });
      expect(portAccesses, label).toBe(0);
    }
  });

  test('snapshots all request-owned data and rejects accessors, exotics, and fake signals before I/O', async () => {
    const readStatus = await loadReader();
    const assertInvalidWithoutIo = async (
      label: string,
      invalidRequest: unknown,
    ): Promise<void> => {
      let portAccesses = 0;
      const ports = new Proxy(readPorts(), {
        get(target, property, receiver) {
          portAccesses += 1;
          return Reflect.get(target, property, receiver);
        },
      });
      const result = await readStatus(ports, invalidRequest as never);
      expect(result, label).toEqual({
        ok: false,
        error: {
          code: 'status-read',
          reason: 'invalid-request',
          exitClass: 'usage',
          message: 'status request is invalid',
        },
      });
      expect(portAccesses, label).toBe(0);
    };

    const accessorConfiguration = { ...configuration };
    Object.defineProperty(accessorConfiguration, 'forceColor', {
      enumerable: true,
      get() {
        throw new Error('request accessor canary');
      },
    });
    await assertInvalidWithoutIo('nested accessor', {
      ...request(),
      configuration: accessorConfiguration,
    });
    await assertInvalidWithoutIo('nested proxy', {
      ...request(),
      projectContext: new Proxy(projectContext, {}),
    });
    await assertInvalidWithoutIo('array subclass', {
      ...request(),
      tools: new (class extends Array<string> {} as typeof Array)(...'codex'.split(',')),
    });
    await assertInvalidWithoutIo('fake signal', { ...request(), signal: { aborted: false } });

    const controller = new AbortController();
    controller.abort();
    let cancelledPortAccesses = 0;
    const cancelled = await readStatus(
      new Proxy(readPorts(), {
        get(target, property, receiver) {
          cancelledPortAccesses += 1;
          return Reflect.get(target, property, receiver);
        },
      }),
      { ...request(), signal: controller.signal },
    );
    expect(cancelled).toEqual({
      ok: false,
      error: {
        code: 'status-read',
        reason: 'cancelled',
        exitClass: 'cancelled',
        message: 'status read was cancelled',
      },
    });
    expect(cancelledPortAccesses).toBe(0);

    const mutable = {
      ...request(),
      projectContext: { ...projectContext },
      configuration: { ...configuration, configLayer: { ...configuration.configLayer } },
      targets: [] as string[],
      tools: ['codex'] as Array<'codex' | 'claude-code'>,
      scopes: ['user'] as Array<'user' | 'project'>,
    };
    const base = readPorts();
    let mutated = false;
    const snapshotted = await readStatus(
      {
        ...base,
        pathKind: async (path) => {
          if (!mutated) {
            mutated = true;
            mutable.tools[0] = 'claude-code';
            mutable.scopes[0] = 'project';
            mutable.projectContext.effectiveCwd = '/mutated-after-io';
            mutable.configuration.codexHome = '/mutated-codex-home';
          }
          return base.pathKind(path);
        },
      },
      mutable,
    );
    expect(snapshotted.ok).toBeTrue();
    if (!snapshotted.ok) throw new Error('expected immutable request snapshot');
    expect(snapshotted.value.selection).toMatchObject({ tools: ['codex'], scopes: ['user'] });
    expect(snapshotted.value.context.effectiveCwd).toBe(ROOT);
  });

  test('enforces project-placement provenance coherence before I/O', async () => {
    const readStatus = await loadReader();
    const nullContext: ProjectContext = {
      invocationCwd: ROOT,
      effectiveCwd: ROOT,
      projectRoot: null,
      projectIdentity: null,
      projectKind: 'non-git',
      discoveredConfigPath: null,
      explicitConfigPath: null,
    };
    const invalid = [
      {
        ...request(),
        projectPlacement: {
          state: 'selected' as const,
          source: 'shared-project' as const,
          canonicalCwd: '/outside/repo',
          root: ROOT,
          identity: ROOT,
        },
      },
      {
        ...request(),
        projectPlacement: {
          state: 'selected' as const,
          source: 'shared-project' as const,
          canonicalCwd: '/repo/nested/..',
          root: ROOT,
          identity: ROOT,
        },
      },
      {
        ...request(),
        projectPlacement: {
          state: 'selected' as const,
          source: 'shared-project' as const,
          canonicalCwd: '/other',
          root: '/other',
          identity: '/other',
        },
      },
      {
        ...request(),
        projectContext: nullContext,
        projectPlacement: {
          state: 'selected' as const,
          source: 'explicit-non-git' as const,
          canonicalCwd: '/other',
          root: ROOT,
          identity: ROOT,
        },
      },
      {
        ...request(),
        projectContext: nullContext,
        projectPlacement: {
          state: 'selected' as const,
          source: 'explicit-non-git' as const,
          canonicalCwd: ROOT,
          root: ROOT,
          identity: '/other',
        },
      },
      {
        ...request(),
        projectPlacement: { state: 'unselected' as const },
      },
      {
        ...request(),
        projectContext: nullContext,
        projectPlacement: {
          state: 'selected' as const,
          source: 'explicit-non-git' as const,
          canonicalCwd: ROOT,
          root: ROOT,
          identity: ROOT,
        },
      },
      {
        ...request(),
        projectContext: nullContext,
        projectPlacement: {
          state: 'selected' as const,
          source: 'explicit-non-git' as const,
          canonicalCwd: ROOT,
          root: ROOT,
          identity: ROOT,
        },
        scopes: ['system', 'user', 'project', 'managed'],
        scopeSelectionSource: 'unbounded-default' as const,
      },
      {
        ...request(),
        tools: ['codex', 'claude-code', 'kilo-code', 'opencode'],
        toolSelectionSource: 'unbounded-default' as const,
      },
      {
        ...request(),
        scopes: ['system', 'user', 'managed'],
        scopeSelectionSource: 'unbounded-default' as const,
      },
      {
        ...request(),
        scopes: ['user', 'system'],
        scopeSelectionSource: 'explicit' as const,
      },
      {
        ...request(),
        artifactSelection: { state: 'unselected' as const, reason: 'live-only-scope' as const },
      },
    ];
    for (const candidate of invalid) {
      let accesses = 0;
      const result = await readStatus(
        new Proxy(readPorts(), {
          get(target, property, receiver) {
            accesses += 1;
            return Reflect.get(target, property, receiver);
          },
        }),
        candidate as never,
      );
      expect(result).toMatchObject({ ok: false, error: { reason: 'invalid-request' } });
      expect(accesses).toBe(0);
    }

    const explicit = await readStatus(readPorts(), {
      ...request(),
      projectContext: nullContext,
      projectPlacement: {
        state: 'selected',
        source: 'explicit-non-git',
        canonicalCwd: ROOT,
        root: ROOT,
        identity: ROOT,
      },
      scopes: ['project'],
      scopeSelectionSource: 'explicit',
    });
    expect(explicit.ok).toBeTrue();

    const controller = new AbortController();
    controller.abort();
    const selectedUnbounded = await readStatus(readPorts(), {
      ...request(),
      tools: ['claude-code', 'codex', 'kilo-code', 'opencode'],
      toolSelectionSource: 'unbounded-default',
      scopes: ['system', 'user', 'project', 'managed'],
      scopeSelectionSource: 'unbounded-default',
      signal: controller.signal,
    });
    expect(selectedUnbounded).toMatchObject({
      ok: false,
      error: { reason: 'cancelled' },
    });
    const unselectedUnbounded = await readStatus(readPorts(), {
      ...request(),
      projectContext: nullContext,
      projectPlacement: { state: 'unselected' },
      artifactSelection: {
        state: 'selected',
        source: 'user-default',
        manifestPath: join(HOME, '.config', 'skillsmith', 'skillsmith.toml'),
        lockPath: join(HOME, '.config', 'skillsmith', 'skillsmith.lock'),
        lockSource: 'sibling',
      },
      tools: ['claude-code', 'codex', 'kilo-code', 'opencode'],
      toolSelectionSource: 'unbounded-default',
      scopes: ['system', 'user', 'managed'],
      scopeSelectionSource: 'unbounded-default',
      signal: controller.signal,
    });
    expect(unselectedUnbounded).toMatchObject({
      ok: false,
      error: { reason: 'cancelled' },
    });
  });

  test('enforces complete project and selected-artifact provenance before filesystem methods', async () => {
    const readStatus = await loadReader();
    const controller = new AbortController();
    controller.abort();
    const userManifest = join(HOME, '.config', 'skillsmith', 'skillsmith.toml');
    const userLock = join(HOME, '.config', 'skillsmith', 'skillsmith.lock');
    const noDiscoveryContext: ProjectContext = {
      ...projectContext,
      discoveredConfigPath: null,
    };
    const outsideContext: ProjectContext = {
      invocationCwd: ROOT,
      effectiveCwd: ROOT,
      projectRoot: null,
      projectIdentity: null,
      projectKind: 'non-git',
      discoveredConfigPath: null,
      explicitConfigPath: null,
    };
    const nonGitDiscoveredContext: ProjectContext = {
      ...projectContext,
      projectKind: 'non-git',
    };
    const withMethodCounter = () => {
      const base = readPorts();
      let methodCalls = 0;
      const ports = new Proxy(base, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (typeof value !== 'function') return value;
          return (...args: never[]) => {
            methodCalls += 1;
            return (value as (...values: never[]) => unknown)(...args);
          };
        },
      });
      return { ports, methodCalls: () => methodCalls };
    };
    const readBeforeMethods = async (candidate: Readonly<StatusReadRequest>) => {
      const counted = withMethodCounter();
      const result = await readStatus(counted.ports, candidate);
      expect(counted.methodCalls()).toBe(0);
      return result;
    };
    const selected = (
      source: 'explicit' | 'discovered-project' | 'project-default' | 'user-default',
      manifestPath: string,
      lockPath: string,
      lockSource: 'sibling' | 'explicit' = 'sibling',
    ) => ({ state: 'selected' as const, source, manifestPath, lockPath, lockSource });

    const valid: readonly Readonly<StatusReadRequest>[] = [
      ...(['system', 'user', 'project', 'managed'] as const).map((scope) => ({
        ...request(selected('explicit', MANIFEST_PATH, LOCK_PATH)),
        scopes: [scope],
        scopeSelectionSource: 'explicit' as const,
        signal: controller.signal,
      })),
      {
        ...request(selected('explicit', MANIFEST_PATH, '/custom/status.lock', 'explicit')),
        signal: controller.signal,
      },
      {
        ...request(selected('explicit', MANIFEST_PATH, LOCK_PATH)),
        projectPlacement: {
          state: 'selected',
          source: 'shared-project',
          canonicalCwd: '/repo/nested',
          root: ROOT,
          identity: ROOT,
        },
        signal: controller.signal,
      },
      {
        ...request(selected('explicit', MANIFEST_PATH, LOCK_PATH)),
        projectPlacement: {
          state: 'selected',
          source: 'shared-project',
          canonicalCwd: '/repo/..cache',
          root: ROOT,
          identity: ROOT,
        },
        signal: controller.signal,
      },
      {
        ...request(selected('user-default', userManifest, userLock)),
        signal: controller.signal,
      },
      {
        ...request(selected('discovered-project', MANIFEST_PATH, LOCK_PATH)),
        scopes: ['project'],
        scopeSelectionSource: 'explicit',
        signal: controller.signal,
      },
      {
        ...request(selected('project-default', MANIFEST_PATH, LOCK_PATH)),
        projectContext: noDiscoveryContext,
        scopes: ['project'],
        scopeSelectionSource: 'explicit',
        signal: controller.signal,
      },
      {
        ...request(selected('discovered-project', MANIFEST_PATH, LOCK_PATH)),
        projectContext: nonGitDiscoveredContext,
        scopes: ['project'],
        scopeSelectionSource: 'explicit',
        signal: controller.signal,
      },
      {
        ...request(selected('user-default', userManifest, userLock)),
        projectContext: outsideContext,
        projectPlacement: { state: 'unselected' },
        tools: ['claude-code', 'codex', 'kilo-code', 'opencode'],
        toolSelectionSource: 'unbounded-default',
        scopes: ['system', 'user', 'managed'],
        scopeSelectionSource: 'unbounded-default',
        signal: controller.signal,
      },
      {
        ...request(selected('project-default', MANIFEST_PATH, LOCK_PATH)),
        projectContext: outsideContext,
        projectPlacement: {
          state: 'selected',
          source: 'explicit-non-git',
          canonicalCwd: ROOT,
          root: ROOT,
          identity: ROOT,
        },
        scopes: ['project'],
        scopeSelectionSource: 'explicit',
        signal: controller.signal,
      },
    ];
    for (const [index, candidate] of valid.entries()) {
      const result = await readBeforeMethods(candidate);
      expect(result, `valid provenance ${index}`).toMatchObject({
        ok: false,
        error: { reason: 'cancelled' },
      });
    }

    const invalid: readonly Readonly<StatusReadRequest>[] = [
      request(selected('discovered-project', MANIFEST_PATH, LOCK_PATH)),
      request(selected('discovered-project', '/repo/other.toml', '/repo/other.lock')),
      request(selected('project-default', MANIFEST_PATH, LOCK_PATH)),
      {
        ...request(selected('discovered-project', MANIFEST_PATH, LOCK_PATH)),
        projectContext: noDiscoveryContext,
        scopes: ['project'],
        scopeSelectionSource: 'explicit',
      },
      {
        ...request(selected('project-default', '/repo/other.toml', '/repo/other.lock')),
        projectContext: noDiscoveryContext,
        scopes: ['project'],
        scopeSelectionSource: 'explicit',
      },
      request(
        selected('user-default', '/home/wrong/skillsmith.toml', '/home/wrong/skillsmith.lock'),
      ),
      request(selected('user-default', userManifest, userLock, 'explicit')),
      request(selected('explicit', MANIFEST_PATH, '/elsewhere/skillsmith.lock')),
      request(selected('explicit', '/repo/./skillsmith.toml', LOCK_PATH, 'explicit')),
      request(selected('explicit', MANIFEST_PATH, '/repo/nested/../skillsmith.lock', 'explicit')),
      request(selected('explicit', '/repo/artifacts/..', ROOT, 'explicit')),
      {
        ...request(selected('user-default', userManifest, userLock)),
        scopes: ['system'],
        scopeSelectionSource: 'explicit',
      },
      {
        ...request(),
        projectContext: { ...outsideContext, projectRoot: ROOT, projectIdentity: ROOT },
      },
      {
        ...request(),
        projectContext: {
          ...nonGitDiscoveredContext,
          projectRoot: '/other',
          projectIdentity: '/other',
        },
        projectPlacement: {
          state: 'selected',
          source: 'shared-project',
          canonicalCwd: '/other',
          root: '/other',
          identity: '/other',
        },
      },
      {
        ...request(),
        projectContext: { ...projectContext, discoveredConfigPath: '/repo/other.toml' },
      },
      {
        ...request(),
        projectContext: { ...projectContext, discoveredConfigPath: '/outside/skillsmith.toml' },
      },
    ];
    for (const [index, candidate] of invalid.entries()) {
      const result = await readBeforeMethods(candidate);
      expect(result, `invalid provenance ${index}`).toMatchObject({
        ok: false,
        error: { reason: 'invalid-request' },
      });
    }
  });

  test('revalidates canonical cwd before out-of-context I/O and preserves gate errors', async () => {
    const readStatus = await loadReader();
    const nonGitContext: ProjectContext = {
      invocationCwd: ROOT,
      effectiveCwd: ROOT,
      projectRoot: null,
      projectIdentity: null,
      projectKind: 'non-git',
      discoveredConfigPath: null,
      explicitConfigPath: null,
    };
    const candidates: readonly Readonly<StatusReadRequest>[] = [
      request(),
      {
        ...request(),
        projectContext: nonGitContext,
        projectPlacement: {
          state: 'selected',
          source: 'explicit-non-git',
          canonicalCwd: ROOT,
          root: ROOT,
          identity: ROOT,
        },
        scopes: ['project'],
        scopeSelectionSource: 'explicit',
      },
    ];
    const readAtGate = async (
      candidate: Readonly<StatusReadRequest>,
      canonicalize: (path: string) => Promise<string>,
    ) => {
      const base = readPorts();
      let canonicalCalls = 0;
      let outOfContextCalls = 0;
      const ports = new Proxy(base, {
        get(target, property, receiver) {
          if (property === 'realpath') {
            return async (path: string) => {
              canonicalCalls += 1;
              return canonicalize(path);
            };
          }
          const value = Reflect.get(target, property, receiver);
          if (typeof value !== 'function') return value;
          return (...args: never[]) => {
            outOfContextCalls += 1;
            return (value as (...values: never[]) => unknown)(...args);
          };
        },
      });
      const result = await readStatus(ports, candidate);
      return { result, canonicalCalls, outOfContextCalls };
    };

    for (const candidate of candidates) {
      const forged = await readAtGate(candidate, async () => '/foreign/canonical-cwd');
      expect(forged.result).toMatchObject({
        ok: false,
        error: { reason: 'invalid-request' },
      });
      expect(forged.canonicalCalls).toBe(1);
      expect(forged.outOfContextCalls).toBe(0);
    }

    const failures = [
      [Object.assign(new Error('cancelled gate'), { code: 'ABORT_ERR' }), 'cancelled'],
      [Object.assign(new Error('denied gate'), { code: 'EACCES' }), 'permission-denied'],
      [new Error('failed gate'), 'observation-failed'],
    ] as const;
    for (const [failure, reason] of failures) {
      const mapped = await readAtGate(request(), async () => {
        throw failure;
      });
      expect(mapped.result).toMatchObject({ ok: false, error: { reason } });
      expect(mapped.canonicalCalls).toBe(1);
      expect(mapped.outOfContextCalls).toBe(0);
    }
  });

  test('ignores stale listed children unless durable ledger state derives absence', async () => {
    const readStatus = await loadReader();
    const liveOnly = await readStatus(readPorts({ listing: ['ghost'] }), request());
    expect(liveOnly.ok).toBeTrue();
    if (!liveOnly.ok) throw new Error('expected stale listing to be ignored');
    expect(liveOnly.value.entries).toEqual([]);

    const durable = await readStatus(
      readPorts({ listing: ['ghost'], bytes: artifactBytes(['ghost']) }),
      request(),
    );
    expect(durable.ok).toBeTrue();
    if (!durable.ok) throw new Error('expected ledger-derived absent placement');
    expect(durable.value.entries).toHaveLength(1);
    expect(durable.value.entries[0]?.name).toBe('ghost');
    expect(durable.value.entries[0]?.placements).toHaveLength(1);
    expect(durable.value.entries[0]?.placements[0]).toMatchObject({
      classification: 'broken',
      brokenReason: 'ledger-recorded-absence',
      live: { state: 'absent' },
    });
  });

  test('projects canonical pair membership and mismatch facts with exact values', () => {
    const manifest = manifestModel(['alpha']);
    const missing = unwrapJoin(
      joinInput({
        request: selectedArtifactRequest(),
        manifest: artifactPresent('manifest', manifest, 1),
        lock: artifactPresent('lock', lockModel([], manifest), 1),
      }),
    );
    expect(relationshipOf(missing)).toMatchObject({
      state: 'incomplete',
      missingNames: ['alpha'],
    });
    expect(missing.entries[0]?.facts).toContainEqual(
      expect.objectContaining({
        code: 'lock-missing-entry',
        expected: 'present',
        actual: 'absent',
      }),
    );
    expect(missing.entries[0]?.facts.map((fact) => fact.code)).not.toContain('manifest-only');

    const emptyManifest = manifestModel([]);
    const extra = unwrapJoin(
      joinInput({
        request: selectedArtifactRequest({
          toolSelectionSource: 'unbounded-default',
          scopeSelectionSource: 'unbounded-default',
        }),
        manifest: artifactPresent('manifest', emptyManifest, 1),
        lock: artifactPresent('lock', lockModel(['alpha'], emptyManifest), 1),
      }),
    );
    expect(relationshipOf(extra)).toMatchObject({ state: 'incomplete', missingNames: [] });
    expect(extra.entries[0]?.facts).toContainEqual(
      expect.objectContaining({
        code: 'lock-extra-entry',
        expected: 'absent',
        actual: 'present',
      }),
    );
    expect(extra.entries[0]?.facts.map((fact) => fact.code)).not.toContain('lock-only');

    const staleLock = lockModel(['alpha'], manifest);
    const stale = unwrapJoin(
      joinInput({
        request: selectedArtifactRequest(),
        manifest: artifactPresent('manifest', manifest, 1),
        lock: artifactPresent(
          'lock',
          {
            ...staleLock,
            skills: [
              {
                ...(staleLock.skills[0] as PortableLockV1['skills'][number]),
                source: 'github.com/other/repository//wrong',
                requestedRef: 'v9',
                sourcePath: 'wrong',
              },
            ],
          },
          1,
        ),
      }),
    );
    expect(relationshipOf(stale).state).toBe('stale');
    expect(stale.entries[0]?.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'lock-source',
          expected: 'github.com/acme/skills//alpha',
          actual: 'github.com/other/repository//wrong',
        }),
        expect.objectContaining({ code: 'lock-ref', expected: null, actual: 'v9' }),
        expect.objectContaining({
          code: 'lock-source-path',
          expected: 'alpha',
          actual: 'wrong',
        }),
      ]),
    );
  });

  test('suppresses a correlated lock when its canonical declaration is context-filtered', () => {
    const userManifest = manifestModel(['alpha']);
    const projectManifest: NormalizedManifestV1 = {
      ...userManifest,
      skills: userManifest.skills.map((skill) => ({
        ...skill,
        scope: 'project',
        path: './.agents/skills/alpha',
      })),
    };
    const context: ProjectContext = {
      invocationCwd: ROOT,
      effectiveCwd: ROOT,
      projectRoot: null,
      projectIdentity: null,
      projectKind: 'non-git',
      discoveredConfigPath: null,
      explicitConfigPath: null,
    };
    const canonicalLock = lockModel(['alpha'], projectManifest);
    const canonicalSkill = canonicalLock.skills[0];
    if (canonicalSkill === undefined) throw new Error('missing canonical lock fixture');
    const report = unwrapJoin(
      joinInput({
        request: selectedArtifactRequest({
          projectContext: context,
          projectPlacement: { state: 'unselected' },
          targets: ['alpha'],
          selectionSource: 'explicit-targets',
          tools: ['codex'],
          toolSelectionSource: 'unbounded-default',
          scopes: ['user'],
          scopeSelectionSource: 'unbounded-default',
        }),
        manifest: artifactPresent('manifest', projectManifest, 1),
        lock: artifactPresent(
          'lock',
          {
            ...canonicalLock,
            manifestHash: CONTENT_HASH,
            skills: [
              {
                ...canonicalSkill,
                source: 'github.com/other/repository//wrong',
                requestedRef: 'v9',
                sourcePath: 'wrong',
              },
            ],
          },
          1,
        ),
        ledger: artifactPresent(
          'ledger',
          emptyLedgerModel({ skills: { alpha: { tools: { codex: pairFor('alpha') } } } }),
          2,
        ),
        live: [liveInput('alpha', join(CODEX_ROOT, 'alpha'))],
      }),
    );
    expect(report.selection).toMatchObject({ outcome: 'selected' });
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]).toMatchObject({
      name: 'alpha',
      desired: { state: 'absent' },
      locked: { state: 'absent' },
    });
    expect(report.entries[0]?.facts.map((fact) => fact.code)).not.toEqual(
      expect.arrayContaining([
        'lock-missing-entry',
        'lock-extra-entry',
        'lock-source',
        'lock-ref',
        'lock-source-path',
      ]),
    );
    expect(relationshipOf(report)).toEqual({ state: 'none' });
    expect(report.facts.map((fact) => fact.code)).not.toEqual(
      expect.arrayContaining(['lock-only', 'lock-manifest-hash']),
    );
  });

  test('normalizes ledger root origin skill paths to null without changing nested paths', () => {
    const rootPair: LedgerPairV1Dto = {
      ...pairFor('root'),
      origin: {
        ...(pairFor('root').origin as NonNullable<LedgerPairV1Dto['origin']>),
        skillPath: '',
      },
    };
    const nestedPair = pairFor('nested');
    const ledger = emptyLedgerModel({
      skills: {
        root: { tools: { codex: rootPair } },
        nested: { tools: { codex: nestedPair } },
      },
    });
    const report = unwrapJoin(
      joinInput({
        ledger: artifactPresent('ledger', ledger, 2),
      }),
    );
    const sources = Object.fromEntries(
      report.entries.map((entry) => [
        entry.name,
        entry.placements[0]?.ledger.state === 'present'
          ? entry.placements[0].ledger.value.source?.path
          : undefined,
      ]),
    );
    expect(sources).toEqual({ nested: 'nested', root: null });
  });

  test('projects committed legacy pinned-to-dev reversal as one store-only retention requirement', () => {
    const path = join(CODEX_ROOT, 'alpha');
    const storePath = join(DATA_ROOT, 'store', 'retained-alpha');
    const pair: LedgerPairV1Dto = {
      ...pairFor('alpha'),
      placementPath: path,
      mode: 'dev',
      dev: {
        sourcePath: '/source/alpha',
        resolvedPath: '/source/alpha',
        repoRoot: '/source',
        sourceRelPath: 'alpha',
        remote: null,
        recordedAt: '2026-07-14T00:00:00.000Z',
      },
      pinned: null,
      journal: {
        op: 'dev',
        txId: 'tx:pinned-to-dev',
        phase: 'committed',
        startedAt: '2026-07-14T00:00:00.000Z',
        completedAt: '2026-07-14T00:00:01.000Z',
        before: {
          mode: 'pinned',
          storePath,
          contentHash: CONTENT_HASH,
          liveKind: 'dir',
        },
        stagingPath: `${path}.stage`,
        backupPath: `${path}.backup`,
      },
    };
    const retention: StatusRetentionProbeInput = {
      transactionId: 'tx:pinned-to-dev',
      resourceId: null,
      path: storePath,
      pathState: 'satisfied',
      repositoryRevision: { state: 'unverified', digest: null },
      contentHash: { state: 'observed', digest: CONTENT_HASH },
      node: { state: 'observed', kind: 'directory', linkTarget: null },
    };
    const report = unwrapJoin(
      joinInput({
        ledger: artifactPresent(
          'ledger',
          emptyLedgerModel({ skills: { alpha: { tools: { codex: pair } } } }),
          2,
        ),
        live: [
          {
            ...liveInput('alpha', path),
            physicalClass: 'dev',
            observation: {
              path,
              realpath: '/source/alpha',
              nodeKind: 'symlink',
              linkTarget: '/source/alpha',
              skillFile: 'valid',
            },
          },
        ],
        retention: [retention],
      }),
    );
    expect(report.entries[0]?.placements[0]?.journal).toMatchObject({
      state: 'committed',
      format: 'legacy-pair',
      reverseEligibility: 'eligible',
      retention: [
        {
          role: 'store',
          sourceRole: null,
          path: storePath,
          state: 'satisfied',
        },
      ],
      remediation: {
        reverse: ['skillsmith', 'undo', path, '--tool', 'codex', '--scope', 'user'],
      },
    });
    const journal = report.entries[0]?.placements[0]?.journal;
    expect(journal === undefined || journal.state === 'none' ? [] : journal.retention).toHaveLength(
      1,
    );

    const missingTargetPair: LedgerPairV1Dto = {
      ...pair,
      journal: {
        ...(pair.journal as NonNullable<LedgerPairV1Dto['journal']>),
        txId: 'tx:pinned-symlink-to-dev',
        before: {
          mode: 'pinned',
          storePath,
          contentHash: CONTENT_HASH,
          liveKind: 'symlink',
        },
      },
    };
    const missingTargetReport = unwrapJoin(
      joinInput({
        ledger: artifactPresent(
          'ledger',
          emptyLedgerModel({ skills: { alpha: { tools: { codex: missingTargetPair } } } }),
          2,
        ),
        live: [
          {
            ...liveInput('alpha', path),
            physicalClass: 'dev',
            observation: {
              path,
              realpath: '/source/alpha',
              nodeKind: 'symlink',
              linkTarget: '/source/alpha',
              skillFile: 'valid',
            },
          },
        ],
        retention: [{ ...retention, transactionId: 'tx:pinned-symlink-to-dev' }],
      }),
    );
    expect(missingTargetReport.entries[0]?.placements[0]?.journal).toMatchObject({
      state: 'committed',
      reverseEligibility: 'eligible',
      retention: [
        {
          role: 'store',
          structural: { expected: { kind: 'directory', linkTarget: null } },
          state: 'satisfied',
        },
      ],
      remediation: { reverse: expect.any(Array) },
    });
  });

  test('uses literal structure alone for recoverable pinned legacy symlinks', () => {
    const path = join(CODEX_ROOT, 'alpha');
    const backupPath = `${path}.backup`;
    const linkTarget = '/retained/source/alpha';
    const reportFor = (
      phase: 'live' | 'committed',
      observedKind: 'symlink' | 'directory',
      observedTarget: string | null,
    ) => {
      const pair: LedgerPairV1Dto = {
        ...pairFor('alpha'),
        journal: {
          op: 'uninstall',
          txId: `tx:pinned-${phase}-${observedKind}`,
          phase,
          startedAt: '2026-07-14T00:00:00.000Z',
          completedAt: phase === 'committed' ? '2026-07-14T00:00:01.000Z' : null,
          before: {
            mode: 'pinned',
            storePath: join(DATA_ROOT, 'store', 'retained-alpha'),
            contentHash: CONTENT_HASH,
            liveKind: observedKind === 'directory' ? 'dir' : 'symlink',
            ...(observedKind === 'symlink' ? { symlinkTarget: linkTarget } : {}),
          },
          stagingPath: `${path}.stage`,
          backupPath,
        },
      };
      const retention: StatusRetentionProbeInput = {
        transactionId: pair.journal?.txId ?? '',
        resourceId: null,
        path: backupPath,
        pathState: 'satisfied',
        repositoryRevision: { state: 'unverified', digest: null },
        contentHash: { state: 'unverified', digest: null },
        node: {
          state: 'observed',
          kind: observedKind,
          linkTarget: observedTarget,
        },
      };
      return unwrapJoin(
        joinInput({
          ledger: artifactPresent(
            'ledger',
            emptyLedgerModel({ skills: { alpha: { tools: { codex: pair } } } }),
            2,
          ),
          retention: [retention],
        }),
      ).entries[0]?.placements[0]?.journal;
    };

    for (const phase of ['live', 'committed'] as const) {
      const exact = reportFor(phase, 'symlink', linkTarget);
      expect(exact, phase).toMatchObject({
        state: phase === 'live' ? 'pending' : 'committed',
        retention: [
          {
            structural: { state: 'satisfied' },
            contentHash: { state: 'not-recorded' },
            state: 'satisfied',
          },
        ],
        ...(phase === 'live'
          ? {
              abortEligibility: 'eligible',
              remediation: { abort: expect.any(Array) },
            }
          : {
              reverseEligibility: 'eligible',
              remediation: { reverse: expect.any(Array) },
            }),
      });
    }

    const wrongTarget = reportFor('live', 'symlink', '/wrong/target');
    expect(wrongTarget).toMatchObject({
      state: 'pending',
      abortEligibility: 'retention-mismatch',
      retention: [{ structural: { state: 'mismatch' }, state: 'mismatch' }],
      remediation: { abort: null },
    });
    const directory = reportFor('live', 'directory', null);
    expect(directory).toMatchObject({
      state: 'pending',
      abortEligibility: 'retention-unverified',
      retention: [
        {
          structural: { state: 'satisfied' },
          contentHash: { state: 'unverified' },
          state: 'unverified',
        },
      ],
      remediation: { abort: null },
    });
  });

  test('fails closed for legacy before-images that v1 cannot reverse unambiguously', () => {
    const absentPath = join(CODEX_ROOT, 'absent-before');
    const absentBackup = `${absentPath}.backup`;
    const absentPair: LedgerPairV1Dto = {
      ...pairFor('absent-before'),
      placementPath: absentPath,
      journal: {
        op: 'uninstall',
        txId: 'tx:absent-before',
        phase: 'committed',
        startedAt: '2026-07-14T00:00:00.000Z',
        completedAt: '2026-07-14T00:00:01.000Z',
        before: { mode: 'absent' },
        stagingPath: `${absentPath}.stage`,
        backupPath: absentBackup,
      },
    };
    const missingTargetPath = join(CODEX_ROOT, 'missing-target');
    const missingTargetBackup = `${missingTargetPath}.backup`;
    const missingTargetPair: LedgerPairV1Dto = {
      ...pairFor('missing-target'),
      placementPath: missingTargetPath,
      journal: {
        op: 'uninstall',
        txId: 'tx:missing-target',
        phase: 'committed',
        startedAt: '2026-07-14T00:00:00.000Z',
        completedAt: '2026-07-14T00:00:01.000Z',
        before: {
          mode: 'pinned',
          storePath: join(DATA_ROOT, 'store', 'missing-target'),
          contentHash: CONTENT_HASH,
          liveKind: 'symlink',
        },
        stagingPath: `${missingTargetPath}.stage`,
        backupPath: missingTargetBackup,
      },
    };
    const backedUpPath = join(CODEX_ROOT, 'missing-target-backed-up');
    const backedUpBackup = `${backedUpPath}.backup`;
    const backedUpPair: LedgerPairV1Dto = {
      ...pairFor('missing-target-backed-up'),
      placementPath: backedUpPath,
      journal: {
        op: 'uninstall',
        txId: 'tx:missing-target-backed-up',
        phase: 'backed-up',
        startedAt: '2026-07-14T00:00:00.000Z',
        completedAt: null,
        before: {
          mode: 'pinned',
          storePath: join(DATA_ROOT, 'store', 'missing-target-backed-up'),
          contentHash: CONTENT_HASH,
          liveKind: 'symlink',
        },
        stagingPath: `${backedUpPath}.stage`,
        backupPath: backedUpBackup,
      },
    };
    const livePath = join(CODEX_ROOT, 'missing-target-live');
    const liveBackup = `${livePath}.backup`;
    const livePair: LedgerPairV1Dto = {
      ...pairFor('missing-target-live'),
      placementPath: livePath,
      journal: {
        op: 'uninstall',
        txId: 'tx:missing-target-live',
        phase: 'live',
        startedAt: '2026-07-14T00:00:00.000Z',
        completedAt: null,
        before: {
          mode: 'pinned',
          storePath: join(DATA_ROOT, 'store', 'missing-target-live'),
          contentHash: CONTENT_HASH,
          liveKind: 'symlink',
        },
        stagingPath: `${livePath}.stage`,
        backupPath: liveBackup,
      },
    };
    const report = unwrapJoin(
      joinInput({
        ledger: artifactPresent(
          'ledger',
          emptyLedgerModel({
            skills: {
              'absent-before': { tools: { codex: absentPair } },
              'missing-target': { tools: { codex: missingTargetPair } },
              'missing-target-backed-up': { tools: { codex: backedUpPair } },
              'missing-target-live': { tools: { codex: livePair } },
            },
          }),
          2,
        ),
        retention: [
          {
            transactionId: 'tx:absent-before',
            resourceId: null,
            path: absentBackup,
            pathState: 'satisfied',
            repositoryRevision: { state: 'unverified', digest: null },
            contentHash: { state: 'unverified', digest: null },
            node: { state: 'observed', kind: 'absent', linkTarget: null },
          },
          {
            transactionId: 'tx:missing-target',
            resourceId: null,
            path: missingTargetBackup,
            pathState: 'satisfied',
            repositoryRevision: { state: 'unverified', digest: null },
            contentHash: { state: 'unverified', digest: null },
            node: { state: 'observed', kind: 'symlink', linkTarget: '' },
          },
          {
            transactionId: 'tx:missing-target-backed-up',
            resourceId: null,
            path: backedUpBackup,
            pathState: 'satisfied',
            repositoryRevision: { state: 'unverified', digest: null },
            contentHash: { state: 'unverified', digest: null },
            node: { state: 'observed', kind: 'symlink', linkTarget: '/observed/backed-up' },
          },
          {
            transactionId: 'tx:missing-target-live',
            resourceId: null,
            path: liveBackup,
            pathState: 'satisfied',
            repositoryRevision: { state: 'unverified', digest: null },
            contentHash: { state: 'unverified', digest: null },
            node: { state: 'observed', kind: 'symlink', linkTarget: '/observed/live' },
          },
        ],
      }),
    );
    const journals = Object.fromEntries(
      report.entries.map((entry) => [entry.name, entry.placements[0]?.journal]),
    );
    expect(journals['absent-before']).toMatchObject({
      state: 'committed',
      reverseEligibility: 'not-reversible',
      remediation: { reverse: null },
    });
    expect(journals['missing-target']).toMatchObject({
      state: 'committed',
      before: 'pinned',
      reverseEligibility: 'not-reversible',
      retention: [{ structural: { expected: { kind: 'symlink', linkTarget: null } } }],
      remediation: { reverse: null },
    });
    for (const name of ['missing-target-backed-up', 'missing-target-live']) {
      expect(journals[name], name).toMatchObject({
        state: 'pending',
        abortEligibility: 'not-reversible',
        retention: [
          {
            structural: {
              state: 'mismatch',
              expected: { kind: 'symlink', linkTarget: null },
            },
          },
        ],
        remediation: { abort: null },
      });
    }
  });

  test('includes legacy path state in the aggregate before mapping to status@1', () => {
    const path = join(CODEX_ROOT, 'path-state');
    const backupPath = `${path}.backup`;
    const pair: LedgerPairV1Dto = {
      ...pairFor('path-state'),
      placementPath: path,
      journal: {
        op: 'uninstall',
        txId: 'tx:path-state',
        phase: 'committed',
        startedAt: '2026-07-14T00:00:00.000Z',
        completedAt: '2026-07-14T00:00:01.000Z',
        before: {
          mode: 'pinned',
          storePath: join(DATA_ROOT, 'store', 'path-state'),
          contentHash: null,
          liveKind: 'dir',
        },
        stagingPath: `${path}.stage`,
        backupPath,
      },
    };
    const report = unwrapJoin(
      joinInput({
        ledger: artifactPresent(
          'ledger',
          emptyLedgerModel({ skills: { 'path-state': { tools: { codex: pair } } } }),
          2,
        ),
        retention: [
          {
            transactionId: 'tx:path-state',
            resourceId: null,
            path: backupPath,
            pathState: 'unverified',
            repositoryRevision: { state: 'unverified', digest: null },
            contentHash: { state: 'unverified', digest: null },
            node: { state: 'observed', kind: 'directory', linkTarget: null },
          },
        ],
      }),
    );
    expect(report.entries[0]?.placements[0]?.journal).toMatchObject({
      state: 'committed',
      reverseEligibility: 'retention-unverified',
      retention: [
        {
          pathState: 'unverified',
          structural: { state: 'unverified', observed: null },
          contentHash: { state: 'not-recorded' },
          state: 'unverified',
        },
      ],
    });
    expect(() => toStatusV1Dto(report)).not.toThrow();
  });

  test('uses the exact selected portable set for pair-global manifest hash projection', () => {
    const manifest = manifestModel(['alpha', 'beta']);
    const canonical = lockModel(['alpha', 'beta'], manifest);
    const staleLock: PortableLockV1 = { ...canonical, manifestHash: CONTENT_HASH };
    const alphaAndLocal = unwrapJoin(
      joinInput({
        request: selectedArtifactRequest({
          targets: ['alpha', 'local-only'],
          selectionSource: 'explicit-targets',
        }),
        manifest: artifactPresent('manifest', manifest, 1),
        lock: artifactPresent('lock', staleLock, 1),
        live: [liveInput('local-only', join(CODEX_ROOT, 'local-only'))],
      }),
    );
    expect(alphaAndLocal.entries.map((entry) => entry.name)).toEqual(['alpha', 'local-only']);
    expect(relationshipOf(alphaAndLocal).state).toBe('current');
    expect(alphaAndLocal.facts.map((fact) => fact.code)).not.toContain('lock-manifest-hash');

    const completePortableSet = unwrapJoin(
      joinInput({
        request: selectedArtifactRequest(),
        manifest: artifactPresent('manifest', manifest, 1),
        lock: artifactPresent('lock', staleLock, 1),
      }),
    );
    expect(relationshipOf(completePortableSet).state).toBe('stale');
    expect(completePortableSet.facts).toContainEqual(
      expect.objectContaining({ code: 'lock-manifest-hash' }),
    );
    const completePortableSetPlusLocal = unwrapJoin(
      joinInput({
        request: selectedArtifactRequest({
          targets: ['alpha', 'beta', 'local-only'],
          selectionSource: 'explicit-targets',
        }),
        manifest: artifactPresent('manifest', manifest, 1),
        lock: artifactPresent('lock', staleLock, 1),
        live: [liveInput('local-only', join(CODEX_ROOT, 'local-only'))],
      }),
    );
    expect(relationshipOf(completePortableSetPlusLocal).state).toBe('stale');
    expect(completePortableSetPlusLocal.facts).toContainEqual(
      expect.objectContaining({ code: 'lock-manifest-hash' }),
    );
  });

  test('bounds exact-path projection to matched rows before facts, journals, and shadows', () => {
    const userPath = join(CODEX_ROOT, 'alpha');
    const projectPath = join(ROOT, '.agents', 'skills', 'alpha');
    const userPair = { ...pairFor('alpha'), placementPath: userPath };
    const projectPair = {
      ...pairFor('alpha'),
      placementPath: projectPath,
      journal: {
        op: 'install' as const,
        txId: 'tx:unselected-project',
        phase: 'live' as const,
        startedAt: '2026-07-14T00:00:00.000Z',
        completedAt: null,
        before: { mode: 'absent' as const },
        stagingPath: `${projectPath}.stage`,
        backupPath: `${projectPath}.backup`,
      },
    };
    const ledger = emptyLedgerModel({
      skills: { alpha: { tools: { codex: userPair } } },
      projects: {
        [ROOT]: { skills: { alpha: { tools: { codex: projectPair } } } },
      },
    });
    const report = unwrapJoin(
      joinInput({
        request: statusRequest({
          targets: [userPath],
          selectionSource: 'explicit-targets',
          scopes: ['user', 'project'],
        }),
        ledger: artifactPresent('ledger', ledger, 2),
        live: [liveInput('alpha', userPath), liveInput('alpha', projectPath, 'project')],
      }),
    );
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]?.placements).toHaveLength(1);
    expect(report.entries[0]?.placements[0]).toMatchObject({
      identity: { path: userPath, scope: 'user' },
      shadow: { state: 'none' },
      journal: { state: 'none' },
    });
    expect(report.entries[0]?.placements[0]?.facts.map((fact) => fact.code)).not.toEqual(
      expect.arrayContaining(['shadowed', 'duplicate-live', 'journal-pending']),
    );
  });

  test('bounds exact-mappable journals by name versus placement without inventing mismatched rows', () => {
    const concretePath = join(CODEX_ROOT, 'alpha');
    const journalPath = join(CODEX_ROOT, 'alternate', 'alpha');
    const otherPath = join(CODEX_ROOT, 'other', 'alpha');
    const journal = logicalJournal({
      name: 'alpha',
      path: journalPath,
      transactionId: 'tx:placement-matrix',
    });
    const ledger = artifactPresent(
      'ledger',
      emptyLedgerModel({ transactions: { [journal.transactionId]: journal } }),
      2,
    );
    const withConcrete = (requestValue: Readonly<StatusReadRequest>) =>
      joinInput({ request: requestValue, ledger, live: [liveInput('alpha', concretePath)] });

    const nameOnly = unwrapJoin(
      withConcrete(statusRequest({ targets: ['alpha'], selectionSource: 'explicit-targets' })),
    );
    expect(nameOnly.entries[0]?.placements.map((placement) => placement.identity.path)).toEqual([
      concretePath,
    ]);
    expect(nameOnly.entries[0]?.placements[0]?.journal).toEqual({ state: 'none' });
    expect(nameOnly.journals).toContainEqual(
      expect.objectContaining({
        transactionId: journal.transactionId,
        reason: 'unselected-placement',
      }),
    );
    expect(nameOnly.facts).toContainEqual(expect.objectContaining({ code: 'journal-pending' }));

    const exactJournalPath = unwrapJoin(
      withConcrete(statusRequest({ targets: [journalPath], selectionSource: 'explicit-targets' })),
    );
    expect(exactJournalPath.entries[0]?.placements).toHaveLength(1);
    expect(exactJournalPath.entries[0]?.placements[0]).toMatchObject({
      identity: { path: journalPath },
      classification: 'absent',
      journal: { state: 'pending', transactionId: journal.transactionId },
    });
    expect(exactJournalPath.journals).toEqual([]);

    const exactConcretePath = unwrapJoin(
      withConcrete(statusRequest({ targets: [concretePath], selectionSource: 'explicit-targets' })),
    );
    expect(exactConcretePath.entries[0]?.placements).toHaveLength(1);
    expect(exactConcretePath.entries[0]?.placements[0]).toMatchObject({
      identity: { path: concretePath },
      journal: { state: 'none' },
    });
    expect(exactConcretePath.journals).toEqual([]);

    const exactOtherPath = joinStatus(
      withConcrete(statusRequest({ targets: [otherPath], selectionSource: 'explicit-targets' })),
    );
    expect(exactOtherPath).toEqual({ ok: false, error: { reason: 'unmatched-target' } });

    const bounded = unwrapJoin(withConcrete(statusRequest()));
    expect(bounded.entries[0]?.placements.map((placement) => placement.identity.path)).toEqual([
      concretePath,
      journalPath,
    ]);
    expect(
      bounded.entries[0]?.placements.find((placement) => placement.identity.path === journalPath)
        ?.journal,
    ).toMatchObject({ state: 'pending', transactionId: journal.transactionId });

    const noConcrete = unwrapJoin(
      joinInput({
        request: statusRequest({ targets: ['alpha'], selectionSource: 'explicit-targets' }),
        ledger,
      }),
    );
    expect(noConcrete.entries[0]?.placements).toHaveLength(1);
    expect(noConcrete.entries[0]?.placements[0]).toMatchObject({
      identity: { path: journalPath },
      journal: { state: 'pending', transactionId: journal.transactionId },
    });
  });

  test('retains selected top-level multi-resource journals as real selection context', () => {
    const base = logicalJournal({
      name: 'alpha',
      path: join(CODEX_ROOT, 'alpha'),
      transactionId: 'tx:multi-resource',
    });
    const firstBefore = base.actual.before.find((resource) => resource.role === 'live');
    const firstAfter = base.actual.after.find((resource) => resource.role === 'live');
    if (firstBefore === undefined || firstAfter === undefined) {
      throw new Error('missing logical live fixture');
    }
    const journal: LogicalJournalV1Dto = {
      ...base,
      actual: {
        ...base.actual,
        before: [
          ...base.actual.before,
          {
            ...firstBefore,
            resourceId: 'resource:alpha:second-before',
            placementPath: join(CODEX_ROOT, 'alternate', 'alpha'),
          },
        ],
        after: [
          ...base.actual.after,
          {
            ...firstAfter,
            resourceId: 'resource:alpha:second-after',
            placementPath: join(CODEX_ROOT, 'alternate', 'alpha'),
          },
        ],
      },
    };
    const filteredPair = pairFor('beta');
    const ledger = (withFiltered: boolean) =>
      artifactPresent(
        'ledger',
        emptyLedgerModel({
          skills: withFiltered ? { beta: { tools: { 'claude-code': filteredPair } } } : {},
          transactions: { [journal.transactionId]: journal },
        }),
        2,
      );

    const explicit = unwrapJoin(
      joinInput({
        request: statusRequest({ targets: ['alpha'], selectionSource: 'explicit-targets' }),
        ledger: ledger(false),
      }),
    );
    expect(explicit.selection).toMatchObject({ outcome: 'selected' });
    expect(explicit.entries).toEqual([]);
    expect(explicit.summary).toMatchObject({ entries: 0, converged: 0, drifting: 0 });
    expect(explicit.journals).toEqual([
      expect.objectContaining({ transactionId: journal.transactionId, reason: 'multi-resource' }),
    ]);
    expect(explicit.facts).toContainEqual(expect.objectContaining({ code: 'journal-pending' }));

    const bounded = unwrapJoin(joinInput({ ledger: ledger(false) }));
    expect(bounded.selection).toMatchObject({ outcome: 'selected' });
    expect(bounded.entries).toEqual([]);
    expect(bounded.journals).toHaveLength(1);

    const mixed = unwrapJoin(
      joinInput({
        request: statusRequest({
          targets: ['alpha', 'beta'],
          selectionSource: 'explicit-targets',
        }),
        ledger: ledger(true),
      }),
    );
    expect(mixed.selection).toMatchObject({ outcome: 'selected', reason: null });
    expect(mixed.entries).toEqual([]);
    expect(mixed.journals).toHaveLength(1);
    expect(mixed.facts).toContainEqual(expect.objectContaining({ code: 'journal-pending' }));

    const pathTarget = joinStatus(
      joinInput({
        request: statusRequest({
          targets: [join(CODEX_ROOT, 'alpha')],
          selectionSource: 'explicit-targets',
        }),
        ledger: ledger(false),
      }),
    );
    expect(pathTarget).toEqual({ ok: false, error: { reason: 'unmatched-target' } });
  });

  test('distinguishes filtered ledger and logical membership from unmatched live-only targets', () => {
    const filteredLedger = emptyLedgerModel({
      skills: { alpha: { tools: { 'claude-code': pairFor('alpha') } } },
    });
    const ledgerNoop = unwrapJoin(
      joinInput({
        request: statusRequest({ targets: ['alpha'], selectionSource: 'explicit-targets' }),
        ledger: artifactPresent('ledger', filteredLedger, 2),
      }),
    );
    expect(ledgerNoop.selection).toMatchObject({ outcome: 'filter-noop' });

    const filteredLogical = logicalJournal({
      name: 'beta',
      path: join(HOME, '.claude', 'skills', 'beta'),
      transactionId: 'tx:filtered-logical',
      tool: 'claude-code',
    });
    const logicalNoop = unwrapJoin(
      joinInput({
        request: statusRequest({ targets: ['beta'], selectionSource: 'explicit-targets' }),
        ledger: artifactPresent(
          'ledger',
          emptyLedgerModel({ transactions: { [filteredLogical.transactionId]: filteredLogical } }),
          2,
        ),
      }),
    );
    expect(logicalNoop.selection).toMatchObject({ outcome: 'filter-noop' });

    const scopeFilteredLedger = emptyLedgerModel({
      projects: {
        [ROOT]: { skills: { gamma: { tools: { codex: pairFor('gamma') } } } },
      },
    });
    const ledgerScopeNoop = unwrapJoin(
      joinInput({
        request: statusRequest({ targets: ['gamma'], selectionSource: 'explicit-targets' }),
        ledger: artifactPresent('ledger', scopeFilteredLedger, 2),
      }),
    );
    expect(ledgerScopeNoop.selection).toMatchObject({ outcome: 'filter-noop' });

    const scopeFilteredLogical = logicalJournal({
      name: 'delta',
      path: join(ROOT, '.agents', 'skills', 'delta'),
      transactionId: 'tx:scope-filtered-logical',
      scope: 'project',
      projectRoot: ROOT,
    });
    const logicalScopeNoop = unwrapJoin(
      joinInput({
        request: statusRequest({ targets: ['delta'], selectionSource: 'explicit-targets' }),
        ledger: artifactPresent(
          'ledger',
          emptyLedgerModel({
            transactions: { [scopeFilteredLogical.transactionId]: scopeFilteredLogical },
          }),
          2,
        ),
      }),
    );
    expect(logicalScopeNoop.selection).toMatchObject({ outcome: 'filter-noop' });

    const unmatched = joinStatus(
      joinInput({
        request: statusRequest({
          targets: ['unselected-live-only'],
          selectionSource: 'explicit-targets',
        }),
      }),
    );
    expect(unmatched).toEqual({ ok: false, error: { reason: 'unmatched-target' } });
  });

  test('uses one known-or-unbounded predicate for unknown v2 pair journals and retention probes', async () => {
    const readStatus = await loadReader();
    const unknownTool = 'future-tool';
    const legacyPath = join(CODEX_ROOT, 'future-legacy');
    const legacyBackup = `${legacyPath}.backup`;
    const legacyPair: LedgerPairV1Dto = {
      ...pairFor('future-legacy'),
      placementPath: legacyPath,
      journal: {
        op: 'uninstall',
        txId: 'tx:future-legacy',
        phase: 'live',
        startedAt: '2026-07-14T00:00:00.000Z',
        completedAt: null,
        before: { mode: 'absent' },
        stagingPath: `${legacyPath}.stage`,
        backupPath: legacyBackup,
      },
    };
    const model = emptyLedgerModel({
      skills: {
        'future-legacy': { tools: { [unknownTool]: legacyPair } },
      },
    });
    const allKnownTools = ['claude-code', 'codex', 'kilo-code', 'opencode'] as const;

    for (const source of ['explicit', 'effective-config'] as const) {
      const filtered = unwrapJoin(
        joinInput({
          request: statusRequest({
            tools: allKnownTools,
            toolSelectionSource: source,
          }),
          ledger: artifactPresent('ledger', model, 2),
        }),
      );
      expect(filtered.selection, source).toMatchObject({ outcome: 'filter-noop' });
      expect(filtered.entries, source).toEqual([]);
      expect(filtered.journals, source).toEqual([]);
    }

    const retained = unwrapJoin(
      joinInput({
        request: statusRequest({
          tools: allKnownTools,
          toolSelectionSource: 'unbounded-default',
        }),
        ledger: artifactPresent('ledger', model, 2),
        retention: [
          {
            transactionId: 'tx:future-legacy',
            resourceId: null,
            path: legacyBackup,
            pathState: 'missing',
            repositoryRevision: { state: 'missing', digest: null },
            contentHash: { state: 'missing', digest: null },
            node: { state: 'observed', kind: 'absent', linkTarget: null },
          },
        ],
      }),
    );
    expect(retained.entries.map((entry) => entry.name)).toEqual(['future-legacy']);
    expect(retained.entries[0]?.placements[0]?.identity.tool).toBe(unknownTool);
    expect(
      retained.entries.map((entry) => {
        const journal = entry.placements[0]?.journal;
        return journal === undefined || !('retention' in journal)
          ? null
          : journal.retention[0]?.state;
      }),
    ).toEqual(['satisfied']);

    const encoded = ledgerV2Codec.encode(model);
    if (!encoded.ok) {
      throw new Error(`unknown ledger encoding failed: ${JSON.stringify(encoded.error)}`);
    }
    const bytes = new Map([[LEDGER_PATH, encoded.value]]);
    for (const source of ['explicit', 'effective-config'] as const) {
      const filteredProbes: string[] = [];
      const filteredBase = readPorts({ bytes });
      const filtered = await readStatus(
        {
          ...filteredBase,
          readFileMetadata: async (path) => {
            if (path === legacyBackup) filteredProbes.push(path);
            return filteredBase.readFileMetadata(path);
          },
        },
        { ...request(), tools: allKnownTools, toolSelectionSource: source },
      );
      expect(filtered.ok, source).toBeTrue();
      if (!filtered.ok) throw new Error(`expected ${source} filtered status product`);
      expect(filtered.value.selection, source).toMatchObject({ outcome: 'filter-noop' });
      expect(filtered.value.entries, source).toEqual([]);
      expect(filteredProbes, source).toEqual([]);
    }
    const probed: string[] = [];
    const base = readPorts({ bytes });
    const observed = await readStatus(
      {
        ...base,
        readFileMetadata: async (path) => {
          if (path === legacyBackup) probed.push(path);
          return base.readFileMetadata(path);
        },
      },
      {
        ...request(),
        tools: allKnownTools,
        toolSelectionSource: 'unbounded-default',
      },
    );
    expect(observed.ok).toBeTrue();
    if (!observed.ok) throw new Error('expected unbounded unknown-pair status product');
    expect(probed).toEqual([legacyBackup]);
    expect(observed.value.entries.map((entry) => entry.name)).toEqual(['future-legacy']);
    expect(
      observed.value.entries.map((entry) => {
        const journal = entry.placements[0]?.journal;
        if (journal === undefined || !('retention' in journal)) return null;
        return journal.retention[0]?.state;
      }),
    ).toEqual(['satisfied']);
  });

  test('emits retention facts only after the corresponding failure gate', () => {
    const retained = {
      resourceId: 'resource:retained',
      role: 'backup' as const,
      sourceRole: 'live' as const,
      path: '/retained/alpha',
      repositoryRevision: { kind: 'resource' as const, digest: CONTENT_HASH },
      contentHash: CONTENT_HASH,
      retainUntil: null,
    };
    const probe = (state: 'satisfied' | 'missing'): StatusRetentionProbeInput => ({
      transactionId: 'tx:retention',
      resourceId: retained.resourceId,
      path: retained.path,
      pathState: state,
      repositoryRevision:
        state === 'satisfied'
          ? { state: 'observed', digest: CONTENT_HASH }
          : { state: 'missing', digest: null },
      contentHash:
        state === 'satisfied'
          ? { state: 'observed', digest: CONTENT_HASH }
          : { state: 'missing', digest: null },
      node: {
        state: 'observed',
        kind: state === 'satisfied' ? 'directory' : 'absent',
        linkTarget: null,
      },
    });
    const factsFor = (
      reversibility: LogicalJournalV1Dto['intent']['reversibility'],
      actualRetained: LogicalJournalV1Dto['actual']['retained'],
      retention: readonly StatusRetentionProbeInput[],
    ): readonly string[] => {
      const journal = logicalJournal({
        name: 'alpha',
        path: join(CODEX_ROOT, 'alpha'),
        transactionId: 'tx:retention',
        reversibility,
        retained: actualRetained,
      });
      const report = unwrapJoin(
        joinInput({
          ledger: artifactPresent(
            'ledger',
            emptyLedgerModel({ transactions: { [journal.transactionId]: journal } }),
            2,
          ),
          retention,
        }),
      );
      return report.entries[0]?.placements[0]?.facts.map((fact) => fact.code) ?? [];
    };
    expect(
      factsFor(
        { kind: 'reversible', retentionResourceIds: [retained.resourceId] },
        [retained],
        [probe('satisfied')],
      ).filter((code) => code.startsWith('retention-')),
    ).toEqual([]);
    expect(
      factsFor({ kind: 'none', retentionResourceIds: [] }, [retained], [probe('missing')]).filter(
        (code) => code.startsWith('retention-'),
      ),
    ).toEqual([]);
    expect(
      factsFor(
        {
          kind: 'conditional',
          retentionResourceIds: [retained.resourceId, 'resource:unrecorded'],
        },
        [retained],
        [probe('missing')],
      ).filter((code) => code.startsWith('retention-')),
    ).toEqual(['retention-incomplete']);
    expect(
      factsFor(
        { kind: 'conditional', retentionResourceIds: [retained.resourceId] },
        [retained],
        [probe('missing')],
      ).filter((code) => code.startsWith('retention-')),
    ).toEqual(['retention-missing']);
  });

  test('ranks journals by pending, timestamp, transaction id, then format', () => {
    const path = join(CODEX_ROOT, 'alpha');
    const winnerFor = (
      transactions: readonly LogicalJournalV1Dto[],
      history: readonly LogicalJournalV1Dto[] = [],
      pair: LedgerPairV1Dto | null = null,
    ): Readonly<{ transactionId: string; format: string }> => {
      const ledger = emptyLedgerModel({
        skills: pair === null ? {} : { alpha: { tools: { codex: pair } } },
        transactions: Object.fromEntries(
          transactions.map((journal) => [journal.transactionId, journal]),
        ),
        history,
      });
      const report = unwrapJoin(joinInput({ ledger: artifactPresent('ledger', ledger, 2) }));
      const journal = report.entries[0]?.placements[0]?.journal;
      if (journal === undefined || journal.state === 'none') throw new Error('missing journal');
      return { transactionId: journal.transactionId, format: journal.format };
    };
    const journal = (
      transactionId: string,
      updatedAt: string,
      phase: LogicalJournalV1Dto['phase'] = 'live',
    ) => logicalJournal({ name: 'alpha', path, transactionId, updatedAt, phase });

    expect(
      winnerFor(
        [journal('tx:pending-older', '2026-07-14T00:00:01.000Z')],
        [journal('tx:committed-newer', '2026-07-14T00:00:09.000Z', 'committed')],
      ).transactionId,
    ).toBe('tx:pending-older');
    expect(
      winnerFor([
        journal('tx:older', '2026-07-14T00:00:01.000Z'),
        journal('tx:newer', '2026-07-14T00:00:02.000Z'),
      ]).transactionId,
    ).toBe('tx:newer');
    expect(
      winnerFor([
        journal('tx:b', '2026-07-14T00:00:02.000Z'),
        journal('tx:a', '2026-07-14T00:00:02.000Z'),
      ]).transactionId,
    ).toBe('tx:a');
    const legacyPair = (transactionId: string): LedgerPairV1Dto => ({
      ...pairFor('alpha'),
      placementPath: path,
      journal: {
        op: 'install',
        txId: transactionId,
        phase: 'live',
        startedAt: '2026-07-14T00:00:02.000Z',
        completedAt: null,
        before: { mode: 'absent' },
        stagingPath: `${path}.stage`,
        backupPath: `${path}.backup`,
      },
    });
    expect(
      winnerFor([journal('tx:b', '2026-07-14T00:00:02.000Z')], [], legacyPair('tx:a')),
    ).toEqual({ transactionId: 'tx:a', format: 'legacy-pair' });
    expect(
      winnerFor([journal('tx:same', '2026-07-14T00:00:02.000Z')], [], legacyPair('tx:same')),
    ).toEqual({
      transactionId: 'tx:same',
      format: 'logical',
    });
  });

  test('probes retention only for definitive attached journal winners in display order', async () => {
    const readStatus = await loadReader();
    const run = async (
      ledger: LedgerModel,
      retainedPaths: ReadonlySet<string>,
      readRequest: Readonly<StatusReadRequest> = request(),
    ): Promise<readonly string[]> => {
      const encoded = ledgerV2Codec.encode(ledger);
      if (!encoded.ok) {
        throw new Error(`retention-plan ledger encoding failed: ${JSON.stringify(encoded.error)}`);
      }
      const base = readPorts({ bytes: new Map([[LEDGER_PATH, encoded.value]]) });
      const probed: string[] = [];
      const result = await readStatus(
        {
          ...base,
          readFileMetadata: async (path) => {
            if (retainedPaths.has(path)) probed.push(path);
            return base.readFileMetadata(path);
          },
        },
        readRequest,
      );
      expect(result.ok).toBeTrue();
      return probed;
    };
    const retained = (label: string) => retainedResource(`/retained/${label}`);
    const reversibilityFor = (
      resources: readonly [
        LogicalJournalV1Dto['actual']['retained'][number],
        ...LogicalJournalV1Dto['actual']['retained'][number][],
      ],
    ): LogicalJournalV1Dto['intent']['reversibility'] => ({
      kind: 'conditional',
      retentionResourceIds: [
        resources[0].resourceId,
        ...resources.slice(1).map((resource) => resource.resourceId),
      ],
    });

    const pendingRetained = retained('pending-winner');
    const committedRetained = retained('committed-loser');
    const pending = logicalJournal({
      name: 'pending-vs-committed',
      path: join(CODEX_ROOT, 'pending-vs-committed'),
      transactionId: 'tx:pending-winner',
      retained: [pendingRetained],
      reversibility: reversibilityFor([pendingRetained]),
    });
    const committed = logicalJournal({
      name: 'pending-vs-committed',
      path: join(CODEX_ROOT, 'pending-vs-committed'),
      transactionId: 'tx:committed-loser',
      phase: 'committed',
      updatedAt: '2026-07-14T00:00:09.000Z',
      retained: [committedRetained],
      reversibility: reversibilityFor([committedRetained]),
    });
    expect(
      await run(
        emptyLedgerModel({
          transactions: { [pending.transactionId]: pending },
          history: [committed],
        }),
        new Set([pendingRetained.path, committedRetained.path]),
      ),
    ).toEqual([pendingRetained.path]);

    const olderRetained = retained('older-loser');
    const newerRetained = retained('newer-winner');
    const older = logicalJournal({
      name: 'pending-rank',
      path: join(CODEX_ROOT, 'pending-rank'),
      transactionId: 'tx:older-loser',
      updatedAt: '2026-07-14T00:00:01.000Z',
      retained: [olderRetained],
      reversibility: reversibilityFor([olderRetained]),
    });
    const newer = logicalJournal({
      name: 'pending-rank',
      path: join(CODEX_ROOT, 'pending-rank'),
      transactionId: 'tx:newer-winner',
      updatedAt: '2026-07-14T00:00:02.000Z',
      retained: [newerRetained],
      reversibility: reversibilityFor([newerRetained]),
    });
    expect(
      await run(
        emptyLedgerModel({
          transactions: {
            [older.transactionId]: older,
            [newer.transactionId]: newer,
          },
        }),
        new Set([olderRetained.path, newerRetained.path]),
      ),
    ).toEqual([newerRetained.path]);

    const tiePath = join(CODEX_ROOT, 'format-tie');
    const logicalRetained = retained('logical-winner');
    const logical = logicalJournal({
      name: 'format-tie',
      path: tiePath,
      transactionId: 'tx:format-tie',
      updatedAt: '2026-07-14T00:00:02.000Z',
      retained: [logicalRetained],
      reversibility: reversibilityFor([logicalRetained]),
    });
    const legacyBackup = `${tiePath}.legacy-backup`;
    const legacyPair: LedgerPairV1Dto = {
      ...pairFor('format-tie'),
      placementPath: tiePath,
      journal: {
        op: 'uninstall',
        txId: logical.transactionId,
        phase: 'live',
        startedAt: logical.updatedAt,
        completedAt: null,
        before: { mode: 'absent' },
        stagingPath: `${tiePath}.stage`,
        backupPath: legacyBackup,
      },
    };
    expect(
      await run(
        emptyLedgerModel({
          skills: { 'format-tie': { tools: { codex: legacyPair } } },
          transactions: { [logical.transactionId]: logical },
        }),
        new Set([logicalRetained.path, legacyBackup]),
      ),
    ).toEqual([logicalRetained.path]);

    const sharedLegacyId = 'tx:shared-legacy';
    const legacyFor = (name: string): LedgerPairV1Dto => {
      const path = join(CODEX_ROOT, name);
      return {
        ...pairFor(name),
        placementPath: path,
        journal: {
          op: 'uninstall',
          txId: sharedLegacyId,
          phase: 'live',
          startedAt: '2026-07-14T00:00:01.000Z',
          completedAt: null,
          before: { mode: 'absent' },
          stagingPath: `${path}.stage`,
          backupPath: `${path}.backup`,
        },
      };
    };
    const alphaLegacy = legacyFor('alpha-shared');
    const betaLegacy = legacyFor('beta-shared');
    const alphaLegacyBackup = alphaLegacy.journal?.backupPath ?? '';
    const betaLegacyBackup = betaLegacy.journal?.backupPath ?? '';
    expect(
      await run(
        emptyLedgerModel({
          skills: {
            'beta-shared': { tools: { codex: betaLegacy } },
            'alpha-shared': { tools: { codex: alphaLegacy } },
          },
        }),
        new Set([alphaLegacyBackup, betaLegacyBackup]),
      ),
    ).toEqual([alphaLegacyBackup, betaLegacyBackup]);

    const unselectedRetained = retained('unselected-placement');
    const unselected = logicalJournal({
      name: 'unselected',
      path: join(CODEX_ROOT, 'alternate', 'unselected'),
      transactionId: 'tx:unselected',
      retained: [unselectedRetained],
      reversibility: reversibilityFor([unselectedRetained]),
    });
    const unrelatedPath = join(CODEX_ROOT, 'unrelated');
    const unrelatedBackup = `${unrelatedPath}.backup`;
    const unrelatedPair: LedgerPairV1Dto = {
      ...pairFor('unrelated'),
      placementPath: unrelatedPath,
      journal: {
        op: 'uninstall',
        txId: 'tx:unrelated',
        phase: 'live',
        startedAt: '2026-07-14T00:00:01.000Z',
        completedAt: null,
        before: { mode: 'absent' },
        stagingPath: `${unrelatedPath}.stage`,
        backupPath: unrelatedBackup,
      },
    };
    expect(
      await run(
        emptyLedgerModel({
          skills: {
            unselected: { tools: { codex: pairFor('unselected') } },
            unrelated: { tools: { codex: unrelatedPair } },
          },
          transactions: { [unselected.transactionId]: unselected },
        }),
        new Set([unselectedRetained.path, unrelatedBackup]),
        {
          ...request(),
          targets: ['unselected'],
          selectionSource: 'explicit-targets',
        },
      ),
    ).toEqual([]);

    const multiRetained = retained('multi-resource');
    const multiBase = logicalJournal({
      name: 'multi',
      path: join(CODEX_ROOT, 'multi'),
      transactionId: 'tx:multi',
      retained: [multiRetained],
      reversibility: reversibilityFor([multiRetained]),
    });
    const beforeLive = multiBase.actual.before.find((resource) => resource.role === 'live');
    const afterLive = multiBase.actual.after.find((resource) => resource.role === 'live');
    if (beforeLive === undefined || afterLive === undefined) {
      throw new Error('missing multi-resource live fixture');
    }
    const multi: LogicalJournalV1Dto = {
      ...multiBase,
      actual: {
        ...multiBase.actual,
        before: [
          ...multiBase.actual.before,
          {
            ...beforeLive,
            resourceId: 'resource:multi:second-before',
            placementPath: join(CODEX_ROOT, 'alternate', 'multi'),
          },
        ],
        after: [
          ...multiBase.actual.after,
          {
            ...afterLive,
            resourceId: 'resource:multi:second-after',
            placementPath: join(CODEX_ROOT, 'alternate', 'multi'),
          },
        ],
      },
    };
    const { retention: _retention, ...multiInput } = joinInput({
      request: { ...request(), targets: ['multi'], selectionSource: 'explicit-targets' },
      ledger: artifactPresent(
        'ledger',
        emptyLedgerModel({ transactions: { [multi.transactionId]: multi } }),
        2,
      ),
    });
    expect(planStatusRetention(multiInput)).toEqual([]);

    const sameIdAlpha = retained('same-id-alpha');
    const sameIdBeta = retained('same-id-beta');
    const sharedId = 'tx:repeated-history-id';
    const sameIdBetaJournal = logicalJournal({
      name: 'same-id-beta',
      path: join(CODEX_ROOT, 'same-id-beta'),
      transactionId: sharedId,
      phase: 'committed',
      retained: [sameIdBeta],
      reversibility: reversibilityFor([sameIdBeta]),
    });
    const sameIdAlphaJournal = logicalJournal({
      name: 'same-id-alpha',
      path: join(CODEX_ROOT, 'same-id-alpha'),
      transactionId: sharedId,
      phase: 'committed',
      retained: [sameIdAlpha],
      reversibility: reversibilityFor([sameIdAlpha]),
    });
    expect(
      await run(
        emptyLedgerModel({ history: [sameIdBetaJournal, sameIdAlphaJournal] }),
        new Set([sameIdAlpha.path, sameIdBeta.path]),
      ),
    ).toEqual([sameIdAlpha.path, sameIdBeta.path]);

    const alphaFirst = retained('alpha-signed-first');
    const alphaSecond = retained('alpha-signed-second');
    const beta = retained('beta');
    const betaJournal = logicalJournal({
      name: 'beta-order',
      path: join(CODEX_ROOT, 'beta-order'),
      transactionId: 'tx:beta-order',
      retained: [beta],
      reversibility: reversibilityFor([beta]),
    });
    const alphaJournal = logicalJournal({
      name: 'alpha-order',
      path: join(CODEX_ROOT, 'alpha-order'),
      transactionId: 'tx:alpha-order',
      retained: [alphaFirst, alphaSecond],
      reversibility: reversibilityFor([alphaFirst, alphaSecond]),
    });
    expect(
      await run(
        emptyLedgerModel({
          transactions: {
            [betaJournal.transactionId]: betaJournal,
            [alphaJournal.transactionId]: alphaJournal,
          },
        }),
        new Set([alphaFirst.path, alphaSecond.path, beta.path]),
      ),
    ).toEqual([alphaFirst.path, alphaSecond.path, beta.path]);
  });

  test('keeps repeated logical retention probe identities separate across observation domains', async () => {
    const readStatus = await loadReader();
    const retainedPath = '/retained/shared-correlation';
    const retainedBytes = new TextEncoder().encode('shared retained bytes\n');
    const repositoryRevision = unwrap(
      hashCanonicalInput('resource', 1, retainedBytes),
      'shared retained repository revision',
    );
    const manifestContentHash = hashManifestBytes(retainedBytes);
    const resourceId = 'resource:retained:shared-correlation';
    const alphaRetained: LogicalJournalV1Dto['actual']['retained'][number] = {
      resourceId,
      role: 'backup',
      sourceRole: 'manifest',
      path: retainedPath,
      repositoryRevision: { kind: 'resource', digest: repositoryRevision },
      contentHash: manifestContentHash,
      retainUntil: null,
    };
    const betaRetained: LogicalJournalV1Dto['actual']['retained'][number] = {
      ...alphaRetained,
      sourceRole: 'live',
    };
    const sharedTransactionId = 'tx:repeated-probe-correlation';
    const alpha = logicalJournal({
      name: 'alpha-probe-correlation',
      path: join(CODEX_ROOT, 'alpha-probe-correlation'),
      transactionId: sharedTransactionId,
      phase: 'committed',
      retained: [alphaRetained],
      reversibility: { kind: 'conditional', retentionResourceIds: [resourceId] },
    });
    const beta = logicalJournal({
      name: 'beta-probe-correlation',
      path: join(CODEX_ROOT, 'beta-probe-correlation'),
      transactionId: sharedTransactionId,
      phase: 'committed',
      retained: [betaRetained],
      reversibility: { kind: 'conditional', retentionResourceIds: [resourceId] },
    });
    const ledger = ledgerV2Codec.encode(emptyLedgerModel({ history: [beta, alpha] }));
    if (!ledger.ok) {
      throw new Error(`shared-correlation ledger encoding failed: ${JSON.stringify(ledger.error)}`);
    }
    const result = await readStatus(
      readPorts({
        bytes: new Map([
          [LEDGER_PATH, ledger.value],
          [retainedPath, retainedBytes],
        ]),
      }),
      request(),
    );
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error('expected repeated-correlation status product');
    const journals = Object.fromEntries(
      result.value.entries.map((entry) => [entry.name, entry.placements[0]?.journal]),
    );
    expect(journals['alpha-probe-correlation']).toMatchObject({
      state: 'committed',
      reverseEligibility: 'eligible',
      retention: [{ contentHash: { state: 'satisfied', domain: 'manifest-bytes' } }],
      remediation: { reverse: expect.any(Array) },
    });
    expect(journals['beta-probe-correlation']).toMatchObject({
      state: 'committed',
      reverseEligibility: 'retention-unverified',
      retention: [{ contentHash: { state: 'unverified', domain: 'source-content' } }],
      remediation: { reverse: null },
    });
  });

  test('requires user logical journals to carry an explicit null project root in reader and join', async () => {
    const readStatus = await loadReader();
    const validRetained = retainedResource('/retained/valid-user');
    const foreignRetained = retainedResource('/retained/foreign-user');
    const valid = logicalJournal({
      name: 'valid-user',
      path: join(CODEX_ROOT, 'valid-user'),
      transactionId: 'tx:valid-user',
      retained: [validRetained],
      reversibility: { kind: 'conditional', retentionResourceIds: [validRetained.resourceId] },
    });
    const foreign = logicalJournal({
      name: 'foreign-user',
      path: join(CODEX_ROOT, 'foreign-user'),
      transactionId: 'tx:foreign-user',
      projectRoot: ROOT,
      retained: [foreignRetained],
      reversibility: { kind: 'conditional', retentionResourceIds: [foreignRetained.resourceId] },
    });
    const base = readPorts({ bytes: journalLedgerBytes([valid, foreign]) });
    const probed: string[] = [];
    const result = await readStatus(
      {
        ...base,
        readFileMetadata: async (path) => {
          if (path === validRetained.path || path === foreignRetained.path) probed.push(path);
          return base.readFileMetadata(path);
        },
      },
      request(),
    );
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error('expected journal-root isolation product');
    expect(result.value.entries.map((entry) => entry.name)).toEqual(['valid-user']);
    expect(result.value.entries[0]?.placements[0]?.journal).toMatchObject({
      state: 'pending',
      transactionId: valid.transactionId,
    });
    expect(probed).toEqual([validRetained.path]);
  });

  test('rethrows direct and nested retained-probe AbortError/ABORT_ERR as cancellation', async () => {
    const readStatus = await loadReader();
    const retained = retainedResource('/retained/cancelled');
    const journal = logicalJournal({
      name: 'cancelled',
      path: join(CODEX_ROOT, 'cancelled'),
      transactionId: 'tx:cancelled',
      retained: [retained],
      reversibility: { kind: 'conditional', retentionResourceIds: [retained.resourceId] },
    });
    const bytes = journalLedgerBytes([journal]);
    const directBase = readPorts({ bytes });
    const directAbort = Object.defineProperty(new Error('direct abort canary'), 'name', {
      value: 'AbortError',
      enumerable: true,
    });
    const direct = await readStatus(
      {
        ...directBase,
        readFileMetadata: async (path) => {
          if (path === retained.path) throw directAbort;
          return directBase.readFileMetadata(path);
        },
      },
      request(),
    );
    expect(direct).toEqual({
      ok: false,
      error: {
        code: 'status-read',
        reason: 'cancelled',
        exitClass: 'cancelled',
        message: 'status read was cancelled',
      },
    });

    const nestedTarget = '/resolved/retained/cancelled';
    const nestedBase = readPorts({ bytes });
    const nestedAbort = Object.assign(new Error('nested abort canary'), { code: 'ABORT_ERR' });
    const nested = await readStatus(
      {
        ...nestedBase,
        realpath: async (path) => (path === retained.path ? nestedTarget : path),
        readLink: async (path) => {
          if (path === retained.path) return nestedTarget;
          return nestedBase.readLink(path);
        },
        readFileMetadata: async (path) => {
          if (path === retained.path) {
            return { kind: 'symlink', mode: 0o777, identity: 'retained-link' };
          }
          if (path === nestedTarget) throw nestedAbort;
          return nestedBase.readFileMetadata(path);
        },
      },
      request(),
    );
    expect(nested).toEqual({
      ok: false,
      error: {
        code: 'status-read',
        reason: 'cancelled',
        exitClass: 'cancelled',
        message: 'status read was cancelled',
      },
    });
  });

  test('does not follow a structural-only legacy retained symlink', async () => {
    const readStatus = await loadReader();
    const path = join(CODEX_ROOT, 'legacy-link');
    const backupPath = `${path}.backup`;
    const linkTarget = '/source/legacy-link';
    const pair: LedgerPairV1Dto = {
      ...pairFor('legacy-link'),
      placementPath: path,
      journal: {
        op: 'uninstall',
        txId: 'tx:legacy-link',
        phase: 'live',
        startedAt: '2026-07-14T00:00:00.000Z',
        completedAt: null,
        before: {
          mode: 'pinned',
          storePath: join(DATA_ROOT, 'store', 'legacy-link'),
          contentHash: CONTENT_HASH,
          liveKind: 'symlink',
          symlinkTarget: linkTarget,
        },
        stagingPath: `${path}.stage`,
        backupPath,
      },
    };
    const ledger = emptyLedgerModel({
      skills: { 'legacy-link': { tools: { codex: pair } } },
    });
    const encoded = ledgerV2Codec.encode(ledger);
    if (!encoded.ok) throw new Error('legacy no-follow ledger encoding failed');
    const base = readPorts({ bytes: new Map([[LEDGER_PATH, encoded.value]]) });
    let retainedRealpaths = 0;
    let retainedLinks = 0;
    const result = await readStatus(
      {
        ...base,
        readFileMetadata: async (candidate) =>
          candidate === backupPath
            ? { kind: 'symlink', mode: 0o777, identity: 'legacy-retained-link' }
            : base.readFileMetadata(candidate),
        readLink: async (candidate) => {
          if (candidate !== backupPath) return base.readLink(candidate);
          retainedLinks += 1;
          return linkTarget;
        },
        realpath: async (candidate) => {
          if (candidate === backupPath) retainedRealpaths += 1;
          return candidate === backupPath ? linkTarget : base.realpath(candidate);
        },
      },
      request(),
    );
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error('expected structural-only legacy symlink product');
    expect(result.value.entries[0]?.placements[0]?.journal).toMatchObject({
      state: 'pending',
      abortEligibility: 'eligible',
      retention: [
        {
          structural: { state: 'satisfied' },
          contentHash: { state: 'not-recorded' },
        },
      ],
    });
    expect(retainedLinks).toBe(1);
    expect(retainedRealpaths).toBe(0);
  });

  test('does not reinterpret a legacy expected-directory backup symlink as source content', async () => {
    const readStatus = await loadReader();
    const path = join(CODEX_ROOT, 'legacy-directory-link');
    const backupPath = `${path}.backup`;
    const linkTarget = '/foreign/legacy-directory-link';
    const pair: LedgerPairV1Dto = {
      ...pairFor('legacy-directory-link'),
      placementPath: path,
      journal: {
        op: 'uninstall',
        txId: 'tx:legacy-directory-link',
        phase: 'live',
        startedAt: '2026-07-14T00:00:00.000Z',
        completedAt: null,
        before: {
          mode: 'pinned',
          storePath: join(DATA_ROOT, 'store', 'legacy-directory-link'),
          contentHash: CONTENT_HASH,
          liveKind: 'dir',
        },
        stagingPath: `${path}.stage`,
        backupPath,
      },
    };
    const encoded = ledgerV2Codec.encode(
      emptyLedgerModel({
        skills: { 'legacy-directory-link': { tools: { codex: pair } } },
      }),
    );
    if (!encoded.ok) throw new Error('legacy directory-link ledger encoding failed');
    const base = readPorts({ bytes: new Map([[LEDGER_PATH, encoded.value]]) });
    let retainedLinks = 0;
    let retainedRealpaths = 0;
    const result = await readStatus(
      {
        ...base,
        readFileMetadata: async (candidate) =>
          candidate === backupPath
            ? { kind: 'symlink', mode: 0o777, identity: 'legacy-directory-link' }
            : base.readFileMetadata(candidate),
        readLink: async (candidate) => {
          if (candidate !== backupPath) return base.readLink(candidate);
          retainedLinks += 1;
          return linkTarget;
        },
        realpath: async (candidate) => {
          if (candidate === backupPath) retainedRealpaths += 1;
          return candidate === backupPath ? linkTarget : base.realpath(candidate);
        },
      },
      request(),
    );
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error('expected legacy directory-link report');
    expect(result.value.entries[0]?.placements[0]?.journal).toMatchObject({
      state: 'pending',
      abortEligibility: 'retention-mismatch',
      retention: [
        {
          structural: { state: 'mismatch', expected: { kind: 'directory' } },
          contentHash: { state: 'unverified' },
        },
      ],
    });
    expect(retainedLinks).toBe(1);
    expect(retainedRealpaths).toBe(0);
  });

  test('does not project a legacy backup directory when the live before-image makes it structural-only', async () => {
    const readStatus = await loadReader();
    const path = join(CODEX_ROOT, 'legacy-directory');
    const backupPath = `${path}.backup`;
    const pair: LedgerPairV1Dto = {
      ...pairFor('legacy-directory'),
      placementPath: path,
      journal: {
        op: 'uninstall',
        txId: 'tx:legacy-directory',
        phase: 'backed-up',
        startedAt: '2026-07-14T00:00:00.000Z',
        completedAt: null,
        before: {
          mode: 'pinned',
          storePath: join(DATA_ROOT, 'store', 'legacy-directory'),
          contentHash: CONTENT_HASH,
          liveKind: 'dir',
        },
        stagingPath: `${path}.stage`,
        backupPath,
      },
    };
    const ledger = emptyLedgerModel({
      skills: { 'legacy-directory': { tools: { codex: pair } } },
    });
    const encoded = ledgerV2Codec.encode(ledger);
    if (!encoded.ok) throw new Error('legacy directory no-project ledger encoding failed');
    const base = readPorts({
      names: ['legacy-directory'],
      bytes: new Map([[LEDGER_PATH, encoded.value]]),
    });
    let projectedBackup = 0;
    const result = await readStatus(
      {
        ...base,
        readFileMetadata: async (candidate) =>
          candidate === backupPath
            ? { kind: 'dir', mode: 0o755, identity: 'legacy-retained-directory' }
            : base.readFileMetadata(candidate),
        listDir: async (candidate) => {
          if (candidate === backupPath) projectedBackup += 1;
          return candidate === backupPath ? [] : base.listDir(candidate);
        },
      },
      request(),
    );
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error('expected structural-only legacy directory product');
    expect(result.value.entries[0]?.placements[0]?.journal).toMatchObject({
      state: 'pending',
      abortEligibility: 'retention-mismatch',
      retention: [
        {
          structural: { state: 'mismatch', expected: { kind: 'absent' } },
          contentHash: { state: 'not-recorded' },
        },
      ],
    });
    expect(projectedBackup).toBe(0);
  });

  test('projects only logical retained digests consumed by the selected artifact-source checks', async () => {
    const readStatus = await loadReader();
    const cases = (['manifest', 'lock', 'ledger'] as const).flatMap((sourceRole) =>
      (['artifact-symlink', 'resource-symlink', 'artifact-directory'] as const).map(
        (representation) => {
          const path = `/retained/${sourceRole}-${representation}`;
          const repositoryKind = representation.startsWith('artifact')
            ? ('artifact-bytes' as const)
            : ('resource' as const);
          const retained = {
            ...retainedResource(path, repositoryKind),
            sourceRole,
          };
          return {
            sourceRole,
            representation,
            path,
            retained,
            journal: logicalJournal({
              name: `${sourceRole}-${representation}`,
              path: join(CODEX_ROOT, `${sourceRole}-${representation}`),
              transactionId: `tx:${sourceRole}-${representation}`,
              retained: [retained],
              reversibility: {
                kind: 'conditional',
                retentionResourceIds: [retained.resourceId],
              },
            }),
          };
        },
      ),
    );
    const retainedPaths = new Set(cases.map((candidate) => candidate.path));
    const symlinkPaths = new Set(
      cases
        .filter((candidate) => candidate.representation.endsWith('symlink'))
        .map((candidate) => candidate.path),
    );
    const resourceSymlinks = new Set(
      cases
        .filter((candidate) => candidate.representation === 'resource-symlink')
        .map((candidate) => candidate.path),
    );
    const base = readPorts({
      bytes: journalLedgerBytes(cases.map((candidate) => candidate.journal)),
    });
    const realpaths: string[] = [];
    const links: string[] = [];
    const projectedDirectories: string[] = [];
    const result = await readStatus(
      {
        ...base,
        readFileMetadata: async (path) => {
          if (!retainedPaths.has(path)) return base.readFileMetadata(path);
          return symlinkPaths.has(path)
            ? { kind: 'symlink', mode: 0o777, identity: `logical:${path}` }
            : { kind: 'dir', mode: 0o755, identity: `logical:${path}` };
        },
        readLink: async (path) => {
          if (!retainedPaths.has(path)) return base.readLink(path);
          links.push(path);
          return `${path}.target`;
        },
        realpath: async (path) => {
          if (retainedPaths.has(path)) realpaths.push(path);
          return retainedPaths.has(path) ? `${path}.target` : base.realpath(path);
        },
        listDir: async (path) => {
          if (retainedPaths.has(path)) projectedDirectories.push(path);
          return retainedPaths.has(path) ? [] : base.listDir(path);
        },
      },
      request(),
    );
    expect(result.ok).toBeTrue();
    expect(realpaths).toEqual([]);
    expect(projectedDirectories).toEqual([]);
    expect(links.sort()).toEqual([...resourceSymlinks].sort());
  });

  test('leaves artifact-bytes revision unverified for retained directories and symlinks', async () => {
    const readStatus = await loadReader();
    for (const representation of ['dir', 'symlink'] as const) {
      const retained = retainedResource(`/retained/wrong-${representation}`, 'artifact-bytes');
      const journal = logicalJournal({
        name: `wrong-${representation}`,
        path: join(CODEX_ROOT, `wrong-${representation}`),
        transactionId: `tx:wrong-${representation}`,
        retained: [retained],
        reversibility: { kind: 'conditional', retentionResourceIds: [retained.resourceId] },
      });
      const target = `${retained.path}.target`;
      const base = readPorts({ bytes: journalLedgerBytes([journal]) });
      const result = await readStatus(
        {
          ...base,
          realpath: async (path) => (path === retained.path ? target : path),
          readLink: async (path) => {
            if (path === retained.path && representation === 'symlink') return target;
            return base.readLink(path);
          },
          readFileMetadata: async (path) => {
            if (path === retained.path) {
              return {
                kind: representation,
                mode: representation === 'dir' ? 0o755 : 0o777,
                identity: `retained-${representation}`,
              };
            }
            if (path === target) return { kind: 'dir', mode: 0o755, identity: 'retained-target' };
            return base.readFileMetadata(path);
          },
        },
        request(),
      );
      expect(result.ok, representation).toBeTrue();
      if (!result.ok) throw new Error(`expected wrong-${representation} status product`);
      const requirement = result.value.entries[0]?.placements[0]?.journal;
      expect(requirement, representation).toMatchObject({
        state: 'pending',
        transactionId: journal.transactionId,
        retention: [{ repositoryRevision: { state: 'unverified' } }],
      });
    }
  });
});
