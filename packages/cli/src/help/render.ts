import type { Command } from 'commander';
import type { CommandOptionSpec, CommandSpec, OptionHelpFamily } from '../spec/types.ts';

export const COMMAND_GROUP_HEADINGS = {
  discover: 'DISCOVER:',
  manage: 'MANAGE:',
  develop: 'DEVELOP:',
  declarative: 'DECLARATIVE:',
  maintain: 'MAINTAIN:',
} as const;

export const OPTION_HELP_FAMILY_ORDER = [
  'targets-scope',
  'source-destination-artifacts',
  'behavior-verification',
  'safety-approval',
  'automation-output',
  'inherited-globals',
] as const satisfies readonly OptionHelpFamily[];

export const OPTION_HELP_HEADINGS: Readonly<Record<OptionHelpFamily, string>> = {
  'targets-scope': 'TARGETS AND SCOPE:',
  'source-destination-artifacts': 'SOURCE, DESTINATION, AND ARTIFACTS:',
  'behavior-verification': 'BEHAVIOR AND VERIFICATION:',
  'safety-approval': 'SAFETY AND APPROVAL:',
  'automation-output': 'AUTOMATION AND OUTPUT:',
  'inherited-globals': 'INHERITED GLOBALS:',
};

export const compareOptionHelpOrder = (
  left: CommandOptionSpec,
  right: CommandOptionSpec,
): number => {
  const family =
    OPTION_HELP_FAMILY_ORDER.indexOf(left.helpFamily) -
    OPTION_HELP_FAMILY_ORDER.indexOf(right.helpFamily);
  if (family !== 0) return family;
  if (left.helpLevel === right.helpLevel) return 0;
  return left.helpLevel === 'common' ? -1 : 1;
};

export const optionHelpHeading = (option: CommandOptionSpec): string =>
  OPTION_HELP_HEADINGS[option.helpFamily];

export const optionHelpDescription = (option: CommandOptionSpec): string =>
  option.helpLevel === 'advanced'
    ? `Advanced — ${option.description ?? ''}`
    : (option.description ?? '');

const workflowBlock = (spec: CommandSpec): string => {
  if (spec.path === 'skillsmith' || spec.commonWorkflows.length === 0) return spec.description;
  const rows = spec.commonWorkflows.flatMap((workflow) => [
    `  ${workflow.label} [${workflow.safety}] — ${workflow.description}`,
    `    $ ${workflow.invocation}`,
  ]);
  return `${spec.description}\n\nCOMMON WORKFLOWS\n${rows.join('\n')}`;
};

const exitCodeBlock = (spec: CommandSpec): string => {
  const rows =
    spec.exitCodes !== undefined && spec.exitCodes.length > 0
      ? spec.exitCodes.map(({ code, meaning }) => `  ${code.toString().padEnd(4)} ${meaning}`)
      : ['  See skillsmith help exit-codes.'];
  return `EXIT CODES\n${rows.join('\n')}`;
};

const headingStyle = (title: string): string => {
  const heading = title.replace(/:$/u, '').toUpperCase();
  return heading === 'GLOBAL OPTIONS' ? 'INHERITED GLOBALS' : heading;
};

export const configureProgressiveHelp = (command: Command, spec: CommandSpec): void => {
  command
    .description(workflowBlock(spec))
    .summary(spec.description)
    .configureHelp({
      showGlobalOptions: spec.path !== 'skillsmith',
      styleTitle: headingStyle,
    });
};

const renderProgressiveHelp = (spec: CommandSpec, commanderHelp: string): string => {
  const aliases = spec.aliases.length > 0 ? `ALIASES\n  ${spec.aliases.join(', ')}\n\n` : '';
  return `PRIMARY QUESTION\n  ${spec.primaryQuestion}\n\n${aliases}${commanderHelp}\n${exitCodeBlock(spec)}\n`;
};

export const renderCommandHelp = (spec: CommandSpec, commanderHelp: string): string =>
  renderProgressiveHelp(spec, commanderHelp);

export const renderRootHelp = (spec: CommandSpec, commanderHelp: string): string =>
  renderProgressiveHelp(spec, commanderHelp);
