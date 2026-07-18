import { describe, expect, test } from 'bun:test';
import { hashManifestBytes } from '../../src/artifacts/hash.ts';
import { planInitManifest } from '../../src/artifacts/init.ts';
import { validateExecutionPlanShape } from '../../src/execution/scheduler.ts';
import { hashInitResourceBytes, prepareInitOperationPlan } from '../../src/init/plan.ts';
import type { InitArtifactSelection, InitDefaults, InitRequest } from '../../src/init/types.ts';

const encoder = new TextEncoder();
const path = '/work/skillsmith.toml';
const request: InitRequest = Object.freeze({
  tools: Object.freeze([]),
  explicitTools: false,
  toolSource: 'none',
  scope: null,
  explicitScope: false,
  file: path,
  force: true,
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

const classify = (bytes: Uint8Array | null, force: boolean) => {
  const result = planInitManifest({
    skeleton: {},
    current: bytes === null ? { state: 'absent' } : { state: 'present', bytes },
    legacyIntent: { requireMatch: [] },
    force,
  });
  expect(result.ok, result.ok ? undefined : result.error.message).toBeTrue();
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

describe('init operation plan', () => {
  test('projects an opaque replacement with distinct manifest and resource digests', () => {
    const bytes = Uint8Array.from([0xff, 0xfe, 0xfd]);
    const prepared = prepareInitOperationPlan({
      request,
      dryRun: true,
      defaults,
      selection,
      skeleton: {},
      classification: classify(bytes, true),
      observed: {
        state: 'file',
        bytes,
        resourceDigest: hashInitResourceBytes(bytes),
        mode: 0o640,
      },
    });
    const operation = prepared.plan.operations[0];
    expect(operation).toMatchObject({
      kind: 'write-manifest',
      pairId: null,
      before: { kind: 'opaque-manifest', shape: 'malformed' },
      after: { kind: 'manifest', shape: 'canonical' },
      conflict: {
        class: 'destination-exists',
        normal: 'refuse',
        forced: 'backup-and-replace',
        backup: 'required',
      },
      mutates: { live: false, manifest: true, lock: false, ledger: false },
    });
    expect(
      String(operation?.before.kind === 'opaque-manifest' ? operation.before.byteHash : null),
    ).toBe(String(hashInitResourceBytes(bytes)));
    expect(prepared.result.before.byteHash).toBe(hashManifestBytes(bytes));
    expect(prepared.result.before.byteHash).not.toBe(
      operation?.before.kind === 'opaque-manifest' ? operation.before.byteHash : null,
    );
    validateExecutionPlanShape(prepared.plan);
  });

  test('projects create and noop without inventing conflicts or executable noop work', () => {
    const create = prepareInitOperationPlan({
      request: { ...request, force: false },
      dryRun: false,
      defaults,
      selection,
      skeleton: {},
      classification: classify(null, false),
      observed: { state: 'absent' },
    });
    expect(create.plan.operations).toHaveLength(1);
    expect(create.plan.operations[0]?.conflict).toBeNull();

    const bytes = encoder.encode('version = 1\n');
    const noop = prepareInitOperationPlan({
      request: { ...request, force: false },
      dryRun: false,
      defaults,
      selection,
      skeleton: {},
      classification: classify(bytes, false),
      observed: {
        state: 'file',
        bytes,
        resourceDigest: hashInitResourceBytes(bytes),
        mode: 0o600,
      },
    });
    expect(noop.result).toMatchObject({ action: 'noop', operationId: null, after: null });
    expect(noop.plan.operations).toEqual([]);
  });
});
