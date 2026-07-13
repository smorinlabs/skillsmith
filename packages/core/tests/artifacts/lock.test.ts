import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashManifestSemantics } from '../../src/artifacts/hash.ts';
import {
  type PortableLockStateError,
  type PortableLockV1,
  correlatePortableLock,
  hashPortableLock,
  readPortableLockSource,
  serializePortableLock,
} from '../../src/artifacts/lock.ts';
import { normalizeManifestDocument, readManifestSource } from '../../src/artifacts/manifest.ts';
import type { Result } from '../../src/result.ts';

const encoder = new TextEncoder();
const fixturePath = join(
  import.meta.dir,
  '../../../../tests/ergonomics/fixtures/p2-ts03/lock-v1.golden.toml',
);
const fixtureBytes = new Uint8Array(readFileSync(fixturePath));
const fixtureSource = new TextDecoder().decode(fixtureBytes);

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

  test('classifies every presentation-only change as noncanonical', () => {
    const variants = [
      `# comment\n${fixtureSource}`,
      fixtureSource.replaceAll('\n', '\r\n'),
      fixtureSource.slice(0, -1),
      `${fixtureSource}\n`,
      fixtureSource.replace('version = 1', 'version=1'),
      fixtureSource.replace('manifest_hash = ', 'manifest_hash  = '),
      fixtureSource.replace(
        'version = 1\nhash_schema_version = 1',
        'hash_schema_version = 1\nversion = 1',
      ),
      fixtureSource.replace('name = "lint"', "name = 'lint'"),
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

  test('keeps all failures secret-safe', () => {
    const canary = 'P17_SECRET_CANARY';
    const malformed = readPortableLockSource(
      encoder.encode(`version = 1\nhash_schema_version = 1\n${canary} = "${canary}"\n`),
    );
    expect(malformed.ok).toBeFalse();
    if (!malformed.ok) expect(JSON.stringify(malformed.error)).not.toContain(canary);
  });
});
