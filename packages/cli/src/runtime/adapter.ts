import type {
  CommandExitClass,
  CommandOutcome,
  ObservationBundle,
  ObservationSpan,
} from '@skillsmith/core';
import { normalizeCliError, renderCliError } from '../output/error-boundary.ts';
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
  readonly observation: ObservationBundle;
  readonly format: RuntimeFormat;
  /** Presentation-only policy; JSON output is never suppressed. */
  readonly quiet?: boolean;
  /** Internal stderr observation buffer, settled before canonical command output. */
  readonly diagnosticBuffer?: {
    flush(): void;
    discard(): void;
  };
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
  (typeof value === 'object' && value !== null) || typeof value === 'function';

const readProperty = (value: unknown, key: PropertyKey): unknown => {
  if (!isRecord(value)) return undefined;
  try {
    return value[key];
  } catch {
    return undefined;
  }
};

const isExitClass = (value: unknown): value is RuntimeExitClass =>
  typeof value === 'string' && Object.hasOwn(EXIT_CODES, value);

const exitClassForCode = (exitCode: ExitCode): RuntimeExitClass => {
  switch (exitCode) {
    case 0:
    case 1:
      return 'failure';
    case 2:
      return 'usage';
    case 3:
      return 'state';
    case 4:
      return 'capability';
    case 5:
      return 'source';
    case 6:
      return 'permission';
    case 7:
      return 'drift';
    case 130:
      return 'cancelled';
  }
};

const isOutcome = (value: unknown): value is RuntimeOutcome =>
  isRecord(value) &&
  'report' in value &&
  Array.isArray(value.diagnostics) &&
  isExitClass(value.exitClass) &&
  'mutation' in value &&
  Array.isArray(value.deprecations);

const defaultFailure = (error: unknown): RuntimeFailure => {
  const requestedClass = readProperty(error, 'exitClass');
  const explicitClass = isExitClass(requestedClass) ? requestedClass : undefined;
  const fallbackClass =
    explicitClass === undefined || explicitClass === 'success' || explicitClass === 'drift'
      ? 'failure'
      : explicitClass;
  const normalized = normalizeCliError(error, { exitCode: exitCodeForClass(fallbackClass) });
  const normalizedClass = exitClassForCode(normalized.exitCode);
  const exitClass =
    explicitClass === undefined
      ? normalizedClass === 'success' || normalizedClass === 'drift'
        ? 'failure'
        : normalizedClass
      : fallbackClass;
  return {
    exitClass,
    code: normalized.code,
    message: normalized.message,
  };
};

const defaultFailureRenderer: RuntimeFailureRenderer = (failure, format) => {
  const normalized = normalizeCliError(failure, {
    exitCode: exitCodeForClass(failure.exitClass),
  });
  const rendered = renderCliError(
    { ...normalized, exitCode: exitCodeForClass(failure.exitClass) },
    format,
  );
  return format === 'human' ? { stderr: rendered } : { stdout: rendered };
};

const renderedOutput = (value: string | RenderedCommandOutput): RenderedCommandOutput =>
  typeof value === 'string' ? { stdout: value } : value;

const outputForRequest = (
  output: RenderedCommandOutput,
  request: Pick<RuntimeExecutionRequest, 'format' | 'quiet'>,
): RenderedCommandOutput =>
  request.format === 'human' && request.quiet === true
    ? { ...(output.stderr === undefined ? {} : { stderr: output.stderr }) }
    : output;

const settleDiagnosticBuffer = (
  request: RuntimeExecutionRequest,
  exitClass: RuntimeExitClass,
): void => {
  if (request.format === 'json' && exitClass !== 'success' && exitClass !== 'drift') {
    request.diagnosticBuffer?.discard();
    return;
  }
  request.diagnosticBuffer?.flush();
};

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

  const safeClassification = (error: unknown): RuntimeFailure => {
    try {
      return classifyFailure(error);
    } catch (classificationError) {
      return defaultFailure(classificationError);
    }
  };

  const commandOutcome = (exitClass: RuntimeExitClass): 'success' | 'failure' | 'cancelled' => {
    if (exitClass === 'cancelled') return 'cancelled';
    return exitClass === 'success' || exitClass === 'drift' ? 'success' : 'failure';
  };

  const fallbackErrorCode = (exitClass: Exclude<RuntimeExitClass, 'success' | 'drift'>): string =>
    exitClass === 'failure' ? 'command-failed' : exitClass;

  const outcomeErrorCode = (outcome: RuntimeOutcome): string | null => {
    if (outcome.exitClass === 'success' || outcome.exitClass === 'drift') return null;
    const diagnostic = outcome.diagnostics.find((candidate) => candidate.severity === 'error');
    if (diagnostic !== undefined) {
      return normalizeCliError(
        { code: diagnostic.code },
        {
          code: fallbackErrorCode(outcome.exitClass),
          message: 'Command failed',
        },
      ).code;
    }
    return fallbackErrorCode(outcome.exitClass);
  };

  const completeCommand = (
    observation: ObservationBundle | undefined,
    span: ObservationSpan<'command.started'> | null,
    exitClass: RuntimeExitClass,
    errorCode: string | null,
  ): void => {
    observation?.emitter.complete(span, {
      outcome: commandOutcome(exitClass),
      exitClass,
      errorCode,
    });
  };

  const finishFailure = (
    error: unknown,
    request: RuntimeExecutionRequest,
    commandSpan: ObservationSpan<'command.started'> | null,
  ): RuntimeExecution => {
    let failure = safeClassification(error);
    let output: RenderedCommandOutput;
    try {
      output = renderFailure(failure, request.format);
    } catch (renderError) {
      failure = safeClassification(renderError);
      output = defaultFailureRenderer(failure, request.format);
    }
    const exitCode = exitCodeForClass(failure.exitClass);
    completeCommand(request.observation, commandSpan, failure.exitClass, failure.code);
    settleDiagnosticBuffer(request, failure.exitClass);
    emitCommandOutput(options.io, outputForRequest(output, request));
    options.io.exit(exitCode);
    return { exitCode, failure };
  };

  return {
    execute: async (request): Promise<RuntimeExecution> => {
      // Kept tolerant at runtime for older embedders while the public type requires the bundle.
      const observation = request.observation as ObservationBundle | undefined;
      const commandSpan: ObservationSpan<'command.started'> | null =
        observation?.emitter.begin<'command.started'>(observation.context, {
          kind: 'command.started',
        }) ?? null;
      const application = options.applications[request.application];
      if (application === undefined) {
        return finishFailure(
          new Error(`Application service '${request.application}' is not registered`),
          request,
          commandSpan,
        );
      }

      let unwrapped: { readonly outcome: RuntimeOutcome } | { readonly error: unknown };
      try {
        const result = await application(request.request, request.context);
        unwrapped = unwrapApplicationResult(result);
      } catch (error) {
        return finishFailure(error, request, commandSpan);
      }

      if ('error' in unwrapped) return finishFailure(unwrapped.error, request, commandSpan);

      const renderer = options.renderers[request.reportKind];
      if (renderer === undefined) {
        return finishFailure(
          new Error(`Renderer '${request.reportKind}' is not registered`),
          request,
          commandSpan,
        );
      }

      let output: RenderedCommandOutput;
      try {
        output = renderedOutput(renderer[request.format](unwrapped.outcome));
      } catch (error) {
        return finishFailure(error, request, commandSpan);
      }
      const exitCode = exitCodeForClass(unwrapped.outcome.exitClass);
      completeCommand(
        observation,
        commandSpan,
        unwrapped.outcome.exitClass,
        outcomeErrorCode(unwrapped.outcome),
      );
      settleDiagnosticBuffer(request, unwrapped.outcome.exitClass);
      emitCommandOutput(options.io, outputForRequest(output, request));
      options.io.exit(exitCode);
      return { exitCode, outcome: unwrapped.outcome };
    },
  };
};
