import { describe, expect, test } from 'bun:test';
import { join, normalize } from 'node:path';
import { resolveArtifactPair as resolveCurrentCliPair } from '../../../packages/cli/src/util/artifact-pair.ts';
import { type ProjectContext, resolveProjectContext } from '../../../packages/core/src/index.ts';

type PathEntry = Readonly<{
  kind: 'dir' | 'file' | 'symlink';
  text?: string;
  realpath?: string;
}>;

type ArtifactError = Readonly<{
  code: string;
  exitClass: 'usage' | 'state';
  message: string;
  paths?: readonly string[];
}>;

type Result<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: ArtifactError }>;

type ManifestCandidate = Readonly<{
  role: 'selected-project' | 'project-root' | 'user' | 'explicit';
  path: string;
  existence: 'absent' | 'file';
  shape: string | null;
  declaredNames: readonly string[];
}>;

type ArtifactDiscoverySnapshot = Readonly<{
  projectContext: ProjectContext;
  selectedProjectManifest: string | null;
  projectRootManifest: string | null;
  userManifest: string;
  userConfig: string;
  explicitConfigPath: string | null;
  explicitArtifactPath: string | null;
  candidates: readonly ManifestCandidate[];
}>;

type ManifestDestination = Readonly<{
  kind: 'existing' | 'new' | 'absent';
  role: 'selected-project' | 'project-root' | 'user' | 'explicit' | null;
  path: string | null;
  names: readonly string[];
}>;

type PairPath = Readonly<{
  token: string | null;
  path: string;
  portability: 'portable' | 'machine-bound';
  portableToken: string | null;
}>;

type ResolvedArtifactPair = Readonly<{
  file: PairPath;
  lockfile: PairPath;
  lockfileSource: 'explicit' | 'sibling';
}>;

type ArtifactAuthority = Readonly<{
  discoverArtifactSnapshot: (
    ports: FakeArtifactPorts,
    context: ProjectContext,
    options?: Readonly<{
      explicitConfig?: string;
      explicitFile?: string;
      explicitProjectScope?: boolean;
    }>,
  ) => Promise<Result<ArtifactDiscoverySnapshot>>;
  selectManifestDestination: (
    snapshot: ArtifactDiscoverySnapshot,
    request: Readonly<{
      names: readonly string[];
      scope: 'user' | 'project';
      mode: 'save' | 'remove';
      explicitFile?: string;
    }>,
  ) => Result<ManifestDestination>;
  resolveArtifactPair: (
    ports: FakeArtifactPorts,
    context: ProjectContext,
    options: Readonly<{
      discoveredFile?: string | null;
      file?: string;
      lockfile?: string;
    }>,
  ) => Promise<Result<ResolvedArtifactPair>>;
}>;

const HOME = '/home/u';
const XDG_CONFIG = '/home/u/.config';
const REPO = '/work/repo';
const NESTED = '/work/repo/packages/api';
const DEEP_CWD = '/work/repo/packages/api/src';
const ROOT_MANIFEST = '/work/repo/skillsmith.toml';
const NESTED_MANIFEST = '/work/repo/packages/api/skillsmith.toml';
const USER_MANIFEST = '/home/u/.config/skillsmith/skillsmith.toml';
const USER_CONFIG = '/home/u/.config/skillsmith/config.toml';

const canonicalManifest = (
  names: readonly string[],
  scope: 'user' | 'project' = 'project',
): string =>
  `${[
    'version = 1',
    '',
    '[defaults]',
    `scope = "${scope}"`,
    'tools = ["codex"]',
    ...names.flatMap((name) => [
      '',
      '[[skills]]',
      `name = "${name}"`,
      `source = "github.com/acme/skills//${name}"`,
    ]),
  ].join('\n')}\n`;

class FakeArtifactPorts {
  readonly homeDir = HOME;
  readonly executableSearchPath: readonly string[] = [];
  readonly platform = 'linux' as const;
  readonly xdg = Object.freeze({ config: XDG_CONFIG, data: '/home/u/.local/share', cache: '/tmp' });
  readonly entries = new Map<string, PathEntry>();
  readonly calls = {
    pathKind: [] as string[],
    realpath: [] as string[],
    readText: [] as string[],
    gitRoot: [] as string[],
  };
  gitRoot: string | null = REPO;

  constructor(entries: Readonly<Record<string, PathEntry>> = {}) {
    for (const [path, entry] of Object.entries(entries)) this.entries.set(normalize(path), entry);
  }

  async fileExists(path: string): Promise<boolean> {
    return this.entries.has(normalize(path));
  }

  async pathKind(path: string): Promise<'absent' | 'dir' | 'file' | 'symlink'> {
    const key = normalize(path);
    this.calls.pathKind.push(key);
    return this.entries.get(key)?.kind ?? 'absent';
  }

  async realpath(path: string): Promise<string> {
    const key = normalize(path);
    this.calls.realpath.push(key);
    const entry = this.entries.get(key);
    if (!entry) throw new Error(`unexpected realpath of absent fixture path ${key}`);
    return normalize(entry.realpath ?? key);
  }

  async readText(path: string): Promise<string> {
    const key = normalize(path);
    this.calls.readText.push(key);
    const entry = this.entries.get(key);
    if (entry?.kind !== 'file' || entry.text === undefined) {
      throw new Error(`unexpected text read ${key}`);
    }
    return entry.text;
  }

  async listDir(): Promise<readonly string[]> {
    throw new Error('unexpected directory scan');
  }

  async readBytes(): Promise<Uint8Array> {
    throw new Error('unexpected byte read');
  }

  async readLink(): Promise<string> {
    throw new Error('unexpected direct symlink read');
  }

  async isExecutable(): Promise<boolean> {
    throw new Error('unexpected executable probe');
  }

  async modifiedAt(): Promise<number | null> {
    throw new Error('unexpected modified-time probe');
  }

  readonly git = {
    findRepositoryRoot: async (request: Readonly<{ cwd: string }>): Promise<string | null> => {
      this.calls.gitRoot.push(normalize(request.cwd));
      return this.gitRoot;
    },
  };
}

// Keep the fake intentionally read-only. Casting happens only at the current ProjectContext guard,
// whose production signature grants more Git capabilities than this test is allowed to exercise.
const currentContext = async (ports: FakeArtifactPorts, cwd: string): Promise<ProjectContext> => {
  const result = await resolveProjectContext(ports as never, {
    invocationCwd: cwd,
  });
  if (!result.ok) throw new Error(`fixture ProjectContext failed: ${result.error.message}`);
  return result.value;
};

const frozenContext = (
  cwd = DEEP_CWD,
  projectRoot: string | null = REPO,
  discoveredConfigPath: string | null = NESTED_MANIFEST,
): ProjectContext =>
  Object.freeze({
    invocationCwd: cwd,
    effectiveCwd: cwd,
    projectRoot,
    projectIdentity: projectRoot,
    projectKind: projectRoot === null ? 'non-git' : 'git',
    discoveredConfigPath,
    explicitConfigPath: null,
  });

let authorityLoad:
  | Promise<Readonly<{ api: ArtifactAuthority | null; reason: string | null }>>
  | undefined;

const loadAuthority = () => {
  authorityLoad ??= (async () => {
    const modulePath = '../../../packages/core/src/artifacts/index.ts';
    try {
      const loaded = (await import(modulePath)) as Partial<ArtifactAuthority>;
      const complete =
        typeof loaded.discoverArtifactSnapshot === 'function' &&
        typeof loaded.selectManifestDestination === 'function' &&
        typeof loaded.resolveArtifactPair === 'function';
      return complete
        ? { api: loaded as ArtifactAuthority, reason: null }
        : { api: null, reason: 'artifact module does not export the three planned authorities' };
    } catch (error) {
      return {
        api: null,
        reason: error instanceof Error ? error.message : 'artifact authority module is absent',
      };
    }
  })();
  return authorityLoad;
};

const requireAuthority = async (): Promise<ArtifactAuthority | null> => {
  const loaded = await loadAuthority();
  if (loaded.api === null) {
    expect(`missing G2-01 artifact authority: ${loaded.reason}`).toBe(
      'G2-01 artifact authority available',
    );
  }
  return loaded.api;
};

const expectOk = <T>(result: Result<T>): T => {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected success, received ${result.error.code}`);
  return result.value;
};

const expectError = <T>(result: Result<T>, code: string, exitClass: 'usage' | 'state') => {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected refusal, received success');
  expect(result.error.code).toBe(code);
  expect(result.error.exitClass).toBe(exitClass);
  return result.error;
};

const hostileThrownValues = (
  canary: string,
): ReadonlyArray<readonly [label: string, value: unknown, accessCount: () => number]> => {
  const canaryError = new Error(canary);
  let messageAccesses = 0;
  const accessorError = Object.create(Error.prototype) as object;
  Object.defineProperty(accessorError, 'message', {
    get() {
      messageAccesses += 1;
      throw new Error('hostile message getter invoked');
    },
  });
  let coercionAccesses = 0;
  const hostileCoercion = {
    toString(): string {
      coercionAccesses += 1;
      throw new Error('hostile toString invoked');
    },
    [Symbol.toPrimitive](): string {
      coercionAccesses += 1;
      throw new Error('hostile Symbol.toPrimitive invoked');
    },
  };
  let proxyAccesses = 0;
  const hostileProxy = new Proxy(Object.create(null) as object, {
    getPrototypeOf() {
      proxyAccesses += 1;
      throw new Error('hostile getPrototypeOf invoked');
    },
    get() {
      proxyAccesses += 1;
      throw new Error('hostile get invoked');
    },
  });
  return [
    ['canary Error', canaryError, () => 0],
    ['canary primitive', canary, () => 0],
    ['hostile message accessor', accessorError, () => messageAccesses],
    ['hostile coercion', hostileCoercion, () => coercionAccesses],
    ['hostile proxy', hostileProxy, () => proxyAccesses],
  ];
};

const snapshotFixture = (
  candidates: readonly ManifestCandidate[],
  context = frozenContext(),
  explicitArtifactPath: string | null = null,
): ArtifactDiscoverySnapshot =>
  Object.freeze({
    projectContext: context,
    selectedProjectManifest: NESTED_MANIFEST,
    projectRootManifest: ROOT_MANIFEST,
    userManifest: USER_MANIFEST,
    userConfig: USER_CONFIG,
    explicitConfigPath: null,
    explicitArtifactPath,
    candidates: Object.freeze(candidates.map((candidate) => Object.freeze({ ...candidate }))),
  });

const candidate = (
  role: ManifestCandidate['role'],
  path: string,
  names: readonly string[],
  shape = 'canonical',
): ManifestCandidate =>
  Object.freeze({ role, path, existence: 'file', shape, declaredNames: Object.freeze([...names]) });

describe('EWP-P2-TS02 — artifact discovery, ownership, and pair selection', () => {
  test('fixture guards are hermetic, counted, and canonically shaped', async () => {
    const text = canonicalManifest(['review']);
    expect(text).toContain('version = 1');
    expect(text).toContain('name = "review"');

    const ports = new FakeArtifactPorts({
      [DEEP_CWD]: { kind: 'dir' },
      [NESTED_MANIFEST]: { kind: 'file', text },
      '/work/repo/link.toml': { kind: 'symlink', realpath: NESTED_MANIFEST },
    });
    expect(await ports.pathKind(NESTED_MANIFEST)).toBe('file');
    expect(await ports.readText(NESTED_MANIFEST)).toBe(text);
    expect(await ports.realpath('/work/repo/link.toml')).toBe(NESTED_MANIFEST);
    expect(ports.calls).toEqual({
      pathKind: [NESTED_MANIFEST],
      realpath: ['/work/repo/link.toml'],
      readText: [NESTED_MANIFEST],
      gitRoot: [],
    });
  });

  test('current ProjectContext keeps nested desired state separate from the Git root', async () => {
    const ports = new FakeArtifactPorts({
      [REPO]: { kind: 'dir', realpath: REPO },
      [DEEP_CWD]: { kind: 'dir', realpath: DEEP_CWD },
      [NESTED_MANIFEST]: { kind: 'file', text: canonicalManifest(['nested']) },
    });
    const context = await currentContext(ports, DEEP_CWD);
    expect(context.effectiveCwd).toBe(DEEP_CWD);
    expect(context.projectRoot).toBe(REPO);
    expect(context.projectIdentity).toBe(REPO);
    expect(context.discoveredConfigPath).toBe(NESTED_MANIFEST);
  });

  test('current pair compatibility retains sibling derivation and requires file for lockfile', () => {
    const sibling = resolveCurrentCliPair({
      effectiveCwd: REPO,
      file: './state/team.toml',
    });
    expect(sibling).toEqual({
      ok: true,
      value: {
        file: '/work/repo/state/team.toml',
        lockfile: '/work/repo/state/team.lock',
        lockfileSource: 'sibling',
      },
    });
    const invalid = resolveCurrentCliPair({ effectiveCwd: REPO, lockfile: 'team.lock' });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.exitCode).toBe(2);
  });

  test('discovers immutable project, user, explicit, nested, and parse-once roles', async () => {
    const api = await requireAuthority();
    if (api === null) return;

    const ports = new FakeArtifactPorts({
      [REPO]: { kind: 'dir', realpath: REPO },
      [DEEP_CWD]: { kind: 'dir', realpath: DEEP_CWD },
      [NESTED_MANIFEST]: { kind: 'file', text: canonicalManifest(['nested']) },
      [ROOT_MANIFEST]: { kind: 'file', text: canonicalManifest(['root']) },
      [USER_MANIFEST]: { kind: 'file', text: canonicalManifest(['user'], 'user') },
      [USER_CONFIG]: { kind: 'file', text: 'tool = "codex"\n' },
    });
    const context = await currentContext(ports, DEEP_CWD);
    ports.calls.readText.length = 0;
    const samePath = '../skillsmith.toml';
    const snapshot = expectOk(
      await api.discoverArtifactSnapshot(ports, context, {
        explicitConfig: samePath,
        explicitFile: samePath,
      }),
    );

    expect(snapshot.projectContext.projectRoot).toBe(REPO);
    expect(snapshot.selectedProjectManifest).toBe(NESTED_MANIFEST);
    expect(snapshot.projectRootManifest).toBe(ROOT_MANIFEST);
    expect(snapshot.userManifest).toBe(USER_MANIFEST);
    expect(snapshot.userConfig).toBe(USER_CONFIG);
    expect(snapshot.explicitConfigPath).toBe(NESTED_MANIFEST);
    expect(snapshot.explicitArtifactPath).toBe(NESTED_MANIFEST);
    expect(snapshot.candidates).toEqual([
      candidate('selected-project', NESTED_MANIFEST, ['nested']),
      candidate('project-root', ROOT_MANIFEST, ['root']),
      candidate('user', USER_MANIFEST, ['user']),
      candidate('explicit', NESTED_MANIFEST, ['nested']),
    ]);
    expect(ports.calls.readText).toHaveLength(3);
    for (const path of [NESTED_MANIFEST, ROOT_MANIFEST, USER_MANIFEST]) {
      expect(ports.calls.readText.filter((readPath) => readPath === path)).toHaveLength(1);
    }
    expect(ports.calls.readText).not.toContain(USER_CONFIG);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.candidates)).toBe(true);
    expect(snapshot.candidates.every((item) => Object.isFrozen(item))).toBe(true);
    expect(snapshot.candidates.every((item) => Object.isFrozen(item.declaredNames))).toBe(true);

    const secondPorts = new FakeArtifactPorts({
      [REPO]: { kind: 'dir', realpath: REPO },
      [join(NESTED, 'src', 'deeper')]: { kind: 'dir', realpath: join(NESTED, 'src', 'deeper') },
      [NESTED_MANIFEST]: { kind: 'file', text: canonicalManifest(['nested']) },
      [ROOT_MANIFEST]: { kind: 'file', text: canonicalManifest(['root']) },
    });
    const secondContext = await currentContext(secondPorts, join(NESTED, 'src', 'deeper'));
    const second = expectOk(await api.discoverArtifactSnapshot(secondPorts, secondContext));
    expect(second.selectedProjectManifest).toBe(snapshot.selectedProjectManifest);
    expect(second.projectContext.projectRoot).toBe(REPO);

    const rootPorts = new FakeArtifactPorts({
      [REPO]: { kind: 'dir', realpath: REPO },
      [ROOT_MANIFEST]: { kind: 'file', text: canonicalManifest(['root']) },
    });
    const rootContext = await currentContext(rootPorts, REPO);
    const atRoot = expectOk(await api.discoverArtifactSnapshot(rootPorts, rootContext));
    expect(atRoot.selectedProjectManifest).toBe(ROOT_MANIFEST);
    expect(atRoot.projectContext.projectRoot).toBe(REPO);
    expect(atRoot.projectContext.projectIdentity).toBe(REPO);

    const worktreeRoot = '/work/repo-worktree';
    const worktreeManifest = `${worktreeRoot}/skillsmith.toml`;
    const worktreeContext = Object.freeze({
      ...frozenContext(worktreeRoot, worktreeRoot, worktreeManifest),
      projectIdentity: REPO,
    });
    const worktreePorts = new FakeArtifactPorts({
      [worktreeRoot]: { kind: 'dir', realpath: worktreeRoot },
      [worktreeManifest]: { kind: 'file', text: canonicalManifest(['worktree']) },
    });
    const worktree = expectOk(await api.discoverArtifactSnapshot(worktreePorts, worktreeContext));
    expect(worktree.projectContext.projectRoot).toBe(worktreeRoot);
    expect(worktree.projectContext.projectIdentity).toBe(REPO);
    expect(worktree.selectedProjectManifest).toBe(worktreeManifest);

    const nonGitCwd = '/scratch/project';
    const nonGitManifest = join(nonGitCwd, 'skillsmith.toml');
    const nonGitPorts = new FakeArtifactPorts({
      [nonGitCwd]: { kind: 'dir', realpath: nonGitCwd },
      [nonGitManifest]: { kind: 'file', text: canonicalManifest(['local']) },
    });
    nonGitPorts.gitRoot = null;
    const nonGitContext = await currentContext(nonGitPorts, nonGitCwd);
    const nonGit = expectOk(
      await api.discoverArtifactSnapshot(nonGitPorts, nonGitContext, {
        explicitProjectScope: true,
      }),
    );
    expect(nonGit.projectContext.projectRoot).toBe(nonGitCwd);
    expect(nonGit.selectedProjectManifest).toBe(nonGitManifest);

    const emptyNonGitCwd = '/scratch/empty-project';
    const emptyNonGitPorts = new FakeArtifactPorts({
      [emptyNonGitCwd]: { kind: 'dir', realpath: emptyNonGitCwd },
    });
    emptyNonGitPorts.gitRoot = null;
    const emptyNonGitContext = await currentContext(emptyNonGitPorts, emptyNonGitCwd);
    expect(emptyNonGitContext.projectRoot).toBeNull();
    const explicitProject = expectOk(
      await api.discoverArtifactSnapshot(emptyNonGitPorts, emptyNonGitContext, {
        explicitProjectScope: true,
      }),
    );
    expect(explicitProject.selectedProjectManifest).toBeNull();
    expect(explicitProject.projectRootManifest).toBe(`${emptyNonGitCwd}/skillsmith.toml`);
    expect(
      expectOk(
        api.selectManifestDestination(explicitProject, {
          names: ['new'],
          scope: 'project',
          mode: 'save',
        }),
      ),
    ).toMatchObject({
      kind: 'new',
      role: 'project-root',
      path: `${emptyNonGitCwd}/skillsmith.toml`,
    });

    const canary = 'discovery-capability-secret-canary';
    for (const capability of ['pathKind', 'readText'] as const) {
      for (const [label, thrown, accessCount] of hostileThrownValues(canary)) {
        const hostilePorts = new FakeArtifactPorts();
        let pathKindCalls = 0;
        let readTextCalls = 0;
        hostilePorts.pathKind = async () => {
          pathKindCalls += 1;
          if (capability === 'pathKind') throw thrown;
          return 'file';
        };
        hostilePorts.readText = async () => {
          readTextCalls += 1;
          if (capability === 'readText') throw thrown;
          return canonicalManifest(['unused']);
        };
        const error = expectError(
          await api.discoverArtifactSnapshot(hostilePorts, frozenContext()),
          'manifest-candidate-unreadable',
          'state',
        );
        expect(error, `${capability}: ${label}`).toEqual({
          code: 'manifest-candidate-unreadable',
          exitClass: 'state',
          message:
            capability === 'pathKind'
              ? 'cannot inspect manifest candidate'
              : 'cannot read manifest candidate',
          paths: [NESTED_MANIFEST],
        });
        expect(Object.isFrozen(error)).toBe(true);
        expect(Object.isFrozen(error.paths)).toBe(true);
        expect('cause' in error).toBe(false);
        expect(JSON.stringify(error)).not.toContain(canary);
        expect(accessCount(), `${capability}: ${label}`).toBe(0);
        expect({ pathKindCalls, readTextCalls }).toEqual({
          pathKindCalls: 1,
          readTextCalls: capability === 'readText' ? 1 : 0,
        });
      }
    }
  });

  test('selects unique declaration owners and refuses every ambiguous or unsafe candidate set', async () => {
    const api = await requireAuthority();
    if (api === null) return;

    const selected = candidate('selected-project', NESTED_MANIFEST, ['nested', 'shared']);
    const root = candidate('project-root', ROOT_MANIFEST, ['root']);
    const user = candidate('user', USER_MANIFEST, ['user'], 'canonical');
    const base = snapshotFixture([selected, root, user]);

    expect(
      expectOk(
        api.selectManifestDestination(
          snapshotFixture(base.candidates, frozenContext(), '/tmp/team.toml'),
          {
            names: ['anything'],
            scope: 'project',
            mode: 'save',
            explicitFile: '/tmp/team.toml',
          },
        ),
      ),
    ).toMatchObject({ kind: 'new', role: 'explicit', path: '/tmp/team.toml' });
    expect(
      expectOk(
        api.selectManifestDestination(base, {
          names: ['nested'],
          scope: 'project',
          mode: 'save',
        }),
      ),
    ).toMatchObject({ kind: 'existing', role: 'selected-project', path: NESTED_MANIFEST });
    expect(
      expectOk(
        api.selectManifestDestination(base, {
          names: ['root'],
          scope: 'project',
          mode: 'save',
        }),
      ),
    ).toMatchObject({ kind: 'existing', role: 'project-root', path: ROOT_MANIFEST });
    expect(
      expectOk(
        api.selectManifestDestination(base, {
          names: ['user'],
          scope: 'project',
          mode: 'save',
        }),
      ),
    ).toMatchObject({ kind: 'existing', role: 'user', path: USER_MANIFEST });

    for (const candidates of [
      [
        candidate('selected-project', NESTED_MANIFEST, ['dupe']),
        candidate('project-root', ROOT_MANIFEST, ['dupe']),
      ],
      [
        candidate('selected-project', NESTED_MANIFEST, ['dupe']),
        candidate('user', USER_MANIFEST, ['dupe']),
      ],
      [
        candidate('project-root', ROOT_MANIFEST, ['dupe']),
        candidate('user', USER_MANIFEST, ['dupe']),
      ],
      [
        candidate('selected-project', NESTED_MANIFEST, ['dupe']),
        candidate('project-root', ROOT_MANIFEST, ['dupe']),
        candidate('user', USER_MANIFEST, ['dupe']),
      ],
    ]) {
      const error = expectError(
        api.selectManifestDestination(snapshotFixture(candidates), {
          names: ['dupe'],
          scope: 'project',
          mode: 'save',
        }),
        'manifest-owner-ambiguous',
        'usage',
      );
      expect(new Set(error.paths)).toEqual(new Set(candidates.map((item) => item.path)));
    }

    const empty = snapshotFixture([]);
    expect(
      expectOk(
        api.selectManifestDestination(empty, {
          names: ['new'],
          scope: 'project',
          mode: 'save',
        }),
      ),
    ).toMatchObject({ kind: 'new', role: 'project-root', path: ROOT_MANIFEST });
    expect(
      expectOk(
        api.selectManifestDestination(empty, { names: ['new'], scope: 'user', mode: 'save' }),
      ),
    ).toMatchObject({ kind: 'new', role: 'user', path: USER_MANIFEST });
    expect(
      expectOk(
        api.selectManifestDestination(empty, {
          names: ['missing'],
          scope: 'project',
          mode: 'remove',
        }),
      ),
    ).toMatchObject({ kind: 'absent', role: null, path: null });

    expectError(
      api.selectManifestDestination(
        snapshotFixture([
          candidate('selected-project', NESTED_MANIFEST, ['one']),
          candidate('user', USER_MANIFEST, ['two']),
        ]),
        { names: ['one', 'two'], scope: 'project', mode: 'save' },
      ),
      'manifest-owner-split',
      'usage',
    );
    expectError(
      api.selectManifestDestination(
        snapshotFixture([candidate('project-root', ROOT_MANIFEST, [], 'malformed')]),
        { names: ['new'], scope: 'project', mode: 'save' },
      ),
      'manifest-candidate-invalid',
      'state',
    );
    expectError(
      api.selectManifestDestination(
        snapshotFixture([
          candidate('selected-project', NESTED_MANIFEST, ['owned']),
          candidate('project-root', ROOT_MANIFEST, [], 'malformed'),
        ]),
        { names: ['owned'], scope: 'project', mode: 'save' },
      ),
      'manifest-candidate-invalid',
      'state',
    );

    expect(base.candidates.some((item) => item.path === USER_CONFIG)).toBe(false);

    expectError(
      api.selectManifestDestination(base, {
        names: ['new'],
        scope: 'project',
        mode: 'save',
        explicitFile: '/tmp/unpreflighted.toml',
      }),
      'manifest-explicit-selector-mismatch',
      'usage',
    );
    const preflightedAbsent = snapshotFixture([], frozenContext(), '/tmp/preflighted.toml');
    expectError(
      api.selectManifestDestination(preflightedAbsent, {
        names: ['new'],
        scope: 'project',
        mode: 'save',
        explicitFile: '/tmp/different.toml',
      }),
      'manifest-explicit-selector-mismatch',
      'usage',
    );
    expect(
      expectOk(
        api.selectManifestDestination(preflightedAbsent, {
          names: ['missing'],
          scope: 'project',
          mode: 'remove',
          explicitFile: '/tmp/preflighted.toml',
        }),
      ),
    ).toMatchObject({ kind: 'absent', role: null, path: null });
  });

  test('resolves one collision-safe, token-preserving, contained artifact pair per invocation', async () => {
    const api = await requireAuthority();
    if (api === null) return;

    const ports = new FakeArtifactPorts({
      [REPO]: { kind: 'dir', realpath: REPO },
      '/work/repo/state/team.toml': { kind: 'file', text: canonicalManifest([]) },
      '/work/repo/state/team.lock': { kind: 'file', text: '' },
      '/work/repo/alias.toml': { kind: 'symlink', realpath: '/work/repo/state/team.toml' },
      '/work/repo/alias.lock': { kind: 'symlink', realpath: '/work/repo/state/team.toml' },
      '/work/repo/escape.lock': { kind: 'symlink', realpath: '/outside/escape.lock' },
    });
    const context = frozenContext(REPO, REPO, ROOT_MANIFEST);

    const sibling = expectOk(
      await api.resolveArtifactPair(ports, context, { file: './state/team.toml' }),
    );
    expect(sibling.file).toMatchObject({
      token: './state/team.toml',
      path: '/work/repo/state/team.toml',
      portability: 'portable',
      portableToken: './state/team.toml',
    });
    expect(sibling.lockfile).toMatchObject({ path: '/work/repo/state/team.lock' });
    expect(sibling.lockfileSource).toBe('sibling');

    const noFilePorts = new FakeArtifactPorts();
    expectError(
      await api.resolveArtifactPair(noFilePorts, context, { lockfile: './team.lock' }),
      'artifact-lockfile-requires-file',
      'usage',
    );
    expect(noFilePorts.calls.pathKind).toEqual([]);
    expect(noFilePorts.calls.realpath).toEqual([]);

    const lexicalPorts = new FakeArtifactPorts();
    expectError(
      await api.resolveArtifactPair(lexicalPorts, context, {
        file: './team.toml',
        lockfile: 'state/../team.toml',
      }),
      'artifact-pair-collision',
      'usage',
    );
    expect(lexicalPorts.calls.pathKind).toEqual([]);
    expect(lexicalPorts.calls.realpath).toEqual([]);
    expect(lexicalPorts.calls.readText).toEqual([]);

    expectError(
      await api.resolveArtifactPair(ports, context, {
        file: './alias.toml',
        lockfile: './alias.lock',
      }),
      'artifact-pair-collision',
      'usage',
    );
    expect(ports.calls.realpath.filter((path) => path === '/work/repo/alias.toml')).toHaveLength(1);
    expect(ports.calls.realpath.filter((path) => path === '/work/repo/alias.lock')).toHaveLength(1);

    expectError(
      await api.resolveArtifactPair(new FakeArtifactPorts(), context, { file: './team.lock' }),
      'artifact-pair-collision',
      'usage',
    );
    expectError(
      await api.resolveArtifactPair(new FakeArtifactPorts(), context, {
        file: './team.toml',
        lockfile: '../team.lock',
      }),
      'artifact-selector-escape',
      'usage',
    );
    expectError(
      await api.resolveArtifactPair(ports, context, {
        file: './state/team.toml',
        lockfile: './escape.lock',
      }),
      'artifact-selector-escape',
      'usage',
    );

    for (const token of [
      'C:\\state\\team.lock',
      'C:state/team.lock',
      '\\\\server\\state\\team.lock',
      'state\\team.lock',
    ]) {
      expectError(
        await api.resolveArtifactPair(new FakeArtifactPorts(), context, {
          file: './team.toml',
          lockfile: token,
        }),
        'artifact-selector-nonportable',
        'usage',
      );
    }
    expectError(
      await api.resolveArtifactPair(new FakeArtifactPorts(), context, {
        file: './team.toml',
        lockfile: 'team\u0001.lock',
      }),
      'artifact-selector-invalid',
      'usage',
    );

    const ancestorPorts = new FakeArtifactPorts({
      [REPO]: { kind: 'dir', realpath: REPO },
      '/work/repo/escape-dir': { kind: 'symlink', realpath: '/outside' },
      '/work/repo/inside-dir': { kind: 'symlink', realpath: '/work/repo/actual' },
    });
    expectError(
      await api.resolveArtifactPair(ancestorPorts, context, {
        file: './escape-dir/missing/team.toml',
      }),
      'artifact-selector-escape',
      'usage',
    );
    const containedDescendant = expectOk(
      await api.resolveArtifactPair(ancestorPorts, context, {
        file: './inside-dir/missing/team.toml',
      }),
    );
    expect(containedDescendant.file.path).toBe('/work/repo/inside-dir/missing/team.toml');

    const explicit = expectOk(
      await api.resolveArtifactPair(new FakeArtifactPorts(), context, {
        file: './team.toml',
        lockfile: './locks/../locks/team.lock',
      }),
    );
    expect(explicit.lockfile).toMatchObject({
      token: './locks/../locks/team.lock',
      path: '/work/repo/locks/team.lock',
      portability: 'portable',
      portableToken: './locks/team.lock',
    });
    expect(explicit.lockfileSource).toBe('explicit');

    const crossDirectoryPorts = new FakeArtifactPorts();
    const crossDirectory = expectOk(
      await api.resolveArtifactPair(crossDirectoryPorts, context, {
        file: './state/team.toml',
        lockfile: './root.lock',
      }),
    );
    expect(crossDirectory.file.path).toBe('/work/repo/state/team.toml');
    expect(crossDirectory.lockfile.path).toBe('/work/repo/root.lock');
    expect(crossDirectoryPorts.calls.gitRoot).toEqual([]);

    const repeated = expectOk(
      await api.resolveArtifactPair(new FakeArtifactPorts(), context, { file: './team.toml' }),
    );
    expect(repeated.lockfile.path).toBe('/work/repo/team.lock');
    expect(repeated.lockfileSource).toBe('sibling');

    const discovered = expectOk(
      await api.resolveArtifactPair(new FakeArtifactPorts(), context, {
        discoveredFile: '/work/repo/discovered.toml',
      }),
    );
    expect(discovered.file.path).toBe('/work/repo/discovered.toml');
    expect(discovered.lockfile.path).toBe('/work/repo/discovered.lock');
    expect(discovered.lockfileSource).toBe('sibling');

    const absolute = expectOk(
      await api.resolveArtifactPair(new FakeArtifactPorts(), context, {
        file: './team.toml',
        lockfile: '/var/tmp/team.lock',
      }),
    );
    expect(absolute.lockfile).toMatchObject({
      token: '/var/tmp/team.lock',
      path: '/var/tmp/team.lock',
      portability: 'machine-bound',
      portableToken: null,
    });

    const canary = 'pair-capability-secret-canary';
    for (const capability of ['pathKind', 'realpath'] as const) {
      for (const [label, thrown, accessCount] of hostileThrownValues(canary)) {
        const hostilePorts = new FakeArtifactPorts();
        let pathKindCalls = 0;
        let realpathCalls = 0;
        hostilePorts.pathKind = async () => {
          pathKindCalls += 1;
          if (capability === 'pathKind') throw thrown;
          return 'file';
        };
        hostilePorts.realpath = async (path) => {
          realpathCalls += 1;
          if (capability === 'realpath') throw thrown;
          return path;
        };
        const error = expectError(
          await api.resolveArtifactPair(hostilePorts, context, { file: './team.toml' }),
          'artifact-selector-unresolvable',
          'state',
        );
        expect(error, `${capability}: ${label}`).toEqual({
          code: 'artifact-selector-unresolvable',
          exitClass: 'state',
          message: 'cannot resolve artifact selector',
          paths: ['/work/repo/team.toml'],
        });
        expect(Object.isFrozen(error)).toBe(true);
        expect(Object.isFrozen(error.paths)).toBe(true);
        expect('cause' in error).toBe(false);
        expect(JSON.stringify(error)).not.toContain(canary);
        expect(accessCount(), `${capability}: ${label}`).toBe(0);
        expect({ pathKindCalls, realpathCalls }).toEqual({
          pathKindCalls: 1,
          realpathCalls: capability === 'realpath' ? 1 : 0,
        });
      }
    }
    expect(context.projectRoot).toBe(REPO);
    expect(context.projectIdentity).toBe(REPO);
    expect(ports.calls.readText).toEqual([]);
    expect(ports.calls.gitRoot).toEqual([]);
  });
});
