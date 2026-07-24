import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
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

  test('normalizes real lock contention to the closed conflict code', async () => {
    const ports = await defaultRuntimePorts();
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-lock-contention-'));
    const target = join(root, 'state');
    let invoked = false;
    try {
      await ports.withFileLock(target, async () => {
        await expect(
          ports.withFileLock(target, async () => {
            invoked = true;
          }),
        ).rejects.toMatchObject({
          capability: 'lock',
          operation: 'withFileLock',
          code: 'conflict',
        });
      });
      expect(invoked).toBeFalse();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects a pre-aborted lock request without invoking the callback', async () => {
    const ports = await defaultRuntimePorts();
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-lock-cancelled-'));
    const target = join(root, 'placements.json');
    const controller = new AbortController();
    controller.abort();
    let invoked = false;
    const withFileLock = ports.withFileLock as unknown as <T>(
      path: string,
      operation: () => Promise<T>,
      options?: Readonly<{ signal?: AbortSignal }>,
    ) => Promise<T>;
    try {
      await expect(
        withFileLock(
          target,
          async () => {
            invoked = true;
          },
          { signal: controller.signal },
        ),
      ).rejects.toMatchObject({
        capability: 'lock',
        operation: 'withFileLock',
        code: 'cancelled',
      });
      expect(invoked).toBeFalse();
      expect(await ports.pathKind(target)).toBe('absent');
      expect(await ports.pathKind(`${target}.lock`)).toBe('absent');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('reads stable regular-file metadata and applies focused permission bits', async () => {
    const ports = await defaultRuntimePorts();
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-config-metadata-'));
    const file = join(root, 'config.toml');
    try {
      await writeFile(file, 'tool = "codex"\n');
      await chmod(file, 0o600);
      const before = await ports.readFileMetadata(file);
      expect(before).toMatchObject({
        kind: 'file',
        mode: 0o600,
        uid: ports.effectiveUserIdentity().uid,
        gid: ports.effectiveUserIdentity().gid,
      });
      expect(before.identity).toBeString();
      await ports.setFileMode(file, 0o640);
      expect((await stat(file)).mode & 0o777).toBe(0o640);
      expect((await ports.readFileMetadata(file)).identity).toBe(before.identity);
      expect(await ports.readFileMetadata(join(root, 'absent'))).toEqual({
        kind: 'absent',
        mode: null,
        identity: null,
        linkCount: 0,
        uid: null,
        gid: null,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('creates private directories and text files exclusively with initial modes', async () => {
    const ports = await defaultRuntimePorts();
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-private-state-'));
    const directory = join(root, 'recovery');
    const file = join(directory, 'record.json');
    try {
      expect(ports.effectiveUserIdentity()).toMatchObject({
        uid: process.geteuid?.() ?? process.getuid?.() ?? null,
        gid: process.getegid?.() ?? process.getgid?.() ?? null,
      });
      await ports.makeDirExclusive(directory, 0o700);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      await expect(ports.makeDirExclusive(directory, 0o700)).rejects.toMatchObject({
        operation: 'makeDirExclusive',
        code: 'conflict',
      });
      await ports.writeTextFileExclusive(file, '{"revision":1}\n', 0o600);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(await readFile(file, 'utf8')).toBe('{"revision":1}\n');
      await expect(ports.writeTextFileExclusive(file, 'clobbered', 0o600)).rejects.toMatchObject({
        operation: 'writeTextFileExclusive',
        code: 'conflict',
      });
      expect(await readFile(file, 'utf8')).toBe('{"revision":1}\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('classifies FIFOs, sockets, and devices as other metadata rather than regular files', async () => {
    if (process.platform === 'win32') return;
    const ports = await defaultRuntimePorts();
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-special-metadata-'));
    const fifo = join(root, 'config.fifo');
    const socket = join(root, 'config.socket');
    const server = createServer();
    try {
      const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
      expect(created.status, created.stderr).toBe(0);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socket, resolve);
      });
      expect(await ports.readFileMetadata(fifo)).toMatchObject({ kind: 'other' });
      expect(await ports.readFileMetadata(socket)).toMatchObject({ kind: 'other' });
      expect(await ports.readFileMetadata('/dev/null')).toMatchObject({ kind: 'other' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
