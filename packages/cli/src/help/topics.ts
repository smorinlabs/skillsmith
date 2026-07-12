import { type Result, err, ok } from '@skillsmith/core';

export const HELP_TOPIC_NAMES = [
  'exit-codes',
  'environment',
  'scopes',
  'manifest',
  'sources',
  'formatting',
] as const;

export type HelpTopic = (typeof HELP_TOPIC_NAMES)[number];

export const TOPICS: Record<HelpTopic, string> = {
  'exit-codes':
    'P17 disposition: current behavior; target authority: docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md#811-global-exit-code-taxonomy-and-precedence\n\n' +
    'Current shipped exit codes\n' +
    '  0 success\n' +
    '  1 failure (verify gate / flip failed; generic failure / verification failed)\n' +
    '  2 usage error or refusal\n' +
    '  3 config or ledger unreadable\n' +
    '  4 no placement/tool (install: tool not detected)\n' +
    '  5 source unresolvable (dev source or install source)\n' +
    '  6 permission error\n' +
    '  130 SIGINT\n\n' +
    'Historical shipped reference only: research/skillsmith-cli-design.md §6.1. The canonical future taxonomy is the P17 target linked above.',
  environment:
    'P17 disposition: current behavior; authorities: packages/cli/src/util/color.ts, packages/core/src/config/env.ts, packages/core/src/place/paths.ts\n\n' +
    'Environment variables\n' +
    '  NO_COLOR, FORCE_COLOR, CLICOLOR, CLICOLOR_FORCE, TERM — honored by --color auto mode.\n' +
    '  SKILLSMITH_TOOL, SKILLSMITH_SCOPE, SKILLSMITH_PATH, SKILLSMITH_REGISTRY — current config-layer inputs.\n' +
    '  SKILLSMITH_HOME — current override for SkillSmith data, store, and placement-ledger state.\n\n' +
    'Internal E2E-only variables are not user configuration.',
  scopes:
    'P17 disposition: current behavior; target authority: docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md#81-global\n\n' +
    "Scopes: --system, --user, --project. Current command support varies; use each command's --help for its accepted scope flags.",
  manifest:
    'P17 disposition: superseded target; authority: docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md#2-canonical-state-and-artifact-model\n\n' +
    'The current project config uses skillsmith.toml. P17 defines the future unified desired-state manifest and paired portable artifacts; apply is not implemented yet.',
  sources:
    'P17 disposition: current behavior; future target authority: docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md#86-install\n\n' +
    'Source forms (skillsmith install <source>[@<ref>]):\n\n' +
    '  owner/repo                        GitHub sugar; whole repo — exactly one skill installs it,\n' +
    '                                    several -> interactive picker (TTY) / list + exit 2 (non-TTY)\n' +
    '  owner/repo/<name>                 GitHub sugar; skill resolved BY NAME (repo-wide SKILL.md scan)\n' +
    '  owner/repo//path/to/skill         sugar + explicit in-repo path\n' +
    '  <host>/owner/repo[/<name>]        host-explicit: gitlab.com/..., git.corp:8443/... - no config\n' +
    '  <host>/group/sub/repo//path       GitLab subgroups: multi-segment repo paths require `//`\n' +
    '                                    (trailing bare `//` = whole-repo scan of a subgroup repo)\n' +
    '  <git-url>[//path/to/skill]        any https/ssh/scp URL; `//` = explicit path in repo\n\n' +
    'Every form may end with @<ref> (tag, branch, or full 40-hex SHA) after the path portion —\n' +
    'never inside scp user@host. One-part names are reserved for a future registry and rejected;\n' +
    'local filesystem paths are rejected (use `skillsmith dev --source` / `skillsmith promote`).\n\n' +
    'Full reference: research/commands/install.md §Source forms.',
  formatting:
    'P17 disposition: current behavior; target authority: docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md#p2-01-consistent-output-selection\n\n' +
    'Current output flags are command-specific: agents uses --format markdown|json, while supported operational commands use --json. stdout carries data; stderr carries messages.',
};

export const renderTopic = (
  name: string,
): Result<string, { code: 'unknown-topic'; name: string }> => {
  if ((HELP_TOPIC_NAMES as readonly string[]).includes(name)) {
    return ok(TOPICS[name as HelpTopic]);
  }
  return err({ code: 'unknown-topic', name });
};
