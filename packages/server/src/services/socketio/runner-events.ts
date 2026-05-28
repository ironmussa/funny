import {
  RUNNER_AGENT_EVENT,
  RUNNER_BROWSER_RELAY,
  parseRunnerAgentEvent,
  parseRunnerBrowserRelay,
} from '@funny/shared/socket-events';
import type { Socket } from 'socket.io';

import { audit } from '../../lib/audit.js';
import { log } from '../../lib/logger.js';
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

export function setupRunnerEventHandlers(ctx: RunnerEventContext): void {
  const allowRunnerEvent = createAllowRunnerEvent(ctx);

  ctx.socket.on(RUNNER_AGENT_EVENT, async (data: unknown) => {
    if (isRateLimited(ctx.socket.id, 500, 10_000)) return;
    const msg = parseRunnerAgentEvent(data);
    if (!msg) return;
    if (!allowRunnerEvent(RUNNER_AGENT_EVENT, msg)) return;

    ctx.wsRelay.relayToUser(msg.userId, msg.event);

    const threadRegistry = await import('../thread-registry.js');
    const event = msg.event as Record<string, any> | null;
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
      const { getOrchestratorEventBuffer } = await import('../orchestrator-event-buffer.js');
      getOrchestratorEventBuffer().publish({
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
    if (!allowRunnerEvent(RUNNER_BROWSER_RELAY, relay)) return;
    ctx.wsRelay.relayToUser(relay.userId, relay.data);
  });
}
