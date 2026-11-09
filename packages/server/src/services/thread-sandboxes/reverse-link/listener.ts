/**
 * The server's own listener for reverse-link traffic (change thread-sandboxes).
 *
 * The dialer pipes each sandbox connection into this listener rather than the
 * main one, so the request is NOT seen as coming from loopback: the main
 * server trusts loopback for some operations (shared-secret runner
 * registration), and a sandbox must never inherit that. Every request here
 * gets `REVERSE_LINK_CALLER_IP` as its caller address; otherwise it is served
 * exactly like the main origin (HTTP routes + the runner gRPC carrier).
 */

const REVERSE_LINK_CALLER_IP = {
  address: 'sandbox-reverse-link',
  family: 'reverse-link',
  port: 0,
} as const;

type ReverseLinkCallerIp = typeof REVERSE_LINK_CALLER_IP;

export interface ReverseLinkListener {
  target: { hostname: string; port: number };
  stop(): void;
}

export function startReverseLinkListener(options: {
  /** Bun server options shared with the main server (limits, WebSocket handlers). */
  serve: Omit<Parameters<typeof Bun.serve>[0], 'fetch' | 'port' | 'hostname'>;
  fetch(
    req: Request,
    server: Bun.Server<any>,
    ip: ReverseLinkCallerIp,
  ): Response | Promise<Response> | undefined;
}): ReverseLinkListener {
  const server = Bun.serve<any>({
    ...(options.serve as object),
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req, srv) => options.fetch(req, srv, REVERSE_LINK_CALLER_IP),
  } as Parameters<typeof Bun.serve>[0]);
  return {
    target: { hostname: '127.0.0.1', port: server.port! },
    stop: () => void server.stop(true),
  };
}
