import { types as utilTypes } from 'node:util';
import { type Result, err, ok } from '../result.ts';

export type HumanTomlScanErrorReason = 'invalid-utf8' | 'unsafe-human-edit';

export interface HumanTomlScanError {
  readonly code: 'human-toml';
  readonly reason: HumanTomlScanErrorReason;
  readonly message: string;
}

export interface HumanTomlRange {
  readonly start: number;
  readonly end: number;
}

export interface HumanTomlLine extends HumanTomlRange {
  readonly bodyEnd: number;
  readonly newline: '' | '\n' | '\r\n';
  readonly kind: 'blank' | 'comment' | 'header' | 'assignment' | 'continuation' | 'other';
}

export interface HumanTomlHeader extends HumanTomlRange {
  readonly bodyEnd: number;
  readonly lineIndex: number;
  readonly array: boolean;
  readonly path: readonly string[];
  readonly dotted: boolean;
  readonly leadingCommentStart: number | null;
  readonly inlineComment: string | null;
}

export interface HumanTomlAssignment extends HumanTomlRange {
  readonly lineStart: number;
  readonly lineBodyEnd: number;
  readonly lineEnd: number;
  readonly lineIndex: number;
  readonly endLineIndex: number;
  readonly tablePath: readonly string[];
  readonly arrayTableIndex: number | null;
  readonly keyPath: readonly string[];
  readonly dotted: boolean;
  readonly rawKey: string;
  readonly keyRange: HumanTomlRange;
  readonly value: string;
  readonly valueRange: HumanTomlRange;
  readonly multiline: boolean;
  readonly inlineComment: string | null;
  readonly leadingCommentStart: number | null;
  readonly quote: 'basic' | 'literal' | null;
  readonly arrayTrailingComma: boolean;
}

export interface HumanTomlDocument {
  readonly bytes: Uint8Array;
  readonly source: string;
  readonly lines: readonly HumanTomlLine[];
  readonly headers: readonly HumanTomlHeader[];
  readonly assignments: readonly HumanTomlAssignment[];
  readonly comments: readonly HumanTomlRange[];
}

export interface HumanTomlReplacement {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const scanError = (reason: HumanTomlScanErrorReason, message: string): HumanTomlScanError =>
  Object.freeze({ code: 'human-toml', reason, message });

const frozenRange = (start: number, end: number): HumanTomlRange => Object.freeze({ start, end });

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get;
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;
const copyBytes = Uint8Array.prototype.set;

const ownBytes = (input: Uint8Array): Result<Uint8Array, HumanTomlScanError> => {
  try {
    if (
      utilTypes.isProxy(input) ||
      !utilTypes.isUint8Array(input) ||
      Object.getPrototypeOf(input) !== Uint8Array.prototype ||
      bufferGetter === undefined ||
      byteLengthGetter === undefined
    ) {
      return err(scanError('unsafe-human-edit', 'human TOML input must be owned bytes'));
    }
    const buffer = Reflect.apply(bufferGetter, input, []) as ArrayBufferLike;
    const byteLength = Reflect.apply(byteLengthGetter, input, []) as number;
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
      return err(scanError('unsafe-human-edit', 'human TOML input must be owned bytes'));
    }
    const owned = new Uint8Array(byteLength);
    Reflect.apply(copyBytes, owned, [input]);
    return ok(owned);
  } catch {
    return err(scanError('invalid-utf8', 'human TOML bytes are unavailable'));
  }
};

const physicalLines = (source: string): HumanTomlLine[] => {
  const lines: HumanTomlLine[] = [];
  let start = 0;
  while (start < source.length) {
    const lf = source.indexOf('\n', start);
    const end = lf < 0 ? source.length : lf + 1;
    const bodyEnd = lf < 0 ? end : lf > start && source[lf - 1] === '\r' ? lf - 1 : lf;
    const newline = source.slice(bodyEnd, end) as '' | '\n' | '\r\n';
    const trimmed = source.slice(start, bodyEnd).trim();
    lines.push({
      start,
      end,
      bodyEnd,
      newline,
      kind: trimmed.length === 0 ? 'blank' : trimmed.startsWith('#') ? 'comment' : 'other',
    });
    start = end;
  }
  return lines;
};

const leadingCommentStart = (lines: readonly HumanTomlLine[], lineIndex: number): number | null => {
  let index = lineIndex - 1;
  if (index < 0 || lines[index]?.kind !== 'comment') return null;
  while (index > 0 && lines[index - 1]?.kind === 'comment') index -= 1;
  return lines[index]?.start ?? null;
};

const basicEscape = (
  value: string,
  index: number,
): Readonly<{ value: string; next: number }> | null => {
  const escapeCode = value[index + 1];
  const simple: Readonly<Record<string, string>> = Object.freeze({
    b: '\b',
    t: '\t',
    n: '\n',
    f: '\f',
    r: '\r',
    '"': '"',
    '\\': '\\',
  });
  if (escapeCode !== undefined && Object.prototype.hasOwnProperty.call(simple, escapeCode)) {
    return { value: simple[escapeCode] as string, next: index + 2 };
  }
  if (escapeCode !== 'u' && escapeCode !== 'U') return null;
  const width = escapeCode === 'u' ? 4 : 8;
  const token = value.slice(index + 2, index + 2 + width);
  if (token.length !== width || !/^[0-9A-Fa-f]+$/u.test(token)) return null;
  const point = Number.parseInt(token, 16);
  if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return null;
  return { value: String.fromCodePoint(point), next: index + 2 + width };
};

const decodeKeySegment = (raw: string): string | null => {
  const token = raw.trim();
  if (/^[A-Za-z0-9_-]+$/u.test(token)) return token;
  if (token.length < 2) return null;
  if (token.startsWith("'") && token.endsWith("'")) return token.slice(1, -1);
  if (!token.startsWith('"') || !token.endsWith('"')) return null;
  let decoded = '';
  for (let index = 1; index < token.length - 1; ) {
    const character = token[index] as string;
    if (character !== '\\') {
      decoded += character;
      index += 1;
      continue;
    }
    const decodedEscape = basicEscape(token, index);
    if (decodedEscape === null || decodedEscape.next > token.length - 1) return null;
    decoded += decodedEscape.value;
    index = decodedEscape.next;
  }
  return decoded;
};

const parseKeyPath = (raw: string): readonly string[] | null => {
  const segments: string[] = [];
  let start = 0;
  let quote: 'basic' | 'literal' | null = null;
  let escaped = false;
  for (let index = 0; index <= raw.length; index += 1) {
    const character = raw[index];
    if (quote === 'basic') {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quote = null;
      continue;
    }
    if (quote === 'literal') {
      if (character === "'") quote = null;
      continue;
    }
    if (character === '"') quote = 'basic';
    else if (character === "'") quote = 'literal';
    else if (character === '.' || index === raw.length) {
      const decoded = decodeKeySegment(raw.slice(start, index));
      if (decoded === null) return null;
      segments.push(decoded);
      start = index + 1;
    }
  }
  return quote === null && segments.length > 0 ? Object.freeze(segments) : null;
};

const findHeaderComment = (body: string): number => {
  let quote: 'basic' | 'literal' | null = null;
  let escaped = false;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (quote === 'basic') {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quote = null;
    } else if (quote === 'literal') {
      if (character === "'") quote = null;
    } else if (character === '"') quote = 'basic';
    else if (character === "'") quote = 'literal';
    else if (character === '#') return index;
  }
  return body.length;
};

const quoteRun = (source: string, index: number, quote: '"' | "'"): number => {
  let end = index;
  while (source[end] === quote) end += 1;
  return end - index;
};

const headerOf = (
  source: string,
  lines: readonly HumanTomlLine[],
  lineIndex: number,
): HumanTomlHeader | null => {
  const line = lines[lineIndex];
  if (line === undefined) return null;
  const body = source.slice(line.start, line.bodyEnd);
  const comment = findHeaderComment(body);
  const content = body.slice(0, comment).trim();
  const array = content.startsWith('[[') && content.endsWith(']]');
  const standard = !array && content.startsWith('[') && content.endsWith(']');
  if (!array && !standard) return null;
  const inside = content.slice(array ? 2 : 1, array ? -2 : -1);
  const path = parseKeyPath(inside);
  if (path === null) return null;
  return Object.freeze({
    start: line.start,
    bodyEnd: line.bodyEnd,
    end: line.end,
    lineIndex,
    array,
    path,
    dotted: path.length > 1,
    leadingCommentStart: leadingCommentStart(lines, lineIndex),
    inlineComment: comment === body.length ? null : body.slice(comment),
  });
};

const commentRanges = (source: string): readonly HumanTomlRange[] => {
  const ranges: HumanTomlRange[] = [];
  let quote: 'basic' | 'literal' | 'multiline-basic' | 'multiline-literal' | null = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] as string;
    if (quote === 'basic') {
      if (character === '\n' || character === '\r') quote = null;
      else if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quote = null;
      continue;
    }
    if (quote === 'literal') {
      if (character === '\n' || character === '\r' || character === "'") quote = null;
      continue;
    }
    if (quote === 'multiline-basic') {
      const run = character === '"' ? quoteRun(source, index, '"') : 0;
      if (run >= 3 && run <= 5 && !escaped) {
        quote = null;
        index += run - 1;
      } else {
        escaped = !escaped && character === '\\';
        if (character !== '\\') escaped = false;
      }
      continue;
    }
    if (quote === 'multiline-literal') {
      const run = character === "'" ? quoteRun(source, index, "'") : 0;
      if (run >= 3 && run <= 5) {
        quote = null;
        index += run - 1;
      }
      continue;
    }
    if (source.startsWith('"""', index)) {
      quote = 'multiline-basic';
      index += 2;
    } else if (source.startsWith("'''", index)) {
      quote = 'multiline-literal';
      index += 2;
    } else if (character === '"') quote = 'basic';
    else if (character === "'") quote = 'literal';
    else if (character === '#') {
      const lf = source.indexOf('\n', index);
      const end = lf < 0 ? source.length : lf > index && source[lf - 1] === '\r' ? lf - 1 : lf;
      ranges.push(frozenRange(index, end));
      index = lf < 0 ? source.length : lf;
    }
  }
  return Object.freeze(ranges);
};

const assignmentEquals = (body: string): number => {
  let quote: 'basic' | 'literal' | null = null;
  let escaped = false;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (quote === 'basic') {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quote = null;
    } else if (quote === 'literal') {
      if (character === "'") quote = null;
    } else if (character === '"') quote = 'basic';
    else if (character === "'") quote = 'literal';
    else if (character === '=') return index;
    else if (character === '#') return -1;
  }
  return -1;
};

interface ValueScan {
  readonly end: number;
  readonly endLineIndex: number;
  readonly commentStart: number | null;
  readonly multiline: boolean;
}

const scanValue = (
  source: string,
  lines: readonly HumanTomlLine[],
  lineIndex: number,
  valueStart: number,
): ValueScan | null => {
  let quote: 'basic' | 'literal' | 'multiline-basic' | 'multiline-literal' | null = null;
  let escaped = false;
  let square = 0;
  let curly = 0;
  let commentStart: number | null = null;
  let multiline = false;
  let currentLine = lineIndex;
  let end = valueStart;

  for (let index = valueStart; index < source.length; index += 1) {
    while (currentLine < lines.length && index >= (lines[currentLine]?.end ?? source.length + 1)) {
      currentLine += 1;
    }
    const line = lines[currentLine];
    if (line === undefined) break;
    if (index === line.bodyEnd) {
      if (quote === 'multiline-basic' || quote === 'multiline-literal' || square > 0 || curly > 0) {
        multiline = true;
        end = line.end;
        index = line.end - 1;
        continue;
      }
      end = index;
      break;
    }
    const character = source[index] as string;
    if (quote === 'basic') {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quote = null;
      end = index + 1;
      continue;
    }
    if (quote === 'literal') {
      if (character === "'") quote = null;
      end = index + 1;
      continue;
    }
    if (quote === 'multiline-basic') {
      const run = character === '"' ? quoteRun(source, index, '"') : 0;
      if (run >= 3 && run <= 5 && !escaped) {
        quote = null;
        end = index + run;
        index += run - 1;
      } else {
        escaped = !escaped && character === '\\';
        if (character !== '\\') escaped = false;
        end = index + 1;
      }
      continue;
    }
    if (quote === 'multiline-literal') {
      const run = character === "'" ? quoteRun(source, index, "'") : 0;
      if (run >= 3 && run <= 5) {
        quote = null;
        end = index + run;
        index += run - 1;
      } else end = index + 1;
      continue;
    }
    if (source.startsWith('"""', index)) {
      quote = 'multiline-basic';
      multiline = true;
      end = index + 3;
      index += 2;
    } else if (source.startsWith("'''", index)) {
      quote = 'multiline-literal';
      multiline = true;
      end = index + 3;
      index += 2;
    } else if (character === '"') {
      quote = 'basic';
      end = index + 1;
    } else if (character === "'") {
      quote = 'literal';
      end = index + 1;
    } else if (character === '[') {
      square += 1;
      end = index + 1;
    } else if (character === ']') {
      square -= 1;
      end = index + 1;
    } else if (character === '{') {
      curly += 1;
      end = index + 1;
    } else if (character === '}') {
      curly -= 1;
      end = index + 1;
    } else if (character === '#') {
      if (square === 0 && curly === 0) {
        commentStart = index;
        end = index;
        break;
      }
      multiline = true;
      end = line.end;
      index = line.end - 1;
    } else {
      end = index + 1;
    }
  }
  if (quote !== null || square !== 0 || curly !== 0) return null;
  while (end > valueStart && /[ \t]/u.test(source[end - 1] ?? '')) end -= 1;
  return { end, endLineIndex: currentLine, commentStart, multiline };
};

export const scanHumanToml = (input: Uint8Array): Result<HumanTomlDocument, HumanTomlScanError> => {
  const copied = ownBytes(input);
  if (!copied.ok) return err(copied.error);
  const bytes = copied.value;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return err(scanError('invalid-utf8', 'human TOML must not contain a UTF-8 BOM'));
  }
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return err(scanError('invalid-utf8', 'human TOML is not valid UTF-8'));
  }
  if (source.startsWith('\ufeff')) {
    return err(scanError('invalid-utf8', 'human TOML must not contain a UTF-8 BOM'));
  }

  const lines = physicalLines(source);
  const headers: HumanTomlHeader[] = [];
  const assignments: HumanTomlAssignment[] = [];
  let tablePath: readonly string[] = Object.freeze([]);
  let arrayTableIndex: number | null = null;
  let nextArrayTableIndex = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (line === undefined || line.kind === 'blank' || line.kind === 'comment') continue;
    const header = headerOf(source, lines, lineIndex);
    if (header !== null) {
      headers.push(header);
      tablePath = header.path;
      arrayTableIndex = header.array ? nextArrayTableIndex++ : null;
      lines[lineIndex] = Object.freeze({ ...line, kind: 'header' });
      continue;
    }
    const body = source.slice(line.start, line.bodyEnd);
    const equals = assignmentEquals(body);
    if (equals < 0) continue;
    const keySource = body.slice(0, equals);
    const rawKey = keySource.trim();
    const keyPath = parseKeyPath(rawKey);
    if (keyPath === null) continue;
    const keyStart = line.start + (keySource.length - keySource.trimStart().length);
    let localValueStart = equals + 1;
    while (body[localValueStart] === ' ' || body[localValueStart] === '\t') localValueStart += 1;
    const valueStart = line.start + localValueStart;
    const value = scanValue(source, lines, lineIndex, valueStart);
    if (value === null) continue;
    const lastLine = lines[value.endLineIndex] ?? line;
    const rawValue = source.slice(valueStart, value.end);
    const trimmedValue = rawValue.trim();
    const assignment: HumanTomlAssignment = Object.freeze({
      start: line.start,
      end: lastLine.end,
      lineStart: line.start,
      lineBodyEnd: line.bodyEnd,
      lineEnd: line.end,
      lineIndex,
      endLineIndex: value.endLineIndex,
      tablePath,
      arrayTableIndex,
      keyPath,
      dotted: keyPath.length > 1,
      rawKey,
      keyRange: frozenRange(keyStart, keyStart + rawKey.length),
      value: rawValue,
      valueRange: frozenRange(valueStart, value.end),
      multiline: value.multiline || value.endLineIndex !== lineIndex,
      inlineComment:
        value.commentStart === null
          ? null
          : source.slice(
              value.commentStart,
              lines[value.endLineIndex]?.bodyEnd ?? value.commentStart,
            ),
      leadingCommentStart: leadingCommentStart(lines, lineIndex),
      quote: trimmedValue.startsWith("'")
        ? 'literal'
        : trimmedValue.startsWith('"')
          ? 'basic'
          : null,
      arrayTrailingComma: /,\s*\]$/u.test(trimmedValue),
    });
    assignments.push(assignment);
    lines[lineIndex] = Object.freeze({ ...line, kind: 'assignment' });
    for (let continuation = lineIndex + 1; continuation <= value.endLineIndex; continuation += 1) {
      const continued = lines[continuation];
      if (continued !== undefined)
        lines[continuation] = Object.freeze({ ...continued, kind: 'continuation' });
    }
    lineIndex = value.endLineIndex;
  }

  return ok(
    Object.freeze({
      bytes,
      source,
      lines: Object.freeze(lines.map((line) => Object.freeze({ ...line }))),
      headers: Object.freeze(headers),
      assignments: Object.freeze(assignments),
      comments: commentRanges(source),
    }),
  );
};

const literalSafe = (value: string): boolean => {
  if (value.includes("'")) return false;
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (point <= 0x1f || point === 0x7f) return false;
  }
  return true;
};

export const renderHumanTomlString = (
  value: string,
  preferred: 'basic' | 'literal' | null = null,
): string => (preferred === 'literal' && literalSafe(value) ? `'${value}'` : JSON.stringify(value));

export const renderHumanTomlStringArray = (
  values: readonly string[],
  options: Readonly<{ quote?: 'basic' | 'literal' | null; trailingComma?: boolean }> = {},
): string => {
  const rendered = values.map((value) => renderHumanTomlString(value, options.quote ?? null));
  return `[${rendered.join(', ')}${options.trailingComma === true && rendered.length > 0 ? ',' : ''}]`;
};

export const applyHumanTomlReplacements = (
  source: string,
  replacements: readonly HumanTomlReplacement[],
): Result<string, HumanTomlScanError> => {
  const sorted = [...replacements].sort(
    (left, right) => right.start - left.start || right.end - left.end,
  );
  let previousStart = source.length;
  let edited = source;
  for (const replacement of sorted) {
    if (
      !Number.isSafeInteger(replacement.start) ||
      !Number.isSafeInteger(replacement.end) ||
      replacement.start < 0 ||
      replacement.end < replacement.start ||
      replacement.end > source.length ||
      replacement.end > previousStart
    ) {
      return err(scanError('unsafe-human-edit', 'human TOML replacement ranges overlap'));
    }
    edited = `${edited.slice(0, replacement.start)}${replacement.text}${edited.slice(replacement.end)}`;
    previousStart = replacement.start;
  }
  return ok(edited);
};
