import type { InstallRecord } from '../detect/types.ts';
import type { ScanEnv } from '../env/types.ts';
import type { SkillSmithError } from '../errors.ts';
import type { Result } from '../result.ts';

export type { InstallMethod, InstallRecord } from '../detect/types.ts';

export type SupportedTool = 'claude-code' | 'codex' | 'kilo-code' | 'opencode';

export const SUPPORTED_TOOLS: readonly SupportedTool[] = [
  'claude-code',
  'codex',
  'kilo-code',
  'opencode',
];

export interface Agent {
  readonly tool: SupportedTool;
  readonly installHint: string;
  detect(env: ScanEnv, signal?: AbortSignal): Promise<Result<InstallRecord[], SkillSmithError>>;
}
