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
    '  4 no placement/tool (verify: required tool or mode unavailable)\n' +
    '  5 dev source unresolvable\n' +
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
    'Source formats: owner/repo/skill, repo/skill, Git URL. Wired in MVP-2c (install).\n\nSee research/skillsmith-cli-design.md §1.4.',
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
