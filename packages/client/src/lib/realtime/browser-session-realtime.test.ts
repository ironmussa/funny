import { DeliveryClass } from '@funny/shared/browser-v1/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { sendBrowserSessionRealtime, setBrowserSessionTransport } from './browser-session-realtime';

afterEach(() => setBrowserSessionTransport(null));

describe('browser session realtime transport', () => {
  it('rejects commands before connection, while disconnected, and after teardown', () => {
    const sendInteractive = vi.fn();
    let connected = false;
    expect(sendBrowserSessionRealtime('session', { case: 'heartbeat' })).toBe(false);
    setBrowserSessionTransport({ connected: () => connected, sendInteractive });
    expect(sendBrowserSessionRealtime('session', { case: 'heartbeat' })).toBe(false);
    expect(sendInteractive).not.toHaveBeenCalled();
    connected = true;
    expect(sendBrowserSessionRealtime('session', { case: 'heartbeat' })).toBe(true);
    setBrowserSessionTransport(null);
    expect(sendBrowserSessionRealtime('session', { case: 'heartbeat' })).toBe(false);
    expect(sendInteractive).toHaveBeenCalledTimes(1);
  });

  it('preserves per-session input ordinals when the connection is replaced', () => {
    const first = vi.fn();
    const second = vi.fn();
    setBrowserSessionTransport({ connected: () => true, sendInteractive: first });
    sendBrowserSessionRealtime('input-a', { case: 'input', action: { kind: 'click' } });
    setBrowserSessionTransport(null);
    setBrowserSessionTransport({ connected: () => true, sendInteractive: second });
    sendBrowserSessionRealtime('input-a', { case: 'input', action: { kind: 'click' } });
    sendBrowserSessionRealtime('input-b', { case: 'input', action: { kind: 'click' } });
    expect(first.mock.calls[0][0].payload.value.payload.value.inputOrdinal).toBe(1n);
    expect(second.mock.calls[0][0].payload.value.payload.value.inputOrdinal).toBe(2n);
    expect(second.mock.calls[1][0].payload.value.payload.value.inputOrdinal).toBe(1n);
    expect(second.mock.calls[0][0].delivery.deliveryClass).toBe(DeliveryClass.AT_MOST_ONCE);
  });

  it('keeps request metadata and negotiated delivery classes for commands', () => {
    const sendInteractive = vi.fn();
    setBrowserSessionTransport({ connected: () => true, sendInteractive });
    sendBrowserSessionRealtime('inspect', {
      case: 'inspect',
      requestId: 'request-1',
      selector: { kind: 'at', x: 5, y: 8 },
    });
    expect(sendInteractive).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ requestId: 'request-1' }),
        delivery: expect.objectContaining({ deliveryClass: DeliveryClass.SNAPSHOT_RECOVERABLE }),
        payload: expect.objectContaining({
          case: 'browserSession',
          value: expect.objectContaining({
            browserSessionId: 'inspect',
            payload: expect.objectContaining({
              case: 'inspect',
              value: expect.objectContaining({ selector: { kind: 'at', x: 5, y: 8 } }),
            }),
          }),
        }),
      }),
    );
  });
});
