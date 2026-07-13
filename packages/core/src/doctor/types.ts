import type { SupportedTool } from '../agents/types.ts';
import type { Scope } from '../config/types.ts';
import type { Logger } from '../env/logger.ts';
import type {
  HttpPort,
  InventoryReadPorts,
  PathAccessPort,
  ResolvedRuntimeConfiguration,
} from '../ports/types.ts';

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

export type DoctorPorts = InventoryReadPorts & PathAccessPort & { readonly http: HttpPort };

export interface CheckRunContext {
  env: DoctorPorts;
  mode: CheckRunMode;
  tools: readonly SupportedTool[];
  scopes: readonly Scope[];
  /** Whether the caller explicitly selected a scope instead of using the default sweep. */
  scopeExplicit?: boolean;
  cwd: string;
  /** Resolved read-only artifact pair selected by the CLI; schemas and writes remain downstream. */
  artifactPair?: { readonly file: string; readonly lockfile: string };
  configuration: ResolvedRuntimeConfiguration;
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
