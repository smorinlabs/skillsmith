export type NonMutatingCommand =
  | 'status'
  | 'doctor'
  | 'check'
  | 'install'
  | 'uninstall'
  | 'dev'
  | 'promote'
  | 'init'
  | 'export'
  | 'plan'
  | 'apply'
  | 'sync'
  | 'update'
  | 'undo'
  | 'gc';

export interface NonMutatingModeOptions {
  dryRun?: boolean;
  check?: boolean;
  yes?: boolean;
  /** Commander represents `--no-prompt` as the negated `prompt: false`. */
  prompt?: boolean;
  noPrompt?: boolean;
  json?: boolean;
  force?: boolean;
  strict?: boolean;
  continueOnError?: boolean;
  allowDirty?: boolean;
  exitCode?: boolean;
  reportOnly?: boolean;
  out?: string;
}

interface NonMutatingModePolicy {
  readonly dryRun: boolean;
  readonly check: boolean;
  readonly approval: boolean;
  readonly reportOnly?: boolean;
}

/**
 * One declarative authority for preview/check/approval families. Future command entries reserve
 * policy only; they do not create parser surfaces or pull their implementation phases forward.
 */
export const NON_MUTATING_MODE_POLICIES = {
  status: { dryRun: false, check: true, approval: false },
  doctor: { dryRun: true, check: false, approval: true },
  check: { dryRun: false, check: false, approval: false, reportOnly: true },
  install: { dryRun: true, check: false, approval: true },
  uninstall: { dryRun: true, check: false, approval: true },
  dev: { dryRun: true, check: false, approval: true },
  promote: { dryRun: true, check: false, approval: true },
  init: { dryRun: true, check: false, approval: false },
  export: { dryRun: true, check: false, approval: false },
  plan: { dryRun: false, check: true, approval: false },
  apply: { dryRun: true, check: true, approval: true },
  sync: { dryRun: true, check: false, approval: true },
  update: { dryRun: true, check: true, approval: true },
  undo: { dryRun: true, check: false, approval: true },
  gc: { dryRun: true, check: false, approval: true },
} as const satisfies Record<NonMutatingCommand, NonMutatingModePolicy>;

export type NonMutatingModeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly exitCode: 2; readonly message: string };

const conflict = (left: string, right: string): NonMutatingModeResult => ({
  ok: false,
  exitCode: 2,
  message: `${left} cannot be combined with ${right}`,
});

/** Pure option-policy validation. Callers must invoke this before environment construction or I/O. */
export const validateNonMutatingMode = (
  command: NonMutatingCommand,
  options: Readonly<NonMutatingModeOptions>,
): NonMutatingModeResult => {
  const policy: NonMutatingModePolicy = NON_MUTATING_MODE_POLICIES[command];

  if (options.dryRun && options.check) return conflict('--dry-run', '--check');
  if (options.yes && options.dryRun) return conflict('--yes', '--dry-run');
  if (options.yes && options.check) return conflict('--yes', '--check');
  if (policy.reportOnly && options.reportOnly && options.exitCode)
    return conflict('--report-only', '--exit-code');
  if (command === 'plan' && options.check && options.out !== undefined) {
    return conflict('--check', '--out');
  }
  if (command === 'plan' && options.check && options.force) {
    return conflict('--check', '--force');
  }

  return { ok: true };
};
