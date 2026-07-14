import { describe, expect, test } from 'bun:test';
import {
  artifactCodecError,
  canonicalJsonBytes,
  decodeArtifactUtf8,
  deepOwnFreeze,
  hasSensitiveArtifactContent,
  ownArtifactBytes,
  unsignedUtf16Compare,
} from '../../src/artifacts/codec.ts';

const decoder = new TextDecoder();

describe('artifact codec foundation', () => {
  test('constructs fixed secret-safe errors and bounds schema paths', () => {
    expect(
      artifactCodecError('plan', 2, 'unsupported-version', ['schemaVersion', 'x'.repeat(65), -1]),
    ).toEqual({
      code: 'artifact-codec',
      artifactId: 'plan',
      requestedVersion: 2,
      reason: 'unsupported-version',
      path: ['schemaVersion', '*', '*'],
      exitCode: 3,
      message: 'artifact version is not supported',
    });
    expect(artifactCodecError('manifest', Number.NaN, 'invalid-shape').requestedVersion).toBeNull();
  });

  test('owns ordinary bytes and refuses shared, subclassed, and hostile views', () => {
    const source = Uint8Array.of(1, 2, 3);
    const owned = ownArtifactBytes('plan', source, 1);
    expect(owned.ok).toBe(true);
    if (!owned.ok) return;
    source[0] = 9;
    expect([...owned.value]).toEqual([1, 2, 3]);

    const buffer = Buffer.from([1]);
    expect(ownArtifactBytes('plan', buffer, 1).ok).toBe(false);
    if (typeof SharedArrayBuffer !== 'undefined') {
      expect(ownArtifactBytes('plan', new Uint8Array(new SharedArrayBuffer(1)), 1).ok).toBe(false);
    }
    let shadowReads = 0;
    const shadowed = Uint8Array.of(1);
    Object.defineProperty(shadowed, 'buffer', {
      configurable: true,
      get: () => {
        shadowReads += 1;
        return new ArrayBuffer(1);
      },
    });
    expect(ownArtifactBytes('plan', shadowed, 1).ok).toBe(false);
    expect(shadowReads).toBe(0);
    let traps = 0;
    const hostile = new Proxy(source, {
      getPrototypeOf: () => {
        traps += 1;
        return Uint8Array.prototype;
      },
    });
    expect(ownArtifactBytes('plan', hostile, 1).ok).toBe(false);
    expect(traps).toBe(0);
  });

  test('fatal-decodes owned UTF-8 and rejects BOM and malformed input', () => {
    const decoded = decodeArtifactUtf8('journal', new TextEncoder().encode('{"ok":true}\n'), 1);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.source).toBe('{"ok":true}\n');
    expect(decodeArtifactUtf8('journal', Uint8Array.of(0xef, 0xbb, 0xbf, 0x7b), 1).ok).toBe(false);
    expect(decodeArtifactUtf8('journal', Uint8Array.of(0xc3, 0x28), 1).ok).toBe(false);
  });

  test('copies filesystem Buffers only at the UTF-8 decode boundary', () => {
    const source = Buffer.from('{"ok":true}\n');
    const decoded = decodeArtifactUtf8('plan', source, 1);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    source.fill(0);
    expect(decoder.decode(decoded.value.bytes)).toBe('{"ok":true}\n');
    expect(Object.getPrototypeOf(decoded.value.bytes)).toBe(Uint8Array.prototype);
    expect(ownArtifactBytes('plan', Buffer.from([1]), 1).ok).toBe(false);
  });

  test('deeply owns and freezes plain data without invoking accessors or proxy traps', () => {
    const source = { nested: [{ value: 1 }] };
    const owned = deepOwnFreeze<typeof source>('ledger', source, 2);
    expect(owned.ok).toBe(true);
    if (!owned.ok) return;
    const sourceLeaf = source.nested[0];
    if (sourceLeaf) sourceLeaf.value = 2;
    expect(owned.value.nested[0]?.value).toBe(1);
    expect(Object.isFrozen(owned.value)).toBe(true);
    expect(Object.isFrozen(owned.value.nested)).toBe(true);
    expect(Object.isFrozen(owned.value.nested[0])).toBe(true);

    let reads = 0;
    const accessor = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => {
        reads += 1;
        return 'value';
      },
    });
    expect(deepOwnFreeze('ledger', accessor, 2).ok).toBe(false);
    expect(reads).toBe(0);
    expect(deepOwnFreeze('ledger', new Proxy({}, {}), 2).ok).toBe(false);
    const sparse = Array.from({ length: 3 }) as unknown[];
    sparse[0] = 1;
    sparse[2] = 3;
    Reflect.deleteProperty(sparse, '1');
    expect(deepOwnFreeze('ledger', sparse, 2).ok).toBe(false);
  });

  test('detects recursive sensitive content and fails closed on hostile values', () => {
    expect(hasSensitiveArtifactContent({ nested: ['safe', 'authorization=Bearer abcdefgh'] })).toBe(
      true,
    );
    expect(hasSensitiveArtifactContent({ nested: ['safe', 'P17_SECRET_CANARY'] })).toBe(true);
    expect(hasSensitiveArtifactContent({ nested: ['safe', 'sha256:abcd'] })).toBe(false);
    expect(hasSensitiveArtifactContent(new Proxy({}, {}))).toBe(true);
  });

  test('emits deterministic JSON bytes with the requested framing', () => {
    const dto = { schemaVersion: 1, kind: 'skillsmith.plan', values: ['b', 'a'] };
    const framed = canonicalJsonBytes('plan', dto, 1, true);
    expect(framed.ok).toBe(true);
    if (!framed.ok) return;
    expect(decoder.decode(framed.value)).toBe(`${JSON.stringify(dto, null, 2)}\n`);
    const compatibility = canonicalJsonBytes('ledger', dto, 1, false);
    expect(compatibility.ok).toBe(true);
    if (compatibility.ok) expect(decoder.decode(compatibility.value).endsWith('\n')).toBe(false);
  });

  test('compares unsigned UTF-16 strings without locale state', () => {
    expect(['z', 'a', 'ä'].sort(unsignedUtf16Compare)).toEqual(['a', 'z', 'ä']);
  });
});
