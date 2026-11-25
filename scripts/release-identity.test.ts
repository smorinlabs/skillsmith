import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  checkReleaseIdentity,
  parseBunLock,
  readLockWorkspaceVersions,
  syncLockWorkspaceVersions,
} from './release-identity';

const ROOT = resolve(import.meta.dir, '..');
const source = (path: string): Promise<string> => readFile(resolve(ROOT, path), 'utf8');

const LOCK = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "skillsmith-workspace",
      "devDependencies": {
        "lefthook": "1.13.6",
      },
    },
    "packages/cli": {
      "name": "skillsmith",
      "version": "0.8.0",
      "bin": {
        "skillsmith": "./src/index.ts",
      },
    },
    "packages/core": {
      "name": "@skillsmith/core",
      "version": "0.8.0",
      "dependencies": {
        "trailing": "a, }",
      },
    },
  },
  "packages": {
    "x": ["x@1.0.0", "", {}, "sha512-,]"],
  },
}
`;

describe('release identity', () => {
  test('parses bun.lock text with trailing commas without touching string contents', () => {
    const lock = parseBunLock(LOCK) as {
      workspaces: Record<string, { dependencies?: Record<string, string> }>;
      packages: Record<string, unknown[]>;
    };
    expect(lock.workspaces['packages/core']?.dependencies?.trailing).toBe('a, }');
    expect(lock.packages.x?.[3]).toBe('sha512-,]');
    expect(readLockWorkspaceVersions(LOCK)).toEqual({ cli: '0.8.0', core: '0.8.0' });
  });

  test('rejects malformed lock text and missing workspace versions', () => {
    expect(() => parseBunLock('{"a": [1,,]}')).toThrow();
    expect(() => parseBunLock('{"a": 1')).toThrow();
    expect(() => readLockWorkspaceVersions('{"workspaces": {"packages/cli": {}}}')).toThrow();
  });

  test('syncs exactly the two workspace version values', () => {
    const synced = syncLockWorkspaceVersions(LOCK, '1.0.0');
    expect(readLockWorkspaceVersions(synced)).toEqual({ cli: '1.0.0', core: '1.0.0' });
    const changed = LOCK.split('\n').filter((line, index) => synced.split('\n')[index] !== line);
    expect(changed).toEqual(['      "version": "0.8.0",', '      "version": "0.8.0",']);
    expect(syncLockWorkspaceVersions(synced, '1.0.0')).toBe(synced);
  });

  test('the identity check names every manifest that disagrees', () => {
    const files = {
      manifest: '{".": "1.0.0"}',
      packages: ['{"version": "1.0.0"}', '{"version": "1.0.0"}', '{"version": "1.0.0"}'],
      lock: LOCK,
    };
    expect(() => checkReleaseIdentity('1.0.0', files)).toThrow(/bun\.lock packages\/cli 0\.8\.0/u);
    expect(() =>
      checkReleaseIdentity('1.0.0', { ...files, lock: syncLockWorkspaceVersions(LOCK, '1.0.0') }),
    ).not.toThrow();
    expect(() =>
      checkReleaseIdentity('1.0.0', {
        ...files,
        lock: syncLockWorkspaceVersions(LOCK, '1.0.0'),
        manifest: '{".": "0.8.0"}',
      }),
    ).toThrow(/release-please manifest 0\.8\.0/u);
  });

  test('the committed lock, manifest, and package versions agree', async () => {
    const [manifest, root, cli, core, lock] = await Promise.all([
      source('.release-please-manifest.json'),
      source('package.json'),
      source('packages/cli/package.json'),
      source('packages/core/package.json'),
      source('bun.lock'),
    ]);
    const version = (JSON.parse(manifest) as Record<string, string>)['.'] ?? '';
    expect(() =>
      checkReleaseIdentity(version, { manifest, packages: [root, cli, core], lock }),
    ).not.toThrow();
  });
});
