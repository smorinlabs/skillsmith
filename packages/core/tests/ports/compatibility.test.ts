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
    expect(focused.effectiveUserIdentity()).toEqual({ uid: null, gid: null });
    await expect(focused.makeDirExclusive('/state', 0o700)).rejects.toMatchObject({
      capability: 'file-write',
      operation: 'makeDirExclusive',
      code: 'unavailable',
    });
    await expect(
      focused.writeTextFileExclusive('/state/record', '{}', 0o600),
    ).rejects.toMatchObject({
      capability: 'file-write',
      operation: 'writeTextFileExclusive',
      code: 'unavailable',
    });
    await expect(focused.setFileMode('/state', 0o600)).rejects.toMatchObject({
      capability: 'file-write',
      operation: 'setFileMode',
      code: 'unavailable',
    });
  });

  test('projects an explicit private-state supplement without emulating exclusivity', async () => {
    const legacy = await defaultScanEnv();
    const calls: string[] = [];
    const focused = runtimePortsFromScanEnv(legacy, {
      clock: {
        wallNowIso: () => '2026-07-12T00:00:00.000Z',
        epochMilliseconds: () => 1,
        monotonicMilliseconds: () => 2,
      },
      id: { nextId: (purpose) => `${purpose}-fixture` },
      privateState: {
        effectiveUserIdentity: () => ({ uid: 1000, gid: 100 }),
        makeDirExclusive: async (path, mode) => {
          calls.push(`dir:${path}:${mode.toString(8)}`);
        },
        writeTextFileExclusive: async (path, text, mode) => {
          calls.push(`file:${path}:${mode.toString(8)}:${text}`);
        },
      },
    });
    expect(focused.effectiveUserIdentity()).toEqual({ uid: 1000, gid: 100 });
    await focused.makeDirExclusive('/recovery', 0o700);
    await focused.writeTextFileExclusive('/recovery/record', '{}', 0o600);
    expect(calls).toEqual(['dir:/recovery:700', 'file:/recovery/record:600:{}']);
  });

  test('defaultScanEnv is the legacy projection of the same real adapter shape', async () => {
    const ports = await defaultRuntimePorts();
    const legacy = scanEnvFromRuntimePorts(ports);
    expect(legacy.homeDir).toBe(ports.homeDir);
    expect(legacy.path).toEqual(ports.executableSearchPath);
    expect(await legacy.fileExists('/definitely/missing/p17')).toBeFalse();
  });
});
