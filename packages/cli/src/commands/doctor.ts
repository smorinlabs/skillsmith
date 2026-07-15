import { resolve } from 'node:path';
import { SUPPORTED_TOOLS } from '@skillsmith/core';
import { validateNonMutatingMode } from '../util/non-mutating-mode.ts';

export interface DoctorInputRequest {
  readonly cli: Readonly<{
    readonly tools: readonly string[];
    readonly scope?: string;
    readonly allTools: boolean;
    readonly file?: string;
    readonly lockfile?: string;
    readonly fix: boolean;
    readonly dryRun: boolean;
    readonly yes: boolean;
  }>;
  readonly effectiveConfig: Readonly<{ readonly tool?: string; readonly scope?: string }>;
  readonly effectiveCwd: string;
}

export type DoctorInputResult =
  | Readonly<{
      ok: true;
      value: Readonly<{
        tools: readonly string[];
        scopes: readonly string[];
        file?: string;
        lockfile?: string;
        fix: boolean;
        dryRun: boolean;
        yes: boolean;
      }>;
    }>
  | Readonly<{
      ok: false;
      error: Readonly<{ code: 'usage'; exitCode: 2; message: string }>;
    }>;

export const resolveDoctorInputs = (input: DoctorInputRequest): DoctorInputResult => {
  const policy = validateNonMutatingMode('doctor', {
    fix: input.cli.fix,
    dryRun: input.cli.dryRun,
    yes: input.cli.yes,
  });
  if (!policy.ok) {
    return {
      ok: false,
      error: { code: 'usage', exitCode: 2, message: policy.message },
    };
  }
  const tools =
    input.cli.tools.length > 0
      ? [...input.cli.tools]
      : input.cli.allTools
        ? [...SUPPORTED_TOOLS]
        : input.effectiveConfig.tool === undefined
          ? []
          : [input.effectiveConfig.tool];
  const scope = input.cli.scope ?? input.effectiveConfig.scope;
  return {
    ok: true,
    value: {
      tools,
      scopes: scope === undefined ? [] : [scope],
      ...(input.cli.file === undefined
        ? {}
        : { file: resolve(input.effectiveCwd, input.cli.file) }),
      ...(input.cli.lockfile === undefined
        ? {}
        : { lockfile: resolve(input.effectiveCwd, input.cli.lockfile) }),
      fix: input.cli.fix,
      dryRun: input.cli.dryRun,
      yes: input.cli.yes,
    },
  };
};

export interface DoctorExitInput {
  readonly report: Readonly<{
    readonly counts?: Readonly<{ readonly warning?: number; readonly error?: number }>;
    readonly repair?: Readonly<{
      readonly operations?: readonly unknown[];
      readonly results?: readonly Readonly<{ readonly outcome?: string }>[];
    }>;
  }> | null;
  readonly strict: boolean;
  readonly failure: null | 'health' | 'usage' | 'state' | 'source' | 'permission' | 'cancelled';
}

export const resolveDoctorExitCode = (input: DoctorExitInput): 0 | 1 | 2 | 3 | 5 | 6 | 130 => {
  if (input.failure !== null) {
    return {
      health: 1,
      usage: 2,
      state: 3,
      source: 5,
      permission: 6,
      cancelled: 130,
    }[input.failure] as 1 | 2 | 3 | 5 | 6 | 130;
  }
  if (input.report === null) return 1;
  if ((input.report.repair?.results ?? []).some((result) => result.outcome === 'failed')) return 1;
  if ((input.report.counts?.error ?? 0) > 0) return 1;
  if (input.strict && (input.report.counts?.warning ?? 0) > 0) return 1;
  return 0;
};
