/**
 * Holds a reference to the in-process runtime's fetch function.
 * Set once at startup when LOCAL_RUNNER=true; null in remote-runner-only mode.
 *
 * Using a module-level singleton avoids circular imports between index.ts,
 * the proxy middleware, and the thread routes.
 */

let _localFetch: ((req: Request) => Promise<Response>) | null = null;

export function setLocalRunnerFetch(fn: (req: Request) => Promise<Response>): void {
  _localFetch = fn;
}

export function getLocalRunnerFetch(): ((req: Request) => Promise<Response>) | null {
  return _localFetch;
}
