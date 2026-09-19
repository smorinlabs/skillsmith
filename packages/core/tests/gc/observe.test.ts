import { describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeGcState } from '../../src/gc/observe.ts';
import { defaultRuntimePorts } from '../../src/ports/default.ts';

describe('GC read-only observation', () => {
  test('observes absent state without creating data, store, ledger, or recovery paths', async () => {
    const ports = await defaultRuntimePorts();
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-gc-observe-'));
    try {
      const dataDir = join(root, 'data');
      const storeRoot = join(dataDir, 'store');
      const observed = await observeGcState(ports, {
        dataDir,
        storeRoot,
        ledgerPath: join(dataDir, 'placements.json'),
      });
      expect(observed).toMatchObject({
        ledger: { state: 'absent' },
        inventory: { state: 'ok', objects: [] },
        recovery: { state: 'none' },
        tombstones: { state: 'safe' },
      });
      expect(await ports.pathKind(dataDir)).toBe('absent');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('refuses planted recovery state before observing the ledger or inventory', async () => {
    const ports = await defaultRuntimePorts();
    const root = await mkdtemp(join(tmpdir(), 'skillsmith-gc-observe-refuse-'));
    try {
      const dataDir = join(root, 'data');
      const recovery = join(dataDir, '.gc-recovery', 'v1');
      await mkdir(recovery, { recursive: true, mode: 0o700 });
      await chmod(dataDir, 0o700);
      await chmod(join(dataDir, '.gc-recovery'), 0o700);
      await writeFile(join(recovery, 'planted'), 'unsafe', { mode: 0o600 });
      expect(
        await observeGcState(ports, {
          dataDir,
          storeRoot: join(dataDir, 'store'),
          ledgerPath: join(dataDir, 'placements.json'),
        }),
      ).toMatchObject({ error: expect.stringContaining('unexpected') });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
