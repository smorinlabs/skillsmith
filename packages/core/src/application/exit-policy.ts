import type { CommandExitClass } from './types.ts';

export interface ApplicationExitError {
  readonly code: string;
  readonly exitClass?: CommandExitClass;
}

const EXIT_PRECEDENCE: Readonly<Record<CommandExitClass, number>> = Object.freeze({
  success: 0,
  drift: 0,
  failure: 1,
  usage: 2,
  state: 3,
  capability: 4,
  source: 5,
  permission: 6,
  cancelled: 7,
});

/** Shared numeric exit policy for lifecycle and read-only application services. */
export const exitClassForApplicationError = (
  error: ApplicationExitError,
  signal?: AbortSignal,
): CommandExitClass => {
  if (signal?.aborted || error.code === 'cancelled' || error.code === 'abort') return 'cancelled';
  if (error.exitClass !== undefined) return error.exitClass;
  switch (error.code) {
    case 'permission-denied':
      return 'permission';
    case 'source-unresolvable':
      return 'source';
    case 'placement-not-found':
    case 'tool-unavailable':
    case 'capability':
      return 'capability';
    case 'config-error':
    case 'ledger-error':
    case 'state':
      return 'state';
    case 'invalid-argument':
    case 'invalid-enum':
    case 'unknown-tool':
    case 'usage':
    case 'flip-refused':
      return 'usage';
    default:
      return 'failure';
  }
};

export const selectApplicationExitClass = (
  classes: readonly CommandExitClass[],
): CommandExitClass =>
  classes.reduce<CommandExitClass>(
    (selected, candidate) =>
      EXIT_PRECEDENCE[candidate] > EXIT_PRECEDENCE[selected] ? candidate : selected,
    'success',
  );
