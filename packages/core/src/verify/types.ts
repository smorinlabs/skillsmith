import type { VerificationToolId } from '../agents/adapter-types.ts';
import type { SkillSmithError } from '../errors.ts';
import type { DetectionPorts, FileWritePort, IdPort, ProcessPort } from '../ports/types.ts';
import type { Result } from '../result.ts';
export { VERIFIED_AGAINST, VERIFY_TOOLS } from '../agents/registry.ts';
export { DEEP_TIMEOUT_MS, STATIC_TIMEOUT_MS } from './constants.ts';

export type VerifyTool = VerificationToolId;

export type VerifyMode = 'static' | 'deep';
export type NormalizedSeverity = 'error' | 'warning' | 'info';
export type VerifyOutcome = 'pass' | 'warn' | 'fail'; // a produced verdict
export type SummaryVerdict = VerifyOutcome | 'inconclusive'; // rollup when nothing ran
export type ModeStatus = 'ran' | 'skipped' | 'error'; // did the checker run?
export type SkipReason = 'not-installed' | 'timeout' | 'exec-error';

export interface VerifyFinding {
  checkId: string; // e.g. 'claude.frontmatter' | 'codex.skill-load' | 'codex.manifest'
  toolSeverity: string | null; // native token verbatim; null for synthesized findings
  normalizedSeverity: NormalizedSeverity;
  message: string; // the tool's own message (verbatim or lightly trimmed)
  file: string | null; // path relative to <path> when known
  subject: 'skill' | 'manifest' | 'marketplace' | 'plugin';
  raw?: string; // the raw tool line, for --debug and forward-compat
}

export interface ModeResult {
  mode: VerifyMode;
  status: ModeStatus;
  skipReason: SkipReason | null; // null when status === 'ran'
  coverage: { manifest: boolean; skills: boolean }; // what THIS (tool,mode) actually inspected
  verdict: VerifyOutcome | null; // null unless status === 'ran'
  command: string; // the command line run (temp paths redacted), for auditability
  findings: VerifyFinding[];
}

export interface ToolVerdict {
  tool: VerifyTool;
  available: boolean; // detected on PATH
  toolVersion: string | null; // observed CLI version, or null when unavailable
  versionDrift: boolean; // observed !== VERIFIED_AGAINST[tool]
  skipReason: SkipReason | null; // 'not-installed' when !available
  verdict: SummaryVerdict; // worst of ran modes; 'inconclusive' if none ran
  modes: ModeResult[]; // empty when !available
}

export interface VerifyReport {
  schemaVersion: 1;
  target: { path: string; kind: 'plugin' | 'skill' }; // 'skill' = bare skill dir, wrapped
  requested: {
    tools: VerifyTool[];
    modes: VerifyMode[];
    strict: boolean;
    explicitTools: boolean;
  };
  verifiedAgainst: Record<VerifyTool, string>;
  summary: {
    verdict: SummaryVerdict;
    verified: VerifyTool[]; // tools with a produced pass/warn verdict
    failed: VerifyTool[]; // tools with a fail verdict
    skipped: VerifyTool[]; // tools that could not run
    counts: { error: number; warning: number; info: number }; // normalized totals, all findings
  };
  tools: ToolVerdict[];
}

export interface ToolVerifyOptions {
  path: string; // resolved plugin dir (post bare-skill wrap)
  modes: readonly VerifyMode[];
  strict: boolean;
  signal?: AbortSignal;
  // Original target shape from resolveTarget, so a checker can map any temp-staging
  // path back to what the user actually verified (e.g. collapse a bare skill's
  // synthesized `skills/<name>/SKILL.md` to the original `SKILL.md`). Undefined ==
  // 'plugin' (the common case; only runVerify threads this through today).
  kind?: 'plugin' | 'skill';
}

export type VerifyPorts = DetectionPorts &
  FileWritePort &
  Pick<ProcessPort, 'exec'> &
  Pick<IdPort, 'nextId'>;

export type ToolVerifier = (
  env: VerifyPorts,
  opts: ToolVerifyOptions,
) => Promise<Result<ToolVerdict, SkillSmithError>>;
