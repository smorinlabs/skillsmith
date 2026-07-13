import { parse as parseToml } from 'smol-toml';
import { type Result, err, ok } from '../result.ts';
import {
  type ArtifactDigest,
  HASH_SCHEMA_VERSION,
  hashCanonicalInput,
  hashManifestSemantics,
  parseArtifactDigest,
} from './hash.ts';
import { normalizeSourceIdentity, validateManifestName, validateRequestedRef } from './identity.ts';
import type { CanonicalSourceIdentity, NormalizedManifestV1 } from './types.ts';

export const LOCK_VERSION = 1 as const;

export interface PortableLockV1 {
  readonly version: typeof LOCK_VERSION;
  readonly hashSchemaVersion: typeof HASH_SCHEMA_VERSION;
  readonly manifestHash: ArtifactDigest;
  readonly skills: readonly PortableLockSkillV1[];
}

export interface PortableLockSkillV1 {
  readonly name: string;
  readonly source: string;
  readonly requestedRef: string | null;
  readonly resolvedSha: string;
  readonly sourcePath: string;
  readonly contentHash: ArtifactDigest;
}

export type PortableLockStateErrorReason =
  | 'empty-lock'
  | 'malformed-lock'
  | 'invalid-version'
  | 'unsupported-lock-version'
  | 'unsupported-hash-schema'
  | 'unknown-field'
  | 'missing-field'
  | 'invalid-field'
  | 'duplicate-name'
  | 'noncanonical-lock';

export interface PortableLockStateError {
  readonly code: 'portable-lock-state';
  readonly exitCode: 3;
  readonly reason: PortableLockStateErrorReason;
  readonly field?: string;
  readonly message: string;
}

export type PortableLockFact =
  | { readonly reason: 'missing-entry'; readonly name: string; readonly field: 'skills.name' }
  | { readonly reason: 'extra-entry'; readonly name: string; readonly field: 'skills.name' }
  | { readonly reason: 'manifest-hash-mismatch'; readonly field: 'manifest_hash' }
  | { readonly reason: 'source-mismatch'; readonly name: string; readonly field: 'source' }
  | {
      readonly reason: 'requested-ref-mismatch';
      readonly name: string;
      readonly field: 'requested_ref';
    }
  | {
      readonly reason: 'source-path-mismatch';
      readonly name: string;
      readonly field: 'source_path';
    };

type IncompleteLockFact = Extract<
  PortableLockFact,
  { readonly reason: 'missing-entry' | 'extra-entry' }
>;
type StaleLockFact = Exclude<PortableLockFact, { readonly reason: 'missing-entry' }>;

export type PortableLockRelationship =
  | { readonly state: 'missing-lock' }
  | {
      readonly state: 'incomplete';
      readonly missingNames: readonly string[];
      readonly facts: readonly IncompleteLockFact[];
    }
  | { readonly state: 'stale'; readonly facts: readonly StaleLockFact[] }
  | { readonly state: 'current' };

type RawRecord = Record<string, unknown>;

const ROOT_KEYS = new Set(['version', 'hash_schema_version', 'manifest_hash', 'skills']);
const SKILL_KEYS = new Set([
  'name',
  'source',
  'requested_ref',
  'resolved_sha',
  'source_path',
  'content_hash',
]);
const NORMALIZED_ROOT_KEYS = new Set(['version', 'hashSchemaVersion', 'manifestHash', 'skills']);
const NORMALIZED_SKILL_KEYS = new Set([
  'name',
  'source',
  'requestedRef',
  'resolvedSha',
  'sourcePath',
  'contentHash',
]);
const INTEGER_TOKEN = /^[1-9][0-9]*$/u;
const SHA1 = /^[0-9a-f]{40}$/u;
const encoder = new TextEncoder();

const ERROR_MESSAGES: Readonly<Record<PortableLockStateErrorReason, string>> = Object.freeze({
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
});

const lockError = (reason: PortableLockStateErrorReason, field?: string): PortableLockStateError =>
  Object.freeze({
    code: 'portable-lock-state',
    exitCode: 3,
    reason,
    ...(field === undefined ? {} : { field }),
    message: ERROR_MESSAGES[reason],
  });

const fail = (
  reason: PortableLockStateErrorReason,
  field?: string,
): Result<never, PortableLockStateError> => err(lockError(reason, field));

const isRecord = (value: unknown): value is RawRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnlyOwnKeys = (value: RawRecord, expected: ReadonlySet<string>): boolean =>
  Reflect.ownKeys(value).every((key) => typeof key === 'string' && expected.has(key));

const deepFreeze = <T>(value: T, seen = new Set<object>()): T => {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
};

const compareNames = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};

const splitAssignment = (line: string): Readonly<{ key: string; value: string }> | null => {
  let quote: 'single' | 'double' | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === 'double') {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quote = null;
      continue;
    }
    if (quote === 'single') {
      if (character === "'") quote = null;
      continue;
    }
    if (character === '"') quote = 'double';
    else if (character === "'") quote = 'single';
    else if (character === '=') {
      return { key: line.slice(0, index).trim(), value: line.slice(index + 1) };
    }
  }
  return null;
};

const stripInlineComment = (value: string): string => {
  let quote: 'single' | 'double' | null = null;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote === 'double') {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quote = null;
      continue;
    }
    if (quote === 'single') {
      if (character === "'") quote = null;
      continue;
    }
    if (character === '"') quote = 'double';
    else if (character === "'") quote = 'single';
    else if (character === '#') return value.slice(0, index).trim();
  }
  return value.trim();
};

const keyParsesTo = (key: string, expected: string): boolean => {
  if (key.length === 0 || key.length > 128) return false;
  try {
    const parsed = parseToml(`${key} = 0`);
    return (
      isRecord(parsed) &&
      Reflect.ownKeys(parsed).length === 1 &&
      typeof parsed[expected] === 'number' &&
      parsed[expected] === 0
    );
  } catch {
    return false;
  }
};

const findRootToken = (source: string, key: string): string | null => {
  for (const rawLine of source.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const trimmed = line.trimStart();
    if (trimmed.startsWith('[')) return null;
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const assignment = splitAssignment(trimmed);
    if (assignment !== null && keyParsesTo(assignment.key, key)) {
      return stripInlineComment(assignment.value);
    }
  }
  return null;
};

const projectLockSource = (source: CanonicalSourceIdentity): string =>
  `${source.host}/${source.repository}${source.path === null ? '' : `//${source.path}`}`;

const normalizeLockSource = (value: string): CanonicalSourceIdentity | null => {
  const pathMarker = value.indexOf('//');
  const repositoryPart = pathMarker < 0 ? value : value.slice(0, pathMarker);
  if (repositoryPart.split('/').length < 3) return null;
  const normalized = normalizeSourceIdentity(`https://${value}`, 'skills[].source');
  if (!normalized.ok || projectLockSource(normalized.value) !== value) return null;
  return normalized.value;
};

const encodeTomlString = (value: string): string | null => {
  let encoded = '"';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return null;
      encoded += value[index] ?? '';
      encoded += value[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return null;
    if (code <= 0x1f || code === 0x7f) return null;
    if (code === 0x22) encoded += '\\"';
    else if (code === 0x5c) encoded += '\\\\';
    else encoded += value[index] ?? '';
  }
  return `${encoded}"`;
};

const validateAndOwnSkill = (
  value: unknown,
  index: number,
  serializedShape: boolean,
): Result<PortableLockSkillV1, PortableLockStateError> => {
  const prefix = `skills[${index}]`;
  if (!isRecord(value)) return fail('invalid-field', prefix);
  const expectedKeys = serializedShape ? SKILL_KEYS : NORMALIZED_SKILL_KEYS;
  if (!hasOnlyOwnKeys(value, expectedKeys)) return fail('unknown-field', 'skills[]');

  const fields = serializedShape
    ? ({
        name: 'name',
        source: 'source',
        requestedRef: 'requested_ref',
        resolvedSha: 'resolved_sha',
        sourcePath: 'source_path',
        contentHash: 'content_hash',
      } as const)
    : ({
        name: 'name',
        source: 'source',
        requestedRef: 'requestedRef',
        resolvedSha: 'resolvedSha',
        sourcePath: 'sourcePath',
        contentHash: 'contentHash',
      } as const);

  const required: string[] = [
    fields.name,
    fields.source,
    fields.resolvedSha,
    fields.sourcePath,
    fields.contentHash,
  ];
  if (!serializedShape) required.push(fields.requestedRef);
  for (const key of required) {
    if (!(key in value)) {
      const externalKey =
        key === fields.requestedRef
          ? 'requested_ref'
          : key === fields.resolvedSha
            ? 'resolved_sha'
            : key === fields.sourcePath
              ? 'source_path'
              : key === fields.contentHash
                ? 'content_hash'
                : key;
      return fail('missing-field', `${prefix}.${externalKey}`);
    }
  }

  const name = value[fields.name];
  if (typeof name !== 'string' || !validateManifestName(name, `${prefix}.name`).ok) {
    return fail('invalid-field', `${prefix}.name`);
  }
  const source = value[fields.source];
  if (typeof source !== 'string') return fail('invalid-field', `${prefix}.source`);
  const normalizedSource = normalizeLockSource(source);
  if (normalizedSource === null) return fail('invalid-field', `${prefix}.source`);

  const requestedRef =
    fields.requestedRef in value ? value[fields.requestedRef] : (null as unknown);
  if (
    requestedRef !== null &&
    (typeof requestedRef !== 'string' ||
      !validateRequestedRef(requestedRef, `${prefix}.requested_ref`).ok)
  ) {
    return fail('invalid-field', `${prefix}.requested_ref`);
  }

  const resolvedSha = value[fields.resolvedSha];
  if (typeof resolvedSha !== 'string' || !SHA1.test(resolvedSha)) {
    return fail('invalid-field', `${prefix}.resolved_sha`);
  }
  const sourcePath = value[fields.sourcePath];
  if (typeof sourcePath !== 'string' || sourcePath !== (normalizedSource.path ?? '.')) {
    return fail('invalid-field', `${prefix}.source_path`);
  }
  const contentHashResult = parseArtifactDigest(value[fields.contentHash]);
  if (!contentHashResult.ok) return fail('invalid-field', `${prefix}.content_hash`);

  if (encodeTomlString(name) === null) return fail('invalid-field', `${prefix}.name`);
  if (encodeTomlString(source) === null) return fail('invalid-field', `${prefix}.source`);
  if (requestedRef !== null && encodeTomlString(requestedRef) === null) {
    return fail('invalid-field', `${prefix}.requested_ref`);
  }
  if (encodeTomlString(sourcePath) === null) {
    return fail('invalid-field', `${prefix}.source_path`);
  }

  return ok(
    deepFreeze({
      name,
      source,
      requestedRef: requestedRef as string | null,
      resolvedSha,
      sourcePath,
      contentHash: contentHashResult.value,
    }),
  );
};

const validateAndOwnLock = (
  value: unknown,
  serializedShape: boolean,
): Result<PortableLockV1, PortableLockStateError> => {
  try {
    if (!isRecord(value)) return fail('invalid-field', 'root');
    const expectedRoot = serializedShape ? ROOT_KEYS : NORMALIZED_ROOT_KEYS;
    if (!hasOnlyOwnKeys(value, expectedRoot)) return fail('unknown-field', 'root');
    const versionKey = 'version';
    const hashSchemaKey = serializedShape ? 'hash_schema_version' : 'hashSchemaVersion';
    const manifestHashKey = serializedShape ? 'manifest_hash' : 'manifestHash';
    const skillsKey = 'skills';

    if (!(versionKey in value)) return fail('missing-field', 'version');
    if (value[versionKey] !== LOCK_VERSION) return fail('invalid-version', 'version');
    if (!(hashSchemaKey in value)) return fail('missing-field', 'hash_schema_version');
    if (value[hashSchemaKey] !== HASH_SCHEMA_VERSION) {
      return fail('unsupported-hash-schema', 'hash_schema_version');
    }
    if (!(manifestHashKey in value)) return fail('missing-field', 'manifest_hash');
    const manifestHashResult = parseArtifactDigest(value[manifestHashKey]);
    if (!manifestHashResult.ok) return fail('invalid-field', 'manifest_hash');

    if (!serializedShape && !(skillsKey in value)) return fail('missing-field', 'skills');
    const rawSkills = skillsKey in value ? value[skillsKey] : [];
    if (!Array.isArray(rawSkills)) return fail('invalid-field', 'skills');
    const skills: PortableLockSkillV1[] = [];
    const names = new Set<string>();
    for (let index = 0; index < rawSkills.length; index += 1) {
      const result = validateAndOwnSkill(rawSkills[index], index, serializedShape);
      if (!result.ok) return result;
      if (names.has(result.value.name)) return fail('duplicate-name', 'skills[].name');
      names.add(result.value.name);
      skills.push(result.value);
    }
    if (!serializedShape) {
      for (let index = 1; index < skills.length; index += 1) {
        if (compareNames(skills[index - 1]?.name ?? '', skills[index]?.name ?? '') >= 0) {
          return fail('invalid-field', 'skills[].name');
        }
      }
    } else {
      skills.sort((left, right) => compareNames(left.name, right.name));
    }

    return ok(
      deepFreeze({
        version: LOCK_VERSION,
        hashSchemaVersion: HASH_SCHEMA_VERSION,
        manifestHash: manifestHashResult.value,
        skills,
      }),
    );
  } catch {
    return fail('invalid-field', 'root');
  }
};

const serializeOwnedLock = (lock: PortableLockV1): string => {
  const lines = [
    `version = ${LOCK_VERSION}`,
    `hash_schema_version = ${HASH_SCHEMA_VERSION}`,
    `manifest_hash = "${lock.manifestHash}"`,
  ];
  for (const skill of lock.skills) {
    lines.push('', '[[skills]]');
    lines.push(`name = ${encodeTomlString(skill.name) as string}`);
    lines.push(`source = ${encodeTomlString(skill.source) as string}`);
    if (skill.requestedRef !== null) {
      lines.push(`requested_ref = ${encodeTomlString(skill.requestedRef) as string}`);
    }
    lines.push(`resolved_sha = "${skill.resolvedSha}"`);
    lines.push(`source_path = ${encodeTomlString(skill.sourcePath) as string}`);
    lines.push(`content_hash = "${skill.contentHash}"`);
  }
  return `${lines.join('\n')}\n`;
};

/** Read and strictly validate the one canonical portable-lock v1 byte representation. */
export const readPortableLockSource = (
  source: Uint8Array,
): Result<PortableLockV1, PortableLockStateError> => {
  let owned: Uint8Array;
  try {
    owned = new Uint8Array(source);
  } catch {
    return fail('malformed-lock');
  }
  if (owned.byteLength === 0) return fail('empty-lock');
  const hasBom = owned[0] === 0xef && owned[1] === 0xbb && owned[2] === 0xbf;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(owned);
  } catch {
    return fail('malformed-lock');
  }
  if (hasBom) return fail('noncanonical-lock');

  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch {
    return fail('malformed-lock');
  }
  if (!isRecord(raw)) return fail('malformed-lock');
  if (Reflect.ownKeys(raw).length === 0) return fail('empty-lock');

  const versionToken = findRootToken(text, 'version');
  if (
    typeof raw.version !== 'number' ||
    !Number.isSafeInteger(raw.version) ||
    versionToken === null ||
    !INTEGER_TOKEN.test(versionToken) ||
    Number(versionToken) !== raw.version
  ) {
    return fail('invalid-version', 'version');
  }
  if (raw.version !== LOCK_VERSION) return fail('unsupported-lock-version', 'version');

  if (!('hash_schema_version' in raw)) return fail('missing-field', 'hash_schema_version');
  const hashSchemaToken = findRootToken(text, 'hash_schema_version');
  if (
    typeof raw.hash_schema_version !== 'number' ||
    !Number.isSafeInteger(raw.hash_schema_version) ||
    hashSchemaToken === null ||
    !INTEGER_TOKEN.test(hashSchemaToken) ||
    Number(hashSchemaToken) !== raw.hash_schema_version
  ) {
    return fail('invalid-field', 'hash_schema_version');
  }
  if (raw.hash_schema_version !== HASH_SCHEMA_VERSION) {
    return fail('unsupported-hash-schema', 'hash_schema_version');
  }

  const normalized = validateAndOwnLock(raw, true);
  if (!normalized.ok) return normalized;
  const canonical = serializeOwnedLock(normalized.value);
  if (!equalBytes(owned, encoder.encode(canonical))) return fail('noncanonical-lock');
  return normalized;
};

/** Validate and serialize a complete normalized lock as its canonical TOML v1 string. */
export const serializePortableLock = (
  lock: Readonly<PortableLockV1>,
): Result<string, PortableLockStateError> => {
  const normalized = validateAndOwnLock(lock, false);
  return normalized.ok ? ok(serializeOwnedLock(normalized.value)) : normalized;
};

/** Hash the exact canonical lock bytes in the closed lock-canonical v1 domain. */
export const hashPortableLock = (
  lock: Readonly<PortableLockV1>,
): Result<ArtifactDigest, PortableLockStateError> => {
  const serialized = serializePortableLock(lock);
  if (!serialized.ok) return serialized;
  const digest = hashCanonicalInput('lock-canonical', HASH_SCHEMA_VERSION, serialized.value);
  return digest.ok ? ok(digest.value) : fail('invalid-field', 'root');
};

const FACT_RANK: Readonly<Record<PortableLockFact['reason'], number>> = Object.freeze({
  'missing-entry': 0,
  'extra-entry': 1,
  'manifest-hash-mismatch': 2,
  'source-mismatch': 3,
  'requested-ref-mismatch': 4,
  'source-path-mismatch': 5,
});

const sortFacts = <T extends PortableLockFact>(facts: T[]): T[] =>
  facts.sort((left, right) => {
    const rank = FACT_RANK[left.reason] - FACT_RANK[right.reason];
    if (rank !== 0) return rank;
    const leftName = 'name' in left ? left.name : '';
    const rightName = 'name' in right ? right.name : '';
    return compareNames(leftName, rightName);
  });

/** Classify a normalized manifest against an already-normalized portable lock. */
export const correlatePortableLock = (
  manifest: NormalizedManifestV1,
  lock: PortableLockV1 | null,
): PortableLockRelationship => {
  if (lock === null) return Object.freeze({ state: 'missing-lock' });

  const manifestByName = new Map(manifest.skills.map((skill) => [skill.name, skill]));
  const lockByName = new Map(lock.skills.map((skill) => [skill.name, skill]));
  const missingNames = [...manifestByName.keys()]
    .filter((name) => !lockByName.has(name))
    .sort(compareNames);
  const extraNames = [...lockByName.keys()]
    .filter((name) => !manifestByName.has(name))
    .sort(compareNames);

  if (missingNames.length > 0) {
    const facts: IncompleteLockFact[] = [
      ...missingNames.map(
        (name): IncompleteLockFact => ({ reason: 'missing-entry', name, field: 'skills.name' }),
      ),
      ...extraNames.map(
        (name): IncompleteLockFact => ({ reason: 'extra-entry', name, field: 'skills.name' }),
      ),
    ];
    return deepFreeze({ state: 'incomplete', missingNames, facts: sortFacts(facts) });
  }

  const facts: StaleLockFact[] = extraNames.map(
    (name): StaleLockFact => ({ reason: 'extra-entry', name, field: 'skills.name' }),
  );
  if (lock.manifestHash !== hashManifestSemantics(manifest)) {
    facts.push({ reason: 'manifest-hash-mismatch', field: 'manifest_hash' });
  }
  for (const [name, declaration] of manifestByName) {
    const skill = lockByName.get(name);
    if (skill === undefined) continue;
    if (skill.source !== projectLockSource(declaration.source)) {
      facts.push({ reason: 'source-mismatch', name, field: 'source' });
    }
    if (skill.requestedRef !== declaration.ref) {
      facts.push({ reason: 'requested-ref-mismatch', name, field: 'requested_ref' });
    }
    if (skill.sourcePath !== (declaration.source.path ?? '.')) {
      facts.push({ reason: 'source-path-mismatch', name, field: 'source_path' });
    }
  }

  if (facts.length > 0) return deepFreeze({ state: 'stale', facts: sortFacts(facts) });
  return Object.freeze({ state: 'current' });
};
