import type { SupportedTool } from '../agents/types.ts';
import type { Scope } from '../config/types.ts';
import type { Logger } from '../env/logger.ts';
import type { ScanEnv } from '../env/types.ts';

export type Severity = 'error' | 'warning' | 'info';
export type CheckRunMode = 'doctor' | 'check';

export interface Finding {
  checkId: string;
  severity: Severity;
  title: string;
  message: string;
  remediation?: string;
  tool?: SupportedTool;
  scope?: Scope;
  path?: string;
  operation?: string;
  reason?: string;
  scopeInUse?: boolean;
}

export interface CheckRunContext {
  env: ScanEnv;
  mode: CheckRunMode;
  tools: readonly SupportedTool[];
  scopes: readonly Scope[];
  /** Whether the caller explicitly selected a scope instead of using the default sweep. */
  scopeExplicit?: boolean;
  cwd: string;
  envVars: Record<string, string | undefined>;
  offline: boolean;
  logger: Logger;
  signal?: AbortSignal;
}

export interface Check {
  readonly id: string;
  readonly severity: Severity;
  readonly runsIn: readonly CheckRunMode[];
  run(ctx: CheckRunContext): Promise<Finding[]>;
}

export interface CheckRunResult {
  findings: Finding[];
  counts: { ok: number; warning: number; error: number };
}
