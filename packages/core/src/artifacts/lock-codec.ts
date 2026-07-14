import { parse as parseToml } from 'smol-toml';
import { type Result, err, ok } from '../result.ts';
import {
  type ArtifactCodec,
  type ArtifactCodecDescriptor,
  type ArtifactCodecError,
  artifactCodecError,
  decodeArtifactUtf8,
  deepOwnFreeze,
  hasSensitiveArtifactContent,
  unsignedUtf16Compare,
} from './codec.ts';
import {
  LOCK_VERSION,
  type PortableLockStateError,
  type PortableLockV1,
  readPortableLockSource,
  serializePortableLock,
} from './lock.ts';

export type LockV1Dto = PortableLockV1;

const encoder = new TextEncoder();

const descriptor = Object.freeze({
  id: 'lock',
  version: 1,
  syntax: 'toml',
  discriminator: Object.freeze({ kind: 'field', field: 'version' }),
  wireKind: null,
  presentation: Object.freeze({ decode: 'canonical', encode: 'canonical' }),
  terminalLf: true,
  unknownFields: 'reject-recursive',
  migrations: Object.freeze([]),
  compatibility: 'conservative',
}) as ArtifactCodecDescriptor<'lock', 1>;

type LockCodecReason = Extract<
  ArtifactCodecError['reason'],
  'malformed' | 'invalid-shape' | 'unsupported-version' | 'noncanonical' | 'sensitive-content'
>;

const fail = (
  reason: LockCodecReason,
  requestedVersion: number | null,
  path: readonly (string | number)[] = [],
): Result<never, ArtifactCodecError> =>
  err(artifactCodecError('lock', requestedVersion, reason, path));

const exactKeys = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

const skillKeys = [
  'name',
  'source',
  'requestedRef',
  'resolvedSha',
  'sourcePath',
  'contentHash',
] as const;

interface NormalizedLock {
  readonly dto: LockV1Dto;
  readonly source: string;
}

const normalizeLock = (input: unknown): Result<NormalizedLock, ArtifactCodecError> => {
  const owned = deepOwnFreeze<Readonly<Record<string, unknown>>>('lock', input);
  if (!owned.ok) return owned;
  const root = owned.value;
  const requestedVersion =
    typeof root.version === 'number' && Number.isSafeInteger(root.version) && root.version > 0
      ? root.version
      : null;
  if (!exactKeys(root, ['version', 'hashSchemaVersion', 'manifestHash', 'skills'])) {
    return fail('invalid-shape', requestedVersion);
  }
  if (root.version !== LOCK_VERSION) {
    return fail(
      requestedVersion === null ? 'invalid-shape' : 'unsupported-version',
      requestedVersion,
      ['version'],
    );
  }
  const skills = root.skills;
  if (!Array.isArray(skills)) return fail('invalid-shape', 1, ['skills']);
  const ownedSkills: Record<string, unknown>[] = [];
  for (let index = 0; index < skills.length; index += 1) {
    const value = skills[index];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return fail('invalid-shape', 1, ['skills', index]);
    }
    const skill = value as Readonly<Record<string, unknown>>;
    if (!exactKeys(skill, skillKeys)) return fail('invalid-shape', 1, ['skills', index]);
    if (typeof skill.name !== 'string') {
      return fail('invalid-shape', 1, ['skills', index, 'name']);
    }
    ownedSkills.push({ ...skill });
  }
  ownedSkills.sort((left, right) =>
    unsignedUtf16Compare(left.name as string, right.name as string),
  );
  const candidate = {
    version: root.version,
    hashSchemaVersion: root.hashSchemaVersion,
    manifestHash: root.manifestHash,
    skills: ownedSkills,
  } as unknown as PortableLockV1;
  const serialized = serializePortableLock(candidate);
  if (!serialized.ok) return mapLockError(serialized.error, null);
  if (hasSensitiveArtifactContent(serialized.value)) return fail('sensitive-content', 1);
  const decoded = readPortableLockSource(encoder.encode(serialized.value));
  if (!decoded.ok) return mapLockError(decoded.error, serialized.value);
  return ok(Object.freeze({ dto: decoded.value, source: serialized.value }));
};

const fieldPath = (field: string | undefined): readonly (string | number)[] => {
  if (field === undefined || field === 'root') return [];
  const match = /^skills\[(\d+|\*)\]\.(.+)$/u.exec(field);
  if (match !== null) {
    const index = match[1] === '*' ? '*' : Number(match[1]);
    return ['skills', index, match[2] as string];
  }
  if (field === 'skills[].name') return ['skills', '*', 'name'];
  return [field];
};

const futureVersion = (source: string | null): number | null => {
  if (source === null) return null;
  try {
    const parsed = parseToml(source) as Readonly<Record<string, unknown>>;
    return typeof parsed.version === 'number' &&
      Number.isSafeInteger(parsed.version) &&
      parsed.version > 0
      ? parsed.version
      : null;
  } catch {
    return null;
  }
};

function mapLockError(
  error: PortableLockStateError,
  source: string | null,
): Result<never, ArtifactCodecError> {
  if (error.reason === 'empty-lock' || error.reason === 'malformed-lock') {
    return fail('malformed', null);
  }
  if (error.reason === 'invalid-version') return fail('invalid-shape', null, ['version']);
  if (error.reason === 'unsupported-lock-version') {
    const version = futureVersion(source);
    return fail('unsupported-version', version, ['version']);
  }
  if (error.reason === 'noncanonical-lock') return fail('noncanonical', 1);
  return fail('invalid-shape', 1, fieldPath(error.field));
}

const validate = (input: unknown): Result<LockV1Dto, ArtifactCodecError> => {
  const normalized = normalizeLock(input);
  return normalized.ok ? ok(normalized.value.dto) : normalized;
};

export const fromLockV1Dto = (dto: LockV1Dto): Result<PortableLockV1, ArtifactCodecError> => {
  const normalized = normalizeLock(dto);
  return normalized.ok ? ok(normalized.value.dto) : normalized;
};

export const toLockV1Dto = (model: PortableLockV1): Result<LockV1Dto, ArtifactCodecError> => {
  const normalized = normalizeLock(model);
  return normalized.ok ? ok(normalized.value.dto) : normalized;
};

const decode = (
  bytes: Uint8Array,
): ReturnType<ArtifactCodec<'lock', 1, LockV1Dto, PortableLockV1>['decode']> => {
  const source = decodeArtifactUtf8('lock', bytes);
  if (!source.ok) return source;
  const decoded = readPortableLockSource(source.value.bytes);
  if (!decoded.ok) {
    if (!source.value.source.endsWith('\n')) {
      const withTerminalLf = readPortableLockSource(encoder.encode(`${source.value.source}\n`));
      if (withTerminalLf.ok) return fail('noncanonical', 1);
    }
    return mapLockError(decoded.error, source.value.source);
  }
  if (hasSensitiveArtifactContent(source.value.source)) return fail('sensitive-content', 1);
  return ok(
    Object.freeze({
      source: Object.freeze({ kind: 'version', version: 1 }),
      model: decoded.value,
      canonical: true,
      migration: null,
    }),
  );
};

const encode = (model: PortableLockV1): Result<Uint8Array, ArtifactCodecError> => {
  const normalized = normalizeLock(model);
  return normalized.ok ? ok(encoder.encode(normalized.value.source)) : normalized;
};

export const lockV1Codec = Object.freeze({
  descriptor,
  validate,
  fromDto: fromLockV1Dto,
  toDto: toLockV1Dto,
  decode,
  encode,
}) satisfies ArtifactCodec<'lock', 1, LockV1Dto, PortableLockV1>;
