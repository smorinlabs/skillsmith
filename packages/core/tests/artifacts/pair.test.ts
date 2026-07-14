import { describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import {
  type ArtifactPairError,
  type ArtifactPairPorts,
  type ResolvedArtifactPair,
  type ResolvedExplicitArtifactPair,
  classifyArtifactSelectorToken,
  resolveArtifactPair,
  resolveExplicitArtifactPairLexically,
} from '../../src/artifacts/pair.ts';
import type { ProjectContext } from '../../src/context/types.ts';
import type { Result } from '../../src/result.ts';

const ROOT = '/work/repo';

const context: ProjectContext = Object.freeze({
  invocationCwd: ROOT,
  effectiveCwd: ROOT,
  projectRoot: ROOT,
  projectIdentity: ROOT,
  projectKind: 'git',
  discoveredConfigPath: `${ROOT}/skillsmith.toml`,
  explicitConfigPath: null,
});

class FakePairPorts implements ArtifactPairPorts {
  readonly entries = new Map<string, Readonly<{ kind: 'file' | 'symlink'; realpath: string }>>();
  readonly calls = { pathKind: [] as string[], realpath: [] as string[] };

  constructor(
    entries: Readonly<
      Record<string, Readonly<{ kind: 'file' | 'symlink'; realpath: string }>>
    > = {},
  ) {
    for (const [path, entry] of Object.entries(entries)) this.entries.set(normalize(path), entry);
  }

  async pathKind(path: string): Promise<'absent' | 'file' | 'symlink'> {
    const key = normalize(path);
    this.calls.pathKind.push(key);
    return this.entries.get(key)?.kind ?? 'absent';
  }

  async realpath(path: string): Promise<string> {
    const key = normalize(path);
    this.calls.realpath.push(key);
    const entry = this.entries.get(key);
    if (entry === undefined) throw new Error(`unexpected realpath: ${key}`);
    return entry.realpath;
  }
}

const expectOk = (
  result: Result<ResolvedArtifactPair, ArtifactPairError>,
): ResolvedArtifactPair => {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

const expectError = <T>(
  result: Result<T, ArtifactPairError>,
  code: ArtifactPairError['code'],
  exitClass: ArtifactPairError['exitClass'] = 'usage',
): ArtifactPairError => {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected artifact-pair refusal');
  expect(result.error).toMatchObject({ code, exitClass });
  return result.error;
};

const expectLexicalOk = (
  result: Result<ResolvedExplicitArtifactPair, ArtifactPairError>,
): ResolvedExplicitArtifactPair => {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

const hostileThrownValues = (): ReadonlyArray<
  readonly [label: string, value: unknown, accessCount: () => number]
> => {
  const canaryError = new Error('pair-capability-secret-canary');
  const canaryPrimitive = 'pair-capability-secret-canary';
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
    ['canary primitive', canaryPrimitive, () => 0],
    ['hostile message accessor', accessorError, () => messageAccesses],
    ['hostile coercion', hostileCoercion, () => coercionAccesses],
    ['hostile proxy', hostileProxy, () => proxyAccesses],
  ];
};

describe('artifact pair resolution', () => {
  test('classifies Windows selectors independently of the executing host', () => {
    for (const token of ['C:team.toml', 'z:relative/path']) {
      expect(classifyArtifactSelectorToken(token, 'posix')).toBe('nonportable');
      expect(classifyArtifactSelectorToken(token, 'windows')).toBe('nonportable');
    }
    for (const token of [
      'C:/state/team.toml',
      'C:\\state\\team.toml',
      '\\\\host\\share\\team.toml',
    ]) {
      expect(classifyArtifactSelectorToken(token, 'posix')).toBe('nonportable');
      expect(classifyArtifactSelectorToken(token, 'windows')).toBe('machine-bound');
    }
    expect(classifyArtifactSelectorToken('state\\team.toml', 'posix')).toBe('nonportable');
    expect(classifyArtifactSelectorToken('state\\team.toml', 'windows')).toBe('portable');
    expect(classifyArtifactSelectorToken('./state/team.toml', 'posix')).toBe('portable');
    expect(classifyArtifactSelectorToken('./state/team.toml', 'windows')).toBe('portable');
  });

  test('resolves explicit selectors lexically without filesystem authority', () => {
    expect(expectLexicalOk(resolveExplicitArtifactPairLexically({ effectiveCwd: ROOT }))).toEqual({
      file: null,
      lockfile: null,
      lockfileSource: null,
    });
    expect(
      expectLexicalOk(
        resolveExplicitArtifactPairLexically({
          effectiveCwd: ROOT,
          file: './state/team.toml',
        }),
      ),
    ).toEqual({
      file: '/work/repo/state/team.toml',
      lockfile: '/work/repo/state/team.lock',
      lockfileSource: 'sibling',
    });

    expectError(
      resolveExplicitArtifactPairLexically({
        effectiveCwd: ROOT,
        lockfile: './team.lock',
      }),
      'artifact-lockfile-requires-file',
    );
    expectError(
      resolveExplicitArtifactPairLexically({
        effectiveCwd: ROOT,
        file: './team.toml',
        lockfile: 'state/../team.toml',
      }),
      'artifact-pair-collision',
    );
    for (const token of ['C:team.toml', 'state\\team.toml']) {
      expectError(
        resolveExplicitArtifactPairLexically({ effectiveCwd: ROOT, file: token }),
        'artifact-selector-nonportable',
      );
    }
    expectError(
      resolveExplicitArtifactPairLexically({ effectiveCwd: ROOT, file: 'team\u0001.toml' }),
      'artifact-selector-invalid',
    );
  });

  test('derives a portable sibling while retaining the original file token', async () => {
    const pair = expectOk(
      await resolveArtifactPair(new FakePairPorts(), context, { file: './state/team.toml' }),
    );

    expect(pair).toEqual({
      file: {
        token: './state/team.toml',
        path: '/work/repo/state/team.toml',
        portability: 'portable',
        portableToken: './state/team.toml',
      },
      lockfile: {
        token: null,
        path: '/work/repo/state/team.lock',
        portability: 'portable',
        portableToken: './state/team.lock',
      },
      lockfileSource: 'sibling',
    });
    expect(Object.isFrozen(pair)).toBe(true);
    expect(Object.isFrozen(pair.file)).toBe(true);
  });

  test('requires explicit file authority before an explicit lockfile and performs no IO', async () => {
    const ports = new FakePairPorts();
    expectError(
      await resolveArtifactPair(ports, context, { lockfile: './team.lock' }),
      'artifact-lockfile-requires-file',
    );
    expect(ports.calls).toEqual({ pathKind: [], realpath: [] });
  });

  test('rejects lexical and sibling collisions before IO', async () => {
    for (const options of [
      { file: './team.toml', lockfile: 'state/../team.toml' },
      { file: './team.lock' },
    ]) {
      const ports = new FakePairPorts();
      expectError(await resolveArtifactPair(ports, context, options), 'artifact-pair-collision');
      expect(ports.calls).toEqual({ pathKind: [], realpath: [] });
    }
  });

  test('probes each existing selector once and rejects realpath aliases', async () => {
    const target = '/work/repo/state/team.toml';
    const ports = new FakePairPorts({
      '/work/repo/alias.toml': { kind: 'symlink', realpath: target },
      '/work/repo/alias.lock': { kind: 'symlink', realpath: target },
    });

    expectError(
      await resolveArtifactPair(ports, context, {
        file: './alias.toml',
        lockfile: './alias.lock',
      }),
      'artifact-pair-collision',
    );
    expect(ports.calls).toEqual({
      pathKind: ['/work/repo/alias.toml', '/work/repo/alias.lock'],
      realpath: ['/work/repo/alias.toml', '/work/repo/alias.lock'],
    });
  });

  test('returns fixed state errors without inspecting rejected capability values', async () => {
    for (const capability of ['pathKind', 'realpath'] as const) {
      for (const [label, thrown, accessCount] of hostileThrownValues()) {
        const calls = { pathKind: 0, realpath: 0 };
        const ports: ArtifactPairPorts = {
          pathKind: async () => {
            calls.pathKind += 1;
            if (capability === 'pathKind') throw thrown;
            return 'file';
          },
          realpath: async (path) => {
            calls.realpath += 1;
            if (capability === 'realpath') throw thrown;
            return path;
          },
        };

        const error = expectError(
          await resolveArtifactPair(ports, context, { file: './team.toml' }),
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
        expect(JSON.stringify(error)).not.toContain('pair-capability-secret-canary');
        expect(accessCount(), `${capability}: ${label}`).toBe(0);
        expect(calls).toEqual({
          pathKind: 1,
          realpath: capability === 'realpath' ? 1 : 0,
        });
      }
    }
  });

  test('rejects lexical, foreign-form, and symlink escapes from a relative override', async () => {
    expectError(
      await resolveArtifactPair(new FakePairPorts(), context, {
        file: './team.toml',
        lockfile: '../team.lock',
      }),
      'artifact-selector-escape',
    );
    for (const token of [
      'C:\\state\\team.lock',
      'C:state/team.lock',
      '\\\\server\\state\\team.lock',
      'state\\team.lock',
    ]) {
      expectError(
        await resolveArtifactPair(new FakePairPorts(), context, {
          file: './team.toml',
          lockfile: token,
        }),
        'artifact-selector-nonportable',
      );
    }
    expectError(
      await resolveArtifactPair(new FakePairPorts(), context, {
        file: './team.toml',
        lockfile: 'team\u0001.lock',
      }),
      'artifact-selector-invalid',
    );

    const ports = new FakePairPorts({
      '/work/repo/team.toml': { kind: 'file', realpath: '/work/repo/team.toml' },
      '/work/repo/escape.lock': { kind: 'symlink', realpath: '/outside/escape.lock' },
    });
    expectError(
      await resolveArtifactPair(ports, context, {
        file: './team.toml',
        lockfile: './escape.lock',
      }),
      'artifact-selector-escape',
    );
  });

  test('realpaths the nearest existing ancestor for absent descendants under symlink directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-pair-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'skillsmith-pair-outside-'));
    const actual = join(root, 'actual');
    await mkdir(actual);
    await symlink(outside, join(root, 'escape'), 'dir');
    await symlink(actual, join(root, 'inside'), 'dir');

    const realPorts: ArtifactPairPorts = {
      pathKind: async (path) => {
        try {
          const stat = await lstat(path);
          if (stat.isSymbolicLink()) return 'symlink';
          if (stat.isFile()) return 'file';
          return 'dir';
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
          throw error;
        }
      },
      realpath,
    };
    const realContext: ProjectContext = Object.freeze({
      ...context,
      invocationCwd: root,
      effectiveCwd: root,
      projectRoot: root,
      projectIdentity: root,
      discoveredConfigPath: join(root, 'skillsmith.toml'),
    });

    try {
      expectError(
        await resolveArtifactPair(realPorts, realContext, {
          file: './escape/missing/team.toml',
        }),
        'artifact-selector-escape',
      );
      const inRoot = expectOk(
        await resolveArtifactPair(realPorts, realContext, {
          file: './inside/missing/team.toml',
        }),
      );
      expect(inRoot.file.path).toBe(join(root, 'inside/missing/team.toml'));
      expect(inRoot.lockfile.path).toBe(join(root, 'inside/missing/team.lock'));
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('normalizes portable tokens but keeps machine-bound and discovered selection distinct', async () => {
    const portable = expectOk(
      await resolveArtifactPair(new FakePairPorts(), context, {
        file: './team.toml',
        lockfile: './locks/../locks/team.lock',
      }),
    );
    expect(portable.lockfile).toMatchObject({
      token: './locks/../locks/team.lock',
      portableToken: './locks/team.lock',
      portability: 'portable',
    });

    const machineBound = expectOk(
      await resolveArtifactPair(new FakePairPorts(), context, {
        file: './team.toml',
        lockfile: '/var/tmp/team.lock',
      }),
    );
    expect(machineBound.lockfile).toMatchObject({
      token: '/var/tmp/team.lock',
      path: '/var/tmp/team.lock',
      portableToken: null,
      portability: 'machine-bound',
    });

    const discovered = expectOk(
      await resolveArtifactPair(new FakePairPorts(), context, {
        discoveredFile: '/work/repo/discovered.toml',
      }),
    );
    expect(discovered.file).toMatchObject({ token: null, path: '/work/repo/discovered.toml' });
    expect(discovered.lockfile.path).toBe('/work/repo/discovered.lock');
  });
});
