import {
  type ScanEnv,
  type SelectionValidationError,
  type SkillSmithError,
  detectAll,
  validateSelectionRequest,
} from '@skillsmith/core';
import { renderAgentsJson } from '../output/agents-json.ts';
import { renderAgentsMarkdown } from '../output/agents-markdown.ts';
import { CLI_SELECTION_POLICIES } from './selection-validation.ts';

export interface RunAgentsInput {
  env: ScanEnv;
  tools: readonly string[] | undefined;
  format: 'markdown' | 'json';
  detectedOnly: boolean;
  signal?: AbortSignal;
}

export type RunAgentsResult =
  | { ok: true; output: string }
  | { ok: false; error: SkillSmithError | SelectionValidationError };

export const runAgents = async (input: RunAgentsInput): Promise<RunAgentsResult> => {
  const selection = validateSelectionRequest(
    {
      targets: [],
      all: false,
      tools: input.tools ?? [],
      capability: 'read',
    },
    CLI_SELECTION_POLICIES.agents,
  );
  if (!selection.ok) return { ok: false, error: selection.error };
  const r = await detectAll(input.env, {
    ...(selection.value.tools.length > 0 ? { tools: selection.value.tools } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!r.ok) return { ok: false, error: r.error };
  const output =
    input.format === 'json'
      ? renderAgentsJson(r.value)
      : renderAgentsMarkdown(r.value, { detectedOnly: input.detectedOnly });
  return { ok: true, output };
};
