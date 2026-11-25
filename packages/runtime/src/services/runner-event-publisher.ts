import type { JsonObject } from '@bufbuild/protobuf';
import type { WSEvent } from '@funny/shared';
import { isRunnerUserEventType } from '@funny/shared/runner-protocol';
import { FailureCode } from '@funny/shared/runner-v2/common';
import { EventDurability } from '@funny/shared/runner-v2/events';
import { nanoid } from 'nanoid';

import {
  GrpcEventReplayStore,
  type GrpcEventScope,
  type GrpcReplayEvent,
} from './grpc-event-replay-store.js';
import type { RunnerGrpcWireMessage } from './grpc-runner-client.js';

export interface RunnerEventSender {
  send(name: 'events', message: RunnerGrpcWireMessage): boolean;
}

export function runnerEventDurability(event: WSEvent): EventDurability {
  if (event.type === 'agent:result' || event.type === 'agent:error') {
    return EventDurability.TERMINAL;
  }
  return event.type.startsWith('agent:') ? EventDurability.DURABLE : EventDurability.TRANSIENT;
}

/** Executions whose stored events are sent again at a time after a reconnect. */
const REPLAY_BATCH_SCOPES = 100;

/** Publishes replayable application events and applies server receipts. */
export class RunnerEventPublisher {
  private readonly executions = new Map<string, string>();
  /** Executions replayed in this session, so each is sent once per session. */
  private readonly replayed = new Set<string>();
  /**
   * Replayed executions of the current batch the server has not finished
   * answering, with the last sequence sent for each.
   */
  private readonly awaiting = new Map<string, bigint>();
  /** Whether the server enabled `RUNNER_CAPABILITY_USER_EVENTS` this session. */
  private userEventsEnabled = false;

  constructor(
    private readonly sender: RunnerEventSender,
    private readonly store: GrpcEventReplayStore = new GrpcEventReplayStore(),
  ) {}

  resumeCursors() {
    return this.store.resumeCursors();
  }

  publish(event: WSEvent): void {
    const threadId = event.threadId;
    if (!threadId) {
      this.publishUserEvent(event);
      return;
    }
    if (event.type === 'agent:init' || !this.executions.has(threadId)) {
      this.executions.set(threadId, nanoid());
    }
    const stored = this.store.append({
      scope: { threadId, executionId: this.executions.get(threadId)! },
      eventType: event.type,
      // SAFETY: every WS event payload is a plain JSON object: it is what the
      // browser receives as JSON, and the server reads it back as a Struct.
      data: event.data as JsonObject,
      durability: runnerEventDurability(event),
    });
    this.send(stored);
    if (stored.durability === EventDurability.TERMINAL) this.executions.delete(threadId);
  }

  /** Apply the capabilities the server enabled in its hello. */
  setUserEventsEnabled(enabled: boolean): void {
    this.userEventsEnabled = enabled;
  }

  /**
   * Unscoped events for the runner owner (browser-session frames, panel
   * state): sent once, never stored or replayed. Dropped when the server did
   * not enable user events or the type is not allowed.
   */
  private publishUserEvent(event: WSEvent): void {
    if (!this.userEventsEnabled || !isRunnerUserEventType(event.type)) return;
    this.sender.send('events', {
      userEvent: { eventType: event.type, data: (event as { data?: unknown }).data ?? {} },
    });
  }

  activated(): void {
    this.replayed.clear();
    this.awaiting.clear();
    this.replayNext();
  }

  /**
   * Send the stored events of the next executions. The following batch goes
   * out when the server has answered this one, so a long backlog reaches the
   * server in steps instead of the first batch only.
   */
  private replayNext(): void {
    const batch = this.store
      .pendingScopes(this.replayed.size + REPLAY_BATCH_SCOPES)
      .filter((scope) => !this.replayed.has(scope.executionId))
      .slice(0, REPLAY_BATCH_SCOPES);
    for (const scope of batch) {
      this.replayed.add(scope.executionId);
      this.awaiting.set(scope.executionId, 0n);
      this.replayPage(scope, 0n);
    }
  }

  /**
   * Send the stored events of one execution after `afterSequence`, one page at
   * a time. Returns false when there is none left.
   */
  private replayPage(scope: GrpcEventScope, afterSequence: bigint): boolean {
    const page = this.store.replay(scope, afterSequence);
    if (!page.historyAvailable) {
      this.sender.send('events', {
        scope,
        sequence: String(page.earliestAvailableSequence),
        gap: {
          requestedSequence: '1',
          earliestAvailableSequence: String(page.earliestAvailableSequence),
          reason: 'runner replay history was pruned',
        },
      });
    }
    for (const event of page.events) this.send(event);
    const last = page.events.at(-1);
    if (!last) return false;
    this.awaiting.set(scope.executionId, last.sequence);
    return true;
  }

  receiveReceipt(message: RunnerGrpcWireMessage): void {
    if (!message.scope) return;
    const scope = {
      threadId: String(message.scope.threadId),
      executionId: String(message.scope.executionId),
    };
    if (message.accepted) {
      const highest = BigInt(message.accepted.highestContiguousSequence);
      this.store.acknowledge(scope, highest);
      // An execution being replayed has more stored events than one page: wait
      // for the page in flight, then send the next one in the same session.
      const lastSent = this.awaiting.get(scope.executionId);
      if (lastSent !== undefined && (highest < lastSent || this.replayPage(scope, highest))) return;
    } else if (message.failure) {
      // A failure the server may lift (session not active yet) keeps the events.
      if (message.failure.retryable === true) return;
      // The thread was deleted or is out of this runner's scope: the server
      // will never accept these events, and keeping them replays them forever.
      if (message.failure.code === FailureCode.PERMISSION_DENIED) this.store.discardPending(scope);
    } else if (!message.gap) {
      return;
    }
    if (this.awaiting.delete(scope.executionId) && this.awaiting.size === 0) this.replayNext();
  }

  shutdown(): void {
    this.executions.clear();
    this.replayed.clear();
    this.awaiting.clear();
    this.store.close();
  }

  private send(event: GrpcReplayEvent): void {
    this.sender.send('events', {
      scope: event.scope,
      sequence: String(event.sequence),
      event: {
        eventType: event.eventType,
        data: event.data,
        durability: event.durability,
        occurredAt: event.occurredAt,
      },
    });
  }
}
