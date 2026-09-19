import type { CommandExitClass } from '../application/types.ts';
import type { ClockPort } from '../ports/types.ts';

export const OBSERVATION_EVENT_KINDS = Object.freeze([
  'command.started',
  'command.completed',
  'plan.created',
  'operation.started',
  'operation.completed',
  'tool.detection.started',
  'tool.detection.completed',
  'tool.verification.started',
  'tool.verification.completed',
  'transaction.stage.started',
  'transaction.stage.completed',
  'transaction.committed',
  'transaction.rolled-back',
  'recovery.started',
  'recovery.completed',
] as const);

export const OPERATION_KINDS = Object.freeze([
  'inventory',
  'diagnostics',
  'install',
  'update',
  'remove',
  'link-dev',
  'promote',
  'move-scope',
  'adapt',
  'repair',
  'write-manifest',
  'write-lock',
  'migrate-project-config',
  'migrate-ledger',
] as const);

export type ObserverEventKind = (typeof OBSERVATION_EVENT_KINDS)[number];
export type OperationKind = (typeof OPERATION_KINDS)[number];
export type ObservationVerbosity = 'quiet' | 'normal' | 'verbose' | 'trace' | 'debug';
export type ObservationOutcome = 'success' | 'failure' | 'cancelled' | 'skipped';
export type VerificationMode = 'static' | 'deep';
export type VerificationVerdict =
  | 'pass'
  | 'warn'
  | 'fail'
  | 'inconclusive'
  | 'unavailable'
  | 'skipped';
export type TransactionStage = 'prepared' | 'staged' | 'backed-up' | 'live' | 'committed';
export type RecoveryKind = 'resume' | 'rollback' | 'cleanup';

export type OperationContext = Readonly<{
  operationId: string;
  parentOperationId: string | null;
  command: string;
  workflow: string;
  groupId: string | null;
  pairId: string | null;
  attempt: number;
  clock: Readonly<Pick<ClockPort, 'wallNowIso' | 'monotonicMilliseconds'>>;
  startedAt: string;
  startedMonotonicMilliseconds: number;
}>;

export type ObserverEventPayloadMap = {
  readonly 'command.started': Readonly<Record<never, never>>;
  readonly 'command.completed': Readonly<{
    outcome: 'success' | 'failure' | 'cancelled';
    exitClass: CommandExitClass;
    errorCode: string | null;
    durationMilliseconds: number;
  }>;
  readonly 'plan.created': Readonly<{ planId: string; operationCount: number }>;
  readonly 'operation.started': Readonly<{ operationKind: OperationKind }>;
  readonly 'operation.completed': Readonly<{
    operationKind: OperationKind;
    outcome: ObservationOutcome;
    errorCode: string | null;
    standaloneCount: number | null;
    bundledCount: number | null;
    resultCount: number | null;
    durationMilliseconds: number;
  }>;
  readonly 'tool.detection.started': Readonly<{ toolId: string }>;
  readonly 'tool.detection.completed': Readonly<{
    toolId: string;
    outcome: ObservationOutcome;
    errorCode: string | null;
    resultCount: number;
    durationMilliseconds: number;
  }>;
  readonly 'tool.verification.started': Readonly<{
    toolId: string;
    modes: readonly VerificationMode[];
  }>;
  readonly 'tool.verification.completed': Readonly<{
    toolId: string;
    modes: readonly VerificationMode[];
    verdict: VerificationVerdict;
    errorCode: string | null;
    durationMilliseconds: number;
  }>;
  readonly 'transaction.stage.started': Readonly<{
    transactionId: string;
    stage: TransactionStage;
  }>;
  readonly 'transaction.stage.completed': Readonly<{
    transactionId: string;
    stage: TransactionStage;
    outcome: ObservationOutcome;
    errorCode: string | null;
    durationMilliseconds: number;
  }>;
  readonly 'transaction.committed': Readonly<{
    transactionId: string;
    durationMilliseconds: number;
  }>;
  readonly 'transaction.rolled-back': Readonly<{
    transactionId: string;
    reasonCode: string;
    durationMilliseconds: number;
  }>;
  readonly 'recovery.started': Readonly<{
    transactionId: string;
    recoveryKind: RecoveryKind;
  }>;
  readonly 'recovery.completed': Readonly<{
    transactionId: string;
    recoveryKind: RecoveryKind;
    outcome: ObservationOutcome;
    errorCode: string | null;
    durationMilliseconds: number;
  }>;
};

export type ObserverEventCommon = Readonly<{
  operationId: string;
  parentOperationId: string | null;
  command: string;
  workflow: string;
  groupId: string | null;
  pairId: string | null;
  attempt: number;
  occurredAt: string;
  monotonicMilliseconds: number;
}>;

export type ObserverEvent = {
  readonly [Kind in ObserverEventKind]: Readonly<
    ObserverEventCommon & { readonly kind: Kind } & ObserverEventPayloadMap[Kind]
  >;
}[ObserverEventKind];

export interface ObserverPort {
  observe(event: ObserverEvent): void | PromiseLike<void>;
}

export type StartedKind =
  | 'command.started'
  | 'operation.started'
  | 'tool.detection.started'
  | 'tool.verification.started'
  | 'transaction.stage.started'
  | 'recovery.started';

export type InstantKind = 'plan.created' | 'transaction.committed' | 'transaction.rolled-back';

export type StartedInput<Kind extends StartedKind> = Kind extends StartedKind
  ? Readonly<{ kind: Kind } & ObserverEventPayloadMap[Kind]>
  : never;

export type InstantInput<Kind extends InstantKind> = Kind extends InstantKind
  ? Readonly<{ kind: Kind } & ObserverEventPayloadMap[Kind]>
  : never;

export type CompletionInput<Kind extends StartedKind> = Kind extends 'command.started'
  ? Omit<ObserverEventPayloadMap['command.completed'], 'durationMilliseconds'>
  : Kind extends 'operation.started'
    ? Omit<ObserverEventPayloadMap['operation.completed'], 'operationKind' | 'durationMilliseconds'>
    : Kind extends 'tool.detection.started'
      ? Omit<ObserverEventPayloadMap['tool.detection.completed'], 'toolId' | 'durationMilliseconds'>
      : Kind extends 'tool.verification.started'
        ? Omit<
            ObserverEventPayloadMap['tool.verification.completed'],
            'toolId' | 'modes' | 'durationMilliseconds'
          >
        : Kind extends 'transaction.stage.started'
          ? Omit<
              ObserverEventPayloadMap['transaction.stage.completed'],
              'transactionId' | 'stage' | 'durationMilliseconds'
            >
          : Kind extends 'recovery.started'
            ? Omit<
                ObserverEventPayloadMap['recovery.completed'],
                'transactionId' | 'recoveryKind' | 'durationMilliseconds'
              >
            : never;

declare const observationSpanBrand: unique symbol;
export type ObservationSpan<Kind extends StartedKind = StartedKind> = Readonly<{
  [observationSpanBrand]: Kind;
}>;

export interface ObservationEmitter {
  begin<const Kind extends StartedKind>(
    context: OperationContext,
    input: StartedInput<Kind>,
  ): ObservationSpan<Kind> | null;
  complete<const Kind extends StartedKind>(
    span: ObservationSpan<Kind> | null,
    input: CompletionInput<Kind>,
  ): void;
  emit<const Kind extends InstantKind>(context: OperationContext, input: InstantInput<Kind>): void;
}

export type ObservationBundle = Readonly<{
  context: OperationContext;
  emitter: ObservationEmitter;
}>;
