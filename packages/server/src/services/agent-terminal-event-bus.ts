/**
 * @domain subdomain: Orchestration
 * @domain subdomain-type: core
 * @domain type: event-bus
 * @domain layer: application
 *
 * Tiny in-process event bus for agent-terminal events
 * (`completed` / `failed` / `stopped`). The orchestrator's
 * dispatcher subscribes per-threadId; the Socket.IO `runner:agent_event`
 * handler publishes when a runner reports `agent:result`.
 *
 * Kept deliberately small — one source, one consumer, no fan-out
 * semantics needed beyond "did this thread terminate yet".
 */

export type AgentTerminalKind = 'completed' | 'failed' | 'stopped';

export interface AgentTerminalEvent {
  threadId: string;
  kind: AgentTerminalKind;
  error?: string;
}

export type AgentTerminalHandler = (event: AgentTerminalEvent) => void;

export interface AgentTerminalEventBus {
  subscribe(threadId: string, handler: AgentTerminalHandler): () => void;
  publish(event: AgentTerminalEvent): void;
}

export function createAgentTerminalEventBus(): AgentTerminalEventBus {
  const handlers = new Map<string, Set<AgentTerminalHandler>>();

  return {
    subscribe(threadId, handler) {
      let set = handlers.get(threadId);
      if (!set) {
        set = new Set();
        handlers.set(threadId, set);
      }
      set.add(handler);
      return () => {
        const current = handlers.get(threadId);
        if (!current) return;
        current.delete(handler);
        if (current.size === 0) handlers.delete(threadId);
      };
    },
    publish(event) {
      const set = handlers.get(event.threadId);
      if (!set) return;
      // Snapshot — handlers commonly unsubscribe on first invocation.
      for (const h of [...set]) h(event);
    },
  };
}

// ── Module-level singleton ────────────────────────────────────
//
// Server only. Initialised lazily on first access so tests can
// construct their own bus without colliding.

let _bus: AgentTerminalEventBus | null = null;

export function getAgentTerminalEventBus(): AgentTerminalEventBus {
  if (!_bus) _bus = createAgentTerminalEventBus();
  return _bus;
}

/** Test seam — replace the singleton in unit tests. */
export function setAgentTerminalEventBus(bus: AgentTerminalEventBus): void {
  _bus = bus;
}
