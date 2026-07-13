import type { Scope } from '../config/types.ts';
import type { InstallRecord } from '../detect/types.ts';
import type { SkillSmithError } from '../errors.ts';
import type { DetectionPorts, PlatformPaths } from '../ports/types.ts';
import type { Result } from '../result.ts';
import type { SkillRootsCtx } from './claude-code/skill-roots.ts';

export type { InstallMethod, InstallRecord } from '../detect/types.ts';
export type { SkillRootsCtx };

export const SUPPORTED_TOOLS = ['claude-code', 'codex', 'kilo-code', 'opencode'] as const;

export type SupportedTool = (typeof SUPPORTED_TOOLS)[number];

export interface Agent {
  readonly tool: SupportedTool;
  readonly installHint: string;
  detect(
    env: DetectionPorts,
    signal?: AbortSignal,
  ): Promise<Result<InstallRecord[], SkillSmithError>>;
  getSkillRoots(env: PlatformPaths, scope: Scope, ctx: SkillRootsCtx): readonly string[];
  getCommandRoots(env: PlatformPaths, scope: Scope, ctx: SkillRootsCtx): readonly string[];
  getPluginSkillDir(installPath: string): string | null;
  getPluginCommandDir(installPath: string): string | null;
}
