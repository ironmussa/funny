import { create } from '@bufbuild/protobuf';
import {
  BROWSER_V1_CARRIER_EVENTS,
  BROWSER_V1_SCHEMA_FINGERPRINT,
  encodeBrowserCarrier,
} from '@funny/shared/browser-protocol';
import {
  BrowserCapability,
  CursorSchema,
  DeliveryClass,
  Representation,
  ScopeKind,
  ScopeReferenceSchema,
  StatusCode,
  TrafficClass,
} from '@funny/shared/browser-v1/common';
import {
  ApplicationEventSchema,
  SubscriptionOutcomeSchema,
  SubscriptionRequestSchema,
} from '@funny/shared/browser-v1/events';
import { InteractiveEnvelopeSchema } from '@funny/shared/browser-v1/interactive';
import {
  NegotiationOutcomeSchema,
  NegotiationRequestSchema,
} from '@funny/shared/browser-v1/negotiation';
import {
  OperationOutcomeSchema,
  OperationRequestSchema,
} from '@funny/shared/browser-v1/operations';
import { CarrierEnvelopeSchema } from '@funny/shared/browser-v1/transport';
import { describe, expect, test } from 'vitest';

import { SocketIoClientRealtimePort } from '@/lib/realtime/socketio-realtime-port';

class FakeSocket {
  connected = false;
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  readonly handlers = new Map<string, Set<(...args: any[]) => void>>();
  readonly acknowledgements = new Map<string, unknown>();

  on(event: string, listener: (...args: any[]) => void): void {
    const listeners = this.handlers.get(event) ?? new Set();
    listeners.add(listener);
    this.handlers.set(event, listeners);
  }
  off(event: string, listener: (...args: any[]) => void): void {
    this.handlers.get(event)?.delete(listener);
  }
  emit(event: string, payload: unknown): void {
    this.emitted.push({ event, payload });
  }
  timeout(): { emitWithAck: (event: string, payload: unknown) => Promise<unknown> } {
    return {
      emitWithAck: async (event, payload) => {
        this.emitted.push({ event, payload });
        const response = this.acknowledgements.get(event);
        if (response instanceof Error) throw response;
        return response;
      },
    };
  }
  trigger(event: string, payload?: unknown): void {
    for (const listener of this.handlers.get(event) ?? []) listener(payload);
  }
}

function negotiationResponse(assignments: Array<[TrafficClass, Representation]>): Uint8Array {
  const outcome = create(NegotiationOutcomeSchema, {
    outcome: {
      case: 'success',
      value: {
        selectedVersion: { major: 1, minor: 0 },
        generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
        assignments: assignments.map(([trafficClass, representation]) => ({
          trafficClass,
          representation,
        })),
      },
    },
  });
  return encodeBrowserCarrier(
    create(CarrierEnvelopeSchema, {
      generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
      payload: { case: 'negotiationOutcome', value: outcome },
    }),
  );
}

describe('SocketIoClientRealtimePort', () => {
  test('preserves legacy connection lifecycle state and removes handlers on teardown', () => {
    const socket = new FakeSocket();
    const port = new SocketIoClientRealtimePort(socket);
    const phases: string[] = [];
    port.subscribeLifecycle((snapshot) => phases.push(snapshot.phase));

    port.start();
    socket.connected = true;
    socket.trigger('connect');
    socket.trigger('disconnect');
    socket.trigger('connect_error', new Error('offline'));

    expect(phases).toEqual(['connected', 'disconnected', 'error']);
    expect(port.current()).toEqual({ phase: 'error', protocol: 'legacy', error: 'offline' });

    port.stop();
    expect(port.current()).toEqual({ phase: 'idle', protocol: 'legacy', error: null });
    expect(socket.handlers.get('connect')?.size).toBe(0);
    expect(socket.handlers.get('disconnect')?.size).toBe(0);
    expect(socket.handlers.get('connect_error')?.size).toBe(0);
  });

  test('keeps pty:list and thread lifecycle parity behind the neutral operation port', async () => {
    const socket = new FakeSocket();
    socket.acknowledgements.set('pty:list', {
      status: 'ok',
      sessions: [
        {
          ptyId: 'pty-1',
          cwd: '/workspace',
          projectId: 'project-1',
          label: 'Shell',
          shell: '/bin/zsh',
        },
      ],
    });
    const port = new SocketIoClientRealtimePort(socket);
    const ptyOutcome = await port.operate(
      create(OperationRequestSchema, {
        metadata: { requestId: 'pty-list-1' },
        operation: { case: 'ptyList', value: {} },
      }),
    );
    const threadOutcome = await port.operate(
      create(OperationRequestSchema, {
        metadata: { requestId: 'thread-open-1' },
        operation: { case: 'threadOpen', value: { threadId: 'thread-1' } },
      }),
    );

    expect(ptyOutcome).toMatchObject({
      outcome: {
        case: 'success',
        value: {
          result: {
            case: 'ptyList',
            value: {
              terminals: [
                {
                  ptyId: 'pty-1',
                  cwd: '/workspace',
                  projectId: 'project-1',
                  label: 'Shell',
                  shell: '/bin/zsh',
                },
              ],
            },
          },
        },
      },
    });
    expect(threadOutcome).toMatchObject({
      outcome: {
        case: 'success',
        value: { result: { case: 'threadLifecycle', value: { threadId: 'thread-1', open: true } } },
      },
    });
    expect(socket.emitted.map(({ event }) => event)).toEqual(['pty:list', 'thread:open']);
  });

  test('negotiates per-class binary operations and decodes typed acknowledgements', async () => {
    const socket = new FakeSocket();
    socket.acknowledgements.set(
      BROWSER_V1_CARRIER_EVENTS.negotiate,
      negotiationResponse([[TrafficClass.OPERATIONS, Representation.BROWSER_V1]]),
    );
    const operationOutcome = create(OperationOutcomeSchema, {
      requestId: 'thread-close-1',
      outcome: {
        case: 'success',
        value: {
          result: {
            case: 'threadLifecycle',
            value: { threadId: 'thread-1', open: false, presenceRevision: 2n },
          },
        },
      },
    });
    socket.acknowledgements.set(
      BROWSER_V1_CARRIER_EVENTS.operation,
      encodeBrowserCarrier(
        create(CarrierEnvelopeSchema, {
          generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
          payload: {
            case: 'operation',
            value: { payload: { case: 'outcome', value: operationOutcome } },
          },
        }),
      ),
    );
    const port = new SocketIoClientRealtimePort(socket);
    const negotiation = await port.negotiate(
      create(NegotiationRequestSchema, {
        supportedVersions: [{ major: 1, minor: 0 }],
        generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
        capabilities: [BrowserCapability.OPERATIONS],
        client: {
          instanceId: 'client-1',
          applicationVersion: 'test',
          deployment: 'web',
        },
      }),
    );
    const outcome = await port.operate(
      create(OperationRequestSchema, {
        metadata: { requestId: 'thread-close-1' },
        operation: { case: 'threadClose', value: { threadId: 'thread-1' } },
      }),
    );

    expect(negotiation.outcome.case).toBe('success');
    expect(outcome).toEqual(operationOutcome);
    expect(socket.emitted.map(({ event }) => event)).toEqual([
      BROWSER_V1_CARRIER_EVENTS.negotiate,
      BROWSER_V1_CARRIER_EVENTS.operation,
    ]);
  });

  test('rolls pty:list back to the legacy RPC when operations are assigned legacy', async () => {
    const socket = new FakeSocket();
    socket.acknowledgements.set(
      BROWSER_V1_CARRIER_EVENTS.negotiate,
      negotiationResponse([[TrafficClass.OPERATIONS, Representation.LEGACY]]),
    );
    socket.acknowledgements.set('pty:list', { status: 'ok', sessions: [] });
    const port = new SocketIoClientRealtimePort(socket);
    await port.negotiate(
      create(NegotiationRequestSchema, {
        supportedVersions: [{ major: 1, minor: 0 }],
        generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
        capabilities: [BrowserCapability.OPERATIONS],
        client: { instanceId: 'client-1', applicationVersion: 'test', deployment: 'web' },
      }),
    );
    const outcome = await port.operate(
      create(OperationRequestSchema, {
        metadata: { requestId: 'pty-list-rollback' },
        operation: { case: 'ptyList', value: {} },
      }),
    );

    expect(outcome.outcome.case).toBe('success');
    expect(socket.emitted.map(({ event }) => event)).toEqual([
      BROWSER_V1_CARRIER_EVENTS.negotiate,
      'pty:list',
    ]);
  });

  test('maps a binary pty:list acknowledgement timeout to a retryable typed outcome', async () => {
    const socket = new FakeSocket();
    socket.acknowledgements.set(
      BROWSER_V1_CARRIER_EVENTS.negotiate,
      negotiationResponse([[TrafficClass.OPERATIONS, Representation.BROWSER_V1]]),
    );
    socket.acknowledgements.set(BROWSER_V1_CARRIER_EVENTS.operation, new Error('timeout'));
    const port = new SocketIoClientRealtimePort(socket);
    await port.negotiate(
      create(NegotiationRequestSchema, {
        supportedVersions: [{ major: 1, minor: 0 }],
        generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
        capabilities: [BrowserCapability.OPERATIONS],
        client: { instanceId: 'client-1', applicationVersion: 'test', deployment: 'web' },
      }),
    );

    const outcome = await port.operate(
      create(OperationRequestSchema, {
        metadata: { requestId: 'pty-list-timeout' },
        operation: { case: 'ptyList', value: {} },
      }),
    );

    expect(outcome).toMatchObject({
      requestId: 'pty-list-timeout',
      outcome: {
        case: 'status',
        value: { code: StatusCode.DEADLINE_EXCEEDED, retryable: true },
      },
    });
  });

  test('delivers typed events without exposing Socket.IO to consumers', () => {
    const socket = new FakeSocket();
    const port = new SocketIoClientRealtimePort(socket);
    const received: string[] = [];
    const recovery: string[] = [];
    port.start();
    port.onApplicationEvent((event) => received.push(event.metadata?.eventId ?? ''));
    port.onRecoveryRequired((scope) => recovery.push(scope.id));
    const event = create(ApplicationEventSchema, {
      metadata: {
        eventId: 'event-1',
        scope: { kind: ScopeKind.USER, id: 'user-1' },
        sequence: 1n,
        revision: 1n,
      },
      delivery: { deliveryClass: DeliveryClass.SNAPSHOT_RECOVERABLE },
      payload: { case: 'user', value: { eventType: 'profile:updated' } },
    });
    socket.trigger(
      BROWSER_V1_CARRIER_EVENTS.event,
      encodeBrowserCarrier(
        create(CarrierEnvelopeSchema, {
          generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
          payload: { case: 'event', value: { payload: { case: 'event', value: event } } },
        }),
      ),
    );
    socket.trigger(
      BROWSER_V1_CARRIER_EVENTS.event,
      encodeBrowserCarrier(
        create(CarrierEnvelopeSchema, {
          generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
          payload: { case: 'event', value: { payload: { case: 'event', value: event } } },
        }),
      ),
    );
    const gapEvent = create(ApplicationEventSchema, {
      metadata: {
        eventId: 'event-3',
        scope: { kind: ScopeKind.USER, id: 'user-1' },
        sequence: 3n,
        revision: 3n,
      },
      delivery: { deliveryClass: DeliveryClass.SNAPSHOT_RECOVERABLE },
      payload: { case: 'user', value: { eventType: 'profile:updated' } },
    });
    socket.trigger(
      BROWSER_V1_CARRIER_EVENTS.event,
      encodeBrowserCarrier(
        create(CarrierEnvelopeSchema, {
          generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
          payload: { case: 'event', value: { payload: { case: 'event', value: gapEvent } } },
        }),
      ),
    );

    expect(received).toEqual(['event-1']);
    expect(recovery).toEqual(['user-1']);
    port.stop();
    expect(socket.handlers.get(BROWSER_V1_CARRIER_EVENTS.event)?.size).toBe(0);
  });

  test('subscribes with a binary cursor after event rollout assignment', async () => {
    const socket = new FakeSocket();
    socket.acknowledgements.set(
      BROWSER_V1_CARRIER_EVENTS.negotiate,
      negotiationResponse([[TrafficClass.EVENTS, Representation.BROWSER_V1]]),
    );
    const scope = create(ScopeReferenceSchema, { kind: ScopeKind.USER, id: 'user-1' });
    const acceptedCursor = create(CursorSchema, {
      scope,
      lastEventId: 'event-4',
      lastSequence: 4n,
      lastRevision: 4n,
    });
    const outcome = create(SubscriptionOutcomeSchema, {
      scope,
      outcome: {
        case: 'accepted',
        value: { scope, acceptedCursor },
      },
    });
    socket.acknowledgements.set(
      BROWSER_V1_CARRIER_EVENTS.event,
      encodeBrowserCarrier(
        create(CarrierEnvelopeSchema, {
          generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
          payload: {
            case: 'event',
            value: { payload: { case: 'subscriptionOutcome', value: outcome } },
          },
        }),
      ),
    );
    const port = new SocketIoClientRealtimePort(socket);
    await port.negotiate(
      create(NegotiationRequestSchema, {
        supportedVersions: [{ major: 1, minor: 0 }],
        generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
        capabilities: [BrowserCapability.EVENTS],
        client: {
          instanceId: 'client-1',
          applicationVersion: 'test',
          deployment: 'web',
        },
      }),
    );
    const result = await port.subscribeScope(
      create(SubscriptionRequestSchema, {
        scope,
        cursor: create(CursorSchema, { scope, lastSequence: 2n, lastRevision: 2n }),
      }),
    );

    expect(result).toEqual(outcome);
    expect(socket.emitted.map(({ event }) => event)).toEqual([
      BROWSER_V1_CARRIER_EVENTS.negotiate,
      BROWSER_V1_CARRIER_EVENTS.event,
    ]);

    await port.negotiate(
      create(NegotiationRequestSchema, {
        supportedVersions: [{ major: 1, minor: 0 }],
        generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
        capabilities: [BrowserCapability.EVENTS],
        client: {
          instanceId: 'client-1',
          applicationVersion: 'test',
          deployment: 'web',
        },
      }),
    );
    expect(socket.emitted.map(({ event }) => event)).toEqual([
      BROWSER_V1_CARRIER_EVENTS.negotiate,
      BROWSER_V1_CARRIER_EVENTS.event,
      BROWSER_V1_CARRIER_EVENTS.negotiate,
      BROWSER_V1_CARRIER_EVENTS.event,
    ]);
  });

  test('surfaces a typed subscription revocation for targeted recovery', () => {
    const socket = new FakeSocket();
    const port = new SocketIoClientRealtimePort(socket);
    const recovered: string[] = [];
    port.start();
    port.onRecoveryRequired((scope) => recovered.push(`${scope.kind}:${scope.id}`));
    const scope = create(ScopeReferenceSchema, {
      kind: ScopeKind.THREAD_STREAM,
      id: 'thread-1',
    });
    const outcome = create(SubscriptionOutcomeSchema, {
      scope,
      outcome: {
        case: 'status',
        value: { code: StatusCode.REVOKED, message: 'Thread subscription is no longer authorized' },
      },
    });

    socket.trigger(
      BROWSER_V1_CARRIER_EVENTS.event,
      encodeBrowserCarrier(
        create(CarrierEnvelopeSchema, {
          generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
          payload: {
            case: 'event',
            value: { payload: { case: 'subscriptionOutcome', value: outcome } },
          },
        }),
      ),
    );

    expect(recovered).toEqual([`${ScopeKind.THREAD_STREAM}:thread-1`]);
  });

  test('delivers ordered terminal output and reports an explicit output gap', () => {
    const socket = new FakeSocket();
    const port = new SocketIoClientRealtimePort(socket);
    const sequences: bigint[] = [];
    const recovered: string[] = [];
    port.start();
    port.onInteractive((message) => {
      if (message.payload.case === 'terminal' && message.payload.value.payload.case === 'output') {
        sequences.push(message.payload.value.payload.value.sequence);
      }
    });
    port.onRecoveryRequired((scope) => recovered.push(`${scope.kind}:${scope.id}`));
    const output = (sequence: bigint) =>
      encodeBrowserCarrier(
        create(CarrierEnvelopeSchema, {
          generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
          payload: {
            case: 'interactive',
            value: create(InteractiveEnvelopeSchema, {
              delivery: { deliveryClass: DeliveryClass.DURABLE },
              payload: {
                case: 'terminal',
                value: {
                  terminalId: 'pty-1',
                  payload: { case: 'output', value: { sequence, data: new Uint8Array([65]) } },
                },
              },
            }),
          },
        }),
      );

    socket.trigger(BROWSER_V1_CARRIER_EVENTS.interactive, output(1n));
    socket.trigger(BROWSER_V1_CARRIER_EVENTS.interactive, output(1n));
    socket.trigger(BROWSER_V1_CARRIER_EVENTS.interactive, output(3n));

    expect(sequences).toEqual([1n]);
    expect(recovered).toEqual([`${ScopeKind.TERMINAL}:pty-1`]);
  });

  test('rolls terminal and browser-session classes back independently without replay', async () => {
    const socket = new FakeSocket();
    socket.acknowledgements.set(
      BROWSER_V1_CARRIER_EVENTS.negotiate,
      negotiationResponse([
        [TrafficClass.TERMINAL, Representation.LEGACY],
        [TrafficClass.BROWSER_SESSION, Representation.LEGACY],
      ]),
    );
    const port = new SocketIoClientRealtimePort(socket);
    await port.negotiate(
      create(NegotiationRequestSchema, {
        supportedVersions: [{ major: 1, minor: 0 }],
        generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
        capabilities: [BrowserCapability.TERMINAL, BrowserCapability.BROWSER_SESSION],
        client: { instanceId: 'rollback', applicationVersion: 'test', deployment: 'web' },
      }),
    );
    port.sendInteractive(
      create(InteractiveEnvelopeSchema, {
        delivery: { deliveryClass: DeliveryClass.AT_MOST_ONCE },
        payload: {
          case: 'terminal',
          value: {
            terminalId: 'pty-1',
            payload: {
              case: 'write',
              value: { inputOrdinal: 1n, data: new TextEncoder().encode('pwd\n') },
            },
          },
        },
      }),
    );
    port.sendInteractive(
      create(InteractiveEnvelopeSchema, {
        metadata: { requestId: 'nav-1' },
        delivery: { deliveryClass: DeliveryClass.AT_MOST_ONCE },
        payload: {
          case: 'browserSession',
          value: {
            browserSessionId: 'browser-1',
            payload: { case: 'historyNavigation', value: { action: 'back' } },
          },
        },
      }),
    );

    expect(socket.emitted).toMatchObject([
      { event: BROWSER_V1_CARRIER_EVENTS.negotiate },
      { event: 'pty:write', payload: { id: 'pty-1', data: 'pwd\n' } },
      {
        event: 'browser-session:nav',
        payload: { sessionId: 'browser-1', requestId: 'nav-1', action: 'back' },
      },
    ]);
  });
});
