/** Transport-neutral capabilities consumed by HTTP and browser presentation code. */

import type { JsonObject } from '@bufbuild/protobuf';
import type { ThreadComment, WSEvent, WSPtyDataData } from '@funny/shared';
import type { BrowserPtyForwardPayload } from '@funny/shared/socket-events';

export interface RunnerRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string | Uint8Array | null;
  signal?: AbortSignal;
  deadlineAt?: number;
  /**
   * Hand the response body over as it arrives (`bodyStream`) instead of
   * collecting it into `body`. For callers that relay the body unread (the
   * HTTP proxy); callers that parse it leave this off.
   */
  streamBody?: boolean;
}

export interface RunnerResponse {
  status: number;
  headers: Record<string, string>;
  /** The whole body; empty when `bodyStream` is set. */
  body: string;
  bodyEncoding?: 'utf8' | 'base64';
  /** Raw body bytes as they arrive, when the request asked for `streamBody`. */
  bodyStream?: ReadableStream<Uint8Array>;
}

/*
 * Availability and terminal calls are async so a port can answer from another
 * process or a Durable Object (docs/plans/cloudflare-portability.md, Phase 2).
 */
export interface RunnerRequestPort {
  isAvailable(runnerId: string): Promise<boolean>;
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

/**
 * The data of a browser terminal message, as the browser sent it: the legacy
 * `pty:*` socket payload (only `id` and `projectId` are validated, the other
 * fields are passed on unread) or a browser.v1 terminal message mapped to it.
 */
export type RunnerTerminalEventData = BrowserPtyForwardPayload;

export type RunnerTerminalEvent =
  | { type: 'pty:spawn'; data: RunnerTerminalEventData }
  | { type: 'pty:write'; data: RunnerTerminalEventData }
  | { type: 'pty:resize'; data: RunnerTerminalEventData }
  | { type: 'pty:close' | 'pty:kill'; data: RunnerTerminalEventData }
  | { type: 'pty:signal'; data: RunnerTerminalEventData }
  | { type: 'pty:rename'; data: RunnerTerminalEventData }
  | { type: 'pty:reconnect' | 'pty:restore'; data: RunnerTerminalEventData };

/** A terminal a runner keeps open for a user, as the server's dispatcher tracks it. */
export interface RunnerTerminalSession {
  ptyId: string;
  cwd: string;
  projectId?: string;
  label?: string;
  shell?: string;
}

export interface RunnerTerminalPort {
  isAvailable(runnerId: string): Promise<boolean>;
  dispatch(runnerId: string, userId: string, event: RunnerTerminalEvent): Promise<void>;
  listSessions(runnerId: string, userId: string): Promise<RunnerTerminalSession[]>;
}

export interface RunnerPresencePort {
  isAvailable(runnerId: string): Promise<boolean>;
  userHasAvailableRunner(userId: string): Promise<boolean>;
  userIdForRunner(runnerId: string): Promise<string | null>;
  availableRunnerCount(): Promise<number>;
}

export type BrowserPublicationScope =
  | { kind: 'user'; userId: string }
  | { kind: 'all' }
  | { kind: 'thread-stream'; threadId: string }
  | { kind: 'thread-presence'; threadId: string }
  | { kind: 'thread-viewers'; threadId: string };

export type BrowserDeliveryClass =
  | 'durable'
  | 'snapshot-recoverable'
  | 'coalescible'
  | 'volatile'
  | 'at-most-once';

export interface BrowserPublication {
  scope: BrowserPublicationScope;
  logicalType: string;
  trafficClass: 'operations' | 'events' | 'terminal' | 'browserSession';
  delivery: {
    class: BrowserDeliveryClass;
    priority?: number;
    coalescingKey?: string;
  };
  /** The legacy event, or a JSON-normalized copy of one whose data may hold bigint values. */
  legacyEvent: BrowserEvent | JsonObject;
  /** Pre-authorized application envelope. Omitted while a domain remains legacy-only. */
  browserV1?: import('@funny/shared/browser-v1/events').ApplicationEvent;
  /** Pre-authorized interactive envelope for terminal or browser-session traffic. */
  browserV1Interactive?: import('@funny/shared/browser-v1/interactive').InteractiveEnvelope;
}

/** `pty:data` from the server's terminal dispatcher, with the runner's output sequence (uint64). */
export interface TerminalOutputEventData extends WSPtyDataData {
  sequence: bigint;
}

/**
 * A legacy browser event: Socket.IO emits it as is, under its `type`. The
 * server's own events follow `WSEvent` (`@funny/shared`); a runner's are relayed
 * with the data it sent, a decoded protobuf `Struct`.
 */
export interface BrowserEvent {
  type: string;
  threadId?: string;
  data?: WSEvent['data'] | TerminalOutputEventData | JsonObject;
  /** `thread:comment`: the comment posted. */
  comment?: ThreadComment;
  /** `thread:comment_deleted`: the comment removed. */
  commentId?: string;
  /** `runner:status`: the runner that went online or offline. */
  runnerId?: string;
  status?: 'online' | 'offline';
}

export interface BrowserEventSink {
  publish(publication: BrowserPublication): void;
  toUser(userId: string, event: BrowserEvent): void;
  toAll(event: BrowserEvent): void;
  toThreadStream(threadId: string, event: BrowserEvent): void;
  toThreadPresence(threadId: string, event: BrowserEvent): void;
  toThreadViewers(threadId: string, event: BrowserEvent): void;
  evictFromThread(userId: string, threadId: string): void;
}
