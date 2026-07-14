import { types as utilTypes } from 'node:util';
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
import { applyHumanTomlReplacements, renderHumanTomlString, scanHumanToml } from './human-toml.ts';
import { normalizeRegistryIdentity } from './identity.ts';
import { migrateLegacyManifestBytes } from './legacy-migration.ts';
import { type ManifestEdit, editManifestBytes } from './manifest-edit.ts';
import {
  classifyManifestSource,
  normalizeManifestDocument,
  projectManifestSemantics,
  readManifestSource,
} from './manifest.ts';
import type {
  ManifestScope,
  ManifestTool,
  NormalizedManifestDeclaration,
  NormalizedManifestV1,
} from './types.ts';

export interface ManifestV1Dto {
  readonly version: 1;
  readonly defaults?: Readonly<{
    readonly tools?: readonly ManifestTool[];
    readonly scope?: ManifestScope;
    readonly path?: string;
  }>;
  readonly registry?: Readonly<{ readonly default?: string }>;
  readonly skills?: readonly NormalizedManifestDeclaration[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const baseManifestBytes = encoder.encode('version = 1\n');

const descriptor = Object.freeze({
  id: 'manifest',
  version: 1,
  syntax: 'toml',
  discriminator: Object.freeze({
    kind: 'classifier',
    id: 'manifest-v1-or-legacy-project-config',
  }),
  wireKind: null,
  presentation: Object.freeze({ decode: 'human', encode: 'canonical' }),
  terminalLf: true,
  unknownFields: 'reject-recursive',
  migrations: Object.freeze([
    Object.freeze({
      source: Object.freeze({ kind: 'shape', id: 'legacy-project-config' }),
      targetVersion: 1,
      mapperId: 'legacy-project-config-to-manifest-v1',
    }),
  ]),
  compatibility: 'conservative',
}) as ArtifactCodecDescriptor<'manifest', 1>;

type ManifestCodecReason = Extract<
  ArtifactCodecError['reason'],
  'malformed' | 'invalid-shape' | 'unsupported-version' | 'migration-failed' | 'sensitive-content'
>;

const fail = (
  reason: ManifestCodecReason,
  requestedVersion: number | null,
  path: readonly (string | number)[] = [],
): Result<never, ArtifactCodecError> =>
  err(artifactCodecError('manifest', requestedVersion, reason, path));

interface OwnedRecordResult {
  readonly value: Readonly<Record<string, unknown>>;
}

const ownRecord = (
  input: unknown,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): OwnedRecordResult | null => {
  try {
    if (
      typeof input !== 'object' ||
      input === null ||
      utilTypes.isProxy(input) ||
      Array.isArray(input) ||
      ArrayBuffer.isView(input)
    ) {
      return null;
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (Object.getOwnPropertySymbols(input).length > 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Object.keys(descriptors);
    if (
      keys.some((key) => !allowed.includes(key)) ||
      required.some((key) => !(key in descriptors))
    ) {
      return null;
    }
    const value: Record<string, unknown> = {};
    for (const key of keys) {
      const entry = descriptors[key];
      if (entry === undefined || entry.enumerable !== true || !('value' in entry)) return null;
      value[key] = entry.value;
    }
    return Object.freeze({ value: Object.freeze(value) });
  } catch {
    return null;
  }
};

const ownArray = (input: unknown): readonly unknown[] | null => {
  try {
    if (
      !Array.isArray(input) ||
      utilTypes.isProxy(input) ||
      Object.getPrototypeOf(input) !== Array.prototype ||
      Object.getOwnPropertySymbols(input).length > 0
    ) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const lengthEntry = Object.getOwnPropertyDescriptor(input, 'length');
    const rawLength =
      lengthEntry !== undefined && 'value' in lengthEntry ? lengthEntry.value : null;
    if (
      lengthEntry === undefined ||
      !('value' in lengthEntry) ||
      typeof rawLength !== 'number' ||
      !Number.isSafeInteger(rawLength) ||
      rawLength < 0 ||
      rawLength > 10_000
    ) {
      return null;
    }
    const length = rawLength;
    if (
      Object.keys(descriptors).some((key) => key !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(key))
    ) {
      return null;
    }
    const value: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const entry = descriptors[String(index)];
      if (entry === undefined || entry.enumerable !== true || !('value' in entry)) return null;
      value.push(entry.value);
    }
    return Object.freeze(value);
  } catch {
    return null;
  }
};

const ownStringArray = (input: unknown): readonly string[] | null => {
  const array = ownArray(input);
  return array?.every((value) => typeof value === 'string')
    ? Object.freeze([...array] as string[])
    : null;
};

interface OwnedManifestDto {
  readonly version: 1;
  readonly defaults?: Readonly<{
    readonly tools?: readonly string[];
    readonly scope?: string;
    readonly path?: string;
  }>;
  readonly registry?: Readonly<{ readonly default?: string }>;
  readonly skills?: readonly Readonly<{
    readonly name: string;
    readonly source: Readonly<{
      readonly host: string;
      readonly repository: string;
      readonly path: string | null;
    }>;
    readonly ref: string | null;
    readonly tools: readonly string[];
    readonly scope: string;
    readonly placement: string;
    readonly path: string | null;
  }>[];
}

const sensitivePath = (
  input: unknown,
  path: readonly (string | number)[] = [],
): readonly (string | number)[] | null => {
  if (typeof input === 'string') return hasSensitiveArtifactContent(input) ? path : null;
  if (Array.isArray(input)) {
    for (let index = 0; index < input.length; index += 1) {
      const found = sensitivePath(input[index], [...path, index]);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof input === 'object' && input !== null) {
    for (const [key, value] of Object.entries(input)) {
      const found = sensitivePath(value, [...path, key]);
      if (found !== null) return found;
    }
  }
  return null;
};

const ownManifestDto = (input: unknown): Result<OwnedManifestDto, ArtifactCodecError> => {
  const ownedInput = deepOwnFreeze<unknown>('manifest', input);
  if (!ownedInput.ok) return ownedInput;
  const candidateRoot =
    typeof ownedInput.value === 'object' &&
    ownedInput.value !== null &&
    !Array.isArray(ownedInput.value)
      ? (ownedInput.value as Readonly<Record<string, unknown>>)
      : null;
  const candidateVersion = candidateRoot?.version;
  const candidateRequestedVersion =
    typeof candidateVersion === 'number' &&
    Number.isSafeInteger(candidateVersion) &&
    candidateVersion > 0
      ? candidateVersion
      : null;
  const root = ownRecord(
    ownedInput.value,
    ['version', 'defaults', 'registry', 'skills'],
    ['version'],
  );
  if (root === null) return fail('invalid-shape', candidateRequestedVersion);
  const requestedVersion =
    typeof root.value.version === 'number' &&
    Number.isSafeInteger(root.value.version) &&
    root.value.version > 0
      ? root.value.version
      : null;
  if (root.value.version !== 1) {
    return fail(
      requestedVersion === null ? 'invalid-shape' : 'unsupported-version',
      requestedVersion,
      ['version'],
    );
  }

  let defaults: OwnedManifestDto['defaults'];
  if ('defaults' in root.value) {
    const record = ownRecord(root.value.defaults, ['tools', 'scope', 'path'], []);
    if (record === null) return fail('invalid-shape', 1, ['defaults']);
    let tools: readonly string[] | undefined;
    if ('tools' in record.value) {
      tools = ownStringArray(record.value.tools) ?? undefined;
      if (tools === undefined) return fail('invalid-shape', 1, ['defaults', 'tools']);
    }
    if ('scope' in record.value && typeof record.value.scope !== 'string') {
      return fail('invalid-shape', 1, ['defaults', 'scope']);
    }
    if ('path' in record.value && typeof record.value.path !== 'string') {
      return fail('invalid-shape', 1, ['defaults', 'path']);
    }
    defaults = Object.freeze({
      ...(tools === undefined ? {} : { tools }),
      ...(!('scope' in record.value) ? {} : { scope: record.value.scope as string }),
      ...(!('path' in record.value) ? {} : { path: record.value.path as string }),
    });
  }

  let registry: OwnedManifestDto['registry'];
  if ('registry' in root.value) {
    const record = ownRecord(root.value.registry, ['default'], []);
    if (record === null) return fail('invalid-shape', 1, ['registry']);
    if ('default' in record.value && typeof record.value.default !== 'string') {
      return fail('invalid-shape', 1, ['registry', 'default']);
    }
    registry = Object.freeze(
      !('default' in record.value) ? {} : { default: record.value.default as string },
    );
  }

  let skills: OwnedManifestDto['skills'];
  if ('skills' in root.value) {
    const array = ownArray(root.value.skills);
    if (array === null) return fail('invalid-shape', 1, ['skills']);
    const owned: NonNullable<OwnedManifestDto['skills']>[number][] = [];
    for (let index = 0; index < array.length; index += 1) {
      const record = ownRecord(array[index], [
        'name',
        'source',
        'ref',
        'tools',
        'scope',
        'placement',
        'path',
      ]);
      if (record === null) return fail('invalid-shape', 1, ['skills', index]);
      if (typeof record.value.name !== 'string') {
        return fail('invalid-shape', 1, ['skills', index, 'name']);
      }
      const source = ownRecord(record.value.source, ['host', 'repository', 'path']);
      if (
        source === null ||
        typeof source.value.host !== 'string' ||
        typeof source.value.repository !== 'string' ||
        (source.value.path !== null && typeof source.value.path !== 'string')
      ) {
        return fail('invalid-shape', 1, ['skills', index, 'source']);
      }
      const tools = ownStringArray(record.value.tools);
      if (tools === null) return fail('invalid-shape', 1, ['skills', index, 'tools']);
      if (
        (record.value.ref !== null && typeof record.value.ref !== 'string') ||
        typeof record.value.scope !== 'string' ||
        typeof record.value.placement !== 'string' ||
        (record.value.path !== null && typeof record.value.path !== 'string')
      ) {
        return fail('invalid-shape', 1, ['skills', index]);
      }
      owned.push(
        Object.freeze({
          name: record.value.name,
          source: Object.freeze({
            host: source.value.host,
            repository: source.value.repository,
            path: source.value.path as string | null,
          }),
          ref: record.value.ref as string | null,
          tools,
          scope: record.value.scope,
          placement: record.value.placement,
          path: record.value.path as string | null,
        }),
      );
    }
    skills = Object.freeze(owned);
  }

  const dto = Object.freeze({
    version: 1 as const,
    ...(defaults === undefined ? {} : { defaults }),
    ...(registry === undefined ? {} : { registry }),
    ...(skills === undefined ? {} : { skills }),
  });
  return ok(dto);
};

const fieldPath = (field: string | undefined): readonly (string | number)[] => {
  if (field === undefined) return [];
  return field
    .split('.')
    .map((segment) => (/^(?:0|[1-9][0-9]*)$/u.test(segment) ? Number(segment) : segment));
};

const editsFromDto = (dto: OwnedManifestDto): readonly ManifestEdit[] => {
  const edits: ManifestEdit[] = [];
  if (dto.defaults?.tools !== undefined) {
    edits.push({
      kind: 'set-default',
      field: 'tools',
      value: dto.defaults.tools as readonly ManifestTool[],
    });
  }
  if (dto.defaults?.scope !== undefined) {
    edits.push({ kind: 'set-default', field: 'scope', value: dto.defaults.scope as ManifestScope });
  }
  if (dto.defaults?.path !== undefined) {
    edits.push({ kind: 'set-default', field: 'path', value: dto.defaults.path });
  }
  if (dto.registry?.default !== undefined) {
    edits.push({ kind: 'set-registry-default', value: dto.registry.default });
  }
  for (const declaration of [...(dto.skills ?? [])].sort((left, right) =>
    unsignedUtf16Compare(left.name, right.name),
  )) {
    edits.push({ kind: 'add-skill', declaration: declaration as NormalizedManifestDeclaration });
  }
  return Object.freeze(edits);
};

const sameSemantics = (left: NormalizedManifestV1, right: NormalizedManifestV1): boolean =>
  JSON.stringify(projectManifestSemantics(left)) ===
  JSON.stringify(projectManifestSemantics(right));

const sourceFromDto = (
  dto: OwnedManifestDto,
): Result<Readonly<{ source: string; model: NormalizedManifestV1 }>, ArtifactCodecError> => {
  const edits = editsFromDto(dto);
  let source: string;
  if (edits.length === 0) {
    source = decoder.decode(new Uint8Array(baseManifestBytes));
  } else {
    const edited = editManifestBytes(new Uint8Array(baseManifestBytes), { edits });
    if (!edited.ok) {
      const unsafePath = sensitivePath(dto);
      return fail(
        edited.error.reason === 'unsafe-human-edit' && unsafePath !== null
          ? 'sensitive-content'
          : 'invalid-shape',
        1,
        unsafePath ?? [],
      );
    }
    source = edited.value.source;
  }
  const unsafePath = sensitivePath(dto);
  if (hasSensitiveArtifactContent(source)) return fail('sensitive-content', 1, unsafePath ?? []);
  const read = readManifestSource(source);
  if (!read.ok || read.value.shape !== 'canonical') return fail('invalid-shape', 1);
  const normalized = normalizeManifestDocument(read.value);
  if (!normalized.ok) return fail('invalid-shape', 1, fieldPath(normalized.error.field));
  return ok(Object.freeze({ source, model: normalized.value }));
};

const dtoFromModel = (model: NormalizedManifestV1): ManifestV1Dto => {
  const projected = projectManifestSemantics(model);
  return Object.freeze({
    version: 1,
    ...(projected.defaults === undefined ? {} : { defaults: projected.defaults }),
    ...(projected.registry === undefined ? {} : { registry: projected.registry }),
    ...(projected.skills.length === 0 ? {} : { skills: projected.skills }),
  });
};

interface NormalizedDto {
  readonly dto: ManifestV1Dto;
  readonly model: NormalizedManifestV1;
  readonly source: string;
}

const normalizeDto = (input: unknown): Result<NormalizedDto, ArtifactCodecError> => {
  const owned = ownManifestDto(input);
  if (!owned.ok) return owned;
  const generated = sourceFromDto(owned.value);
  if (!generated.ok) return generated;
  return ok(
    Object.freeze({
      dto: dtoFromModel(generated.value.model),
      model: generated.value.model,
      source: generated.value.source,
    }),
  );
};

const validate = (input: unknown): Result<ManifestV1Dto, ArtifactCodecError> => {
  const normalized = normalizeDto(input);
  return normalized.ok ? ok(normalized.value.dto) : normalized;
};

export const fromManifestV1Dto = (
  dto: ManifestV1Dto,
): Result<NormalizedManifestV1, ArtifactCodecError> => {
  const normalized = normalizeDto(dto);
  return normalized.ok ? ok(normalized.value.model) : normalized;
};

export const toManifestV1Dto = (
  model: NormalizedManifestV1,
): Result<ManifestV1Dto, ArtifactCodecError> => {
  const normalized = normalizeDto(model);
  return normalized.ok ? ok(normalized.value.dto) : normalized;
};

const ownedSource = (
  input: unknown,
): Result<Readonly<{ bytes: Uint8Array; source: string }>, ArtifactCodecError> => {
  const decoded = decodeArtifactUtf8('manifest', input);
  if (!decoded.ok) return decoded;
  if (decoded.value.bytes.length === 0 || /^[\t\n\v\f\r ]*$/u.test(decoded.value.source)) {
    return fail('malformed', null);
  }
  return decoded;
};

const requestedVersion = (source: string): number | null => {
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

const adaptCanonicalLegacyRegistry = (
  bytes: Uint8Array,
  source: string,
): NormalizedManifestV1 | null => {
  let raw: unknown;
  try {
    raw = parseToml(source);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const registry = (raw as Readonly<Record<string, unknown>>).registry;
  if (typeof registry !== 'object' || registry === null || Array.isArray(registry)) return null;
  const legacyValue = (registry as Readonly<Record<string, unknown>>).default;
  if (typeof legacyValue !== 'string' || !/^https:\/\//iu.test(legacyValue)) return null;
  const identity = normalizeRegistryIdentity(legacyValue, { legacy: true });
  if (!identity.ok) return null;

  const scanned = scanHumanToml(bytes);
  if (!scanned.ok) return null;
  const assignments = scanned.value.assignments.filter(
    (entry) =>
      entry.arrayTableIndex === null &&
      !entry.dotted &&
      entry.tablePath.length === 1 &&
      entry.tablePath[0] === 'registry' &&
      entry.keyPath.length === 1 &&
      entry.keyPath[0] === 'default' &&
      !entry.multiline,
  );
  const assignment = assignments[0];
  if (assignments.length !== 1 || assignment === undefined) return null;
  const rewritten = applyHumanTomlReplacements(source, [
    {
      start: assignment.valueRange.start,
      end: assignment.valueRange.end,
      text: renderHumanTomlString(identity.value, assignment.quote),
    },
  ]);
  if (!rewritten.ok) return null;
  const read = readManifestSource(rewritten.value);
  if (!read.ok || read.value.shape !== 'canonical') return null;
  const normalized = normalizeManifestDocument(read.value);
  return normalized.ok ? normalized.value : null;
};

const decode = (
  bytes: Uint8Array,
): ReturnType<ArtifactCodec<'manifest', 1, ManifestV1Dto, NormalizedManifestV1>['decode']> => {
  const owned = ownedSource(bytes);
  if (!owned.ok) return owned;
  const shape = classifyManifestSource(owned.value.source);
  if (shape === 'malformed') return fail('malformed', null);
  if (shape === 'future')
    return fail('unsupported-version', requestedVersion(owned.value.source), ['version']);
  if (shape !== 'canonical' && shape !== 'legacy') {
    return fail('invalid-shape', requestedVersion(owned.value.source));
  }

  if (shape === 'legacy') {
    const migrated = migrateLegacyManifestBytes(owned.value.bytes);
    if (!migrated.ok) {
      return fail(
        migrated.error.reason === 'unsafe-content' ? 'sensitive-content' : 'migration-failed',
        null,
      );
    }
    const read = readManifestSource(migrated.value.source);
    if (!read.ok || read.value.shape !== 'canonical') return fail('migration-failed', null);
    const normalized = normalizeManifestDocument(read.value);
    if (!normalized.ok) return fail('migration-failed', null);
    return ok(
      Object.freeze({
        source: Object.freeze({ kind: 'shape', id: 'legacy-project-config' }),
        model: normalized.value,
        canonical: false,
        migration: Object.freeze({
          mapperId: 'legacy-project-config-to-manifest-v1',
          targetVersion: 1,
        }),
      }),
    );
  }

  const read = readManifestSource(owned.value.source);
  if (!read.ok) return fail('invalid-shape', 1);
  let normalized = normalizeManifestDocument(read.value);
  if (!normalized.ok && normalized.error.field === 'registry.default') {
    const adapted = adaptCanonicalLegacyRegistry(owned.value.bytes, owned.value.source);
    if (adapted !== null) normalized = ok(adapted);
  }
  if (!normalized.ok) {
    return fail('invalid-shape', 1, fieldPath(normalized.error.field));
  }
  if (hasSensitiveArtifactContent(owned.value.source)) {
    return fail('sensitive-content', 1, sensitivePath(normalized.value) ?? []);
  }

  const generated = sourceFromDto(dtoFromModel(normalized.value));
  if (!generated.ok || !sameSemantics(normalized.value, generated.value.model)) {
    return fail('invalid-shape', 1);
  }
  const canonical = encoder.encode(generated.value.source);
  const exact =
    canonical.length === owned.value.bytes.length &&
    canonical.every((value, index) => value === owned.value.bytes[index]);
  return ok(
    Object.freeze({
      source: Object.freeze({ kind: 'version', version: 1 }),
      model: normalized.value,
      canonical: exact,
      migration: null,
    }),
  );
};

const encode = (model: NormalizedManifestV1): Result<Uint8Array, ArtifactCodecError> => {
  const normalized = normalizeDto(model);
  if (!normalized.ok) return normalized;
  const reread = readManifestSource(normalized.value.source);
  if (!reread.ok || reread.value.shape !== 'canonical') return fail('invalid-shape', 1);
  const verified = normalizeManifestDocument(reread.value);
  if (!verified.ok || !sameSemantics(normalized.value.model, verified.value)) {
    return fail('invalid-shape', 1);
  }
  if (hasSensitiveArtifactContent(normalized.value.source)) return fail('sensitive-content', 1);
  return ok(encoder.encode(normalized.value.source));
};

export const manifestV1Codec = Object.freeze({
  descriptor,
  validate,
  fromDto: fromManifestV1Dto,
  toDto: toManifestV1Dto,
  decode,
  encode,
}) satisfies ArtifactCodec<'manifest', 1, ManifestV1Dto, NormalizedManifestV1>;
