import { describe, expect, test } from 'bun:test';
import { createStoreRepository } from '../../src/place/store-repository.ts';
import { createStoreSnapshotIdentityV1 } from '../../src/state/types.ts';

const digest = (hex: string): `sha256:${string}` => `sha256:${hex.repeat(64)}`;

describe('private store repository adapter', () => {
  test('dispatches multiple immutable directory snapshots with canonical facts', async () => {
    const alphaPath = '/fixture/store/alpha';
    const betaPath = '/fixture/store/beta';
    const repository = createStoreRepository({
      resources: [
        { resourceId: 'store:alpha', storePath: alphaPath },
        { resourceId: 'store:beta', storePath: betaPath },
      ],
      ports: {
        pathKind: async (path) => (path === alphaPath || path === betaPath ? 'dir' : 'absent'),
        readFileMetadata: async (path) =>
          path === alphaPath || path === betaPath
            ? {
                kind: 'dir',
                mode: 0o755,
                identity: path === alphaPath ? 'store:1' : 'store:2',
                linkCount: 1,
              }
            : { kind: 'dir', mode: 0o755, identity: 'parent:1', linkCount: 1 },
        listDir: async () => [],
        readLink: async () => '',
        readBytes: async () => new Uint8Array(),
        isExecutable: async () => false,
      },
    });

    const alpha = await repository.observe('store:alpha');
    const beta = await repository.observe('store:beta');

    expect(alpha.ok).toBeTrue();
    expect(beta.ok).toBeTrue();
    if (!alpha.ok || !beta.ok) return;
    const alphaValue = alpha.value.value;
    const betaValue = beta.value.value;
    if (alphaValue === null || betaValue === null) throw new Error('expected present stores');
    const alphaContentRevision = alphaValue.contentRevision;
    const betaContentRevision = betaValue.contentRevision;
    expect(Object.isFrozen(alphaValue)).toBeTrue();
    expect(alphaValue.path).toBe(alphaPath);
    expect(alphaValue.repositoryRevision).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(alphaValue.contentRevision).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(alphaValue.snapshotIdentity).toMatch(/^store:v1:[0-9a-f]{64}$/u);
    expect(alpha.value.revision).toMatchObject({
      domain: 'store',
      state: 'present',
      resourceId: 'store:alpha',
      targetKind: 'directory',
      resourceRevision: alphaValue.repositoryRevision,
      snapshotIdentity: alphaValue.snapshotIdentity,
    });
    expect(alphaValue.snapshotIdentity).toBe(
      createStoreSnapshotIdentityV1('store:alpha', alphaContentRevision),
    );
    expect(betaValue.snapshotIdentity).toBe(
      createStoreSnapshotIdentityV1('store:beta', betaContentRevision),
    );
    expect(alphaValue.repositoryRevision).toBe(betaValue.repositoryRevision);
    expect(alphaValue.snapshotIdentity).not.toBe(betaValue.snapshotIdentity);
  });

  test('refuses a non-directory store target', async () => {
    const storePath = '/fixture/store/alpha';
    const repository = createStoreRepository({
      resources: [{ resourceId: 'store:alpha', storePath }],
      ports: {
        pathKind: async () => 'symlink',
        readFileMetadata: async (path) =>
          path === storePath
            ? { kind: 'symlink', mode: 0o777, identity: 'store:1', linkCount: 1 }
            : { kind: 'dir', mode: 0o755, identity: 'parent:1', linkCount: 1 },
        listDir: async () => [],
        readLink: async () => '/external',
        readBytes: async () => new Uint8Array(),
        isExecutable: async () => false,
      },
    });

    expect(await repository.observe('store:alpha')).toEqual({
      ok: false,
      error: {
        code: 'state-repository',
        domain: 'store',
        reason: 'observation-failed',
      },
    });
  });

  test('reobserves absence before staging and rejects a forged caller revision', async () => {
    const storePath = '/fixture/store/alpha';
    let parentIdentity = 'parent:1';
    let parentLinkCount = 1;
    const repository = createStoreRepository({
      resources: [{ resourceId: 'store:alpha', storePath }],
      ports: {
        pathKind: async () => 'absent',
        readFileMetadata: async (path) =>
          path === storePath
            ? { kind: 'absent', mode: null, identity: null, linkCount: 0 }
            : {
                kind: 'dir',
                mode: 0o755,
                identity: parentIdentity,
                linkCount: parentLinkCount,
              },
        listDir: async () => [],
        readLink: async () => '',
        readBytes: async () => new Uint8Array(),
        isExecutable: async () => false,
      },
    });
    const expected = await repository.observeRevision('store:alpha');
    expect(expected.ok).toBeTrue();
    if (!expected.ok) return;
    parentLinkCount += 1;
    expect(await repository.observeRevision('store:alpha')).toEqual(expected);
    parentIdentity = 'parent:2';

    const staged = await repository.stage({
      schemaVersion: 1,
      operationId: 'operation:fixture',
      domain: 'store',
      resourceId: 'store:alpha',
      expectedRevision: expected.value,
      editDigest: digest('a'),
      observedRevision: expected.value,
    } as never);

    expect(staged).toEqual({
      ok: false,
      error: { code: 'stale-revision', domain: 'store', resourceId: 'store:alpha' },
    });
  });

  test('fails closed for unknown resources and duplicate IDs or normalized paths', async () => {
    const ports = {
      pathKind: async () => 'absent' as const,
      readFileMetadata: async () => ({
        kind: 'absent' as const,
        mode: null,
        identity: null,
        linkCount: 0,
      }),
      listDir: async () => [],
      readLink: async () => '',
      readBytes: async () => new Uint8Array(),
      isExecutable: async () => false,
    };
    for (const resources of [
      [
        { resourceId: 'store:alpha', storePath: '/fixture/store/alpha' },
        { resourceId: 'store:alpha', storePath: '/fixture/store/beta' },
      ],
      [
        { resourceId: 'store:alpha', storePath: '/fixture/store/alpha' },
        { resourceId: 'store:beta', storePath: '/fixture/store/../store/alpha' },
      ],
    ]) {
      const repository = createStoreRepository({ resources, ports });
      expect(await repository.observe('store:alpha')).toMatchObject({
        ok: false,
        error: { code: 'state-repository', domain: 'store', reason: 'invalid-request' },
      });
    }

    const valid = createStoreRepository({
      resources: [{ resourceId: 'store:alpha', storePath: '/fixture/store/alpha' }],
      ports,
    });
    expect(await valid.observe('store:missing')).toMatchObject({
      ok: false,
      error: { code: 'state-repository', domain: 'store', reason: 'invalid-request' },
    });
  });
});
