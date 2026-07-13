import { type SkillSmithError, invalidArgumentError } from '../errors.ts';
import { type Result, err, ok } from '../result.ts';
import { CONFIG_ACCESSORS, getConfigTools } from './accessors.ts';
import { parseConfig, parseProjectConfig } from './schema.ts';
import type { Config, ConfigKey, Scope } from './types.ts';

export interface HumanConfigEditInput {
  readonly scope: Scope;
  readonly patch?: Partial<Config>;
  readonly delete?: readonly ConfigKey[];
}

export interface HumanConfigEditResult {
  readonly source: string;
  readonly changed: boolean;
  readonly migrated: boolean;
  readonly operation?: 'migrate-project-config';
}

interface SourceLine {
  readonly start: number;
  readonly bodyEnd: number;
  readonly end: number;
  readonly body: string;
  readonly newline: string;
  readonly section: string | null;
}

interface EntryRange {
  readonly line: SourceLine;
  readonly key: string;
  readonly rawKey: string;
  readonly keyStart: number;
  readonly keyEnd: number;
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly value: string;
}

const newlineOf = (source: string): '\r\n' | '\n' => (source.includes('\r\n') ? '\r\n' : '\n');

const linesOf = (source: string): readonly SourceLine[] => {
  const lines: SourceLine[] = [];
  let offset = 0;
  let section: string | null = null;
  while (offset < source.length) {
    const lineFeed = source.indexOf('\n', offset);
    const end = lineFeed < 0 ? source.length : lineFeed + 1;
    const bodyEnd =
      lineFeed < 0
        ? source.length
        : lineFeed > offset && source[lineFeed - 1] === '\r'
          ? lineFeed - 1
          : lineFeed;
    const body = source.slice(offset, bodyEnd);
    const header = body.trim().match(/^\[([^\[\]]+)](?:\s*#.*)?$/);
    const arrayHeader = body.trim().match(/^\[\[([^\[\]]+)]](?:\s*#.*)?$/);
    if (header) section = header[1]?.trim() ?? null;
    else if (arrayHeader) section = `[[${arrayHeader[1]?.trim() ?? ''}]]`;
    lines.push({
      start: offset,
      bodyEnd,
      end,
      body,
      newline: source.slice(bodyEnd, end),
      section,
    });
    offset = end;
  }
  return lines;
};

const outsideComment = (body: string, start: number): number => {
  let single = false;
  let double = false;
  let escaped = false;
  let square = 0;
  let curly = 0;
  for (let index = start; index < body.length; index++) {
    const character = body[index];
    if (double && escaped) {
      escaped = false;
      continue;
    }
    if (double && character === '\\') {
      escaped = true;
      continue;
    }
    if (!double && character === "'") single = !single;
    else if (!single && character === '"') double = !double;
    else if (!single && !double) {
      if (character === '[') square += 1;
      if (character === ']') square -= 1;
      if (character === '{') curly += 1;
      if (character === '}') curly -= 1;
      if (character === '#' && square === 0 && curly === 0) return index;
    }
  }
  return body.length;
};

const equalsOutsideQuotes = (body: string): number => {
  let single = false;
  let double = false;
  let escaped = false;
  for (let index = 0; index < body.length; index++) {
    const character = body[index];
    if (double && escaped) {
      escaped = false;
      continue;
    }
    if (double && character === '\\') {
      escaped = true;
      continue;
    }
    if (!double && character === "'") single = !single;
    else if (!single && character === '"') double = !double;
    else if (!single && !double && character === '=') return index;
  }
  return -1;
};

const decodeKey = (raw: string): string => {
  const key = raw.trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    return key.slice(1, -1);
  }
  return key;
};

const entryOf = (line: SourceLine): EntryRange | null => {
  const trimmed = line.body.trim();
  if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('[')) return null;
  const equals = equalsOutsideQuotes(line.body);
  if (equals < 0) return null;
  const rawKeyPart = line.body.slice(0, equals);
  const rawKey = rawKeyPart.trim();
  const keyOffset = rawKeyPart.indexOf(rawKey);
  const key = decodeKey(rawKey);
  let valueStartInLine = equals + 1;
  while (/\s/.test(line.body[valueStartInLine] ?? '')) valueStartInLine += 1;
  const comment = outsideComment(line.body, valueStartInLine);
  let valueEndInLine = comment;
  while (valueEndInLine > valueStartInLine && /\s/.test(line.body[valueEndInLine - 1] ?? '')) {
    valueEndInLine -= 1;
  }
  return {
    line,
    key,
    rawKey,
    keyStart: line.start + keyOffset,
    keyEnd: line.start + keyOffset + rawKey.length,
    valueStart: line.start + valueStartInLine,
    valueEnd: line.start + valueEndInLine,
    value: line.body.slice(valueStartInLine, valueEndInLine),
  };
};

const entriesFor = (source: string, section: string | null, key: string): readonly EntryRange[] =>
  linesOf(source)
    .filter((line) => line.section === section)
    .map(entryOf)
    .filter((entry): entry is EntryRange => entry !== null && entry.key === key);

const unsafeEditorShape = (
  source: string,
  section: string | null,
  key: string,
): SkillSmithError | null => {
  const lines = linesOf(source);
  const sectionHeaders = lines.filter((line) => {
    const header = line.body.trim().match(/^\[([^\[\]]+)]/);
    return header?.[1]?.trim() === section;
  });
  if (section !== null && sectionHeaders.length > 1) {
    return invalidArgumentError(`cannot safely edit reopened [${section}] table`);
  }
  const dotted = lines
    .filter((line) => line.section === null)
    .map(entryOf)
    .some((entry) => entry?.key === `${section}.${key}`);
  if (dotted) return invalidArgumentError(`cannot safely edit dotted alias ${section}.${key}`);
  const entries = entriesFor(source, section, key);
  if (entries.length > 1) return invalidArgumentError(`cannot safely edit duplicate ${key}`);
  const entry = entries[0];
  if (
    entry &&
    (/^(?:'''|""")/.test(entry.value) ||
      (!entry.value.endsWith(']') && entry.value.startsWith('[')))
  ) {
    return invalidArgumentError(`cannot safely edit multiline ${key}`);
  }
  return null;
};

const replaceRange = (source: string, start: number, end: number, value: string): string =>
  `${source.slice(0, start)}${value}${source.slice(end)}`;

type ManualValue = string | readonly string[];

const sensitiveManualValue = (value: string): boolean => {
  try {
    const url = new URL(value);
    if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
      return true;
    }
  } catch {
    // Non-URL values still receive the explicit credential-marker checks below.
  }
  return (
    /:\/\/[^/\s:@]+(?::[^/@\s]+)?@/.test(value) ||
    /(?:^|[?&#;\s])(?:api[_-]?key|auth(?:orization)?|credential|password|secret|token)\s*[=:]/i.test(
      value,
    )
  );
};

const renderManualValue = (
  value: ManualValue,
  kind: 'string' | 'array',
): { readonly rendered: string; readonly redacted: boolean } => {
  const values = typeof value === 'string' ? [value] : value;
  const redacted = values.some(sensitiveManualValue);
  if (redacted) return { rendered: '"<REDACTED>"', redacted: true };
  return {
    rendered:
      kind === 'array'
        ? `[${values.map((item) => JSON.stringify(item)).join(', ')}]`
        : JSON.stringify(values[0] ?? ''),
    redacted: false,
  };
};

const manualPatch = (
  section: string | null,
  key: string,
  operation: 'set' | 'unset',
  value: ManualValue,
  kind: 'string' | 'array',
  previous?: ManualValue,
): string => {
  const desired = renderManualValue(value, kind);
  const before = previous === undefined ? undefined : renderManualValue(previous, kind);
  const redacted = desired.redacted || before?.redacted === true;
  const lines = [
    'manual patch:',
    section === null ? 'target: top level' : `target table: [${section}]`,
    '--- a/config.toml',
    '+++ b/config.toml',
    '@@ -1 +1 @@',
  ];
  if (operation === 'unset') {
    lines.push(`-${key} = ${desired.rendered}`, '+');
  } else {
    lines.push(before === undefined ? '-' : `-${key} = ${before.rendered}`);
    lines.push(`+${key} = ${desired.rendered}`);
  }
  if (redacted) {
    lines.push(
      'replace "<REDACTED>" locally with the requested validated value before applying this patch',
    );
  }
  return lines.join('\n');
};

const ambiguousBoundaryComment = (source: string, section: string | null): boolean => {
  const lines = linesOf(source);
  const trailingTriviaHasComment = (before: number): boolean => {
    let index = before - 1;
    let sawComment = false;
    while (index >= 0) {
      const body = lines[index]?.body.trim() ?? '';
      if (body === '') {
        index -= 1;
        continue;
      }
      if (body.startsWith('#')) {
        sawComment = true;
        index -= 1;
        continue;
      }
      break;
    }
    return sawComment;
  };
  const nextHeaderIndex =
    section === null
      ? lines.findIndex((line) => /^\s*\[/.test(line.body))
      : (() => {
          const headerIndex = lines.findIndex(
            (line) =>
              line.body
                .trim()
                .match(/^\[([^\[\]]+)]/)?.[1]
                ?.trim() === section,
          );
          if (headerIndex < 0) return -2;
          const relative = lines
            .slice(headerIndex + 1)
            .findIndex((line) => /^\s*\[/.test(line.body));
          return relative < 0 ? -1 : headerIndex + 1 + relative;
        })();
  if (nextHeaderIndex === -2) return trailingTriviaHasComment(lines.length);
  if (nextHeaderIndex < 0) return trailingTriviaHasComment(lines.length);
  return trailingTriviaHasComment(nextHeaderIndex);
};

const quotedLike = (current: string, value: string): string => {
  const trimmed = current.trim();
  const quote = trimmed.startsWith("'") && !value.includes("'") ? "'" : '"';
  const escaped = quote === '"' ? value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') : value;
  return `${quote}${escaped}${quote}`;
};

const arrayLike = (current: string, values: readonly string[]): string => {
  const open = current.indexOf('[');
  const close = current.lastIndexOf(']');
  if (open < 0 || close < open)
    return `[${values.map((value) => JSON.stringify(value)).join(', ')}]`;
  const inner = current.slice(open + 1, close);
  const leading = inner.match(/^\s*/)?.[0] ?? '';
  const trailing = inner.match(/\s*$/)?.[0] ?? '';
  const trailingComma = /,\s*$/.test(inner);
  const prefersLiteral = inner.match(/["']/)?.[0] === "'";
  const rendered = values
    .map((value) => (prefersLiteral && !value.includes("'") ? `'${value}'` : JSON.stringify(value)))
    .join(', ');
  return `[${leading}${rendered}${trailingComma ? ',' : ''}${trailing}]`;
};

const insertAtSectionEnd = (
  source: string,
  section: string,
  key: string,
  value: string,
): string => {
  const newline = newlineOf(source);
  const lines = linesOf(source);
  const headerIndex = lines.findIndex(
    (line) =>
      line.body
        .trim()
        .match(/^\[([^\[\]]+)]/)?.[1]
        ?.trim() === section,
  );
  const hadFinalNewline = source.endsWith('\n');
  if (headerIndex >= 0) {
    const nextHeader = lines.slice(headerIndex + 1).find((line) => /^\s*\[/.test(line.body));
    const offset = nextHeader?.start ?? source.length;
    const prefix = offset > 0 && source[offset - 1] !== '\n' ? newline : '';
    return replaceRange(
      source,
      offset,
      offset,
      `${prefix}${key} = ${value}${nextHeader || hadFinalNewline ? newline : ''}`,
    );
  }
  const base = hadFinalNewline ? source.slice(0, -newline.length) : source;
  const separator = base.length === 0 ? '' : `${newline}${newline}`;
  return `${base}${separator}[${section}]${newline}${key} = ${value}${hadFinalNewline ? newline : ''}`;
};

const insertTopLevel = (source: string, key: string, value: string): string => {
  const newline = newlineOf(source);
  const lines = linesOf(source);
  const firstHeader = lines.find((line) => /^\s*\[/.test(line.body));
  const offset = firstHeader?.start ?? source.length;
  const hadFinalNewline = source.endsWith('\n');
  const prefix = offset > 0 && source[offset - 1] !== '\n' ? newline : '';
  return replaceRange(
    source,
    offset,
    offset,
    `${prefix}${key} = ${value}${firstHeader || hadFinalNewline ? newline : ''}`,
  );
};

const editOne = (
  source: string,
  section: string | null,
  key: string,
  value: string | null,
  kind: 'string' | 'array',
  semanticValue: ManualValue | undefined,
): Result<string, SkillSmithError> => {
  const existing = entriesFor(source, section, key)[0];
  if (value === null && !existing) return ok(source);
  const unsafe = unsafeEditorShape(source, section, key);
  if (unsafe) {
    const reason = 'message' in unsafe ? unsafe.message : 'cannot safely edit source';
    return err(
      invalidArgumentError(
        `${reason}\n${manualPatch(
          section,
          key,
          value === null ? 'unset' : 'set',
          value === null ? (semanticValue ?? '') : value,
          kind,
          value === null ? undefined : semanticValue,
        )}`,
      ),
    );
  }
  if (value === null) {
    if (!existing) return ok(source);
    return ok(replaceRange(source, existing.keyStart, existing.valueEnd, ''));
  }
  if (existing) {
    const rendered =
      kind === 'array' ? arrayLike(existing.value, [value]) : quotedLike(existing.value, value);
    return ok(
      rendered === existing.value
        ? source
        : replaceRange(source, existing.valueStart, existing.valueEnd, rendered),
    );
  }
  if (ambiguousBoundaryComment(source, section)) {
    return err(
      invalidArgumentError(
        `cannot safely attach ${section === null ? key : `${section}.${key}`} across a comment/table boundary\n${manualPatch(section, key, 'set', value, kind, semanticValue)}`,
      ),
    );
  }
  const rendered = kind === 'array' ? `[${JSON.stringify(value)}]` : JSON.stringify(value);
  return ok(
    section === null
      ? insertTopLevel(source, key, rendered)
      : insertAtSectionEnd(source, section, key, rendered),
  );
};

const normalizeLegacyRegistry = (value: string | undefined): string | undefined => {
  if (value === undefined || !/^https:\/\//i.test(value)) return value;
  const parsed = new URL(value);
  return `${parsed.host}${parsed.pathname.replace(/^\/+|\/+$/g, '') ? `/${parsed.pathname.replace(/^\/+|\/+$/g, '')}` : ''}`;
};

interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

const applyReplacements = (source: string, replacements: readonly Replacement[]): string =>
  [...replacements]
    .sort((left, right) => right.start - left.start || right.end - left.end)
    .reduce(
      (current, replacement) =>
        replaceRange(current, replacement.start, replacement.end, replacement.value),
      source,
    );

const renamedKey = (rawKey: string, key: string): string =>
  rawKey.startsWith("'") ? `'${key}'` : rawKey.startsWith('"') ? `"${key}"` : key;

const canonicalizeLegacyRanges = (
  source: string,
  config: Config,
): Result<string, SkillSmithError> => {
  const newline = newlineOf(source);
  const lines = linesOf(source);
  const topEntries = lines
    .filter((line) => line.section === null)
    .map(entryOf)
    .filter(
      (entry): entry is EntryRange =>
        entry !== null && ['tool', 'scope', 'path'].includes(entry.key),
    );
  const replacements: Replacement[] = [];
  const firstTop = topEntries[0];
  if (firstTop) {
    replacements.push({
      start: firstTop.line.start,
      end: firstTop.line.start,
      value: `version = 1${newline}${newline}[defaults]${newline}`,
    });
    const tool = topEntries.find((entry) => entry.key === 'tool');
    if (tool) {
      replacements.push({
        start: tool.keyStart,
        end: tool.keyEnd,
        value: renamedKey(tool.rawKey, 'tools'),
      });
      replacements.push({
        start: tool.valueStart,
        end: tool.valueEnd,
        value: `[${tool.value}]`,
      });
    }
  } else {
    const firstStructural = lines.find(
      (line) => line.body.trim() !== '' && !line.body.trim().startsWith('#'),
    );
    const offset = firstStructural?.start ?? source.length;
    const prefix = offset > 0 && source[offset - 1] !== '\n' ? newline : '';
    replacements.push({
      start: offset,
      end: offset,
      value: `${prefix}version = 1${newline}${firstStructural ? newline : ''}`,
    });
  }

  const legacyRegistry = entriesFor(source, 'registry', 'default')[0];
  const normalizedRegistry = normalizeLegacyRegistry(config.registry?.default);
  if (legacyRegistry && normalizedRegistry !== undefined) {
    const rendered = quotedLike(legacyRegistry.value, normalizedRegistry);
    if (rendered !== legacyRegistry.value) {
      replacements.push({
        start: legacyRegistry.valueStart,
        end: legacyRegistry.valueEnd,
        value: rendered,
      });
    }
  }

  const canonical = applyReplacements(source, replacements);
  const parsed = parseProjectConfig(canonical);
  return parsed.ok
    ? ok(canonical)
    : err(
        invalidArgumentError(
          `cannot safely migrate the exact legacy source\n${manualPatch(
            'defaults',
            'tools',
            'set',
            getConfigTools(config) ?? [],
            'array',
            getConfigTools(config),
          )}`,
        ),
      );
};

const applySemanticEdit = (config: Config, input: HumanConfigEditInput): Config => {
  const next: Config = {
    ...(config.tool === undefined ? {} : { tool: config.tool }),
    ...(config.tools === undefined ? {} : { tools: [...config.tools] }),
    ...(config.scope === undefined ? {} : { scope: config.scope }),
    ...(config.path === undefined ? {} : { path: config.path }),
    ...(config.registry?.default === undefined
      ? {}
      : { registry: { default: config.registry.default } }),
  };
  if (input.patch?.tool !== undefined) {
    next.tool = input.patch.tool;
    Reflect.deleteProperty(next, 'tools');
  }
  if (input.patch?.scope !== undefined) next.scope = input.patch.scope;
  if (input.patch?.path !== undefined) next.path = input.patch.path;
  if (input.patch?.registry?.default !== undefined) {
    next.registry = { default: input.patch.registry.default };
  }
  for (const key of input.delete ?? []) CONFIG_ACCESSORS[key].del(next);
  return next;
};

const validatePatch = (input: HumanConfigEditInput): SkillSmithError | null => {
  const registry = input.patch?.registry?.default;
  if (
    registry !== undefined &&
    (!/^[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._-]+)*$/.test(registry) || /[%?#@]/.test(registry))
  ) {
    return invalidArgumentError(
      'registry.default must be a credential-free host/namespace identity',
    );
  }
  const path = input.patch?.path;
  if (
    input.scope === 'project' &&
    path !== undefined &&
    (!path.startsWith('./') || path.split('/').includes('..'))
  ) {
    return invalidArgumentError('project path must be portable and project-relative');
  }
  return null;
};

const semanticProjection = (config: Config): string =>
  JSON.stringify({
    tools: getConfigTools(config) ?? null,
    scope: config.scope ?? null,
    path: config.path ?? null,
    registry: config.registry?.default ?? null,
  });

const verifyEditedSemantics = (
  source: string,
  project: boolean,
  expected: Config,
): Result<void, SkillSmithError> => {
  let actual: Config;
  if (project) {
    const parsed = parseProjectConfig(source);
    if (!parsed.ok) return err(invalidArgumentError('edited config failed semantic validation'));
    actual = parsed.value.config;
  } else {
    const parsed = parseConfig(source);
    if (!parsed.ok) return err(invalidArgumentError('edited config failed semantic validation'));
    actual = parsed.value;
  }
  return semanticProjection(actual) === semanticProjection(expected)
    ? ok(undefined)
    : err(invalidArgumentError('edited config did not preserve the requested semantics'));
};

const renderNewProjectConfig = (input: HumanConfigEditInput): string => {
  const config = applySemanticEdit({}, input);
  const rendered: string[] = ['version = 1'];
  const tools = getConfigTools(config);
  if (tools || config.scope !== undefined || config.path !== undefined) {
    rendered.push('', '[defaults]');
    if (tools) rendered.push(`tools = [${tools.map((tool) => JSON.stringify(tool)).join(', ')}]`);
    if (config.scope !== undefined) rendered.push(`scope = ${JSON.stringify(config.scope)}`);
    if (config.path !== undefined) rendered.push(`path = ${JSON.stringify(config.path)}`);
  }
  if (config.registry?.default !== undefined) {
    rendered.push('', '[registry]', `default = ${JSON.stringify(config.registry.default)}`);
  }
  return rendered.join('\n');
};

const semanticManualValue = (
  config: Config,
  key: ConfigKey,
  project: boolean,
): ManualValue | undefined =>
  project && key === 'tool' ? getConfigTools(config) : CONFIG_ACCESSORS[key].get(config);

export const editConfigSource = (
  source: string,
  input: HumanConfigEditInput,
): Result<HumanConfigEditResult, SkillSmithError> => {
  const invalid = validatePatch(input);
  if (invalid) return err(invalid);
  const project = input.scope === 'project';
  let config: Config;
  let edited = source;
  let migrated = false;
  if (project) {
    const parsed = parseProjectConfig(source);
    if (!parsed.ok) return parsed;
    if (parsed.value.shape === 'legacy') {
      const canonical = canonicalizeLegacyRanges(source, parsed.value.config);
      if (!canonical.ok) return canonical;
      edited = canonical.value;
      migrated = true;
    }
    config = parsed.value.config;
  } else {
    const parsed = parseConfig(source);
    if (!parsed.ok) return parsed;
    config = parsed.value;
  }
  const patchEntries: readonly [ConfigKey, string | undefined][] = [
    ['tool', input.patch?.tool],
    ['scope', input.patch?.scope],
    ['path', input.patch?.path],
    ['registry.default', input.patch?.registry?.default],
  ];
  for (const [key, value] of patchEntries) {
    if (value === undefined) continue;
    const location = project
      ? key === 'registry.default'
        ? { section: 'registry', key: 'default', kind: 'string' as const }
        : key === 'tool'
          ? { section: 'defaults', key: 'tools', kind: 'array' as const }
          : { section: 'defaults', key, kind: 'string' as const }
      : key === 'registry.default'
        ? { section: 'registry', key: 'default', kind: 'string' as const }
        : { section: null, key, kind: 'string' as const };
    const result = editOne(
      edited,
      location.section,
      location.key,
      value,
      location.kind,
      semanticManualValue(config, key, project),
    );
    if (!result.ok) return result;
    edited = result.value;
  }
  for (const key of input.delete ?? []) {
    const location = project
      ? key === 'registry.default'
        ? { section: 'registry', key: 'default', kind: 'string' as const }
        : key === 'tool'
          ? { section: 'defaults', key: 'tools', kind: 'array' as const }
          : { section: 'defaults', key, kind: 'string' as const }
      : key === 'registry.default'
        ? { section: 'registry', key: 'default', kind: 'string' as const }
        : { section: null, key, kind: 'string' as const };
    const result = editOne(
      edited,
      location.section,
      location.key,
      null,
      location.kind,
      semanticManualValue(config, key, project),
    );
    if (!result.ok) return result;
    edited = result.value;
  }

  // A semantic no-op is always byte-identical, even when the source uses unusual trivia.
  const semantic = applySemanticEdit(config, input);
  const same = semanticProjection(semantic) === semanticProjection(config);
  if (migrated || !same) {
    const verified = verifyEditedSemantics(edited, project, semantic);
    if (!verified.ok) return verified;
  }
  return ok({
    source: !migrated && same ? source : edited,
    changed: migrated || (!same && edited !== source),
    migrated,
    ...(migrated ? { operation: 'migrate-project-config' } : {}),
  });
};

export const createConfigSource = (
  input: HumanConfigEditInput,
): Result<HumanConfigEditResult, SkillSmithError> => {
  if ((input.delete?.length ?? 0) > 0 && input.patch === undefined) {
    return ok({ source: '', changed: false, migrated: false });
  }
  const invalid = validatePatch(input);
  if (invalid) return err(invalid);
  if (input.scope === 'project') {
    const source = renderNewProjectConfig(input);
    const verified = verifyEditedSemantics(source, true, applySemanticEdit({}, input));
    if (!verified.ok) return verified;
    return ok({ source, changed: source.length > 0, migrated: false });
  }
  let source = '';
  for (const [key, value] of [
    ['tool', input.patch?.tool],
    ['scope', input.patch?.scope],
    ['path', input.patch?.path],
  ] as const) {
    if (value !== undefined) source = insertTopLevel(source, key, JSON.stringify(value));
  }
  if (input.patch?.registry?.default !== undefined) {
    source = insertAtSectionEnd(
      source,
      'registry',
      'default',
      JSON.stringify(input.patch.registry.default),
    );
  }
  if (source.length > 0) {
    const verified = verifyEditedSemantics(source, false, applySemanticEdit({}, input));
    if (!verified.ok) return verified;
  }
  return ok({ source, changed: source.length > 0, migrated: false });
};
