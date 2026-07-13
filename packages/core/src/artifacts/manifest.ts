import { parse as parseToml } from 'smol-toml';
import { SUPPORTED_TOOLS } from '../agents/registry.ts';
import { type Result, err, ok } from '../result.ts';
import {
  normalizePortablePath,
  normalizeRegistryIdentity,
  normalizeSourceIdentity,
  validateManifestName,
  validateRequestedRef,
} from './identity.ts';
import {
  MANIFEST_VERSION,
  type ManifestPlacement,
  type ManifestScope,
  type ManifestSemanticProjectionV1,
  type ManifestShape,
  type ManifestStateError,
  type ManifestTool,
  type NormalizedManifestDeclaration,
  type NormalizedManifestDefaults,
  type NormalizedManifestV1,
  type ReadableManifestDocument,
} from './types.ts';

type RawRecord = Record<string, unknown>;

const CANONICAL_ROOT_KEYS = new Set(['version', 'defaults', 'registry', 'skills']);
const LEGACY_ROOT_KEYS = new Set(['tool', 'scope', 'path', 'registry']);
const DEFAULT_KEYS = new Set(['tools', 'scope', 'path']);
const REGISTRY_KEYS = new Set(['default']);
const SKILL_KEYS = new Set(['name', 'source', 'ref', 'tools', 'scope', 'placement', 'path']);
const CANONICAL_MARKERS = new Set(['version', 'defaults', 'skills']);
const LEGACY_MARKERS = new Set(['tool', 'scope', 'path']);
const TOOL_IDS = new Set<string>(SUPPORTED_TOOLS);

const parsedDocuments = new WeakMap<ReadableManifestDocument, RawRecord>();

const isRecord = (value: unknown): value is RawRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: RawRecord, allowed: ReadonlySet<string>): boolean =>
  Object.keys(value).every((key) => allowed.has(key));

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

const isOptionalString = (record: RawRecord, key: string): boolean =>
  !(key in record) || typeof record[key] === 'string';

const isRegistryStructure = (value: unknown): boolean =>
  isRecord(value) &&
  hasOnlyKeys(value, REGISTRY_KEYS) &&
  (!('default' in value) || typeof value.default === 'string');

const isDefaultsStructure = (value: unknown): boolean =>
  isRecord(value) &&
  hasOnlyKeys(value, DEFAULT_KEYS) &&
  (!('tools' in value) || isStringArray(value.tools)) &&
  isOptionalString(value, 'scope') &&
  isOptionalString(value, 'path');

const isSkillStructure = (value: unknown): boolean =>
  isRecord(value) &&
  hasOnlyKeys(value, SKILL_KEYS) &&
  isOptionalString(value, 'name') &&
  isOptionalString(value, 'source') &&
  isOptionalString(value, 'ref') &&
  (!('tools' in value) || isStringArray(value.tools)) &&
  isOptionalString(value, 'scope') &&
  isOptionalString(value, 'placement') &&
  isOptionalString(value, 'path');

const hasExactIntegerVersionSyntax = (source: string): boolean => {
  for (const line of source.split('\n')) {
    const candidate = line.endsWith('\r') ? line.slice(0, -1) : line;
    const trimmed = candidate.trimStart();
    if (trimmed.startsWith('[')) return false;
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const assignment = /^(?:version|"version"|'version')[ \t]*=[ \t]*([^#]*?)[ \t]*(?:#.*)?$/u.exec(
      trimmed,
    );
    if (assignment === null) continue;
    return /^[+-]?(?:0|[1-9](?:_?[0-9])*)$/u.test(assignment[1] ?? '');
  }
  return false;
};

const isCanonicalStructure = (raw: RawRecord, source: string): boolean =>
  hasOnlyKeys(raw, CANONICAL_ROOT_KEYS) &&
  typeof raw.version === 'number' &&
  Number.isSafeInteger(raw.version) &&
  hasExactIntegerVersionSyntax(source) &&
  (!('defaults' in raw) || isDefaultsStructure(raw.defaults)) &&
  (!('registry' in raw) || isRegistryStructure(raw.registry)) &&
  (!('skills' in raw) ||
    (Array.isArray(raw.skills) && raw.skills.every((entry) => isSkillStructure(entry))));

const isLegacyStructure = (raw: RawRecord): boolean =>
  hasOnlyKeys(raw, LEGACY_ROOT_KEYS) &&
  isOptionalString(raw, 'tool') &&
  isOptionalString(raw, 'scope') &&
  isOptionalString(raw, 'path') &&
  (!('registry' in raw) || isRegistryStructure(raw.registry));

const classifyParsed = (raw: RawRecord, source: string): ManifestShape => {
  const keys = Object.keys(raw);
  if (keys.length === 0) return 'empty';
  const hasCanonicalMarker = keys.some((key) => CANONICAL_MARKERS.has(key));
  const hasLegacyMarker = keys.some((key) => LEGACY_MARKERS.has(key));
  if (hasCanonicalMarker && hasLegacyMarker) return 'mixed';
  if (hasCanonicalMarker) {
    if (!isCanonicalStructure(raw, source)) return 'unknown';
    if ((raw.version as number) > MANIFEST_VERSION) return 'future';
    return raw.version === MANIFEST_VERSION ? 'canonical' : 'unknown';
  }
  return isLegacyStructure(raw) ? 'legacy' : 'unknown';
};

const parseSource = (source: string): Result<RawRecord, ManifestShape> => {
  let parsed: unknown;
  try {
    parsed = parseToml(source);
  } catch {
    return err('malformed');
  }
  return isRecord(parsed) ? ok(parsed) : err('unknown');
};

const manifestError = (
  message: string,
  options: Readonly<{ field?: string; shape?: ManifestShape }> = {},
): ManifestStateError =>
  Object.freeze({
    code: 'manifest-state',
    exitCode: 3,
    ...(options.shape === undefined ? {} : { shape: options.shape }),
    ...(options.field === undefined ? {} : { field: options.field }),
    message,
  });

const semanticError = (field: string, message = 'manifest field is invalid') =>
  err(manifestError(message, { field }));

const deepFreeze = <T>(value: T, seen = new Set<object>()): T => {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
};

export const classifyManifestSource = (source: string): ManifestShape => {
  const parsed = parseSource(source);
  return parsed.ok ? classifyParsed(parsed.value, source) : parsed.error;
};

export const readManifestSource = (
  source: string,
): Result<ReadableManifestDocument, ManifestStateError> => {
  const parsed = parseSource(source);
  if (!parsed.ok) {
    return err(manifestError('manifest source is malformed', { shape: parsed.error }));
  }
  const shape = classifyParsed(parsed.value, source);
  if (shape !== 'canonical' && shape !== 'legacy') {
    return err(manifestError('manifest shape is not readable', { shape }));
  }
  const skills = Array.isArray(parsed.value.skills) ? parsed.value.skills : [];
  const declaredNames = Object.freeze(
    skills.flatMap((entry) =>
      isRecord(entry) && typeof entry.name === 'string' ? [entry.name] : [],
    ),
  );
  const document: ReadableManifestDocument = Object.freeze({
    shape,
    migrationPending: shape === 'legacy',
    source,
    declaredNames,
  });
  parsedDocuments.set(document, parsed.value);
  return ok(document);
};

const normalizeTools = (
  value: unknown,
  field: string,
): Result<readonly ManifestTool[], ManifestStateError> => {
  if (!isStringArray(value) || value.length === 0 || new Set(value).size !== value.length) {
    return semanticError(field, 'manifest tools must be a nonempty unique array');
  }
  if (value.some((tool) => !TOOL_IDS.has(tool))) {
    return semanticError(field, 'manifest contains an unknown tool');
  }
  return ok(Object.freeze([...value].sort()) as readonly ManifestTool[]);
};

const normalizeScope = (
  value: unknown,
  field: string,
): Result<ManifestScope, ManifestStateError> =>
  value === 'user' || value === 'project'
    ? ok(value)
    : semanticError(field, 'manifest scope must be user or project');

const normalizeDefaults = (
  raw: RawRecord | undefined,
): Result<NormalizedManifestDefaults | undefined, ManifestStateError> => {
  if (raw === undefined || Object.keys(raw).length === 0) return ok(undefined);
  let tools: readonly ManifestTool[] | undefined;
  let scope: ManifestScope | undefined;
  let path: string | undefined;

  if ('tools' in raw) {
    const result = normalizeTools(raw.tools, 'defaults.tools');
    if (!result.ok) return result;
    tools = result.value;
  }
  if ('scope' in raw) {
    const result = normalizeScope(raw.scope, 'defaults.scope');
    if (!result.ok) return result;
    scope = result.value;
  }
  if ('path' in raw) {
    if (scope === undefined) {
      return semanticError('defaults.path', 'manifest path requires an effective scope');
    }
    const result = normalizePortablePath(raw.path as string, scope, 'defaults.path');
    if (!result.ok) return result;
    path = result.value;
  }

  return ok(
    deepFreeze({
      ...(tools === undefined ? {} : { tools }),
      ...(scope === undefined ? {} : { scope }),
      ...(path === undefined ? {} : { path }),
    }),
  );
};

const normalizeCanonicalRegistry = (
  raw: RawRecord | undefined,
): Result<Readonly<{ readonly default?: string }> | undefined, ManifestStateError> => {
  if (raw === undefined || !('default' in raw)) return ok(undefined);
  const result = normalizeRegistryIdentity(raw.default as string);
  if (!result.ok) return result;
  return ok(Object.freeze({ default: result.value }));
};

const normalizeCanonical = (raw: RawRecord): Result<NormalizedManifestV1, ManifestStateError> => {
  const defaultsResult = normalizeDefaults(isRecord(raw.defaults) ? raw.defaults : undefined);
  if (!defaultsResult.ok) return defaultsResult;
  const defaults = defaultsResult.value;
  const registryResult = normalizeCanonicalRegistry(
    isRecord(raw.registry) ? raw.registry : undefined,
  );
  if (!registryResult.ok) return registryResult;

  const normalizedSkills: NormalizedManifestDeclaration[] = [];
  const seenNames = new Set<string>();
  const skills = Array.isArray(raw.skills) ? raw.skills : [];
  for (let index = 0; index < skills.length; index += 1) {
    const entry = skills[index];
    if (!isRecord(entry)) return semanticError(`skills.${index}`);
    const prefix = `skills.${index}`;
    if (typeof entry.name !== 'string') {
      return semanticError(`${prefix}.name`, 'manifest declaration name is required');
    }
    const nameResult = validateManifestName(entry.name, `${prefix}.name`);
    if (!nameResult.ok) return nameResult;
    if (seenNames.has(nameResult.value)) {
      return semanticError(`${prefix}.name`, 'manifest declaration names must be unique');
    }
    seenNames.add(nameResult.value);

    if (typeof entry.source !== 'string') {
      return semanticError(`${prefix}.source`, 'manifest declaration source is required');
    }
    const sourceResult = normalizeSourceIdentity(entry.source, `${prefix}.source`);
    if (!sourceResult.ok) return sourceResult;

    const toolsResult = normalizeTools(
      'tools' in entry ? entry.tools : defaults?.tools,
      `${prefix}.tools`,
    );
    if (!toolsResult.ok) return toolsResult;
    const scopeResult = normalizeScope(
      'scope' in entry ? entry.scope : defaults?.scope,
      `${prefix}.scope`,
    );
    if (!scopeResult.ok) return scopeResult;

    let ref: string | null = null;
    if ('ref' in entry) {
      const refResult = validateRequestedRef(entry.ref as string, `${prefix}.ref`);
      if (!refResult.ok) return refResult;
      ref = refResult.value;
    }
    const placement = entry.placement ?? 'symlink';
    if (placement !== 'symlink' && placement !== 'copy') {
      return semanticError(`${prefix}.placement`, 'manifest placement is invalid');
    }
    let path: string | null = null;
    if ('path' in entry) {
      const pathResult = normalizePortablePath(
        entry.path as string,
        scopeResult.value,
        `${prefix}.path`,
      );
      if (!pathResult.ok) return pathResult;
      path = pathResult.value;
    }

    normalizedSkills.push(
      deepFreeze({
        name: nameResult.value,
        source: sourceResult.value,
        ref,
        tools: toolsResult.value,
        scope: scopeResult.value,
        placement: placement as ManifestPlacement,
        path,
      }),
    );
  }

  return ok(
    deepFreeze({
      version: MANIFEST_VERSION,
      ...(defaults === undefined ? {} : { defaults }),
      ...(registryResult.value === undefined ? {} : { registry: registryResult.value }),
      skills: normalizedSkills,
    }),
  );
};

const normalizeLegacy = (raw: RawRecord): Result<NormalizedManifestV1, ManifestStateError> => {
  let tools: readonly ManifestTool[] | undefined;
  let scope: ManifestScope | undefined;
  let path: string | undefined;

  if ('tool' in raw) {
    const result = normalizeTools([raw.tool], 'tool');
    if (!result.ok) return result;
    tools = result.value;
  }
  if ('scope' in raw) {
    const result = normalizeScope(raw.scope, 'scope');
    if (!result.ok) return result;
    scope = result.value;
  }
  if ('path' in raw) {
    if (scope === undefined) return semanticError('path', 'manifest path requires a scope');
    const result = normalizePortablePath(raw.path as string, scope, 'path');
    if (!result.ok) return result;
    path = result.value;
  }

  let registry: Readonly<{ readonly default: string }> | undefined;
  if (isRecord(raw.registry) && typeof raw.registry.default === 'string') {
    const legacyUrl = /^https:\/\//iu.test(raw.registry.default);
    const result = normalizeRegistryIdentity(raw.registry.default, { legacy: legacyUrl });
    if (!result.ok) return result;
    registry = Object.freeze({ default: result.value });
  }

  const hasDefaults = tools !== undefined || scope !== undefined || path !== undefined;
  const defaults = hasDefaults
    ? deepFreeze({
        ...(tools === undefined ? {} : { tools }),
        ...(scope === undefined ? {} : { scope }),
        ...(path === undefined ? {} : { path }),
      })
    : undefined;
  return ok(
    deepFreeze({
      version: MANIFEST_VERSION,
      ...(defaults === undefined ? {} : { defaults }),
      ...(registry === undefined ? {} : { registry }),
      skills: [],
    }),
  );
};

export const normalizeManifestDocument = (
  document: ReadableManifestDocument,
): Result<NormalizedManifestV1, ManifestStateError> => {
  let raw = parsedDocuments.get(document);
  let shape: ManifestShape = document.shape;
  if (raw === undefined) {
    const parsed = parseSource(document.source);
    if (!parsed.ok) {
      return err(manifestError('manifest source is malformed', { shape: parsed.error }));
    }
    raw = parsed.value;
    shape = classifyParsed(raw, document.source);
  }
  if (shape === 'canonical') return normalizeCanonical(raw);
  if (shape === 'legacy') return normalizeLegacy(raw);
  return err(manifestError('manifest shape is not normalizable', { shape }));
};

export const projectManifestSemantics = (
  manifest: NormalizedManifestV1,
): ManifestSemanticProjectionV1 => {
  const defaults = manifest.defaults;
  const projectedDefaults =
    defaults === undefined
      ? undefined
      : {
          ...(defaults.tools === undefined
            ? {}
            : { tools: Object.freeze([...defaults.tools].sort()) }),
          ...(defaults.scope === undefined ? {} : { scope: defaults.scope }),
          ...(defaults.path === undefined ? {} : { path: defaults.path }),
        };
  const registry =
    manifest.registry?.default === undefined ? undefined : { default: manifest.registry.default };
  const skills = [...manifest.skills]
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map((entry) => ({
      name: entry.name,
      source: {
        host: entry.source.host,
        repository: entry.source.repository,
        path: entry.source.path,
      },
      ref: entry.ref,
      tools: [...entry.tools].sort(),
      scope: entry.scope,
      placement: entry.placement,
      path: entry.path,
    }));
  return deepFreeze({
    version: MANIFEST_VERSION,
    ...(projectedDefaults === undefined ? {} : { defaults: projectedDefaults }),
    ...(registry === undefined ? {} : { registry }),
    skills,
  });
};
