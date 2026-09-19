import {
  recoverCommittedAcquirePlacements,
  recoverPlacement,
  recoveryRefusedMessage,
} from '../place/recovery.ts';
import type { SwapExecutionResult, SwapOutcome } from '../place/types.ts';
import type { FlipTool } from '../place/types.ts';
import type { AcquireExecutionInput } from './execute.ts';

export interface AcquireRecoveryTarget {
  readonly skill: string;
  readonly tool: FlipTool;
  readonly scopeKey?: string | null;
}

export const recoverAcquire = (
  input: AcquireExecutionInput,
  target: AcquireRecoveryTarget,
): Promise<SwapExecutionResult<SwapOutcome>> => recoverPlacement(input, 'resume', target);

export const recoverCommittedAcquireJournals = (
  input: AcquireExecutionInput,
): Promise<SwapExecutionResult<string[]>> => recoverCommittedAcquirePlacements(input);

export { recoveryRefusedMessage };
