import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createNodeArtifactCoordinatorPorts,
  createTestNodeArtifactCoordinatorPorts,
} from '../../src/artifacts/node-coordinator.ts';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe('Node artifact coordinator adapter', () => {
  test('creates durable marker-owned transaction directories and no-replace links', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-node-coordinator-'));
    roots.push(root);
    const ports = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const transaction = join(root, '.skillsmith-artifact-0000000000000001');
    const token = 'a'.repeat(64);
    const created = await ports.createTransactionDirectoryExclusive(transaction, token);
    expect(created.identity.length).toBeGreaterThan(0);
    expect(await readFile(join(transaction, 'owner'), 'utf8')).toBe(`${token}\n`);

    const stage = join(transaction, 'manifest.stage');
    const live = join(root, 'skillsmith.toml');
    await ports.writeBytesExclusive(stage, new TextEncoder().encode('version = 1\n'), 0o600);
    await ports.linkFileNoReplace(stage, live);
    await expect(ports.linkFileNoReplace(stage, live)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await ports.readBytes(live)).toEqual(new TextEncoder().encode('version = 1\n'));
  });

  test('atomically moves live bytes and never unlinks a writer that arrives after the move', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-node-atomic-move-'));
    roots.push(root);
    const transaction = join(root, '.skillsmith-artifact-0000000000000001');
    const source = join(root, 'skillsmith.toml');
    const destination = join(transaction, 'manifest.backup');
    const original = new TextEncoder().encode('tool = "original"\n');
    const external = new TextEncoder().encode('tool = "external"\n');
    await writeFile(source, original);
    const ports = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'), {
      afterPhysicalStep: async (step) => {
        if (step.area === 'move' && step.step === 'atomic-renamed') {
          await writeFile(source, external);
        }
      },
    });
    await ports.createTransactionDirectoryExclusive(transaction, 'a'.repeat(64));

    await ports.moveIntoOwnedTransaction(source, destination);

    expect(await ports.readBytes(destination)).toEqual(original);
    expect(await ports.readBytes(source)).toEqual(external);
  });

  test('awaits closed transaction and stage physical-step hooks in syscall order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-node-physical-'));
    roots.push(root);
    const steps: string[] = [];
    const ports = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'), {
      afterPhysicalStep: async ({ area, step }) => {
        if (area !== 'recovery') steps.push(`${area}:${step}`);
      },
    });
    const transaction = join(root, '.skillsmith-artifact-0000000000000001');
    await ports.createTransactionDirectoryExclusive(transaction, 'a'.repeat(64));
    await ports.writeBytesExclusive(
      join(transaction, 'manifest.stage'),
      new TextEncoder().encode('version = 1\n'),
      0o600,
    );

    expect(steps).toEqual([
      'transaction:directory-created',
      'transaction:owner-opened',
      'transaction:owner-written',
      'transaction:owner-fsynced',
      'transaction:directory-fsynced',
      'transaction:parent-fsynced',
      'stage:file-opened',
      'stage:bytes-written',
      'stage:file-closed',
    ]);
  });

  test('holds central and compatibility locks and removes private member markers on release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-node-lock-'));
    roots.push(root);
    const order: string[] = [];
    const ports = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'), {
      failBeforeMarkerRemoval: () => order.push('marker-remove'),
      failAfterLockRelease: () => order.push('physical-release'),
    });
    const target = join(root, 'artifact.toml');
    await ports.withFileLock(
      target,
      {
        policy: 'compatibility',
        centralOperationId: '0000000000000001',
        retryDelaysMs: [0],
      },
      async () => expect((await ports.observe(`${target}.lock`)).kind).toBe('directory'),
    );
    expect(order).toEqual(['marker-remove', 'physical-release']);
    expect((await ports.observe(`${target}.lock`)).kind).toBe('absent');
  });

  test('maps non-contention lock acquisition I/O failures to filesystem failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-node-lock-io-'));
    roots.push(root);
    const ports = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    const target = join(root, 'missing-parent', 'artifact.toml');

    await expect(
      ports.withFileLock(
        target,
        {
          policy: 'central',
          centralOperationId: '0000000000000001',
          retryDelaysMs: [0, 0],
        },
        async () => undefined,
      ),
    ).rejects.toMatchObject({ reason: 'filesystem-failure' });
  });

  test('always releases the physical lock and surfaces release or marker cleanup failure', async () => {
    for (const fault of ['release', 'marker'] as const) {
      const root = await mkdtemp(join(tmpdir(), `skillsmith-node-lock-${fault}-`));
      roots.push(root);
      let enabled = true;
      const ports = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'), {
        ...(fault === 'release'
          ? {
              failAfterLockRelease: () => {
                if (enabled) throw new Error('release fault');
              },
            }
          : {
              failBeforeMarkerRemoval: () => {
                if (enabled) throw new Error('marker fault');
              },
            }),
      });
      const target = join(root, 'artifact.toml');
      await expect(
        ports.withFileLock(
          target,
          {
            policy: 'compatibility',
            centralOperationId: '0000000000000001',
            retryDelaysMs: [0],
          },
          async () => undefined,
        ),
      ).rejects.toBeDefined();
      expect((await ports.observe(`${target}.lock`)).kind, fault).toBe('absent');

      enabled = false;
      await ports.withFileLock(
        target,
        {
          policy: 'compatibility',
          centralOperationId: '0000000000000002',
          retryDelaysMs: [0],
        },
        async () => undefined,
      );
      expect((await ports.observe(`${target}.lock`)).kind, fault).toBe('absent');
    }
  });

  test('refuses a symlink component in the private coordination root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-node-symlink-'));
    roots.push(root);
    const real = join(root, 'real');
    const alias = join(root, 'alias');
    await mkdir(real);
    await symlink(real, alias, 'dir');
    await expect(
      createTestNodeArtifactCoordinatorPorts(join(alias, 'coordination')),
    ).rejects.toMatchObject({ reason: 'permission-denied' });
  });

  test('pins the recovery directory identity and refuses post-construction retargeting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-node-recovery-retarget-'));
    roots.push(root);
    const coordination = join(root, 'coordination');
    const ports = await createTestNodeArtifactCoordinatorPorts(coordination);
    const recovery = join(coordination, 'recovery');
    const original = join(coordination, 'recovery-original');
    const outside = join(root, 'outside');
    await mkdir(outside);
    await rename(recovery, original);
    await symlink(outside, recovery, 'dir');

    await expect(ports.recovery.discover()).rejects.toMatchObject({
      reason: 'recovery-record-invalid',
    });
    expect(await readdir(outside)).toEqual([]);
  });

  test('derives one POSIX account root independently of HOME and every XDG variable', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-node-account-root-'));
    roots.push(root);
    const names = [
      'HOME',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_CACHE_HOME',
      'XDG_STATE_HOME',
      'XDG_RUNTIME_DIR',
    ] as const;
    const saved = new Map(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) process.env[name] = join(root, 'first', name);
      const first = await createNodeArtifactCoordinatorPorts();
      expect(process.env.HOME).toBe(join(root, 'first', 'HOME'));
      for (const name of names) process.env[name] = join(root, 'second', name);
      const second = await createNodeArtifactCoordinatorPorts();
      expect(process.env.HOME).toBe(join(root, 'second', 'HOME'));
      expect(first.coordinationRoot).toBe(second.coordinationRoot);
      expect(first.coordinationRoot.startsWith(root)).toBeFalse();
      expect(await readdir(root)).toEqual([]);
    } finally {
      for (const name of names) {
        const value = saved.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test('ignores account environment that was already spoofed when Bun started', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-node-startup-home-'));
    roots.push(root);
    const moduleUrl = new URL('../../src/artifacts/node-coordinator.ts', import.meta.url).href;
    const child = spawnSync(
      process.execPath,
      [
        '--eval',
        `const module = await import(${JSON.stringify(moduleUrl)}); const ports = await module.createNodeArtifactCoordinatorPorts(); process.stdout.write(ports.coordinationRoot);`,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: root,
          LOGNAME: 'p17-spoofed-account',
          SHELL: join(root, 'shell'),
          USER: 'p17-spoofed-account',
        },
        maxBuffer: 16_384,
        timeout: 10_000,
      },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(child.stderr).toBe('');
    expect(child.stdout.startsWith(root)).toBeFalse();
  });

  test('maps hostile operation rejections without invoking getters or Proxy handlers', async () => {
    for (const hostileKind of ['accessor', 'proxy'] as const) {
      const root = await mkdtemp(join(tmpdir(), `skillsmith-node-hostile-${hostileKind}-`));
      roots.push(root);
      const ports = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
      const target = join(root, 'artifact.toml');
      let interactions = 0;
      const hostile =
        hostileKind === 'accessor'
          ? (() => {
              const value = Object.create(null) as Record<string, unknown>;
              Object.defineProperty(value, 'code', {
                get: () => {
                  interactions += 1;
                  return 'EACCES';
                },
              });
              return value;
            })()
          : new Proxy(Object.create(null) as Record<string, unknown>, {
              get: () => {
                interactions += 1;
                return 'EACCES';
              },
              getOwnPropertyDescriptor: () => {
                interactions += 1;
                return undefined;
              },
              getPrototypeOf: () => {
                interactions += 1;
                return null;
              },
              has: () => {
                interactions += 1;
                return true;
              },
              ownKeys: () => {
                interactions += 1;
                return ['code'];
              },
            });

      await expect(
        ports.withFileLock(
          target,
          {
            policy: 'central',
            centralOperationId: '0000000000000001',
            retryDelaysMs: [0],
          },
          async () => {
            throw hostile;
          },
        ),
      ).rejects.toMatchObject({ reason: 'filesystem-failure', exitCode: 3 });
      expect(interactions).toBe(0);
    }
  });

  test('rejects arbitrary adapter IDs without handler or coercion access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-node-hostile-id-'));
    roots.push(root);
    const ports = await createTestNodeArtifactCoordinatorPorts(join(root, 'coordination'));
    let interactions = 0;
    const hostileId = new Proxy(Object.create(null) as Record<string, unknown>, {
      get: () => {
        interactions += 1;
        return () => '0000000000000001';
      },
      getOwnPropertyDescriptor: () => {
        interactions += 1;
        return undefined;
      },
      getPrototypeOf: () => {
        interactions += 1;
        return null;
      },
      has: () => {
        interactions += 1;
        return true;
      },
      ownKeys: () => {
        interactions += 1;
        return [];
      },
    });

    await expect(
      ports.createTransactionDirectoryExclusive(
        join(root, '.skillsmith-artifact-0000000000000001'),
        hostileId as unknown as string,
      ),
    ).rejects.toMatchObject({ reason: 'filesystem-failure' });
    await expect(
      ports.withFileLock(
        join(root, 'artifact.toml'),
        {
          policy: 'central',
          centralOperationId: hostileId as unknown as string,
          retryDelaysMs: [0],
        },
        async () => undefined,
      ),
    ).rejects.toMatchObject({ reason: 'filesystem-failure' });
    expect(interactions).toBe(0);
  });
});
