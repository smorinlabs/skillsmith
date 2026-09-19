import { describe, expect, test } from 'bun:test';
import { hashManifestBytes, hashManifestSemantics } from '../../src/artifacts/hash.ts';
import { INIT_MANIFEST_OPERATION_KINDS, planInitManifest } from '../../src/artifacts/init.ts';
import { normalizeManifestDocument, readManifestSource } from '../../src/artifacts/manifest.ts';

const encoder = new TextEncoder();

const request = (
  skeleton: Readonly<Record<string, unknown>> = {},
  current: Readonly<Record<string, unknown>> = { state: 'absent' },
  force = false,
) => ({ skeleton, current, legacyIntent: { requireMatch: [] }, force });

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  expect(result.ok).toBeTrue();
  if (!result.ok) throw new Error('expected init operation');
  return result.value;
};

describe('pure init manifest authority', () => {
  test('constructs exact canonical declaration-empty bytes and matching immutable hashes', () => {
    const operation = unwrap(
      planInitManifest(
        request({
          defaults: {
            tools: ['codex', 'claude-code'],
            scope: 'project',
            path: './skills',
          },
          registry: { default: 'github.com/acme' },
        }),
      ),
    );
    expect(operation.kind).toBe('create-manifest');
    expect(operation.before).toBeNull();
    if (operation.after === null) throw new Error('create operation lacks after image');
    expect(operation.after.source).toBe(
      'version = 1\n\n[defaults]\ntools = ["claude-code", "codex"]\nscope = "project"\npath = "./skills"\n\n[registry]\ndefault = "github.com/acme"\n',
    );
    expect(operation.after.byteHash).toBe(hashManifestBytes(operation.after.source));
    const document = unwrap(readManifestSource(operation.after.source));
    const manifest = unwrap(normalizeManifestDocument(document));
    expect(manifest.skills).toEqual([]);
    expect(operation.after.semanticHash).toBe(hashManifestSemantics(manifest));
    expect(Object.isFrozen(operation)).toBeTrue();
    expect(Object.isFrozen(operation.after)).toBeTrue();
  });

  test('normalizes absent and empty defaults and publishes the closed operation inventory', () => {
    expect(INIT_MANIFEST_OPERATION_KINDS).toEqual([
      'create-manifest',
      'replace-manifest',
      'migrate-project-config',
      'noop',
    ]);
    expect(Object.isFrozen(INIT_MANIFEST_OPERATION_KINDS)).toBeTrue();
    const absentResult = planInitManifest(request());
    expect(Object.isFrozen(absentResult)).toBeTrue();
    const absent = unwrap(absentResult);
    const empty = unwrap(planInitManifest(request({ defaults: {} })));
    expect(absent).toEqual(empty);
    expect(absent.after?.source).toBe('version = 1\n');
  });

  test('returns a semantic noop without exposing current bytes or source', () => {
    const currentSource = '# retained formatting\nversion=1\n';
    const operation = unwrap(
      planInitManifest(
        request({ defaults: {} }, { state: 'present', bytes: encoder.encode(currentSource) }),
      ),
    );
    expect(operation.kind).toBe('noop');
    expect(operation.after).toBeNull();
    expect(operation.before).toEqual({
      byteHash: hashManifestBytes(currentSource),
      semanticHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      shape: 'canonical',
    });
    expect(operation.before).not.toHaveProperty('bytes');
    expect(operation.before).not.toHaveProperty('source');
  });

  test('orders future refusal ahead of force and gates all other replacement on force', () => {
    const future = planInitManifest(
      request(
        {},
        { state: 'present', bytes: encoder.encode('version = 2\nfuture = true\n') },
        true,
      ),
    );
    expect(future).toEqual({
      ok: false,
      error: {
        code: 'init-manifest',
        exitCode: 3,
        reason: 'future-manifest',
        shape: 'future',
        message: 'init manifest uses a newer unsupported schema',
      },
    });

    const existingBytes = encoder.encode('other = true\n');
    const refused = planInitManifest(request({}, { state: 'present', bytes: existingBytes }));
    expect(refused.ok).toBeFalse();
    if (!refused.ok) expect(refused.error.reason).toBe('existing-manifest');
    const replaced = unwrap(
      planInitManifest(request({}, { state: 'present', bytes: existingBytes }, true)),
    );
    expect(replaced.kind).toBe('replace-manifest');
    expect(replaced.before?.shape).toBe('unknown');
    expect(replaced.before?.semanticHash).toBeNull();
  });

  test('validates per-field intent order and optional properties by absence', () => {
    for (const [input, field] of [
      [{ ...request(), skeleton: { defaults: undefined } }, 'skeleton.defaults'],
      [
        {
          ...request({ defaults: { tools: ['codex'], scope: 'project' } }),
          legacyIntent: { requireMatch: ['defaults.scope', 'defaults.tools'] },
        },
        'legacyIntent.requireMatch',
      ],
      [
        {
          ...request(),
          legacyIntent: { requireMatch: ['defaults.scope'] },
        },
        'legacyIntent.requireMatch',
      ],
    ] as const) {
      const result = planInitManifest(input);
      expect(result.ok).toBeFalse();
      if (!result.ok) {
        expect(result.error.reason).toBe('invalid-request');
        expect(result.error.field).toBe(field);
      }
    }
  });

  test('rejects trap-bearing containers and non-owned byte views without invoking caller code', () => {
    const proxied = new Proxy(request(), {
      ownKeys: () => {
        throw new Error('must not run');
      },
    });
    expect(planInitManifest(proxied).ok).toBeFalse();

    const shared = new Uint8Array(new SharedArrayBuffer(8));
    const sharedResult = planInitManifest(request({}, { state: 'present', bytes: shared }));
    expect(sharedResult.ok).toBeFalse();
    if (!sharedResult.ok) {
      expect(sharedResult.error.field).toBe('current.bytes');
      expect(Object.isFrozen(sharedResult)).toBeTrue();
      expect(Object.isFrozen(sharedResult.error)).toBeTrue();
    }

    const forgedView = new Uint8ClampedArray(encoder.encode('version = 1\n'));
    Object.setPrototypeOf(forgedView, Uint8Array.prototype);
    expect(
      planInitManifest(
        request({}, { state: 'present', bytes: forgedView as unknown as Uint8Array }),
      ).ok,
    ).toBeFalse();

    const disguisedSharedBuffer = new SharedArrayBuffer(16);
    const disguisedShared = new Uint8Array(disguisedSharedBuffer);
    disguisedShared.set(encoder.encode('version = 1\n'));
    Object.setPrototypeOf(disguisedSharedBuffer, ArrayBuffer.prototype);
    expect(
      planInitManifest(request({}, { state: 'present', bytes: disguisedShared })).ok,
    ).toBeFalse();

    const shadowed = encoder.encode('version = 1\n');
    Object.defineProperty(shadowed, 'constructor', { value: Uint8Array });
    expect(planInitManifest(request({}, { state: 'present', bytes: shadowed })).ok).toBeFalse();

    const detachedBuffer = new ArrayBuffer(8);
    const detached = new Uint8Array(detachedBuffer);
    structuredClone(detachedBuffer, { transfer: [detachedBuffer] });
    const detachedResult = planInitManifest(request({}, { state: 'present', bytes: detached }));
    expect(detachedResult.ok).toBeFalse();
    if (!detachedResult.ok) expect(detachedResult.error.field).toBe('current.bytes');
  });
});
