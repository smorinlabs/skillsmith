import { types as utilTypes } from 'node:util';
import { SUPPORTED_TOOLS } from '../agents/registry.ts';
import { type Result, err, ok } from '../result.ts';
import { containsSensitiveMaterial } from '../safety/redaction.ts';
import { type ArtifactDigest, hashManifestBytes, hashManifestSemantics } from './hash.ts';
import { renderHumanTomlString, renderHumanTomlStringArray, scanHumanToml } from './human-toml.ts';
import { normalizePortablePath, normalizeRegistryIdentity } from './identity.ts';
import { type LegacyManifestMigration, migrateLegacyManifestBytes } from './legacy-migration.ts';
import {
  classifyManifestSource,
  normalizeManifestDocument,
  projectManifestSemantics,
  readManifestSource,
} from './manifest.ts';
import type {
  ManifestScope,
  ManifestShape,
  ManifestTool,
  NormalizedManifestDefaults,
  NormalizedManifestV1,
} from './types.ts';

export const INIT_MANIFEST_OPERATION_KINDS = Object.freeze([
  'create-manifest',
  'replace-manifest',
  'migrate-project-config',
  'noop',
] as const);

export interface InitManifestDefaultsInput {
  readonly tools?: readonly ManifestTool[];
  readonly scope?: ManifestScope;
  readonly path?: string;
}

export interface InitManifestSkeletonInput {
  readonly defaults?: InitManifestDefaultsInput;
  readonly registry?: Readonly<{ readonly default: string }>;
}

export type InitManifestIntentField =
  | 'defaults.tools'
  | 'defaults.scope'
  | 'defaults.path'
  | 'registry.default';

export interface InitManifestLegacyIntentInput {
  readonly requireMatch: readonly InitManifestIntentField[];
}

export type InitManifestCurrentInput =
  | Readonly<{ readonly state: 'absent' }>
  | Readonly<{ readonly state: 'present'; readonly bytes: Uint8Array }>;

export interface InitManifestRequest {
  readonly skeleton: InitManifestSkeletonInput;
  readonly current: InitManifestCurrentInput;
  readonly legacyIntent: InitManifestLegacyIntentInput;
  readonly force: boolean;
}

export interface InitManifestBeforeImage {
  readonly byteHash: ArtifactDigest;
  readonly semanticHash: ArtifactDigest | null;
  readonly shape: ManifestShape;
}

export interface InitManifestWriteImage {
  readonly source: string;
  readonly byteHash: ArtifactDigest;
  readonly semanticHash: ArtifactDigest;
  readonly shape: 'canonical';
}

export type InitManifestOperationInput =
  | Readonly<{
      readonly kind: 'create-manifest';
      readonly before: null;
      readonly after: InitManifestWriteImage;
    }>
  | Readonly<{
      readonly kind: 'replace-manifest' | 'migrate-project-config';
      readonly before: InitManifestBeforeImage;
      readonly after: InitManifestWriteImage;
    }>
  | Readonly<{
      readonly kind: 'noop';
      readonly before: InitManifestBeforeImage;
      readonly after: null;
    }>;

type InitManifestRefusalField =
  | 'skeleton'
  | 'skeleton.defaults'
  | 'skeleton.defaults.tools'
  | 'skeleton.defaults.scope'
  | 'skeleton.defaults.path'
  | 'skeleton.registry.default'
  | 'current'
  | 'current.bytes'
  | 'legacyIntent'
  | 'legacyIntent.requireMatch'
  | 'force';

export interface InitManifestRefusal {
  readonly code: 'init-manifest';
  readonly exitCode: 2 | 3;
  readonly reason:
    | 'invalid-request'
    | 'existing-manifest'
    | 'future-manifest'
    | 'legacy-intent-conflict'
    | 'unsafe-legacy-migration';
  readonly field?:
    | 'skeleton'
    | 'skeleton.defaults'
    | 'skeleton.defaults.tools'
    | 'skeleton.defaults.scope'
    | 'skeleton.defaults.path'
    | 'skeleton.registry.default'
    | 'current'
    | 'current.bytes'
    | 'legacyIntent'
    | 'legacyIntent.requireMatch'
    | 'force';
  readonly shape?: ManifestShape;
  readonly message: string;
}

interface NormalizedSkeleton {
  readonly defaults?: NormalizedManifestDefaults;
  readonly registry?: Readonly<{ readonly default: string }>;
}

interface ValidatedRequest {
  readonly skeleton: NormalizedSkeleton;
  readonly current:
    | Readonly<{ readonly state: 'absent' }>
    | Readonly<{ readonly state: 'present'; readonly bytes: Uint8Array }>;
  readonly requireMatch: readonly InitManifestIntentField[];
  readonly force: boolean;
}

const INTENT_FIELDS = Object.freeze([
  'defaults.tools',
  'defaults.scope',
  'defaults.path',
  'registry.default',
] as const satisfies readonly InitManifestIntentField[]);
const INTENT_FIELD_INDEX = new Map<string, number>(
  INTENT_FIELDS.map((field, index) => [field, index]),
);
const MANIFEST_TOOLS: ReadonlySet<string> = new Set(SUPPORTED_TOOLS);
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get;
const typedArrayLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'length')?.get;
const typedArraySet = Uint8Array.prototype.set;

class InitManifestInvariantError extends Error {}

const REFUSAL_MESSAGES = Object.freeze({
  'invalid-request': 'init manifest request is invalid',
  'existing-manifest': 'init manifest already exists and requires force',
  'future-manifest': 'init manifest uses a newer unsupported schema',
  'legacy-intent-conflict': 'legacy project configuration conflicts with requested init defaults',
  'unsafe-legacy-migration': 'legacy project configuration cannot be migrated safely',
} as const);

const refusal = (
  reason: InitManifestRefusal['reason'],
  options: Readonly<{
    field?: InitManifestRefusalField;
    shape?: ManifestShape;
  }> = {},
): InitManifestRefusal =>
  Object.freeze({
    code: 'init-manifest',
    exitCode: reason === 'invalid-request' ? 2 : 3,
    reason,
    ...(options.field === undefined ? {} : { field: options.field }),
    ...(options.shape === undefined ? {} : { shape: options.shape }),
    message: REFUSAL_MESSAGES[reason],
  });

const invalid = (field?: InitManifestRefusalField): Result<never, InitManifestRefusal> =>
  err(refusal('invalid-request', field === undefined ? {} : { field }));

const isOrdinaryObject = (value: unknown): value is Record<string, unknown> => {
  if (
    typeof value !== 'object' ||
    value === null ||
    utilTypes.isProxy(value) ||
    Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const ownData = (
  value: unknown,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): Readonly<Record<string, unknown>> | null => {
  if (!isOrdinaryObject(value) || Object.getOwnPropertySymbols(value).length > 0) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (
    keys.some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(descriptors, key))
  ) {
    return null;
  }
  const copied: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !('value' in descriptor)) return null;
    copied[key] = descriptor.value;
  }
  return copied;
};

const ownArray = (value: unknown): readonly unknown[] | null => {
  if (
    utilTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    return null;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined ||
    !('value' in lengthDescriptor) ||
    typeof lengthDescriptor.value !== 'number' ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > 10_000
  ) {
    return null;
  }
  const length = lengthDescriptor.value;
  const keys = Object.keys(descriptors).filter((key) => key !== 'length');
  if (
    keys.length !== length ||
    keys.some((key) => !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length)
  ) {
    return null;
  }
  const copied: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !('value' in descriptor)) return null;
    copied.push(descriptor.value);
  }
  return copied;
};

const ownBytes = (value: unknown): Uint8Array | null => {
  try {
    if (
      typeof value !== 'object' ||
      value === null ||
      utilTypes.isProxy(value) ||
      !utilTypes.isUint8Array(value) ||
      Object.getPrototypeOf(value) !== Uint8Array.prototype ||
      Object.getOwnPropertySymbols(value).length > 0 ||
      typedArrayBufferGetter === undefined ||
      typedArrayLengthGetter === undefined
    ) {
      return null;
    }
    const buffer = Reflect.apply(typedArrayBufferGetter, value, []) as unknown;
    if (
      typeof buffer !== 'object' ||
      buffer === null ||
      !utilTypes.isArrayBuffer(buffer) ||
      utilTypes.isSharedArrayBuffer(buffer) ||
      Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype
    ) {
      return null;
    }
    const length = Reflect.apply(typedArrayLengthGetter, value, []) as unknown;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (
      keys.length !== length ||
      keys.some((key) => !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length)
    ) {
      return null;
    }
    for (let index = 0; index < length; index += 1) {
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
        return null;
      }
    }
    const owned = new Uint8Array(length);
    Reflect.apply(typedArraySet, owned, [value]);
    return owned;
  } catch {
    return null;
  }
};

const normalizedTools = (value: unknown): readonly ManifestTool[] | null => {
  const tools = ownArray(value);
  if (
    tools === null ||
    tools.length === 0 ||
    tools.some((tool) => typeof tool !== 'string' || !MANIFEST_TOOLS.has(tool)) ||
    new Set(tools).size !== tools.length
  ) {
    return null;
  }
  return Object.freeze([...tools].sort()) as readonly ManifestTool[];
};

const validateSkeleton = (value: unknown): Result<NormalizedSkeleton, InitManifestRefusal> => {
  const skeleton = ownData(value, ['defaults', 'registry'], []);
  if (skeleton === null) return invalid('skeleton');

  let defaults: NormalizedManifestDefaults | undefined;
  if (Object.hasOwn(skeleton, 'defaults')) {
    if (skeleton.defaults === undefined) return invalid('skeleton.defaults');
    const rawDefaults = ownData(skeleton.defaults, ['tools', 'scope', 'path'], []);
    if (rawDefaults === null) return invalid('skeleton.defaults');
    let tools: readonly ManifestTool[] | undefined;
    let scope: ManifestScope | undefined;
    let path: string | undefined;
    if (Object.hasOwn(rawDefaults, 'tools')) {
      if (rawDefaults.tools === undefined) return invalid('skeleton.defaults.tools');
      tools = normalizedTools(rawDefaults.tools) ?? undefined;
      if (tools === undefined) return invalid('skeleton.defaults.tools');
    }
    if (Object.hasOwn(rawDefaults, 'scope')) {
      if (rawDefaults.scope !== 'user' && rawDefaults.scope !== 'project') {
        return invalid('skeleton.defaults.scope');
      }
      scope = rawDefaults.scope;
    }
    if (Object.hasOwn(rawDefaults, 'path')) {
      if (typeof rawDefaults.path !== 'string' || scope === undefined) {
        return invalid('skeleton.defaults.path');
      }
      const result = normalizePortablePath(rawDefaults.path, scope, 'skeleton.defaults.path');
      if (!result.ok) return invalid('skeleton.defaults.path');
      path = result.value;
    }
    if (tools !== undefined || scope !== undefined || path !== undefined) {
      defaults = Object.freeze({
        ...(tools === undefined ? {} : { tools }),
        ...(scope === undefined ? {} : { scope }),
        ...(path === undefined ? {} : { path }),
      });
    }
  }

  let registry: Readonly<{ readonly default: string }> | undefined;
  if (Object.hasOwn(skeleton, 'registry')) {
    if (skeleton.registry === undefined) return invalid('skeleton.registry.default');
    const rawRegistry = ownData(skeleton.registry, ['default']);
    if (rawRegistry === null || typeof rawRegistry.default !== 'string') {
      return invalid('skeleton.registry.default');
    }
    const result = normalizeRegistryIdentity(rawRegistry.default, {}, 'skeleton.registry.default');
    if (!result.ok) return invalid('skeleton.registry.default');
    registry = Object.freeze({ default: result.value });
  }

  return ok(
    Object.freeze({
      ...(defaults === undefined ? {} : { defaults }),
      ...(registry === undefined ? {} : { registry }),
    }),
  );
};

const hasSkeletonField = (
  skeleton: NormalizedSkeleton,
  field: InitManifestIntentField,
): boolean => {
  switch (field) {
    case 'defaults.tools':
      return skeleton.defaults?.tools !== undefined;
    case 'defaults.scope':
      return skeleton.defaults?.scope !== undefined;
    case 'defaults.path':
      return skeleton.defaults?.path !== undefined;
    case 'registry.default':
      return skeleton.registry?.default !== undefined;
  }
};

const validateRequest = (input: unknown): Result<ValidatedRequest, InitManifestRefusal> => {
  const request = ownData(input, ['skeleton', 'current', 'legacyIntent', 'force']);
  if (request === null) {
    const partial = ownData(input, ['skeleton', 'current', 'legacyIntent', 'force'], []);
    if (partial !== null) {
      if (!Object.hasOwn(partial, 'skeleton')) return invalid('skeleton');
      if (!Object.hasOwn(partial, 'current')) return invalid('current');
      if (!Object.hasOwn(partial, 'legacyIntent')) return invalid('legacyIntent');
      if (!Object.hasOwn(partial, 'force')) return invalid('force');
    }
    return invalid();
  }

  const skeletonResult = validateSkeleton(request.skeleton);
  if (!skeletonResult.ok) return skeletonResult;

  const currentState = ownData(request.current, ['state', 'bytes'], ['state']);
  if (currentState === null) return invalid('current');
  let current: ValidatedRequest['current'];
  if (currentState.state === 'absent') {
    if (Object.keys(currentState).length !== 1) return invalid('current');
    current = Object.freeze({ state: 'absent' });
  } else if (currentState.state === 'present') {
    if (!Object.hasOwn(currentState, 'bytes')) return invalid('current.bytes');
    const bytes = ownBytes(currentState.bytes);
    if (bytes === null) return invalid('current.bytes');
    current = Object.freeze({ state: 'present', bytes });
  } else {
    return invalid('current');
  }

  const legacyIntent = ownData(request.legacyIntent, ['requireMatch']);
  if (legacyIntent === null) return invalid('legacyIntent');
  const rawRequireMatch = ownArray(legacyIntent.requireMatch);
  if (rawRequireMatch === null) return invalid('legacyIntent.requireMatch');
  const requireMatch: InitManifestIntentField[] = [];
  let priorIndex = -1;
  for (const field of rawRequireMatch) {
    if (typeof field !== 'string') return invalid('legacyIntent.requireMatch');
    const index = INTENT_FIELD_INDEX.get(field);
    if (
      index === undefined ||
      index <= priorIndex ||
      !hasSkeletonField(skeletonResult.value, field as InitManifestIntentField)
    ) {
      return invalid('legacyIntent.requireMatch');
    }
    priorIndex = index;
    requireMatch.push(field as InitManifestIntentField);
  }

  if (typeof request.force !== 'boolean') return invalid('force');
  return ok(
    Object.freeze({
      skeleton: skeletonResult.value,
      current,
      requireMatch: Object.freeze(requireMatch),
      force: request.force,
    }),
  );
};

const renderSkeleton = (skeleton: NormalizedSkeleton): string => {
  const sections: string[] = ['version = 1'];
  if (skeleton.defaults !== undefined) {
    const lines = ['[defaults]'];
    if (skeleton.defaults.tools !== undefined) {
      lines.push(`tools = ${renderHumanTomlStringArray(skeleton.defaults.tools)}`);
    }
    if (skeleton.defaults.scope !== undefined) {
      lines.push(`scope = ${renderHumanTomlString(skeleton.defaults.scope)}`);
    }
    if (skeleton.defaults.path !== undefined) {
      lines.push(`path = ${renderHumanTomlString(skeleton.defaults.path)}`);
    }
    sections.push(lines.join('\n'));
  }
  if (skeleton.registry !== undefined) {
    sections.push(`[registry]\ndefault = ${renderHumanTomlString(skeleton.registry.default)}`);
  }
  return `${sections.join('\n\n')}\n`;
};

const canonicalImage = (
  skeleton: NormalizedSkeleton,
): Result<
  Readonly<{ source: string; manifest: NormalizedManifestV1; image: InitManifestWriteImage }>,
  InitManifestRefusal
> => {
  const source = renderSkeleton(skeleton);
  if (containsSensitiveMaterial(source)) return invalid();
  const document = readManifestSource(source);
  if (!document.ok || document.value.shape !== 'canonical') {
    throw new InitManifestInvariantError('canonical init manifest invariant failed');
  }
  const manifest = normalizeManifestDocument(document.value);
  if (!manifest.ok) {
    throw new InitManifestInvariantError('canonical init manifest invariant failed');
  }
  const expected = Object.freeze({
    version: 1,
    ...(skeleton.defaults === undefined ? {} : { defaults: skeleton.defaults }),
    ...(skeleton.registry === undefined ? {} : { registry: skeleton.registry }),
    skills: Object.freeze([]),
  }) as NormalizedManifestV1;
  if (
    JSON.stringify(projectManifestSemantics(manifest.value)) !==
    JSON.stringify(projectManifestSemantics(expected))
  ) {
    throw new InitManifestInvariantError('canonical init manifest invariant failed');
  }
  const image = Object.freeze({
    source,
    byteHash: hashManifestBytes(source),
    semanticHash: hashManifestSemantics(manifest.value),
    shape: 'canonical' as const,
  });
  return ok(Object.freeze({ source, manifest: manifest.value, image }));
};

const decodeCurrent = (bytes: Uint8Array): string | null => {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return null;
  }
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
};

const TOML_INTEGER =
  /^(?:[+-]?(?:0|[1-9](?:_?[0-9])*)|0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|0o[0-7](?:_?[0-7])*|0b[01](?:_?[01])*)$/u;

const hasFutureVersion = (bytes: Uint8Array): boolean => {
  const scanned = scanHumanToml(bytes);
  if (!scanned.ok) return false;
  const candidates = scanned.value.assignments.filter(
    (assignment) =>
      assignment.tablePath.length === 0 &&
      assignment.keyPath.length === 1 &&
      assignment.keyPath[0] === 'version' &&
      !assignment.dotted &&
      !assignment.multiline,
  );
  if (candidates.length !== 1) return false;
  const token = candidates[0]?.value ?? '';
  if (!TOML_INTEGER.test(token)) return false;
  const version = Number(token.replaceAll('_', ''));
  return Number.isSafeInteger(version) && version > 1;
};

type InitConfigSnapshot =
  | Readonly<{
      shape: 'canonical';
      manifest: NormalizedManifestV1;
    }>
  | Readonly<{
      shape: 'legacy';
      manifest: NormalizedManifestV1;
      migration: LegacyManifestMigration;
    }>;

const inspectKnownInitConfigSnapshot = (
  bytes: Uint8Array,
  source: string,
  shape: 'canonical' | 'legacy',
): InitConfigSnapshot | null => {
  const document = readManifestSource(source);
  if (!document.ok) return null;
  const normalized = normalizeManifestDocument(document.value);
  if (!normalized.ok) return null;
  if (shape === 'canonical') {
    return Object.freeze({ shape, manifest: normalized.value });
  }
  const migration = migrateLegacyManifestBytes(bytes);
  if (!migration.ok || containsSensitiveMaterial(migration.value.source)) return null;
  return Object.freeze({ shape, manifest: normalized.value, migration: migration.value });
};

const inspectInitConfigSnapshot = (bytes: Uint8Array): InitConfigSnapshot | null => {
  const source = decodeCurrent(bytes);
  if (source === null || hasFutureVersion(bytes)) return null;
  const shape = classifyManifestSource(source);
  return shape === 'canonical' || shape === 'legacy'
    ? inspectKnownInitConfigSnapshot(bytes, source, shape)
    : null;
};

/** Whether one already-owned init snapshot may participate as an automatic config layer. */
export const isInitConfigSnapshotEligible = (bytes: Uint8Array): boolean =>
  inspectInitConfigSnapshot(bytes) !== null;

const beforeImage = (
  bytes: Uint8Array,
  shape: ManifestShape,
  semanticHash: ArtifactDigest | null,
): InitManifestBeforeImage =>
  Object.freeze({
    byteHash: hashManifestBytes(bytes),
    semanticHash,
    shape,
  });

const intentValue = (
  manifest: NormalizedManifestV1,
  field: InitManifestIntentField,
): readonly ManifestTool[] | ManifestScope | string | undefined => {
  switch (field) {
    case 'defaults.tools':
      return manifest.defaults?.tools;
    case 'defaults.scope':
      return manifest.defaults?.scope;
    case 'defaults.path':
      return manifest.defaults?.path;
    case 'registry.default':
      return manifest.registry?.default;
  }
};

const skeletonIntentValue = (
  skeleton: NormalizedSkeleton,
  field: InitManifestIntentField,
): readonly ManifestTool[] | ManifestScope | string | undefined => {
  switch (field) {
    case 'defaults.tools':
      return skeleton.defaults?.tools;
    case 'defaults.scope':
      return skeleton.defaults?.scope;
    case 'defaults.path':
      return skeleton.defaults?.path;
    case 'registry.default':
      return skeleton.registry?.default;
  }
};

const equalIntentValue = (left: unknown, right: unknown): boolean =>
  Array.isArray(left) && Array.isArray(right)
    ? left.length === right.length && left.every((value, index) => value === right[index])
    : left === right;

const planInitManifestResult = (
  input: unknown,
): Result<InitManifestOperationInput, InitManifestRefusal> => {
  try {
    const request = validateRequest(input);
    if (!request.ok) return request;
    const canonical = canonicalImage(request.value.skeleton);
    if (!canonical.ok) return canonical;
    if (request.value.current.state === 'absent') {
      return ok(
        Object.freeze({
          kind: 'create-manifest',
          before: null,
          after: canonical.value.image,
        }),
      );
    }

    const bytes = request.value.current.bytes;
    const source = decodeCurrent(bytes);
    const classified = source === null ? 'malformed' : classifyManifestSource(source);
    const shape = classified !== 'malformed' && hasFutureVersion(bytes) ? 'future' : classified;
    if (shape === 'future') return err(refusal('future-manifest', { shape }));

    if (shape === 'legacy' && source !== null) {
      const inspected = inspectKnownInitConfigSnapshot(bytes, source, shape);
      if (inspected === null || inspected.shape !== 'legacy') {
        return err(refusal('unsafe-legacy-migration', { shape }));
      }
      for (const field of request.value.requireMatch) {
        if (
          !equalIntentValue(
            intentValue(inspected.manifest, field),
            skeletonIntentValue(request.value.skeleton, field),
          )
        ) {
          return err(refusal('legacy-intent-conflict', { shape }));
        }
      }
      const before = beforeImage(bytes, shape, inspected.migration.beforeSemanticHash);
      const after = Object.freeze({
        source: inspected.migration.source,
        byteHash: hashManifestBytes(inspected.migration.source),
        semanticHash: inspected.migration.afterSemanticHash,
        shape: 'canonical' as const,
      });
      return ok(
        Object.freeze({
          kind: 'migrate-project-config',
          before,
          after,
        }),
      );
    }

    let semanticHash: ArtifactDigest | null = null;
    let semanticallyEqual = false;
    if (shape === 'canonical' && source !== null) {
      const inspected = inspectKnownInitConfigSnapshot(bytes, source, shape);
      if (inspected !== null && inspected.shape === 'canonical') {
        semanticHash = hashManifestSemantics(inspected.manifest);
        semanticallyEqual =
          JSON.stringify(projectManifestSemantics(inspected.manifest)) ===
          JSON.stringify(projectManifestSemantics(canonical.value.manifest));
      }
    }
    const before = beforeImage(bytes, shape, semanticHash);
    if (semanticallyEqual) {
      return ok(Object.freeze({ kind: 'noop', before, after: null }));
    }
    if (!request.value.force) return err(refusal('existing-manifest', { shape }));
    return ok(
      Object.freeze({
        kind: 'replace-manifest',
        before,
        after: canonical.value.image,
      }),
    );
  } catch (error) {
    if (error instanceof InitManifestInvariantError) throw error;
    return invalid();
  }
};

export function planInitManifest(
  input: unknown,
): Result<InitManifestOperationInput, InitManifestRefusal> {
  return Object.freeze(planInitManifestResult(input));
}
