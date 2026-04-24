import type { InstallRecord } from '../detect/types.ts';
import type { ScanEnv } from '../env/types.ts';
import type { SkillSmithError } from '../errors.ts';
import type { Result } from '../result.ts';

export type { InstallMethod, InstallRecord } from '../detect/types.ts';

export const SUPPORTED_TOOLS = ['claude-code', 'codex', 'kilo-code', 'opencode'] as const;

export type SupportedTool = (typeof SUPPORTED_TOOLS)[number];

export interface Agent {
  readonly tool: SupportedTool;
  readonly installHint: string;
  detect(env: ScanEnv, signal?: AbortSignal): Promise<Result<InstallRecord[], SkillSmithError>>;
}
