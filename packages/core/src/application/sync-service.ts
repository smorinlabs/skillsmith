import { type SyncReportV1Dto, syncV1Codec } from '../contracts/v1/sync.ts';
import type { SkillSmithError } from '../errors.ts';
import type {
  ApplicationService,
  CommandExitClass,
  CommandOutcome,
  CurrentCommandRequest,
  Diagnostic,
  MutationSummary,
  SyncApplicationRequest,
} from './types.ts';
import { NO_MUTATION } from './types.ts';

/** Renderer-facing sync boundary; pre-domain usage/capability failures carry no wire report. */
export interface SyncApplicationReport {
  readonly result: SyncReportV1Dto | null;
}

const EMPTY_REPORT: SyncApplicationReport = Object.freeze({ result: null });

const failure = (
  exitClass: CommandExitClass,
  code: string,
  message: string,
  result: SyncReportV1Dto | null = null,
): CommandOutcome<SyncApplicationReport> => ({
  report: result === null ? EMPTY_REPORT : { result },
  diagnostics: [{ code, severity: 'error', message }],
  exitClass,
  mutation: NO_MUTATION,
  deprecations: [],
});

const errorExitClass = (error: SkillSmithError): CommandExitClass => {
  if (error.code === 'cancelled') return 'cancelled';
  if (error.code === 'invalid-argument') return 'usage';
  if (error.code === 'unknown-tool' || error.code === 'tool-unavailable') return 'capability';
  if (error.code === 'permission-denied') return 'permission';
  if (
    error.code === 'config-error' ||
    error.code === 'ledger-error' ||
    error.code === 'placement-not-found' ||
    error.code === 'flip-refused'
  )
    return 'state';
  return 'failure';
};

const errorText = (error: SkillSmithError): string =>
  error.code === 'unknown-tool' ? `unknown tool: ${error.tool}` : error.message;

const strings = (value: unknown): readonly string[] | null => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0))
    return null;
  return value;
};

const positionalSkills = (arguments_: readonly unknown[]): readonly string[] | null => {
  if (arguments_.length === 0) return [];
  if (arguments_.length === 1 && Array.isArray(arguments_[0])) return strings(arguments_[0]);
  return strings(arguments_);
};

const boolean = (options: Readonly<Record<string, unknown>>, key: string): boolean | null => {
  const value = options[key];
  return value === undefined ? false : typeof value === 'boolean' ? value : null;
};

const scalar = (
  options: Readonly<Record<string, unknown>>,
  key: string,
): string | null | undefined => {
  const value = options[key];
  return value === undefined
    ? null
    : typeof value === 'string' && value.length > 0
      ? value
      : undefined;
};

const normalize = (
  request: CurrentCommandRequest,
):
  | { readonly ok: true; readonly value: SyncApplicationRequest }
  | { readonly ok: false; readonly message: string } => {
  const from = scalar(request.options, 'from');
  const to = scalar(request.options, 'to');
  if (from === null) return { ok: false, message: '--from is required' };
  if (from === undefined) return { ok: false, message: '--from requires one non-empty value' };
  if (to === null) return { ok: false, message: '--to is required' };
  if (to === undefined) return { ok: false, message: '--to requires one non-empty value' };
  const skills = positionalSkills(request.arguments);
  if (skills === null)
    return { ok: false, message: 'sync skill targets must be non-empty strings' };
  const tools = strings(request.options.tool);
  if (tools === null) return { ok: false, message: '--tool must be a list of non-empty values' };
  const file = scalar(request.options, 'file');
  const lockfile = scalar(request.options, 'lockfile');
  if (file === undefined) return { ok: false, message: '--file requires one non-empty value' };
  if (lockfile === undefined)
    return { ok: false, message: '--lockfile requires one non-empty value' };
  const flags = ['force', 'delete', 'save', 'dryRun', 'yes', 'continueOnError'] as const;
  const values = Object.fromEntries(
    flags.map((key) => [key, boolean(request.options, key)]),
  ) as Record<(typeof flags)[number], boolean | null>;
  const invalid = flags.find((key) => values[key] === null);
  if (invalid !== undefined)
    return {
      ok: false,
      message: `--${invalid.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} must be boolean`,
    };
  if (values.yes && values.dryRun)
    return { ok: false, message: '--yes cannot be combined with --dry-run' };
  if (file !== null && !values.save) return { ok: false, message: '--file requires --save' };
  if (lockfile !== null && (file === null || !values.save))
    return { ok: false, message: '--lockfile requires --file and --save' };
  return {
    ok: true,
    value: {
      from,
      to,
      skills,
      tools,
      force: values.force as boolean,
      delete: values.delete as boolean,
      save: values.save as boolean,
      file,
      lockfile,
      dryRun: values.dryRun as boolean,
      yes: values.yes as boolean,
      continueOnError: values.continueOnError as boolean,
    },
  };
};

const reportExitClass = (report: SyncReportV1Dto): CommandExitClass => {
  const pairs = report.groups.flatMap(({ pairs }) => pairs);
  if (
    report.approval.outcome === 'cancelled' ||
    pairs.some(({ outcome }) => outcome === 'cancelled')
  )
    return 'cancelled';
  if (report.state === 'partial' || pairs.some(({ outcome }) => outcome === 'failed'))
    return 'failure';
  const classes = report.diagnostics
    .map(({ refusalClass }) => refusalClass)
    .filter((value): value is NonNullable<typeof value> => value !== null);
  if (report.state === 'refused') {
    if (classes.includes('permission')) return 'permission';
    if (classes.includes('capability')) return 'capability';
    if (classes.includes('state')) return 'state';
    if (classes.includes('usage')) return 'usage';
    return 'failure';
  }
  return 'success';
};

const mutationFor = (report: SyncReportV1Dto): MutationSummary => {
  const planned = report.operations.length;
  const pairs = report.groups.flatMap(({ pairs }) => pairs);
  const changed = pairs.filter(({ outcome }) => outcome === 'succeeded').length;
  const failed = pairs.filter(({ outcome }) => outcome === 'failed').length;
  const unchanged = report.summary.unchanged;
  if (planned === 0 && changed === 0 && failed === 0) return NO_MUTATION;
  return {
    kind: report.mode === 'dry-run' || report.state === 'ready' ? 'preview' : 'applied',
    planned,
    changed,
    unchanged,
    failed,
  };
};

const success = (report: SyncReportV1Dto): CommandOutcome<SyncApplicationReport> => ({
  report: { result: report },
  diagnostics: [],
  exitClass: reportExitClass(report),
  mutation: mutationFor(report),
  deprecations: [],
});

const validatedReport = (
  report: SyncReportV1Dto,
):
  | { readonly ok: true; readonly value: SyncReportV1Dto }
  | { readonly ok: false; readonly diagnostic: Diagnostic } => {
  const validated = syncV1Codec.validate(report);
  return validated.ok
    ? validated
    : {
        ok: false,
        diagnostic: {
          code: 'invalid-sync-report',
          severity: 'error',
          message: `sync adapter returned an invalid report: ${validated.error.message}`,
        },
      };
};

const approvalReport = (
  report: SyncReportV1Dto,
  outcome: 'refused' | 'cancelled',
): SyncReportV1Dto => ({ ...report, state: 'refused', approval: { required: true, outcome } });

const requestMatchesReport = (request: SyncApplicationRequest, report: SyncReportV1Dto): boolean =>
  report.mode === (request.dryRun ? 'dry-run' : 'execute') &&
  report.endpoints.from.selectedInput === request.from &&
  report.endpoints.to.selectedInput === request.to &&
  report.options.force === request.force &&
  report.options.delete === request.delete &&
  report.options.save === request.save &&
  report.options.dryRun === request.dryRun &&
  report.options.continueOnError === request.continueOnError;

const preparedApprovalReport = (report: SyncReportV1Dto): SyncReportV1Dto => {
  const pairs = report.groups.flatMap(({ pairs }) => pairs);
  const required =
    report.mode === 'execute' &&
    report.state !== 'refused' &&
    report.summary.changed > 0 &&
    (report.groups.length > 1 ||
      pairs.some(({ action }) => action === 'remove') ||
      pairs.some(({ force }) => force.used));
  return {
    ...report,
    approval: required
      ? { required: true, outcome: 'pending' }
      : { required: false, outcome: 'not-required' },
  };
};

const executedApprovalReport = (report: SyncReportV1Dto, required: boolean): SyncReportV1Dto => ({
  ...report,
  approval: required
    ? { required: true, outcome: 'approved' }
    : { required: false, outcome: 'not-required' },
});

export const runSyncApplication: ApplicationService<
  CurrentCommandRequest,
  SyncApplicationReport
> = async (request, context) => {
  const normalized = normalize(request);
  if (!normalized.ok) return failure('usage', 'invalid-sync-usage', normalized.message);
  if (context.sync === undefined) {
    return failure('capability', 'sync-adapter-unavailable', 'sync capability is unavailable');
  }
  const preparedResult = await context.sync.prepare(normalized.value, context);
  if (!preparedResult.ok) {
    return failure(
      errorExitClass(preparedResult.error),
      preparedResult.error.code,
      errorText(preparedResult.error),
    );
  }
  if (!requestMatchesReport(normalized.value, preparedResult.value.report)) {
    return failure(
      'failure',
      'invalid-sync-report',
      'sync adapter preparation does not match the normalized request',
    );
  }
  const preparedReport = validatedReport(preparedApprovalReport(preparedResult.value.report));
  if (!preparedReport.ok)
    return failure('failure', preparedReport.diagnostic.code, preparedReport.diagnostic.message);
  if (normalized.value.dryRun || preparedReport.value.state === 'refused')
    return success(preparedReport.value);

  if (preparedReport.value.approval.required) {
    const approval = await context.interaction.confirm({
      id: 'sync.exact-plan',
      message: 'Execute this exact sync plan?',
      preview: {
        kind: 'exact-sync-preview',
        command: 'sync',
        groupIds: preparedReport.value.selection.groupIds,
        operationIds: preparedReport.value.operations.map(({ operationId }) => operationId),
      },
    });
    if (approval.status === 'cancelled') {
      return failure(
        'cancelled',
        'sync-cancelled',
        'sync was cancelled',
        approvalReport(preparedReport.value, 'cancelled'),
      );
    }
    if (approval.status === 'refused' || approval.value !== true) {
      return failure(
        'usage',
        'sync-approval-required',
        approval.status === 'refused' ? approval.reason : 'sync approval was refused',
        approvalReport(preparedReport.value, 'refused'),
      );
    }
  }

  const approvalRequired = preparedReport.value.approval.required;
  const executed = await context.sync.execute(preparedResult.value, context);
  if (!executed.ok)
    return failure(errorExitClass(executed.error), executed.error.code, errorText(executed.error));
  if (!requestMatchesReport(normalized.value, executed.value)) {
    return failure(
      'failure',
      'invalid-sync-report',
      'sync adapter execution does not match the normalized request',
    );
  }
  const report = validatedReport(executedApprovalReport(executed.value, approvalRequired));
  return report.ok
    ? success(report.value)
    : failure('failure', report.diagnostic.code, report.diagnostic.message);
};
