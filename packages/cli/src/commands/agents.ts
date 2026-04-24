import {
  type ScanEnv,
  type SkillSmithError,
  type SupportedTool,
  detectAll,
} from '@skillsmith/core';
import { renderAgentsJson } from '../output/agents-json.ts';
import { renderAgentsMarkdown } from '../output/agents-markdown.ts';

export interface RunAgentsInput {
  env: ScanEnv;
  tools: readonly string[] | undefined;
  format: 'markdown' | 'json';
  detectedOnly: boolean;
  signal?: AbortSignal;
}

export type RunAgentsResult = { ok: true; output: string } | { ok: false; error: SkillSmithError };

export const runAgents = async (input: RunAgentsInput): Promise<RunAgentsResult> => {
  const r = await detectAll(input.env, {
    ...(input.tools ? { tools: input.tools as readonly SupportedTool[] } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!r.ok) return { ok: false, error: r.error };
  const output =
    input.format === 'json'
      ? renderAgentsJson(r.value)
      : renderAgentsMarkdown(r.value, { detectedOnly: input.detectedOnly });
  return { ok: true, output };
};
