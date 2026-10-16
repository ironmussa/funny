import { describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: mocks.warn, error: vi.fn(), debug: vi.fn() },
}));

import { browserSessionManager } from '../../services/browser-session-manager.js';

describe('BrowserSessionManager fire-and-forget close', () => {
  test('a failing close is logged instead of silently swallowed', async () => {
    const manager = browserSessionManager as any;
    const close = vi.spyOn(manager, 'close').mockRejectedValueOnce(new Error('kill EPERM'));

    manager.closeAndLog('session-1', 'heartbeat');
    await vi.waitFor(() => expect(mocks.warn).toHaveBeenCalled());

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
