import {
  type CheckRunResult,
  type Result,
  SCOPES,
  SUPPORTED_TOOLS,
  type Scope,
  type SupportedTool,
  err,
  ok,
} from '@skillsmith/core';
import { resolveArtifactPair } from '../util/artifact-pair.ts';

export interface CheckFlags {
  readonly reportOnly: boolean;
  readonly exitCode: boolean;
}
export interface CheckUsageError {
  readonly code: 'usage';
  readonly exitCode: 2;
  readonly message: string;
}
export interface CheckInputs {
  readonly cli: {
    readonly tools: readonly string[];
    readonly scope?: string;
    readonly allTools: boolean;
    readonly file?: string;
    readonly lockfile?: string;
  };
  readonly effectiveConfig: { readonly tool?: string; readonly scope?: string };
  readonly effectiveCwd: string;
}
export interface ResolvedCheckInputs {
  readonly tools: readonly SupportedTool[];
  readonly scopes: readonly Scope[];
  readonly file?: string;
  readonly lockfile?: string;
}

const usageError = (message: string): CheckUsageError => ({ code: 'usage', exitCode: 2, message });

export const resolveCheckExitCode = (
  report: CheckRunResult,
  flags: CheckFlags,
): Result<0 | 1, CheckUsageError> => {
  if (flags.reportOnly && flags.exitCode)
    return err(usageError('--report-only cannot be combined with --exit-code'));
  if (flags.reportOnly) return ok(0);
  return ok(report.counts.error > 0 ? 1 : 0);
};

export const resolveCheckInputs = (
  input: CheckInputs,
): Result<ResolvedCheckInputs, CheckUsageError> => {
  if (input.cli.allTools && input.cli.tools.length > 0)
    return err(usageError('--all-tools cannot be combined with --tool'));
  const artifacts = resolveArtifactPair({
    effectiveCwd: input.effectiveCwd,
    ...(input.cli.file === undefined ? {} : { file: input.cli.file }),
    ...(input.cli.lockfile === undefined ? {} : { lockfile: input.cli.lockfile }),
  });
  if (!artifacts.ok) return artifacts;
  const rawTools = input.cli.allTools
    ? SUPPORTED_TOOLS
    : input.cli.tools.length > 0
      ? input.cli.tools
      : input.effectiveConfig.tool
        ? [input.effectiveConfig.tool]
        : SUPPORTED_TOOLS;
  const tools: SupportedTool[] = [];
  for (const raw of rawTools) {
    const tool = SUPPORTED_TOOLS.find((candidate) => candidate === raw);
    if (tool === undefined) return err(usageError(`unknown tool '${raw}'`));
    tools.push(tool);
  }
  const rawScope = input.cli.scope ?? input.effectiveConfig.scope;
  let scopes: readonly Scope[] = SCOPES;
  if (rawScope !== undefined) {
    const scope = SCOPES.find((candidate) => candidate === rawScope);
    if (scope === undefined) return err(usageError(`unknown scope '${rawScope}'`));
    scopes = [scope];
  }
  if (artifacts.value.file === null || artifacts.value.lockfile === null)
    return ok({ tools, scopes });
  return ok({
    tools,
    scopes,
    file: artifacts.value.file,
    lockfile: artifacts.value.lockfile,
  });
};
