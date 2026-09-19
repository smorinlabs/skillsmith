import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashManifestSemantics } from '../../src/artifacts/hash.ts';
import { fromLockV1Dto, lockV1Codec, toLockV1Dto } from '../../src/artifacts/lock-codec.ts';
import {
  type PortableLockSkillV1,
  type PortableLockStateError,
  type PortableLockV1,
  correlatePortableLock,
  hashPortableLock,
  readPortableLockSource,
  serializePortableLock,
} from '../../src/artifacts/lock.ts';
import { normalizeManifestDocument, readManifestSource } from '../../src/artifacts/manifest.ts';
import type { NormalizedManifestV1 } from '../../src/artifacts/types.ts';
import type { Result } from '../../src/result.ts';

const encoder = new TextEncoder();
const fixturePath = join(
  import.meta.dir,
  '../../../../tests/ergonomics/fixtures/p2-ts03/lock-v1.golden.toml',
);
const fixtureBytes = new Uint8Array(readFileSync(fixturePath));
const fixtureSource = new TextDecoder().decode(fixtureBytes);

const ERROR_MESSAGES: Readonly<Record<PortableLockStateError['reason'], string>> = {
  'empty-lock': 'portable lock is empty',
  'malformed-lock': 'portable lock is malformed',
  'invalid-version': 'portable lock version is invalid',
  'unsupported-lock-version': 'portable lock version is unsupported',
  'unsupported-hash-schema': 'portable lock hash schema is unsupported',
  'unknown-field': 'portable lock contains an unknown field',
  'missing-field': 'portable lock is missing a required field',
  'invalid-field': 'portable lock field is invalid',
  'duplicate-name': 'portable lock skill name is duplicated',
  'noncanonical-lock': 'portable lock bytes are not canonical',
};

const unwrap = <T, E>(result: Result<T, E>): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

const expectError = <T>(
  result: Result<T, PortableLockStateError>,
  reason: PortableLockStateError['reason'],
  field?: string,
): void => {
  expect(result.ok).toBeFalse();
  if (result.ok) throw new Error(`expected ${reason}`);
  expect(result.error.reason).toBe(reason);
  expect(result.error.field).toBe(field);
  expect(result.error.code).toBe('portable-lock-state');
  expect(result.error.exitCode).toBe(3);
  expect(result.error.message).toBe(ERROR_MESSAGES[reason]);
  if (field === undefined) expect(result.error).not.toHaveProperty('field');
  expect(Object.isFrozen(result.error)).toBeTrue();
};

const manifestSource = `version = 1
[defaults]
tools = ["codex"]
scope = "project"

[[skills]]
name = "review"
source = "github.com/acme/tools//skills/review"
ref = "main"

[[skills]]
name = "lint"
source = "https://git.example.com/acme/tools//skills/lint"
`;

const manifest = unwrap(normalizeManifestDocument(unwrap(readManifestSource(manifestSource))));

const readCandidate = (candidate: PortableLockV1): PortableLockV1 =>
  unwrap(readPortableLockSource(encoder.encode(unwrap(serializePortableLock(candidate)))));

const serializeUnknown = (value: unknown): Result<string, PortableLockStateError> =>
  serializePortableLock(value as PortableLockV1);

const manifestFrom = (source: string): NormalizedManifestV1 =>
  unwrap(normalizeManifestDocument(unwrap(readManifestSource(source))));

const expectRecursivelyFrozen = (value: unknown, seen = new Set<object>()): void => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBeTrue();
  for (const child of Object.values(value)) expectRecursivelyFrozen(child, seen);
};

describe('portable lock authority', () => {
  test('reads, freezes, serializes, and hashes the hard-coded canonical lock bytes', () => {
    const lock = unwrap(readPortableLockSource(fixtureBytes));
    expect(Object.isFrozen(lock)).toBeTrue();
    expect(Object.isFrozen(lock.skills)).toBeTrue();
    expect(lock.skills.every(Object.isFrozen)).toBeTrue();
    expect(lock.skills.map((skill) => skill.name)).toEqual(['lint', 'review']);
    expect(lock.skills[0]?.requestedRef).toBeNull();
    expect(unwrap(serializePortableLock(lock))).toBe(fixtureSource);
    expect(String(unwrap(hashPortableLock(lock)))).toBe(
      'sha256:54ceb53b4caacc1dcbc5faac4bd83eca31d33d98efdd0a4f9d420a774d6ffc84',
    );
  });

  test('emits the exact empty-lock form and omits null requested refs', () => {
    const fixture = unwrap(readPortableLockSource(fixtureBytes));
    const empty = { ...fixture, skills: [] };
    expect(unwrap(serializePortableLock(empty))).toBe(
      `version = 1
hash_schema_version = 1
manifest_hash = "${fixture.manifestHash}"
`,
    );
    const one = { ...fixture, skills: [fixture.skills[0] as (typeof fixture.skills)[number]] };
    const serialized = unwrap(serializePortableLock(one));
    expect(serialized).not.toContain('requested_ref');
    expect(serialized.endsWith('\n')).toBeTrue();
    expect(serialized.endsWith('\n\n')).toBeFalse();
  });

  test('applies fatal UTF-8, BOM, empty, and strict version-first precedence', () => {
    expectError(readPortableLockSource(new Uint8Array()), 'empty-lock');
    expectError(readPortableLockSource(encoder.encode('# trivia only\n')), 'empty-lock');
    expectError(readPortableLockSource(Uint8Array.of(0xc3, 0x28)), 'malformed-lock');
    expectError(
      readPortableLockSource(Uint8Array.from([0xef, 0xbb, 0xbf, ...fixtureBytes])),
      'noncanonical-lock',
    );
    expectError(
      readPortableLockSource(encoder.encode('version = 2\nfuture = true\n')),
      'unsupported-lock-version',
      'version',
    );
    for (const token of ['0', '-1', '+1', '1.0', '1e0', '1_0', '"1"', 'true']) {
      expectError(
        readPortableLockSource(encoder.encode(`version = ${token}\n`)),
        'invalid-version',
        'version',
      );
    }
    expectError(readPortableLockSource(encoder.encode('version = 01\n')), 'malformed-lock');
  });

  test('covers exact positive-safe-integer version tokens and future-version precedence', () => {
    for (const source of [
      'version = 2\n',
      'version = 9007199254740991\n',
      '  version   =   2 # future shape\nfuture = true\n',
      '"version" = 2\nfuture = true\n',
      'version = 2\n[[future]]\nvalue = "P17_SECRET_CANARY"\n',
      'future = """\n[[skills]]\nversion = 1\n"""\nversion = 2\n',
      "future = '''\nversion = +1\n'''\nversion = 2\n",
    ]) {
      expectError(
        readPortableLockSource(encoder.encode(source)),
        'unsupported-lock-version',
        'version',
      );
    }

    for (const token of [
      '0',
      '-0',
      '-2',
      '+2',
      '2.0',
      '2e0',
      '2_0',
      '0x2',
      '0o2',
      '0b10',
      'nan',
      'inf',
      '"2"',
      'false',
      '[2]',
      '{ value = 2 }',
    ]) {
      expectError(
        readPortableLockSource(encoder.encode(`version = ${token}\nfuture = true\n`)),
        'invalid-version',
        'version',
      );
    }
    for (const source of [
      'version = 00\n',
      'version = 02\n',
      'version = 9007199254740992\n',
      'version = 1\nversion = 1\n',
      'version =\n',
      '= 1\n',
    ]) {
      expectError(readPortableLockSource(encoder.encode(source)), 'malformed-lock');
    }
    expectError(
      readPortableLockSource(encoder.encode('hash_schema_version = 1\n')),
      'invalid-version',
      'version',
    );
    expectError(
      readPortableLockSource(encoder.encode('version.value = 1\n')),
      'invalid-version',
      'version',
    );
    expectError(
      readPortableLockSource(encoder.encode("future = '''\nversion = 1\n'''\nversion = +1\n")),
      'invalid-version',
      'version',
    );
  });

  test('discriminates hash schema before strict v1 fields', () => {
    expectError(
      readPortableLockSource(encoder.encode('version = 1\nfuture = true\n')),
      'missing-field',
      'hash_schema_version',
    );
    expectError(
      readPortableLockSource(
        encoder.encode('version = 1\nhash_schema_version = 2\nfuture = true\n'),
      ),
      'unsupported-hash-schema',
      'hash_schema_version',
    );
    for (const token of ['+1', '1.0', '1e0', '1_0', '"1"']) {
      expectError(
        readPortableLockSource(encoder.encode(`version = 1\nhash_schema_version = ${token}\n`)),
        'invalid-field',
        'hash_schema_version',
      );
    }
  });

  test('covers hash-schema token grammar, parser failures, and precedence', () => {
    for (const source of [
      'version = 1\nhash_schema_version = 2\n',
      'version = 1\nhash_schema_version = 9007199254740991\nfuture = true\n',
      'version = 1\n"hash_schema_version" = 2\nfuture = true\n',
      'version = 1\nhash_schema_version = 2 # future schema\nfuture = true\n',
      'version = 1\nfuture = """\nhash_schema_version = 1\n"""\nhash_schema_version = 2\n',
      "version = 1\nfuture = '''\nhash_schema_version = +1\n'''\nhash_schema_version = 2\n",
    ]) {
      expectError(
        readPortableLockSource(encoder.encode(source)),
        'unsupported-hash-schema',
        'hash_schema_version',
      );
    }
    for (const token of [
      '0',
      '-1',
      '+1',
      '1.0',
      '1e0',
      '1_0',
      '0x1',
      '0o1',
      '0b1',
      '"1"',
      'true',
      '[1]',
      '{ value = 1 }',
    ]) {
      expectError(
        readPortableLockSource(
          encoder.encode(`version = 1\nhash_schema_version = ${token}\nfuture = true\n`),
        ),
        'invalid-field',
        'hash_schema_version',
      );
    }
    for (const source of [
      'version = 1\nhash_schema_version = 01\n',
      'version = 1\nhash_schema_version = 9007199254740992\n',
      'version = 1\nhash_schema_version = 1\nhash_schema_version = 1\n',
    ]) {
      expectError(readPortableLockSource(encoder.encode(source)), 'malformed-lock');
    }
    expectError(
      readPortableLockSource(
        encoder.encode(
          'version = 1\nfuture = """\nhash_schema_version = 1\n"""\nhash_schema_version = +1\n',
        ),
      ),
      'invalid-field',
      'hash_schema_version',
    );
  });

  test('classifies every presentation-only change as noncanonical', () => {
    const [header, firstBlock, secondBlock] = fixtureSource.split('\n\n[[skills]]\n');
    if (header === undefined || firstBlock === undefined || secondBlock === undefined) {
      throw new Error('lock fixture structure changed');
    }
    const variants = [
      `# comment\n${fixtureSource}`,
      fixtureSource.replace('\n\n[[skills]]', '\n# between\n\n[[skills]]'),
      fixtureSource.replace(
        '\n[[skills]]\nname = "review"',
        '\n[[skills]] # table comment\nname = "review"',
      ),
      fixtureSource.replaceAll('\n', '\r\n'),
      fixtureSource.slice(0, -1),
      `${fixtureSource}\n`,
      fixtureSource.replace('version = 1', 'version=1'),
      fixtureSource.replace('version = 1', ' version = 1'),
      fixtureSource.replace('version = 1\n', 'version = 1 \n'),
      fixtureSource.replace('manifest_hash = ', 'manifest_hash  = '),
      fixtureSource.replace('manifest_hash = ', '"manifest_hash" = '),
      fixtureSource.replace(
        'version = 1\nhash_schema_version = 1',
        'hash_schema_version = 1\nversion = 1',
      ),
      fixtureSource.replace(
        'name = "lint"\nsource = "git.example.com/acme/tools//skills/lint"',
        'source = "git.example.com/acme/tools//skills/lint"\nname = "lint"',
      ),
      fixtureSource
        .replace(
          'requested_ref = "main"\nresolved_sha =',
          'resolved_sha = "89abcdef0123456789abcdef0123456789abcdef"\nrequested_ref = "main"\n_unused =',
        )
        .replace('_unused = "89abcdef0123456789abcdef0123456789abcdef"\n', ''),
      `${header}\n\n[[skills]]\n${secondBlock.replace(/\n$/u, '')}\n\n[[skills]]\n${firstBlock}\n`,
      fixtureSource.replace('name = "lint"', "name = 'lint'"),
      fixtureSource.replace('requested_ref = "main"', "requested_ref = 'main'"),
      fixtureSource.replace('requested_ref = "main"', 'requested_ref = """main"""'),
      fixtureSource.replace('requested_ref = "main"', 'requested_ref = "m\\u0061in"'),
      fixtureSource.replace('\n\n[[skills]]', '\n[[skills]]'),
      fixtureSource.replace('\n\n[[skills]]', '\n\n\n[[skills]]'),
    ];
    for (const variant of variants) {
      expectError(readPortableLockSource(encoder.encode(variant)), 'noncanonical-lock');
    }
  });

  test('refuses unknown, missing, malformed, duplicate, and inconsistent entry fields', () => {
    const lock = unwrap(readPortableLockSource(fixtureBytes));
    expectError(
      readPortableLockSource(
        encoder.encode(fixtureSource.replace('manifest_hash =', 'future = true\nmanifest_hash =')),
      ),
      'unknown-field',
      'root',
    );
    expectError(
      readPortableLockSource(encoder.encode(fixtureSource.replace('name = "lint"\n', ''))),
      'missing-field',
      'skills[0].name',
    );
    expectError(
      readPortableLockSource(
        encoder.encode(fixtureSource.replace('name = "lint"', 'name = "review"')),
      ),
      'duplicate-name',
      'skills[].name',
    );
    expectError(
      serializePortableLock({
        ...lock,
        skills: [
          { ...(lock.skills[0] as (typeof lock.skills)[number]), resolvedSha: 'A'.repeat(40) },
        ],
      }),
      'invalid-field',
      'skills[0].resolved_sha',
    );
    expectError(
      serializePortableLock({
        ...lock,
        skills: [{ ...(lock.skills[0] as (typeof lock.skills)[number]), sourcePath: '.' }],
      }),
      'invalid-field',
      'skills[0].source_path',
    );
    expectError(
      serializePortableLock({ ...lock, skills: [...lock.skills].reverse() }),
      'invalid-field',
      'skills[].name',
    );
    const { skills: _skills, ...withoutSkills } = lock;
    expectError(
      serializePortableLock(withoutSkills as unknown as PortableLockV1),
      'missing-field',
      'skills',
    );
    expectError(
      serializePortableLock({
        ...lock,
        skills: [
          {
            ...(lock.skills[0] as (typeof lock.skills)[number]),
            requestedRef: '\ud800',
          },
        ],
      }),
      'invalid-field',
      'skills[0].requested_ref',
    );
  });

  test('enforces exact root and entry key sets, required fields, and runtime types', () => {
    const lock = unwrap(readPortableLockSource(fixtureBytes));
    const first = lock.skills[0] as PortableLockSkillV1;

    for (const value of [null, undefined, true, 1, 'lock', [], new Uint8Array()]) {
      expectError(serializeUnknown(value), 'invalid-field', 'root');
    }

    const rootUnknown = { ...lock, future: true };
    expectError(serializeUnknown(rootUnknown), 'unknown-field', 'root');
    const rootSymbol = { ...lock, [Symbol('future')]: true };
    expectError(serializeUnknown(rootSymbol), 'unknown-field', 'root');

    for (const [key, field] of [
      ['version', 'version'],
      ['hashSchemaVersion', 'hash_schema_version'],
      ['manifestHash', 'manifest_hash'],
      ['skills', 'skills'],
    ] as const) {
      const candidate = { ...lock } as Record<string, unknown>;
      delete candidate[key];
      expectError(serializeUnknown(candidate), 'missing-field', field);
    }

    for (const value of [null, '1', 0, 1.5, true]) {
      expectError(serializeUnknown({ ...lock, version: value }), 'invalid-version', 'version');
    }
    expectError(serializeUnknown({ ...lock, version: 2 }), 'unsupported-lock-version', 'version');
    for (const value of [null, '1', 0, 1.5, true]) {
      expectError(
        serializeUnknown({ ...lock, hashSchemaVersion: value }),
        'invalid-field',
        'hash_schema_version',
      );
    }
    expectError(
      serializeUnknown({ ...lock, hashSchemaVersion: 2 }),
      'unsupported-hash-schema',
      'hash_schema_version',
    );
    for (const value of [null, true, 1, [], {}, 'sha256:ABC']) {
      expectError(
        serializeUnknown({ ...lock, manifestHash: value }),
        'invalid-field',
        'manifest_hash',
      );
    }
    for (const value of [null, true, 1, 'skills', {}, new Uint8Array()]) {
      expectError(serializeUnknown({ ...lock, skills: value }), 'invalid-field', 'skills');
    }

    for (const [key, field] of [
      ['name', 'name'],
      ['source', 'source'],
      ['requestedRef', 'requested_ref'],
      ['resolvedSha', 'resolved_sha'],
      ['sourcePath', 'source_path'],
      ['contentHash', 'content_hash'],
    ] as const) {
      const candidate = { ...first } as Record<string, unknown>;
      delete candidate[key];
      expectError(
        serializeUnknown({ ...lock, skills: [candidate] }),
        'missing-field',
        `skills[0].${field}`,
      );
    }
    expectError(
      serializeUnknown({ ...lock, skills: [{ ...first, future: true }] }),
      'unknown-field',
      'skills[]',
    );
    expectError(serializeUnknown({ ...lock, skills: [null] }), 'invalid-field', 'skills[0]');
    expectError(serializeUnknown({ ...lock, skills: ['skill'] }), 'invalid-field', 'skills[0]');

    const inheritedRoot = Object.create(lock) as PortableLockV1;
    expectError(serializePortableLock(inheritedRoot), 'missing-field', 'version');
    const inheritedEntry = Object.create(first) as PortableLockSkillV1;
    expectError(
      serializePortableLock({ ...lock, skills: [inheritedEntry] }),
      'missing-field',
      'skills[0].name',
    );
  });

  test('gives stable structural reader precedence for unknown, missing, and wrong fields', () => {
    const header = fixtureSource.slice(0, fixtureSource.indexOf('\n\n[[skills]]'));
    expectError(
      readPortableLockSource(encoder.encode(header.replace(/^manifest_hash.*\n?/mu, ''))),
      'missing-field',
      'manifest_hash',
    );
    expectError(
      readPortableLockSource(
        encoder.encode(header.replace(/manifest_hash = ".*"/u, 'manifest_hash = true')),
      ),
      'invalid-field',
      'manifest_hash',
    );
    expectError(
      readPortableLockSource(encoder.encode(`${header}\nskills = "bad"\n`)),
      'invalid-field',
      'skills',
    );
    expectError(
      readPortableLockSource(
        encoder.encode(
          fixtureSource.replace(
            'source = "git.example.com',
            'future = true\nsource = "git.example.com',
          ),
        ),
      ),
      'unknown-field',
      'skills[]',
    );
    expectError(
      readPortableLockSource(
        encoder.encode(
          fixtureSource
            .replace('name = "lint"\n', '')
            .replace('source = "git.example.com', 'future = true\nsource = "git.example.com'),
        ),
      ),
      'unknown-field',
      'skills[]',
    );
    expectError(
      readPortableLockSource(
        encoder.encode(
          fixtureSource.replace(
            'source = "git.example.com/acme/tools//skills/lint"',
            'source = true',
          ),
        ),
      ),
      'invalid-field',
      'skills[0].source',
    );
    expectError(
      readPortableLockSource(
        encoder.encode(
          fixtureSource.replace(
            '\n\n[[skills]]',
            `\nmanifest_hash = "${unwrap(readPortableLockSource(fixtureBytes)).manifestHash}"\n\n[[skills]]`,
          ),
        ),
      ),
      'malformed-lock',
    );
  });

  test('projects explicit hosts and canonical TOML escapes without retaining acquisition URLs', () => {
    const lock = unwrap(readPortableLockSource(fixtureBytes));
    const review = lock.skills[1] as (typeof lock.skills)[number];
    const withQuote = {
      ...lock,
      skills: [{ ...review, requestedRef: 'feature/quo"te' }],
    };
    const serialized = unwrap(serializePortableLock(withQuote));
    expect(serialized).toContain('source = "github.com/acme/tools//skills/review"');
    expect(serialized).toContain('requested_ref = "feature/quo\\"te"');
    expect(unwrap(readPortableLockSource(encoder.encode(serialized))).skills[0]?.requestedRef).toBe(
      'feature/quo"te',
    );
    expectError(
      serializePortableLock({
        ...lock,
        skills: [{ ...review, source: 'acme/tools//skills/review' }],
      }),
      'invalid-field',
      'skills[0].source',
    );
  });

  test('round-trips single-label hosts, dotted owners, root paths, and Unicode scalars exactly', () => {
    const lock = unwrap(readPortableLockSource(fixtureBytes));
    const template = lock.skills[0] as PortableLockSkillV1;
    const skills: PortableLockSkillV1[] = [
      {
        ...template,
        name: 'root',
        source: 'git/dotted.owner/répô',
        sourcePath: '.',
        requestedRef: 'feature/🚀"quoted',
      },
      {
        ...template,
        name: 'unicode',
        source: 'git/dotted.owner/répô//skills/café',
        sourcePath: 'skills/café',
        requestedRef: null,
      },
    ];
    const source = unwrap(serializePortableLock({ ...lock, skills }));
    expect(source).toContain('source = "git/dotted.owner/répô"');
    expect(source).toContain('requested_ref = "feature/🚀\\"quoted"');
    expect(source).toContain('source = "git/dotted.owner/répô//skills/café"');
    expect(source).toContain('source_path = "."');
    expect(source).not.toContain('https://');
    const roundTrip = unwrap(readPortableLockSource(encoder.encode(source)));
    expect(roundTrip.skills).toEqual(skills);
  });

  test('refuses noncanonical, ambiguous, credential-bearing, or unsafe source identities', () => {
    const lock = unwrap(readPortableLockSource(fixtureBytes));
    const template = lock.skills[0] as PortableLockSkillV1;
    const invalidSources = [
      'acme/tools//skills/lint',
      'https://git.example.com/acme/tools//skills/lint',
      'ssh://git@git.example.com/acme/tools//skills/lint',
      'git@git.example.com:acme/tools//skills/lint',
      'user@git.example.com/acme/tools//skills/lint',
      'git.example.com/acme/tools.git//skills/lint',
      'GIT.EXAMPLE.COM/acme/tools//skills/lint',
      'git.example.com/acme/tools//skills/../lint',
      'git.example.com/acme/tools//skills\\lint',
      'git.example.com/acme/tools//skills/lint?token=P17_SECRET_CANARY',
      'git.example.com/acme/tools//skills/lint#P17_SECRET_CANARY',
      'git.example.com/acme',
      'git.example.com//acme/tools',
      '/git.example.com/acme/tools',
    ];
    for (const source of invalidSources) {
      const result = serializePortableLock({ ...lock, skills: [{ ...template, source }] });
      expectError(result, 'invalid-field', 'skills[0].source');
      if (!result.ok) expect(JSON.stringify(result.error)).not.toContain('P17_SECRET_CANARY');
    }

    for (const sourcePath of [
      '',
      './skills/lint',
      '../P17_SECRET_CANARY',
      '/skills/lint',
      'C:/skills/lint',
      'skills\\lint',
      'skills/other',
    ]) {
      const result = serializePortableLock({
        ...lock,
        skills: [{ ...template, sourcePath }],
      });
      expectError(result, 'invalid-field', 'skills[0].source_path');
      if (!result.ok) expect(JSON.stringify(result.error)).not.toContain('P17_SECRET_CANARY');
    }
  });

  test('enforces name, requested-ref, SHA-1, and digest grammars field by field', () => {
    const lock = unwrap(readPortableLockSource(fixtureBytes));
    const template = lock.skills[0] as PortableLockSkillV1;
    for (const name of ['', '.hidden', 'bad name', 'bad/', 'trail.', 'a'.repeat(129)]) {
      expectError(
        serializePortableLock({ ...lock, skills: [{ ...template, name }] }),
        'invalid-field',
        'skills[0].name',
      );
    }
    for (const requestedRef of [
      '',
      '-main',
      '/main',
      'main/',
      'main.',
      '@',
      'bad ref',
      'bad..ref',
      'bad@{ref',
      'bad//ref',
      '.hidden',
      'topic.lock',
      'P17_SECRET_CANARY\\ref',
      '\udfff',
    ]) {
      const result = serializePortableLock({
        ...lock,
        skills: [{ ...template, requestedRef }],
      });
      expectError(result, 'invalid-field', 'skills[0].requested_ref');
      if (!result.ok) expect(JSON.stringify(result.error)).not.toContain('P17_SECRET_CANARY');
    }
    for (const requestedRef of [undefined, true, 1, [], {}]) {
      expectError(
        serializeUnknown({ ...lock, skills: [{ ...template, requestedRef }] }),
        'invalid-field',
        'skills[0].requested_ref',
      );
    }

    for (const resolvedSha of [
      '',
      '0'.repeat(39),
      '0'.repeat(41),
      'A'.repeat(40),
      'g'.repeat(40),
      '0'.repeat(64),
      'P17_SECRET_CANARY',
    ]) {
      const result = serializePortableLock({
        ...lock,
        skills: [{ ...template, resolvedSha }],
      });
      expectError(result, 'invalid-field', 'skills[0].resolved_sha');
      if (!result.ok) expect(JSON.stringify(result.error)).not.toContain('P17_SECRET_CANARY');
    }
    for (const resolvedSha of [null, true, 1, [], {}]) {
      expectError(
        serializeUnknown({ ...lock, skills: [{ ...template, resolvedSha }] }),
        'invalid-field',
        'skills[0].resolved_sha',
      );
    }

    const invalidDigests = [
      '',
      'sha256:',
      `sha256:${'0'.repeat(63)}`,
      `sha256:${'0'.repeat(65)}`,
      `sha256:${'A'.repeat(64)}`,
      `SHA256:${'0'.repeat(64)}`,
      `sha512:${'0'.repeat(64)}`,
      ` sha256:${'0'.repeat(64)}`,
      `sha256:${'0'.repeat(64)} `,
      'P17_SECRET_CANARY',
    ];
    for (const contentHash of invalidDigests) {
      const result = serializeUnknown({
        ...lock,
        skills: [{ ...template, contentHash }],
      });
      expectError(result, 'invalid-field', 'skills[0].content_hash');
      if (!result.ok) expect(JSON.stringify(result.error)).not.toContain('P17_SECRET_CANARY');
    }
    for (const manifestHash of invalidDigests) {
      const result = serializeUnknown({ ...lock, manifestHash });
      expectError(result, 'invalid-field', 'manifest_hash');
      if (!result.ok) expect(JSON.stringify(result.error)).not.toContain('P17_SECRET_CANARY');
    }
  });

  test('classifies missing, incomplete, stale, and current with frozen ranked facts', () => {
    const fixture = unwrap(readPortableLockSource(fixtureBytes));
    const current = readCandidate({
      ...fixture,
      manifestHash: hashManifestSemantics(manifest),
    });
    expect(correlatePortableLock(manifest, null)).toEqual({ state: 'missing-lock' });
    expect(correlatePortableLock(manifest, current)).toEqual({ state: 'current' });

    const incomplete = readCandidate({ ...current, skills: current.skills.slice(1) });
    const incompleteRelationship = correlatePortableLock(manifest, incomplete);
    expect(incompleteRelationship).toEqual({
      state: 'incomplete',
      missingNames: ['lint'],
      facts: [{ reason: 'missing-entry', name: 'lint', field: 'skills.name' }],
    });
    expect(Object.isFrozen(incompleteRelationship)).toBeTrue();
    if (incompleteRelationship.state === 'incomplete') {
      expect(Object.isFrozen(incompleteRelationship.missingNames)).toBeTrue();
      expect(Object.isFrozen(incompleteRelationship.facts)).toBeTrue();
    }

    const stale = readCandidate({
      ...current,
      manifestHash: fixture.manifestHash,
      skills: current.skills.map((skill) =>
        skill.name === 'review' ? { ...skill, requestedRef: 'other' } : skill,
      ),
    });
    const staleRelationship = correlatePortableLock(manifest, stale);
    expect(staleRelationship).toEqual({
      state: 'stale',
      facts: [
        { reason: 'manifest-hash-mismatch', field: 'manifest_hash' },
        {
          reason: 'requested-ref-mismatch',
          name: 'review',
          field: 'requested_ref',
        },
      ],
    });
    expect(Object.isFrozen(staleRelationship)).toBeTrue();
  });

  test('correlates a pinned manifest SHA while retaining the requested lock ref', () => {
    const fixture = unwrap(readPortableLockSource(fixtureBytes));
    const current = readCandidate({
      ...fixture,
      manifestHash: hashManifestSemantics(manifest),
    });
    const lint = current.skills.find(({ name }) => name === 'lint');
    if (lint === undefined) throw new Error('missing lint lock fixture');
    const pinnedManifest = {
      ...manifest,
      skills: manifest.skills.map((declaration) =>
        declaration.name === 'lint' ? { ...declaration, ref: lint.resolvedSha } : declaration,
      ),
    };
    const pinnedLock = readCandidate({
      ...current,
      manifestHash: hashManifestSemantics(pinnedManifest),
    });
    expect(correlatePortableLock(pinnedManifest, pinnedLock)).toEqual({ state: 'current' });

    const unrelatedManifest = {
      ...pinnedManifest,
      skills: pinnedManifest.skills.map((declaration) =>
        declaration.name === 'lint' ? { ...declaration, ref: 'feature/unrelated' } : declaration,
      ),
    };
    const unrelatedLock = readCandidate({
      ...pinnedLock,
      manifestHash: hashManifestSemantics(unrelatedManifest),
    });
    expect(correlatePortableLock(unrelatedManifest, unrelatedLock)).toEqual({
      state: 'stale',
      facts: [{ reason: 'requested-ref-mismatch', name: 'lint', field: 'requested_ref' }],
    });
  });

  test('ranks every relationship fact and applies incomplete precedence over all staleness', () => {
    const fixture = unwrap(readPortableLockSource(fixtureBytes));
    const lint = fixture.skills[0] as PortableLockSkillV1;
    const review = fixture.skills[1] as PortableLockSkillV1;
    const currentHash = hashManifestSemantics(manifest);
    const unrelatedHash = lint.contentHash;
    const extraA: PortableLockSkillV1 = { ...lint, name: 'aaa-extra' };
    const extraZ: PortableLockSkillV1 = { ...lint, name: 'zzz-extra' };
    const mismatchedLint: PortableLockSkillV1 = {
      ...lint,
      source: 'git.example.com/acme/tools//other/lint',
      sourcePath: 'other/lint',
      requestedRef: 'topic',
    };
    const mismatchedReview: PortableLockSkillV1 = {
      ...review,
      source: 'github.com/acme/tools//other/review',
      sourcePath: 'other/review',
      requestedRef: null,
    };

    const allStale = readCandidate({
      ...fixture,
      manifestHash: unrelatedHash,
      skills: [extraA, mismatchedLint, mismatchedReview, extraZ],
    });
    const relationship = correlatePortableLock(manifest, allStale);
    expect(relationship).toEqual({
      state: 'stale',
      facts: [
        { reason: 'extra-entry', name: 'aaa-extra', field: 'skills.name' },
        { reason: 'extra-entry', name: 'zzz-extra', field: 'skills.name' },
        { reason: 'manifest-hash-mismatch', field: 'manifest_hash' },
        { reason: 'source-mismatch', name: 'lint', field: 'source' },
        { reason: 'source-mismatch', name: 'review', field: 'source' },
        { reason: 'requested-ref-mismatch', name: 'lint', field: 'requested_ref' },
        { reason: 'requested-ref-mismatch', name: 'review', field: 'requested_ref' },
        { reason: 'source-path-mismatch', name: 'lint', field: 'source_path' },
        { reason: 'source-path-mismatch', name: 'review', field: 'source_path' },
      ],
    });
    expectRecursivelyFrozen(relationship);

    const incomplete = readCandidate({
      ...fixture,
      manifestHash: unrelatedHash,
      skills: [extraA, mismatchedReview, extraZ],
    });
    const incompleteRelationship = correlatePortableLock(manifest, incomplete);
    expect(incompleteRelationship).toEqual({
      state: 'incomplete',
      missingNames: ['lint'],
      facts: [
        { reason: 'missing-entry', name: 'lint', field: 'skills.name' },
        { reason: 'extra-entry', name: 'aaa-extra', field: 'skills.name' },
        { reason: 'extra-entry', name: 'zzz-extra', field: 'skills.name' },
      ],
    });
    expectRecursivelyFrozen(incompleteRelationship);

    const extraOnly = readCandidate({
      ...fixture,
      manifestHash: currentHash,
      skills: [extraA, lint, review],
    });
    expect(correlatePortableLock(manifest, extraOnly)).toEqual({
      state: 'stale',
      facts: [{ reason: 'extra-entry', name: 'aaa-extra', field: 'skills.name' }],
    });
  });

  test('treats formatting-only manifest variants as current and semantic changes as hash-stale', () => {
    const fixture = unwrap(readPortableLockSource(fixtureBytes));
    const current = readCandidate({ ...fixture, manifestHash: hashManifestSemantics(manifest) });
    const formattingVariant = manifestFrom(`# presentation only
version = 1
[defaults]
scope = "project"
tools = ["codex"]

[[skills]]
source = "https://git.example.com/acme/tools//skills/lint"
name = "lint"

[[skills]]
ref = "main"
source = "acme/tools//skills/review"
name = "review"
`);
    expect(hashManifestSemantics(formattingVariant)).toBe(hashManifestSemantics(manifest));
    const currentRelationship = correlatePortableLock(formattingVariant, current);
    expect(currentRelationship).toEqual({ state: 'current' });
    expectRecursivelyFrozen(currentRelationship);
    expectRecursivelyFrozen(correlatePortableLock(manifest, null));

    const semanticVariant = manifestFrom(manifestSource.replace('ref = "main"', 'ref = "next"'));
    const semanticRelationship = correlatePortableLock(semanticVariant, current);
    expect(semanticRelationship).toEqual({
      state: 'stale',
      facts: [
        { reason: 'manifest-hash-mismatch', field: 'manifest_hash' },
        {
          reason: 'requested-ref-mismatch',
          name: 'review',
          field: 'requested_ref',
        },
      ],
    });
    expectRecursivelyFrozen(semanticRelationship);
  });

  test('keeps all failures secret-safe', () => {
    const canary = 'P17_SECRET_CANARY';
    const malformed = readPortableLockSource(
      encoder.encode(`version = 1\nhash_schema_version = 1\n${canary} = "${canary}"\n`),
    );
    expect(malformed.ok).toBeFalse();
    if (!malformed.ok) expect(JSON.stringify(malformed.error)).not.toContain(canary);
  });
});

describe('portable lock artifact codec adapter', () => {
  test('publishes the exact frozen descriptor and identity-preserving mappers', () => {
    expect(lockV1Codec.descriptor).toEqual({
      id: 'lock',
      version: 1,
      syntax: 'toml',
      discriminator: { kind: 'field', field: 'version' },
      wireKind: null,
      presentation: { decode: 'canonical', encode: 'canonical' },
      terminalLf: true,
      unknownFields: 'reject-recursive',
      migrations: [],
      compatibility: 'conservative',
    });
    expectRecursivelyFrozen(lockV1Codec.descriptor);

    const decoded = unwrap(lockV1Codec.decode(fixtureBytes));
    expect(decoded).toMatchObject({
      source: { kind: 'version', version: 1 },
      canonical: true,
      migration: null,
    });
    const dto = unwrap(toLockV1Dto(decoded.model));
    const reordered = { ...dto, skills: [...dto.skills].reverse() };
    const remapped = unwrap(fromLockV1Dto(reordered));
    expect(remapped.skills.map(({ name }) => name)).toEqual(['lint', 'review']);
    expect(unwrap(lockV1Codec.encode(remapped))).toEqual(fixtureBytes);
    expectRecursivelyFrozen(decoded);
    expectRecursivelyFrozen(dto);
    expectRecursivelyFrozen(remapped);
  });

  test('maps signed lock refusals to fixed codec errors with exact precedence', () => {
    const cases = [
      {
        id: 'empty',
        bytes: new Uint8Array(),
        reason: 'malformed',
        requestedVersion: null,
        path: [],
      },
      {
        id: 'bom',
        bytes: Uint8Array.from([0xef, 0xbb, 0xbf, ...fixtureBytes]),
        reason: 'malformed',
        requestedVersion: null,
        path: [],
      },
      {
        id: 'invalid-version',
        bytes: encoder.encode('version = 0\n'),
        reason: 'invalid-shape',
        requestedVersion: null,
        path: ['version'],
      },
      {
        id: 'future-before-unknown',
        bytes: encoder.encode('version = 2\nunknown = true\n'),
        reason: 'unsupported-version',
        requestedVersion: 2,
        path: ['version'],
      },
      {
        id: 'unknown-root',
        bytes: encoder.encode(
          fixtureSource.replace('version = 1\n', 'version = 1\nunknown = true\n'),
        ),
        reason: 'invalid-shape',
        requestedVersion: 1,
        path: [],
      },
      {
        id: 'noncanonical',
        bytes: fixtureBytes.slice(0, -1),
        reason: 'noncanonical',
        requestedVersion: 1,
        path: [],
      },
    ] as const;
    for (const fixture of cases) {
      const result = lockV1Codec.decode(fixture.bytes);
      expect(result.ok, fixture.id).toBeFalse();
      if (result.ok) continue;
      expect(result.error, fixture.id).toEqual({
        code: 'artifact-codec',
        artifactId: 'lock',
        requestedVersion: fixture.requestedVersion,
        reason: fixture.reason,
        path: fixture.path,
        exitCode: 3,
        message:
          fixture.reason === 'malformed'
            ? 'artifact source is malformed'
            : fixture.reason === 'invalid-shape'
              ? 'artifact shape is invalid'
              : fixture.reason === 'unsupported-version'
                ? 'artifact version is not supported'
                : 'artifact bytes are not canonical',
      });
    }
  });

  test('rejects sensitive canonical bytes after canonicality and hostile DTOs without throwing', () => {
    const decoded = unwrap(lockV1Codec.decode(fixtureBytes));
    const poison = {
      ...decoded.model,
      skills: decoded.model.skills.map((skill, index) =>
        index === 1 ? { ...skill, requestedRef: 'P17_SECRET_CANARY' } : skill,
      ),
    };
    const canonicalPoison = encoder.encode(unwrap(serializePortableLock(poison)));
    const sensitive = lockV1Codec.decode(canonicalPoison);
    expect(sensitive).toEqual({
      ok: false,
      error: {
        code: 'artifact-codec',
        artifactId: 'lock',
        requestedVersion: 1,
        reason: 'sensitive-content',
        path: [],
        exitCode: 3,
        message: 'artifact contains sensitive content',
      },
    });
    const noncanonical = lockV1Codec.decode(canonicalPoison.slice(0, -1));
    expect(noncanonical).toMatchObject({
      ok: false,
      error: { reason: 'noncanonical' },
    });
    const mapped = fromLockV1Dto(poison);
    expect(mapped).toMatchObject({
      ok: false,
      error: { reason: 'sensitive-content' },
    });
    if (!mapped.ok) expect(JSON.stringify(mapped.error)).not.toContain('P17_SECRET_CANARY');

    const accessor = Object.defineProperty({}, 'version', {
      enumerable: true,
      get() {
        throw new Error('P17_SECRET_CANARY');
      },
    });
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('P17_SECRET_CANARY');
        },
      },
    );
    for (const value of [null, accessor, hostile, Object.create({ version: 1 }), new Array(2)]) {
      expect(() => lockV1Codec.validate(value)).not.toThrow();
      const result = lockV1Codec.validate(value);
      expect(result).toMatchObject({ ok: false, error: { reason: 'invalid-shape' } });
      if (!result.ok) expect(JSON.stringify(result.error)).not.toContain('P17_SECRET_CANARY');
    }
  });
});
