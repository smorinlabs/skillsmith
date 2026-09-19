import { describe, expect, test } from 'bun:test';
import type {
  ArtifactCoordinatorPorts,
  ArtifactPathObservation,
} from '../../src/artifacts/coordinator-types.ts';
import {
  artifactMutationError,
  nodeErrorToArtifactMutationError,
  observeArtifactFile,
  observeArtifactPair,
} from '../../src/artifacts/file-state.ts';

const presentParent = Object.freeze({
  state: 'present' as const,
  path: '/tmp',
  identity: 'parent-1',
});

const observation = (overrides: Partial<ArtifactPathObservation> = {}): ArtifactPathObservation =>
  Object.freeze({
    kind: 'file',
    mode: 0o640,
    identity: 'leaf-1',
    linkCount: 1,
    parent: presentParent,
    ...overrides,
  });

const snapshotPorts = (
  observations: readonly ArtifactPathObservation[],
  bytes: Uint8Array,
): Pick<ArtifactCoordinatorPorts, 'observe' | 'readBytes'> => {
  let index = 0;
  return {
    observe: async () => observations[index++] ?? (observations.at(-1) as ArtifactPathObservation),
    readBytes: async () => bytes,
  };
};

describe('artifact file-state', () => {
  test('copies bytes and freezes every snapshot fact without aliasing adapter values', async () => {
    const source = new Uint8Array([1, 2, 3]);
    const result = await observeArtifactFile(
      snapshotPorts([observation(), observation()], source),
      '/tmp/skillsmith.toml',
      'resource',
    );
    expect('code' in result).toBeFalse();
    if ('code' in result || result.state !== 'file') throw new Error('expected file');
    source[0] = 9;
    expect([...result.bytes]).toEqual([1, 2, 3]);
    expect(Object.isFrozen(result)).toBeTrue();
    expect(Object.isFrozen(result.parent)).toBeTrue();
  });

  test('refuses special topology, hard links, metadata races, and pair aliases', async () => {
    for (const invalid of [
      observation({ kind: 'directory' }),
      observation({ kind: 'symlink' }),
      observation({ kind: 'other' }),
      observation({ linkCount: 2 }),
    ]) {
      const result = await observeArtifactFile(
        snapshotPorts([invalid], new Uint8Array()),
        '/tmp/artifact',
        'resource',
      );
      expect('code' in result && result.reason).toBe('invalid-file-kind');
    }

    const raced = await observeArtifactFile(
      snapshotPorts([observation(), observation({ identity: 'leaf-2' })], new Uint8Array([1])),
      '/tmp/artifact',
      'resource',
    );
    expect('code' in raced && raced.reason).toBe('external-writer-conflict');

    const lock = new TextEncoder().encode(
      `version = 1\nhash_schema_version = 1\nmanifest_hash = "sha256:${'0'.repeat(64)}"\n`,
    );
    const pairPorts = {
      observe: async () => observation({ identity: 'same-leaf' }),
      readBytes: async () => lock,
    };
    const pair = await observeArtifactPair(pairPorts, '/tmp/a', '/tmp/b');
    expect('code' in pair && pair.reason).toBe('artifact-alias');
  });

  test('keeps the closed exit-code partition', () => {
    const cases = [
      ['invalid-request', 2],
      ['unsafe-human-edit', 2],
      ['invalid-utf8', 3],
      ['invalid-manifest', 3],
      ['recovery-conflict', 3],
      ['permission-denied', 6],
      ['cancelled', 130],
    ] as const;
    for (const [reason, exitCode] of cases) {
      expect(artifactMutationError(reason).exitCode).toBe(exitCode);
    }
  });

  test('classifies only own data error codes without invoking getters or Proxy handlers', () => {
    for (const code of ['EACCES', 'EPERM'] as const) {
      expect(nodeErrorToArtifactMutationError(Object.freeze({ code })).reason).toBe(
        'permission-denied',
      );
    }

    let getterCalls = 0;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, 'code', {
      get: () => {
        getterCalls += 1;
        return 'EACCES';
      },
    });
    expect(nodeErrorToArtifactMutationError(accessor).reason).toBe('filesystem-failure');
    expect(getterCalls).toBe(0);

    let handlerCalls = 0;
    const proxy = new Proxy(Object.create(null) as Record<string, unknown>, {
      get: () => {
        handlerCalls += 1;
        return 'EACCES';
      },
      getOwnPropertyDescriptor: () => {
        handlerCalls += 1;
        return undefined;
      },
      getPrototypeOf: () => {
        handlerCalls += 1;
        return null;
      },
      has: () => {
        handlerCalls += 1;
        return true;
      },
      ownKeys: () => {
        handlerCalls += 1;
        return ['code'];
      },
    });
    expect(nodeErrorToArtifactMutationError(proxy).reason).toBe('filesystem-failure');
    expect(handlerCalls).toBe(0);
  });
});
