import { describe, expect, test } from 'bun:test';
import type { CurrentApplicationContext } from '../../src/application/types.ts';
import { hashCanonicalInput } from '../../src/artifacts/hash.ts';
import { planInitManifest } from '../../src/artifacts/init.ts';
import { prepareInitOperationPlan } from '../../src/init/plan.ts';
import { executePreparedInit, observeInitManifest } from '../../src/init/run.ts';
import type { InitArtifactSelection, InitDefaults, InitRequest } from '../../src/init/types.ts';

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

  test('preserves an execution observation permission failure through shared preconditions', async () => {
    const path = '/work/skillsmith.toml';
    const request: InitRequest = Object.freeze({
      tools: Object.freeze([]),
      explicitTools: false,
      toolSource: 'none',
      scope: null,
      explicitScope: false,
      file: path,
      force: false,
    });
    const defaults: InitDefaults = Object.freeze({
      tools: null,
      scope: null,
      path: null,
      registryDefault: null,
    });
    const selection: InitArtifactSelection = Object.freeze({
      outcome: 'selected',
      selectedBy: 'explicit-file',
      manifestPath: path,
      lockPath: '/work/skillsmith.lock',
      lockSource: 'sibling',
    });
    const classification = planInitManifest({
      skeleton: {},
      current: { state: 'absent' },
      legacyIntent: { requireMatch: [] },
      force: false,
    });
    expect(classification.ok).toBeTrue();
    if (!classification.ok) return;
    const prepared = prepareInitOperationPlan({
      request,
      dryRun: false,
      defaults,
      selection,
      skeleton: {},
      classification: classification.value,
      observed: { state: 'absent' },
    });
    const context = {
      artifactCoordinator: {
        observe: async () => {
          throw new Error('EACCES');
        },
      },
      ports: {},
      observation: {},
    } as unknown as CurrentApplicationContext;

    expect(await executePreparedInit(context, prepared)).toMatchObject({
      ok: false,
      error: { code: 'init-observation-failed', exitClass: 'permission' },
    });
  });
});
