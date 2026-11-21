import { afterEach, describe, expect, mock, test, vi } from 'bun:test';

import { stubGlobal, unstubAllGlobals } from '@funny/test-kit';
import { act, renderHook, waitFor } from '@testing-library/react';
import { okAsync } from 'neverthrow';

const apiMocks = (() => ({
  getTranscribeToken: vi.fn(),
}))();

mock.module('@/lib/api', () => ({
  api: apiMocks,
}));

// Vite turns `./pcm-worklet.js?url` into the asset's URL; bun loads the module
// itself, which has no default export. Give the hook a URL instead, and import
// it after the mock so its import sees it.
mock.module('@/hooks/pcm-worklet.js?url', () => ({ default: '/pcm-worklet.js' }));

const { useDictation } = await import('@/hooks/use-dictation');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/** The part of a `MediaStream` the hook touches; `getUserMedia` is stubbed, so no DOM stream is needed. */
interface MediaStreamStub {
  getTracks: () => { stop: () => void }[];
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
    unstubAllGlobals();
    vi.clearAllMocks();
  });

  test('stops a microphone stream that resolves after unmount', async () => {
    const pendingStream = deferred<MediaStreamStub>();
    const stop = vi.fn();
    const stream = {
      getTracks: () => [{ stop }],
    };
    const getUserMedia = vi.fn(() => pendingStream.promise);
    stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia },
    });
    const onError = vi.fn();
    const { result, unmount } = renderHook(() => useDictation({ onError }));

    let startPromise!: Promise<void>;
    act(() => {
      startPromise = result.current.start();
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      pendingStream.resolve(stream);
      await startPromise;
    });

    expect(stop).toHaveBeenCalledTimes(1);
    expect(apiMocks.getTranscribeToken).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  test('stop while still connecting cancels the start', async () => {
    const pendingStream = deferred<MediaStreamStub>();
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] };
    stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia: vi.fn(() => pendingStream.promise) },
    });
    const onError = vi.fn();
    const { result } = renderHook(() => useDictation({ onError }));

    let startPromise!: Promise<void>;
    act(() => {
      startPromise = result.current.start();
    });
    expect(result.current.isConnecting).toBe(true);

    // The push-to-talk keys are released before the microphone is ready.
    act(() => result.current.stop());
    expect(result.current.isConnecting).toBe(false);

    await act(async () => {
      pendingStream.resolve(stream);
      await startPromise;
    });

    expect(result.current.isRecording).toBe(false);
    expect(stopTrack).toHaveBeenCalledTimes(1); // the late stream is released
    expect(apiMocks.getTranscribeToken).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  test('closes a connecting WebSocket without reporting a stale error after unmount', async () => {
    const stop = vi.fn();
    const stream = {
      getTracks: () => [{ stop }],
    };
    stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    stubGlobal('WebSocket', ConnectingWebSocket);
    apiMocks.getTranscribeToken.mockReturnValue(okAsync({ token: 'temporary-token' }));
    const onError = vi.fn();
    const { result, unmount } = renderHook(() => useDictation({ onError }));

    let startPromise!: Promise<void>;
    act(() => {
      startPromise = result.current.start();
    });
    await waitFor(() => expect(ConnectingWebSocket.instances).toHaveLength(1));

    const socket = ConnectingWebSocket.instances[0];
    const url = new URL(socket.url);
    expect(url.origin + url.pathname).toBe('wss://streaming.assemblyai.com/v3/ws');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      speech_model: 'universal-3-6-pro',
      sample_rate: '16000',
      encoding: 'pcm_s16le',
      token: 'temporary-token',
    });
    unmount();
    await act(async () => {
      await startPromise;
    });

    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });
});
