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

  test('delegates exact collision and selector validation to core lexical authority', () => {
    for (const options of [
      { effectiveCwd: '/work/repo', file: './team.toml', lockfile: 'state/../team.toml' },
      { effectiveCwd: '/work/repo', file: './team.lock' },
    ]) {
      expect(resolveArtifactPair(options)).toEqual({
        ok: false,
        error: {
          code: 'usage',
          exitCode: 2,
          message: 'artifact manifest and lockfile resolve to the same path',
        },
      });
    }

    for (const file of ['C:state/team.toml', 'state\\team.toml']) {
      expect(resolveArtifactPair({ effectiveCwd: '/work/repo', file })).toMatchObject({
        ok: false,
        error: {
          code: 'usage',
          exitCode: 2,
          message: expect.stringContaining('foreign absolute-path form'),
        },
      });
    }
    expect(resolveArtifactPair({ effectiveCwd: '/work/repo', file: 'team\u0001.toml' })).toEqual({
      ok: false,
      error: {
        code: 'usage',
        exitCode: 2,
        message: 'artifact file selector is empty or invalid',
      },
    });
  });
});
