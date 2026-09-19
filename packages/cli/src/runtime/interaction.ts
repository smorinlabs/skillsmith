import { confirm, isCancel, select } from '@clack/prompts';
import type {
  InteractionConfirmationRequest,
  InteractionPort,
  InteractionRequest,
  InteractionResolution,
} from '@skillsmith/core';

export interface InteractionPolicyInput {
  readonly json: boolean;
  readonly noPrompt: boolean;
  readonly yes: boolean;
  readonly stdinIsTTY: boolean;
  readonly stderrIsTTY: boolean;
  readonly signal?: AbortSignal;
}

export interface ResolvedInteractionPolicy {
  readonly interactive: boolean;
  readonly autoConfirm: boolean;
  readonly signal?: AbortSignal;
}

export const resolveInteractionPolicy = (
  input: InteractionPolicyInput,
): ResolvedInteractionPolicy => ({
  interactive: !input.json && !input.noPrompt && input.stdinIsTTY && input.stderrIsTTY,
  autoConfirm: input.yes,
  ...(input.signal === undefined ? {} : { signal: input.signal }),
});

const cancelled = <T>(): InteractionResolution<T> => ({ status: 'cancelled' });
const refused = <T>(reason = 'interactive input is unavailable'): InteractionResolution<T> => ({
  status: 'refused',
  reason,
});

/** Build the one @clack confirmation projection without changing exact operation order. */
export const createConfirmationPromptOptions = (request: InteractionConfirmationRequest) => {
  const groups =
    request.preview?.kind === 'exact-sync-preview' ||
    request.preview?.kind === 'exact-update-preview' ||
    request.preview?.kind === 'exact-undo-preview'
      ? request.preview.groupIds
      : [];
  const operations = request.preview?.operationIds ?? [];
  const exactGroups =
    groups.length === 0
      ? ''
      : `\nExact groups:\n${groups
          .map((groupId, index) => `  ${index + 1}. ${JSON.stringify(groupId)}`)
          .join('\n')}`;
  const exactPreview =
    operations.length === 0
      ? ''
      : `\nExact operations:\n${operations
          .map((operationId, index) => `  ${index + 1}. ${JSON.stringify(operationId)}`)
          .join('\n')}`;
  return Object.freeze({
    message: `${request.message}${exactGroups}${exactPreview}`,
    initialValue: false,
  });
};

export const noninteractiveInteraction = (): InteractionPort => ({
  mode: 'noninteractive',
  choose: async () => refused(),
  confirm: async () => refused(),
});

/** The sole @clack adapter; application services depend only on the public core port. */
export const promptInteraction = (): InteractionPort => ({
  mode: 'interactive',
  choose: async <T>(request: InteractionRequest<T>): Promise<InteractionResolution<T>> => {
    const answer = await select({
      message: request.message,
      options: request.choices.map((choice) => ({
        value: choice.value,
        label: choice.label,
        hint: choice.hint ?? '',
      })) as never[],
    });
    return isCancel(answer) ? cancelled() : { status: 'resolved', value: answer as T };
  },
  confirm: async (
    request: InteractionConfirmationRequest,
  ): Promise<InteractionResolution<boolean>> => {
    const answer = await confirm(createConfirmationPromptOptions(request));
    return isCancel(answer) ? cancelled() : { status: 'resolved', value: Boolean(answer) };
  },
});

export const createPolicyInteraction = (
  policy: ResolvedInteractionPolicy,
  interactive: InteractionPort = promptInteraction(),
): InteractionPort => {
  const wasCancelled = (): boolean => policy.signal?.aborted === true;
  return {
    mode: policy.interactive ? 'interactive' : 'noninteractive',
    choose: async <T>(request: InteractionRequest<T>): Promise<InteractionResolution<T>> => {
      if (wasCancelled()) return cancelled();
      if (!policy.interactive) return refused();
      const answer = await interactive.choose(request);
      return wasCancelled() ? cancelled() : answer;
    },
    confirm: async (request): Promise<InteractionResolution<boolean>> => {
      if (wasCancelled()) return cancelled();
      if (policy.autoConfirm) return { status: 'resolved', value: true };
      if (!policy.interactive) return refused();
      const answer = await interactive.confirm(request);
      return wasCancelled() ? cancelled() : answer;
    },
  };
};

export type {
  ExactApprovalPreviewRequest,
  ExactSyncApprovalPreviewRequest,
  ExactUndoApprovalPreviewRequest,
  InteractionConfirmationRequest,
  InteractionPort,
  InteractionRequest,
  InteractionResolution,
} from '@skillsmith/core';
