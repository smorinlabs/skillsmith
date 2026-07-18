import { describe, expect, test } from 'bun:test';
import type { CurrentApplicationContext } from '../../src/application/types.ts';
import { hashCanonicalInput } from '../../src/artifacts/hash.ts';
import { observeInitManifest } from '../../src/init/run.ts';

describe('init runtime observation', () => {
  test('owns ordinary bytes in the resource digest domain without parsing them', async () => {
    const original = Uint8Array.from([0xff, 0xfe, 0xfd]);
    const context = {
      artifactCoordinator: {
        observe: async () => ({ kind: 'file', mode: 0o640, identity: 'inode', linkCount: 1 }),
        readBytes: async () => original,
      },
    } as unknown as CurrentApplicationContext;
    const observed = await observeInitManifest(context, '/work/opaque.toml');
    expect(observed.ok).toBeTrue();
    if (!observed.ok || observed.value.state !== 'file') return;
    const expected = hashCanonicalInput('resource', 1, original);
    expect(expected.ok).toBeTrue();
    if (!expected.ok) return;
    expect(observed.value.resourceDigest).toBe(expected.value);
    expect(observed.value.mode).toBe(0o640);
    original.fill(0);
    expect(observed.value.bytes).toEqual(Uint8Array.from([0xff, 0xfe, 0xfd]));
  });

  test('refuses aliases and non-files before reading bytes', async () => {
    let reads = 0;
    const context = {
      artifactCoordinator: {
        observe: async () => ({ kind: 'symlink', mode: 0o777, identity: 'link', linkCount: 1 }),
        readBytes: async () => {
          reads += 1;
          return new Uint8Array();
        },
      },
    } as unknown as CurrentApplicationContext;
    expect(await observeInitManifest(context, '/work/link.toml')).toMatchObject({
      ok: false,
      error: { code: 'init-invalid-file-kind', exitClass: 'state' },
    });
    expect(reads).toBe(0);
  });
});
