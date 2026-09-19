import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  type ArtifactDigest,
  type ArtifactHashError,
  HASH_DOMAINS,
  HASH_SCHEMA_VERSION,
  type HashDomain,
  type HashSchemaVersion,
  hashCanonicalInput,
  hashManifestBytes,
  hashManifestSemantics,
  parseArtifactDigest,
} from '../../src/artifacts/hash.ts';
import { projectManifestSemantics } from '../../src/artifacts/manifest.ts';
import type { NormalizedManifestV1 } from '../../src/artifacts/types.ts';

const VECTORS = [
  {
    domain: 'manifest-semantic',
    framedHex: '736b696c6c736d6974683a6d616e69666573742d73656d616e7469633a76310066697874757265',
    digest: 'sha256:0a6f886554ddb1c3e8ea8855e9d925510bd8e4b7ab019acad00fc439ffc19928',
  },
  {
    domain: 'manifest-bytes',
    framedHex: '736b696c6c736d6974683a6d616e69666573742d62797465733a76310066697874757265',
    digest: 'sha256:9e1f83b8613015af33ebaaf466478ae39b44b63053391940182842b55dd7427c',
  },
  {
    domain: 'lock-canonical',
    framedHex: '736b696c6c736d6974683a6c6f636b2d63616e6f6e6963616c3a76310066697874757265',
    digest: 'sha256:dff4c0236161665a378587c0cc5c7795d783989d0dc6002de39e916051380d71',
  },
  {
    domain: 'source-content',
    framedHex: '736b696c6c736d6974683a736f757263652d636f6e74656e743a76310066697874757265',
    digest: 'sha256:bb3c0bcb637ca8f405ecb0e2906cb5ddaaa3360a046bc2b6bf777f1e5dab8044',
  },
  {
    domain: 'resource',
    framedHex: '736b696c6c736d6974683a7265736f757263653a76310066697874757265',
    digest: 'sha256:bab42d680e596ad547a777448b64b04e87ec46d71621927ba8de4c6d91cd6593',
  },
  {
    domain: 'selection-set',
    framedHex: '736b696c6c736d6974683a73656c656374696f6e2d7365743a76310066697874757265',
    digest: 'sha256:5f23d1b15485383c4a21f3ee993a8916906eb3f93814e2356045ad92481ba94a',
  },
  {
    domain: 'capability',
    framedHex: '736b696c6c736d6974683a6361706162696c6974793a76310066697874757265',
    digest: 'sha256:8d3011072ef5529731b1bd0ee2761e2ffcdf8bd802b4a645fab38a20de8f61f9',
  },
] as const satisfies readonly {
  readonly domain: HashDomain;
  readonly framedHex: string;
  readonly digest: string;
}[];

const EXPECTED_SEMANTIC_JSON =
  '{"version":1,"defaults":{"tools":["claude-code","codex"],"scope":"project","path":"./skills"},"registry":{"default":"github.com/acme"},"skills":[{"name":"alpha","source":{"host":"github.com","repository":"acme/tools","path":"skills/alpha"},"ref":null,"tools":["codex"],"scope":"project","placement":"symlink","path":null},{"name":"zeta","source":{"host":"git.example","repository":"acme/tools","path":null},"ref":"release/v1","tools":["claude-code","codex"],"scope":"user","placement":"copy","path":"~/skills/zeta"}]}';
const EXPECTED_SEMANTIC_DIGEST =
  'sha256:43e7e2c7a35f3a1ab792804954596683def22cdbe98b85ef4df6710e6d198c31';

const MANIFEST = {
  version: 1,
  defaults: {
    tools: ['codex', 'claude-code'],
    scope: 'project',
    path: './skills',
  },
  registry: { default: 'github.com/acme' },
  skills: [
    {
      name: 'zeta',
      source: { host: 'git.example', repository: 'acme/tools', path: null },
      ref: 'release/v1',
      tools: ['codex', 'claude-code'],
      scope: 'user',
      placement: 'copy',
      path: '~/skills/zeta',
    },
    {
      name: 'alpha',
      source: { host: 'github.com', repository: 'acme/tools', path: 'skills/alpha' },
      ref: null,
      tools: ['codex'],
      scope: 'project',
      placement: 'symlink',
      path: null,
    },
  ],
} as const satisfies NormalizedManifestV1;

const expectDigest = (actual: ArtifactDigest, expected: string): void => {
  expect(String(actual)).toBe(expected);
};

const expectHashSuccess = (
  result: ReturnType<typeof hashCanonicalInput>,
  expected: string,
): ArtifactDigest => {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  expectDigest(result.value, expected);
  return result.value;
};

describe('artifact hash authority', () => {
  test('publishes the frozen closed v1 registry and closed public types', () => {
    const version: HashSchemaVersion = HASH_SCHEMA_VERSION;
    const domain: HashDomain = HASH_DOMAINS[0];
    const error: ArtifactHashError = {
      code: 'artifact-hash',
      reason: 'invalid-digest',
      field: 'digest',
      message: 'artifact digest is invalid',
    };

    expect(version).toBe(1);
    expect(domain).toBe('manifest-semantic');
    expect(error.code).toBe('artifact-hash');
    expect([...HASH_DOMAINS]).toEqual(VECTORS.map((vector) => vector.domain));
    expect(Object.isFrozen(HASH_DOMAINS)).toBe(true);
  });

  test('matches hard-coded framed bytes and SHA-256 digests for every domain', () => {
    const digests = new Set<string>();
    for (const vector of VECTORS) {
      expect(
        `sha256:${createHash('sha256').update(Buffer.from(vector.framedHex, 'hex')).digest('hex')}`,
      ).toBe(vector.digest);
      const result = hashCanonicalInput(vector.domain, 1, 'fixture');
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      expectDigest(result.value, vector.digest);
      digests.add(result.value);
    }
    expect(digests.size).toBe(HASH_DOMAINS.length);
  });

  test('hashes copied binary input byte-for-byte, including invalid UTF-8 and NUL', () => {
    const input = Uint8Array.of(0, 255, 254, 128, 65);
    const result = hashCanonicalInput('resource', 1, input);
    input.fill(7);

    expectHashSuccess(
      result,
      'sha256:fc75a6d01152730919216993a2cf1d55bf6c6baa7936c7c3aafed00e50c09c6b',
    );
    expect(
      createHash('sha256')
        .update(Buffer.from('736b696c6c736d6974683a7265736f757263653a76310000fffe8041', 'hex'))
        .digest('hex'),
    ).toBe('fc75a6d01152730919216993a2cf1d55bf6c6baa7936c7c3aafed00e50c09c6b');

    const backing = Uint8Array.of(9, 102, 105, 120, 116, 117, 114, 101, 8);
    const view = backing.subarray(1, 8);
    const viewResult = hashCanonicalInput('resource', 1, view);
    backing.fill(0);
    expectHashSuccess(
      viewResult,
      'sha256:bab42d680e596ad547a777448b64b04e87ec46d71621927ba8de4c6d91cd6593',
    );
  });

  test('uses exact byte input and WHATWG UTF-8 string semantics without normalization', () => {
    expectHashSuccess(
      hashCanonicalInput('resource', 1, ''),
      'sha256:60b01fded61bd00bcc727832c7850f77251d9b81b6f731fbec248db43781a066',
    );
    const unicode = hashCanonicalInput('resource', 1, 'é');
    expectHashSuccess(
      unicode,
      'sha256:62def40252d519a19e62269cb58d8292d7cd1b4697431d6a33e89df6e2c7d656',
    );
    expect(unicode).toEqual(hashCanonicalInput('resource', 1, Uint8Array.of(0xc3, 0xa9)));

    expectDigest(
      hashManifestBytes('\ud800'),
      'sha256:7849119f699532f48a6bab80210a12d00d8b641d25830e9e7bbff36356e3f2c5',
    );
    expect(hashManifestBytes('\ud800')).toBe(hashManifestBytes(Uint8Array.of(0xef, 0xbf, 0xbd)));
    expect(hashManifestBytes('\udc00')).toBe(hashManifestBytes('\ud800'));
    expect(hashManifestBytes(Uint8Array.of(0xff))).not.toBe(hashManifestBytes('\ufffd'));

    expectDigest(
      hashManifestBytes(Uint8Array.of(0xff)),
      'sha256:1fe361bbc412c0a8d9adb2f76fa1257cef917010bffe90384b1e8c1f7749007d',
    );
    expectDigest(
      hashManifestBytes(Uint8Array.of(0xef, 0xbb, 0xbf)),
      'sha256:9dcd9b1286a95d4147b594c4ea910d05f2215e1ec17a8c05bd06daa16f8c1397',
    );
    expectDigest(
      hashManifestBytes(Uint8Array.of()),
      'sha256:adb21d6a867fd51eb3f34a1afd936a72f64b0f3251b69cf19c1c588770f32311',
    );
    expectDigest(
      hashManifestBytes(Uint8Array.of(0)),
      'sha256:252e9c630ec474ca03e6ece85ca12edaf7b6f4f42525a210f18f523d7471f0a1',
    );

    const exactBytes = Uint8Array.of(0xff);
    const exactDigest = hashManifestBytes(exactBytes);
    exactBytes[0] = 0;
    expectDigest(
      exactDigest,
      'sha256:1fe361bbc412c0a8d9adb2f76fa1257cef917010bffe90384b1e8c1f7749007d',
    );
  });

  test('refuses unknown domains and schema versions with fixed secret-safe errors', () => {
    const secretDomain = 'P17_CANARY';
    const domainError = {
      ok: false,
      error: {
        code: 'artifact-hash',
        reason: 'unknown-domain',
        field: 'domain',
        message: 'artifact hash domain is unsupported',
      },
    } as const;
    const unknown = hashCanonicalInput(secretDomain, 1, 'ignored');
    expect(unknown).toEqual(domainError);
    if (!unknown.ok) {
      expect(Object.isFrozen(unknown.error)).toBe(true);
      expect(JSON.stringify(unknown.error)).not.toContain(secretDomain);
    }

    for (const domain of [
      '',
      'RESOURCE',
      'Resource',
      'resource ',
      ' resource',
      'resource\n',
      'source_content',
      'manifest-semantic:v1',
      'skillsmith:resource:v1',
      '__proto__',
      'toString',
    ]) {
      expect(hashCanonicalInput(domain, 1, 'ignored')).toEqual(domainError);
    }

    const schemaError = {
      ok: false,
      error: {
        code: 'artifact-hash',
        reason: 'unsupported-hash-schema',
        field: 'schemaVersion',
        message: 'artifact hash schema is unsupported',
      },
    } as const;
    for (const version of [
      0,
      -0,
      2,
      -1,
      1.1,
      Number.MIN_VALUE,
      Number.MAX_SAFE_INTEGER,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '1' as unknown as number,
      null as unknown as number,
      1n as unknown as number,
      new Number(1) as unknown as number,
    ]) {
      expect(hashCanonicalInput('resource', version, 'ignored')).toEqual({
        ...schemaError,
      });
    }
    expect(hashCanonicalInput('unknown', 2, 'ignored')).toEqual(domainError);

    let inputTouches = 0;
    const hostileInput = new Proxy(Uint8Array.of(1), {
      get: () => {
        inputTouches += 1;
        throw new Error('P17_HOSTILE_INPUT_CANARY');
      },
    });
    expect(hashCanonicalInput('unknown', 1, hostileInput)).toEqual(domainError);
    expect(hashCanonicalInput('resource', 2, hostileInput)).toEqual(schemaError);
    expect(inputTouches).toBe(0);
  });

  test('brands only exact lowercase SHA-256 digests after runtime parsing', () => {
    const valid = VECTORS[0].digest;
    const parsed = parseArtifactDigest(valid);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error.message);
    expectDigest(parsed.value, valid);

    for (const accepted of [
      `sha256:${'0'.repeat(64)}`,
      `sha256:${'f'.repeat(64)}`,
      'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    ]) {
      const result = parseArtifactDigest(accepted);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      expectDigest(result.value, accepted);
    }

    const secret = { digest: `sha256:${'0'.repeat(63)}P17_CANARY` };
    for (const invalid of [
      undefined,
      null,
      false,
      1,
      1n,
      Symbol('digest'),
      {},
      [],
      new String(valid),
      secret,
      '',
      ` ${valid}`,
      `${valid} `,
      `${valid}\n`,
      `${valid}\0`,
      valid.toUpperCase(),
      valid.replace('sha256', 'SHA256'),
      valid.replace('sha256:', 'sha256::'),
      valid.slice('sha256:'.length),
      `sha-256:${'0'.repeat(64)}`,
      `sha512:${'0'.repeat(64)}`,
      `sha256:${'0'.repeat(63)}`,
      `sha256:${'0'.repeat(65)}`,
      `sha256:${'g'.repeat(64)}`,
    ]) {
      const result = parseArtifactDigest(invalid);
      expect(result).toEqual({
        ok: false,
        error: {
          code: 'artifact-hash',
          reason: 'invalid-digest',
          field: 'digest',
          message: 'artifact digest is invalid',
        },
      });
      if (!result.ok) {
        expect(Object.isFrozen(result.error)).toBe(true);
        expect(JSON.stringify(result.error)).not.toContain('P17_CANARY');
      }
    }
  });

  test('hashes exactly the existing schema-ordered manifest semantic projection', () => {
    const projection = projectManifestSemantics(MANIFEST);
    expect(JSON.stringify(projection)).toBe(EXPECTED_SEMANTIC_JSON);
    expectDigest(hashManifestSemantics(MANIFEST), EXPECTED_SEMANTIC_DIGEST);
    const exact = hashCanonicalInput('manifest-semantic', 1, EXPECTED_SEMANTIC_JSON);
    expect(exact.ok).toBe(true);
    if (!exact.ok) throw new Error(exact.error.message);
    expectDigest(exact.value, EXPECTED_SEMANTIC_DIGEST);

    const withNewline = hashCanonicalInput('manifest-semantic', 1, `${EXPECTED_SEMANTIC_JSON}\n`);
    expect(withNewline.ok).toBe(true);
    if (!withNewline.ok) throw new Error(withNewline.error.message);
    expect(String(withNewline.value)).not.toBe(EXPECTED_SEMANTIC_DIGEST);
  });

  test('hashes exact manifest source bytes and remains presentation-sensitive', () => {
    expectDigest(
      hashManifestBytes('version = 1\n'),
      'sha256:f59632b3a21636f59c5f3f93b747c27663df80cb2a9bc9c4f7a1f19803c6049b',
    );
    expectDigest(
      hashManifestBytes(new TextEncoder().encode('version = 1\n')),
      'sha256:f59632b3a21636f59c5f3f93b747c27663df80cb2a9bc9c4f7a1f19803c6049b',
    );
    expectDigest(
      hashManifestBytes('version = 1\r\n'),
      'sha256:0f5a121fda0d0b89468b8e74ee30bac8b82a40e45792ef59b6364fcb9c1b9b69',
    );
    expectDigest(
      hashManifestBytes('# comment\nversion = 1\n'),
      'sha256:3cd05948bd4c5570e3984fa7ceacd1a7eeb71ab35619c9fe4a0cffd4d11cadfe',
    );
  });
});
