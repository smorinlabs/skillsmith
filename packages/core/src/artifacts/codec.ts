import { types as utilTypes } from 'node:util';
import { type Result, err, ok } from '../result.ts';
import { containsSensitiveMaterial } from '../safety/redaction.ts';

export type ArtifactId = 'manifest' | 'lock' | 'plan' | 'ledger' | 'journal';
export type ArtifactSource =
  | { readonly kind: 'version'; readonly version: number }
  | { readonly kind: 'shape'; readonly id: 'legacy-project-config' };
export type ArtifactDiscriminator =
  | { readonly kind: 'field'; readonly field: 'version' | 'schemaVersion' }
  | { readonly kind: 'classifier'; readonly id: 'manifest-v1-or-legacy-project-config' };
export type ArtifactMapperId = 'legacy-project-config-to-manifest-v1' | 'ledger-v1-to-v2';

export interface ArtifactMigrationDescriptor {
  readonly source: ArtifactSource;
  readonly targetVersion: number;
  readonly mapperId: ArtifactMapperId;
}

export interface ArtifactCodecDescriptor<
  Id extends ArtifactId = ArtifactId,
  Version extends number = number,
> {
  readonly id: Id;
  readonly version: Version;
  readonly syntax: 'json' | 'toml';
  readonly discriminator: ArtifactDiscriminator;
  readonly wireKind: string | null;
  readonly presentation: {
    readonly decode: 'human' | 'canonical';
    readonly encode: 'canonical' | 'compatibility';
  };
  readonly terminalLf: boolean;
  readonly unknownFields: 'reject-recursive';
  readonly migrations: readonly ArtifactMigrationDescriptor[];
  readonly compatibility: 'conservative';
}

export interface ArtifactMigrationInfo {
  readonly mapperId: ArtifactMapperId;
  readonly targetVersion: number;
}

export interface DecodedArtifact<Model> {
  readonly source: ArtifactSource;
  readonly model: Model;
  readonly canonical: boolean;
  readonly migration: ArtifactMigrationInfo | null;
}

export type ArtifactCodecErrorReason =
  | 'malformed'
  | 'invalid-shape'
  | 'unsupported-version'
  | 'migration-failed'
  | 'noncanonical'
  | 'sensitive-content';

export interface ArtifactCodecError {
  readonly code: 'artifact-codec';
  readonly artifactId: ArtifactId;
  readonly requestedVersion: number | null;
  readonly reason: ArtifactCodecErrorReason;
  readonly path: readonly (string | number)[];
  readonly exitCode: 3;
  readonly message: string;
}

export interface ArtifactCodec<
  Id extends ArtifactId = ArtifactId,
  Version extends number = number,
  Dto = unknown,
  Model = unknown,
> {
  readonly descriptor: ArtifactCodecDescriptor<Id, Version>;
  validate(input: unknown): Result<Dto, ArtifactCodecError>;
  fromDto(dto: Dto): Result<Model, ArtifactCodecError>;
  toDto(model: Model): Result<Dto, ArtifactCodecError>;
  decode(bytes: Uint8Array): Result<DecodedArtifact<Model>, ArtifactCodecError>;
  encode(model: Model): Result<Uint8Array, ArtifactCodecError>;
}

export interface ArtifactContractRegistry {
  readonly codecs: readonly ArtifactCodec[];
  get(id: ArtifactId, version: number): ArtifactCodec | undefined;
  latest(id: ArtifactId): ArtifactCodec | undefined;
}

const ERROR_MESSAGES: Readonly<Record<ArtifactCodecErrorReason, string>> = Object.freeze({
  malformed: 'artifact source is malformed',
  'invalid-shape': 'artifact shape is invalid',
  'unsupported-version': 'artifact version is not supported',
  'migration-failed': 'artifact migration failed',
  noncanonical: 'artifact bytes are not canonical',
  'sensitive-content': 'artifact contains sensitive content',
});
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const MAX_DEPTH = 64;
const MAX_NODES = 16_384;
const MAX_ERROR_PATH = 16;

const safePath = (path: readonly (string | number)[]): readonly (string | number)[] =>
  Object.freeze(
    path
      .slice(0, MAX_ERROR_PATH)
      .map((segment) =>
        typeof segment === 'number' && Number.isSafeInteger(segment) && segment >= 0
          ? segment
          : typeof segment === 'string' && segment.length > 0 && segment.length <= 64
            ? segment
            : '*',
      ),
  );

export const artifactCodecError = (
  artifactId: ArtifactId,
  requestedVersion: number | null,
  reason: ArtifactCodecErrorReason,
  path: readonly (string | number)[] = [],
): ArtifactCodecError =>
  Object.freeze({
    code: 'artifact-codec' as const,
    artifactId,
    requestedVersion:
      requestedVersion !== null && Number.isSafeInteger(requestedVersion) && requestedVersion > 0
        ? requestedVersion
        : null,
    reason,
    path: safePath(path),
    exitCode: 3 as const,
    message: ERROR_MESSAGES[reason],
  });

const isSharedView = (value: Uint8Array): boolean =>
  typeof SharedArrayBuffer !== 'undefined' && value.buffer instanceof SharedArrayBuffer;

/** Own a plain, non-shared byte view without retaining caller storage. */
export const ownArtifactBytes = (
  artifactId: ArtifactId,
  input: unknown,
  requestedVersion: number | null = null,
): Result<Uint8Array, ArtifactCodecError> => {
  if (
    typeof input !== 'object' ||
    input === null ||
    utilTypes.isProxy(input) ||
    !utilTypes.isUint8Array(input) ||
    Object.getPrototypeOf(input) !== Uint8Array.prototype ||
    isSharedView(input)
  ) {
    return err(artifactCodecError(artifactId, requestedVersion, 'malformed'));
  }
  return ok(new Uint8Array(input));
};

/** Fatal UTF-8 decode with BOM rejection, returning both owned bytes and source text. */
export const decodeArtifactUtf8 = (
  artifactId: ArtifactId,
  input: unknown,
  requestedVersion: number | null = null,
): Result<Readonly<{ bytes: Uint8Array; source: string }>, ArtifactCodecError> => {
  const owned = ownArtifactBytes(artifactId, input, requestedVersion);
  if (!owned.ok) return owned;
  if (
    owned.value.length >= 3 &&
    owned.value[0] === 0xef &&
    owned.value[1] === 0xbb &&
    owned.value[2] === 0xbf
  ) {
    return err(artifactCodecError(artifactId, requestedVersion, 'malformed'));
  }
  try {
    return ok(Object.freeze({ bytes: owned.value, source: decoder.decode(owned.value) }));
  } catch {
    return err(artifactCodecError(artifactId, requestedVersion, 'malformed'));
  }
};

type OwnFailure = Readonly<{ path: readonly (string | number)[] }>;

const ownPlainData = (input: unknown): Result<unknown, OwnFailure> => {
  let nodes = 0;
  const ancestors = new WeakSet<object>();

  const visit = (value: unknown, path: readonly (string | number)[], depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) throw Object.freeze({ path: safePath(path) });
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      return value;
    }
    if (typeof value !== 'object' || utilTypes.isProxy(value)) {
      throw Object.freeze({ path: safePath(path) });
    }
    if (ancestors.has(value)) throw Object.freeze({ path: safePath(path) });

    const proto = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (proto !== Array.prototype) throw Object.freeze({ path: safePath(path) });
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const length = descriptors.length;
      if (!length || !('value' in length) || length.value !== value.length) {
        throw Object.freeze({ path: safePath(path) });
      }
      const keys = Reflect.ownKeys(descriptors);
      if (
        keys.some(
          (key) =>
            typeof key !== 'string' || (key !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(key)),
        )
      ) {
        throw Object.freeze({ path: safePath(path) });
      }
      ancestors.add(value);
      const output: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || descriptor.enumerable !== true || !('value' in descriptor)) {
          ancestors.delete(value);
          throw Object.freeze({ path: safePath([...path, index]) });
        }
        output.push(visit(descriptor.value, [...path, index], depth + 1));
      }
      ancestors.delete(value);
      return Object.freeze(output);
    }

    if (proto !== Object.prototype && proto !== null) {
      throw Object.freeze({ path: safePath(path) });
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== 'string')) {
      throw Object.freeze({ path: safePath(path) });
    }
    ancestors.add(value);
    const output: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.enumerable !== true || !('value' in descriptor)) {
        ancestors.delete(value);
        throw Object.freeze({ path: safePath([...path, key]) });
      }
      output[key] = visit(descriptor.value, [...path, key], depth + 1);
    }
    ancestors.delete(value);
    return Object.freeze(output);
  };

  try {
    return ok(visit(input, [], 0));
  } catch (failure) {
    const path =
      typeof failure === 'object' &&
      failure !== null &&
      !utilTypes.isProxy(failure) &&
      Object.getPrototypeOf(failure) === Object.prototype &&
      Array.isArray(Object.getOwnPropertyDescriptor(failure, 'path')?.value)
        ? (Object.getOwnPropertyDescriptor(failure, 'path')?.value as readonly (string | number)[])
        : [];
    return err(Object.freeze({ path: safePath(path) }));
  }
};

/** Copy and deeply freeze JSON-like ordinary data without invoking caller code. */
export const deepOwnFreeze = <T>(
  artifactId: ArtifactId,
  input: unknown,
  requestedVersion: number | null = null,
): Result<T, ArtifactCodecError> => {
  const owned = ownPlainData(input);
  return owned.ok
    ? ok(owned.value as T)
    : err(artifactCodecError(artifactId, requestedVersion, 'invalid-shape', owned.error.path));
};

export const validatePlainData = deepOwnFreeze;

/** Fail-closed sensitive scan over already-safe or hostile unknown data. */
export const hasSensitiveArtifactContent = (input: unknown): boolean => {
  const owned = ownPlainData(input);
  if (!owned.ok) return true;
  const pending: unknown[] = [owned.value];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === 'string' && containsSensitiveMaterial(value)) return true;
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) pending.push(value[index]);
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        if (containsSensitiveMaterial(key)) return true;
        pending.push(child);
      }
    }
  }
  return false;
};

export const unsignedUtf16Compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** Serialize a field-enumerated DTO using the persisted JSON framing contract. */
export const canonicalJsonBytes = (
  artifactId: ArtifactId,
  input: unknown,
  requestedVersion: number | null,
  terminalLf: boolean,
): Result<Uint8Array, ArtifactCodecError> => {
  const owned = deepOwnFreeze<unknown>(artifactId, input, requestedVersion);
  if (!owned.ok) return owned;
  if (hasSensitiveArtifactContent(owned.value)) {
    return err(artifactCodecError(artifactId, requestedVersion, 'sensitive-content'));
  }
  const source = JSON.stringify(owned.value, null, 2);
  if (typeof source !== 'string') {
    return err(artifactCodecError(artifactId, requestedVersion, 'invalid-shape'));
  }
  return ok(encoder.encode(terminalLf ? `${source}\n` : source));
};
