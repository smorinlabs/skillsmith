import {
  type InstallScope,
  type JournalPhase,
  type UninstallOptions,
  defaultScanEnv,
  defaultUninstallDeps,
  runUninstall,
} from '@skillsmith/core';
import { Argument, Command, Option } from 'commander';
import {
  failCliError,
  normalizeCliError,
  renderCliError,
  withCliErrorBoundary,
} from '../output/error-boundary.ts';
import { renderUninstallHuman } from '../output/install-human.ts';
import { renderUninstallJson } from '../output/install-json.ts';
import { acquireExitCode } from '../util/acquire-exit.ts';
import { validateNonMutatingMode } from '../util/non-mutating-mode.ts';
import { resolveCommandProjectContext } from '../util/project-context.ts';
import { resolveScopeFlags } from '../util/scope-resolver.ts';
import { CLI_SELECTION_POLICIES, validateCliAdapterSelection } from './selection-validation.ts';

const collectTool = (value: string, prev: string[]): string[] => {
  return [...prev, value];
};

const JOURNAL_PHASES = new Set(['prepared', 'staged', 'backed-up', 'live', 'committed']);
const isJournalPhase = (v: string | undefined): v is JournalPhase =>
  v !== undefined && JOURNAL_PHASES.has(v);

const usageError = (message: string): never =>
  failCliError({ code: 'commander.invalidArgument', message });

interface UninstallFlags {
  tool: string[];
  scope?: string;
  user: boolean;
  project: boolean;
  allScopes: boolean;
  force: boolean;
  dryRun: boolean;
  json: boolean;
  yes: boolean;
  prompt: boolean; // --no-prompt sets this false; accepted no-op — uninstall never prompts
}

const EXAMPLES = `
ALIASES
  rm, remove

EXAMPLES
  # Remove a skill everywhere it is placed for both tools
  $ skillsmith uninstall factor-scan

  # Remove only the project-scope copy
  $ skillsmith uninstall review --project

  # Remove from every scope, codex only
  $ skillsmith rm review --all-scopes --tool codex

  # Preview
  $ skillsmith uninstall factor-scan --dry-run

EXIT CODES
  0    removed (or not installed anywhere — idempotent no-op)
  1    removal failed mid-flight (state recoverable)
  2    refusal: ambiguous across scopes, dev-mode placement without --force,
       unmanaged placement without --force, unresolved journal
  3    placements ledger unreadable
  6    permission error (skills dir or ledger not writable)
  130  cancelled (SIGINT; state recoverable)`;

export const uninstallCommand = (signal?: AbortSignal): Command =>
  withCliErrorBoundary(
    new Command('uninstall')
      .aliases(['rm', 'remove'])
      .description(
        'Remove installed skills (placements + ledger records; the store is never deleted).',
      )
      .addArgument(
        new Argument(
          '<skill...>',
          'Installed skill name(s) (leaf dir name) or placement path(s). Ambiguous across scopes → disambiguate with --scope, --tool, or --all-scopes.',
        ),
      )
      .addOption(
        new Option(
          '-t, --tool <name>',
          'claude-code | codex. Repeatable. Default: every tool where the skill is found.',
        )
          .choices(['claude-code', 'codex', 'kilo-code', 'opencode'])
          .argParser(collectTool)
          .default([] as string[]),
      )
      .addOption(
        new Option(
          '-s, --scope <scope>',
          'user | project. Required when the name is ambiguous. (system deferred)',
        ).choices(['system', 'user', 'project', 'managed']),
      )
      .option('--user', 'Shorthand for --scope=user', false)
      .option('--project', 'Shorthand for --scope=project', false)
      .option('--all-scopes', 'Remove from user scope and the current project', false)
      .option('-f, --force', 'Remove dev-mode or unmanaged placements too', false)
      .option('--dry-run', 'Print removals without executing', false)
      .option('--json', 'Emit the versioned JSON report on stdout', false)
      .option('-y, --yes', 'Accepted no-op — uninstall never prompts.', false)
      .option('--no-prompt', 'Accepted no-op — uninstall never prompts.')
      .addHelpText('after', EXAMPLES)
      .action(async (targets: string[], opts: UninstallFlags, command: Command) => {
        const selection = validateCliAdapterSelection(
          {
            targets,
            all: false,
            tools: opts.tool,
            ...(opts.scope === undefined ? {} : { scopes: [opts.scope] }),
            capability: 'uninstall',
          },
          CLI_SELECTION_POLICIES.uninstall,
          opts.json ? 'json' : 'human',
        );
        const mode = validateNonMutatingMode('uninstall', opts);
        if (!mode.ok) usageError(mode.message);
        if (opts.allScopes && opts.scope !== undefined) {
          usageError('--all-scopes cannot be combined with --scope');
        }
        const scopeR = resolveScopeFlags({
          ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
          user: opts.user,
          project: opts.project,
        });
        if (!scopeR.ok) usageError(scopeR.error.message);
        const resolvedScope = scopeR.ok ? scopeR.value : null;
        if (resolvedScope === 'system' || resolvedScope === 'managed') {
          return failCliError(
            {
              code: 'capability',
              message: `scope '${resolvedScope}' is unsupported for uninstall`,
            },
            opts.json ? 'json' : 'human',
            { exitCode: 4 },
          );
        }
        const scope: InstallScope | null = resolvedScope;
        if (opts.allScopes && scope !== null) {
          usageError('--all-scopes cannot be combined with --user/--project');
        }

        const env = await defaultScanEnv();
        const context = await resolveCommandProjectContext(command, env);
        if (!context.ok) return failCliError(context.error, opts.json ? 'json' : 'human');
        const testPauseAt =
          process.env.SKILLSMITH_E2E === '1' && isJournalPhase(process.env.SKILLSMITH_TEST_PAUSE_AT)
            ? (process.env.SKILLSMITH_TEST_PAUSE_AT as JournalPhase)
            : undefined;

        const uninstallOpts: UninstallOptions = {
          targets,
          ...(selection.tools.length > 0 ? { tools: selection.tools } : {}),
          ...(scope !== null ? { scope } : {}),
          allScopes: opts.allScopes,
          force: opts.force,
          dryRun: opts.dryRun,
          cwd: context.value.projectRoot ?? context.value.effectiveCwd,
          envVars: process.env,
          ...(testPauseAt !== undefined ? { testPauseAt } : {}),
          ...(signal ? { signal } : {}),
        };

        const r = await runUninstall(env, uninstallOpts, { ...defaultUninstallDeps });
        if (!r.ok) {
          const error = normalizeCliError(r.error);
          const format = opts.json ? 'json' : 'human';
          (opts.json ? process.stdout : process.stderr).write(renderCliError(error, format));
          process.exit(signal?.aborted ? 130 : error.exitCode);
        }

        for (const res of r.value.results) {
          const label = `${res.skill}${res.tool ? ` (${res.tool})` : ''}`;
          if (res.action === 'refused' || res.action === 'failed') {
            process.stderr.write(`error: ${label}: ${res.reason ?? res.action}\n`);
          } else if (res.action !== 'noop' && res.reason) {
            process.stderr.write(`warning: ${label}: ${res.reason}\n`);
          }
        }

        const code = acquireExitCode(r.value);
        process.stdout.write(
          opts.json ? renderUninstallJson(r.value) : renderUninstallHuman(r.value, code),
        );
        process.exit(signal?.aborted ? 130 : code);
      }),
  );
