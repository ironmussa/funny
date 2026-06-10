/**
 * Socket.IO event names and payload schemas shared between server, runtime,
 * and client. Keeps the wire contract in one place.
 */
import { z } from 'zod';

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
  'data:get_thread_with_messages',
  'data:get_tool_call',
  'data:find_tool_call',
  'data:find_last_unanswered_interactive_tool_call',
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

const objectPayloadSchema = z.union([z.record(z.string(), z.unknown()), z.null(), z.undefined()]);

/** Normalize browser/runner fire-and-forget payloads. Returns null when invalid. */
export function parseObjectPayload(data: unknown): Record<string, unknown> | null {
  if (data != null && (typeof data !== 'object' || Array.isArray(data))) {
    return null;
  }
  const parsed = objectPayloadSchema.safeParse(data);
  if (!parsed.success) return null;
  return (parsed.data ?? {}) as Record<string, unknown>;
}

export function parseRunnerAgentEvent(data: unknown): RunnerAgentEventPayload | null {
  const parsed = runnerAgentEventSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

export function parseRunnerBrowserRelay(data: unknown): RunnerBrowserRelayPayload | null {
  const parsed = runnerBrowserRelaySchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}
