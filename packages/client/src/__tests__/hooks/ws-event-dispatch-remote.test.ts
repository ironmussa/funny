import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';

import { stubGlobal, unstubAllGlobals, waitFor } from '@funny/test-kit';

import {
  clearWSDispatchState,
  connectRemoteWS,
  disconnectAllRemote,
  disconnectRemoteWS,
  setWSStopped,
} from '@/hooks/ws-event-dispatch';
import { useThreadStore } from '@/stores/thread-store';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  close() {
    this.onclose?.();
  }
}

describe('ws-event-dispatch — remote WebSocket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockWebSocket.instances = [];
    stubGlobal('WebSocket', MockWebSocket);
    setWSStopped(false);
  });

  afterEach(() => {
    disconnectAllRemote();
    clearWSDispatchState();
    setWSStopped(true);
    unstubAllGlobals();
  });

  test('connectRemoteWS opens ws:// URL for valid http container origin', () => {
    connectRemoteWS('http://localhost:30042');

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toBe('ws://localhost:30042/ws');
  });

  test('connectRemoteWS ignores invalid container URLs', () => {
    connectRemoteWS('javascript:alert(1)');

    expect(MockWebSocket.instances).toHaveLength(0);
  });

  test('connectRemoteWS is a no-op when already connected to the same URL', () => {
    connectRemoteWS('http://127.0.0.1:8080');
    connectRemoteWS('http://127.0.0.1:8080');

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  test('handleRawMessage dispatches parsed events from remote socket', async () => {
    const calls: Array<{ tid: string; data: unknown }> = [];
    useThreadStore.setState({
      handleWSInit: (tid, data) => {
        calls.push({ tid, data });
      },
    });

    connectRemoteWS('http://localhost:9000');
    MockWebSocket.instances[0].onmessage?.(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'agent:init',
          threadId: 'remote-1',
          data: { model: 'sonnet' },
        }),
      }),
    );

    await waitFor(() => {
      expect(calls).toEqual([{ tid: 'remote-1', data: { model: 'sonnet' } }]);
    });
  });

  test('disconnectRemoteWS allows a fresh connection afterward', () => {
    connectRemoteWS('http://localhost:30042');
    expect(MockWebSocket.instances).toHaveLength(1);

    disconnectRemoteWS('http://localhost:30042');
    connectRemoteWS('http://localhost:30042');

    expect(MockWebSocket.instances).toHaveLength(2);
  });
});
