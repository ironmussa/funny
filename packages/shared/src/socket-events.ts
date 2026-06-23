/**
 * Socket.IO event names and payload schemas shared between server, runtime,
 * and client. Keeps the wire contract in one place.
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

// ─── Runner → Server ─────────────────────────────────────────────────────────

export const RUNNER_AGENT_EVENT = 'runner:agent_event' as const;
export const RUNNER_BROWSER_RELAY = 'runner:browser_relay' as const;

export const runnerAgentEventSchema = z.object({
  userId: z.string(),
  event: z.unknown(),
});

export type RunnerAgentEventPayload = z.infer<typeof runnerAgentEventSchema>;

export const runnerBrowserRelaySchema = z.object({
  userId: z.string(),
  data: z.unknown(),
});

export type RunnerBrowserRelayPayload = z.infer<typeof runnerBrowserRelaySchema>;

export const RUNNER_CONTROL_EVENTS = [
  'runner:heartbeat',
  'runner:poll_tasks',
  'runner:assign_project',
] as const;

/** Runner → server data persistence channel event names. */
export const RUNNER_DATA_EVENTS = [
  'data:insert_message',
  'data:insert_tool_call',
  'data:update_thread',
  'data:update_message',
  'data:delete_messages_after',
  'data:update_tool_call_output',
  'data:get_thread',
  'data:get_thread_by_external_request_id',
  'data:get_thread_by_session_id',
  'data:get_thread_with_messages',
  'data:get_tool_call',
  'data:find_tool_call',
  'data:find_last_unanswered_interactive_tool_call',
  'data:search_threads',
  'data:get_project',
  'data:list_projects',
  'data:list_project_threads',
  'data:resolve_project_path',
  'data:create_project',
  'data:create_thread',
  'data:delete_thread',
  'data:enqueue_message',
  'data:dequeue_message',
  'data:peek_message',
  'data:queue_count',
  'data:list_queue',
  'data:cancel_queued_message',
  'data:update_queued_message',
  'data:save_thread_event',
  'data:get_profile',
  'data:get_provider_key',
  'data:get_github_token',
  'data:get_minimax_api_key',
  'data:update_profile',
  'data:resolve_agent_execution_profile',
  'data:mark_and_list_stale_threads',
  'data:get_agent_template',
  'data:create_permission_rule',
  'data:find_permission_rule',
  'data:list_permission_rules',
  'data:get_builtin_providers',
  'data:set_builtin_providers',
  'data:watcher_insert',
  'data:watcher_get',
  'data:watcher_get_live_by_thread_key',
  'data:watcher_list_pending',
  'data:watcher_list_due',
  'data:watcher_list_by_user',
  'data:watcher_update',
  'data:watcher_delete_by_thread',
  'data:job_insert',
  'data:job_get',
  'data:job_list_running',
  'data:job_list_by_user',
  'data:job_update',
  'data:job_delete_by_thread',
] as const;

export type RunnerDataEvent = (typeof RUNNER_DATA_EVENTS)[number];

// ─── Payload parsing ─────────────────────────────────────────────────────────

const socketRequestIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
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

const advertisedModelEntrySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  contextWindow: z.number().int().positive(),
  i18nKey: z.string().min(1),
});

const advertisedProviderSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  models: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('static'),
      defaultModel: z.string().min(1),
      entries: z.array(advertisedModelEntrySchema).optional(),
    }),
    z.object({
      kind: z.literal('dynamic'),
      defaultModel: z.string().min(1),
    }),
  ]),
  attachmentLimits: z.object({
    inlineMaxBytes: z.number().int().nonnegative(),
    uploadMaxBytes: z.number().int().nonnegative(),
    hardMaxBytes: z.number().int().nonnegative(),
  }),
  auth: z.object({
    mode: z.enum(['runner-preauth', 'provider-key']),
    providerKeyId: z.string().min(1).optional(),
  }),
});

export const runnerHeartbeatSchema = z.preprocess(
  (data) => data ?? {},
  z
    .object({
      activeThreadIds: z.array(z.string()).default([]),
      providers: z.array(advertisedProviderSchema).optional(),
      activeBuiltins: z.array(z.string()).optional(),
      availableProviders: z.array(z.string()).optional(),
    })
    .passthrough(),
);

export type RunnerHeartbeatPayload = z.infer<typeof runnerHeartbeatSchema>;

export const runnerPollTasksSchema = z.preprocess((data) => data ?? {}, z.object({}).passthrough());

export type RunnerPollTasksPayload = z.infer<typeof runnerPollTasksSchema>;

const runnerAssignProjectBodySchema = z
  .object({
    projectId: z.string().min(1),
    localPath: z.string().min(1),
  })
  .passthrough();

export const runnerAssignProjectSchema = z.preprocess((data) => {
  if (data && typeof data === 'object' && !Array.isArray(data) && 'payload' in data) {
    return (data as { payload?: unknown }).payload;
  }
  return data;
}, runnerAssignProjectBodySchema);

export type RunnerAssignProjectPayload = z.infer<typeof runnerAssignProjectSchema>;

export const tunnelRequestSchema = z.object({
  method: z.string().min(1),
  path: z.string().min(1),
  headers: z.record(z.string(), z.string()),
  body: z.string().nullable(),
});

export type TunnelRequestPayload = z.infer<typeof tunnelRequestSchema>;

export const dataResponseSchema = z.object({
  requestId: socketRequestIdSchema,
  response: z.unknown().optional(),
});

export type DataResponsePayload = z.infer<typeof dataResponseSchema>;

export const centralBrowserWsSchema = z.object({
  userId: z.string().min(1),
  data: z.unknown(),
});

export type CentralBrowserWsPayload = z.infer<typeof centralBrowserWsSchema>;

export const centralPtyListSchema = z.object({
  userId: z.string().min(1),
});

export type CentralPtyListPayload = z.infer<typeof centralPtyListSchema>;

export const centralCommandSchema = z
  .object({
    task: z
      .object({
        taskId: z.string().optional(),
        type: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type CentralCommandPayload = z.infer<typeof centralCommandSchema>;

export const runnerDataRequestSchema = z
  .object({
    _requestId: socketRequestIdSchema.optional(),
  })
  .catchall(z.unknown());

export type RunnerDataRequestPayload = z.infer<typeof runnerDataRequestSchema>;

/** Normalize browser/runner fire-and-forget payloads. Returns null when invalid. */
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

export function parseRunnerAgentEvent(data: unknown): RunnerAgentEventPayload | null {
  return parseSocketPayload(runnerAgentEventSchema, data);
}

export function parseRunnerBrowserRelay(data: unknown): RunnerBrowserRelayPayload | null {
  return parseSocketPayload(runnerBrowserRelaySchema, data);
}

export function parseTunnelRequest(data: unknown): TunnelRequestPayload | null {
  return parseSocketPayload(tunnelRequestSchema, data);
}

export function parseDataResponse(data: unknown): DataResponsePayload | null {
  return parseSocketPayload(dataResponseSchema, data);
}

export function parseCentralBrowserWs(data: unknown): CentralBrowserWsPayload | null {
  return parseSocketPayload(centralBrowserWsSchema, data);
}

export function parseCentralPtyList(data: unknown): CentralPtyListPayload | null {
  return parseSocketPayload(centralPtyListSchema, data);
}

export function parseCentralCommand(data: unknown): CentralCommandPayload | null {
  return parseSocketPayload(centralCommandSchema, data);
}

export function parseRunnerDataRequest(data: unknown): RunnerDataRequestPayload | null {
  return parseSocketPayload(runnerDataRequestSchema, data ?? {});
}
