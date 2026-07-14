import { types as utilTypes } from 'node:util';
import { SUPPORTED_TOOLS } from '../agents/registry.ts';
import { type Result, err, ok } from '../result.ts';
import { containsSensitiveMaterial, redactSensitiveString } from '../safety/redaction.ts';
import type { ArtifactMutationError } from './coordinator-types.ts';
import { type ArtifactDigest, hashManifestSemantics } from './hash.ts';
import {
  type HumanTomlAssignment,
  type HumanTomlDocument,
  type HumanTomlHeader,
  type HumanTomlReplacement,
  applyHumanTomlReplacements,
  renderHumanTomlString,
  renderHumanTomlStringArray,
  scanHumanToml,
} from './human-toml.ts';
import {
  normalizeManifestDocument,
  projectManifestSemantics,
  readManifestSource,
} from './manifest.ts';
import type {
  CanonicalSourceIdentity,
  ManifestPlacement,
  ManifestScope,
  ManifestTool,
  NormalizedManifestDeclaration,
  NormalizedManifestV1,
} from './types.ts';

export type ManifestDefaultSetEdit =
  | {
      readonly kind: 'set-default';
      readonly field: 'tools';
      readonly value: readonly ManifestTool[];
    }
  | { readonly kind: 'set-default'; readonly field: 'scope'; readonly value: ManifestScope }
  | { readonly kind: 'set-default'; readonly field: 'path'; readonly value: string };

export type ManifestSkillSetEdit =
  | {
      readonly kind: 'set-skill-field';
      readonly name: string;
      readonly field: 'source';
      readonly value: string;
    }
  | {
      readonly kind: 'set-skill-field';
      readonly name: string;
      readonly field: 'ref';
      readonly value: string;
    }
  | {
      readonly kind: 'set-skill-field';
      readonly name: string;
      readonly field: 'tools';
      readonly value: readonly ManifestTool[];
    }
  | {
      readonly kind: 'set-skill-field';
      readonly name: string;
      readonly field: 'scope';
      readonly value: ManifestScope;
    }
  | {
      readonly kind: 'set-skill-field';
      readonly name: string;
      readonly field: 'placement';
      readonly value: ManifestPlacement;
    }
  | {
      readonly kind: 'set-skill-field';
      readonly name: string;
      readonly field: 'path';
      readonly value: string;
    };

export type ManifestEdit =
  | ManifestDefaultSetEdit
  | { readonly kind: 'unset-default'; readonly field: 'tools' | 'scope' | 'path' }
  | { readonly kind: 'set-registry-default'; readonly value: string }
  | { readonly kind: 'unset-registry-default' }
  | ManifestSkillSetEdit
  | {
      readonly kind: 'unset-skill-field';
      readonly name: string;
      readonly field: 'ref' | 'tools' | 'scope' | 'placement' | 'path';
    }
  | { readonly kind: 'add-skill'; readonly declaration: NormalizedManifestDeclaration }
  | { readonly kind: 'remove-skill'; readonly name: string }
  | { readonly kind: 'migrate-legacy' };

export type ManifestEditTarget =
  | { readonly kind: 'migration' }
  | { readonly kind: 'default'; readonly field: 'tools' | 'scope' | 'path' }
  | { readonly kind: 'registry-default' }
  | {
      readonly kind: 'skill-field';
      readonly name: string;
      readonly field: 'source' | 'ref' | 'tools' | 'scope' | 'placement' | 'path';
    }
  | { readonly kind: 'skill-declaration'; readonly name: string };

export interface ManifestEditRequest {
  readonly edits: readonly ManifestEdit[];
}

export interface ManifestEditResult {
  readonly bytes: Uint8Array;
  readonly source: string;
  readonly changed: boolean;
  readonly migrated: boolean;
  readonly beforeSemanticHash: ArtifactDigest;
  readonly afterSemanticHash: ArtifactDigest;
  readonly touchedTargets: readonly ManifestEditTarget[];
}

type MutableDeclaration = {
  name: string;
  source: CanonicalSourceIdentity;
  ref: string | null;
  tools: ManifestTool[];
  scope: ManifestScope;
  placement: ManifestPlacement;
  path: string | null;
};

type MutableManifest = {
  version: 1;
  defaults?: { tools?: ManifestTool[]; scope?: ManifestScope; path?: string } | undefined;
  registry?: { default?: string } | undefined;
  skills: MutableDeclaration[];
};

const MANIFEST_TOOLS: ReadonlySet<string> = new Set(SUPPORTED_TOOLS);

const REASON_MESSAGES: Readonly<Record<ArtifactMutationError['reason'], string>> = Object.freeze({
  'invalid-request': 'manifest edit request is invalid',
  'unsafe-human-edit': 'manifest source cannot be edited safely',
  'invalid-utf8': 'manifest source is not valid UTF-8',
  'invalid-manifest': 'manifest source is invalid',
  'invalid-lock': 'portable lock source is invalid',
  'invalid-file-kind': 'artifact path has an invalid file kind',
  'artifact-alias': 'artifact paths alias the same file',
  'lock-contention': 'artifact lock is contended',
  'external-writer-conflict': 'artifact changed outside this operation',
  'stage-collision': 'artifact staging name collided',
  'recovery-record-invalid': 'artifact recovery record is invalid',
  'recovery-conflict': 'artifact recovery cannot prove a safe state',
  'filesystem-failure': 'artifact filesystem operation failed',
  'permission-denied': 'artifact filesystem permission was denied',
  cancelled: 'artifact operation was cancelled',
});

const mutationError = (
  reason: ArtifactMutationError['reason'],
  options: Readonly<{ field?: string; manualPatch?: string }> = {},
): ArtifactMutationError =>
  Object.freeze({
    code: 'artifact-mutation',
    exitCode: reason === 'invalid-request' || reason === 'unsafe-human-edit' ? 2 : 3,
    reason,
    role: 'manifest',
    ...(options.field === undefined ? {} : { field: redactSensitiveString(options.field) }),
    ...(options.manualPatch === undefined
      ? {}
      : { manualPatch: redactSensitiveString(options.manualPatch) }),
    message: REASON_MESSAGES[reason],
  }) as ArtifactMutationError;

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
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !(key in descriptors))) {
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
  const lengthValue = lengthDescriptor?.value;
  if (
    typeof lengthValue !== 'number' ||
    !Number.isSafeInteger(lengthValue) ||
    lengthValue < 0 ||
    lengthValue > 10_000
  )
    return null;
  const length = lengthValue;
  const result: unknown[] = [];
  for (const key of Object.keys(descriptors)) {
    if (key === 'length') continue;
    if (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length) return null;
  }
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !('value' in descriptor)) return null;
    result.push(descriptor.value);
  }
  return result;
};

const toolsValue = (value: unknown): readonly ManifestTool[] | null => {
  const array = ownArray(value);
  if (array === null || array.length === 0 || new Set(array).size !== array.length) return null;
  if (array.some((entry) => typeof entry !== 'string' || !MANIFEST_TOOLS.has(entry))) return null;
  return Object.freeze([...array] as ManifestTool[]);
};

const sourceIdentityValue = (value: unknown): CanonicalSourceIdentity | null => {
  const record = ownData(value, ['host', 'repository', 'path']);
  if (
    record === null ||
    typeof record.host !== 'string' ||
    typeof record.repository !== 'string' ||
    (record.path !== null && typeof record.path !== 'string')
  ) {
    return null;
  }
  return Object.freeze({ host: record.host, repository: record.repository, path: record.path });
};

const declarationValue = (value: unknown): NormalizedManifestDeclaration | null => {
  const record = ownData(value, ['name', 'source', 'ref', 'tools', 'scope', 'placement', 'path']);
  if (record === null || typeof record.name !== 'string') return null;
  const source = sourceIdentityValue(record.source);
  const tools = toolsValue(record.tools);
  if (
    source === null ||
    tools === null ||
    (record.ref !== null && typeof record.ref !== 'string') ||
    (record.scope !== 'user' && record.scope !== 'project') ||
    (record.placement !== 'copy' && record.placement !== 'symlink') ||
    (record.path !== null && typeof record.path !== 'string')
  ) {
    return null;
  }
  return Object.freeze({
    name: record.name,
    source,
    ref: record.ref,
    tools,
    scope: record.scope,
    placement: record.placement,
    path: record.path,
  });
};

interface ValidatedRequest {
  readonly edits: readonly ManifestEdit[];
  readonly targets: readonly ManifestEditTarget[];
}

const targetOf = (edit: ManifestEdit): ManifestEditTarget => {
  switch (edit.kind) {
    case 'migrate-legacy':
      return Object.freeze({ kind: 'migration' });
    case 'set-default':
    case 'unset-default':
      return Object.freeze({ kind: 'default', field: edit.field });
    case 'set-registry-default':
    case 'unset-registry-default':
      return Object.freeze({ kind: 'registry-default' });
    case 'set-skill-field':
    case 'unset-skill-field':
      return Object.freeze({ kind: 'skill-field', name: edit.name, field: edit.field });
    case 'add-skill':
      return Object.freeze({ kind: 'skill-declaration', name: edit.declaration.name });
    case 'remove-skill':
      return Object.freeze({ kind: 'skill-declaration', name: edit.name });
  }
};

const validateEdit = (value: unknown): ManifestEdit | null => {
  if (!isOrdinaryObject(value) || Object.getOwnPropertySymbols(value).length > 0) return null;
  const kindDescriptor = Object.getOwnPropertyDescriptor(value, 'kind');
  if (
    kindDescriptor === undefined ||
    !('value' in kindDescriptor) ||
    typeof kindDescriptor.value !== 'string'
  )
    return null;
  switch (kindDescriptor.value) {
    case 'migrate-legacy': {
      const record = ownData(value, ['kind']);
      return record === null ? null : Object.freeze({ kind: 'migrate-legacy' });
    }
    case 'set-default': {
      const record = ownData(value, ['kind', 'field', 'value']);
      if (record === null) return null;
      if (record.field === 'tools') {
        const tools = toolsValue(record.value);
        return tools === null
          ? null
          : Object.freeze({ kind: 'set-default', field: 'tools', value: tools });
      }
      if (record.field === 'scope' && (record.value === 'user' || record.value === 'project')) {
        return Object.freeze({ kind: 'set-default', field: 'scope', value: record.value });
      }
      if (record.field === 'path' && typeof record.value === 'string') {
        return Object.freeze({ kind: 'set-default', field: 'path', value: record.value });
      }
      return null;
    }
    case 'unset-default': {
      const record = ownData(value, ['kind', 'field']);
      return record !== null &&
        (record.field === 'tools' || record.field === 'scope' || record.field === 'path')
        ? Object.freeze({ kind: 'unset-default', field: record.field })
        : null;
    }
    case 'set-registry-default': {
      const record = ownData(value, ['kind', 'value']);
      return record !== null && typeof record.value === 'string'
        ? Object.freeze({ kind: 'set-registry-default', value: record.value })
        : null;
    }
    case 'unset-registry-default': {
      const record = ownData(value, ['kind']);
      return record === null ? null : Object.freeze({ kind: 'unset-registry-default' });
    }
    case 'set-skill-field': {
      const record = ownData(value, ['kind', 'name', 'field', 'value']);
      if (record === null || typeof record.name !== 'string') return null;
      if (record.field === 'tools') {
        const tools = toolsValue(record.value);
        return tools === null
          ? null
          : Object.freeze({
              kind: 'set-skill-field',
              name: record.name,
              field: 'tools',
              value: tools,
            });
      }
      if (record.field === 'scope' && (record.value === 'user' || record.value === 'project')) {
        return Object.freeze({
          kind: 'set-skill-field',
          name: record.name,
          field: 'scope',
          value: record.value,
        });
      }
      if (record.field === 'placement' && (record.value === 'copy' || record.value === 'symlink')) {
        return Object.freeze({
          kind: 'set-skill-field',
          name: record.name,
          field: 'placement',
          value: record.value,
        });
      }
      if (
        (record.field === 'source' || record.field === 'ref' || record.field === 'path') &&
        typeof record.value === 'string'
      ) {
        return Object.freeze({
          kind: 'set-skill-field',
          name: record.name,
          field: record.field,
          value: record.value,
        }) as ManifestEdit;
      }
      return null;
    }
    case 'unset-skill-field': {
      const record = ownData(value, ['kind', 'name', 'field']);
      return record !== null &&
        typeof record.name === 'string' &&
        (record.field === 'ref' ||
          record.field === 'tools' ||
          record.field === 'scope' ||
          record.field === 'placement' ||
          record.field === 'path')
        ? Object.freeze({ kind: 'unset-skill-field', name: record.name, field: record.field })
        : null;
    }
    case 'add-skill': {
      const record = ownData(value, ['kind', 'declaration']);
      if (record === null) return null;
      const declaration = declarationValue(record.declaration);
      return declaration === null ? null : Object.freeze({ kind: 'add-skill', declaration });
    }
    case 'remove-skill': {
      const record = ownData(value, ['kind', 'name']);
      return record !== null && typeof record.name === 'string'
        ? Object.freeze({ kind: 'remove-skill', name: record.name })
        : null;
    }
    default:
      return null;
  }
};

const validateRequest = (
  input: ManifestEditRequest,
): Result<ValidatedRequest, ArtifactMutationError> => {
  const record = ownData(input, ['edits']);
  if (record === null) return err(mutationError('invalid-request'));
  const rawEdits = ownArray(record.edits);
  if (rawEdits === null || rawEdits.length === 0) return err(mutationError('invalid-request'));
  const edits: ManifestEdit[] = [];
  const targets: ManifestEditTarget[] = [];
  const seenTargets = new Set<string>();
  const removedNames = new Set<string>();
  const updatedNames = new Set<string>();
  let migrations = 0;
  for (let index = 0; index < rawEdits.length; index += 1) {
    const edit = validateEdit(rawEdits[index]);
    if (edit === null) return err(mutationError('invalid-request'));
    if (edit.kind === 'migrate-legacy') {
      migrations += 1;
      if (index !== 0 || migrations !== 1) return err(mutationError('invalid-request'));
    }
    const target = targetOf(edit);
    const tuple = JSON.stringify(target);
    if (seenTargets.has(tuple)) return err(mutationError('invalid-request'));
    seenTargets.add(tuple);
    if (edit.kind === 'remove-skill') removedNames.add(edit.name);
    if (edit.kind === 'set-skill-field' || edit.kind === 'unset-skill-field')
      updatedNames.add(edit.name);
    edits.push(edit);
    targets.push(target);
  }
  if ([...removedNames].some((name) => updatedNames.has(name))) {
    return err(mutationError('invalid-request'));
  }
  return ok(Object.freeze({ edits: Object.freeze(edits), targets: Object.freeze(targets) }));
};

const mutableManifest = (manifest: NormalizedManifestV1): MutableManifest => ({
  version: 1,
  ...(manifest.defaults === undefined
    ? {}
    : {
        defaults: {
          ...(manifest.defaults.tools === undefined ? {} : { tools: [...manifest.defaults.tools] }),
          ...(manifest.defaults.scope === undefined ? {} : { scope: manifest.defaults.scope }),
          ...(manifest.defaults.path === undefined ? {} : { path: manifest.defaults.path }),
        },
      }),
  ...(manifest.registry === undefined ? {} : { registry: { ...manifest.registry } }),
  skills: manifest.skills.map((entry) => ({
    name: entry.name,
    source: { ...entry.source },
    ref: entry.ref,
    tools: [...entry.tools],
    scope: entry.scope,
    placement: entry.placement,
    path: entry.path,
  })),
});

const sourceToken = (source: CanonicalSourceIdentity): string =>
  `${source.host}/${source.repository}${source.path === null ? '' : `//${source.path}`}`;

const serializeDeclaration = (
  declaration: MutableDeclaration | NormalizedManifestDeclaration,
  defaults: MutableManifest['defaults'],
  newline: string,
): string => {
  const lines = [
    '[[skills]]',
    `name = ${JSON.stringify(declaration.name)}`,
    `source = ${JSON.stringify(sourceToken(declaration.source))}`,
  ];
  if (declaration.ref !== null) lines.push(`ref = ${JSON.stringify(declaration.ref)}`);
  if (
    defaults?.tools === undefined ||
    JSON.stringify(defaults.tools) !== JSON.stringify(declaration.tools)
  ) {
    lines.push(`tools = ${renderHumanTomlStringArray(declaration.tools)}`);
  }
  if (defaults?.scope === undefined || defaults.scope !== declaration.scope) {
    lines.push(`scope = ${JSON.stringify(declaration.scope)}`);
  }
  if (declaration.placement !== 'symlink')
    lines.push(`placement = ${JSON.stringify(declaration.placement)}`);
  if (declaration.path !== null) lines.push(`path = ${JSON.stringify(declaration.path)}`);
  return lines.join(newline);
};

const serializeCanonicalManifest = (manifest: MutableManifest, newline = '\n'): string => {
  const sections: string[] = ['version = 1'];
  if (manifest.defaults !== undefined && Object.keys(manifest.defaults).length > 0) {
    const lines = ['[defaults]'];
    if (manifest.defaults.tools !== undefined)
      lines.push(`tools = ${renderHumanTomlStringArray(manifest.defaults.tools)}`);
    if (manifest.defaults.scope !== undefined)
      lines.push(`scope = ${JSON.stringify(manifest.defaults.scope)}`);
    if (manifest.defaults.path !== undefined)
      lines.push(`path = ${JSON.stringify(manifest.defaults.path)}`);
    sections.push(lines.join(newline));
  }
  if (manifest.registry?.default !== undefined) {
    sections.push(`[registry]${newline}default = ${JSON.stringify(manifest.registry.default)}`);
  }
  for (const declaration of manifest.skills) {
    sections.push(serializeDeclaration(declaration, manifest.defaults, newline));
  }
  return `${sections.join(`${newline}${newline}`)}${newline}`;
};

const validateExpected = (
  manifest: MutableManifest,
): Result<NormalizedManifestV1, ArtifactMutationError> => {
  const source = serializeCanonicalManifest(manifest);
  const read = readManifestSource(source);
  if (!read.ok) return err(mutationError('invalid-request'));
  const normalized = normalizeManifestDocument(read.value);
  return normalized.ok ? ok(normalized.value) : err(mutationError('invalid-request'));
};

const applyExpectedEdits = (
  before: NormalizedManifestV1,
  edits: readonly ManifestEdit[],
  inherited: Readonly<{
    tools: ReadonlySet<string>;
    scope: ReadonlySet<string>;
  }>,
): Result<
  Readonly<{ mutable: MutableManifest; normalized: NormalizedManifestV1 }>,
  ArtifactMutationError
> => {
  const expected = mutableManifest(before);
  const originalNames = new Set(expected.skills.map((entry) => entry.name));
  const addedNames = new Set<string>();
  const orderedEdits = [
    ...edits.filter(
      (edit) =>
        edit.kind === 'set-default' ||
        edit.kind === 'unset-default' ||
        edit.kind === 'set-registry-default' ||
        edit.kind === 'unset-registry-default',
    ),
    ...edits.filter(
      (edit) =>
        edit.kind === 'set-skill-field' ||
        edit.kind === 'unset-skill-field' ||
        edit.kind === 'remove-skill',
    ),
    ...edits.filter((edit) => edit.kind === 'add-skill'),
  ];
  for (const edit of orderedEdits) {
    switch (edit.kind) {
      case 'set-default':
        expected.defaults ??= {};
        if (edit.field === 'tools') {
          expected.defaults.tools = [...edit.value];
          for (const skill of expected.skills) {
            if (inherited.tools.has(skill.name)) skill.tools = [...edit.value];
          }
        } else if (edit.field === 'scope') {
          expected.defaults.scope = edit.value;
          for (const skill of expected.skills) {
            if (inherited.scope.has(skill.name)) skill.scope = edit.value;
          }
        } else expected.defaults.path = edit.value;
        break;
      case 'unset-default':
        if (expected.defaults !== undefined) {
          delete expected.defaults[edit.field];
          if (Object.keys(expected.defaults).length === 0) expected.defaults = undefined;
        }
        break;
      case 'set-registry-default':
        expected.registry = { default: edit.value };
        break;
      case 'unset-registry-default':
        expected.registry = undefined;
        break;
      case 'set-skill-field': {
        const skill = expected.skills.find((entry) => entry.name === edit.name);
        if (skill === undefined || !originalNames.has(edit.name))
          return err(mutationError('invalid-request'));
        if (edit.field === 'source') {
          const probe = readManifestSource(
            `version = 1\n[defaults]\ntools = ["codex"]\nscope = "project"\n[[skills]]\nname = "probe"\nsource = ${JSON.stringify(edit.value)}\n`,
          );
          if (!probe.ok) return err(mutationError('invalid-request'));
          const normalized = normalizeManifestDocument(probe.value);
          if (!normalized.ok || normalized.value.skills[0] === undefined)
            return err(mutationError('invalid-request'));
          skill.source = { ...normalized.value.skills[0].source };
        } else if (edit.field === 'tools') skill.tools = [...edit.value];
        else if (edit.field === 'ref') skill.ref = edit.value;
        else if (edit.field === 'scope') skill.scope = edit.value;
        else if (edit.field === 'placement') skill.placement = edit.value;
        else skill.path = edit.value;
        break;
      }
      case 'unset-skill-field': {
        const skill = expected.skills.find((entry) => entry.name === edit.name);
        if (skill === undefined || !originalNames.has(edit.name))
          return err(mutationError('invalid-request'));
        if (edit.field === 'ref' || edit.field === 'path') skill[edit.field] = null;
        else if (edit.field === 'placement') skill.placement = 'symlink';
        else if (edit.field === 'tools') {
          if (expected.defaults?.tools === undefined) return err(mutationError('invalid-request'));
          skill.tools = [...expected.defaults.tools];
        } else {
          if (expected.defaults?.scope === undefined) return err(mutationError('invalid-request'));
          skill.scope = expected.defaults.scope;
        }
        break;
      }
      case 'add-skill':
        if (originalNames.has(edit.declaration.name) || addedNames.has(edit.declaration.name)) {
          return err(mutationError('invalid-request'));
        }
        addedNames.add(edit.declaration.name);
        expected.skills.push({
          name: edit.declaration.name,
          source: { ...edit.declaration.source },
          ref: edit.declaration.ref,
          tools: [...edit.declaration.tools],
          scope: edit.declaration.scope,
          placement: edit.declaration.placement,
          path: edit.declaration.path,
        });
        break;
      case 'remove-skill': {
        const index = expected.skills.findIndex((entry) => entry.name === edit.name);
        if (index < 0 || !originalNames.has(edit.name))
          return err(mutationError('invalid-request'));
        expected.skills.splice(index, 1);
        break;
      }
    }
  }
  const normalized = validateExpected(expected);
  return normalized.ok
    ? ok(Object.freeze({ mutable: expected, normalized: normalized.value }))
    : normalized;
};

const samePath = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((entry, index) => entry === right[index]);

const assignmentsAt = (
  document: HumanTomlDocument,
  tablePath: readonly string[],
  key: string,
  arrayTableIndex: number | null = null,
): readonly HumanTomlAssignment[] =>
  document.assignments.filter(
    (entry) =>
      samePath(entry.tablePath, tablePath) &&
      entry.arrayTableIndex === arrayTableIndex &&
      entry.keyPath.length === 1 &&
      entry.keyPath[0] === key,
  );

const headersAt = (
  document: HumanTomlDocument,
  path: readonly string[],
  array: boolean,
): readonly HumanTomlHeader[] =>
  document.headers.filter((header) => header.array === array && samePath(header.path, path));

const targetAlias = (document: HumanTomlDocument, table: 'defaults' | 'registry'): boolean =>
  document.assignments.some(
    (entry) =>
      (entry.tablePath.length === 0 && entry.keyPath[0] === table && entry.keyPath.length > 1) ||
      (entry.tablePath.length === 0 &&
        entry.keyPath.length === 1 &&
        entry.keyPath[0] === table &&
        entry.value.trim().startsWith('{')),
  );

const localNewline = (
  document: HumanTomlDocument,
  start: number,
  end: number,
): '\n' | '\r\n' | null => {
  const forms = new Set(
    document.lines
      .filter((line) => line.start >= start && line.start < end && line.newline !== '')
      .map((line) => line.newline),
  );
  return forms.size === 1 ? ([...forms][0] as '\n' | '\r\n') : null;
};

const globalNewline = (document: HumanTomlDocument): '\n' | '\r\n' | null => {
  const forms = new Set(document.lines.map((line) => line.newline).filter((value) => value !== ''));
  return forms.size === 1 ? ([...forms][0] as '\n' | '\r\n') : null;
};

const targetField = (edit: ManifestEdit): string => {
  const target = targetOf(edit);
  if (target.kind === 'default') return `defaults.${target.field}`;
  if (target.kind === 'registry-default') return 'registry.default';
  if (target.kind === 'skill-field')
    return redactSensitiveString(`skills[${JSON.stringify(target.name)}].${target.field}`);
  if (target.kind === 'skill-declaration')
    return redactSensitiveString(`skills[${JSON.stringify(target.name)}]`);
  return 'manifest';
};

const requestedValue = (edit: ManifestEdit): unknown => {
  if ('value' in edit) return edit.value;
  if (edit.kind === 'add-skill') return edit.declaration;
  return undefined;
};

const manualPatch = (edit: ManifestEdit): string => {
  const field = targetField(edit);
  const raw = requestedValue(edit);
  const rendered = raw === undefined ? '<unset>' : JSON.stringify(raw);
  const sensitive = containsSensitiveMaterial(rendered);
  return redactSensitiveString(
    [
      '--- a/skillsmith.toml',
      '+++ b/skillsmith.toml',
      '@@ manual manifest edit @@',
      `-${field} = <current>`,
      `+${field} = ${sensitive ? '[REDACTED]' : rendered}`,
      ...(sensitive ? ['Fill the validated value locally before applying this patch.'] : []),
    ].join('\n'),
  );
};

const unsafe = (edit: ManifestEdit): Result<never, ArtifactMutationError> =>
  err(
    mutationError('unsafe-human-edit', {
      field: targetField(edit),
      manualPatch: manualPatch(edit),
    }),
  );

const assignmentValue = (assignment: HumanTomlAssignment, edit: ManifestEdit): string => {
  if (!('value' in edit)) return '';
  if (typeof edit.value !== 'string') {
    const quote = /^\s*\[\s*'/u.test(assignment.value) ? 'literal' : 'basic';
    return renderHumanTomlStringArray(edit.value, {
      quote,
      trailingComma: assignment.arrayTrailingComma,
    });
  }
  return renderHumanTomlString(edit.value, assignment.quote);
};

const missingValue = (edit: ManifestEdit): string => {
  if (!('value' in edit)) return '';
  return typeof edit.value !== 'string'
    ? renderHumanTomlStringArray(edit.value)
    : renderHumanTomlString(edit.value);
};

const skillHeaders = (document: HumanTomlDocument): readonly HumanTomlHeader[] =>
  headersAt(document, ['skills'], true);

const skillLocation = (
  document: HumanTomlDocument,
  before: NormalizedManifestV1,
  name: string,
): Readonly<{ header: HumanTomlHeader; arrayIndex: number }> | null => {
  const manifestIndex = before.skills.findIndex((entry) => entry.name === name);
  const header = skillHeaders(document)[manifestIndex];
  return manifestIndex < 0 || header === undefined
    ? null
    : { header, arrayIndex: document.headers.filter((item) => item.array).indexOf(header) };
};

const blockEnd = (document: HumanTomlDocument, header: HumanTomlHeader): number => {
  const later = document.headers.find((candidate) => candidate.start > header.start);
  if (later !== undefined) return later.leadingCommentStart ?? later.start;
  const assignments = document.assignments.filter(
    (entry) =>
      entry.arrayTableIndex === document.headers.filter((item) => item.array).indexOf(header),
  );
  const last = assignments.at(-1);
  if (last === undefined) return header.end;
  const trailing = document.source.slice(last.end);
  return /^\s*$/u.test(trailing) ? document.source.length : last.end;
};

const tableBoundary = (
  document: HumanTomlDocument,
  header: HumanTomlHeader,
): Readonly<{ insertAt: number; end: number }> => {
  const next = document.headers.find((candidate) => candidate.start > header.start);
  const end = next?.leadingCommentStart ?? next?.start ?? document.source.length;
  const assignments = document.assignments.filter(
    (entry) =>
      entry.arrayTableIndex === null &&
      samePath(entry.tablePath, header.path) &&
      entry.start >= header.end &&
      entry.start < end,
  );
  return { insertAt: assignments.at(-1)?.end ?? header.end, end };
};

const insertedLine = (
  document: HumanTomlDocument,
  at: number,
  line: string,
  newline: '\n' | '\r\n',
): string => {
  if (at !== document.source.length) return `${line}${newline}`;
  const hadFinalNewline = document.source.endsWith('\n');
  return `${hadFinalNewline ? '' : newline}${line}${hadFinalNewline ? newline : ''}`;
};

const canonicalFieldValue = (edit: ManifestSkillSetEdit): string =>
  typeof edit.value !== 'string'
    ? renderHumanTomlStringArray(edit.value)
    : renderHumanTomlString(edit.value);

const editCanonicalSource = (
  document: HumanTomlDocument,
  before: NormalizedManifestV1,
  expected: MutableManifest,
  edits: readonly ManifestEdit[],
): Result<string, ArtifactMutationError> => {
  const replacements: HumanTomlReplacement[] = [];
  const insertions = new Map<number, string[]>();
  const enqueue = (at: number, text: string): void => {
    const queued = insertions.get(at) ?? [];
    queued.push(text);
    insertions.set(at, queued);
  };

  for (const table of ['defaults', 'registry'] as const) {
    if (targetAlias(document, table)) {
      const triggering = edits.find((edit) =>
        table === 'defaults'
          ? edit.kind === 'set-default' || edit.kind === 'unset-default'
          : edit.kind === 'set-registry-default' || edit.kind === 'unset-registry-default',
      );
      if (triggering !== undefined) return unsafe(triggering);
    }
  }

  const rootEdits = edits.filter(
    (edit) =>
      edit.kind === 'set-default' ||
      edit.kind === 'unset-default' ||
      edit.kind === 'set-registry-default' ||
      edit.kind === 'unset-registry-default',
  );
  const missingDefaults: ManifestDefaultSetEdit[] = [];
  const missingRegistry: Extract<ManifestEdit, { kind: 'set-registry-default' }>[] = [];

  for (const edit of rootEdits) {
    const table =
      edit.kind === 'set-default' || edit.kind === 'unset-default' ? 'defaults' : 'registry';
    const key =
      edit.kind === 'set-default' || edit.kind === 'unset-default' ? edit.field : 'default';
    const headers = headersAt(document, [table], false);
    if (headers.length > 1) return unsafe(edit);
    const assignment = assignmentsAt(document, [table], key)[0];
    if (assignment?.multiline) return unsafe(edit);
    if (edit.kind === 'set-default' || edit.kind === 'set-registry-default') {
      if (assignment !== undefined) {
        replacements.push({
          start: assignment.valueRange.start,
          end: assignment.valueRange.end,
          text: assignmentValue(assignment, edit),
        });
      } else if (headers.length === 0) {
        if (edit.kind === 'set-default') missingDefaults.push(edit);
        else missingRegistry.push(edit);
      } else {
        const boundary = tableBoundary(document, headers[0] as HumanTomlHeader);
        const newline = localNewline(document, (headers[0] as HumanTomlHeader).start, boundary.end);
        if (newline === null) return unsafe(edit);
        enqueue(
          boundary.insertAt,
          insertedLine(document, boundary.insertAt, `${key} = ${missingValue(edit)}`, newline),
        );
      }
    } else if (assignment !== undefined) {
      if (assignment.inlineComment !== null || assignment.leadingCommentStart !== null)
        return unsafe(edit);
      replacements.push({ start: assignment.lineStart, end: assignment.lineEnd, text: '' });
    }
  }

  if (missingDefaults.length > 0 || missingRegistry.length > 0) {
    const newline = globalNewline(document);
    const version = assignmentsAt(document, [], 'version')[0];
    if (newline === null || version === undefined)
      return unsafe((missingDefaults[0] ?? missingRegistry[0]) as ManifestEdit);
    const firstHeader = document.headers[0];
    const triviaEnd =
      firstHeader?.leadingCommentStart ?? firstHeader?.start ?? document.source.length;
    if (
      document.lines.some(
        (line) => line.start >= version.end && line.start < triviaEnd && line.kind === 'comment',
      )
    ) {
      return unsafe((missingDefaults[0] ?? missingRegistry[0]) as ManifestEdit);
    }
    const sections: string[] = [];
    if (missingDefaults.length > 0) {
      sections.push(
        [
          '[defaults]',
          ...missingDefaults.map((edit) => `${edit.field} = ${missingValue(edit)}`),
        ].join(newline),
      );
    }
    if (missingRegistry.length > 0) {
      sections.push(
        `[registry]${newline}default = ${missingValue(missingRegistry[0] as ManifestEdit)}`,
      );
    }
    enqueue(version.end, `${newline}${sections.join(`${newline}${newline}`)}${newline}`);
  }

  for (const edit of edits) {
    if (edit.kind !== 'set-skill-field' && edit.kind !== 'unset-skill-field') continue;
    const location = skillLocation(document, before, edit.name);
    if (location === null) return err(mutationError('invalid-request'));
    const assignment = assignmentsAt(document, ['skills'], edit.field, location.arrayIndex)[0];
    if (assignment?.multiline) return unsafe(edit);
    if (edit.kind === 'set-skill-field') {
      if (assignment !== undefined) {
        replacements.push({
          start: assignment.valueRange.start,
          end: assignment.valueRange.end,
          text: assignmentValue(assignment, edit),
        });
      } else {
        const end = blockEnd(document, location.header);
        const newline = localNewline(document, location.header.start, end);
        if (newline === null) return unsafe(edit);
        const assignments = document.assignments.filter(
          (item) => item.arrayTableIndex === location.arrayIndex,
        );
        const insertAt = assignments.at(-1)?.end ?? location.header.end;
        enqueue(
          insertAt,
          insertedLine(document, insertAt, `${edit.field} = ${canonicalFieldValue(edit)}`, newline),
        );
      }
    } else if (assignment !== undefined) {
      if (assignment.inlineComment !== null || assignment.leadingCommentStart !== null)
        return unsafe(edit);
      replacements.push({ start: assignment.lineStart, end: assignment.lineEnd, text: '' });
    }
  }

  const additions = edits.filter(
    (edit): edit is Extract<ManifestEdit, { kind: 'add-skill' }> => edit.kind === 'add-skill',
  );
  let additionsConsumed = false;
  for (const edit of edits) {
    if (edit.kind !== 'remove-skill') continue;
    const location = skillLocation(document, before, edit.name);
    if (location === null) return err(mutationError('invalid-request'));
    const end = blockEnd(document, location.header);
    const internalComment = document.lines.some(
      (line) => line.kind === 'comment' && line.start >= location.header.end && line.start < end,
    );
    const blockComment = document.comments.some(
      (comment) => comment.start >= location.header.start && comment.start < end,
    );
    const inlineComment =
      location.header.inlineComment !== null ||
      document.assignments.some(
        (assignment) =>
          assignment.start >= location.header.start &&
          assignment.start < end &&
          assignment.inlineComment !== null,
      );
    if (internalComment || blockComment || inlineComment) return unsafe(edit);
    let text = '';
    if (end === document.source.length && additions.length > 0) {
      const newline = globalNewline(document);
      if (newline === null) return unsafe(edit);
      text = `${additions.map((addition) => serializeDeclaration(addition.declaration, expected.defaults, newline)).join(`${newline}${newline}`)}${document.source.endsWith(newline) ? newline : ''}`;
      additionsConsumed = true;
    }
    replacements.push({
      start: location.header.leadingCommentStart ?? location.header.start,
      end,
      text,
    });
  }

  if (additions.length > 0 && !additionsConsumed) {
    const newline = globalNewline(document);
    if (newline === null) return unsafe(additions[0] as ManifestEdit);
    const declarations = additions.map((edit) =>
      serializeDeclaration(edit.declaration, expected.defaults, newline),
    );
    const suffix = document.source.endsWith(newline)
      ? `${newline}${declarations.join(`${newline}${newline}`)}${newline}`
      : `${newline}${newline}${declarations.join(`${newline}${newline}`)}`;
    enqueue(document.source.length, suffix);
  }

  for (const [at, texts] of insertions)
    replacements.push({ start: at, end: at, text: texts.join('') });
  const result = applyHumanTomlReplacements(document.source, replacements);
  return result.ok ? ok(result.value) : err(mutationError('unsafe-human-edit'));
};

const normalizeSource = (source: string): Result<NormalizedManifestV1, ArtifactMutationError> => {
  const read = readManifestSource(source);
  if (!read.ok) return err(mutationError('invalid-manifest'));
  const normalized = normalizeManifestDocument(read.value);
  return normalized.ok ? ok(normalized.value) : err(mutationError('invalid-manifest'));
};

const frozenResult = (
  source: string,
  changed: boolean,
  migrated: boolean,
  beforeSemanticHash: ArtifactDigest,
  afterSemanticHash: ArtifactDigest,
  targets: readonly ManifestEditTarget[],
): ManifestEditResult =>
  Object.freeze({
    bytes: new TextEncoder().encode(source),
    source,
    changed,
    migrated,
    beforeSemanticHash,
    afterSemanticHash,
    touchedTargets: Object.freeze(targets.map((target) => Object.freeze({ ...target }))),
  });

export const editManifestBytes = (
  bytes: Uint8Array,
  request: ManifestEditRequest,
): Result<ManifestEditResult, ArtifactMutationError> => {
  const validated = validateRequest(request);
  if (!validated.ok) return validated;
  const scanned = scanHumanToml(bytes);
  if (!scanned.ok) {
    return err(mutationError(scanned.error.reason));
  }
  const document = scanned.value;
  const read = readManifestSource(document.source);
  if (!read.ok) return err(mutationError('invalid-manifest'));
  const beforeResult = normalizeManifestDocument(read.value);
  if (!beforeResult.ok) return err(mutationError('invalid-manifest'));
  const before = beforeResult.value;
  if (
    document.comments.some((range) =>
      containsSensitiveMaterial(document.source.slice(range.start, range.end)),
    )
  ) {
    return unsafe(validated.value.edits[0] as ManifestEdit);
  }
  const migrating = validated.value.edits[0]?.kind === 'migrate-legacy';
  if (read.value.shape === 'legacy' && !migrating) return err(mutationError('invalid-request'));

  const inherited = { tools: new Set<string>(), scope: new Set<string>() };
  for (const skill of before.skills) {
    const location = skillLocation(document, before, skill.name);
    if (location === null) continue;
    if (assignmentsAt(document, ['skills'], 'tools', location.arrayIndex).length === 0)
      inherited.tools.add(skill.name);
    if (assignmentsAt(document, ['skills'], 'scope', location.arrayIndex).length === 0)
      inherited.scope.add(skill.name);
  }
  const expectedResult = applyExpectedEdits(before, validated.value.edits, inherited);
  if (!expectedResult.ok) return expectedResult;
  const expected = expectedResult.value;
  const beforeHash = hashManifestSemantics(before);
  const expectedHash = hashManifestSemantics(expected.normalized);
  if (beforeHash === expectedHash && !migrating) {
    return ok(
      frozenResult(document.source, false, false, beforeHash, beforeHash, validated.value.targets),
    );
  }

  let candidate: string;
  if (read.value.shape === 'legacy') {
    candidate = serializeCanonicalManifest(expected.mutable, globalNewline(document) ?? '\n');
  } else {
    const edited = editCanonicalSource(document, before, expected.mutable, validated.value.edits);
    if (!edited.ok) return edited;
    candidate = edited.value;
  }
  const firstMaterialEdit = validated.value.edits.find((edit) => edit.kind !== 'migrate-legacy');
  if (candidate !== document.source && containsSensitiveMaterial(candidate)) {
    return unsafe(firstMaterialEdit ?? (validated.value.edits[0] as ManifestEdit));
  }
  const afterResult = normalizeSource(candidate);
  if (!afterResult.ok) return afterResult;
  const afterHash = hashManifestSemantics(afterResult.value);
  if (
    afterHash !== expectedHash ||
    JSON.stringify(projectManifestSemantics(afterResult.value)) !==
      JSON.stringify(projectManifestSemantics(expected.normalized))
  ) {
    return err(mutationError('unsafe-human-edit'));
  }
  return ok(
    frozenResult(
      candidate,
      candidate !== document.source,
      read.value.shape === 'legacy',
      beforeHash,
      afterHash,
      validated.value.targets,
    ),
  );
};
