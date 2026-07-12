import { stripVTControlCharacters } from 'node:util';
import type { SkillSmithError } from '@skillsmith/core';
import { type ExitCode, exitCodeForError } from '../util/exit-codes.ts';

export type CliErrorExitCode = ExitCode;

export interface NormalizedCliError {
  readonly code: string;
  readonly message: string;
  readonly exitCode: CliErrorExitCode;
}

export interface CliErrorFallback {
  readonly code?: string;
  readonly message?: string;
  readonly exitCode?: CliErrorExitCode;
}

const SKILLSMITH_ERROR_CODES = new Set<SkillSmithError['code']>([
  'generic',
  'unknown-tool',
  'config-error',
  'skill-parse-error',
  'placement-not-found',
  'source-unresolvable',
  'ledger-error',
  'permission-denied',
  'flip-refused',
  'flip-failed',
  'tool-unavailable',
]);

const DEFAULT_ERROR: NormalizedCliError = {
  code: 'generic',
  message: 'Unexpected error',
  exitCode: 1,
};

const CONTROL_OR_LINE_SEPARATOR = /[\p{Cc}\p{Zl}\p{Zp}]+/gu;
const WHITESPACE = /\s+/g;
const UNSAFE_CODE_CHARACTER = /[^A-Za-z0-9._-]+/g;

const sanitizeMessage = (value: string, fallback: string): string => {
  const sanitized = stripVTControlCharacters(value)
    .replace(CONTROL_OR_LINE_SEPARATOR, ' ')
    .replace(WHITESPACE, ' ')
    .trim();
  return sanitized.length > 0 ? sanitized : fallback;
};

const sanitizeCode = (value: string, fallback: string): string => {
  const sanitized = value.replace(UNSAFE_CODE_CHARACTER, '-').replace(/^-+|-+$/g, '');
  return sanitized.length > 0 ? sanitized : fallback;
};

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  (typeof value === 'object' && value !== null) || typeof value === 'function';

const readProperty = (value: unknown, key: PropertyKey): unknown => {
  if (!isRecord(value)) return undefined;
  try {
    return value[key];
  } catch {
    return undefined;
  }
};

const readString = (value: unknown, key: PropertyKey): string | undefined => {
  const property = readProperty(value, key);
  return typeof property === 'string' ? property : undefined;
};

const isExitCode = (value: unknown): value is CliErrorExitCode =>
  value === 0 ||
  value === 1 ||
  value === 2 ||
  value === 3 ||
  value === 4 ||
  value === 5 ||
  value === 6 ||
  value === 7 ||
  value === 130;

const fallbackError = (fallback?: string | CliErrorFallback): NormalizedCliError => {
  if (fallback === undefined) return DEFAULT_ERROR;
  if (typeof fallback === 'string') {
    return { ...DEFAULT_ERROR, message: sanitizeMessage(fallback, DEFAULT_ERROR.message) };
  }

  const code = sanitizeCode(readString(fallback, 'code') ?? DEFAULT_ERROR.code, DEFAULT_ERROR.code);
  const message = sanitizeMessage(
    readString(fallback, 'message') ?? DEFAULT_ERROR.message,
    DEFAULT_ERROR.message,
  );
  const exitCode = readProperty(fallback, 'exitCode');
  return { code, message, exitCode: isExitCode(exitCode) ? exitCode : DEFAULT_ERROR.exitCode };
};

const messageForSkillSmithError = (error: unknown, code: SkillSmithError['code']): string => {
  const message = readString(error, 'message');
  if (message !== undefined) return message;
  if (code === 'unknown-tool') {
    const tool = readString(error, 'tool');
    if (tool !== undefined) return `Unknown tool: ${tool}`;
  }
  return code;
};

/** Convert any thrown value to the small, non-recursive public CLI error contract. */
export const normalizeCliError = (
  error: unknown,
  fallback?: string | CliErrorFallback,
): NormalizedCliError => {
  const safeFallback = fallbackError(fallback);
  const rawCode = readString(error, 'code');
  const rawName = readString(error, 'name');

  if (rawName === 'AbortError' || rawCode === 'ABORT_ERR') {
    return {
      code: 'cancelled',
      message: sanitizeMessage(
        readString(error, 'message') ?? 'Interrupted by user',
        safeFallback.message,
      ),
      exitCode: 130,
    };
  }

  if (rawCode?.startsWith('commander.') === true) {
    const informational = rawCode === 'commander.helpDisplayed' || rawCode === 'commander.version';
    return {
      code: sanitizeCode(rawCode, 'commander.error'),
      message: sanitizeMessage(
        readString(error, 'message') ?? safeFallback.message,
        safeFallback.message,
      ),
      exitCode: informational ? 0 : 2,
    };
  }

  if (rawCode !== undefined && SKILLSMITH_ERROR_CODES.has(rawCode as SkillSmithError['code'])) {
    const code = rawCode as SkillSmithError['code'];
    return {
      code,
      message: sanitizeMessage(messageForSkillSmithError(error, code), safeFallback.message),
      exitCode: exitCodeForError(error as SkillSmithError),
    };
  }

  const message =
    readString(error, 'message') ?? (typeof error === 'string' ? error : safeFallback.message);
  return {
    code: rawCode === undefined ? safeFallback.code : sanitizeCode(rawCode, safeFallback.code),
    message: sanitizeMessage(message, safeFallback.message),
    exitCode: safeFallback.exitCode,
  };
};

/** Render exactly one public error record, with no access to the original throwable. */
export const renderCliError = (error: NormalizedCliError, format: 'human' | 'json'): string => {
  if (format === 'human')
    return `error: ${sanitizeMessage(error.message, DEFAULT_ERROR.message)}\n`;

  return `${JSON.stringify({
    schemaVersion: 1,
    kind: 'error',
    code: sanitizeCode(error.code, DEFAULT_ERROR.code),
    message: sanitizeMessage(error.message, DEFAULT_ERROR.message),
    exitCode: error.exitCode,
  })}\n`;
};
