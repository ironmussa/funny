import { create } from '@bufbuild/protobuf';
import {
  BROWSER_V1_CARRIER_EVENTS,
  BROWSER_V1_SCHEMA_FINGERPRINT,
} from '@funny/shared/browser-protocol';
import {
  Representation,
  ScopeKind,
  ScopeReferenceSchema,
  StatusCode,
  StatusSchema,
} from '@funny/shared/browser-v1/common';
import { EventEnvelopeSchema, SubscriptionOutcomeSchema } from '@funny/shared/browser-v1/events';
import { CarrierEnvelopeSchema } from '@funny/shared/browser-v1/transport';
import type { Server as SocketIOServer, Socket } from 'socket.io';

import type { BrowserEventSink, BrowserPublication } from '../runner-ports.js';
import { browserV1EventRetention } from './browser-v1-event-retention.js';
import { observeBrowserV1 } from './browser-v1-observability.js';
import { BrowserV1OutboundQueue } from './browser-v1-outbound-queue.js';
import { encodeSocketIoCarrier } from './browser-v1-wire.js';
import { encodeSocketIoStatus } from './browser-v1-wire.js';

type BrowserV1Event = NonNullable<BrowserPublication['browserV1']>;

export const threadStreamRoom = (threadId: string): string => `thread:${threadId}:stream`;
export const threadPresenceRoom = (threadId: string): string => `thread:${threadId}:presence`;

export interface BrowserSinkTelemetry {
  logicalType: string;
  trafficClass: BrowserPublication['trafficClass'];
  representation: 'legacy' | 'browser.v1' | 'shadow';
  dispatched: boolean;
  payloadBytes?: number;
  queueDepth?: number;
  reason?: string;
}

/** Socket.IO adapter for browser-only publication and room membership. */
export class SocketIoBrowserEventSink implements BrowserEventSink {
  private readonly outbound = new WeakMap<Socket, BrowserV1OutboundQueue>();

  constructor(
    private readonly io: SocketIOServer,
    private readonly options: {
      selectRepresentation?: (socket: Socket, publication: BrowserPublication) => Representation;
      telemetry?: (event: BrowserSinkTelemetry) => void;
    } = {},
  ) {}

  private recordTelemetry(event: BrowserSinkTelemetry): void {
    this.options.telemetry?.(event);
    observeBrowserV1({
      event: event.reason === 'exhausted' || event.reason === 'dropped' ? 'queue' : 'dispatch',
      status: event.dispatched || event.representation === 'shadow' ? 'ok' : 'rejected',
      representation: event.representation,
      trafficClass: event.trafficClass,
      logicalType: event.logicalType,
      reason: event.reason,
      payloadBytes: event.payloadBytes,
      queueDepth: event.queueDepth,
    });
  }

  publish(publication: BrowserPublication): void {
    const browserV1Event = publication.browserV1
      ? browserV1EventRetention.append(this.protocolScope(publication), publication.browserV1)
      : undefined;
    for (const socket of this.targetSockets(publication)) {
      this.publishToSocket(socket, publication, browserV1Event);
    }
  }

  private publishToSocket(
    socket: Socket,
    publication: BrowserPublication,
    browserV1Event: BrowserV1Event | undefined,
  ): void {
    const selected = this.selectRepresentation(socket, publication);
    // Browser sessions have no legacy representation: a socket that did not
    // negotiate browser.v1 gets none of them.
    if (publication.trafficClass === 'browserSession' && selected !== Representation.BROWSER_V1) {
      return;
    }
    const hasBrowserV1Payload = Boolean(browserV1Event ?? publication.browserV1Interactive);
    if (selected === Representation.BROWSER_V1 && hasBrowserV1Payload) {
      this.sendBrowserV1(socket, publication, this.encodePublication(publication, browserV1Event));
      return;
    }
    this.publishLegacy(socket, publication, selected, hasBrowserV1Payload, browserV1Event);
  }

  /**
   * Emit the legacy representation. A shadow socket also gets the browser.v1
   * payload measured (never sent); a browser.v1 socket only lands here when
   * the publication carries no browser.v1 payload.
   */
  private publishLegacy(
    socket: Socket,
    publication: BrowserPublication,
    selected: Representation,
    hasBrowserV1Payload: boolean,
    browserV1Event: BrowserV1Event | undefined,
  ): void {
    if (selected === Representation.SHADOW && hasBrowserV1Payload) {
      this.recordTelemetry({
        ...this.telemetryOf(publication),
        representation: 'shadow',
        dispatched: false,
        payloadBytes: this.encodePublication(publication, browserV1Event).byteLength,
      });
    } else if (selected === Representation.BROWSER_V1) {
      this.recordTelemetry({
        ...this.telemetryOf(publication),
        representation: 'legacy',
        dispatched: true,
        reason: 'browser-v1-payload-unavailable',
      });
    }
    socket.emit(publication.logicalType, publication.legacyEvent);
    if (selected !== Representation.SHADOW) {
      this.recordTelemetry({
        ...this.telemetryOf(publication),
        representation: 'legacy',
        dispatched: true,
      });
    }
  }

  private sendBrowserV1(socket: Socket, publication: BrowserPublication, payload: Buffer): void {
    const queued = this.dispatchBrowserV1(socket, publication, payload);
    this.recordTelemetry({
      ...this.telemetryOf(publication),
      representation: 'browser.v1',
      dispatched: queued.result === 'accepted' || queued.result === 'coalesced',
      payloadBytes: payload.byteLength,
      queueDepth: queued.queueDepth,
      reason: queued.result === 'accepted' ? undefined : queued.result,
    });
  }

  private encodePublication(
    publication: BrowserPublication,
    browserV1Event: BrowserV1Event | undefined,
  ): Buffer {
    return browserV1Event
      ? this.encodeEvent(browserV1Event)
      : this.encodeInteractive(publication.browserV1Interactive!);
  }

  private telemetryOf(
    publication: BrowserPublication,
  ): Pick<BrowserSinkTelemetry, 'logicalType' | 'trafficClass'> {
    return { logicalType: publication.logicalType, trafficClass: publication.trafficClass };
  }

  toUser(userId: string, event: Record<string, unknown>): void {
    this.io.of('/').to(`user:${userId}`).emit(this.eventType(event), event);
  }

  toAll(event: Record<string, unknown>): void {
    this.io.of('/').emit(this.eventType(event), event);
  }

  toThreadStream(threadId: string, event: Record<string, unknown>): void {
    this.io.of('/').to(threadStreamRoom(threadId)).emit(this.eventType(event), event);
  }

  toThreadPresence(threadId: string, event: Record<string, unknown>): void {
    this.io.of('/').to(threadPresenceRoom(threadId)).emit(this.eventType(event), event);
  }

  toThreadViewers(threadId: string, event: Record<string, unknown>): void {
    this.toThreadPresence(threadId, event);
  }

  evictFromThread(userId: string, threadId: string): void {
    const namespace = this.io.of('/');
    const userSocketIds = namespace.adapter.rooms.get(`user:${userId}`) ?? new Set<string>();
    for (const socketId of userSocketIds) {
      const socket = namespace.sockets.get(socketId);
      const assignments = socket?.data.browserV1?.assignments as
        | { events?: Representation }
        | undefined;
      if (socket && assignments?.events === Representation.BROWSER_V1) {
        for (const kind of [ScopeKind.THREAD_STREAM, ScopeKind.THREAD_PRESENCE]) {
          socket.emit(BROWSER_V1_CARRIER_EVENTS.event, this.encodeRevocation(kind, threadId));
        }
      }
    }
    this.io
      .of('/')
      .in(`user:${userId}`)
      .socketsLeave([threadStreamRoom(threadId), threadPresenceRoom(threadId)]);
  }

  connectedUserIds(): string[] {
    const userIds: string[] = [];
    for (const [room] of this.io.of('/').adapter.rooms) {
      if (room.startsWith('user:')) userIds.push(room.slice(5));
    }
    return userIds;
  }

  stats(): { browserClients: number; browserUsers: number } {
    return {
      browserClients: this.io.of('/').sockets.size,
      browserUsers: this.connectedUserIds().length,
    };
  }

  private eventType(event: Record<string, unknown>): string {
    return (event.type as string) || 'event';
  }

  private selectRepresentation(socket: Socket, publication: BrowserPublication): Representation {
    if (!publication.browserV1 && !publication.browserV1Interactive) {
      return Representation.LEGACY;
    }
    if (this.options.selectRepresentation) {
      return this.options.selectRepresentation(socket, publication);
    }
    const state = socket.data.browserV1 as
      | { assignments?: Partial<Record<BrowserPublication['trafficClass'], Representation>> }
      | undefined;
    return state?.assignments?.[publication.trafficClass] ?? Representation.LEGACY;
  }

  private targetSockets(publication: BrowserPublication): Socket[] {
    const namespace = this.io.of('/');
    if (publication.scope.kind === 'all') return [...namespace.sockets.values()];

    let room: string;
    switch (publication.scope.kind) {
      case 'user':
        room = `user:${publication.scope.userId}`;
        break;
      case 'thread-stream':
        room = threadStreamRoom(publication.scope.threadId);
        break;
      case 'thread-presence':
      case 'thread-viewers':
        room = threadPresenceRoom(publication.scope.threadId);
        break;
    }
    const socketIds = namespace.adapter.rooms.get(room) ?? new Set<string>();
    const sockets: Socket[] = [];
    for (const socketId of socketIds) {
      const socket = namespace.sockets.get(socketId);
      if (socket) sockets.push(socket);
    }
    return sockets;
  }

  private protocolScope(publication: BrowserPublication) {
    const existing = publication.browserV1?.metadata?.scope;
    if (existing) return existing;
    switch (publication.scope.kind) {
      case 'user':
        return create(ScopeReferenceSchema, {
          kind: ScopeKind.USER,
          id: publication.scope.userId,
        });
      case 'thread-stream':
        return create(ScopeReferenceSchema, {
          kind: ScopeKind.THREAD_STREAM,
          id: publication.scope.threadId,
        });
      case 'thread-presence':
      case 'thread-viewers':
        return create(ScopeReferenceSchema, {
          kind: ScopeKind.THREAD_PRESENCE,
          id: publication.scope.threadId,
        });
      case 'all':
        return create(ScopeReferenceSchema, { kind: ScopeKind.TENANT, id: 'all' });
    }
  }

  private encodeEvent(event: NonNullable<BrowserPublication['browserV1']>): Buffer {
    return encodeSocketIoCarrier(
      create(CarrierEnvelopeSchema, {
        generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
        payload: {
          case: 'event',
          value: { payload: { case: 'event', value: event } },
        },
      }),
    );
  }

  private encodeInteractive(
    interactive: NonNullable<BrowserPublication['browserV1Interactive']>,
  ): Buffer {
    return encodeSocketIoCarrier(
      create(CarrierEnvelopeSchema, {
        generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
        payload: { case: 'interactive', value: interactive },
      }),
    );
  }

  private encodeRevocation(kind: ScopeKind, threadId: string): Buffer {
    const scope = create(ScopeReferenceSchema, { kind, id: threadId });
    return encodeSocketIoCarrier(
      create(CarrierEnvelopeSchema, {
        generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
        payload: {
          case: 'event',
          value: create(EventEnvelopeSchema, {
            payload: {
              case: 'subscriptionOutcome',
              value: create(SubscriptionOutcomeSchema, {
                scope,
                outcome: {
                  case: 'status',
                  value: create(StatusSchema, {
                    code: StatusCode.REVOKED,
                    message: 'Thread subscription is no longer authorized',
                  }),
                },
              }),
            },
          }),
        },
      }),
    );
  }

  private dispatchBrowserV1(
    socket: Socket,
    publication: BrowserPublication,
    payload: Buffer,
  ): {
    result: 'accepted' | 'coalesced' | 'dropped' | 'exhausted';
    queueDepth: number;
  } {
    let queue = this.outbound.get(socket);
    if (!queue) {
      queue = new BrowserV1OutboundQueue({
        maxMessagesPerClass: 256,
        maxBytesPerClass: 4 * 1024 * 1024,
        maxConcurrentPerClass: 4,
        reservedControlMessages: 16,
      });
      this.outbound.set(socket, queue);
    }
    const deliveryClass = publication.delivery.class;
    const result = queue.enqueue(publication.trafficClass, {
      byteLength: payload.byteLength,
      coalescingKey: publication.delivery.coalescingKey,
      droppable: deliveryClass === 'coalescible' || deliveryClass === 'volatile',
      priority:
        (publication.delivery.priority ?? 0) >= 100
          ? 'control'
          : deliveryClass === 'coalescible' || deliveryClass === 'volatile'
            ? 'bulk'
            : 'normal',
      send: () => {
        socket.emit(
          publication.trafficClass === 'events'
            ? BROWSER_V1_CARRIER_EVENTS.event
            : BROWSER_V1_CARRIER_EVENTS.interactive,
          payload,
        );
        const transport = socket.conn?.transport as
          | { writable?: boolean; once?: (event: string, listener: () => void) => void }
          | undefined;
        if (transport?.writable !== false || !transport.once) return;
        return new Promise<void>((resolve) => {
          transport.once?.('drain', resolve);
          socket.once('disconnect', () => resolve());
        });
      },
    });
    if (result === 'exhausted') {
      socket.emit(
        BROWSER_V1_CARRIER_EVENTS.control,
        encodeSocketIoStatus(
          create(StatusSchema, {
            code: StatusCode.RESOURCE_EXHAUSTED,
            message: 'Browser event queue is exhausted; resynchronization is required',
            retryable: true,
          }),
        ),
      );
    }
    return { result, queueDepth: queue.stats(publication.trafficClass).messages };
  }
}
