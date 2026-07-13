import {
  type FlipOptions,
  type JournalPhase,
  defaultScanEnv,
  runDev,
  runRollback,
} from '@skillsmith/core';
import { Argument, Command, Option } from 'commander';
import {
  CLI_SELECTION_POLICIES,
  validateCliAdapterSelection,
} from '../../commands/selection-validation.ts';
import {
  failCliError,
  normalizeCliError,
  renderCliError,
  withCliErrorBoundary,
} from '../../output/error-boundary.ts';
import { renderFlipHuman } from '../../output/flip-human.ts';
import { renderFlipJson } from '../../output/flip-json.ts';
import { flipExitCode } from '../../util/flip-exit.ts';
import { validateNonMutatingMode } from '../../util/non-mutating-mode.ts';
import { resolveCommandProjectContext } from '../../util/project-context.ts';

const collectTool = (value: string, prev: string[]): string[] => {
  return [...prev, value];
};

const JOURNAL_PHASES = new Set(['prepared', 'staged', 'backed-up', 'live', 'committed']);
const isJournalPhase = (v: string | undefined): v is JournalPhase =>
  v !== undefined && JOURNAL_PHASES.has(v);

const usageError = (message: string): never =>
  failCliError({ code: 'commander.invalidArgument', message });

interface DevFlags {
  all: boolean;
  tool: string[];
  source?: string;
  dest?: string;
  strict: boolean;
  verify: boolean; // --no-verify sets this false
  rollback: boolean;
  dryRun: boolean;
  json: boolean;
  yes: boolean;
  prompt: boolean;
}

const EXAMPLES = `
ALIASES
  demote

EXAMPLES
  # Back to the live checkout recorded at promote time
  $ skillsmith dev factor-scan

  # Adopt a hand-copied skill into dev mode
  $ skillsmith dev gh-fix-ci --tool codex --source ~/c/gh-fix-ci/skills/gh-fix-ci

  # Whole fleet back to dev for a hack session
  $ skillsmith dev --all

  # Undo the last flip (or recover an interrupted one)
  $ skillsmith dev --rollback factor-scan

EXIT CODES
  0    demoted (or already in dev mode — idempotent no-op)
  1    a flip failed (swap error; state recoverable)
  2    usage error or refusal (no recorded source without --source, unresolved journal, …)
  3    placements ledger unreadable
  4    no placement found for a requested skill/tool
  5    recorded dev source no longer exists on disk
  6    permission error (skills dir or ledger not writable)
  130  cancelled (SIGINT; state recoverable)`;

export const devCommand = (signal?: AbortSignal): Command =>
  withCliErrorBoundary(
    new Command('dev')
      .alias('demote')
      .description('Flip a skill from production (pinned copy) back to dev mode (symlink).')
      .addArgument(new Argument('[skill...]', 'Skill name(s) or placement path(s)'))
      .option('--all', 'Demote every pinned placement with a recorded dev source.', false)
      .addOption(
        new Option('-t, --tool <name>', 'Restrict to tool(s): claude-code | codex. Repeatable.')
          .choices(['claude-code', 'codex', 'kilo-code', 'opencode'])
          .argParser(collectTool)
          .default([] as string[]),
      )
      .option(
        '--source <path>',
        'Dev source: create (absent) or adopt (matching symlink) a placement.',
      )
      .option(
        '--dest <path>',
        'Destination root for a created placement (requires exactly one --tool).',
      )
      .option('--strict', 'Treat verify warnings/inconclusive as blocking on create/adopt.', false)
      .option('--no-verify', 'Skip the static verify gate on create/adopt.')
      .option('--rollback', 'Restore the prior placement state (undo / crash recovery).', false)
      .option('--dry-run', 'Show the plan without changing anything.', false)
      .option('--json', 'Emit the versioned JSON report on stdout.', false)
      .option('--yes', 'Accepted no-op — dev never prompts.', false)
      .addHelpText('after', EXAMPLES)
      .action(async (skills: string[], opts: DevFlags, command: Command) => {
        opts.prompt = (command.optsWithGlobals() as { prompt: boolean }).prompt;
        const selection = validateCliAdapterSelection(
          {
            targets: skills,
            all: opts.all,
            tools: opts.tool,
            capability: opts.rollback ? 'undo' : 'dev',
          },
          CLI_SELECTION_POLICIES.dev,
          opts.json ? 'json' : 'human',
        );
        const mode = validateNonMutatingMode('dev', opts);
        if (!mode.ok) usageError(mode.message);
        if (opts.all && opts.source !== undefined) {
          // PRD D5: create/adopt are inherently targeted; --all gains no create/adopt semantics.
          usageError('--all cannot be combined with --source');
        }
        if (
          opts.rollback &&
          (opts.source !== undefined || opts.dest !== undefined || opts.strict || !opts.verify)
        ) {
          // BF-7(c): rollback restores prior state — it takes none of the create/gate flags, matching
          // promote's flag discipline.
          usageError(
            '--rollback cannot be combined with --source, --dest, --strict, or --no-verify',
          );
        }
        if (opts.source !== undefined && skills.length !== 1) {
          usageError('--source is only valid with exactly one positional target');
        }
        if (opts.dest !== undefined && opts.tool.length !== 1) {
          usageError(`--dest requires exactly one --tool (got ${opts.tool.length})`);
        }

        const env = await defaultScanEnv();
        const context = await resolveCommandProjectContext(command, env);
        if (!context.ok) return failCliError(context.error, opts.json ? 'json' : 'human');
        const testPauseAt =
          process.env.SKILLSMITH_E2E === '1' && isJournalPhase(process.env.SKILLSMITH_TEST_PAUSE_AT)
            ? (process.env.SKILLSMITH_TEST_PAUSE_AT as JournalPhase)
            : undefined;

        const flipOpts: FlipOptions = {
          targets: skills,
          all: opts.all,
          ...(selection.tools.length > 0 ? { tools: selection.tools } : {}),
          ...(opts.source !== undefined ? { source: opts.source } : {}),
          ...(opts.dest !== undefined ? { dest: opts.dest } : {}),
          strict: opts.strict,
          noVerify: !opts.verify,
          dryRun: opts.dryRun,
          cwd: context.value.projectRoot ?? context.value.effectiveCwd,
          envVars: process.env,
          ...(testPauseAt !== undefined ? { testPauseAt } : {}),
          ...(signal ? { signal } : {}),
        };

        const r = opts.rollback
          ? await runRollback(env, { ...flipOpts, op: 'dev' })
          : await runDev(env, flipOpts);

        if (!r.ok) {
          const error = normalizeCliError(r.error);
          const format = opts.json ? 'json' : 'human';
          (opts.json ? process.stdout : process.stderr).write(renderCliError(error, format));
          process.exit(signal?.aborted ? 130 : error.exitCode);
        }

        for (const res of r.value.results) {
          if (res.action === 'refused' || res.action === 'failed') {
            process.stderr.write(
              `error: ${res.skill}${res.tool ? ` (${res.tool})` : ''}: ${res.reason ?? res.action}\n`,
            );
          } else if (res.reason) {
            process.stderr.write(
              `warning: ${res.skill}${res.tool ? ` (${res.tool})` : ''}: ${res.reason}\n`,
            );
          }
        }

        const code = flipExitCode(r.value);
        process.stdout.write(opts.json ? renderFlipJson(r.value) : renderFlipHuman(r.value, code));
        process.exit(signal?.aborted ? 130 : code);
      }),
  );
