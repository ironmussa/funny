import { beforeEach, describe, expect, test, vi } from 'vitest';

const send = vi.hoisted(() => vi.fn());
vi.mock('@/lib/realtime/browser-session-realtime', () => ({
  sendBrowserSessionRealtime: send,
}));

import { browserSessionClient } from './browser-session-client';

describe('browser session open delivery', () => {
  beforeEach(() => send.mockReset());

  test('reports an unavailable connection instead of silently dropping open', () => {
    send.mockReturnValue(false);
    expect(() => browserSessionClient.open('thread:t1', 'https://example.com')).toThrow(
      'Browser connection unavailable',
    );
  });

  test('sends a recoverable open for the requested session', () => {
    send.mockReturnValue(true);
    expect(() => browserSessionClient.open('thread:t1', 'https://example.com')).not.toThrow();
    expect(send).toHaveBeenCalledWith('thread:t1', {
      case: 'open',
      targetUrl: 'https://example.com',
    });
  });
});
