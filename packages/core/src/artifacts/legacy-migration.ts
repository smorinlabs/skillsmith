import { types as utilTypes } from 'node:util';
import { type Result, err, ok } from '../result.ts';
import { containsSensitiveMaterial } from '../safety/redaction.ts';
import { type ArtifactDigest, hashManifestSemantics } from './hash.ts';
import {
  type HumanTomlAssignment,
  type HumanTomlDocument,
  type HumanTomlHeader,
  type HumanTomlReplacement,
  applyHumanTomlReplacements,
  renderHumanTomlString,
  scanHumanToml,
} from './human-toml.ts';
import {
  normalizeManifestDocument,
  projectManifestSemantics,
  readManifestSource,
} from './manifest.ts';
import type { NormalizedManifestV1 } from './types.ts';

export interface LegacyManifestMigration {
  readonly source: string;
  readonly beforeSemanticHash: ArtifactDigest;
  readonly afterSemanticHash: ArtifactDigest;
}

export interface LegacyManifestMigrationError {
  readonly code: 'legacy-manifest-migration';
  readonly reason: 'invalid-input' | 'unsafe-range' | 'unsafe-content';
  readonly message: string;
}

const MESSAGES: Readonly<Record<LegacyManifestMigrationError['reason'], string>> = Object.freeze({
  'invalid-input': 'legacy manifest input is invalid',
  'unsafe-range': 'legacy manifest ranges cannot be migrated safely',
  'unsafe-content': 'legacy manifest content cannot be retained safely',
});

const migrationError = (
  reason: LegacyManifestMigrationError['reason'],
): LegacyManifestMigrationError =>
  Object.freeze({
    code: 'legacy-manifest-migration',
    reason,
    message: MESSAGES[reason],
  });

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get;
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;
const copyBytes = Uint8Array.prototype.set;

const ownOrdinaryBytes = (input: Uint8Array): Result<Uint8Array, LegacyManifestMigrationError> => {
  try {
    if (
      utilTypes.isProxy(input) ||
      !(input instanceof Uint8Array) ||
      Object.getPrototypeOf(input) !== Uint8Array.prototype ||
      Object.getOwnPropertySymbols(input).length > 0 ||
      bufferGetter === undefined ||
      byteLengthGetter === undefined
    ) {
      return err(migrationError('invalid-input'));
    }
    const buffer = Reflect.apply(bufferGetter, input, []) as ArrayBufferLike;
    const byteLength = Reflect.apply(byteLengthGetter, input, []) as number;
    const propertyKeys = Reflect.ownKeys(input);
    if (
      !(buffer instanceof ArrayBuffer) ||
      Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < 0 ||
      propertyKeys.length !== byteLength ||
      propertyKeys.some((key, index) => typeof key !== 'string' || key !== String(index))
    ) {
      return err(migrationError('invalid-input'));
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
        return err(migrationError('invalid-input'));
      }
    }
    const owned = new Uint8Array(byteLength);
    Reflect.apply(copyBytes, owned, [input]);
    return ok(owned);
  } catch {
    return err(migrationError('invalid-input'));
  }
};

const samePath = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((entry, index) => entry === right[index]);

const assignmentsAt = (
  document: HumanTomlDocument,
  tablePath: readonly string[],
  key: string,
): readonly HumanTomlAssignment[] =>
  document.assignments.filter(
    (entry) =>
      samePath(entry.tablePath, tablePath) &&
      entry.arrayTableIndex === null &&
      entry.keyPath.length === 1 &&
      entry.keyPath[0] === key &&
      !entry.dotted,
  );

const exactLegacyRanges = (
  document: HumanTomlDocument,
  before: NormalizedManifestV1,
): Readonly<{
  root: readonly HumanTomlAssignment[];
  tool: HumanTomlAssignment | null;
  registry: HumanTomlAssignment | null;
  registryHeader: HumanTomlHeader | null;
}> | null => {
  if (document.lines.some((line) => line.kind === 'other' || line.kind === 'continuation')) {
    return null;
  }
  if (
    document.headers.some(
      (header) => header.array || header.dotted || !samePath(header.path, ['registry']),
    )
  ) {
    return null;
  }
  const registryHeaders = document.headers.filter((header) => samePath(header.path, ['registry']));
  if (registryHeaders.length > 1) return null;

  const root = document.assignments.filter(
    (entry) =>
      entry.tablePath.length === 0 &&
      entry.arrayTableIndex === null &&
      entry.keyPath.length === 1 &&
      !entry.dotted &&
      (entry.keyPath[0] === 'tool' || entry.keyPath[0] === 'scope' || entry.keyPath[0] === 'path'),
  );
  const registryAssignments = assignmentsAt(document, ['registry'], 'default');
  if (
    root.length + registryAssignments.length !== document.assignments.length ||
    root.some((entry) => entry.multiline) ||
    registryAssignments.some((entry) => entry.multiline)
  ) {
    return null;
  }

  const toolAssignments = assignmentsAt(document, [], 'tool');
  const scopeAssignments = assignmentsAt(document, [], 'scope');
  const pathAssignments = assignmentsAt(document, [], 'path');
  const expectedCounts = [
    [toolAssignments, before.defaults?.tools === undefined ? 0 : 1],
    [scopeAssignments, before.defaults?.scope === undefined ? 0 : 1],
    [pathAssignments, before.defaults?.path === undefined ? 0 : 1],
    [registryAssignments, before.registry?.default === undefined ? 0 : 1],
  ] as const;
  if (expectedCounts.some(([entries, count]) => entries.length !== count)) return null;
  if ((registryAssignments.length === 1) !== (registryHeaders.length === 1)) return null;

  return Object.freeze({
    root: Object.freeze(root),
    tool: toolAssignments[0] ?? null,
    registry: registryAssignments[0] ?? null,
    registryHeader: registryHeaders[0] ?? null,
  });
};

const newlineOf = (document: HumanTomlDocument): '\n' | '\r\n' | null => {
  const forms = new Set(document.lines.map((line) => line.newline).filter((value) => value !== ''));
  if (forms.size === 0) return '\n';
  return forms.size === 1 ? ([...forms][0] as '\n' | '\r\n') : null;
};

const insertionStart = (target: HumanTomlAssignment | HumanTomlHeader): number =>
  target.leadingCommentStart === null || target.leadingCommentStart === 0
    ? target.start
    : target.leadingCommentStart;

const renamedToolKey = (assignment: HumanTomlAssignment): string => {
  const trimmed = assignment.rawKey.trim();
  if (trimmed.startsWith("'")) return "'tools'";
  if (trimmed.startsWith('"')) return '"tools"';
  return 'tools';
};

const canonicalRead = (source: string): NormalizedManifestV1 | null => {
  const read = readManifestSource(source);
  if (!read.ok || read.value.shape !== 'canonical') return null;
  const normalized = normalizeManifestDocument(read.value);
  return normalized.ok ? normalized.value : null;
};

const sameSemantics = (left: NormalizedManifestV1, right: NormalizedManifestV1): boolean =>
  JSON.stringify(projectManifestSemantics(left)) ===
  JSON.stringify(projectManifestSemantics(right));

const apply = (source: string, replacements: readonly HumanTomlReplacement[]): string | null => {
  const result = applyHumanTomlReplacements(source, replacements);
  return result.ok ? result.value : null;
};

export const migrateLegacyManifestBytes = (
  bytes: Uint8Array,
): Result<LegacyManifestMigration, LegacyManifestMigrationError> => {
  const owned = ownOrdinaryBytes(bytes);
  if (!owned.ok) return owned;
  const scanned = scanHumanToml(owned.value);
  if (!scanned.ok) return err(migrationError('invalid-input'));
  const document = scanned.value;
  const read = readManifestSource(document.source);
  if (!read.ok || read.value.shape !== 'legacy') return err(migrationError('invalid-input'));
  const normalized = normalizeManifestDocument(read.value);
  if (!normalized.ok) return err(migrationError('invalid-input'));
  const before = normalized.value;
  const ranges = exactLegacyRanges(document, before);
  if (ranges === null) return err(migrationError('unsafe-range'));
  const newline = newlineOf(document);
  if (newline === null) return err(migrationError('unsafe-range'));

  const firstRoot = ranges.root[0] ?? null;
  const structuralTarget = firstRoot ?? ranges.registryHeader;
  if (structuralTarget === null) return err(migrationError('invalid-input'));
  const replacements: HumanTomlReplacement[] = [
    {
      start: insertionStart(structuralTarget),
      end: insertionStart(structuralTarget),
      text:
        firstRoot === null
          ? `version = 1${newline}${newline}`
          : `version = 1${newline}${newline}[defaults]${newline}`,
    },
  ];

  if (ranges.tool !== null) {
    replacements.push(
      {
        start: ranges.tool.keyRange.start,
        end: ranges.tool.keyRange.end,
        text: renamedToolKey(ranges.tool),
      },
      {
        start: ranges.tool.valueRange.start,
        end: ranges.tool.valueRange.end,
        text: `[${ranges.tool.value}]`,
      },
    );
  }

  let candidate = apply(document.source, replacements);
  if (candidate === null) return err(migrationError('unsafe-range'));
  let after = canonicalRead(candidate);

  // A canonical registry token is already valid after the table insertion. Exact legacy HTTPS
  // spelling is the sole legacy registry form that requires a value-range rewrite.
  if ((after === null || !sameSemantics(before, after)) && ranges.registry !== null) {
    const registry = before.registry?.default;
    if (registry === undefined) return err(migrationError('unsafe-range'));
    candidate = apply(document.source, [
      ...replacements,
      {
        start: ranges.registry.valueRange.start,
        end: ranges.registry.valueRange.end,
        text: renderHumanTomlString(registry, ranges.registry.quote),
      },
    ]);
    if (candidate === null) return err(migrationError('unsafe-range'));
    after = canonicalRead(candidate);
  }

  if (after === null || !sameSemantics(before, after)) {
    return err(migrationError('unsafe-range'));
  }
  if (containsSensitiveMaterial(candidate)) return err(migrationError('unsafe-content'));

  return ok(
    Object.freeze({
      source: candidate,
      beforeSemanticHash: hashManifestSemantics(before),
      afterSemanticHash: hashManifestSemantics(after),
    }),
  );
};
