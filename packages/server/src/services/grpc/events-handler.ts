import { canonicalJson } from '@funny/shared/lib/canonical-json';
import { FailureCode } from '@funny/shared/runner-v2/common';

import { db } from '../../db/index.js';
import { threadEvents } from '../../db/schema.js';
import { relayToThreadStream, relayToUser } from '../browser-events.js';
import { threadBelongsToUser } from '../thread-registry.js';
import {
  SqlEventReceiptStore,
  type EventReceiptStore,
  type EventScopeIdentity,
} from './event-receipts.js';
import type {
  RunnerGrpcCall,
  RunnerGrpcCallContext,
  RunnerGrpcHandler,
} from './runner-grpc-server.js';
import type { RunnerGrpcSessionRegistry } from './session-registry.js';
import { observeRunnerGrpc } from './transport-observability.js';

type WireRequest = Record<string, any> & {
  session?: { sessionEpoch?: string | number | bigint };
  scope?: { threadId?: string; executionId?: string };
  sequence?: string | number | bigint;
  event?: {
    eventType?: string;
    data?: unknown;
    durability?: number;
    occurredAt?: { seconds?: string | number | bigint; nanos?: number };
  };
  gap?: {
    requestedSequence?: string | number | bigint;
    earliestAvailableSequence?: string | number | bigint;
    reason?: string;
  };
};

export interface AcceptedAgentEvent {
  scope: EventScopeIdentity;
  sequence: bigint;
  eventType: string;
  data: Record<string, unknown>;
  durability: number;
  occurredAt?: { seconds?: string | number | bigint; nanos?: number };
}

export interface EventGapNotice {
  scope: EventScopeIdentity;
  requestedSequence: bigint;
  earliestAvailableSequence: bigint;
  reason: string;
}

export interface EventsHandlerOptions {
  receipts?: EventReceiptStore;
  applyEvent?: (context: RunnerGrpcCallContext, event: AcceptedAgentEvent) => Promise<void>;
  resynchronizeThread?: (context: RunnerGrpcCallContext, gap: EventGapNotice) => Promise<void>;
  publishEvent?: (context: RunnerGrpcCallContext, event: AcceptedAgentEvent) => void;
}

function defaultPublishEvent(context: RunnerGrpcCallContext, event: AcceptedAgentEvent): void {
  const browserEvent = {
    type: event.eventType,
    threadId: event.scope.threadId,
    data: event.data,
  };
  if (context.principal.userId) relayToUser(context.principal.userId, browserEvent);
  relayToThreadStream(event.scope.threadId, browserEvent);
}

function decodeValue(value: any): unknown {
  if (!value || typeof value !== 'object' || typeof value.kind !== 'string') return value;
  switch (value.kind) {
    case 'nullValue':
      return null;
    case 'numberValue':
      return value.numberValue;
    case 'stringValue':
      return value.stringValue;
    case 'boolValue':
      return value.boolValue;
    case 'structValue':
      return decodeStruct(value.structValue);
    case 'listValue':
      return (value.listValue?.values ?? []).map(decodeValue);
    default:
      return null;
  }
}

function decodeStruct(value: any): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  if (!value.fields || typeof value.fields !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value.fields).map(([key, field]) => [key, decodeValue(field)]),
  );
}

function parseUnsigned(value: unknown): bigint | null {
  try {
    const parsed = BigInt(value as string | number | bigint);
    return parsed >= 0n && parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? parsed : null;
  } catch {
    return null;
  }
}

function requestKind(request: WireRequest): 'event' | 'gap' | undefined {
  if (request.event) return 'event';
  if (request.gap) return 'gap';
  return undefined;
}

function responseBase(epoch: bigint, scope?: EventScopeIdentity): Record<string, unknown> {
  return {
    session: { sessionEpoch: epoch.toString() },
    ...(scope ? { scope } : {}),
  };
}

async function defaultApplyEvent(
  context: RunnerGrpcCallContext,
  event: AcceptedAgentEvent,
): Promise<void> {
  // Transient chunks need sequencing but not central persistence. Durable and
  // terminal events are inserted in the same database transaction as receipt
  // advancement, using a deterministic ID for crash-safe duplicate handling.
  if (event.durability < 2) return;
  await db
    .insert(threadEvents)
    .values({
      id: `grpc:${context.principal.runnerId}:${event.scope.executionId}:${event.sequence}`,
      threadId: event.scope.threadId,
      eventType: event.eventType,
      data: canonicalJson(event.data),
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing({ target: threadEvents.id });
}

class ThreadResynchronizationDenied extends Error {}

async function defaultResynchronizeThread(
  context: RunnerGrpcCallContext,
  gap: EventGapNotice,
): Promise<void> {
  if (
    !context.principal.userId ||
    !(await threadBelongsToUser(gap.scope.threadId, context.principal.userId))
  ) {
    throw new ThreadResynchronizationDenied();
  }
  const event = {
    type: 'thread:updated',
    threadId: gap.scope.threadId,
    data: { resync: true },
  };
  if (context.principal.userId) relayToUser(context.principal.userId, event);
  relayToThreadStream(gap.scope.threadId, event);
}

export function createEventsHandler(
  sessions: RunnerGrpcSessionRegistry,
  options: EventsHandlerOptions = {},
): RunnerGrpcHandler {
  const receipts = options.receipts ?? new SqlEventReceiptStore();
  const applyEvent = options.applyEvent ?? defaultApplyEvent;
  const resynchronizeThread = options.resynchronizeThread ?? defaultResynchronizeThread;
  const publishEvent = options.publishEvent ?? defaultPublishEvent;

  return (call: RunnerGrpcCall, context: RunnerGrpcCallContext) => {
    let closed = false;
    const close = () => {
      closed = true;
    };
    call.once('cancelled', close);
    call.once('close', close);
    call.once('error', close);

    call.on('data', (request: WireRequest) => {
      void (async () => {
        const epoch = parseUnsigned(request.session?.sessionEpoch) ?? 0n;
        const scope =
          request.scope?.threadId && request.scope.executionId
            ? { threadId: request.scope.threadId, executionId: request.scope.executionId }
            : undefined;
        const sendFailure = (code: FailureCode, message: string, retryable = false) => {
          if (!closed) {
            call.write({
              ...responseBase(epoch, scope),
              failure: { code, message, retryable },
            });
          }
        };

        if (!sessions.isActive(context.principal.runnerId, epoch)) {
          sendFailure(FailureCode.UNAVAILABLE, 'runner session is not active', true);
          return;
        }
        if (!scope) {
          sendFailure(FailureCode.INVALID_ARGUMENT, 'event thread and execution IDs are required');
          return;
        }
        const sequence = parseUnsigned(request.sequence);
        if (sequence === null || sequence === 0n) {
          sendFailure(FailureCode.INVALID_ARGUMENT, 'event sequence must be a positive integer');
          return;
        }

        const kind = requestKind(request);
        if (kind === 'gap') {
          const requestedSequence = parseUnsigned(request.gap?.requestedSequence);
          const earliestAvailableSequence = parseUnsigned(request.gap?.earliestAvailableSequence);
          if (
            requestedSequence === null ||
            requestedSequence === 0n ||
            earliestAvailableSequence === null ||
            earliestAvailableSequence <= requestedSequence
          ) {
            sendFailure(FailureCode.INVALID_ARGUMENT, 'event gap sequence range is invalid');
            return;
          }
          const reason = request.gap?.reason ?? 'event replay history is unavailable';
          const gap = {
            scope,
            requestedSequence,
            earliestAvailableSequence,
            reason,
          };
          try {
            await receipts.resynchronize(
              {
                runnerId: context.principal.runnerId,
                scope,
                missingThroughSequence: earliestAvailableSequence - 1n,
              },
              () => resynchronizeThread(context, gap),
            );
          } catch (error) {
            if (error instanceof ThreadResynchronizationDenied) {
              sendFailure(FailureCode.PERMISSION_DENIED, 'event scope is not authorized');
              return;
            }
            throw error;
          }
          if (!closed) {
            call.write({
              ...responseBase(epoch, scope),
              gap: {
                requestedSequence: requestedSequence.toString(),
                earliestAvailableSequence: earliestAvailableSequence.toString(),
                reason,
              },
            });
            observeRunnerGrpc({
              event: 'event-gap',
              streamClass: 'events',
              status: 'gap',
              runnerId: context.principal.runnerId,
              sessionEpoch: epoch,
              gapSize: Number(earliestAvailableSequence - requestedSequence),
            });
          }
          return;
        }
        if (kind !== 'event' || !request.event?.eventType) {
          sendFailure(FailureCode.INVALID_ARGUMENT, 'an agent event or replay gap is required');
          return;
        }

        const event: AcceptedAgentEvent = {
          scope,
          sequence,
          eventType: request.event.eventType,
          data: decodeStruct(request.event.data),
          durability: request.event.durability ?? 0,
          ...(request.event.occurredAt ? { occurredAt: request.event.occurredAt } : {}),
        };
        const result = await receipts.accept(
          { runnerId: context.principal.runnerId, scope, sequence },
          () => applyEvent(context, event),
        );
        if (result.kind === 'accepted') publishEvent(context, event);
        if (closed) return;
        if (result.kind === 'out_of_order') {
          call.write({
            ...responseBase(epoch, scope),
            gap: {
              requestedSequence: sequence.toString(),
              earliestAvailableSequence: (result.highestContiguousSequence + 1n).toString(),
              reason: 'event sequence is not contiguous',
            },
          });
          observeRunnerGrpc({
            event: 'event-gap',
            streamClass: 'events',
            status: 'out_of_order',
            runnerId: context.principal.runnerId,
            sessionEpoch: epoch,
            gapSize: Number(sequence - result.highestContiguousSequence),
          });
          return;
        }
        call.write({
          ...responseBase(epoch, scope),
          accepted: { highestContiguousSequence: result.highestContiguousSequence.toString() },
        });
        observeRunnerGrpc({
          event: 'event-receipt',
          streamClass: 'events',
          status: 'ok',
          runnerId: context.principal.runnerId,
          sessionEpoch: epoch,
          receiptLag: Math.max(0, Number(sequence - result.highestContiguousSequence)),
        });
      })().catch(() => {
        if (!closed) {
          call.write({
            failure: {
              code: FailureCode.INTERNAL,
              message: 'event could not be durably accepted',
              retryable: true,
            },
          });
        }
      });
    });
  };
}
