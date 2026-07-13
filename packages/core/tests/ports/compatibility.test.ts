import { describe, expect, test } from 'bun:test';
import { defaultScanEnv } from '../../src/env/default.ts';
import { runtimePortsFromScanEnv, scanEnvFromRuntimePorts } from '../../src/ports/compatibility.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';

describe('ScanEnv compatibility', () => {
  test('projects legacy path and methods into focused ports with injected clock and ID', async () => {
    const legacy = await defaultScanEnv();
    const focused = runtimePortsFromScanEnv(legacy, {
      clock: {
        wallNowIso: () => '2026-07-12T00:00:00.000Z',
        epochMilliseconds: () => 1,
        monotonicMilliseconds: () => 2,
      },
      id: { nextId: (purpose) => `${purpose}-fixture` },
    });

    expect(focused.executableSearchPath).toEqual(legacy.path);
    expect(focused.wallNowIso()).toBe('2026-07-12T00:00:00.000Z');
    expect(focused.monotonicMilliseconds()).toBe(2);
    expect(focused.nextId('tx')).toBe('tx-fixture');
    expect(focused).not.toHaveProperty('git');
    expect(focused).not.toHaveProperty('http');
    await expect(focused.assertWritableDirectory('/state')).rejects.toMatchObject({
      capability: 'path-access',
      operation: 'assertWritableDirectory',
      code: 'unavailable',
    });
    expect(await focused.readFileMetadata('/definitely/missing')).toEqual({
      kind: 'absent',
      mode: null,
      identity: null,
    });
    await expect(focused.setFileMode('/state', 0o600)).rejects.toMatchObject({
      capability: 'file-write',
      operation: 'setFileMode',
      code: 'unavailable',
    });
  });

  test('defaultScanEnv is the legacy projection of the same real adapter shape', async () => {
    const ports = await defaultRuntimePorts();
    const legacy = scanEnvFromRuntimePorts(ports);
    expect(legacy.homeDir).toBe(ports.homeDir);
    expect(legacy.path).toEqual(ports.executableSearchPath);
    expect(await legacy.fileExists('/definitely/missing/p17')).toBeFalse();
  });
});
