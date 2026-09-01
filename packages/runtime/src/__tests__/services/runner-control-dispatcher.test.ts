import { FailureCode } from '@funny/shared/runner-v2/common';
import { describe, expect, test, vi } from 'vitest';

import { RunnerControlDispatcher } from '../../services/runner-control-dispatcher.js';

describe('RunnerControlDispatcher', () => {
  test('reports unavailable when no command handler is installed', () => {
    const sendControl = vi.fn(() => true);
    const dispatcher = new RunnerControlDispatcher({ isActive: () => true, sendControl });

    dispatcher.receive({ command: { metadata: { correlationId: 'c1' } } });
    expect(sendControl).toHaveBeenCalledWith({
      commandOutcome: expect.objectContaining({
        correlationId: 'c1',
        failure: expect.objectContaining({ code: FailureCode.UNAVAILABLE }),
      }),
    });
  });

  test('aborts in-flight work and acknowledges cancellation', async () => {
    const sendControl = vi.fn(() => true);
    let signal: AbortSignal | undefined;
    const dispatcher = new RunnerControlDispatcher(
      { isActive: () => true, sendControl },
      async (_command, nextSignal) => {
        signal = nextSignal;
        await new Promise<void>((_resolve, reject) => {
          nextSignal.addEventListener('abort', () => reject(new Error('cancelled')), {
            once: true,
          });
        });
      },
    );

    dispatcher.receive({ command: { metadata: { correlationId: 'c1' } } });
    dispatcher.receive({ cancel: { correlationId: 'c1', reason: 'user stop' } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(signal?.aborted).toBe(true);
    expect(sendControl).toHaveBeenCalledWith({
      cancellationAcknowledgement: { correlationId: 'c1', workStopped: true },
    });
    expect(sendControl).toHaveBeenCalledWith({
      commandOutcome: expect.objectContaining({
        correlationId: 'c1',
        failure: expect.objectContaining({ code: FailureCode.CANCELLED }),
      }),
    });
  });
});
