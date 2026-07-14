import { Buffer } from 'node:buffer';
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

export interface DecodedArtifact<Model = unknown> {
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
const ARTIFACT_SENSITIVE_CANARY = 'P17_SECRET_CANARY';
const staticErrorPaths = (fields: string): ReadonlySet<string> => new Set(fields.split(' '));
const STATIC_ERROR_PATHS: Readonly<Record<ArtifactId, ReadonlySet<string>>> = Object.freeze({
  manifest: staticErrorPaths(
    '* version defaults tools scope path registry default skills name source ref placement',
  ),
  lock: staticErrorPaths(
    '* version hashSchemaVersion manifestHash skills name source requestedRef resolvedSha sourcePath contentHash',
  ),
  plan: staticErrorPaths(
    '* schemaVersion kind skillsmithVersion executorSchemaVersion hashSchemaVersion portability artifactPair manifestSemanticHash lockCanonicalHash options selection operations checks diagnostics resourcePreconditions selectionPreconditions capabilityPreconditions reasons manifest lock lockSource prune locked selectionSource skills tools scopes operationId groupId pairId dependsOn skill source tool scope before after reason preconditionIds requiredCheckIds reversibility mutates conflict resource classification representation linkTarget dangling contentHash location shape version byteHash semanticHash value projectRoot identity host repository path requestedRef resolvedSha sourcePath defaults registry default name ref placement manifestHash expectedState expectedHash expectedRevision domain digest members resourceHash operation capabilityVersion supported live ledger retentionResourceIds code message class normal forced target backup checkId blocking operationIds capabilityPreconditionId expectedContentHash mode diagnosticId severity refusalClass affected correlation unexpected',
  ),
  ledger: staticErrorPaths(
    '* schemaVersion kind updatedAt skills projects projectRegistrations transactions history tools placementPath mode dev sourcePath resolvedPath repoRoot sourceRelPath remote recordedAt pinned storePath rev gitSha dirty contentHash snapshotAt verify placement origin source host repo skillPath refRequested refResolved pin installedAt journal op txId phase startedAt completedAt before liveKind symlinkTarget stagingPath backupPath consumers skill tool store path transactionId',
  ),
  journal: staticErrorPaths(
    '* schemaVersion kind transactionId intent context parentOperationId command workflow attempt startedAt disposition phase actual before after retained resourceId role state repositoryRevision placementPath liveKind mode symlinkTarget contentHash location shape version byteHash semanticHash canonicalHash projectRoot sourceRole path retainUntil updatedAt completedAt digest',
  ),
});
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'byteLength',
)?.get;
const copyUint8Array = Uint8Array.prototype.set;

type OwnedByteViewKind = 'filesystem-buffer' | 'uint8array';

const ownExactByteView = (
  artifactId: ArtifactId,
  input: unknown,
  requestedVersion: number | null,
  kind: OwnedByteViewKind,
): Result<Uint8Array, ArtifactCodecError> => {
  try {
    if (typeof input !== 'object' || input === null || utilTypes.isProxy(input)) {
      return err(artifactCodecError(artifactId, requestedVersion, 'malformed'));
    }
    const exactView =
      kind === 'filesystem-buffer'
        ? Buffer.isBuffer(input) && Object.getPrototypeOf(input) === Buffer.prototype
        : utilTypes.isUint8Array(input) && Object.getPrototypeOf(input) === Uint8Array.prototype;
    if (
      !exactView ||
      typedArrayBufferGetter === undefined ||
      typedArrayByteLengthGetter === undefined
    ) {
      return err(artifactCodecError(artifactId, requestedVersion, 'malformed'));
    }
    const buffer = Reflect.apply(typedArrayBufferGetter, input, []) as ArrayBufferLike;
    const byteLength = Reflect.apply(typedArrayByteLengthGetter, input, []) as number;
    const keys = Reflect.ownKeys(input);
    if (
      !utilTypes.isArrayBuffer(buffer) ||
      utilTypes.isSharedArrayBuffer(buffer) ||
      Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < 0 ||
      keys.length !== byteLength ||
      keys.some((key, index) => typeof key !== 'string' || key !== String(index))
    ) {
      return err(artifactCodecError(artifactId, requestedVersion, 'malformed'));
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    for (let index = 0; index < byteLength; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !('value' in descriptor) ||
        typeof descriptor.value !== 'number' ||
        !Number.isInteger(descriptor.value) ||
        descriptor.value < 0 ||
        descriptor.value > 255 ||
        descriptor.writable !== true ||
        descriptor.enumerable !== true ||
        descriptor.configurable !== true
      ) {
        return err(artifactCodecError(artifactId, requestedVersion, 'malformed'));
      }
    }
    const owned = new Uint8Array(byteLength);
    Reflect.apply(copyUint8Array, owned, [input]);
    return ok(owned);
  } catch {
    return err(artifactCodecError(artifactId, requestedVersion, 'malformed'));
  }
};

const boundedOwnPath = (path: readonly (string | number)[]): readonly (string | number)[] =>
  Object.freeze(
    path.slice(0, MAX_ERROR_PATH).map((segment) =>
      typeof segment === 'number' && Number.isSafeInteger(segment) && segment >= 0
        ? segment
        : typeof segment === 'string' &&
            segment.length > 0 &&
            segment.length <= 64 &&
            !segment.includes(ARTIFACT_SENSITIVE_CANARY) &&
            !containsSensitiveMaterial(segment) &&
            ![...segment].some((character) => {
              const point = character.codePointAt(0) ?? 0;
              return point <= 0x1f || point === 0x7f;
            })
          ? segment
          : '*',
    ),
  );

/** Keep only numeric indexes and artifact-schema segments in externally visible error paths. */
export const sanitizeArtifactErrorPath = (
  artifactId: ArtifactId,
  path: readonly (string | number)[],
): readonly (string | number)[] =>
  Object.freeze(
    boundedOwnPath(path).map((segment) =>
      typeof segment === 'number' || STATIC_ERROR_PATHS[artifactId].has(segment) ? segment : '*',
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
    path: sanitizeArtifactErrorPath(artifactId, path),
    exitCode: 3 as const,
    message: ERROR_MESSAGES[reason],
  });

/** Own a plain, non-shared byte view without retaining caller storage. */
export const ownArtifactBytes = (
  artifactId: ArtifactId,
  input: unknown,
  requestedVersion: number | null = null,
): Result<Uint8Array, ArtifactCodecError> =>
  ownExactByteView(artifactId, input, requestedVersion, 'uint8array');

/**
 * Filesystem reads return Node Buffers. Keep the public byte-ownership guard
 * strict while allowing the decode boundary to copy an exact, non-shared
 * Buffer without consulting caller-defined properties.
 */
const ownFilesystemBufferBytes = (
  artifactId: ArtifactId,
  input: unknown,
  requestedVersion: number | null,
): Result<Uint8Array, ArtifactCodecError> =>
  ownExactByteView(artifactId, input, requestedVersion, 'filesystem-buffer');

/** Copy exact bytes returned by the filesystem port without relaxing the public ownership guard. */
export const ownArtifactReadBytes = (
  artifactId: ArtifactId,
  input: unknown,
  requestedVersion: number | null = null,
): Result<Uint8Array, ArtifactCodecError> => {
  const strictBytes = ownArtifactBytes(artifactId, input, requestedVersion);
  return strictBytes.ok
    ? strictBytes
    : ownFilesystemBufferBytes(artifactId, input, requestedVersion);
};

/** Fatal UTF-8 decode with BOM rejection, returning both owned bytes and source text. */
export const decodeArtifactUtf8 = (
  artifactId: ArtifactId,
  input: unknown,
  requestedVersion: number | null = null,
): Result<Readonly<{ bytes: Uint8Array; source: string }>, ArtifactCodecError> => {
  const owned = ownArtifactReadBytes(artifactId, input, requestedVersion);
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
    if (nodes > MAX_NODES || depth > MAX_DEPTH) throw Object.freeze({ path: boundedOwnPath(path) });
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      return value;
    }
    if (typeof value !== 'object' || utilTypes.isProxy(value)) {
      throw Object.freeze({ path: boundedOwnPath(path) });
    }
    if (ancestors.has(value)) throw Object.freeze({ path: boundedOwnPath(path) });

    const proto = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (proto !== Array.prototype) throw Object.freeze({ path: boundedOwnPath(path) });
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const length = Object.getOwnPropertyDescriptor(value, 'length');
      if (!length || !('value' in length) || length.value !== value.length) {
        throw Object.freeze({ path: boundedOwnPath(path) });
      }
      const keys = Reflect.ownKeys(descriptors);
      if (
        keys.some(
          (key) =>
            typeof key !== 'string' || (key !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(key)),
        )
      ) {
        throw Object.freeze({ path: boundedOwnPath(path) });
      }
      ancestors.add(value);
      const output: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || descriptor.enumerable !== true || !('value' in descriptor)) {
          ancestors.delete(value);
          throw Object.freeze({ path: boundedOwnPath([...path, index]) });
        }
        output.push(visit(descriptor.value, [...path, index], depth + 1));
      }
      ancestors.delete(value);
      return Object.freeze(output);
    }

    if (proto !== Object.prototype && proto !== null) {
      throw Object.freeze({ path: boundedOwnPath(path) });
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== 'string')) {
      throw Object.freeze({ path: boundedOwnPath(path) });
    }
    ancestors.add(value);
    const output: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.enumerable !== true || !('value' in descriptor)) {
        ancestors.delete(value);
        throw Object.freeze({ path: boundedOwnPath([...path, key]) });
      }
      Object.defineProperty(output, key, {
        value: visit(descriptor.value, [...path, key], depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
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
    return err(Object.freeze({ path: boundedOwnPath(path) }));
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
    if (
      typeof value === 'string' &&
      (value.includes(ARTIFACT_SENSITIVE_CANARY) || containsSensitiveMaterial(value))
    ) {
      return true;
    }
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) pending.push(value[index]);
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        if (key.includes(ARTIFACT_SENSITIVE_CANARY) || containsSensitiveMaterial(key)) return true;
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
