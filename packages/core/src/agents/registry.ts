import { type SkillSmithError, unknownToolError } from '../errors.ts';
import { type Result, err, ok } from '../result.ts';
import { claudeCodeAgent } from './claude-code/index.ts';
import { codexAgent } from './codex/index.ts';
import { kiloCodeAgent } from './kilo-code/index.ts';
import { opencodeAgent } from './opencode/index.ts';
import type { Agent, SupportedTool } from './types.ts';
import { SUPPORTED_TOOLS } from './types.ts';

export const registry: Readonly<Record<SupportedTool, Agent>> = Object.freeze({
  'claude-code': claudeCodeAgent,
  codex: codexAgent,
  'kilo-code': kiloCodeAgent,
  opencode: opencodeAgent,
});

export const listSupportedTools = (): readonly SupportedTool[] => SUPPORTED_TOOLS;

export const getAgent = (tool: string): Result<Agent, SkillSmithError> => {
  if ((SUPPORTED_TOOLS as readonly string[]).includes(tool)) {
    return ok(registry[tool as SupportedTool]);
  }
  return err(unknownToolError(tool));
};
