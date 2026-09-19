export const EXECUTABLE_OPERATION_KINDS = Object.freeze([
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

export type ExecutableOperationKind = (typeof EXECUTABLE_OPERATION_KINDS)[number];

export const PLANNING_DIAGNOSTIC_KINDS = Object.freeze([
  'noop',
  'skip',
  'refuse',
  'conflict',
  'warning',
] as const);

export type PlanningDiagnosticKind = (typeof PLANNING_DIAGNOSTIC_KINDS)[number];

export const OPERATION_EXECUTION_OUTCOMES = Object.freeze([
  'succeeded',
  'failed',
  'cancelled',
  'rolled-back',
  'skipped-after-failure',
] as const);

export type OperationExecutionOutcome = (typeof OPERATION_EXECUTION_OUTCOMES)[number];

export const OPERATION_SELECTION_SOURCES = Object.freeze([
  'explicit-targets',
  'explicit-all',
  'bounded-default',
] as const);

export type OperationSelectionSource = (typeof OPERATION_SELECTION_SOURCES)[number];
