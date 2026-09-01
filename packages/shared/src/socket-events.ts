/**
 * Browser Socket.IO event names and payload schemas shared by the central
 * server and client. Runner dispatch uses the separate runner.v2 gRPC contract.
 */
import { z, type ZodTypeAny } from 'zod';

// ─── Browser → Server (fire-and-forget forwarders) ───────────────────────────

/** PTY commands forwarded browser → runner (excluding ack-based `pty:list`). */
export const BROWSER_PTY_FORWARD_EVENTS = [
  'pty:spawn',
  'pty:write',
  'pty:resize',
  'pty:close',
  'pty:kill',
  'pty:signal',
  'pty:rename',
  'pty:reconnect',
  'pty:restore',
] as const;

export type BrowserPtyForwardEvent = (typeof BROWSER_PTY_FORWARD_EVENTS)[number];

export const BROWSER_SESSION_EVENTS = [
  'browser-session:open',
  'browser-session:navigate',
  'browser-session:nav',
  'browser-session:input',
  'browser-session:inspect-at',
  'browser-session:inspect-rect',
  'browser-session:screenshot',
  'browser-session:execute',
  'browser-session:heartbeat',
  'browser-session:close',
] as const;

export type BrowserSessionEvent = (typeof BROWSER_SESSION_EVENTS)[number];

// ─── Thread presence (thread-sharing) ────────────────────────────────────────
// Browser → server: start/stop viewing a thread. On open the server validates
// view access, joins the presence room (and, for sharees, the stream room), and
// broadcasts presence. Modeled awareness-style: each viewer is keyed by a
// per-connection clientId (the socket id) so it can later ride a Yjs awareness
// provider unchanged. See thread-sharing design D8.
export const THREAD_OPEN_EVENT = 'thread:open' as const;
export const THREAD_CLOSE_EVENT = 'thread:close' as const;
/** Server → browser: full presence roster sent to a viewer right after it opens. */
export const PRESENCE_SYNC_EVENT = 'presence:sync' as const;
/** Server → browser: a viewer joined / left a thread's presence room. */
export const PRESENCE_JOIN_EVENT = 'presence:join' as const;
export const PRESENCE_LEAVE_EVENT = 'presence:leave' as const;
/** Server → browser: the caller's share was revoked; drop the thread. */
export const THREAD_SHARE_REVOKED_EVENT = 'thread:share-revoked' as const;
/** Server → browser: a thread was just shared WITH the caller; pull it into "Shared with me". */
export const THREAD_SHARE_GRANTED_EVENT = 'thread:share-granted' as const;
/** Server → browser: a new comment was posted on a thread; appended live for all current viewers. */
export const THREAD_COMMENT_EVENT = 'thread:comment' as const;
/** Server → browser: a comment was deleted from a thread. */
export const THREAD_COMMENT_DELETED_EVENT = 'thread:comment_deleted' as const;

export const threadOpenSchema = z.object({ threadId: z.string().min(1) });

/** Ack-based RPC from browser → server. */
export const BROWSER_PTY_LIST_EVENT = 'pty:list' as const;

export const ptyListResponseSchema = z.object({
  status: z.enum(['ok', 'no-runner', 'timeout', 'error']),
  sessions: z.array(z.unknown()),
  error: z.string().optional(),
});

export type PtyListResponse = z.infer<typeof ptyListResponseSchema>;

// ─── Payload parsing ─────────────────────────────────────────────────────────

const objectPayloadSchema = z.union([z.record(z.string(), z.unknown()), z.null(), z.undefined()]);

export const socketObjectPayloadSchema = z.preprocess(
  (data) => data ?? {},
  z.object({}).catchall(z.unknown()),
);

export type SocketObjectPayload = z.infer<typeof socketObjectPayloadSchema>;

export const browserPtyForwardPayloadSchema = z.preprocess(
  (data) => data ?? {},
  z
    .object({
      projectId: z.string().min(1).optional(),
      id: z.string().min(1).optional(),
    })
    .catchall(z.unknown()),
);

export type BrowserPtyForwardPayload = z.infer<typeof browserPtyForwardPayloadSchema>;

/** Normalize browser fire-and-forget payloads. Returns null when invalid. */
export function parseObjectPayload(data: unknown): Record<string, unknown> | null {
  if (data != null && (typeof data !== 'object' || Array.isArray(data))) {
    return null;
  }
  const parsed = objectPayloadSchema.safeParse(data);
  if (!parsed.success) return null;
  return (parsed.data ?? {}) as Record<string, unknown>;
}

export function parseSocketPayload<TSchema extends ZodTypeAny>(
  schema: TSchema,
  data: unknown,
): z.infer<TSchema> | null {
  const parsed = schema.safeParse(data);
  return parsed.success ? parsed.data : null;
}
