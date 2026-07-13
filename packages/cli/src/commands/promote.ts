import {
  type FlipOptions,
  type JournalPhase,
  defaultScanEnv,
  runPromote,
  runRollback,
} from '@skillsmith/core';
import { Argument, Command, Option } from 'commander';
import {
  failCliError,
  normalizeCliError,
  renderCliError,
  withCliErrorBoundary,
} from '../output/error-boundary.ts';
import { renderFlipHuman } from '../output/flip-human.ts';
import { renderFlipJson } from '../output/flip-json.ts';
import { flipExitCode } from '../util/flip-exit.ts';
import { validateNonMutatingMode } from '../util/non-mutating-mode.ts';
import { resolveCommandProjectContext } from '../util/project-context.ts';
import { CLI_SELECTION_POLICIES, validateCliAdapterSelection } from './selection-validation.ts';

const collectTool = (value: string, prev: string[]): string[] => {
  return [...prev, value];
};

const JOURNAL_PHASES = new Set(['prepared', 'staged', 'backed-up', 'live', 'committed']);
const isJournalPhase = (v: string | undefined): v is JournalPhase =>
  v !== undefined && JOURNAL_PHASES.has(v);

const usageError = (message: string): never =>
  failCliError({ code: 'commander.invalidArgument', message });

interface PromoteFlags {
  all: boolean;
  tool: string[];
  strict: boolean;
  verify: boolean; // --no-verify sets this false
  allowDirty: boolean;
  rollback: boolean;
  dryRun: boolean;
  json: boolean;
  yes: boolean;
  prompt: boolean;
}

const EXAMPLES = `
EXAMPLES
  # Pin one skill for both tools it is placed in
  $ skillsmith promote factor-scan

  # Pin the whole fleet, previewing first
  $ skillsmith promote --all --dry-run
  $ skillsmith promote --all

  # Claude only, treat verify warnings as blocking
  $ skillsmith promote factor-scan --tool claude-code --strict

  # Recover after an interrupted swap
  $ skillsmith promote --rollback factor-scan

EXIT CODES
  0    promoted (or already pinned — idempotent no-op)
  1    a flip failed (verify gate failed, snapshot/swap error; state recoverable)
  2    usage error or refusal (dirty tree without --allow-dirty, unresolved journal, …)
  3    placements ledger unreadable
  4    no placement found for a requested skill/tool
  5    dev source unresolvable (dangling symlink)
  6    permission error (skills dir, store, or ledger not writable)
  130  cancelled (SIGINT; state recoverable)`;

export const promoteCommand = (signal?: AbortSignal): Command =>
  withCliErrorBoundary(
    new Command('promote')
      .description('Promote a skill from dev mode (symlink) to production (pinned copy).')
      .addArgument(new Argument('[skill...]', 'Skill name(s) or placement path(s)'))
      .option('--all', 'Promote every dev-mode placement in the selected tools.', false)
      .addOption(
        new Option('-t, --tool <name>', 'Restrict to tool(s): claude-code | codex. Repeatable.')
          .choices(['claude-code', 'codex', 'kilo-code', 'opencode'])
          .argParser(collectTool)
          .default([] as string[]),
      )
      .option('--strict', 'Verify-gate warnings block promotion.', false)
      .option('--no-verify', 'Skip the verify gate (recorded as unverified).')
      .option('--allow-dirty', 'Allow snapshotting a dirty git tree (rev: dirty-<hash>).', false)
      .option('--rollback', 'Restore the prior placement state (undo / crash recovery).', false)
      .option('--dry-run', 'Show the plan without changing anything.', false)
      .option('--json', 'Emit the versioned JSON report on stdout.', false)
      .option('--yes', 'Accepted no-op — promote never prompts.', false)
      .addHelpText('after', EXAMPLES)
      .action(async (skills: string[], opts: PromoteFlags, command: Command) => {
        opts.prompt = (command.optsWithGlobals() as { prompt: boolean }).prompt;
        const selection = validateCliAdapterSelection(
          {
            targets: skills,
            all: opts.all,
            tools: opts.tool,
            capability: opts.rollback ? 'undo' : 'promote',
          },
          CLI_SELECTION_POLICIES.promote,
          opts.json ? 'json' : 'human',
        );
        const mode = validateNonMutatingMode('promote', opts);
        if (!mode.ok) usageError(mode.message);
        if (opts.rollback && (opts.strict || !opts.verify || opts.allowDirty)) {
          usageError('--rollback cannot be combined with --strict, --no-verify, or --allow-dirty');
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
          strict: opts.strict,
          noVerify: !opts.verify,
          allowDirty: opts.allowDirty,
          dryRun: opts.dryRun,
          cwd: context.value.projectRoot ?? context.value.effectiveCwd,
          envVars: process.env,
          ...(testPauseAt !== undefined ? { testPauseAt } : {}),
          ...(signal ? { signal } : {}),
        };

        const r = opts.rollback
          ? await runRollback(env, { ...flipOpts, op: 'promote' })
          : await runPromote(env, flipOpts);

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
