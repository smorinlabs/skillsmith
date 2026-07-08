import { isCancel, select } from '@clack/prompts';
import {
  type CandidateSkill,
  type FlipTool,
  type InstallDeps,
  type InstallOptions,
  type InstallScope,
  type JournalPhase,
  defaultInstallDeps,
  defaultScanEnv,
  runInstall,
} from '@skillsmith/core';
import { Argument, Command, InvalidArgumentError, Option } from 'commander';
import { renderInstallHuman } from '../output/install-human.ts';
import { renderInstallJson } from '../output/install-json.ts';
import { acquireExitCode } from '../util/acquire-exit.ts';
import { exitCodeForError } from '../util/exit-codes.ts';
import { resolveScopeFlags } from '../util/scope-resolver.ts';

const collectTool = (value: string, prev: string[]): string[] => {
  if (value !== 'claude-code' && value !== 'codex')
    throw new InvalidArgumentError(`--tool must be one of claude-code, codex (got '${value}')`);
  return [...prev, value];
};

// `program.exitOverride()` (program.ts) is not inherited by commands attached via `addCommand`
// (only `.command()`-created subcommands copy parent settings) — mirror promote.ts's/dev.ts's
// local mapping.
const USAGE_ERROR_CODES = new Set([
  'commander.invalidArgument',
  'commander.missingArgument',
  'commander.unknownOption',
  'commander.excessArguments',
  'commander.missingMandatoryOptionValue',
]);

const JOURNAL_PHASES = new Set(['prepared', 'staged', 'backed-up', 'live', 'committed']);
const isJournalPhase = (v: string | undefined): v is JournalPhase =>
  v !== undefined && JOURNAL_PHASES.has(v);

const usageError = (message: string): never => {
  process.stderr.write(`error: ${message}\n`);
  process.exit(2);
};

interface InstallFlags {
  tool: string[];
  scope?: 'user' | 'project';
  user: boolean;
  project: boolean;
  ref?: string;
  pin: boolean;
  direct: boolean;
  force: boolean;
  strict: boolean;
  verify: boolean; // --no-verify sets this false
  deep: boolean;
  continueOnError: boolean;
  dryRun: boolean;
  json: boolean;
  yes: boolean;
  prompt: boolean; // --no-prompt sets this false
}

export interface TtyState {
  stderr: boolean;
  stdin: boolean;
}

/** D4: the picker is wired ONLY when both stderr and stdin are TTYs and neither `--json` nor
 *  `--no-prompt` is set. `--yes` has no input here at all — the ambiguity picker is a choice,
 *  not a confirmation, and must never auto-pick. */
export const shouldEnablePicker = (
  opts: { json: boolean; noPrompt: boolean },
  tty: TtyState,
): boolean => tty.stderr && tty.stdin && !opts.json && !opts.noPrompt;

const currentTty = (): TtyState => ({
  stderr: Boolean(process.stderr.isTTY),
  stdin: Boolean(process.stdin.isTTY),
});

/** Build the `InstallDeps` the CLI hands to `runInstall`: the core defaults, plus an
 *  `@clack/prompts`-backed `pick` callback wired in only when `shouldEnablePicker` gates true.
 *  Core stays non-interactive (no `@clack/prompts` import anywhere under packages/core/src) —
 *  the CLI is the only place a picker can be constructed. */
export const buildInstallDeps = (
  opts: { json: boolean; noPrompt: boolean },
  tty: TtyState = currentTty(),
): InstallDeps => {
  const deps: InstallDeps = { ...defaultInstallDeps };
  if (shouldEnablePicker(opts, tty)) {
    deps.pick = async (candidates: readonly CandidateSkill[]): Promise<CandidateSkill | null> => {
      const result = await select({
        message: `${candidates.length} skills found — which one?`,
        options: candidates.map((c) => ({ value: c, label: c.name, hint: `//${c.path}` })),
      });
      if (isCancel(result)) return null;
      return result as CandidateSkill;
    };
  }
  return deps;
};

const EXAMPLES = `
ALIASES
  i

EXAMPLES
  # Rebuild part of the fleet on a new machine (user scope, both detected tools)
  $ skillsmith install smorinlabs/smorinlabs-harness/factor-scan --user

  # Team repo: project-scoped, ref-pinned — resolves identically for every teammate
  $ skillsmith install acme/agent-tools/review@v1.2.0 --project --pin

  # Explicit path into a GitLab subgroup repo, claude-code only
  $ skillsmith install gitlab.com/acme/platform/tools//skills/review -t claude-code

  # Deliberate upgrade or downgrade (store entries are write-once; reverting is
  # another --force --ref away)
  $ skillsmith install smorinlabs/smorinlabs-harness/factor-scan --force --ref v2.0.0

EXIT CODES
  0    installed (or already at the resolved rev — idempotent no-op)
  1    verify gate failed, snapshot/swap error (state recoverable)
  2    usage error or refusal (grammar rejection, ambiguity in non-TTY,
       cross-scope shadowing without --force, ...)
  3    placements ledger unreadable
  4    target tool not detected (explicit --tool), or no tool detected at all
  5    source unresolvable (network, repo/ref not found, skill name not in repo)
  6    permission error (skills dir, store, or ledger not writable)
  130  cancelled (SIGINT; state recoverable)`;

export const installCommand = (signal?: AbortSignal): Command =>
  new Command('install')
    .alias('i')
    .description('Install agent skills from a git host.')
    .addArgument(
      new Argument(
        '<source...>',
        'owner/repo[/<name>], owner/repo//path, <host>/owner/repo[/<name>], or a git URL. Append @<ref>.',
      ),
    )
    .addOption(
      new Option(
        '-t, --tool <name>',
        'Target tool: claude-code | codex. Repeatable. Default: all detected.',
      )
        .choices(['claude-code', 'codex'])
        .argParser(collectTool)
        .default([] as string[]),
    )
    .addOption(
      new Option(
        '-s, --scope <scope>',
        'user | project. Default: project in a git repo, else user. (system deferred)',
      ).choices(['user', 'project']),
    )
    .option('--user', 'Shorthand for --scope=user', false)
    .option('--project', 'Shorthand for --scope=project', false)
    .option('--ref <git-ref>', 'Tag, branch, or full SHA (default: HEAD). Single source only.')
    .option('--pin', 'Freeze the resolved commit SHA in the ledger', false)
    .option('--direct', 'Copy files instead of symlinking from the store', false)
    .option('-f, --force', 'Reinstall / replace / override cross-scope shadowing', false)
    .option('--strict', 'Verify warnings block installation', false)
    .option('--no-verify', 'Skip the verify gate (recorded in the ledger)')
    .option('--deep', 'Run codex static+deep before placement (conflicts with --no-verify)', false)
    .option('--continue-on-error', 'Keep going after per-source failures', false)
    .option('--dry-run', 'Print the resolved plan without changing anything', false)
    .option('--json', 'Emit the versioned JSON report on stdout', false)
    .option('-y, --yes', 'Accepted no-op — the picker is a choice, not a confirmation.', false)
    .option('--no-prompt', 'Force non-TTY behavior: ambiguity lists candidates and exits 2.')
    .exitOverride((err) => {
      if (USAGE_ERROR_CODES.has(err.code)) process.exit(2);
      if (err.code === 'commander.helpDisplayed') process.exit(0);
      process.exit(err.exitCode ?? 1);
    })
    .addHelpText('after', EXAMPLES)
    .action(async (sources: string[], opts: InstallFlags) => {
      if (opts.deep && !opts.verify) {
        usageError(
          '--deep and --no-verify contradict each other: --deep opts into a deeper verify gate, --no-verify skips the gate entirely',
        );
      }
      const scopeR = resolveScopeFlags({
        ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
        user: opts.user,
        project: opts.project,
      });
      if (!scopeR.ok) usageError(scopeR.error.message);
      const scope = (scopeR.ok ? scopeR.value : null) as InstallScope | null;

      const env = await defaultScanEnv();
      const testPauseAt =
        process.env.SKILLSMITH_E2E === '1' && isJournalPhase(process.env.SKILLSMITH_TEST_PAUSE_AT)
          ? (process.env.SKILLSMITH_TEST_PAUSE_AT as JournalPhase)
          : undefined;

      const noPrompt = !opts.prompt;
      const deps = buildInstallDeps({ json: opts.json, noPrompt });

      const installOpts: InstallOptions = {
        sources,
        ...(opts.tool.length > 0 ? { tools: opts.tool as FlipTool[] } : {}),
        ...(scope !== null ? { scope } : {}),
        ...(opts.ref !== undefined ? { ref: opts.ref } : {}),
        pin: opts.pin,
        direct: opts.direct,
        force: opts.force,
        strict: opts.strict,
        noVerify: !opts.verify,
        deep: opts.deep,
        continueOnError: opts.continueOnError,
        dryRun: opts.dryRun,
        cwd: process.cwd(),
        envVars: process.env,
        ...(testPauseAt !== undefined ? { testPauseAt } : {}),
        ...(signal ? { signal } : {}),
      };

      const r = await runInstall(env, installOpts, deps);
      if (!r.ok) {
        process.stderr.write(`error: ${'message' in r.error ? r.error.message : r.error.code}\n`);
        process.exit(signal?.aborted ? 130 : exitCodeForError(r.error));
      }

      for (const res of r.value.results) {
        const label = res.skill ? `${res.skill}${res.tool ? ` (${res.tool})` : ''}` : res.source;
        if (res.action === 'refused' || res.action === 'failed') {
          process.stderr.write(`error: ${label}: ${res.reason ?? res.action}\n`);
          if (res.candidates && res.candidates.length > 0) {
            process.stderr.write('\n');
            for (const c of res.candidates) process.stderr.write(`  ${c}\n`);
            process.stderr.write('\nRe-run with one of the exact paths above.\n');
          }
        } else if (res.action !== 'noop' && res.reason) {
          process.stderr.write(`warning: ${label}: ${res.reason}\n`);
        }
      }

      const code = acquireExitCode(r.value);
      process.stdout.write(
        opts.json ? renderInstallJson(r.value) : renderInstallHuman(r.value, code),
      );
      process.exit(signal?.aborted ? 130 : code);
    });
