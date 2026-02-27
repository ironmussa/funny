import type { EventBus } from '../infrastructure/event-bus.js';

/**
 * A workflow subscribes to EventBus events, orchestrates a multi-step flow,
 * and publishes result events. Workflows contain the "when X happens, do Y then Z"
 * logic that was previously scattered across routes and watchdog.
 */
export interface IWorkflow {
  readonly name: string;

  /** Subscribe to EventBus events and start reacting. */
  start(): void;

  /** Unsubscribe and stop reacting. */
  stop(): void;
}

/** Base config every workflow receives. */
export interface WorkflowDeps {
  eventBus: EventBus;
}
