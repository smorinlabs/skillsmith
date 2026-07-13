import { describe, expect, test } from 'bun:test';
import { PORT_ERROR_CODES, type PlatformPaths, isPortError, portError } from '../../src/index.ts';

describe('capability port contracts', () => {
  test('PlatformPaths uses the executable search path without the ScanEnv alias', () => {
    const paths = {
      homeDir: '/home/test',
      executableSearchPath: ['/bin', '/usr/bin'],
      platform: 'linux',
      xdg: { config: '/config', data: '/data', cache: '/cache' },
    } as const satisfies PlatformPaths;

    expect(paths.executableSearchPath).toEqual(['/bin', '/usr/bin']);
    expect(paths).not.toHaveProperty('path');
  });

  test('PortError is a frozen scalar-only value without a cause', () => {
    const failure = portError({
      capability: 'file-read',
      operation: 'readText',
      code: 'not-found',
      message: 'file is not available',
      context: { path: '/missing', retryable: false, attempt: 1, detail: null },
    });

    expect(PORT_ERROR_CODES).toHaveLength(8);
    expect(isPortError(failure)).toBeTrue();
    expect(Object.isFrozen(failure)).toBeTrue();
    expect(Object.isFrozen(failure.context)).toBeTrue();
    expect(failure).not.toHaveProperty('cause');
    expect(isPortError({ ...failure, stack: 'leaked stack' })).toBeFalse();
    expect(
      isPortError(
        Object.assign(Object.create(failure), {
          unrelated1: 1,
          unrelated2: 2,
          unrelated3: 3,
          unrelated4: 4,
          unrelated5: 5,
        }),
      ),
    ).toBeFalse();
  });
});
