import type { CommandExitClass, CommandOutcome } from '@skillsmith/core';
import type { ExitCode } from '../util/exit-codes.ts';
import { type CliRuntimeIo, type RenderedCommandOutput, emitCommandOutput } from './io.ts';

export type RuntimeExitClass = CommandExitClass;

/** Structural view of the public core outcome, avoiding a second CLI-owned domain model. */
export type RuntimeOutcome<T = unknown> = CommandOutcome<T>;

export interface RuntimeFailure {
  readonly exitClass: Exclude<RuntimeExitClass, 'success' | 'drift'>;
  readonly code: string;
  readonly message: string;
}

export type RuntimeApplicationResult =
  | RuntimeOutcome
  | { readonly ok: true; readonly value: RuntimeOutcome }
  | { readonly ok: false; readonly error: unknown };

export type RuntimeApplication = (
  request: unknown,
  context: unknown,
) => RuntimeApplicationResult | Promise<RuntimeApplicationResult>;

export interface RuntimeRenderer {
  human(outcome: RuntimeOutcome): string | RenderedCommandOutput;
  json(outcome: RuntimeOutcome): string | RenderedCommandOutput;
}

export type ApplicationRegistry = Readonly<Record<string, RuntimeApplication>>;
export type RendererRegistry = Readonly<Record<string, RuntimeRenderer>>;

export type RuntimeFailureClassifier = (error: unknown) => RuntimeFailure;

export type RuntimeFailureRenderer = (
  failure: RuntimeFailure,
  format: RuntimeFormat,
) => RenderedCommandOutput;

export type RuntimeFormat = 'human' | 'json';

export interface RuntimeAdapterOptions {
  readonly applications: ApplicationRegistry;
  readonly renderers: RendererRegistry;
  readonly io: CliRuntimeIo;
  readonly classifyFailure?: RuntimeFailureClassifier;
  readonly renderFailure?: RuntimeFailureRenderer;
}

export interface RuntimeExecutionRequest {
  readonly application: string;
  readonly reportKind: string;
  readonly request: unknown;
  readonly context: unknown;
  readonly format: RuntimeFormat;
}

export interface RuntimeExecution {
  readonly exitCode: ExitCode;
  readonly outcome?: RuntimeOutcome;
  readonly failure?: RuntimeFailure;
}

export interface CliRuntimeAdapter {
  execute(request: RuntimeExecutionRequest): Promise<RuntimeExecution>;
}

const EXIT_CODES = {
  success: 0,
  failure: 1,
  usage: 2,
  state: 3,
  capability: 4,
  source: 5,
  permission: 6,
  drift: 7,
  cancelled: 130,
} as const satisfies Record<RuntimeExitClass, ExitCode>;

export const exitCodeForClass = (exitClass: RuntimeExitClass): ExitCode => EXIT_CODES[exitClass];

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === 'object' && value !== null;

const isExitClass = (value: unknown): value is RuntimeExitClass =>
  typeof value === 'string' && Object.hasOwn(EXIT_CODES, value);

const isOutcome = (value: unknown): value is RuntimeOutcome =>
  isRecord(value) &&
  'report' in value &&
  Array.isArray(value.diagnostics) &&
  isExitClass(value.exitClass) &&
  'mutation' in value &&
  Array.isArray(value.deprecations);

const defaultFailure = (error: unknown): RuntimeFailure => {
  if (isRecord(error)) {
    const exitClass = isExitClass(error.exitClass) ? error.exitClass : 'failure';
    const safeClass = exitClass === 'success' || exitClass === 'drift' ? 'failure' : exitClass;
    return {
      exitClass: safeClass,
      code: typeof error.code === 'string' ? error.code : 'generic',
      message: typeof error.message === 'string' ? error.message : 'Unexpected error',
    };
  }
  return {
    exitClass: 'failure',
    code: 'generic',
    message: typeof error === 'string' ? error : 'Unexpected error',
  };
};

const sanitizeLine = (value: string): string => value.replace(/[\r\n\t]+/g, ' ').trim();

const defaultFailureRenderer: RuntimeFailureRenderer = (failure, format) => {
  const message = sanitizeLine(failure.message) || 'Unexpected error';
  if (format === 'human') return { stderr: `error: ${message}\n` };
  return {
    stdout: `${JSON.stringify({
      schemaVersion: 1,
      kind: 'error',
      code: failure.code,
      message,
      exitCode: exitCodeForClass(failure.exitClass),
    })}\n`,
  };
};

const renderedOutput = (value: string | RenderedCommandOutput): RenderedCommandOutput =>
  typeof value === 'string' ? { stdout: value } : value;

const unwrapApplicationResult = (
  result: RuntimeApplicationResult,
): { readonly outcome: RuntimeOutcome } | { readonly error: unknown } => {
  if (isOutcome(result)) return { outcome: result };
  if (result.ok)
    return isOutcome(result.value) ? { outcome: result.value } : { error: result.value };
  return { error: result.error };
};

export const createCliRuntimeAdapter = (options: RuntimeAdapterOptions): CliRuntimeAdapter => {
  const classifyFailure = options.classifyFailure ?? defaultFailure;
  const renderFailure = options.renderFailure ?? defaultFailureRenderer;

  const finishFailure = (error: unknown, format: RuntimeFormat): RuntimeExecution => {
    const failure = classifyFailure(error);
    const exitCode = exitCodeForClass(failure.exitClass);
    emitCommandOutput(options.io, renderFailure(failure, format));
    options.io.exit(exitCode);
    return { exitCode, failure };
  };

  return {
    execute: async (request): Promise<RuntimeExecution> => {
      const application = options.applications[request.application];
      if (application === undefined) {
        return finishFailure(
          new Error(`Application service '${request.application}' is not registered`),
          request.format,
        );
      }

      let result: RuntimeApplicationResult;
      try {
        result = await application(request.request, request.context);
      } catch (error) {
        return finishFailure(error, request.format);
      }

      const unwrapped = unwrapApplicationResult(result);
      if ('error' in unwrapped) return finishFailure(unwrapped.error, request.format);

      const renderer = options.renderers[request.reportKind];
      if (renderer === undefined) {
        return finishFailure(
          new Error(`Renderer '${request.reportKind}' is not registered`),
          request.format,
        );
      }

      const output = renderer[request.format](unwrapped.outcome);
      emitCommandOutput(options.io, renderedOutput(output));
      const exitCode = exitCodeForClass(unwrapped.outcome.exitClass);
      options.io.exit(exitCode);
      return { exitCode, outcome: unwrapped.outcome };
    },
  };
};
