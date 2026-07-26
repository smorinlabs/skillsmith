import { stripVTControlCharacters } from 'node:util';
import {
  type SkillSmithError,
  redactSensitiveString,
  redactSensitiveValue,
} from '@skillsmith/core';
import { errorV1Codec, toErrorV1Dto } from '@skillsmith/core/contracts/v1';
import type { Command } from 'commander';
import { type CliRuntimeIo, processRuntimeIo } from '../runtime/io.ts';
import {
  presentHumanOutput,
  presentationPolicyForIo,
  presentationPolicyFromArgv,
} from '../runtime/presentation.ts';
import { type ExitCode, exitCodeForError } from '../util/exit-codes.ts';
import { encodeWire } from './wire-codec.ts';

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

export type CliErrorFormat = 'human' | 'json';

const SKILLSMITH_ERROR_CODES = new Set<SkillSmithError['code']>([
  'generic',
  'invalid-argument',
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
  'cancelled',
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
  const sanitized = stripVTControlCharacters(redactSensitiveString(value))
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

  const safeFallback = redactSensitiveValue(fallback);
  const code = sanitizeCode(
    readString(safeFallback, 'code') ?? DEFAULT_ERROR.code,
    DEFAULT_ERROR.code,
  );
  const message = sanitizeMessage(
    readString(safeFallback, 'message') ?? DEFAULT_ERROR.message,
    DEFAULT_ERROR.message,
  );
  const exitCode = readProperty(safeFallback, 'exitCode');
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
  // Convert hostile values to the shared frozen data-only shape before reading a property. This
  // avoids invoking caller accessors/proxy traps and applies the same recursive secret policy used
  // by observations and acquisition reports.
  const safeError = redactSensitiveValue(error);
  const rawCode = readString(safeError, 'code');
  const rawName = readString(safeError, 'name');

  if (rawName === 'AbortError' || rawCode === 'ABORT_ERR') {
    return {
      code: 'cancelled',
      message: sanitizeMessage(
        readString(safeError, 'message') ?? 'Interrupted by user',
        safeFallback.message,
      ),
      exitCode: 130,
    };
  }

  if (rawCode?.startsWith('commander.') === true) {
    const informational = rawCode === 'commander.helpDisplayed' || rawCode === 'commander.version';
    const commanderMessage = (readString(safeError, 'message') ?? safeFallback.message).replace(
      /^error:\s*/i,
      '',
    );
    return {
      code: sanitizeCode(rawCode, 'commander.error'),
      message: sanitizeMessage(commanderMessage, safeFallback.message),
      exitCode: informational ? 0 : 2,
    };
  }

  if (rawCode === 'artifact-mutation') {
    const exitCode = readProperty(safeError, 'exitCode');
    return {
      code: rawCode,
      message: sanitizeMessage(
        readString(safeError, 'message') ?? 'Artifact mutation failed',
        safeFallback.message,
      ),
      exitCode: isExitCode(exitCode) ? exitCode : 3,
    };
  }

  if (rawCode !== undefined && SKILLSMITH_ERROR_CODES.has(rawCode as SkillSmithError['code'])) {
    const code = rawCode as SkillSmithError['code'];
    return {
      code,
      message: sanitizeMessage(messageForSkillSmithError(safeError, code), safeFallback.message),
      exitCode: exitCodeForError(safeError as SkillSmithError),
    };
  }

  const message =
    readString(safeError, 'message') ??
    (typeof safeError === 'string' ? safeError : safeFallback.message);
  return {
    code: rawCode === undefined ? safeFallback.code : sanitizeCode(rawCode, safeFallback.code),
    message: sanitizeMessage(message, safeFallback.message),
    exitCode: safeFallback.exitCode,
  };
};

/** Render exactly one public error record, with no access to the original throwable. */
export const renderCliError = (error: NormalizedCliError, format: CliErrorFormat): string => {
  if (format === 'human')
    return `error: ${sanitizeMessage(error.message, DEFAULT_ERROR.message)}\n`;

  return encodeWire(
    errorV1Codec,
    toErrorV1Dto({
      code: sanitizeCode(error.code, DEFAULT_ERROR.code),
      message: sanitizeMessage(error.message, DEFAULT_ERROR.message),
      exitCode: error.exitCode,
    }),
  );
};

/** Resolve the requested error format before Commander has necessarily completed option parsing. */
export const cliErrorFormatFromArgv = (
  argv: readonly string[] = process.argv.slice(2),
): CliErrorFormat => {
  if (argv.includes('--json') || argv.includes('--format=json')) return 'json';
  const formatIndex = argv.lastIndexOf('--format');
  return formatIndex >= 0 && argv[formatIndex + 1] === 'json' ? 'json' : 'human';
};

/** Emit exactly one normalized error value to the format-owned stream and terminate control flow. */
export const failCliError = (
  error: unknown,
  format: CliErrorFormat = cliErrorFormatFromArgv(),
  fallback?: string | CliErrorFallback,
  argv: readonly string[] = process.argv.slice(2),
  io: CliRuntimeIo = processRuntimeIo,
): never => {
  const normalized = normalizeCliError(error, fallback);
  const rendered = renderCliError(normalized, format);
  if (format === 'json') {
    io.stdout.write(rendered);
  } else {
    const presented = presentHumanOutput(
      { stderr: rendered },
      presentationPolicyFromArgv(argv, format, io),
      'error',
    );
    io.stderr.write(presented.stderr ?? rendered);
  }
  process.exit(normalized.exitCode);
};

const invocationForCommand = (command: Command): readonly string[] => {
  let root = command;
  while (root.parent !== null) root = root.parent;
  const state = root as Command & {
    readonly rawArgs?: readonly string[];
    readonly _scriptPath?: string;
  };
  const rawArgs = state.rawArgs ?? process.argv;
  return state._scriptPath === undefined ? rawArgs : rawArgs.slice(2);
};

/**
 * Route Commander usage failures through the same boundary. Commander writes its diagnostic before
 * invoking an exit override, so suppress that raw write and emit the normalized record here.
 */
export const withCliErrorBoundary = <T extends Command>(
  command: T,
  io: CliRuntimeIo = processRuntimeIo,
): T => {
  command.configureOutput({
    writeOut: (value) => {
      const options = command.optsWithGlobals() as { quiet?: boolean };
      if (options.quiet !== true) {
        const output = presentHumanOutput(
          { stdout: value },
          presentationPolicyForIo(options, 'human', io),
          'help',
        );
        if (output.stdout !== undefined) io.stdout.write(output.stdout);
      }
    },
    writeErr: () => undefined,
  });
  command.exitOverride((error) => {
    if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') {
      process.exit(0);
    }
    const invocation = invocationForCommand(command);
    failCliError(error, cliErrorFormatFromArgv(invocation), undefined, invocation, io);
  });
  return command;
};
