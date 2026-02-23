/**
 * IngestMapper — translates external webhook events into thread/message
 * operations and WebSocket emissions.
 *
 * Designed to be service-agnostic: any external service can create and update
 * threads by sending events that follow the { event_type, request_id, timestamp, data, metadata } contract.
 *
 * Event-type routing:
 *   *.accepted    → create thread
 *   *.cli_message → handle raw CLIMessage (same rendering as regular threads)
 *   *.stopped     → mark stopped
 *   *.message     → insert/update assistant message (legacy/simple)
 *
 * Lifecycle events (*.started, *.completed, *.failed) are handled as
 * FALLBACK only — if cli_message already processed the result, these are skipped.
 */

import { nanoid } from 'nanoid';
import { wsBroker } from './ws-broker.js';
import * as tm from './thread-manager.js';
import * as pm from './project-manager.js';
import type { WSEvent, WSWorkflowStepData, WSWorkflowStatusData } from '@funny/shared';
import { log } from '../lib/abbacchio.js';
import { shutdownManager, ShutdownPhase } from './shutdown-manager.js';

// ── Types ────────────────────────────────────────────────────

export interface IngestEvent {
  event_type: string;
  request_id: string;
  thread_id?: string;
  timestamp: string;
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

interface ExternalThreadState {
  threadId: string;
  projectId: string;
  userId: string;
  /** Timestamp of the last event received for this thread */
  lastEventAt: number;
}

/**
 * Per-request state for CLI message processing.
 * Mirrors the state tracking in agent-message-handler.ts.
 */
interface CLIMessageState {
  /** Map CLI-side message ID → DB message ID */
  cliToDbMsgId: Map<string, string>;
  /** Current assistant message being built (text accumulation) */
  currentAssistantMsgId: string | null;
  /** Map CLI-side tool_use ID → DB tool_call ID */
  processedToolUseIds: Map<string, string>;
  /** Set to true once a CLI result message has been processed */
  resultHandled: boolean;
}

// ── IngestMapper ─────────────────────────────────────────────

/** In-memory map of request_id → thread state */
const threadStates = new Map<string, ExternalThreadState>();

/** In-memory map of request_id → CLI message processing state */
const cliStates = new Map<string, CLIMessageState>();

/**
 * Pipeline lifecycle events that are handled internally by the pipeline
 * service and should NOT be rendered as system messages in the UI.
 * Their UI-facing equivalents are sent via pipeline.cli_message.
 */
const SILENT_EVENT_TYPES = new Set([
  'pipeline.started',
  'pipeline.completed',
  'pipeline.failed',
  'pipeline.containers.ready',
  'pipeline.tier_classified',
  'pipeline.agent.started',
  'pipeline.agent.completed',
  'pipeline.agent.failed',
  'pipeline.correcting',
  'pipeline.correction.started',
  'pipeline.correction.completed',
  'pipeline.message',
  'pipeline.cli_message',
  // Workflow events are handled by onWorkflowEvent and should not create system messages
  'workflow.started',
  'workflow.step.completed',
  'workflow.completed',
  'workflow.failed',
  // Director system events (no request_id — not tied to a specific pipeline run)
  'director.activated',
  'director.cycle.completed',
  'director.integration.dispatched',
  'director.integration.pr_created',
  'director.pr.rebase_needed',
]);

function getCLIState(requestId: string): CLIMessageState {
  let state = cliStates.get(requestId);
  if (!state) {
    state = {
      cliToDbMsgId: new Map(),
      currentAssistantMsgId: null,
      processedToolUseIds: new Map(),
      resultHandled: false,
    };
    cliStates.set(requestId, state);
  }
  return state;
}

/**
 * Decode literal Unicode escape sequences (\uXXXX) that may appear
 * in CLI output when the text was double-encoded.
 */
function decodeUnicodeEscapes(str: string): string {
  return str.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

/**
 * Resolve a project from a worktree/working path by checking if any project's
 * path is a prefix of the given path.
 */
function resolveProjectId(workingPath: string): string | null {
  const normalised = workingPath.replace(/\\/g, '/').toLowerCase();
  const projects = pm.listProjects('__local__');
  for (const project of projects) {
    const projPath = project.path.replace(/\\/g, '/').toLowerCase();
    if (normalised.startsWith(projPath) || normalised.includes('.funny-worktrees')) {
      return project.id;
    }
  }
  return null;
}

/**
 * Look up or restore the in-memory state for a request_id.
 * Falls back to a DB lookup so the mapper survives server restarts.
 */
function getState(requestId: string): ExternalThreadState | null {
  const cached = threadStates.get(requestId);
  if (cached) return cached;

  // Fallback: look up thread by externalRequestId via repository
  const row = tm.getThreadByExternalRequestId(requestId);

  if (row) {
    const state: ExternalThreadState = {
      threadId: row.id,
      projectId: row.projectId,
      userId: row.userId,
      lastEventAt: Date.now(),
    };
    threadStates.set(requestId, state);
    return state;
  }

  return null;
}

/**
 * Look up thread state by direct thread ID.
 * Allows sending events to threads created from the UI (not via ingest).
 */
function getStateByThreadId(threadId: string): ExternalThreadState | null {
  const cacheKey = `__thread:${threadId}`;
  const cached = threadStates.get(cacheKey);
  if (cached) return cached;

  const row = tm.getThread(threadId);
  if (row) {
    const state: ExternalThreadState = {
      threadId: row.id,
      projectId: row.projectId,
      userId: row.userId,
      lastEventAt: Date.now(),
    };
    threadStates.set(cacheKey, state);
    return state;
  }

  return null;
}

/**
 * Resolve thread state from an event — tries thread_id first (direct),
 * then falls back to request_id (externalRequestId lookup).
 */
function resolveState(event: IngestEvent): ExternalThreadState | null {
  const state = event.thread_id
    ? getStateByThreadId(event.thread_id)
    : getState(event.request_id);
  if (state) state.lastEventAt = Date.now();
  return state;
}

/**
 * Resolve the cache key used for CLI state maps.
 * Uses thread_id when present, otherwise request_id.
 */
function resolveStateKey(event: IngestEvent): string {
  return event.thread_id ? `__thread:${event.thread_id}` : event.request_id;
}

function emitWS(state: ExternalThreadState, event: WSEvent): void {
  if (state.userId && state.userId !== '__local__') {
    wsBroker.emitToUser(state.userId, event);
  } else {
    wsBroker.emit(event);
  }
}

// ── Event handlers ───────────────────────────────────────────

function onAccepted(event: IngestEvent): string | undefined {
  const { request_id, data, metadata, timestamp } = event;
  const stateKey = resolveStateKey(event);

  // If thread_id is provided, link to an existing thread instead of creating one
  if (event.thread_id) {
    const existing = getStateByThreadId(event.thread_id);
    if (existing) {
      // Link request_id to the existing thread for future lookups
      if (request_id) {
        tm.updateThread(existing.threadId, { provider: 'external' });
        threadStates.set(request_id, existing);
      }
      const prompt = (data.prompt as string) ?? (metadata?.prompt as string);
      if (prompt) {
        tm.insertMessage({ threadId: existing.threadId, role: 'user', content: prompt });
        emitWS(existing, { type: 'agent:message', threadId: existing.threadId, data: { messageId: '', role: 'user', content: prompt } });
      }
      emitWS(existing, { type: 'agent:status', threadId: existing.threadId, data: { status: 'pending' } });
      log.info('Linked to existing thread', { namespace: 'ingest', threadId: existing.threadId, requestId: request_id });
      return existing.threadId;
    }
    throw new Error(`Thread not found: thread_id=${event.thread_id}`);
  }

  // Prevent duplicate thread creation
  if (getState(request_id)) {
    return;
  }

  // Resolve project — prefer top-level data.projectId, then metadata, then auto-detect
  const projectId =
    (data.projectId as string) ??
    (metadata?.projectId as string) ??
    (data.worktree_path ? resolveProjectId(data.worktree_path as string) : null);

  if (!projectId) {
    throw new Error(
      `Cannot resolve projectId for request_id=${request_id}. ` +
      `Pass metadata.projectId or ensure worktree_path matches a known project.`,
    );
  }

  const threadId = nanoid();
  const userId = (metadata?.userId as string) ?? '__local__';
  const title = (data.title as string) ?? (data.branch ? `Pipeline: ${data.branch}` : `External: ${request_id.slice(0, 8)}`);
  const branch = (data.branch as string) ?? null;
  const baseBranch = (data.base_branch as string) ?? null;
  const worktreePath = (data.worktree_path as string) ?? null;
  // createdBy: allow external caller to specify agent/pipeline name, otherwise mark as "external"
  const createdBy = (metadata?.createdBy as string) ?? (data.created_by as string) ?? 'external';

  tm.createThread({
    id: threadId,
    projectId,
    userId,
    title,
    mode: worktreePath ? 'worktree' : 'local',
    provider: 'external',
    permissionMode: 'autoEdit',
    status: 'pending',
    stage: 'in_progress',
    model: (data.model as string) ?? 'sonnet',
    branch,
    baseBranch,
    worktreePath,
    source: 'ingest',
    externalRequestId: request_id,
    cost: 0,
    createdBy,
    createdAt: timestamp,
  });

  const state: ExternalThreadState = { threadId, projectId, userId, lastEventAt: Date.now() };
  threadStates.set(request_id, state);

  // Insert initial prompt as user message if provided
  const prompt = (data.prompt as string) ?? (metadata?.prompt as string);
  if (prompt) {
    tm.insertMessage({ threadId, role: 'user', content: prompt });
  }

  emitWS(state, { type: 'thread:created', threadId, data: { projectId, title, source: 'ingest' } });
  emitWS(state, { type: 'agent:status', threadId, data: { status: 'pending' } });
  log.info('Thread created', { namespace: 'ingest', threadId, requestId: request_id });
  return threadId;
}

/**
 * pipeline.started — just update DB status. The CLI system.init message
 * (via onCLIMessage → handleCLISystem) handles the WebSocket emissions.
 */
function onStarted(event: IngestEvent): void {
  const state = resolveState(event);
  if (!state) return;
  tm.updateThread(state.threadId, { status: 'running' });
}

/**
 * pipeline.completed — FALLBACK finalization.
 * If handleCLIResult already processed the result CLI message, skip.
 */
function onCompleted(event: IngestEvent): void {
  const stateKey = resolveStateKey(event);

  // Check if CLI result already handled this
  const cliState = cliStates.get(stateKey);
  if (cliState?.resultHandled) return;

  const state = resolveState(event);
  if (!state) return;

  const now = new Date().toISOString();
  const costUsd = (event.data.cost_usd as number) ?? (event.data.cost as number) ?? 0;
  const durationMs = (event.data.duration_ms as number) ?? (event.data.duration as number) ?? undefined;

  tm.updateThread(state.threadId, {
    status: 'completed', stage: 'review', completedAt: now,
    ...(costUsd ? { cost: costUsd } : {}),
  });

  emitWS(state, {
    type: 'agent:result',
    threadId: state.threadId,
    data: {
      status: 'completed',
      cost: costUsd,
      duration: durationMs,
      result: (event.data.result as string) ?? 'Completed',
      stage: 'review',
    },
  });

  cliStates.delete(stateKey);
  threadStates.delete(stateKey);
}

/**
 * pipeline.failed — FALLBACK finalization.
 * If handleCLIResult already processed the result CLI message, skip.
 */
function onFailed(event: IngestEvent): void {
  const stateKey = resolveStateKey(event);

  // Check if CLI result already handled this
  const cliState = cliStates.get(stateKey);
  if (cliState?.resultHandled) return;

  const state = resolveState(event);
  if (!state) return;

  const now = new Date().toISOString();
  const error = (event.data.error as string) ?? (event.data.message as string) ?? 'Failed';
  const costUsd = (event.data.cost_usd as number) ?? (event.data.cost as number) ?? 0;
  const durationMs = (event.data.duration_ms as number) ?? (event.data.duration as number) ?? undefined;

  tm.updateThread(state.threadId, {
    status: 'failed', completedAt: now,
    ...(costUsd ? { cost: costUsd } : {}),
  });

  emitWS(state, {
    type: 'agent:result',
    threadId: state.threadId,
    data: {
      status: 'failed',
      cost: costUsd,
      duration: durationMs,
      result: error,
      errorReason: (event.data.subtype as string) ?? 'error',
    },
  });

  cliStates.delete(stateKey);
  threadStates.delete(stateKey);
}

function onStopped(event: IngestEvent): void {
  const stateKey = resolveStateKey(event);
  const state = resolveState(event);
  if (!state) return;

  const now = new Date().toISOString();
  tm.updateThread(state.threadId, { status: 'stopped', completedAt: now });

  emitWS(state, { type: 'agent:status', threadId: state.threadId, data: { status: 'stopped' } });

  cliStates.delete(stateKey);
  threadStates.delete(stateKey);
}

// ── CLI Message handler (mirrors agent-message-handler.ts) ───

function onCLIMessage(event: IngestEvent): void {
  const threadState = resolveState(event);
  if (!threadState) return;

  const msg = event.data.cli_message as any;
  if (!msg || !msg.type) return;

  const stateKey = resolveStateKey(event);
  const cliState = getCLIState(stateKey);
  // Extract author from CLI message (set by pipeline agents)
  const author = (msg.author as string) ?? (event.data.author as string) ?? undefined;

  switch (msg.type) {
    case 'system':
      handleCLISystem(threadState, cliState, msg);
      break;
    case 'assistant':
      handleCLIAssistant(threadState, cliState, msg, author);
      break;
    case 'user':
      handleCLIToolResults(threadState, cliState, msg);
      break;
    case 'result':
      handleCLIResult(threadState, cliState, msg, stateKey);
      break;
  }
}

function handleCLISystem(
  threadState: ExternalThreadState,
  _cliState: CLIMessageState,
  msg: any,
): void {
  if (msg.subtype === 'init') {
    tm.updateThread(threadState.threadId, {
      sessionId: msg.session_id,
      status: 'running',
      initTools: JSON.stringify(msg.tools ?? []),
      initCwd: msg.cwd ?? '',
    });

    emitWS(threadState, {
      type: 'agent:status',
      threadId: threadState.threadId,
      data: { status: 'running' },
    });
    emitWS(threadState, {
      type: 'agent:init',
      threadId: threadState.threadId,
      data: {
        tools: msg.tools ?? [],
        cwd: msg.cwd ?? '',
        model: msg.model ?? '',
      },
    });
  }
}

function handleCLIAssistant(
  threadState: ExternalThreadState,
  cliState: CLIMessageState,
  msg: any,
  author?: string,
): void {
  const { threadId } = threadState;
  const cliMsgId = msg.message?.id;
  if (!cliMsgId || !msg.message?.content) return;

  // Combine all text blocks
  const textContent = decodeUnicodeEscapes(
    msg.message.content
      .filter((b: any) => b.type === 'text' && b.text)
      .map((b: any) => b.text)
      .join('\n\n')
  );

  if (textContent) {
    let msgId = cliState.currentAssistantMsgId || cliState.cliToDbMsgId.get(cliMsgId);
    if (msgId) {
      tm.updateMessage(msgId, textContent);
    } else {
      msgId = tm.insertMessage({ threadId, role: 'assistant', content: textContent, author });
    }
    cliState.currentAssistantMsgId = msgId;
    cliState.cliToDbMsgId.set(cliMsgId, msgId);

    emitWS(threadState, {
      type: 'agent:message',
      threadId,
      data: { messageId: msgId, role: 'assistant', content: textContent, author },
    });
  }

  // Handle tool_use blocks
  for (const block of msg.message.content) {
    if (block.type !== 'tool_use') continue;
    if (cliState.processedToolUseIds.has(block.id)) {
      cliState.currentAssistantMsgId = null;
      continue;
    }

    // Ensure there's a parent assistant message
    let parentMsgId = cliState.currentAssistantMsgId || cliState.cliToDbMsgId.get(cliMsgId);
    if (!parentMsgId) {
      parentMsgId = tm.insertMessage({ threadId, role: 'assistant', content: '', author });
      emitWS(threadState, {
        type: 'agent:message',
        threadId,
        data: { messageId: parentMsgId, role: 'assistant', content: '', author },
      });
    }
    cliState.currentAssistantMsgId = parentMsgId;
    cliState.cliToDbMsgId.set(cliMsgId, parentMsgId);

    // Check DB for existing duplicate
    const inputJson = JSON.stringify(block.input);
    const existingTC = tm.findToolCall(parentMsgId, block.name, inputJson);

    if (existingTC) {
      cliState.processedToolUseIds.set(block.id, existingTC.id);
    } else {
      const toolCallId = tm.insertToolCall({
        messageId: parentMsgId,
        name: block.name,
        input: inputJson,
        author,
      });
      cliState.processedToolUseIds.set(block.id, toolCallId);

      emitWS(threadState, {
        type: 'agent:tool_call',
        threadId,
        data: {
          toolCallId,
          messageId: parentMsgId,
          name: block.name,
          input: block.input,
          author,
        },
      });
    }

    // Reset current assistant message — next text should start a new message
    cliState.currentAssistantMsgId = null;
  }
}

function handleCLIToolResults(
  threadState: ExternalThreadState,
  cliState: CLIMessageState,
  msg: any,
): void {
  if (!msg.message?.content) return;

  for (const block of msg.message.content) {
    if (block.type !== 'tool_result' || !block.tool_use_id) continue;

    const toolCallId = cliState.processedToolUseIds.get(block.tool_use_id);
    if (toolCallId && block.content) {
      const decodedOutput = decodeUnicodeEscapes(block.content);
      tm.updateToolCallOutput(toolCallId, decodedOutput);

      emitWS(threadState, {
        type: 'agent:tool_output',
        threadId: threadState.threadId,
        data: { toolCallId, output: decodedOutput },
      });
    }
  }
}

function handleCLIResult(
  threadState: ExternalThreadState,
  cliState: CLIMessageState,
  msg: any,
  requestId: string,
): void {
  // Mark as handled so onCompleted/onFailed don't duplicate
  cliState.resultHandled = true;

  const finalStatus = msg.subtype === 'success' ? 'completed' : 'failed';
  const now = new Date().toISOString();

  tm.updateThread(threadState.threadId, {
    status: finalStatus,
    cost: msg.total_cost_usd ?? 0,
    completedAt: now,
    stage: 'review',
  });

  emitWS(threadState, {
    type: 'agent:result',
    threadId: threadState.threadId,
    data: {
      result: msg.result ? decodeUnicodeEscapes(msg.result) : msg.result,
      cost: msg.total_cost_usd ?? 0,
      duration: msg.duration_ms ?? 0,
      status: finalStatus,
      stage: 'review',
      ...(finalStatus === 'failed' ? { errorReason: msg.subtype } : {}),
    },
  });

  // Don't delete states here — let onCompleted/onFailed do it
  // (they check resultHandled and skip, but still clean up)
}

// ── Legacy simple message handler ────────────────────────────

function onMessage(event: IngestEvent): void {
  const state = resolveState(event);
  if (!state) return;

  const content = (event.data.text as string) ?? (event.data.content as string) ?? (event.data.message as string) ?? JSON.stringify(event.data);
  const role = (event.data.role as string) ?? 'assistant';

  const msgId = tm.insertMessage({ threadId: state.threadId, role, content });
  emitWS(state, { type: 'agent:message', threadId: state.threadId, data: { messageId: msgId, role, content } });
}

// ── Workflow event handler ────────────────────────────────────

function onWorkflowEvent(event: IngestEvent): void {
  const state = resolveState(event);
  if (!state) return;

  const { event_type, data } = event;
  const runId = (data.run_id as string) ?? event.request_id;
  const workflowName = (data.workflow_name as string) ?? 'unknown';

  if (event_type === 'workflow.started') {
    const wsEvent: WSEvent = {
      type: 'workflow:status',
      threadId: state.threadId,
      data: {
        runId,
        workflowName,
        status: 'running',
      } satisfies WSWorkflowStatusData,
    };
    emitWS(state, wsEvent);
  } else if (event_type === 'workflow.step.completed') {
    const wsEvent: WSEvent = {
      type: 'workflow:step',
      threadId: state.threadId,
      data: {
        runId,
        workflowName,
        stepName: (data.step_name as string) ?? 'unknown',
        status: 'completed',
        output: (data.output as Record<string, unknown>) ?? undefined,
      } satisfies WSWorkflowStepData,
    };
    emitWS(state, wsEvent);
  } else if (event_type === 'workflow.completed') {
    const wsEvent: WSEvent = {
      type: 'workflow:status',
      threadId: state.threadId,
      data: {
        runId,
        workflowName,
        status: 'completed',
        qualityScores: (data.quality_scores as Record<string, { status: string; details: string }>) ?? undefined,
      } satisfies WSWorkflowStatusData,
    };
    emitWS(state, wsEvent);
  } else if (event_type === 'workflow.failed') {
    const wsEvent: WSEvent = {
      type: 'workflow:status',
      threadId: state.threadId,
      data: {
        runId,
        workflowName,
        status: 'failed',
      } satisfies WSWorkflowStatusData,
    };
    emitWS(state, wsEvent);
  }
}

// ── Stale-thread sweep ───────────────────────────────────────

/** 10 minutes without events → consider external thread stale */
const STALE_TTL_MS = 10 * 60 * 1000;

/** Sweep interval — check every 2 minutes */
const SWEEP_INTERVAL_MS = 2 * 60 * 1000;

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Clean up in-memory state for a single external thread.
 * Transitions it to `stopped` in the DB and emits a WS event.
 */
export function cleanupExternalThread(threadId: string): void {
  // Find the entry in threadStates that matches this threadId
  for (const [key, state] of threadStates) {
    if (state.threadId === threadId) {
      const now = new Date().toISOString();
      tm.updateThread(threadId, { status: 'stopped', completedAt: now });
      emitWS(state, { type: 'agent:status', threadId, data: { status: 'stopped' } });
      threadStates.delete(key);
      cliStates.delete(key);
      log.info('Cleaned up external thread', { namespace: 'ingest', threadId });
      return;
    }
  }

  // Fallback: no in-memory state, just update DB
  tm.updateThread(threadId, { status: 'stopped', completedAt: new Date().toISOString() });
  log.info('Cleaned up external thread (no in-memory state)', { namespace: 'ingest', threadId });
}

/**
 * Sweep all in-memory external thread states and stop any that haven't
 * received an event in the last STALE_TTL_MS.
 */
export function sweepStaleExternalThreads(): void {
  const now = Date.now();
  const stale: Array<{ key: string; state: ExternalThreadState }> = [];

  for (const [key, state] of threadStates) {
    if (now - state.lastEventAt >= STALE_TTL_MS) {
      stale.push({ key, state });
    }
  }

  for (const { key, state } of stale) {
    const isoNow = new Date().toISOString();
    tm.updateThread(state.threadId, { status: 'stopped', completedAt: isoNow });
    emitWS(state, { type: 'agent:status', threadId: state.threadId, data: { status: 'stopped' } });
    threadStates.delete(key);
    cliStates.delete(key);
    log.info('Swept stale external thread', { namespace: 'ingest', threadId: state.threadId, staleSinceMs: now - state.lastEventAt });
  }

  if (stale.length > 0) {
    log.info(`Swept ${stale.length} stale external thread(s)`, { namespace: 'ingest' });
  }
}

/** Start the periodic sweep timer. Called once at server startup. */
export function startExternalThreadSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweepStaleExternalThreads, SWEEP_INTERVAL_MS);
  log.info(`External thread sweep started (interval=${SWEEP_INTERVAL_MS}ms, ttl=${STALE_TTL_MS}ms)`, { namespace: 'ingest' });
}

// Register cleanup with shutdown manager
shutdownManager.register('ingest-sweep', async () => {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}, ShutdownPhase.SERVICES);

// ── Public API ───────────────────────────────────────────────

/**
 * Process an incoming ingest event. Routes to the appropriate handler
 * based on the event_type suffix.
 */
export interface IngestResult {
  threadId?: string;
}

export function handleIngestEvent(event: IngestEvent): IngestResult {
  // Route workflow events to dedicated handler before suffix-based routing
  if (event.event_type.startsWith('workflow.')) {
    onWorkflowEvent(event);
    return {};
  }

  const suffix = event.event_type.split('.').pop();

  switch (suffix) {
    case 'accepted':
      return { threadId: onAccepted(event) };
    case 'started':
      onStarted(event);
      return {};
    case 'completed':
      onCompleted(event);
      return {};
    case 'failed':
      onFailed(event);
      return {};
    case 'stopped':
      onStopped(event);
      return {};
    case 'cli_message':
      onCLIMessage(event);
      return {};
    case 'message':
      onMessage(event);
      return {};
    default:
      // Silently ignore pipeline lifecycle events that are already
      // handled by cli_message (containers.ready, tier_classified, etc.)
      if (SILENT_EVENT_TYPES.has(event.event_type)) return {};
      // For truly unknown events from other sources, render as system message
      const state = resolveState(event);
      if (!state) return {};
      const detail = (event.data.message as string) ?? (event.data.detail as string) ?? JSON.stringify(event.data);
      const content = `[${event.event_type}] ${detail}`;
      const msgId = tm.insertMessage({ threadId: state.threadId, role: 'system', content });
      emitWS(state, { type: 'agent:message', threadId: state.threadId, data: { messageId: msgId, role: 'system', content } });
      return {};
  }
}
