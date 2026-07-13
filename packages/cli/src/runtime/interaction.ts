export type InteractionAnswer<T> =
  | { readonly kind: 'answered'; readonly value: T }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'cancelled' };

export interface ChoiceOption<T> {
  readonly value: T;
  readonly label: string;
  readonly hint?: string;
}

export interface ChoiceRequest<T> {
  readonly id: string;
  readonly message: string;
  readonly options: readonly ChoiceOption<T>[];
}

export interface ConfirmRequest {
  readonly id: string;
  readonly message: string;
  readonly initialValue?: boolean;
}

/** Choice and confirmation are capabilities; services never import a prompt implementation. */
export interface InteractionPort {
  choose<T>(request: ChoiceRequest<T>): Promise<InteractionAnswer<T>>;
  confirm(request: ConfirmRequest): Promise<InteractionAnswer<boolean>>;
}

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

/** Resolve global/format/TTY policy once, before an application service starts. */
export const resolveInteractionPolicy = (
  input: InteractionPolicyInput,
): ResolvedInteractionPolicy => ({
  interactive: !input.json && !input.noPrompt && input.stdinIsTTY && input.stderrIsTTY,
  autoConfirm: input.yes,
  ...(input.signal === undefined ? {} : { signal: input.signal }),
});

const cancelled = <T>(): InteractionAnswer<T> => ({ kind: 'cancelled' });
const unavailable = <T>(): InteractionAnswer<T> => ({ kind: 'unavailable' });

export const noninteractiveInteraction = (): InteractionPort => ({
  choose: async () => unavailable(),
  confirm: async () => unavailable(),
});

/**
 * Apply cancellation, noninteractive and `--yes` policy around the sole interactive adapter.
 * `--yes` answers confirmations only; it must never auto-select an ambiguous choice.
 */
export const createPolicyInteraction = (
  policy: ResolvedInteractionPolicy,
  interactive: InteractionPort = noninteractiveInteraction(),
): InteractionPort => {
  const wasCancelled = (): boolean => policy.signal?.aborted === true;
  return {
    choose: async <T>(request: ChoiceRequest<T>): Promise<InteractionAnswer<T>> => {
      if (wasCancelled()) return cancelled();
      if (!policy.interactive) return unavailable();
      const answer = await interactive.choose(request);
      return wasCancelled() ? cancelled() : answer;
    },
    confirm: async (request: ConfirmRequest): Promise<InteractionAnswer<boolean>> => {
      if (wasCancelled()) return cancelled();
      if (policy.autoConfirm) return { kind: 'answered', value: true };
      if (!policy.interactive) return unavailable();
      const answer = await interactive.confirm(request);
      return wasCancelled() ? cancelled() : answer;
    },
  };
};
