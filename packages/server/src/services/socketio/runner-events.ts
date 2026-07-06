import {
  RUNNER_AGENT_EVENT,
  RUNNER_BROWSER_RELAY,
  parseRunnerAgentEvent,
  parseRunnerBrowserRelay,
} from '@funny/shared/socket-events';
import type { Socket } from 'socket.io';

import { audit } from '../../lib/audit.js';
import { log } from '../../lib/logger.js';
import { metric } from '../../lib/telemetry.js';
import { isRateLimited } from '../socketio-rate-limit.js';
import { extractRunnerEventUserId, isRunnerEventAllowed } from '../socketio-runner-authz.js';

export interface RunnerEventContext {
  socket: Socket;
  runnerId: string;
  runnerUserId: string | null;
  wsRelay: typeof import('../ws-relay.js');
}

function createAllowRunnerEvent(ctx: RunnerEventContext) {
  return (eventName: string, payload: unknown): boolean => {
    const targetUserId = extractRunnerEventUserId(payload);
    if (isRunnerEventAllowed(ctx.runnerUserId, targetUserId)) return true;

    log.warn('Runner attempted cross-tenant event', {
      namespace: 'socketio',
      event: eventName,
      runnerId: ctx.runnerId,
      runnerUserId: ctx.runnerUserId,
      targetUserId,
    });
    audit({
      action: 'authz.cross_tenant_refused',
      actorId: ctx.runnerUserId,
      detail: `runner ${eventName} refused`,
      meta: { source: `socketio:${eventName}`, runnerId: ctx.runnerId, targetUserId },
    });
    return false;
  };
}

// Low-frequency, per-turn events that flip the client out of "processing".
// Losing one of these leaves every browser stuck on a running spinner until a
// manual refresh (persistence goes through the separate data channel, so a
// refresh shows the finished thread — the "it finished but the UI never
// updated" report). When a chunk storm exhausts the main per-socket cap, these
// events pass under their own much smaller budget instead of being discarded.
const CRITICAL_AGENT_EVENT_TYPES = new Set(['agent:status', 'agent:result', 'agent:error']);

// Sampled drop logging: at most one warn per socket per window, carrying the
// count of drops it stands in for, so a storm is visible without becoming one.
const DROP_LOG_WINDOW_MS = 10_000;
const dropLogWindows = new Map<string, { count: number; windowStartedAt: number }>();

function noteDroppedRunnerEvent(ctx: RunnerEventContext, eventType: string): void {
  metric('ws.runner_event_dropped', 1, { attributes: { eventType } });
  const now = Date.now();
  const window = dropLogWindows.get(ctx.socket.id);
  if (window && now - window.windowStartedAt < DROP_LOG_WINDOW_MS) {
    window.count++;
    return;
  }
  log.warn('Rate limit dropped runner agent events — browsers miss live updates', {
    namespace: 'socketio',
    runnerId: ctx.runnerId,
    eventType,
    droppedInPreviousWindow: window?.count ?? 0,
  });
  dropLogWindows.set(ctx.socket.id, { count: 1, windowStartedAt: now });
}

/** Drop per-socket rate/drop-log state on disconnect (called by runner-namespace). */
export function cleanupRunnerEventState(socketId: string): void {
  dropLogWindows.delete(socketId);
}

export function setupRunnerEventHandlers(ctx: RunnerEventContext): void {
  const allowRunnerEvent = createAllowRunnerEvent(ctx);

  ctx.socket.on(RUNNER_AGENT_EVENT, async (data: unknown) => {
    if (isRateLimited(ctx.socket.id, 500, 10_000)) {
      const overflow = parseRunnerAgentEvent(data);
      const eventType = (overflow?.event as Record<string, unknown> | null)?.type;
      const isCritical = typeof eventType === 'string' && CRITICAL_AGENT_EVENT_TYPES.has(eventType);
      if (!isCritical || isRateLimited(`${ctx.socket.id}:critical`, 100, 10_000)) {
        noteDroppedRunnerEvent(ctx, typeof eventType === 'string' ? eventType : 'unparsed');
        return;
      }
    }
    const msg = parseRunnerAgentEvent(data);
    if (!msg) return;
    if (!allowRunnerEvent(RUNNER_AGENT_EVENT, msg as unknown as Record<string, unknown>)) return;

    ctx.wsRelay.relayToUser(msg.userId, msg.event as Record<string, unknown>);

    const threadRegistry = await import('../thread-registry.js');
    const event = msg.event as Record<string, any> | null;

    // The relay check above validates `msg.userId` (the relay target) but NOT
    // the nested `event.threadId`. These DB writes / event-bus publishes are
    // keyed on that threadId, so a compromised runner could otherwise corrupt
    // another tenant's thread status or inject spurious terminal/scheduler
    // events. Gate every threadId side effect on ownership by the runner's
    // owner.
    const threadId = event?.threadId as string | undefined;
    if (threadId && ctx.runnerUserId) {
      const owned = await threadRegistry.threadBelongsToUser(threadId, ctx.runnerUserId);
      if (!owned) {
        log.warn('Runner reported event for thread it does not own', {
          namespace: 'socketio',
          event: RUNNER_AGENT_EVENT,
          runnerId: ctx.runnerId,
          runnerUserId: ctx.runnerUserId,
          threadId,
        });
        audit({
          action: 'authz.cross_tenant_refused',
          actorId: ctx.runnerUserId,
          detail: 'runner agent_event for unowned thread refused',
          meta: { source: 'socketio:runner_agent_event', runnerId: ctx.runnerId, threadId },
        });
        return;
      }
    }

    // Mirror the in-thread agent stream to the thread's sharee-only stream room
    // (thread-sharing). Gated by the ownership check above, so a runner can only
    // push into rooms for threads its owner owns. The owner is NOT in this room
    // (they already got the event via `user:`), so there is no double delivery.
    if (threadId && event) {
      ctx.wsRelay.relayToThreadStream(threadId, event);
    }

    if (event?.type === 'agent:status' && event?.threadId) {
      threadRegistry
        .updateThreadStatus(event.threadId, event.data?.status || 'running')
        .catch(() => {});
    }
    if (event?.type === 'agent:result' && event?.threadId) {
      threadRegistry.updateThreadStatus(event.threadId, 'completed').catch(() => {});

      const status = event.data?.status as string | undefined;
      const errorText = event.data?.error as string | undefined;
      const kind: 'completed' | 'failed' | 'stopped' =
        status === 'completed' ? 'completed' : status === 'stopped' ? 'stopped' : 'failed';
      const { getAgentTerminalEventBus } = await import('../agent-terminal-event-bus.js');
      getAgentTerminalEventBus().publish({
        threadId: event.threadId,
        kind,
        error: errorText,
      });
      const { getSchedulerEventBuffer } = await import('../scheduler-event-buffer.js');
      getSchedulerEventBuffer().publish({
        kind: 'agent_terminal',
        threadId: event.threadId,
        payload: { kind, error: errorText },
      });
    }
  });

  ctx.socket.on(RUNNER_BROWSER_RELAY, async (data: unknown) => {
    if (isRateLimited(ctx.socket.id, 500, 10_000)) return;
    const relay = parseRunnerBrowserRelay(data);
    if (!relay) return;
    if (!allowRunnerEvent(RUNNER_BROWSER_RELAY, relay as unknown as Record<string, unknown>))
      return;
    ctx.wsRelay.relayToUser(relay.userId, relay.data as Record<string, unknown>);
  });
}
