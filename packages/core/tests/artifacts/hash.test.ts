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

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expectDigest(
      result.value,
      'sha256:fc75a6d01152730919216993a2cf1d55bf6c6baa7936c7c3aafed00e50c09c6b',
    );
    expect(
      createHash('sha256')
        .update(Buffer.from('736b696c6c736d6974683a7265736f757263653a76310000fffe8041', 'hex'))
        .digest('hex'),
    ).toBe('fc75a6d01152730919216993a2cf1d55bf6c6baa7936c7c3aafed00e50c09c6b');
  });

  test('uses WHATWG UTF-8 replacement semantics for unpaired surrogates', () => {
    expectDigest(
      hashManifestBytes('\ud800'),
      'sha256:7849119f699532f48a6bab80210a12d00d8b641d25830e9e7bbff36356e3f2c5',
    );
    expect(hashManifestBytes('\ud800')).toBe(hashManifestBytes(Uint8Array.of(0xef, 0xbf, 0xbd)));
  });

  test('refuses unknown domains and schema versions with fixed secret-safe errors', () => {
    const secretDomain = 'P17_CANARY';
    const unknown = hashCanonicalInput(secretDomain, 1, 'ignored');
    expect(unknown).toEqual({
      ok: false,
      error: {
        code: 'artifact-hash',
        reason: 'unknown-domain',
        field: 'domain',
        message: 'artifact hash domain is unsupported',
      },
    });
    if (!unknown.ok) {
      expect(Object.isFrozen(unknown.error)).toBe(true);
      expect(JSON.stringify(unknown.error)).not.toContain(secretDomain);
    }

    for (const version of [0, 2, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(hashCanonicalInput('resource', version, 'ignored')).toEqual({
        ok: false,
        error: {
          code: 'artifact-hash',
          reason: 'unsupported-hash-schema',
          field: 'schemaVersion',
          message: 'artifact hash schema is unsupported',
        },
      });
    }
  });

  test('brands only exact lowercase SHA-256 digests after runtime parsing', () => {
    const valid = VECTORS[0].digest;
    const parsed = parseArtifactDigest(valid);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error.message);
    expectDigest(parsed.value, valid);

    for (const invalid of [
      null,
      1,
      '',
      ` ${valid}`,
      `${valid} `,
      valid.toUpperCase(),
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
      if (!result.ok) expect(Object.isFrozen(result.error)).toBe(true);
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
