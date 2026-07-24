import { describe, expect, test } from 'bun:test';
import { type ArtifactDigest, hashManifestBytes } from '../../src/artifacts/hash.ts';
import {
  type PortableLockV1,
  hashPortableLock,
  serializePortableLock,
} from '../../src/artifacts/lock.ts';
import {
  RETAINED_ARTIFACT_PREIMAGE_MAX_BYTES,
  decodeRetainedArtifactPreimageV1,
  encodeRetainedArtifactPreimageV1,
} from '../../src/artifacts/retained-preimage-codec.ts';

const encoder = new TextEncoder();
const operationId = `operation:v1:${'a'.repeat(64)}`;
const manifestBeforeSource =
  'version = 1\n\n[[skills]]\nname = "review"\nsource = "acme/review"\ntools = ["codex"]\nscope = "user"\n';
const manifestBefore = () => encoder.encode(manifestBeforeSource);
const manifestAfter = encoder.encode(
  'version = 1\n\n[[skills]]\nname = "review"\nsource = "acme/review"\nref = "v2"\ntools = ["codex"]\nscope = "user"\n',
);

const manifestInput = () => ({
  operationId,
  role: 'manifest' as const,
  path: '/workspace/skillsmith.toml',
  before: { mode: 0o604, bytes: manifestBefore() },
  after: { digest: hashManifestBytes(manifestAfter), mode: 0o604 },
});

const lock = (): PortableLockV1 => ({
  version: 1,
  hashSchemaVersion: 1,
  manifestHash: hashManifestBytes(manifestBefore()),
  skills: [],
});

describe('retained-preimage@1 codec', () => {
  test('round-trips an exact manifest preimage with separate content and envelope digests', () => {
    const source = manifestInput();
    const encoded = encodeRetainedArtifactPreimageV1(source);
    expect(encoded.ok).toBeTrue();
    if (!encoded.ok) return;
    expect(new TextDecoder().decode(encoded.value.encoded)).toBe(
      `${JSON.stringify({
        kind: 'skillsmith.retained-artifact-preimage',
        version: 1,
        operationId,
        role: 'manifest',
        path: source.path,
        before: { mode: 0o604, bytes: Buffer.from(manifestBefore()).toString('base64') },
        after: { digest: source.after.digest, mode: 0o604 },
      })}\n`,
    );
    expect(encoded.value.contentDigest).toBe(hashManifestBytes(manifestBefore()));
    expect(encoded.value.repositoryDigest).not.toBe(encoded.value.contentDigest);
    source.before.bytes[0] = 0;
    expect(encoded.value.model.before.bytes[0]).toBe('v'.charCodeAt(0));

    const decoded = decodeRetainedArtifactPreimageV1(encoded.value.encoded, {
      operationId,
      role: 'manifest',
      path: source.path,
      after: source.after,
    });
    expect(decoded.ok).toBeTrue();
    if (decoded.ok) expect(decoded.value).toEqual(encoded.value);
  });

  test('authenticates canonical lock bytes in the lock-canonical content domain', () => {
    const serialized = serializePortableLock(lock());
    const afterDigest = hashPortableLock(lock());
    expect(serialized.ok && afterDigest.ok).toBeTrue();
    if (!serialized.ok || !afterDigest.ok) return;
    const input = {
      operationId: `operation:v1:${'b'.repeat(64)}`,
      role: 'lock' as const,
      path: '/workspace/skillsmith.lock',
      before: { mode: 0o640, bytes: encoder.encode(serialized.value) },
      after: { digest: afterDigest.value, mode: 0o640 },
    };
    const encoded = encodeRetainedArtifactPreimageV1(input);
    expect(encoded.ok).toBeTrue();
    if (!encoded.ok) return;
    expect(encoded.value.contentDigest).toBe(afterDigest.value);
    expect(decodeRetainedArtifactPreimageV1(encoded.value.encoded, input).ok).toBeTrue();
  });

  test('rejects noncanonical encodings, hostile shapes, invalid payloads, and authority mismatch', () => {
    const encoded = encodeRetainedArtifactPreimageV1(manifestInput());
    expect(encoded.ok).toBeTrue();
    if (!encoded.ok) return;
    const source = new TextDecoder().decode(encoded.value.encoded);
    const dto = JSON.parse(source) as Record<string, unknown>;
    const before = dto.before as Record<string, unknown>;
    const cases = [
      encoder.encode(`${source}\n`),
      encoder.encode(source.replace('"kind"', '"unknown":true,"kind"')),
      encoder.encode(source.replace('"kind"', '"kind":"duplicate","kind"')),
      encoder.encode(source.replace('"kind":', '"version":1,"kind":').replace(',"version":1', '')),
      encoder.encode(source.replace(String(before.bytes), `${String(before.bytes)}=`)),
      Uint8Array.of(0xc3, 0x28),
    ];
    for (const candidate of cases) {
      expect(
        decodeRetainedArtifactPreimageV1(candidate, {
          operationId,
          role: 'manifest',
          path: '/workspace/skillsmith.toml',
        }).ok,
      ).toBeFalse();
    }

    expect(
      decodeRetainedArtifactPreimageV1(encoded.value.encoded, {
        operationId: `operation:v1:${'c'.repeat(64)}`,
        role: 'manifest',
        path: '/workspace/skillsmith.toml',
      }),
    ).toMatchObject({ ok: false, error: { reason: 'expectation-mismatch' } });
    expect(
      encodeRetainedArtifactPreimageV1({ ...manifestInput(), path: 'relative.toml' }).ok,
    ).toBeFalse();
    expect(
      encodeRetainedArtifactPreimageV1({
        ...manifestInput(),
        before: { ...manifestInput().before, mode: 0o10000 },
      }).ok,
    ).toBeFalse();
    expect(
      encodeRetainedArtifactPreimageV1({
        ...manifestInput(),
        before: { ...manifestInput().before, bytes: encoder.encode('not toml') },
      }),
    ).toMatchObject({ ok: false, error: { reason: 'invalid-manifest' } });
    const invalidDigest = `sha256:${'g'.repeat(64)}` as ArtifactDigest;
    expect(
      encodeRetainedArtifactPreimageV1({
        ...manifestInput(),
        after: { ...manifestInput().after, digest: invalidDigest },
      }).ok,
    ).toBeFalse();
  });

  test('bounds decoded and encoded payloads before accepting private retention material', () => {
    const oversized = new Uint8Array(RETAINED_ARTIFACT_PREIMAGE_MAX_BYTES + 1);
    expect(
      encodeRetainedArtifactPreimageV1({
        ...manifestInput(),
        before: { ...manifestInput().before, bytes: oversized },
      }),
    ).toMatchObject({ ok: false, error: { reason: 'payload-too-large' } });
  });
});
