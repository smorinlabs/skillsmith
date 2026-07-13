import {
  type FlipTool,
  type InstallScope,
  SCOPES,
  SUPPORTED_TOOLS,
  type SelectionCapability,
  type SelectionPolicy,
  type SelectionRequest,
  type ValidatedSelectionRequest,
  validateSelectionRequest,
} from '@skillsmith/core';
import { type CliErrorFormat, failCliError } from '../../output/error-boundary.ts';

const readPolicy = (allowedScopes: SelectionPolicy['allowedScopes'] = SCOPES): SelectionPolicy => ({
  requiresSelection: false,
  allowBoundedDefault: true,
  allowAbsentCreate: false,
  allowedTools: SUPPORTED_TOOLS,
  allowedScopes,
  allowedCapabilities: ['read'],
});

const mutationPolicy = (
  capabilities: readonly SelectionCapability[],
  options: { readonly allowAbsentCreate?: boolean } = {},
): SelectionPolicy => ({
  requiresSelection: true,
  allowBoundedDefault: false,
  allowAbsentCreate: options.allowAbsentCreate ?? false,
  allowedTools: ['claude-code', 'codex'],
  allowedScopes: ['user', 'project'],
  allowedCapabilities: capabilities,
});

export const CLI_SELECTION_POLICIES = {
  agents: readPolicy(),
  list: readPolicy(),
  commands: readPolicy(['user', 'project']),
  doctor: readPolicy(['user', 'project', 'system']),
  check: readPolicy(['user', 'project', 'system']),
  install: mutationPolicy(['install'], { allowAbsentCreate: true }),
  uninstall: mutationPolicy(['uninstall']),
  dev: mutationPolicy(['dev', 'undo'], { allowAbsentCreate: true }),
  promote: mutationPolicy(['promote', 'undo']),
  verify: {
    ...readPolicy(),
    requiresSelection: true,
    allowBoundedDefault: false,
    allowedTools: ['claude-code', 'codex'],
  },
} as const satisfies Record<string, SelectionPolicy>;

/** Validate raw Commander strings before they reach typed core adapters. */
export const validateCliSelection = (
  request: SelectionRequest,
  policy: SelectionPolicy,
  format: CliErrorFormat,
): ValidatedSelectionRequest => {
  const result = validateSelectionRequest(request, policy);
  if (!result.ok) {
    return failCliError(result.error, format, { exitCode: result.error.exitCode });
  }
  return result.value;
};

export type ValidatedAdapterSelection = Omit<ValidatedSelectionRequest, 'tools' | 'scopes'> & {
  readonly tools: readonly FlipTool[];
  readonly scopes: readonly InstallScope[];
};

/** Mutation policies narrow the global known enums to the currently writable adapters. */
export const validateCliAdapterSelection = (
  request: SelectionRequest,
  policy: SelectionPolicy,
  format: CliErrorFormat,
): ValidatedAdapterSelection => {
  const selection = validateCliSelection(request, policy, format);
  const tools: FlipTool[] = [];
  for (const tool of selection.tools) {
    if (tool === 'claude-code' || tool === 'codex') tools.push(tool);
    else {
      return failCliError(
        { code: 'capability', message: `tool '${tool}' is unsupported for this operation` },
        format,
        { exitCode: 4 },
      );
    }
  }
  const scopes: InstallScope[] = [];
  for (const scope of selection.scopes) {
    if (scope === 'user' || scope === 'project') scopes.push(scope);
    else {
      return failCliError(
        { code: 'capability', message: `scope '${scope}' is unsupported for this operation` },
        format,
        { exitCode: 4 },
      );
    }
  }
  return { ...selection, tools, scopes };
};
