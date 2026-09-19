import { isAbsolute, resolve } from 'node:path';
import { parseCompletionGraph } from './adapter.ts';
import type { CompletionProviderContext } from './providers.ts';

export const COMPLETION_FAIL_CLOSED = ':5\n';

export const COMPLETION_TRANSPORT_LIMITS = Object.freeze({
  tokens: 64,
  tokenBytes: 4 * 1024,
  inputBytes: 16 * 1024,
  candidates: 256,
  outputBytes: 64 * 1024,
});

export type CompletionRequestContext = CompletionProviderContext;

const encoder = new TextEncoder();
const unpairedSurrogate =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/u;

const hasControl = (value: string): boolean => {
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (point <= 0x1f || (point >= 0x7f && point <= 0x9f)) return true;
  }
  return false;
};

const validInput = (tokens: readonly string[]): boolean => {
  if (tokens.length > COMPLETION_TRANSPORT_LIMITS.tokens) return false;
  let total = 0;
  for (const token of tokens) {
    if (typeof token !== 'string' || unpairedSurrogate.test(token)) return false;
    const bytes = encoder.encode(token).byteLength;
    if (bytes > COMPLETION_TRANSPORT_LIMITS.tokenBytes) return false;
    total += bytes;
    if (total > COMPLETION_TRANSPORT_LIMITS.inputBytes) return false;
  }
  return true;
};

const validField = (value: string, allowEmpty: boolean): boolean =>
  (allowEmpty || value.length > 0) && !hasControl(value) && !unpairedSurrogate.test(value);

export const validateCompletionProtocol = (captured: string): string => {
  if (captured === COMPLETION_FAIL_CLOSED) return captured;
  if (
    unpairedSurrogate.test(captured) ||
    encoder.encode(captured).byteLength > COMPLETION_TRANSPORT_LIMITS.outputBytes ||
    !captured.endsWith('\n')
  ) {
    return COMPLETION_FAIL_CLOSED;
  }
  const lines = captured.slice(0, -1).split('\n');
  const directiveLine = lines.pop();
  if (directiveLine === undefined || !/^:\d+$/u.test(directiveLine)) {
    return COMPLETION_FAIL_CLOSED;
  }
  const directive = Number(directiveLine.slice(1));
  const successfulBits = 2 | 4 | 32;
  if (!Number.isSafeInteger(directive) || directive < 0 || (directive & ~successfulBits) !== 0) {
    return COMPLETION_FAIL_CLOSED;
  }
  if (lines.length > COMPLETION_TRANSPORT_LIMITS.candidates) return COMPLETION_FAIL_CLOSED;
  for (const line of lines) {
    if (/^:\d+$/u.test(line)) return COMPLETION_FAIL_CLOSED;
    const firstTab = line.indexOf('\t');
    if (firstTab >= 0 && line.indexOf('\t', firstTab + 1) >= 0) return COMPLETION_FAIL_CLOSED;
    const value = firstTab < 0 ? line : line.slice(0, firstTab);
    const description = firstTab < 0 ? '' : line.slice(firstTab + 1);
    if (!validField(value, false) || !validField(description, true)) {
      return COMPLETION_FAIL_CLOSED;
    }
  }
  return captured;
};

const effectiveCwd = (tokens: readonly string[], initial: string): string => {
  let cwd = initial;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (token === '--') break;
    let selected: string | undefined;
    if (token === '--cd' || token === '-C') {
      selected = tokens[index + 1];
      index += 1;
    } else if (token.startsWith('--cd=')) {
      selected = token.slice('--cd='.length);
    } else if (token.startsWith('-C') && token.length > 2) {
      selected = token.slice(2);
    }
    if (selected === undefined || selected.length === 0) continue;
    cwd = isAbsolute(selected) ? selected : resolve(cwd, selected);
  }
  return cwd;
};

export const resolveCompletionRequest = async (
  tokens: readonly string[],
  context: CompletionRequestContext,
): Promise<string> => {
  if (!validInput(tokens)) return COMPLETION_FAIL_CLOSED;
  try {
    const captured = await parseCompletionGraph(tokens, {
      cwd: effectiveCwd(tokens, context.cwd),
      monotonicMilliseconds: context.monotonicMilliseconds,
      ports: context.ports,
    });
    return validateCompletionProtocol(captured);
  } catch {
    return COMPLETION_FAIL_CLOSED;
  }
};
