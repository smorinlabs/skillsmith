import { describe, expect, test } from 'bun:test';
import { normalize } from 'node:path';
import {
  type ArtifactPairError,
  type ArtifactPairPorts,
  type ResolvedArtifactPair,
  resolveArtifactPair,
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

const expectError = (
  result: Result<ResolvedArtifactPair, ArtifactPairError>,
  code: ArtifactPairError['code'],
  exitClass: ArtifactPairError['exitClass'] = 'usage',
): ArtifactPairError => {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected artifact-pair refusal');
  expect(result.error).toMatchObject({ code, exitClass });
  return result.error;
};

describe('artifact pair resolution', () => {
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

  test('rejects lexical, foreign-form, and symlink escapes from a relative override', async () => {
    expectError(
      await resolveArtifactPair(new FakePairPorts(), context, {
        file: './team.toml',
        lockfile: '../team.lock',
      }),
      'artifact-selector-escape',
    );
    for (const token of ['C:\\state\\team.lock', '\\\\server\\state\\team.lock']) {
      expectError(
        await resolveArtifactPair(new FakePairPorts(), context, {
          file: './team.toml',
          lockfile: token,
        }),
        'artifact-selector-nonportable',
      );
    }

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
