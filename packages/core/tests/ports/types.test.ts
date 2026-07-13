import { describe, expect, test } from 'bun:test';
import { PORT_ERROR_CODES, type PlatformPaths, isPortError, portError } from '../../src/index.ts';
import type {
  FileMetadataReadPort,
  FileModeWritePort,
  FileReadPort,
  FileWritePort,
} from '../../src/ports/types.ts';

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

  test('metadata and mode remain focused capabilities outside broad read/write ports', async () => {
    type HasMetadata = 'readFileMetadata' extends keyof FileReadPort ? true : false;
    type HasMode = 'setFileMode' extends keyof FileWritePort ? true : false;
    const broadReadHasMetadata: HasMetadata = false;
    const broadWriteHasMode: HasMode = false;
    const metadata: FileMetadataReadPort['readFileMetadata'] = async () => ({
      kind: 'file',
      mode: 0o600,
      identity: '1:2',
    });
    const setMode: FileModeWritePort['setFileMode'] = async () => {};
    expect(broadReadHasMetadata).toBeFalse();
    expect(broadWriteHasMode).toBeFalse();
    expect(await metadata('/config')).toEqual({ kind: 'file', mode: 0o600, identity: '1:2' });
    const special: Awaited<ReturnType<FileMetadataReadPort['readFileMetadata']>> = {
      kind: 'other',
      mode: 0o600,
      identity: '3:4',
    };
    expect(special.kind).toBe('other');
    expect(setMode).toBeFunction();
  });
});
