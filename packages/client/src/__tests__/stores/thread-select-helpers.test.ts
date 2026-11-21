import { describe, expect, test } from 'bun:test';

import type { Thread } from '@funny/shared';

import { buildThread } from '@/data/threads/testing';
import { deriveWaitingState } from '@/stores/thread-select-helpers';

function waitingThread(
  toolCallName: string,
): Thread & { messages: { toolCalls: { name: string }[] }[] } {
  return {
    ...buildThread({ status: 'waiting' }),
    messages: [{ toolCalls: [{ name: toolCallName }] }],
  };
}

describe('deriveWaitingState', () => {
  test('a reloaded waiting thread that ended on a ProviderError keeps its provider-error reason', () => {
    // Without this, the reload falls back to the generic "Waiting for your
    // response" card, which asks for a reply nothing is waiting for.
    expect(deriveWaitingState(waitingThread('ProviderError'))).toEqual({
      waitingReason: 'provider_error',
    });
  });

  test('question and plan waits are still derived', () => {
    expect(deriveWaitingState(waitingThread('AskUserQuestion'))).toEqual({
      waitingReason: 'question',
    });
    expect(deriveWaitingState(waitingThread('ExitPlanMode'))).toEqual({ waitingReason: 'plan' });
  });
});
