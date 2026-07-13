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
  const key = decodeKey(line.body.slice(0, equals));
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

const quotedLike = (current: string, value: string): string => {
  const trimmed = current.trim();
  const quote = trimmed.startsWith("'") ? "'" : '"';
  const escaped =
    quote === '"'
      ? value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
      : value.replaceAll("'", "''");
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
  const firstQuote = inner.match(/["']/)?.[0] === "'" ? "'" : '"';
  const rendered = values
    .map((value) =>
      firstQuote === "'" ? `'${value.replaceAll("'", "''")}'` : JSON.stringify(value),
    )
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
): Result<string, SkillSmithError> => {
  const unsafe = unsafeEditorShape(source, section, key);
  if (unsafe) return err(unsafe);
  const existing = entriesFor(source, section, key)[0];
  if (value === null) {
    return existing
      ? ok(replaceRange(source, existing.line.start, existing.line.end, ''))
      : ok(source);
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

const migrateLegacy = (source: string, config: Config, input: HumanConfigEditInput): string => {
  const newline = newlineOf(source);
  const hadFinalNewline = source.endsWith('\n');
  const firstEntry = linesOf(source)
    .map(entryOf)
    .find((entry) => entry !== null);
  const leading = firstEntry ? source.slice(0, firstEntry.line.start) : '';
  const next = applySemanticEdit(config, input);
  const rendered: string[] = ['version = 1'];
  const tools = getConfigTools(next);
  if (tools || next.scope !== undefined || next.path !== undefined) {
    rendered.push('', '[defaults]');
    if (tools) rendered.push(`tools = [${tools.map((tool) => JSON.stringify(tool)).join(', ')}]`);
    if (next.scope !== undefined) rendered.push(`scope = ${JSON.stringify(next.scope)}`);
    if (next.path !== undefined) rendered.push(`path = ${JSON.stringify(next.path)}`);
  }
  const registry = normalizeLegacyRegistry(next.registry?.default);
  if (registry !== undefined)
    rendered.push('', '[registry]', `default = ${JSON.stringify(registry)}`);
  const prefix = leading.replace(/(?:\r?\n)+$/g, newline);
  return `${prefix}${rendered.join(newline)}${hadFinalNewline ? newline : ''}`;
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

export const editConfigSource = (
  source: string,
  input: HumanConfigEditInput,
): Result<HumanConfigEditResult, SkillSmithError> => {
  const invalid = validatePatch(input);
  if (invalid) return err(invalid);
  const project = input.scope === 'project';
  let config: Config;
  if (project) {
    const parsed = parseProjectConfig(source);
    if (!parsed.ok) return parsed;
    if (parsed.value.shape === 'legacy') {
      return ok({
        source: migrateLegacy(source, parsed.value.config, input),
        changed: true,
        migrated: true,
        operation: 'migrate-project-config',
      });
    }
    config = parsed.value.config;
  } else {
    const parsed = parseConfig(source);
    if (!parsed.ok) return parsed;
    config = parsed.value;
  }
  let edited = source;
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
    const result = editOne(edited, location.section, location.key, value, location.kind);
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
    const result = editOne(edited, location.section, location.key, null, location.kind);
    if (!result.ok) return result;
    edited = result.value;
  }

  // A semantic no-op is always byte-identical, even when the source uses unusual trivia.
  const semantic = applySemanticEdit(config, input);
  const same = JSON.stringify(semantic) === JSON.stringify(config);
  return ok({
    source: same ? source : edited,
    changed: !same && edited !== source,
    migrated: false,
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
    const source = migrateLegacy('', {}, input);
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
  return ok({ source, changed: source.length > 0, migrated: false });
};
