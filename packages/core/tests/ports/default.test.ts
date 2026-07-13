import { describe, expect, test } from 'bun:test';
import { defaultRuntimePorts, isPortError } from '../../src/index.ts';

describe('defaultRuntimePorts', () => {
  test('composes platform, focused effects, deterministic sources, Git, and HTTP', async () => {
    const ports = await defaultRuntimePorts();
    expect(ports.homeDir.length).toBeGreaterThan(0);
    expect(ports.executableSearchPath).toBeArray();
    expect(ports.readText).toBeFunction();
    expect(ports.exec).toBeFunction();
    expect(ports.git.readBlob).toBeFunction();
    expect(ports.http.request).toBeFunction();
    expect(ports.wallNowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(ports.nextId('test')).toMatch(/^test-[0-9a-f]{16}$/);
  });

  test('rejects filesystem and process failures as safe PortError values', async () => {
    const ports = await defaultRuntimePorts();
    for (const operation of [
      () => ports.readText('/definitely/missing/p17-default-port'),
      () => ports.exec('/definitely/missing/p17-default-command', []),
    ]) {
      let failure: unknown;
      try {
        await operation();
      } catch (error) {
        failure = error;
      }
      expect(isPortError(failure)).toBeTrue();
      expect(failure).not.toHaveProperty('cause');
    }

    let accessFailure: unknown;
    try {
      await ports.assertWritableDirectory('/definitely/missing/p17-access');
    } catch (error) {
      accessFailure = error;
    }
    expect(accessFailure).toMatchObject({
      capability: 'path-access',
      operation: 'assertWritableDirectory',
      context: { path: '/definitely/missing/p17-access' },
    });
    expect(
      accessFailure !== null &&
        typeof accessFailure === 'object' &&
        'context' in accessFailure &&
        accessFailure.context !== null &&
        typeof accessFailure.context === 'object' &&
        'uid' in accessFailure.context &&
        (typeof accessFailure.context.uid === 'number' || accessFailure.context.uid === null),
    ).toBeTrue();
    expect(accessFailure).not.toHaveProperty('cause');
  });
});
