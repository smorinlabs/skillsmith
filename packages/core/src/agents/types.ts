import type { ScanEnv } from '../env/types.ts';
import type { SkillSmithError } from '../errors.ts';
import type { Result } from '../result.ts';

export type SupportedTool = 'claude-code' | 'codex' | 'kilo-code' | 'opencode';

export const SUPPORTED_TOOLS: readonly SupportedTool[] = [
  'claude-code',
  'codex',
  'kilo-code',
  'opencode',
];

export type InstallMethod = 'brew' | 'npm-global' | 'native-installer' | 'app-bundle' | 'unknown';

export interface InstallRecord {
  path: string;
  version: string;
  installMethod: InstallMethod;
}

export interface Agent {
  readonly tool: SupportedTool;
  readonly installHint: string;
  detect(env: ScanEnv): Promise<Result<InstallRecord[], SkillSmithError>>;
}
