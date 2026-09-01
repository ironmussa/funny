import type { WSEvent } from '@funny/shared';
import { EventDurability } from '@funny/shared/runner-v2/events';
import { nanoid } from 'nanoid';

import { GrpcEventReplayStore, type GrpcReplayEvent } from './grpc-event-replay-store.js';
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

/** Publishes replayable application events and applies server receipts. */
export class RunnerEventPublisher {
  private readonly executions = new Map<string, string>();

  constructor(
    private readonly sender: RunnerEventSender,
    private readonly store: GrpcEventReplayStore = new GrpcEventReplayStore(),
  ) {}

  resumeCursors() {
    return this.store.resumeCursors();
  }

  publish(event: WSEvent): void {
    const threadId = event.threadId;
    if (!threadId) return;
    if (event.type === 'agent:init' || !this.executions.has(threadId)) {
      this.executions.set(threadId, nanoid());
    }
    const stored = this.store.append({
      scope: { threadId, executionId: this.executions.get(threadId)! },
      eventType: event.type,
      data: event.data as Record<string, unknown>,
      durability: runnerEventDurability(event),
    });
    this.send(stored);
    if (stored.durability === EventDurability.TERMINAL) this.executions.delete(threadId);
  }

  activated(): void {
    for (const scope of this.store.pendingScopes()) {
      const page = this.store.replay(scope, 0n);
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
    }
  }

  receiveReceipt(message: RunnerGrpcWireMessage): void {
    if (!message.accepted || !message.scope) return;
    this.store.acknowledge(
      { threadId: String(message.scope.threadId), executionId: String(message.scope.executionId) },
      BigInt(message.accepted.highestContiguousSequence),
    );
  }

  shutdown(): void {
    this.executions.clear();
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
