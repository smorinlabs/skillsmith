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

const TOPICS: Record<HelpTopic, string> = {
  'exit-codes':
    'Exit codes\n' +
    '  0 success\n' +
    '  1 failure (verify gate / flip failed; generic failure / verification failed)\n' +
    '  2 usage error or refusal\n' +
    '  3 config or ledger unreadable\n' +
    '  4 no placement/tool (install: tool not detected)\n' +
    '  5 source unresolvable (dev source or install source)\n' +
    '  6 permission error\n' +
    '  130 SIGINT\n\n' +
    'Full reference: research/skillsmith-cli-design.md §6.1',
  environment:
    'Environment variables\n  NO_COLOR, FORCE_COLOR, CLICOLOR, CLICOLOR_FORCE, TERM — honored by --color auto mode.\n\nSKILLSMITH_* variables land in MVP-2a with the config layer.',
  scopes:
    'Scopes: --system, --user, --project. Full details in research/skillsmith-cli-design.md §1.2–§1.3.\n\nScope semantics are not exercised in MVP-1.',
  manifest:
    'skillsmith.toml reference lands in MVP-2a (config) and MVP-4 (apply).\n\nSee research/skillsmith-cli-design.md for the planned schema.',
  sources:
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
    'Output formats: markdown (default for agents), json (for agents and later list/doctor). stdout=data, stderr=messages.\n\nSee research/skillsmith-cli-design.md §1.9 and §6.2.',
};

export const renderTopic = (
  name: string,
): Result<string, { code: 'unknown-topic'; name: string }> => {
  if ((HELP_TOPIC_NAMES as readonly string[]).includes(name)) {
    return ok(TOPICS[name as HelpTopic]);
  }
  return err({ code: 'unknown-topic', name });
};
