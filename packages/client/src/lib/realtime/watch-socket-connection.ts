/** The slice of a Socket.IO client the connection watcher needs. */
export interface ConnectionSocket {
  readonly connected: boolean;
  on(event: 'connect' | 'disconnect', listener: () => void): unknown;
  off(event: 'connect' | 'disconnect', listener: () => void): unknown;
}

/**
 * Report the connection state of whichever socket is currently active, and
 * follow it when the active socket is replaced (teardown + connect, e.g. a
 * Vite hot update of `use-ws.ts`). Binding once to the socket seen at mount
 * leaves the caller listening to a dead socket forever — the terminal then
 * sits on "Starting terminal…" because it never hears `connect` again.
 *
 * `onChange` fires with the current state on every (re)bind and on each
 * connect/disconnect of the bound socket. Returns an unsubscribe function.
 */
export function watchSocketConnection<S extends ConnectionSocket>(
  getActive: () => S | null,
  subscribeActive: (listener: (socket: S | null) => void) => () => void,
  onChange: (connected: boolean) => void,
): () => void {
  let bound: S | null = null;
  const onConnect = () => onChange(true);
  const onDisconnect = () => onChange(false);

  const unbind = () => {
    bound?.off('connect', onConnect);
    bound?.off('disconnect', onDisconnect);
    bound = null;
  };

  const bind = (socket: S | null) => {
    if (socket === bound) return;
    unbind();
    bound = socket;
    socket?.on('connect', onConnect);
    socket?.on('disconnect', onDisconnect);
    onChange(!!socket?.connected);
  };

  const unsubscribe = subscribeActive(bind);
  bind(getActive());
  return () => {
    unsubscribe();
    unbind();
  };
}
