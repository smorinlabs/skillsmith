import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultRuntimePorts, defaultScanEnv, isPortError } from '../../src/index.ts';
import { runGit } from '../fixtures/git-env.ts';
import { runtimePorts as fixtureRuntimePorts } from '../fixtures/runtime-ports.ts';

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
    expect(ports.nextId('acquisition-transaction')).toMatch(/^[0-9a-f]{8}$/);
    expect(ports.nextId('placement-transaction')).toMatch(/^[0-9a-f]{8}$/);
  });

  test('compatibility fixtures preserve transaction ID shape without weakening temp IDs', async () => {
    const ports = fixtureRuntimePorts(await defaultScanEnv());
    expect(ports.nextId('acquisition-transaction')).toMatch(/^[0-9a-f]{8}$/);
    expect(ports.nextId('placement-transaction')).toMatch(/^[0-9a-f]{8}$/);
    expect(ports.nextId('config-save')).toMatch(/^config-save-\d+$/);
  });

  test('the real Git adapter reads invalid UTF-8 blobs byte-for-byte', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'skillsmith-p17-git-bytes-'));
    const expected = new Uint8Array([0xff, 0x00, 0xfe, 0x80]);
    try {
      runGit(repository, ['init', '-q']);
      await writeFile(join(repository, 'binary.dat'), expected);
      runGit(repository, ['add', 'binary.dat']);
      runGit(repository, [
        '-c',
        'user.name=Skillsmith Test',
        '-c',
        'user.email=test@skillsmith.invalid',
        'commit',
        '-qm',
        'binary fixture',
      ]);

      const ports = await defaultRuntimePorts();
      expect(
        await ports.git.readBlob({ repositoryRoot: repository, ref: 'HEAD', path: 'binary.dat' }),
      ).toEqual(expected);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
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

  test('rejects in-flight parent abort as a truthful cancelled process failure', async () => {
    const ports = await defaultRuntimePorts();
    const controller = new AbortController();
    const pending = ports.exec(process.execPath, ['-e', 'await Bun.sleep(10_000)'], {
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      capability: 'process',
      operation: 'exec',
      code: 'cancelled',
    });
  });

  test('propagates a locked callback failure without adapting its identity or shape', async () => {
    const ports = await defaultRuntimePorts();
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-lock-callback-'));
    const callbackFailure = { code: 'domain-callback-failure' };
    let received: unknown;
    try {
      await ports.withFileLock(join(root, 'state'), async () => {
        throw callbackFailure;
      });
    } catch (error) {
      received = error;
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    expect(received).toBe(callbackFailure);
    expect(isPortError(received)).toBeFalse();
  });
});
