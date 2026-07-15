import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { hashManifestSemantics, parseArtifactDigest } from '../../src/artifacts/hash.ts';
import { fromLedgerV2Dto, ledgerV2Codec } from '../../src/artifacts/ledger-codec.ts';
import type { LedgerPairV1Dto, LedgerV2Dto } from '../../src/artifacts/ledger-types.ts';
import { type PortableLockV1, serializePortableLock } from '../../src/artifacts/lock.ts';
import { manifestV1Codec } from '../../src/artifacts/manifest-codec.ts';
import type { NormalizedManifestV1 } from '../../src/artifacts/types.ts';
import { resolveRuntimeConfiguration } from '../../src/config/runtime.ts';
import type { ProjectContext } from '../../src/context/types.ts';
import type {
  FileMetadata,
  FileMetadataReadPort,
  InventoryReadPorts,
  ResolvedRuntimeConfiguration,
} from '../../src/ports/types.ts';
import type { Result } from '../../src/result.ts';

type StatusReader = (
  ports: InventoryReadPorts & FileMetadataReadPort,
  request: Readonly<{
    projectContext: ProjectContext;
    projectPlacement:
      | Readonly<{ state: 'unselected' }>
      | Readonly<{
          state: 'selected';
          source: 'shared-project' | 'explicit-non-git';
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
  readonly entries: readonly {
    readonly name: string;
    readonly convergence: string;
    readonly placements: readonly {
      readonly classification: string;
      readonly verification: string;
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
    source: 'discovered-project',
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
    const result = await readStatus(
      ports,
      request(Object.freeze({ state: 'unselected', reason: 'live-only-scope' })),
    );
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error('expected all-absent status product');
    expect(result.value.entries).toEqual([]);
    expect(result.value.selection).toMatchObject({
      source: 'bounded-default',
      tools: ['codex'],
      toolSource: 'explicit',
      scopes: ['user'],
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
});
