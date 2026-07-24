import { Buffer } from 'node:buffer';
import { isAbsolute, win32 } from 'node:path';
import { types as utilTypes } from 'node:util';
import { type Result, err, ok } from '../result.ts';
import { decodeArtifactUtf8, ownArtifactBytes } from './codec.ts';
import {
  type ArtifactDigest,
  HASH_SCHEMA_VERSION,
  hashCanonicalInput,
  hashManifestBytes,
  parseArtifactDigest,
} from './hash.ts';
import { readPortableLockSource } from './lock.ts';
import { normalizeManifestDocument, readManifestSource } from './manifest.ts';

export const RETAINED_ARTIFACT_PREIMAGE_KIND = 'skillsmith.retained-artifact-preimage' as const;
export const RETAINED_ARTIFACT_PREIMAGE_VERSION = 1 as const;
export const RETAINED_ARTIFACT_PREIMAGE_MAX_BYTES = 8 * 1024 * 1024;

export type RetainedArtifactRoleV1 = 'manifest' | 'lock';

export interface RetainedArtifactPreimageV1 {
  readonly kind: typeof RETAINED_ARTIFACT_PREIMAGE_KIND;
  readonly version: typeof RETAINED_ARTIFACT_PREIMAGE_VERSION;
  readonly operationId: string;
  readonly role: RetainedArtifactRoleV1;
  readonly path: string;
  readonly before: Readonly<{
    readonly mode: number;
    readonly bytes: Uint8Array;
  }>;
  readonly after: Readonly<{
    readonly digest: ArtifactDigest;
    readonly mode: number;
  }>;
}

export interface RetainedArtifactPreimageInputV1 {
  readonly operationId: string;
  readonly role: RetainedArtifactRoleV1;
  readonly path: string;
  readonly before: Readonly<{
    readonly mode: number;
    readonly bytes: unknown;
  }>;
  readonly after: Readonly<{
    readonly digest: unknown;
    readonly mode: number;
  }>;
}

export interface RetainedArtifactPreimageExpectationV1 {
  readonly operationId: string;
  readonly role: RetainedArtifactRoleV1;
  readonly path: string;
  readonly after?: Readonly<{
    readonly digest: ArtifactDigest;
    readonly mode: number;
  }>;
}

export interface DecodedRetainedArtifactPreimageV1 {
  readonly model: RetainedArtifactPreimageV1;
  readonly encoded: Uint8Array;
  readonly repositoryDigest: ArtifactDigest;
  readonly contentDigest: ArtifactDigest;
}

export type RetainedArtifactPreimageCodecErrorReason =
  | 'malformed'
  | 'invalid-shape'
  | 'unsupported-version'
  | 'noncanonical'
  | 'payload-too-large'
  | 'invalid-manifest'
  | 'invalid-lock'
  | 'expectation-mismatch';

export interface RetainedArtifactPreimageCodecError {
  readonly code: 'retained-preimage-codec';
  readonly reason: RetainedArtifactPreimageCodecErrorReason;
  readonly field:
    | 'root'
    | 'version'
    | 'operationId'
    | 'role'
    | 'path'
    | 'before.mode'
    | 'before.bytes'
    | 'after.digest'
    | 'after.mode';
  readonly exitCode: 3;
  readonly message: string;
}

type JsonRecord = Record<string, unknown>;

const encoder = new TextEncoder();
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'byteLength',
)?.get;
const OPERATION_ID = /^operation:v1:[0-9a-f]{64}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const ROOT_KEYS = ['kind', 'version', 'operationId', 'role', 'path', 'before', 'after'] as const;
const BEFORE_KEYS = ['mode', 'bytes'] as const;
const AFTER_KEYS = ['digest', 'mode'] as const;

const ERROR_MESSAGES: Readonly<Record<RetainedArtifactPreimageCodecErrorReason, string>> =
  Object.freeze({
    malformed: 'retained artifact preimage is malformed',
    'invalid-shape': 'retained artifact preimage shape is invalid',
    'unsupported-version': 'retained artifact preimage version is unsupported',
    noncanonical: 'retained artifact preimage bytes are not canonical',
    'payload-too-large': 'retained artifact preimage payload exceeds the supported limit',
    'invalid-manifest': 'retained manifest preimage is invalid',
    'invalid-lock': 'retained lock preimage is invalid',
    'expectation-mismatch': 'retained artifact preimage does not match its journal authority',
  });

const codecError = (
  reason: RetainedArtifactPreimageCodecErrorReason,
  field: RetainedArtifactPreimageCodecError['field'] = 'root',
): RetainedArtifactPreimageCodecError =>
  Object.freeze({
    code: 'retained-preimage-codec',
    reason,
    field,
    exitCode: 3,
    message: ERROR_MESSAGES[reason],
  });

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const exactKeys = (value: JsonRecord, keys: readonly string[]): boolean =>
  Reflect.ownKeys(value).length === keys.length &&
  Reflect.ownKeys(value).every((key, index) => typeof key === 'string' && key === keys[index]);

const validMode = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0o7777;

const validAbsolutePath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 16_384 &&
  (isAbsolute(value) || win32.isAbsolute(value));

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};

const digest = (domain: 'resource' | 'lock-canonical', bytes: Uint8Array): ArtifactDigest => {
  const hashed = hashCanonicalInput(domain, HASH_SCHEMA_VERSION, bytes);
  if (!hashed.ok) throw new TypeError('closed retained-preimage digest domain was rejected');
  return hashed.value;
};

const contentDigest = (
  role: RetainedArtifactRoleV1,
  bytes: Uint8Array,
): Result<ArtifactDigest, RetainedArtifactPreimageCodecError> => {
  if (role === 'manifest') {
    const decoded = decodeArtifactUtf8('manifest', bytes, 1);
    if (!decoded.ok) return err(codecError('invalid-manifest', 'before.bytes'));
    const document = readManifestSource(decoded.value.source);
    if (!document.ok || !normalizeManifestDocument(document.value).ok) {
      return err(codecError('invalid-manifest', 'before.bytes'));
    }
    return ok(hashManifestBytes(bytes));
  }
  if (!readPortableLockSource(bytes).ok) {
    return err(codecError('invalid-lock', 'before.bytes'));
  }
  return ok(digest('lock-canonical', bytes));
};

const canonicalDto = (model: RetainedArtifactPreimageV1) => ({
  kind: model.kind,
  version: model.version,
  operationId: model.operationId,
  role: model.role,
  path: model.path,
  before: {
    mode: model.before.mode,
    bytes: Buffer.from(model.before.bytes).toString('base64'),
  },
  after: {
    digest: model.after.digest,
    mode: model.after.mode,
  },
});

const encodeCanonical = (model: RetainedArtifactPreimageV1): Uint8Array =>
  encoder.encode(`${JSON.stringify(canonicalDto(model))}\n`);

const ownModel = (
  input: RetainedArtifactPreimageInputV1,
): Result<RetainedArtifactPreimageV1, RetainedArtifactPreimageCodecError> => {
  if (typeof input.operationId !== 'string' || !OPERATION_ID.test(input.operationId)) {
    return err(codecError('invalid-shape', 'operationId'));
  }
  if (input.role !== 'manifest' && input.role !== 'lock') {
    return err(codecError('invalid-shape', 'role'));
  }
  if (!validAbsolutePath(input.path)) return err(codecError('invalid-shape', 'path'));
  if (!validMode(input.before.mode)) return err(codecError('invalid-shape', 'before.mode'));
  if (!validMode(input.after.mode)) return err(codecError('invalid-shape', 'after.mode'));
  const parsedDigest = parseArtifactDigest(input.after.digest);
  if (!parsedDigest.ok) return err(codecError('invalid-shape', 'after.digest'));
  if (
    typeof input.before.bytes === 'object' &&
    input.before.bytes !== null &&
    !utilTypes.isProxy(input.before.bytes) &&
    utilTypes.isUint8Array(input.before.bytes) &&
    Object.getPrototypeOf(input.before.bytes) === Uint8Array.prototype &&
    typedArrayByteLengthGetter !== undefined &&
    (Reflect.apply(typedArrayByteLengthGetter, input.before.bytes, []) as number) >
      RETAINED_ARTIFACT_PREIMAGE_MAX_BYTES
  ) {
    return err(codecError('payload-too-large', 'before.bytes'));
  }
  const ownedBytes = ownArtifactBytes('journal', input.before.bytes, 1);
  if (!ownedBytes.ok) return err(codecError('invalid-shape', 'before.bytes'));
  if (ownedBytes.value.byteLength > RETAINED_ARTIFACT_PREIMAGE_MAX_BYTES) {
    return err(codecError('payload-too-large', 'before.bytes'));
  }
  const validContent = contentDigest(input.role, ownedBytes.value);
  if (!validContent.ok) return validContent;
  return ok(
    Object.freeze({
      kind: RETAINED_ARTIFACT_PREIMAGE_KIND,
      version: RETAINED_ARTIFACT_PREIMAGE_VERSION,
      operationId: input.operationId,
      role: input.role,
      path: input.path,
      before: Object.freeze({ mode: input.before.mode, bytes: ownedBytes.value }),
      after: Object.freeze({ digest: parsedDigest.value, mode: input.after.mode }),
    }),
  );
};

export const encodeRetainedArtifactPreimageV1 = (
  input: RetainedArtifactPreimageInputV1,
): Result<DecodedRetainedArtifactPreimageV1, RetainedArtifactPreimageCodecError> => {
  const model = ownModel(input);
  if (!model.ok) return model;
  const encoded = encodeCanonical(model.value);
  const hashedContent = contentDigest(model.value.role, model.value.before.bytes);
  if (!hashedContent.ok) return hashedContent;
  return ok(
    Object.freeze({
      model: model.value,
      encoded,
      repositoryDigest: digest('resource', encoded),
      contentDigest: hashedContent.value,
    }),
  );
};

const canonicalBase64 = (value: unknown): Uint8Array | null => {
  if (typeof value !== 'string' || !BASE64.test(value)) return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? new Uint8Array(decoded) : null;
};

const matchesExpectation = (
  model: RetainedArtifactPreimageV1,
  expected: RetainedArtifactPreimageExpectationV1,
): boolean =>
  model.operationId === expected.operationId &&
  model.role === expected.role &&
  model.path === expected.path &&
  (expected.after === undefined ||
    (model.after.digest === expected.after.digest && model.after.mode === expected.after.mode));

export const decodeRetainedArtifactPreimageV1 = (
  input: unknown,
  expected: RetainedArtifactPreimageExpectationV1,
): Result<DecodedRetainedArtifactPreimageV1, RetainedArtifactPreimageCodecError> => {
  const decoded = decodeArtifactUtf8('journal', input, 1);
  if (!decoded.ok) return err(codecError('malformed'));
  if (
    decoded.value.bytes.byteLength >
    Math.ceil((RETAINED_ARTIFACT_PREIMAGE_MAX_BYTES * 4) / 3) + 65_536
  ) {
    return err(codecError('payload-too-large', 'before.bytes'));
  }
  let raw: unknown;
  try {
    raw = JSON.parse(decoded.value.source);
  } catch {
    return err(codecError('malformed'));
  }
  if (!isRecord(raw) || !exactKeys(raw, ROOT_KEYS)) {
    return err(codecError('invalid-shape'));
  }
  if (raw.kind !== RETAINED_ARTIFACT_PREIMAGE_KIND) {
    return err(codecError('invalid-shape'));
  }
  if (raw.version !== RETAINED_ARTIFACT_PREIMAGE_VERSION) {
    return err(codecError('unsupported-version', 'version'));
  }
  if (!isRecord(raw.before) || !exactKeys(raw.before, BEFORE_KEYS)) {
    return err(codecError('invalid-shape', 'before.bytes'));
  }
  if (!isRecord(raw.after) || !exactKeys(raw.after, AFTER_KEYS)) {
    return err(codecError('invalid-shape', 'after.digest'));
  }
  const beforeBytes = canonicalBase64(raw.before.bytes);
  if (beforeBytes === null) return err(codecError('noncanonical', 'before.bytes'));
  const encoded = encodeRetainedArtifactPreimageV1({
    operationId: raw.operationId as string,
    role: raw.role as RetainedArtifactRoleV1,
    path: raw.path as string,
    before: { mode: raw.before.mode as number, bytes: beforeBytes },
    after: { digest: raw.after.digest, mode: raw.after.mode as number },
  });
  if (!encoded.ok) return encoded;
  if (!equalBytes(encoded.value.encoded, decoded.value.bytes)) {
    return err(codecError('noncanonical'));
  }
  if (!matchesExpectation(encoded.value.model, expected)) {
    return err(codecError('expectation-mismatch'));
  }
  return encoded;
};
