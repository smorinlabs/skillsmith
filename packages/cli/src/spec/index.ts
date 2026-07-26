export {
  CURRENT_COMMAND_SPECS,
  CURRENT_OPTION_RELATIONS,
  commandSpecInventory,
  validateCurrentCommandSpecs,
  validateCurrentOptionRelations,
  validateGlobalOptionPermutation,
} from './registry.ts';
export { validateOptionInvocation } from './relations.ts';
export type {
  CommandArgumentSpec,
  CommandGroup,
  CommandOptionSpec,
  CommandSpec,
  CommandWorkflowSafety,
  CommandWorkflowSpec,
  OptionHelpFamily,
  OptionHelpLevel,
  OptionInvocationError,
  OptionInvocationResult,
  OptionRelationKind,
  OptionRelationSpec,
} from './types.ts';
