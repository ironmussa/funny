import {
  createEndpointPolicy,
  createRealtimeController,
  createRealtimeDispatcher,
  parseClientRoute,
  type ClientPlatform,
  type RealtimeActionPorts,
  type RealtimeEffectSink,
  type Unsubscribe,
} from '@funny/client-core';
import { io } from 'socket.io-client';

import type { NativeCookieJar } from '../platform/transport';

export interface NativeSocket {
  connected: boolean;
  on(event: string, listener: (...args: any[]) => void): void;
  off(event: string, listener: (...args: any[]) => void): void;
  onAny(listener: (event: string, data: unknown) => void): void;
  offAny(listener: (event: string, data: unknown) => void): void;
  emit(event: string, data: unknown): void;
  disconnect(): void;
}

export type NativeRealtimePhase = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

export interface NativeRealtimeSnapshot {
  phase: NativeRealtimePhase;
  error: string | null;
}

function defaultSocketFactory(options: {
  origin: string;
  cookie: string;
  clientOrigin: string;
}): NativeSocket {
  return io(options.origin, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 2_000,
    reconnectionDelayMax: 10_000,
    extraHeaders: { Cookie: options.cookie, Origin: options.clientOrigin },
  });
}

export class NativeRealtimeService {
  private socket: NativeSocket | null = null;
  private snapshot: NativeRealtimeSnapshot = { phase: 'idle', error: null };
  private readonly listeners = new Set<(snapshot: NativeRealtimeSnapshot) => void>();
  private stopLifecycle: Unsubscribe | null = null;
  private stopNavigation: Unsubscribe | null = null;
  private stopSocketHandlers: Unsubscribe | null = null;
  private lastOpenThreadId: string | null = null;

  constructor(
    private readonly options: {
      platform: ClientPlatform;
      cookies: NativeCookieJar;
      actions: RealtimeActionPorts;
      effects: RealtimeEffectSink;
      clientOrigin: string;
      socketFactory?: typeof defaultSocketFactory;
      refreshForFocus(reason: 'visibility' | 'focus'): void;
      refreshForReconnect(): void;
      onSessionRejected(): void;
      clock?: () => number;
    },
  ) {}

  current(): NativeRealtimeSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: NativeRealtimeSnapshot) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  connect(): boolean {
    if (this.socket) return false;
    const cookie = this.options.cookies.header();
    if (!cookie) {
      this.update({ phase: 'error', error: 'No authenticated session' });
      return false;
    }
    const policy = createEndpointPolicy(this.options.platform.transport.environment);
    const socket = (this.options.socketFactory ?? defaultSocketFactory)({
      origin: policy.realtimeOrigin,
      cookie,
      clientOrigin: this.options.clientOrigin,
    });
    this.socket = socket;
    this.update({ phase: 'connecting', error: null });
    const dispatcher = createRealtimeDispatcher({
      actions: this.options.actions,
      effects: this.options.effects,
    });
    const controller = createRealtimeController({
      lifecycle: this.options.platform.lifecycle,
      navigation: this.options.platform.navigation,
      connected: () => socket.connected,
      routeEligible: (pathname) => parseClientRoute(pathname).threadId !== null,
      clock: this.options.clock ?? Date.now,
      actions: {
        refreshForFocus: this.options.refreshForFocus,
        refreshForReconnect: this.options.refreshForReconnect,
        skipped: () => undefined,
      },
    });
    const onAny = (type: string, payload: unknown) => {
      const envelope =
        payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
      const threadId = typeof envelope.threadId === 'string' ? envelope.threadId : '';
      dispatcher.dispatch({ type, threadId, data: envelope.data ?? envelope });
    };
    const onConnect = () => {
      this.update({ phase: 'connected', error: null });
      controller.handleConnected();
      if (this.lastOpenThreadId) socket.emit('thread:open', { threadId: this.lastOpenThreadId });
    };
    const onDisconnect = (reason: unknown) => {
      this.update({ phase: 'disconnected', error: typeof reason === 'string' ? reason : null });
      if (reason === 'io server disconnect') this.options.onSessionRejected();
    };
    const onError = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.update({ phase: 'error', error: message });
      this.options.platform.diagnostics.report({
        capability: 'transport',
        operation: 'realtime.connect',
        error,
      });
    };
    socket.onAny(onAny);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onError);
    this.stopSocketHandlers = () => {
      socket.offAny(onAny);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onError);
    };
    this.stopLifecycle = controller.start();
    this.lastOpenThreadId = parseClientRoute(
      this.options.platform.navigation.current().pathname,
    ).threadId;
    this.stopNavigation = this.options.platform.navigation.subscribe((location) => {
      const threadId = parseClientRoute(location.pathname).threadId;
      if (threadId === this.lastOpenThreadId) return;
      if (this.lastOpenThreadId) socket.emit('thread:close', { threadId: this.lastOpenThreadId });
      this.lastOpenThreadId = threadId;
      if (threadId && socket.connected) socket.emit('thread:open', { threadId });
    });
    return true;
  }

  disconnect(): void {
    this.stopLifecycle?.();
    this.stopNavigation?.();
    this.stopSocketHandlers?.();
    this.stopLifecycle = null;
    this.stopNavigation = null;
    this.stopSocketHandlers = null;
    this.socket?.disconnect();
    this.socket = null;
    this.lastOpenThreadId = null;
    this.update({ phase: 'idle', error: null });
  }

  private update(snapshot: NativeRealtimeSnapshot): void {
    if (snapshot.phase === this.snapshot.phase && snapshot.error === this.snapshot.error) return;
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(this.current());
  }
}
