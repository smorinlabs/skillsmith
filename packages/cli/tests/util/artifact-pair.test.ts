import { describe, expect, test } from 'bun:test';
import { resolveArtifactPair } from '../../src/util/artifact-pair.ts';

describe('resolveArtifactPair', () => {
  test('returns no explicit pair when neither selector is present', () => {
    expect(resolveArtifactPair({ effectiveCwd: '/work/repo' })).toEqual({
      ok: true,
      value: { file: null, lockfile: null, lockfileSource: null },
    });
  });

  test('resolves a file from effective cwd and derives its sibling lock', () => {
    expect(
      resolveArtifactPair({ effectiveCwd: '/work/repo/packages/api', file: '../team.toml' }),
    ).toEqual({
      ok: true,
      value: {
        file: '/work/repo/packages/team.toml',
        lockfile: '/work/repo/packages/team.lock',
        lockfileSource: 'sibling',
      },
    });
  });

  test('resolves an explicit lock from effective cwd without rebasing it from the file', () => {
    expect(
      resolveArtifactPair({
        effectiveCwd: '/work/repo/packages/api',
        file: '../../state/team.toml',
        lockfile: './locks/team.custom',
      }),
    ).toEqual({
      ok: true,
      value: {
        file: '/work/repo/state/team.toml',
        lockfile: '/work/repo/packages/api/locks/team.custom',
        lockfileSource: 'explicit',
      },
    });
  });

  test('rejects a lock selector without a file selector', () => {
    expect(resolveArtifactPair({ effectiveCwd: '/work/repo', lockfile: './team.lock' })).toEqual({
      ok: false,
      error: {
        code: 'usage',
        exitCode: 2,
        message: '--lockfile requires --file',
      },
    });
  });
});
