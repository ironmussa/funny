import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import {
  DeliveryClass,
  EventMetadataSchema,
  type Cursor,
  type ScopeReference,
} from '@funny/shared/browser-v1/common';
import { ApplicationEventSchema, type ApplicationEvent } from '@funny/shared/browser-v1/events';

interface RetainedEvent {
  event: ApplicationEvent;
  byteLength: number;
  retainedAt: number;
}

interface ScopeState {
  nextSequence: bigint;
  nextRevision: bigint;
  totalBytes: number;
  entries: RetainedEvent[];
  latestNonReplayableSequence: bigint;
  droppedThroughSequence: bigint;
}

export type BrowserEventResume =
  | { kind: 'accepted'; cursor: Cursor; events: ApplicationEvent[] }
  | { kind: 'gap'; cursor: Cursor; earliestAvailableSequence: bigint }
  | { kind: 'snapshot-required'; cursor: Cursor };

export interface BrowserEventRetentionOptions {
  maxAgeMs: number;
  maxBytesPerScope: number;
  now?: () => number;
  eventId?: () => string;
}

function scopeKey(scope: ScopeReference): string {
  return `${scope.kind}:${scope.parentId ?? ''}:${scope.id}`;
}

export class BrowserV1EventRetention {
  private readonly scopes = new Map<string, ScopeState>();
  private readonly now: () => number;
  private readonly eventId: () => string;

  constructor(private readonly options: BrowserEventRetentionOptions) {
    if (options.maxAgeMs <= 0 || options.maxBytesPerScope <= 0) {
      throw new Error('browser event retention budgets must be positive');
    }
    this.now = options.now ?? Date.now;
    this.eventId = options.eventId ?? (() => crypto.randomUUID());
  }

  append(scope: ScopeReference, event: ApplicationEvent): ApplicationEvent {
    const key = scopeKey(scope);
    const state = this.scopes.get(key) ?? {
      nextSequence: 1n,
      nextRevision: 1n,
      totalBytes: 0,
      entries: [],
      latestNonReplayableSequence: 0n,
      droppedThroughSequence: 0n,
    };
    this.scopes.set(key, state);
    this.prune(state);

    const assigned = create(ApplicationEventSchema, {
      delivery: event.delivery,
      payload: event.payload,
      metadata: create(EventMetadataSchema, {
        ...event.metadata,
        eventId: event.metadata?.eventId || this.eventId(),
        scope,
        sequence: state.nextSequence,
        revision: state.nextRevision,
        occurredAt: event.metadata?.occurredAt ?? timestampFromDate(new Date(this.now())),
      }),
    });
    state.nextSequence += 1n;
    state.nextRevision += 1n;
    if (assigned.delivery?.deliveryClass !== DeliveryClass.DURABLE) {
      state.latestNonReplayableSequence = assigned.metadata?.sequence ?? 0n;
      return assigned;
    }

    const byteLength = toBinary(ApplicationEventSchema, assigned).byteLength;
    state.entries.push({ event: assigned, byteLength, retainedAt: this.now() });
    state.totalBytes += byteLength;
    this.prune(state);
    return assigned;
  }

  resume(scope: ScopeReference, cursor?: Cursor): BrowserEventResume {
    const state = this.scopes.get(scopeKey(scope));
    const latestSequence = state ? state.nextSequence - 1n : 0n;
    const latestRevision = state ? state.nextRevision - 1n : 0n;
    const current = {
      $typeName: 'browser.v1.Cursor' as const,
      scope,
      lastEventId: state?.entries.at(-1)?.event.metadata?.eventId ?? '',
      lastSequence: latestSequence,
      lastRevision: latestRevision,
    };
    if (!state || !cursor) return { kind: 'accepted', cursor: current, events: [] };
    this.prune(state);
    if (cursor.lastSequence >= latestSequence) {
      return { kind: 'accepted', cursor: current, events: [] };
    }
    if (state.latestNonReplayableSequence > cursor.lastSequence) {
      return { kind: 'snapshot-required', cursor: current };
    }
    const earliest = state.entries[0]?.event.metadata?.sequence ?? latestSequence + 1n;
    if (cursor.lastSequence < state.droppedThroughSequence || cursor.lastSequence + 1n < earliest) {
      return { kind: 'gap', cursor: current, earliestAvailableSequence: earliest };
    }
    return {
      kind: 'accepted',
      cursor: current,
      events: state.entries
        .filter((entry) => (entry.event.metadata?.sequence ?? 0n) > cursor.lastSequence)
        .map((entry) => entry.event),
    };
  }

  private prune(state: ScopeState): void {
    const oldestAllowed = this.now() - this.options.maxAgeMs;
    while (
      state.entries.length > 0 &&
      (state.entries[0]!.retainedAt < oldestAllowed ||
        state.totalBytes > this.options.maxBytesPerScope)
    ) {
      const removed = state.entries.shift()!;
      state.totalBytes -= removed.byteLength;
      state.droppedThroughSequence =
        removed.event.metadata?.sequence ?? state.droppedThroughSequence;
    }
  }
}

export const DEFAULT_BROWSER_V1_EVENT_RETENTION = {
  maxAgeMs: 5 * 60_000,
  maxBytesPerScope: 4 * 1024 * 1024,
} as const;

export const browserV1EventRetention = new BrowserV1EventRetention(
  DEFAULT_BROWSER_V1_EVENT_RETENTION,
);
