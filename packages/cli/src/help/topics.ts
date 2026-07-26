import { type Result, err, ok } from '@skillsmith/core';
import { CURRENT_COMMAND_SPECS } from '../spec/registry.ts';
import { COMMAND_GROUP_HEADINGS } from './render.ts';

export const HELP_TOPIC_NAMES = [
  'workflows',
  'manifest',
  'lock',
  'plan',
  'source',
  'environment',
  'scope',
  'exit-codes',
  'formatting',
] as const;

export type HelpTopic = (typeof HELP_TOPIC_NAMES)[number];

export const HELP_TOPIC_ALIASES = {
  sources: 'source',
  scopes: 'scope',
} as const satisfies Readonly<Record<string, HelpTopic>>;

export const HELP_TOPIC_LOOKUP_NAMES = [
  ...HELP_TOPIC_NAMES,
  ...Object.keys(HELP_TOPIC_ALIASES),
] as const;

const WORKFLOW_TOPIC = (): string => {
  const publicSpecs = CURRENT_COMMAND_SPECS.filter(
    (spec) => spec.path.split(' ').length === 2,
  ).toSorted((left, right) => left.helpOrder - right.helpOrder);
  const groups = ['discover', 'manage', 'develop', 'declarative', 'maintain'] as const;
  return [
    'Common command workflows',
    '',
    ...groups.flatMap((group) => [
      COMMAND_GROUP_HEADINGS[group].replace(/:$/u, ''),
      ...publicSpecs
        .filter((spec) => spec.group === group)
        .map((spec) => {
          const workflow =
            spec.path === 'skillsmith config' ? spec.commonWorkflows[1] : spec.commonWorkflows[0];
          return `  $ ${workflow?.invocation ?? spec.minimalInvocations[0] ?? spec.path}`;
        }),
      '',
    ]),
    'Use `skillsmith <command> --help` for options, safety notes, and additional workflows.',
  ].join('\n');
};

const TOPIC_CONTENT: Readonly<Record<Exclude<HelpTopic, 'workflows'>, string>> = {
  manifest:
    'Desired-state manifest\n\n' +
    'skillsmith.toml declares portable skills, source intent, target tools, and placement scope. ' +
    'Use `skillsmith init` to create or migrate it, `skillsmith export` to capture portable live ' +
    'state, and `skillsmith plan` or `skillsmith apply` to preview or converge it. The manifest ' +
    'does not replace the skillsmith.lock resolution lockfile or local placement ledger.',
  lock:
    'Resolution lockfile\n\n' +
    'skillsmith.lock records exact resolved revisions and verification facts for declarations in ' +
    'skillsmith.toml. Commands that accept --lockfile require --file as well. Use locked planning ' +
    'when reproducibility matters; use update to evaluate and persist newer exact revisions.',
  plan:
    'Convergence plans\n\n' +
    '`skillsmith plan` computes changes without mutating selected state. It can emit a canonical ' +
    'saved-plan artifact with --out. `skillsmith apply --plan <file>` validates and executes that ' +
    'exact reviewed authorization; --dry-run validates and renders it without writes.',
  source:
    'Source forms (`skillsmith install <source>[@<ref>]`)\n\n' +
    '  owner/repo                        GitHub repository sugar\n' +
    '  owner/repo/<name>                 resolve a skill by name\n' +
    '  owner/repo//path/to/skill         explicit in-repository path\n' +
    '  <host>/owner/repo[/<name>]        host-explicit source\n' +
    '  <git-url>[//path/to/skill]        HTTPS, SSH, or SCP-style Git URL\n\n' +
    'Append @<ref> for a tag, branch, or full SHA. Local paths belong to `skillsmith dev --source`; ' +
    'one-part registry names are not currently accepted.',
  environment:
    'Environment variables\n\n' +
    '  NO_COLOR, FORCE_COLOR, CLICOLOR, CLICOLOR_FORCE, TERM — terminal color behavior\n' +
    '  SKILLSMITH_CONFIG — explicit configuration file, like global --config\n' +
    '  SKILLSMITH_TOOL, SKILLSMITH_SCOPE, SKILLSMITH_PATH, SKILLSMITH_REGISTRY — config inputs\n' +
    '  SKILLSMITH_HOME — SkillSmith data, store, and placement-ledger root\n\n' +
    'Internal end-to-end test variables are not user configuration.',
  scope:
    'Installation scopes\n\n' +
    'Known values are system, user, project, and managed. Each command exposes only the scopes it ' +
    "can safely operate on. Use that command's --help output for accepted --scope values and " +
    'available shorthand flags such as --user or --project.',
  'exit-codes':
    'Global exit codes\n\n' +
    '  0 success\n' +
    '  1 command, verification, or check failure\n' +
    '  2 usage error or refusal\n' +
    '  3 configuration, manifest, lock, or ledger unreadable\n' +
    '  4 required placement or tool capability unavailable\n' +
    '  5 source unresolvable\n' +
    '  6 permission denied\n' +
    '  7 drift or differences detected\n' +
    '  130 interrupted (SIGINT)\n\n' +
    'Command help lists the exact meanings relevant to that command.',
  formatting:
    'Output formatting\n\n' +
    'Human-readable output is the default. Commands with machine-readable reports expose --json; ' +
    'agents also supports --format markdown|json. stdout carries requested data while stderr ' +
    'carries diagnostics. Color is controlled by --color and standard terminal color variables.',
};

export const TOPICS: Readonly<Record<HelpTopic, string>> = {
  workflows: WORKFLOW_TOPIC(), // P17 disposition: current behavior; authority: packages/cli/src/spec/registry.ts
  manifest: TOPIC_CONTENT.manifest, // P17 disposition: current behavior; authority: packages/core/src/artifacts/manifest-codec.ts
  lock: TOPIC_CONTENT.lock, // P17 disposition: current behavior; authority: packages/core/src/artifacts/lock-codec.ts
  plan: TOPIC_CONTENT.plan, // P17 disposition: current behavior; authority: packages/core/src/artifacts/plan-codec.ts
  source: TOPIC_CONTENT.source, // P17 disposition: current behavior; authority: packages/core/src/acquire/source.ts
  environment: TOPIC_CONTENT.environment, // P17 disposition: current behavior; authorities: packages/cli/src/util/color.ts, packages/core/src/config/env.ts, packages/core/src/place/paths.ts
  scope: TOPIC_CONTENT.scope, // P17 disposition: current behavior; authority: packages/cli/src/spec/options.ts
  'exit-codes': TOPIC_CONTENT['exit-codes'], // P17 disposition: current behavior; authority: packages/cli/src/util/exit-codes.ts
  formatting: TOPIC_CONTENT.formatting, // P17 disposition: current behavior; authority: packages/cli/src/runtime/io.ts
};

export const renderTopic = (
  name: string,
): Result<string, { code: 'unknown-topic'; name: string }> => {
  const canonical =
    HELP_TOPIC_ALIASES[name as keyof typeof HELP_TOPIC_ALIASES] ??
    ((HELP_TOPIC_NAMES as readonly string[]).includes(name) ? (name as HelpTopic) : undefined);
  return canonical === undefined ? err({ code: 'unknown-topic', name }) : ok(TOPICS[canonical]);
};
