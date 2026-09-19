import { describe, expect, test } from 'bun:test';
import { createLivePlacementRepository } from '../../src/place/live-repository.ts';

const skillBytes = new TextEncoder().encode('---\nname: alpha\n---\n');
const digest = (hex: string): `sha256:${string}` => `sha256:${hex.repeat(64)}`;

describe('private live-placement repository adapter', () => {
  test('dispatches multiple resources and owns enriched symlink and directory facts', async () => {
    const alphaPath = '/fixture/live/alpha';
    const betaPath = '/fixture/live/beta';
    const repository = createLivePlacementRepository({
      resources: [
        {
          resourceId: 'live:user:codex:alpha',
          skill: 'alpha',
          tool: 'codex',
          scope: 'user',
          projectIdentity: null,
          placementPath: alphaPath,
          storeRoot: '/fixture/store',
        },
        {
          resourceId: 'live:project:codex:beta',
          skill: 'beta',
          tool: 'codex',
          scope: 'project',
          projectIdentity: '/fixture/project',
          placementPath: betaPath,
          storeRoot: '/fixture/store',
        },
      ],
      ports: {
        pathKind: async (path) => {
          if (path === alphaPath) return 'symlink';
          if (path === betaPath || path === '/fixture/store/alpha') return 'dir';
          if (path === `${betaPath}/SKILL.md`) return 'file';
          return 'absent';
        },
        readFileMetadata: async (path) => {
          if (path === alphaPath) {
            return { kind: 'symlink', mode: 0o777, identity: 'link:1', linkCount: 1 };
          }
          if (path === betaPath) {
            return { kind: 'dir', mode: 0o755, identity: 'beta:1', linkCount: 1 };
          }
          if (path === `${alphaPath}/SKILL.md` || path === `${betaPath}/SKILL.md`) {
            return { kind: 'file', mode: 0o644, identity: `skill:${path}`, linkCount: 1 };
          }
          return { kind: 'dir', mode: 0o755, identity: `dir:${path}`, linkCount: 1 };
        },
        readLink: async (path) => {
          if (path !== alphaPath) throw new Error(`unexpected readlink: ${path}`);
          return '../store/alpha';
        },
        realpath: async (path) => {
          if (path === alphaPath) return '/fixture/store/alpha';
          if (path === betaPath) return betaPath;
          throw new Error(`unexpected realpath: ${path}`);
        },
        listDir: async (path) => {
          if (path === betaPath || path === '/fixture/store/alpha') return ['SKILL.md'];
          throw new Error(`unexpected listing: ${path}`);
        },
        readBytes: async (path) => {
          if (
            path === `${alphaPath}/SKILL.md` ||
            path === `${betaPath}/SKILL.md` ||
            path === '/fixture/store/alpha/SKILL.md'
          ) {
            return skillBytes;
          }
          throw new Error(`unexpected byte read: ${path}`);
        },
        isExecutable: async () => false,
      },
    });

    const alpha = await repository.observe('live:user:codex:alpha');
    const beta = await repository.observe('live:project:codex:beta');
    const alphaRevision = await repository.observeRevision('live:user:codex:alpha');

    expect(alpha.ok).toBeTrue();
    expect(beta.ok).toBeTrue();
    expect(alphaRevision.ok).toBeTrue();
    if (!alpha.ok || !beta.ok || !alphaRevision.ok) return;
    expect(alpha.value.value).toEqual({
      skill: 'alpha',
      tool: 'codex',
      scope: 'user',
      projectIdentity: null,
      representation: 'symlink',
      path: alphaPath,
      realpath: '/fixture/store/alpha',
      linkTarget: '../store/alpha',
      dangling: false,
      placementClass: 'store-linked',
      skillFile: 'valid',
      brokenReason: null,
      contentRevision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(beta.value.value).toMatchObject({
      skill: 'beta',
      scope: 'project',
      projectIdentity: '/fixture/project',
      representation: 'directory',
      path: betaPath,
      realpath: betaPath,
      linkTarget: null,
      dangling: false,
      placementClass: 'pinned',
      skillFile: 'valid',
      brokenReason: null,
      contentRevision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(alpha.value.revision).toEqual(alphaRevision.value);
    expect(alpha.value.revision).toMatchObject({
      domain: 'live',
      state: 'present',
      targetKind: 'symlink',
      resourceId: 'live:user:codex:alpha',
    });
  });

  test('rehashes a resolved symlink target and rejects a stale stage after source edits', async () => {
    const placementPath = '/fixture/live/alpha';
    const resolvedPath = '/fixture/dev/alpha';
    let sourceBytes = new TextEncoder().encode('---\nname: alpha\n---\nversion one\n');
    const repository = createLivePlacementRepository({
      resources: [
        {
          resourceId: 'live:user:codex:alpha',
          skill: 'alpha',
          tool: 'codex',
          scope: 'user',
          projectIdentity: null,
          placementPath,
          storeRoot: '/fixture/store',
        },
      ],
      ports: {
        pathKind: async (path) => {
          if (path === placementPath) return 'symlink';
          if (path === resolvedPath) return 'dir';
          if (path === `${resolvedPath}/SKILL.md` || path === `${placementPath}/SKILL.md`) {
            return 'file';
          }
          return 'absent';
        },
        readFileMetadata: async (path) => {
          if (path === placementPath) {
            return { kind: 'symlink', mode: 0o777, identity: 'link:alpha', linkCount: 1 };
          }
          if (path === resolvedPath || path === '/fixture/live') {
            return { kind: 'dir', mode: 0o755, identity: `dir:${path}`, linkCount: 1 };
          }
          if (path === `${placementPath}/SKILL.md`) {
            return { kind: 'file', mode: 0o644, identity: 'skill:alpha', linkCount: 1 };
          }
          return { kind: 'absent', mode: null, identity: null, linkCount: 0 };
        },
        readLink: async () => '../dev/alpha',
        realpath: async () => resolvedPath,
        listDir: async (path) => {
          if (path === resolvedPath) return ['SKILL.md'];
          throw new Error(`unexpected listing: ${path}`);
        },
        readBytes: async (path) => {
          if (path === `${resolvedPath}/SKILL.md` || path === `${placementPath}/SKILL.md`) {
            return new Uint8Array(sourceBytes);
          }
          throw new Error(`unexpected byte read: ${path}`);
        },
        isExecutable: async () => false,
      },
    });
    const before = await repository.observe('live:user:codex:alpha');
    expect(before.ok).toBeTrue();
    if (!before.ok) return;
    expect(before.value.value?.contentRevision).toMatch(/^sha256:[0-9a-f]{64}$/u);
    sourceBytes = new TextEncoder().encode('---\nname: alpha\n---\nversion two\n');

    const after = await repository.observe('live:user:codex:alpha');
    expect(after.ok).toBeTrue();
    if (!after.ok) return;
    expect(after.value.value?.contentRevision).not.toBe(before.value.value?.contentRevision);
    expect(after.value.revision.revisionDigest).not.toBe(before.value.revision.revisionDigest);
    expect(
      await repository.stage({
        schemaVersion: 1,
        operationId: 'operation:symlink-source-edit',
        domain: 'live',
        resourceId: 'live:user:codex:alpha',
        expectedRevision: before.value.revision,
        editDigest: digest('b'),
      }),
    ).toEqual({
      ok: false,
      error: {
        code: 'stale-revision',
        domain: 'live',
        resourceId: 'live:user:codex:alpha',
      },
    });
  });

  test('fails closed when a non-dangling symlink target is not a readable directory', async () => {
    const placementPath = '/fixture/live/alpha';
    const resolvedPath = '/fixture/dev/alpha';
    const observe = async (targetKind: 'file' | 'dir', unreadable: boolean) =>
      createLivePlacementRepository({
        resources: [
          {
            resourceId: 'live:user:codex:alpha',
            skill: 'alpha',
            tool: 'codex',
            scope: 'user',
            projectIdentity: null,
            placementPath,
            storeRoot: '/fixture/store',
          },
        ],
        ports: {
          pathKind: async (path) =>
            path === placementPath ? 'symlink' : path === resolvedPath ? targetKind : 'absent',
          readFileMetadata: async (path) => {
            if (path === placementPath) {
              return { kind: 'symlink', mode: 0o777, identity: 'link:alpha', linkCount: 1 };
            }
            if (path === resolvedPath) {
              return {
                kind: targetKind,
                mode: targetKind === 'dir' ? 0o755 : 0o644,
                identity: 'target:alpha',
                linkCount: 1,
              };
            }
            return { kind: 'dir', mode: 0o755, identity: `dir:${path}`, linkCount: 1 };
          },
          readLink: async () => '../dev/alpha',
          realpath: async () => resolvedPath,
          listDir: async () => {
            if (unreadable) throw Object.assign(new Error('denied'), { code: 'EACCES' });
            return [];
          },
          readBytes: async () => new Uint8Array(),
          isExecutable: async () => false,
        },
      }).observe('live:user:codex:alpha');

    expect(await observe('file', false)).toMatchObject({
      ok: false,
      error: { code: 'state-repository', domain: 'live', reason: 'observation-failed' },
    });
    expect(await observe('dir', true)).toMatchObject({
      ok: false,
      error: { code: 'state-repository', domain: 'live', reason: 'permission-denied' },
    });
  });

  test('preserves physical files and dangling links as neutral planning/status facts', async () => {
    const filePath = '/fixture/live/file-skill';
    const danglingPath = '/fixture/live/dangling';
    const repository = createLivePlacementRepository({
      resources: [
        {
          resourceId: 'live:user:codex:file-skill',
          skill: 'file-skill',
          tool: 'codex',
          scope: 'user',
          projectIdentity: null,
          placementPath: filePath,
          storeRoot: '/fixture/store',
        },
        {
          resourceId: 'live:user:codex:dangling',
          skill: 'dangling',
          tool: 'codex',
          scope: 'user',
          projectIdentity: null,
          placementPath: danglingPath,
          storeRoot: '/fixture/store',
        },
      ],
      ports: {
        pathKind: async (path) => {
          if (path === filePath) return 'file';
          if (path === danglingPath) return 'symlink';
          return 'absent';
        },
        readFileMetadata: async (path) => {
          if (path === filePath) {
            return { kind: 'file', mode: 0o644, identity: 'file:1', linkCount: 1 };
          }
          if (path === danglingPath) {
            return { kind: 'symlink', mode: 0o777, identity: 'link:2', linkCount: 1 };
          }
          return { kind: 'dir', mode: 0o755, identity: `dir:${path}`, linkCount: 1 };
        },
        readLink: async () => '../../dev/missing',
        realpath: async () => {
          throw new Error('dangling and wrong-kind resources have no realpath');
        },
        listDir: async () => [],
        readBytes: async (path) => {
          if (path === filePath) return new TextEncoder().encode('not a directory');
          throw new Error(`unexpected byte read: ${path}`);
        },
        isExecutable: async () => false,
      },
    });

    const file = await repository.observe('live:user:codex:file-skill');
    const dangling = await repository.observe('live:user:codex:dangling');

    expect(file.ok).toBeTrue();
    expect(dangling.ok).toBeTrue();
    if (!file.ok || !dangling.ok) return;
    expect(file.value.value).toMatchObject({
      representation: 'file',
      placementClass: 'absent',
      skillFile: 'invalid',
      brokenReason: 'wrong-node-kind',
      dangling: false,
    });
    expect(dangling.value.value).toMatchObject({
      representation: 'symlink',
      linkTarget: '../../dev/missing',
      realpath: null,
      placementClass: 'dev',
      skillFile: 'invalid',
      brokenReason: 'dangling-link',
      dangling: true,
    });
  });

  test('revision-binds absence to the observed parent identity', async () => {
    const placementPath = '/fixture/live/alpha';
    let parentLinkCount = 1;
    let parentMode = 0o755;
    let parentIdentity = 'parent:1';
    const repository = createLivePlacementRepository({
      resources: [
        {
          resourceId: 'live:user:codex:alpha',
          skill: 'alpha',
          tool: 'codex',
          scope: 'user',
          projectIdentity: null,
          placementPath,
          storeRoot: '/fixture/store',
        },
      ],
      ports: {
        pathKind: async () => 'absent',
        readFileMetadata: async (path) =>
          path === placementPath
            ? { kind: 'absent', mode: null, identity: null, linkCount: 0 }
            : {
                kind: 'dir',
                mode: parentMode,
                identity: parentIdentity,
                linkCount: parentLinkCount,
              },
        readLink: async () => '',
        realpath: async (path) => path,
        listDir: async () => [],
        readBytes: async () => new Uint8Array(),
        isExecutable: async () => false,
      },
    });

    const observed = await repository.observe('live:user:codex:alpha');

    expect(observed.ok).toBeTrue();
    if (!observed.ok) return;
    expect(observed.value.value).toBeNull();
    expect(observed.value.revision).toMatchObject({
      domain: 'live',
      state: 'absent',
      parentIdentity: '/fixture/live',
      parentKind: 'directory',
    });
    parentLinkCount += 1;
    expect(await repository.observeRevision('live:user:codex:alpha')).toEqual({
      ok: true,
      value: observed.value.revision,
    });
    parentMode = 0o750;
    const afterModeChange = await repository.observeRevision('live:user:codex:alpha');
    expect(afterModeChange).not.toEqual({ ok: true, value: observed.value.revision });
    parentMode = 0o755;
    parentIdentity = 'parent:2';
    const afterReplacement = await repository.observeRevision('live:user:codex:alpha');
    expect(afterReplacement).not.toEqual({ ok: true, value: observed.value.revision });
  });

  test('revision-binds an absent child to a followed symlink parent target', async () => {
    const placementPath = '/fixture/live-link/alpha';
    const parentPath = '/fixture/live-link';
    const followedTargetPath = '/fixture/targets/live';
    let followedTargetIdentity = 'target:1';
    const repository = createLivePlacementRepository({
      resources: [
        {
          resourceId: 'live:user:codex:alpha',
          skill: 'alpha',
          tool: 'codex',
          scope: 'user',
          projectIdentity: null,
          placementPath,
          storeRoot: '/fixture/store',
        },
      ],
      ports: {
        pathKind: async (path) => (path === placementPath ? 'absent' : 'dir'),
        readFileMetadata: async (path) => {
          if (path === parentPath) {
            return { kind: 'symlink', mode: 0o777, identity: 'parent-link:1', linkCount: 1 };
          }
          if (path === followedTargetPath) {
            return {
              kind: 'dir',
              mode: 0o755,
              identity: followedTargetIdentity,
              linkCount: 1,
            };
          }
          return { kind: 'absent', mode: null, identity: null, linkCount: 0 };
        },
        readLink: async (path) => {
          if (path !== parentPath) throw new Error(`unexpected readlink: ${path}`);
          return 'targets/live';
        },
        realpath: async (path) => {
          if (path !== parentPath) throw new Error(`unexpected realpath: ${path}`);
          return followedTargetPath;
        },
        listDir: async () => [],
        readBytes: async () => new Uint8Array(),
        isExecutable: async () => false,
      },
    });
    const before = await repository.observe('live:user:codex:alpha');
    expect(before.ok).toBeTrue();
    if (!before.ok) return;
    expect(before.value.value).toBeNull();
    expect(before.value.revision).toMatchObject({
      state: 'absent',
      parentIdentity: parentPath,
      parentKind: 'directory',
    });

    followedTargetIdentity = 'target:2';
    const after = await repository.observeRevision('live:user:codex:alpha');
    expect(after.ok).toBeTrue();
    if (!after.ok) return;
    expect(after.value.revisionDigest).not.toBe(before.value.revision.revisionDigest);
    expect(
      await repository.stage({
        schemaVersion: 1,
        operationId: 'operation:symlink-parent-replaced',
        domain: 'live',
        resourceId: 'live:user:codex:alpha',
        expectedRevision: before.value.revision,
        editDigest: digest('c'),
      }),
    ).toEqual({
      ok: false,
      error: {
        code: 'stale-revision',
        domain: 'live',
        resourceId: 'live:user:codex:alpha',
      },
    });
  });

  test('observes an absent child under a non-directory parent and binds that conflict', async () => {
    const placementPath = '/fixture/live/alpha';
    let parentIdentity = 'parent-file:1';
    const repository = createLivePlacementRepository({
      resources: [
        {
          resourceId: 'live:user:codex:alpha',
          skill: 'alpha',
          tool: 'codex',
          scope: 'user',
          projectIdentity: null,
          placementPath,
          storeRoot: '/fixture/store',
        },
      ],
      ports: {
        pathKind: async () => {
          throw Object.assign(new Error('non-directory parent'), { code: 'ENOTDIR' });
        },
        readFileMetadata: async (path) => {
          if (path === placementPath) {
            throw Object.assign(new Error('non-directory parent'), { code: 'ENOTDIR' });
          }
          return { kind: 'file', mode: 0o644, identity: parentIdentity, linkCount: 1 };
        },
        readLink: async () => '',
        realpath: async (path) => path,
        listDir: async () => [],
        readBytes: async () => new Uint8Array(),
        isExecutable: async () => false,
      },
    });

    const observed = await repository.observe('live:user:codex:alpha');

    expect(observed.ok).toBeTrue();
    if (!observed.ok) return;
    expect(observed.value.value).toBeNull();
    expect(observed.value.revision).toMatchObject({
      domain: 'live',
      state: 'absent',
      parentIdentity: '/fixture/live',
      parentKind: 'absent',
    });
    parentIdentity = 'parent-file:2';
    expect(await repository.observeRevision('live:user:codex:alpha')).not.toEqual({
      ok: true,
      value: observed.value.revision,
    });
  });

  test('reobserves the live parent before staging and rejects a forged caller revision', async () => {
    const placementPath = '/fixture/live/alpha';
    let parentIdentity = 'parent:1';
    const repository = createLivePlacementRepository({
      resources: [
        {
          resourceId: 'live:user:codex:alpha',
          skill: 'alpha',
          tool: 'codex',
          scope: 'user',
          projectIdentity: null,
          placementPath,
          storeRoot: '/fixture/store',
        },
      ],
      ports: {
        pathKind: async () => 'absent',
        readFileMetadata: async (path) =>
          path === placementPath
            ? { kind: 'absent', mode: null, identity: null, linkCount: 0 }
            : { kind: 'dir', mode: 0o755, identity: parentIdentity, linkCount: 1 },
        readLink: async () => '',
        realpath: async (path) => path,
        listDir: async () => [],
        readBytes: async () => new Uint8Array(),
        isExecutable: async () => false,
      },
    });
    const expected = await repository.observeRevision('live:user:codex:alpha');
    expect(expected.ok).toBeTrue();
    if (!expected.ok) return;
    parentIdentity = 'parent:2';

    const staged = await repository.stage({
      schemaVersion: 1,
      operationId: 'operation:fixture',
      domain: 'live',
      resourceId: 'live:user:codex:alpha',
      expectedRevision: expected.value,
      editDigest: digest('a'),
      observedRevision: expected.value,
    } as never);

    expect(staged).toEqual({
      ok: false,
      error: {
        code: 'stale-revision',
        domain: 'live',
        resourceId: 'live:user:codex:alpha',
      },
    });
  });

  test('fails closed for unknown resources and duplicate descriptor configuration', async () => {
    const ports = {
      pathKind: async () => 'absent' as const,
      readFileMetadata: async () => ({
        kind: 'absent' as const,
        mode: null,
        identity: null,
        linkCount: 0,
      }),
      readLink: async () => '',
      realpath: async (path: string) => path,
      listDir: async () => [],
      readBytes: async () => new Uint8Array(),
      isExecutable: async () => false,
    };
    for (const resources of [
      [
        {
          resourceId: 'live:user:codex:alpha',
          skill: 'alpha',
          tool: 'codex',
          scope: 'user' as const,
          projectIdentity: null,
          placementPath: '/fixture/live/alpha',
          storeRoot: '/fixture/store',
        },
        {
          resourceId: 'live:user:codex:alpha',
          skill: 'beta',
          tool: 'codex',
          scope: 'user' as const,
          projectIdentity: null,
          placementPath: '/fixture/live/beta',
          storeRoot: '/fixture/store',
        },
      ],
      [
        {
          resourceId: 'live:user:codex:alpha',
          skill: 'alpha',
          tool: 'codex',
          scope: 'user' as const,
          projectIdentity: null,
          placementPath: '/fixture/live/alpha',
          storeRoot: '/fixture/store',
        },
        {
          resourceId: 'live:user:codex:beta',
          skill: 'beta',
          tool: 'codex',
          scope: 'user' as const,
          projectIdentity: null,
          placementPath: '/fixture/live/../live/alpha',
          storeRoot: '/fixture/store',
        },
      ],
    ]) {
      const duplicate = createLivePlacementRepository({ resources, ports });
      expect(await duplicate.observe('live:user:codex:alpha')).toEqual({
        ok: false,
        error: {
          code: 'state-repository',
          domain: 'live',
          reason: 'invalid-request',
        },
      });
    }
    const valid = createLivePlacementRepository({
      resources: [
        {
          resourceId: 'live:user:codex:alpha',
          skill: 'alpha',
          tool: 'codex',
          scope: 'user',
          projectIdentity: null,
          placementPath: '/fixture/live/alpha',
          storeRoot: '/fixture/store',
        },
      ],
      ports,
    });
    expect(await valid.observe('live:user:codex:missing')).toMatchObject({
      ok: false,
      error: { code: 'state-repository', domain: 'live', reason: 'invalid-request' },
    });
  });
});
