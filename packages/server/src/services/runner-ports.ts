/** Transport-neutral capabilities consumed by HTTP and browser presentation code. */

export interface RunnerRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string | Uint8Array | null;
  signal?: AbortSignal;
  deadlineAt?: number;
}

export interface RunnerResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyEncoding?: 'utf8' | 'base64';
}

export interface RunnerRequestPort {
  isAvailable(runnerId: string): boolean;
  request(runnerId: string, request: RunnerRequest): Promise<RunnerResponse>;
}

export class RunnerRequestTimeoutError extends Error {
  readonly runnerId: string;
  readonly timeoutMs: number;

  constructor(runnerId: string, timeoutMs: number) {
    super(`Tunnel to runner ${runnerId} timed out after ${timeoutMs}ms`);
    this.name = 'TunnelTimeoutError';
    this.runnerId = runnerId;
    this.timeoutMs = timeoutMs;
  }
}

export type RunnerTerminalEvent =
  | { type: 'pty:spawn'; data: Record<string, any> }
  | { type: 'pty:write'; data: Record<string, any> }
  | { type: 'pty:resize'; data: Record<string, any> }
  | { type: 'pty:close' | 'pty:kill'; data: Record<string, any> }
  | { type: 'pty:signal'; data: Record<string, any> }
  | { type: 'pty:reconnect' | 'pty:restore'; data: Record<string, any> };

export interface RunnerTerminalPort {
  isAvailable(runnerId: string): boolean;
  dispatch(runnerId: string, userId: string, event: RunnerTerminalEvent): void;
  listSessions(runnerId: string, userId: string): Array<Record<string, unknown>>;
}

export interface RunnerPresencePort {
  isAvailable(runnerId: string): boolean;
  userHasAvailableRunner(userId: string): boolean;
  userIdForRunner(runnerId: string): string | null;
  availableRunnerCount(): number;
}

export interface BrowserEventSink {
  toUser(userId: string, event: Record<string, unknown>): void;
  toAll(event: Record<string, unknown>): void;
  toThreadStream(threadId: string, event: Record<string, unknown>): void;
  toThreadPresence(threadId: string, event: Record<string, unknown>): void;
  toThreadViewers(threadId: string, event: Record<string, unknown>): void;
  evictFromThread(userId: string, threadId: string): void;
}
