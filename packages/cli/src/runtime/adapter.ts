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

const snapshotReadonlyMap = (
  source: ReadonlyMap<unknown, unknown>,
  seen: WeakMap<object, unknown>,
): ReadonlyMap<unknown, unknown> => {
  let entries: readonly (readonly [unknown, unknown])[] = [];
  const facade = Object.create(null) as Record<PropertyKey, unknown>;
  seen.set(source, facade);

  const ownedEntries: Array<readonly [unknown, unknown]> = [];
  // Read through the public ReadonlyMap contract. Application products may expose
  // a Map-backed immutable proxy whose methods are bound to the backing Map; such
  // a proxy intentionally has no Map internal slots of its own.
  const iterator = source.entries();
  for (const [key, value] of iterator) {
    ownedEntries.push(
      Object.freeze([snapshotOwnedValue(key, seen), snapshotOwnedValue(value, seen)] as const),
    );
  }
  entries = Object.freeze(ownedEntries);

  const get = Object.freeze((key: unknown): unknown => {
    for (const [candidate, value] of entries) {
      if (Object.is(candidate, key) || candidate === key) return value;
    }
    return undefined;
  });
  const has = Object.freeze((key: unknown): boolean => {
    for (const [candidate] of entries) {
      if (Object.is(candidate, key) || candidate === key) return true;
    }
    return false;
  });
  const keys = Object.freeze(function* (): MapIterator<unknown> {
    for (const [key] of entries) yield key;
  });
  const values = Object.freeze(function* (): MapIterator<unknown> {
    for (const [, value] of entries) yield value;
  });
  const mapEntries = Object.freeze(function* (): MapIterator<[unknown, unknown]> {
    for (const [key, value] of entries) yield [key, value];
  });
  const forEach = Object.freeze(
    (
      callback: (value: unknown, key: unknown, map: ReadonlyMap<unknown, unknown>) => void,
      thisArg?: unknown,
    ): void => {
      for (const [key, value] of entries) callback.call(thisArg, value, key, facade as never);
    },
  );

  Object.defineProperties(facade, {
    size: { value: entries.length, enumerable: false },
    get: { value: get, enumerable: false },
    has: { value: has, enumerable: false },
    keys: { value: keys, enumerable: false },
    values: { value: values, enumerable: false },
    entries: { value: mapEntries, enumerable: false },
    forEach: { value: forEach, enumerable: false },
    [Symbol.iterator]: { value: mapEntries, enumerable: false },
    [Symbol.toStringTag]: { value: 'Map', enumerable: false },
  });
  return Object.freeze(facade) as unknown as ReadonlyMap<unknown, unknown>;
};

const snapshotOwnedValue = (value: unknown, seen: WeakMap<object, unknown>): unknown => {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function')
      throw new TypeError('application outcome contains an unsupported function');
    return value;
  }

  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  if (value instanceof Map) return snapshotReadonlyMap(value, seen);

  const sourceArray = Array.isArray(value) ? value : null;
  const sourcePrototype = Object.getPrototypeOf(value);
  const isError = value instanceof Error;
  if (
    sourceArray === null &&
    sourcePrototype !== Object.prototype &&
    sourcePrototype !== null &&
    !isError
  ) {
    throw new TypeError('application outcome contains an unsupported object');
  }

  const target: Record<PropertyKey, unknown> | unknown[] =
    sourceArray === null ? Object.create(isError ? Error.prototype : sourcePrototype) : [];
  seen.set(value, target);
  for (const key of Reflect.ownKeys(value)) {
    if (sourceArray !== null && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    const owned = snapshotOwnedValue(Reflect.get(value, key), seen);
    Object.defineProperty(target, key, {
      value: owned,
      enumerable: descriptor.enumerable ?? false,
      configurable: false,
      writable: false,
    });
  }
  if (sourceArray !== null) {
    Object.defineProperty(target, 'length', {
      value: sourceArray.length,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(target);
};

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

const renderedOutput = (value: string | RenderedCommandOutput): RenderedCommandOutput => {
  if (typeof value === 'string') return Object.freeze({ stdout: value });
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('renderer must return a string or output record');
  const stdout = value.stdout;
  const stderr = value.stderr;
  if (stdout !== undefined && typeof stdout !== 'string')
    throw new TypeError('renderer stdout must be a string');
  if (stderr !== undefined && typeof stderr !== 'string')
    throw new TypeError('renderer stderr must be a string');
  return Object.freeze({
    ...(stdout === undefined ? {} : { stdout }),
    ...(stderr === undefined ? {} : { stderr }),
  });
};

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
  try {
    if (request.format === 'json' && exitClass !== 'success' && exitClass !== 'drift') {
      request.diagnosticBuffer?.discard();
      return;
    }
    request.diagnosticBuffer?.flush();
  } catch {
    // Presentation-only diagnostic settlement cannot change command output or exit semantics.
  }
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

  const snapshotFailure = (failure: RuntimeFailure): RuntimeFailure => {
    const exitClass: unknown = failure.exitClass;
    const code = failure.code;
    const message = failure.message;
    if (!isExitClass(exitClass) || exitClass === 'success' || exitClass === 'drift')
      throw new TypeError('failure classifier returned an invalid exitClass');
    if (typeof code !== 'string' || typeof message !== 'string')
      throw new TypeError('failure classifier returned invalid text');
    return Object.freeze({ exitClass, code, message });
  };

  const safeClassification = (error: unknown): RuntimeFailure => {
    try {
      return snapshotFailure(classifyFailure(error));
    } catch (classificationError) {
      return snapshotFailure(defaultFailure(classificationError));
    }
  };

  const snapshotOutcome = (
    outcome: RuntimeOutcome,
    exitClass: RuntimeExitClass,
  ): RuntimeOutcome => {
    const seen = new WeakMap<object, unknown>();
    return Object.freeze({
      report: snapshotOwnedValue(outcome.report, seen),
      diagnostics: snapshotOwnedValue(outcome.diagnostics, seen),
      exitClass,
      mutation: snapshotOwnedValue(outcome.mutation, seen),
      deprecations: snapshotOwnedValue(outcome.deprecations, seen),
    }) as RuntimeOutcome;
  };

  const commandOutcome = (exitClass: RuntimeExitClass): 'success' | 'failure' | 'cancelled' => {
    if (exitClass === 'cancelled') return 'cancelled';
    return exitClass === 'success' || exitClass === 'drift' ? 'success' : 'failure';
  };

  const fallbackErrorCode = (exitClass: Exclude<RuntimeExitClass, 'success' | 'drift'>): string =>
    exitClass === 'failure' ? 'command-failed' : exitClass;

  const outcomeErrorCode = (
    outcome: RuntimeOutcome,
    exitClass: RuntimeExitClass,
  ): string | null => {
    if (exitClass === 'success' || exitClass === 'drift') return null;
    const diagnostic = outcome.diagnostics.find((candidate) => candidate.severity === 'error');
    if (diagnostic !== undefined) {
      return normalizeCliError(
        { code: diagnostic.code },
        {
          code: fallbackErrorCode(exitClass),
          message: 'Command failed',
        },
      ).code;
    }
    return fallbackErrorCode(exitClass);
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
      output = renderedOutput(renderFailure({ ...failure }, request.format));
    } catch (renderError) {
      failure = safeClassification(renderError);
      output = renderedOutput(defaultFailureRenderer(failure, request.format));
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
      let application: RuntimeApplication | undefined;
      try {
        application = options.applications[request.application];
      } catch (error) {
        return finishFailure(error, request, commandSpan);
      }
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

      let exitClass: RuntimeExitClass;
      let errorCode: string | null;
      let stableOutcome: RuntimeOutcome;
      try {
        exitClass = unwrapped.outcome.exitClass;
        if (!isExitClass(exitClass))
          throw new TypeError('application returned an invalid exitClass');
        stableOutcome = snapshotOutcome(unwrapped.outcome, exitClass);
        errorCode = outcomeErrorCode(stableOutcome, exitClass);
      } catch (error) {
        return finishFailure(error, request, commandSpan);
      }

      let renderer: RuntimeRenderer | undefined;
      try {
        renderer = options.renderers[request.reportKind];
      } catch (error) {
        return finishFailure(error, request, commandSpan);
      }
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
      const exitCode = exitCodeForClass(exitClass);
      completeCommand(observation, commandSpan, exitClass, errorCode);
      settleDiagnosticBuffer(request, exitClass);
      emitCommandOutput(options.io, outputForRequest(output, request));
      options.io.exit(exitCode);
      return { exitCode, outcome: stableOutcome };
    },
  };
};
