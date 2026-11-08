import type { Thread } from '@funny/shared';
import { describe, expect, test } from 'vitest';

import { deriveWaitingState } from '@/stores/thread-select-helpers';

function waitingThread(toolCallName: string) {
  return {
    status: 'waiting',
    messages: [{ toolCalls: [{ name: toolCallName }] }],
  } as unknown as Thread & { messages: { toolCalls: { name: string }[] }[] };
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
