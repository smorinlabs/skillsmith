import { Buffer } from 'node:buffer';
import type { FileMetadata, FileMetadataReadPort, FileReadPort } from '../ports/types.ts';
import { type Result, err, ok } from '../result.ts';
import { type ArtifactDigest, HASH_SCHEMA_VERSION, hashCanonicalInput } from './hash.ts';

export const SOURCE_CONTENT_EXCLUSIONS_VERSION = 1 as const;
export const SOURCE_CONTENT_EXCLUSIONS_V1 = Object.freeze(['.git'] as const);

export interface SourceContentDirectoryEntryV1 {
  readonly path: string;
  readonly type: 'directory';
}

export interface SourceContentSymlinkEntryV1 {
  readonly path: string;
  readonly type: 'symlink';
  readonly target: string;
}

export interface SourceContentFileEntryV1 {
  readonly path: string;
  readonly type: 'file';
  readonly executable: boolean;
  readonly length: number;
  readonly bytes: string;
}

export type SourceContentEntryV1 =
  | SourceContentDirectoryEntryV1
  | SourceContentSymlinkEntryV1
  | SourceContentFileEntryV1;

export interface SourceContentProjectionV1 {
  readonly version: 1;
  readonly exclusionsVersion: 1;
  readonly entries: readonly SourceContentEntryV1[];
}

export type SourceContentReadPort = Pick<FileReadPort, 'listDir' | 'readBytes' | 'readLink'> &
  FileMetadataReadPort;

export type SourceContentErrorReason =
  | 'invalid-root'
  | 'unsafe-path'
  | 'normalization-collision'
  | 'unsafe-symlink'
  | 'unsupported-entry'
  | 'unstable-read'
  | 'invalid-projection';

export type SourceContentErrorField =
  | 'root'
  | 'projection'
  | 'version'
  | 'exclusionsVersion'
  | 'entries'
  | 'entries[].path'
  | 'entries[].target'
  | 'entries[].type'
  | 'entries[].executable'
  | 'entries[].length'
  | 'entries[].bytes';

export interface SourceContentError {
  readonly code: 'source-content';
  readonly reason: SourceContentErrorReason;
  readonly field: SourceContentErrorField;
  readonly message: string;
}

const ERROR_DETAILS: Readonly<
  Record<SourceContentErrorReason, Readonly<{ field: SourceContentErrorField; message: string }>>
> = Object.freeze({
  'invalid-root': Object.freeze({ field: 'root', message: 'source content root is invalid' }),
  'unsafe-path': Object.freeze({
    field: 'entries[].path',
    message: 'source content path is unsafe',
  }),
  'normalization-collision': Object.freeze({
    field: 'entries[].path',
    message: 'source content paths collide after normalization',
  }),
  'unsafe-symlink': Object.freeze({
    field: 'entries[].target',
    message: 'source content symlink target is unsafe',
  }),
  'unsupported-entry': Object.freeze({
    field: 'entries[].type',
    message: 'source content entry type is unsupported',
  }),
  'unstable-read': Object.freeze({
    field: 'entries',
    message: 'source content changed while it was read',
  }),
  'invalid-projection': Object.freeze({
    field: 'projection',
    message: 'source content projection is invalid',
  }),
});

const sourceError = (
  reason: SourceContentErrorReason,
  field: SourceContentErrorField = ERROR_DETAILS[reason].field,
): SourceContentError =>
  Object.freeze({
    code: 'source-content',
    reason,
    field,
    message: ERROR_DETAILS[reason].message,
  });

const invalidProjection = (field: SourceContentErrorField = 'projection') =>
  err(sourceError('invalid-projection', field));

const deepFreeze = <T>(value: T, seen = new Set<object>()): T => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
};

const hasUnpairedSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
};

const hasForbiddenText = (value: string): boolean => {
  if (hasUnpairedSurrogate(value)) return true;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x1f || unit === 0x7f) return true;
  }
  return false;
};

const isDriveLike = (value: string): boolean => /^[A-Za-z]:/u.test(value);

const normalizeEntryName = (value: unknown): Result<string, SourceContentError> => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    isDriveLike(value) ||
    hasForbiddenText(value)
  ) {
    return err(sourceError('unsafe-path'));
  }
  try {
    return ok(value.normalize('NFC'));
  } catch {
    return err(sourceError('unsafe-path'));
  }
};

const canonicalProjectionPath = (value: unknown): string | null => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    isDriveLike(value) ||
    hasForbiddenText(value)
  ) {
    return null;
  }
  let normalized: string;
  try {
    normalized = value.normalize('NFC');
  } catch {
    return null;
  }
  if (normalized !== value) return null;
  const segments = normalized.split('/');
  if (
    segments.some(
      (segment) =>
        segment.length === 0 || segment === '.' || segment === '..' || isDriveLike(segment),
    )
  ) {
    return null;
  }
  return normalized;
};

const canonicalizeSymlinkTarget = (value: unknown): string | null => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    isDriveLike(value) ||
    hasForbiddenText(value)
  ) {
    return null;
  }
  let normalized: string;
  try {
    normalized = value.normalize('NFC');
  } catch {
    return null;
  }
  const sourceSegments = normalized.split('/');
  if (sourceSegments.some((segment) => segment.length === 0)) return null;
  const stack: string[] = [];
  for (const segment of sourceSegments) {
    if (segment === '.') continue;
    if (segment === '..') {
      if (stack.length > 0 && stack.at(-1) !== '..') stack.pop();
      else stack.push('..');
      continue;
    }
    if (isDriveLike(segment)) return null;
    stack.push(segment);
  }
  return stack.length === 0 ? '.' : stack.join('/');
};

const symlinkStaysInsideRoot = (linkPath: string, target: string): boolean => {
  const resolved = linkPath.split('/').slice(0, -1);
  for (const segment of target.split('/')) {
    if (segment === '.') continue;
    if (segment === '..') {
      if (resolved.length === 0) return false;
      resolved.pop();
    } else {
      resolved.push(segment);
    }
  }
  return true;
};

const encoder = new TextEncoder();

const compareUtf8 = (left: string, right: string): number => {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
};

const exactKeys = (value: object, expected: readonly string[]): boolean => {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => keys.includes(key)) &&
    keys.every((key) => {
      if (typeof key !== 'string' || !expected.includes(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && 'value' in descriptor;
    })
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const copyExactIndexedArray = (value: unknown): readonly unknown[] | null => {
  if (!Array.isArray(value)) return null;
  try {
    const keys = Reflect.ownKeys(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (
      lengthDescriptor === undefined ||
      !('value' in lengthDescriptor) ||
      typeof lengthDescriptor.value !== 'number' ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      keys.length !== lengthDescriptor.value + 1
    ) {
      return null;
    }

    const length = lengthDescriptor.value;
    const descriptors: PropertyDescriptor[] = new Array(length);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (key === 'length') continue;
      if (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length) {
        return null;
      }
    }
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !('value' in descriptor)) return null;
      descriptors[index] = descriptor;
    }

    const copied: unknown[] = new Array(length);
    for (let index = 0; index < length; index += 1) copied[index] = descriptors[index]?.value;
    return copied;
  } catch {
    return null;
  }
};

const decodeCanonicalBase64 = (value: unknown): Uint8Array | null => {
  if (
    typeof value !== 'string' ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    return null;
  }
  try {
    const bytes = Buffer.from(value, 'base64');
    return bytes.toString('base64') === value ? new Uint8Array(bytes) : null;
  } catch {
    return null;
  }
};

const ownProjection = (
  input: Readonly<SourceContentProjectionV1>,
): Result<SourceContentProjectionV1, SourceContentError> => {
  try {
    if (!isRecord(input) || !exactKeys(input, ['version', 'exclusionsVersion', 'entries'])) {
      return invalidProjection();
    }
    if (input.version !== 1) return invalidProjection('version');
    if (input.exclusionsVersion !== 1) return invalidProjection('exclusionsVersion');
    const candidates = copyExactIndexedArray(input.entries);
    if (candidates === null) return invalidProjection('entries');

    const entries: SourceContentEntryV1[] = [];
    let previousPath: string | null = null;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (!isRecord(candidate)) return invalidProjection('entries');
      const path = canonicalProjectionPath(candidate.path);
      if (path === null) return invalidProjection('entries[].path');
      if (previousPath !== null && compareUtf8(previousPath, path) >= 0) {
        return invalidProjection('entries');
      }
      previousPath = path;

      if (candidate.type === 'directory') {
        if (!exactKeys(candidate, ['path', 'type'])) return invalidProjection('entries');
        entries.push({ path, type: 'directory' });
        continue;
      }
      if (candidate.type === 'symlink') {
        if (!exactKeys(candidate, ['path', 'type', 'target'])) {
          return invalidProjection('entries');
        }
        const target = canonicalizeSymlinkTarget(candidate.target);
        if (
          target === null ||
          target !== candidate.target ||
          !symlinkStaysInsideRoot(path, target)
        ) {
          return invalidProjection('entries[].target');
        }
        entries.push({ path, type: 'symlink', target });
        continue;
      }
      if (candidate.type !== 'file') return invalidProjection('entries[].type');
      if (!exactKeys(candidate, ['path', 'type', 'executable', 'length', 'bytes'])) {
        return invalidProjection('entries');
      }
      if (typeof candidate.executable !== 'boolean') {
        return invalidProjection('entries[].executable');
      }
      if (
        typeof candidate.length !== 'number' ||
        !Number.isSafeInteger(candidate.length) ||
        candidate.length < 0
      ) {
        return invalidProjection('entries[].length');
      }
      const bytes = decodeCanonicalBase64(candidate.bytes);
      if (bytes === null) return invalidProjection('entries[].bytes');
      if (bytes.byteLength !== candidate.length) return invalidProjection('entries[].length');
      entries.push({
        path,
        type: 'file',
        executable: candidate.executable,
        length: candidate.length,
        bytes: candidate.bytes as string,
      });
    }
    return ok(
      deepFreeze({
        version: SOURCE_CONTENT_EXCLUSIONS_VERSION,
        exclusionsVersion: SOURCE_CONTENT_EXCLUSIONS_VERSION,
        entries,
      }),
    );
  } catch {
    return invalidProjection();
  }
};

export const serializeSourceContentProjection = (
  projection: Readonly<SourceContentProjectionV1>,
): Result<string, SourceContentError> => {
  const owned = ownProjection(projection);
  if (!owned.ok) return owned;
  return ok(JSON.stringify(owned.value));
};

export const hashSourceContentV1 = (
  projection: Readonly<SourceContentProjectionV1>,
): Result<ArtifactDigest, SourceContentError> => {
  const serialized = serializeSourceContentProjection(projection);
  if (!serialized.ok) return serialized;
  const hashed = hashCanonicalInput('source-content', HASH_SCHEMA_VERSION, serialized.value);
  if (!hashed.ok) return invalidProjection();
  return ok(hashed.value);
};

interface PreparedChild {
  readonly rawName: string;
  readonly name: string;
  readonly path: string;
}

interface ProjectionState {
  readonly entries: SourceContentEntryV1[];
  readonly paths: Set<string>;
}

type StableMetadata = Readonly<{
  kind: 'dir' | 'file' | 'symlink';
  mode: number;
  identity: string;
}>;

const validMetadata = (metadata: unknown): metadata is StableMetadata => {
  if (!isRecord(metadata)) return false;
  return (
    (metadata.kind === 'dir' || metadata.kind === 'file' || metadata.kind === 'symlink') &&
    typeof metadata.identity === 'string' &&
    typeof metadata.mode === 'number' &&
    Number.isSafeInteger(metadata.mode) &&
    metadata.mode >= 0 &&
    metadata.mode <= 0o7777
  );
};

const sameMetadata = (left: StableMetadata, right: StableMetadata): boolean =>
  left.kind === right.kind && left.identity === right.identity && left.mode === right.mode;

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};

const appendHostPath = (parent: string, rawName: string): string =>
  parent.endsWith('/') || parent.endsWith('\\') ? `${parent}${rawName}` : `${parent}/${rawName}`;

const prepareListing = (
  values: readonly unknown[],
  parentPath: string,
): Result<readonly PreparedChild[], SourceContentError> => {
  const children: PreparedChild[] = [];
  const names = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const rawName = values[index];
    const normalized = normalizeEntryName(rawName);
    if (!normalized.ok) return normalized;
    if (names.has(normalized.value)) return err(sourceError('normalization-collision'));
    names.add(normalized.value);
    children.push({
      rawName: rawName as string,
      name: normalized.value,
      path: parentPath.length === 0 ? normalized.value : `${parentPath}/${normalized.value}`,
    });
  }
  children.sort((left, right) => compareUtf8(left.name, right.name));
  return ok(children);
};

const sameChildNames = (left: readonly PreparedChild[], right: readonly PreparedChild[]): boolean =>
  left.length === right.length && left.every((child, index) => child.name === right[index]?.name);

const readMetadata = async (
  ports: SourceContentReadPort,
  path: string,
): Promise<FileMetadata | null> => {
  try {
    const value = await ports.readFileMetadata(path);
    return Object.freeze({ kind: value.kind, mode: value.mode, identity: value.identity });
  } catch {
    return null;
  }
};

const copyListing = async (
  ports: SourceContentReadPort,
  path: string,
): Promise<readonly unknown[] | null> => {
  try {
    const value = await ports.listDir(path);
    return copyExactIndexedArray(value);
  } catch {
    return null;
  }
};

const copyBytes = async (
  ports: SourceContentReadPort,
  path: string,
): Promise<Uint8Array | null> => {
  try {
    const value = await ports.readBytes(path);
    return value instanceof Uint8Array ? new Uint8Array(value) : null;
  } catch {
    return null;
  }
};

const copyTarget = async (ports: SourceContentReadPort, path: string): Promise<string | null> => {
  try {
    const value = await ports.readLink(path);
    return typeof value === 'string' ? `${value}` : null;
  } catch {
    return null;
  }
};

const observeEntry = async (
  ports: SourceContentReadPort,
  hostPath: string,
  projectedPath: string,
  state: ProjectionState,
): Promise<Result<void, SourceContentError>> => {
  const metadataA = await readMetadata(ports, hostPath);
  if (metadataA?.kind === 'other') return err(sourceError('unsupported-entry'));
  if (metadataA === null || !validMetadata(metadataA)) return err(sourceError('unstable-read'));

  if (metadataA.kind === 'dir') {
    state.entries.push({ path: projectedPath, type: 'directory' });
    return observeDirectory(ports, hostPath, projectedPath, metadataA, state);
  }

  if (metadataA.kind === 'file') {
    const bytesA = await copyBytes(ports, hostPath);
    if (bytesA === null) return err(sourceError('unstable-read'));
    const metadataB = await readMetadata(ports, hostPath);
    if (metadataB === null || !validMetadata(metadataB) || !sameMetadata(metadataA, metadataB)) {
      return err(sourceError('unstable-read'));
    }
    const bytesB = await copyBytes(ports, hostPath);
    if (bytesB === null) return err(sourceError('unstable-read'));
    const metadataC = await readMetadata(ports, hostPath);
    if (
      metadataC === null ||
      !validMetadata(metadataC) ||
      !sameMetadata(metadataA, metadataC) ||
      !sameBytes(bytesA, bytesB)
    ) {
      return err(sourceError('unstable-read'));
    }
    state.entries.push({
      path: projectedPath,
      type: 'file',
      executable: (metadataA.mode & 0o111) !== 0,
      length: bytesA.byteLength,
      bytes: Buffer.from(bytesA).toString('base64'),
    });
    return ok(undefined);
  }

  const targetA = await copyTarget(ports, hostPath);
  if (targetA === null) return err(sourceError('unstable-read'));
  const metadataB = await readMetadata(ports, hostPath);
  if (metadataB === null || !validMetadata(metadataB) || !sameMetadata(metadataA, metadataB)) {
    return err(sourceError('unstable-read'));
  }
  const targetB = await copyTarget(ports, hostPath);
  if (targetB === null) return err(sourceError('unstable-read'));
  const metadataC = await readMetadata(ports, hostPath);
  if (
    metadataC === null ||
    !validMetadata(metadataC) ||
    !sameMetadata(metadataA, metadataC) ||
    targetA !== targetB
  ) {
    return err(sourceError('unstable-read'));
  }
  const target = canonicalizeSymlinkTarget(targetA);
  if (target === null || !symlinkStaysInsideRoot(projectedPath, target)) {
    return err(sourceError('unsafe-symlink'));
  }
  state.entries.push({ path: projectedPath, type: 'symlink', target });
  return ok(undefined);
};

const observeDirectory = async (
  ports: SourceContentReadPort,
  hostPath: string,
  projectedPath: string,
  metadataA: StableMetadata,
  state: ProjectionState,
): Promise<Result<void, SourceContentError>> => {
  const listingAValue = await copyListing(ports, hostPath);
  if (listingAValue === null) return err(sourceError('unstable-read'));
  const metadataB = await readMetadata(ports, hostPath);
  if (metadataB === null || !validMetadata(metadataB) || !sameMetadata(metadataA, metadataB)) {
    return err(sourceError('unstable-read'));
  }
  const listingA = prepareListing(listingAValue, projectedPath);
  if (!listingA.ok) return listingA;

  for (const child of listingA.value) {
    if (child.name === SOURCE_CONTENT_EXCLUSIONS_V1[0]) continue;
    if (state.paths.has(child.path)) return err(sourceError('normalization-collision'));
    state.paths.add(child.path);
    const observed = await observeEntry(
      ports,
      appendHostPath(hostPath, child.rawName),
      child.path,
      state,
    );
    if (!observed.ok) return observed;
  }

  const listingBValue = await copyListing(ports, hostPath);
  if (listingBValue === null) return err(sourceError('unstable-read'));
  const metadataC = await readMetadata(ports, hostPath);
  if (metadataC === null || !validMetadata(metadataC) || !sameMetadata(metadataA, metadataC)) {
    return err(sourceError('unstable-read'));
  }
  const listingB = prepareListing(listingBValue, projectedPath);
  if (!listingB.ok) return err(sourceError('unstable-read'));
  if (!sameChildNames(listingA.value, listingB.value)) {
    return err(sourceError('unstable-read'));
  }
  return ok(undefined);
};

export const projectSourceContent = async (
  ports: SourceContentReadPort,
  root: string,
): Promise<Result<SourceContentProjectionV1, SourceContentError>> => {
  if (typeof root !== 'string') return err(sourceError('invalid-root'));
  const initial = await readMetadata(ports, root);
  if (initial === null || !validMetadata(initial) || initial.kind !== 'dir') {
    return err(sourceError('invalid-root'));
  }

  const metadataA = await readMetadata(ports, root);
  if (metadataA === null || !validMetadata(metadataA) || !sameMetadata(initial, metadataA)) {
    return err(sourceError('unstable-read'));
  }
  const state: ProjectionState = { entries: [], paths: new Set<string>() };
  const observed = await observeDirectory(ports, root, '', metadataA, state);
  if (!observed.ok) return observed;
  state.entries.sort((left, right) => compareUtf8(left.path, right.path));
  return ownProjection(
    deepFreeze({
      version: SOURCE_CONTENT_EXCLUSIONS_VERSION,
      exclusionsVersion: SOURCE_CONTENT_EXCLUSIONS_VERSION,
      entries: state.entries,
    }),
  );
};
