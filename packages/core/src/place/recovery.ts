import type { PlacementExecutionInput } from './execute.ts';
import { createPlacementSwapRequest } from './execute.ts';
import { refusedMessage, resumeSwap, rollbackSwap, sweepCommittedAcquireJournals } from './swap.ts';
import type { FlipTool, SwapExecutionResult, SwapOutcome } from './types.ts';

export interface PlacementRecoveryTarget {
  readonly skill: string;
  readonly tool: FlipTool;
  readonly scopeKey?: string | null;
}

export const recoverPlacement = (
  input: PlacementExecutionInput,
  direction: 'resume' | 'rollback',
  target: PlacementRecoveryTarget,
): Promise<SwapExecutionResult<SwapOutcome>> => {
  const request = createPlacementSwapRequest(input);
  return direction === 'resume'
    ? resumeSwap(request, target.skill, target.tool, target.scopeKey ?? null)
    : rollbackSwap(request, target.skill, target.tool, target.scopeKey ?? null);
};

export const recoverCommittedAcquirePlacements = (
  input: PlacementExecutionInput,
): Promise<SwapExecutionResult<string[]>> =>
  sweepCommittedAcquireJournals(createPlacementSwapRequest(input));

export const recoveryRefusedMessage = refusedMessage;
