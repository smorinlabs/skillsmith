import {
  type ApplicationContext,
  type CheckRunContext,
  type ClockPort,
  type DetectOptions,
  type IdPort,
  type ListCommandsOpts,
  type ListSkillsOpts,
  type OBSERVATION_EVENT_KINDS,
  type OPERATION_KINDS,
  type ObservationBundle,
  type ObservationEmitter,
  type ObservationSpan,
  type ObservationVerbosity,
  type ObserverEvent,
  type ObserverEventKind,
  type ObserverEventPayloadMap,
  type ObserverPort,
  type OperationContext,
  type VerifyOptions,
  createChildOperationContext,
  createObservationEmitter,
  createObserverEvent,
  createOperationContext,
  nextOperationAttempt,
  noopObserver,
  redactObservationValue,
  withOperationTarget,
} from '@skillsmith/core';
import type { ProgramBuildExtensions } from '../../../../packages/cli/src/program.ts';
import type { RuntimeExecutionRequest } from '../../../../packages/cli/src/runtime/adapter.ts';

type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

type ExpectedEventKind =
  | 'command.started'
  | 'command.completed'
  | 'plan.created'
  | 'operation.started'
  | 'operation.completed'
  | 'tool.detection.started'
  | 'tool.detection.completed'
  | 'tool.verification.started'
  | 'tool.verification.completed'
  | 'transaction.stage.started'
  | 'transaction.stage.completed'
  | 'transaction.committed'
  | 'transaction.rolled-back'
  | 'recovery.started'
  | 'recovery.completed';

type ExpectedOperationKind =
  | 'inventory'
  | 'diagnostics'
  | 'install'
  | 'update'
  | 'remove'
  | 'link-dev'
  | 'promote'
  | 'move-scope'
  | 'adapt'
  | 'repair'
  | 'write-manifest'
  | 'write-lock'
  | 'migrate-project-config'
  | 'migrate-ledger';

type ExpectedPayloadMap = {
  readonly 'command.started': Readonly<Record<never, never>>;
  readonly 'command.completed': Readonly<{
    outcome: 'success' | 'failure' | 'cancelled';
    exitClass:
      | 'success'
      | 'failure'
      | 'usage'
      | 'state'
      | 'capability'
      | 'source'
      | 'permission'
      | 'drift'
      | 'cancelled';
    errorCode: string | null;
    durationMilliseconds: number;
  }>;
  readonly 'plan.created': Readonly<{ planId: string; operationCount: number }>;
  readonly 'operation.started': Readonly<{ operationKind: ExpectedOperationKind }>;
  readonly 'operation.completed': Readonly<{
    operationKind: ExpectedOperationKind;
    outcome: 'success' | 'failure' | 'cancelled' | 'skipped';
    errorCode: string | null;
    standaloneCount: number | null;
    bundledCount: number | null;
    resultCount: number | null;
    durationMilliseconds: number;
  }>;
  readonly 'tool.detection.started': Readonly<{ toolId: string }>;
  readonly 'tool.detection.completed': Readonly<{
    toolId: string;
    outcome: 'success' | 'failure' | 'cancelled' | 'skipped';
    errorCode: string | null;
    resultCount: number;
    durationMilliseconds: number;
  }>;
  readonly 'tool.verification.started': Readonly<{
    toolId: string;
    modes: readonly ('static' | 'deep')[];
  }>;
  readonly 'tool.verification.completed': Readonly<{
    toolId: string;
    modes: readonly ('static' | 'deep')[];
    verdict: 'pass' | 'warn' | 'fail' | 'inconclusive' | 'unavailable' | 'skipped';
    errorCode: string | null;
    durationMilliseconds: number;
  }>;
  readonly 'transaction.stage.started': Readonly<{
    transactionId: string;
    stage: 'prepared' | 'staged' | 'backed-up' | 'live' | 'committed';
  }>;
  readonly 'transaction.stage.completed': Readonly<{
    transactionId: string;
    stage: 'prepared' | 'staged' | 'backed-up' | 'live' | 'committed';
    outcome: 'success' | 'failure' | 'cancelled' | 'skipped';
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
    recoveryKind: 'resume' | 'rollback' | 'cleanup';
  }>;
  readonly 'recovery.completed': Readonly<{
    transactionId: string;
    recoveryKind: 'resume' | 'rollback' | 'cleanup';
    outcome: 'success' | 'failure' | 'cancelled' | 'skipped';
    errorCode: string | null;
    durationMilliseconds: number;
  }>;
};

type ExpectedContext = Readonly<{
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
type ExpectedCommonEvent = Readonly<{
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
type ExpectedObserverEvent = {
  readonly [Kind in ExpectedEventKind]: Readonly<
    ExpectedCommonEvent & { readonly kind: Kind } & ExpectedPayloadMap[Kind]
  >;
}[ExpectedEventKind];
type ExpectedContextInput = {
  command: string;
  workflow: string;
  clock: Pick<ClockPort, 'wallNowIso' | 'monotonicMilliseconds'>;
  id: Pick<IdPort, 'nextId'>;
  operationId?: string;
  parentOperationId?: string | null;
  groupId?: string | null;
  pairId?: string | null;
  attempt?: number;
};

type _EventTupleParity = Assert<Equal<(typeof OBSERVATION_EVENT_KINDS)[number], ExpectedEventKind>>;
type _EventKindParity = Assert<Equal<ObserverEventKind, ExpectedEventKind>>;
type _PayloadClosure = Assert<Equal<ObserverEventPayloadMap, ExpectedPayloadMap>>;
type _OperationTupleParity = Assert<Equal<(typeof OPERATION_KINDS)[number], ExpectedOperationKind>>;
type _Verbosity = Assert<
  Equal<ObservationVerbosity, 'quiet' | 'normal' | 'verbose' | 'trace' | 'debug'>
>;
type _Context = Assert<Equal<OperationContext, ExpectedContext>>;
type _ContextKeys = Assert<
  Equal<
    keyof OperationContext,
    | 'operationId'
    | 'parentOperationId'
    | 'command'
    | 'workflow'
    | 'groupId'
    | 'pairId'
    | 'attempt'
    | 'clock'
    | 'startedAt'
    | 'startedMonotonicMilliseconds'
  >
>;
type _ContextClock = Assert<
  Equal<
    OperationContext['clock'],
    Readonly<Pick<ClockPort, 'wallNowIso' | 'monotonicMilliseconds'>>
  >
>;
type _Bundle = Assert<
  Equal<ObservationBundle, Readonly<{ context: OperationContext; emitter: ObservationEmitter }>>
>;
type _ObserverReturn = Assert<Equal<ReturnType<ObserverPort['observe']>, void | PromiseLike<void>>>;
type _ObserverInput = Assert<Equal<Parameters<ObserverPort['observe']>, [event: ObserverEvent]>>;
type _ObserverKeys = Assert<Equal<keyof ObserverPort, 'observe'>>;
type _EmitterKeys = Assert<Equal<keyof ObservationEmitter, 'begin' | 'complete' | 'emit'>>;
type _EmitReturn = Assert<Equal<ReturnType<ObservationEmitter['emit']>, void>>;
type _CompleteReturn = Assert<Equal<ReturnType<ObservationEmitter['complete']>, void>>;
type _EventClosure = Assert<Equal<ObserverEvent, ExpectedObserverEvent>>;
type _CreateContext = Assert<
  Equal<typeof createOperationContext, (input: ExpectedContextInput) => OperationContext>
>;
type _CreateChildContext = Assert<
  Equal<
    typeof createChildOperationContext,
    (
      parent: OperationContext,
      input: {
        command: string;
        workflow: string;
        id: Pick<IdPort, 'nextId'>;
      },
    ) => OperationContext
  >
>;
type _TargetContext = Assert<
  Equal<
    typeof withOperationTarget,
    (
      context: OperationContext,
      target: { groupId: string | null; pairId: string | null },
    ) => OperationContext
  >
>;
type _NextAttempt = Assert<
  Equal<typeof nextOperationAttempt, (context: OperationContext) => OperationContext>
>;
type _CreateEmitter = Assert<
  Equal<
    typeof createObservationEmitter,
    (input: { observer: ObserverPort; toolIds?: readonly string[] }) => ObservationEmitter
  >
>;
type _ApplicationObservation = Assert<Equal<ApplicationContext['observation'], ObservationBundle>>;
type _DetectObservation = Assert<
  Equal<DetectOptions['observation'], ObservationBundle | undefined>
>;
type _ListSkillsObservation = Assert<
  Equal<ListSkillsOpts['observation'], ObservationBundle | undefined>
>;
type _ListCommandsObservation = Assert<
  Equal<ListCommandsOpts['observation'], ObservationBundle | undefined>
>;
type _DoctorObservation = Assert<
  Equal<CheckRunContext['observation'], ObservationBundle | undefined>
>;
type _VerifyObservation = Assert<
  Equal<VerifyOptions<string>['observation'], ObservationBundle | undefined>
>;
type _RuntimeObservation = Assert<Equal<RuntimeExecutionRequest['observation'], ObservationBundle>>;
type _OperationPorts = Assert<
  Equal<
    ProgramBuildExtensions['operationPorts'],
    | {
        readonly clock: Pick<ClockPort, 'wallNowIso' | 'monotonicMilliseconds'>;
        readonly id: Pick<IdPort, 'nextId'>;
      }
    | undefined
  >
>;

declare const clock: Pick<ClockPort, 'wallNowIso' | 'monotonicMilliseconds'>;
declare const id: Pick<IdPort, 'nextId'>;
declare const context: OperationContext;
declare const observer: ObserverPort;

const fresh: OperationContext = createOperationContext({
  command: 'skillsmith verify',
  workflow: 'verify',
  clock,
  id,
});
const child: OperationContext = createChildOperationContext(fresh, {
  command: 'skillsmith verify',
  workflow: 'verify',
  id,
});
const targeted: OperationContext = withOperationTarget(child, {
  groupId: 'group-1',
  pairId: 'pair-1',
});
const retried: OperationContext = nextOperationAttempt(targeted);

const emitter = createObservationEmitter({ observer, toolIds: ['fixture-tool'] });
const commandSpan: ObservationSpan<'command.started'> | null = emitter.begin(context, {
  kind: 'command.started',
});
emitter.complete(commandSpan, {
  outcome: 'success',
  exitClass: 'success',
  errorCode: null,
});
const verificationSpan: ObservationSpan<'tool.verification.started'> | null = emitter.begin(
  context,
  {
    kind: 'tool.verification.started',
    toolId: 'fixture-tool',
    modes: ['static', 'deep'],
  },
);
emitter.complete(verificationSpan, { verdict: 'pass', errorCode: null });
const operationSpan = emitter.begin(context, {
  kind: 'operation.started',
  operationKind: 'inventory',
});
const transactionSpan = emitter.begin(context, {
  kind: 'transaction.stage.started',
  transactionId: 'transaction-1',
  stage: 'prepared',
});
const recoverySpan = emitter.begin(context, {
  kind: 'recovery.started',
  transactionId: 'transaction-1',
  recoveryKind: 'resume',
});
emitter.emit(context, { kind: 'plan.created', planId: 'plan-1', operationCount: 2 });

const planEvent: ObserverEvent = createObserverEvent(context, {
  kind: 'plan.created',
  planId: 'plan-1',
  operationCount: 2,
});
const redacted: unknown = redactObservationValue({ authorization: 'Bearer secret' });
const noop: ObserverPort = noopObserver;

// @ts-expect-error unknown event kinds are closed
emitter.emit(context, { kind: 'future.created', value: 1 });
// @ts-expect-error payloads reject unknown fields
emitter.emit(context, { kind: 'plan.created', planId: 'plan-1', operationCount: 2, extra: true });
// @ts-expect-error required payload fields cannot be omitted
emitter.emit(context, { kind: 'plan.created', planId: 'plan-1' });
emitter.begin(context, {
  kind: 'tool.verification.started',
  toolId: 'fixture-tool',
  // @ts-expect-error verification modes are closed
  modes: ['dynamic'],
});
// @ts-expect-error completion identity is span-owned
emitter.complete(verificationSpan, { toolId: 'fixture-tool', verdict: 'pass', errorCode: null });
emitter.complete(verificationSpan, {
  verdict: 'pass',
  errorCode: null,
  // @ts-expect-error duration is computed from the span
  durationMilliseconds: 1,
});
// @ts-expect-error verification modes are span-owned
emitter.complete(verificationSpan, { modes: ['static'], verdict: 'pass', errorCode: null });
emitter.complete(transactionSpan, {
  // @ts-expect-error transaction identity and stage are span-owned
  transactionId: 'transaction-1',
  stage: 'prepared',
  outcome: 'success',
  errorCode: null,
});
emitter.complete(recoverySpan, {
  // @ts-expect-error recovery identity is span-owned
  transactionId: 'transaction-1',
  recoveryKind: 'resume',
  outcome: 'success',
  errorCode: null,
});
emitter.complete(operationSpan, {
  // @ts-expect-error operation identity is span-owned
  operationKind: 'inventory',
  outcome: 'success',
  errorCode: null,
  standaloneCount: 1,
  bundledCount: 0,
  resultCount: 1,
});
declare const opaqueCommandSpan: NonNullable<ObservationSpan<'command.started'>>;
// @ts-expect-error observation spans are opaque
opaqueCommandSpan.context;
emitter.emit(context, {
  kind: 'plan.created',
  planId: 'plan-2',
  operationCount: 1,
});
emitter.complete(commandSpan, {
  outcome: 'success',
  exitClass: 'success',
  errorCode: null,
});
// @ts-expect-error emission cannot drive a decision
const emittedDecision: boolean = emitter.emit(context, {
  kind: 'plan.created',
  planId: 'plan-3',
  operationCount: 1,
});
// @ts-expect-error observers cannot return semantic decisions
const decision: boolean = observer.observe(planEvent);
// @ts-expect-error bundles contain no presentation or IO policy
const invalidBundle: ObservationBundle = { context, emitter, verbosity: 'debug' };
// @ts-expect-error factory inputs contain no registry or IO capability bag
createObservationEmitter({ observer, registry: {}, stdout: process.stdout });
// @ts-expect-error events cannot carry raw exceptions or metadata
const unsafeEvent: ObserverEvent = { ...planEvent, stack: 'secret', metadata: {} };

void retried;
void planEvent;
void redacted;
void noop;
void decision;
void invalidBundle;
void emittedDecision;
void unsafeEvent;
