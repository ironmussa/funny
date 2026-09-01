import { act, renderHook, waitFor } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import { afterEach, describe, expect, test, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  getTranscribeToken: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: apiMocks,
}));

import { useDictation } from '@/hooks/use-dictation';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class ConnectingWebSocket {
  static readonly OPEN = 1;
  static instances: ConnectingWebSocket[] = [];

  readonly send = vi.fn();
  readonly close = vi.fn(() => this.onclose?.(new Event('close')));
  readonly readyState = 0;
  binaryType = '';
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    ConnectingWebSocket.instances.push(this);
  }
}

describe('useDictation', () => {
  afterEach(() => {
    ConnectingWebSocket.instances = [];
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  test('stops a microphone stream that resolves after unmount', async () => {
    const pendingStream = deferred<MediaStream>();
    const stop = vi.fn();
    const stream = {
      getTracks: () => [{ stop }],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(() => pendingStream.promise);
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia },
    });
    const onError = vi.fn();
    const { result, unmount } = renderHook(() => useDictation({ onError }));

    let startPromise!: Promise<void>;
    act(() => {
      startPromise = result.current.start();
    });
    expect(getUserMedia).toHaveBeenCalledOnce();

    unmount();
    await act(async () => {
      pendingStream.resolve(stream);
      await startPromise;
    });

    expect(stop).toHaveBeenCalledOnce();
    expect(apiMocks.getTranscribeToken).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  test('closes a connecting WebSocket without reporting a stale error after unmount', async () => {
    const stop = vi.fn();
    const stream = {
      getTracks: () => [{ stop }],
    } as unknown as MediaStream;
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    vi.stubGlobal('WebSocket', ConnectingWebSocket);
    apiMocks.getTranscribeToken.mockReturnValue(okAsync({ token: 'temporary-token' }));
    const onError = vi.fn();
    const { result, unmount } = renderHook(() => useDictation({ onError }));

    let startPromise!: Promise<void>;
    act(() => {
      startPromise = result.current.start();
    });
    await waitFor(() => expect(ConnectingWebSocket.instances).toHaveLength(1));

    const socket = ConnectingWebSocket.instances[0];
    unmount();
    await act(async () => {
      await startPromise;
    });

    expect(socket.close).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });
});
