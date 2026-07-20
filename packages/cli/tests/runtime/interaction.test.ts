import { describe, expect, test } from 'bun:test';
import type { InteractionPort } from '@skillsmith/core';
import {
  createConfirmationPromptOptions,
  createPolicyInteraction,
  resolveInteractionPolicy,
} from '../../src/runtime/interaction.ts';

const previewRequest = {
  id: 'apply.exact-plan',
  message: 'Apply this exact operation set?',
  preview: {
    kind: 'exact-operation-preview',
    command: 'apply',
    operationIds: ['operation:z-last', 'operation:a-first', 'operation:with\ncontrol'],
  },
} as const;

describe('apply interaction preview', () => {
  test('renders exact operation IDs in supplied order and explicitly defaults to No', () => {
    expect(createConfirmationPromptOptions(previewRequest)).toEqual({
      message:
        'Apply this exact operation set?\nExact operations:\n' +
        '  1. "operation:z-last"\n' +
        '  2. "operation:a-first"\n' +
        '  3. "operation:with\\ncontrol"',
      initialValue: false,
    });
    expect(createConfirmationPromptOptions({ id: 'confirmation', message: 'Continue?' })).toEqual({
      message: 'Continue?',
      initialValue: false,
    });
    const untrustedOverride = { ...previewRequest, defaultValue: true };
    expect(createConfirmationPromptOptions(untrustedOverride).initialValue).toBeFalse();
  });

  test('preserves preview structure through interactive policy and keeps signed policy behavior', async () => {
    let observed: unknown;
    const interactive: InteractionPort = {
      mode: 'interactive',
      choose: async () => ({ status: 'refused', reason: 'unused' }),
      confirm: async (request) => {
        observed = request;
        return { status: 'resolved', value: false };
      },
    };
    const policy = (overrides: Partial<Parameters<typeof resolveInteractionPolicy>[0]> = {}) =>
      resolveInteractionPolicy({
        json: false,
        noPrompt: false,
        yes: false,
        stdinIsTTY: true,
        stderrIsTTY: true,
        ...overrides,
      });

    const delegated = createPolicyInteraction(policy(), interactive);
    expect(await delegated.confirm(previewRequest)).toEqual({ status: 'resolved', value: false });
    expect(observed).toBe(previewRequest);

    observed = null;
    expect(
      await createPolicyInteraction(policy({ yes: true }), interactive).confirm(previewRequest),
    ).toEqual({ status: 'resolved', value: true });
    expect(observed).toBeNull();

    expect(
      await createPolicyInteraction(policy({ noPrompt: true }), interactive).confirm(
        previewRequest,
      ),
    ).toEqual({ status: 'refused', reason: 'interactive input is unavailable' });

    const controller = new AbortController();
    controller.abort();
    expect(
      await createPolicyInteraction(policy({ signal: controller.signal }), interactive).confirm(
        previewRequest,
      ),
    ).toEqual({ status: 'cancelled' });
  });
});
