import { describe, expect, test, vi, mock } from 'bun:test';

import { waitFor } from '@funny/test-kit';

const mocks = (() => ({ warn: vi.fn() }))();

mock.module('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: mocks.warn, error: vi.fn(), debug: vi.fn() },
}));

import { browserSessionManager } from '../../services/browser-session-manager.js';

describe('BrowserSessionManager fire-and-forget close', () => {
  test('a failing close is logged instead of silently swallowed', async () => {
    const manager = browserSessionManager;
    const close = vi.spyOn(manager, 'close').mockRejectedValueOnce(new Error('kill EPERM'));

    manager['closeAndLog']('session-1', 'heartbeat');
    await waitFor(() => expect(mocks.warn).toHaveBeenCalled());

    expect(close).toHaveBeenCalledWith('session-1', 'heartbeat');
    expect(mocks.warn).toHaveBeenCalledWith(
      'Failed to close browser session',
      expect.objectContaining({
        sessionId: 'session-1',
        reason: 'heartbeat',
        error: 'kill EPERM',
      }),
    );
  });
});
