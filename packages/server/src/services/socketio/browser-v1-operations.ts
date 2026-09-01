import { create, toBinary } from '@bufbuild/protobuf';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import {
  BROWSER_V1_CARRIER_EVENTS,
  BROWSER_V1_SCHEMA_FINGERPRINT,
  browserCarrierPayloadSchema,
  decodeBrowserCarrier,
} from '@funny/shared/browser-protocol';
import {
  Representation,
  ResourceKind,
  StatusCode,
  StatusSchema,
} from '@funny/shared/browser-v1/common';
import {
  OperationOutcomeSchema,
  OperationRequestSchema,
  type OperationRequest,
} from '@funny/shared/browser-v1/operations';
import { CarrierEnvelopeSchema } from '@funny/shared/browser-v1/transport';
import type { Socket } from 'socket.io';

import { authorizer } from '../../lib/server-authorizer.js';
import type { RunnerTerminalPort } from '../runner-ports.js';
import { canUserViewThread } from '../thread-access-check.js';
import {
  browserV1IdempotencyStore,
  type BrowserV1IdempotencyPort,
} from './browser-v1-idempotency.js';
import { observeBrowserV1 } from './browser-v1-observability.js';
import { encodeSocketIoCarrier, encodeSocketIoStatus } from './browser-v1-wire.js';
import { registerSocketHandlersWithSchema, registerSocketRpc } from './router.js';
import { closeThreadForSocket, openThreadForSocket } from './thread-presence.js';

interface ActiveOperation {
  controller: AbortController;
  deadlineTimer?: ReturnType<typeof setTimeout>;
}

interface BrowserOperationState {
  principalUserId?: string;
  assignments?: { operations?: Representation };
  maxPendingOperations?: number;
}

export interface BrowserV1OperationDependencies {
  terminals?: RunnerTerminalPort;
  findAnyRunnerForUser(userId: string): Promise<string | null>;
  getRunnerUserId(runnerId: string): Promise<string | null>;
  idempotency?: BrowserV1IdempotencyPort;
}

function operationFingerprint(request: OperationRequest): string {
  return Buffer.from(
    toBinary(
      OperationRequestSchema,
      create(OperationRequestSchema, {
        resources: request.resources,
        operation: request.operation,
      }),
    ),
  ).toString('base64url');
}

async function canAccessResource(
  principalUserId: string,
  resource: OperationRequest['resources'][number],
  dependencies: BrowserV1OperationDependencies,
): Promise<boolean> {
  switch (resource.kind) {
    case ResourceKind.THREAD:
      return canUserViewThread(resource.id, principalUserId);
    case ResourceKind.PROJECT:
      return authorizer.authorize(principalUserId, 'project', resource.id, 'view');
    case ResourceKind.RUNNER:
      return (await dependencies.getRunnerUserId(resource.id)) === principalUserId;
    case ResourceKind.TERMINAL:
    case ResourceKind.BROWSER_SESSION:
      return (
        !!resource.parentId &&
        (await dependencies.getRunnerUserId(resource.parentId)) === principalUserId
      );
    case ResourceKind.SHARE:
      return !!resource.parentId && canUserViewThread(resource.parentId, principalUserId);
    case ResourceKind.TENANT:
      return resource.id === principalUserId;
    default:
      return false;
  }
}

function operationStatus(requestId: string, code: StatusCode, message: string, retryable = false) {
  return create(OperationOutcomeSchema, {
    requestId,
    outcome: { case: 'status', value: create(StatusSchema, { code, message, retryable }) },
  });
}

function encodeOutcome(outcome: ReturnType<typeof operationStatus>): Buffer {
  return encodeSocketIoCarrier(
    create(CarrierEnvelopeSchema, {
      generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
      payload: {
        case: 'operation',
        value: { payload: { case: 'outcome', value: outcome } },
      },
    }),
  );
}

async function executePtyList(
  principalUserId: string,
  request: OperationRequest,
  dependencies: BrowserV1OperationDependencies,
  signal: AbortSignal,
) {
  const requestId = request.metadata?.requestId ?? '';
  const requestedRunnerId =
    request.operation.case === 'ptyList' ? request.operation.value.runnerId : undefined;
  let runnerId = requestedRunnerId ?? null;
  if (runnerId) {
    const ownerId = await dependencies.getRunnerUserId(runnerId);
    if (ownerId !== principalUserId) {
      return operationStatus(requestId, StatusCode.NOT_FOUND, 'Runner is unavailable');
    }
  } else {
    runnerId = await dependencies.findAnyRunnerForUser(principalUserId);
  }
  if (signal.aborted) {
    return signal.reason === 'deadline'
      ? operationStatus(requestId, StatusCode.DEADLINE_EXCEEDED, 'Operation deadline elapsed')
      : operationStatus(requestId, StatusCode.CANCELLED, 'Operation cancelled');
  }
  if (!runnerId || !dependencies.terminals?.isAvailable(runnerId)) {
    return operationStatus(
      requestId,
      StatusCode.UNAVAILABLE,
      'No compatible runner is available',
      true,
    );
  }

  const terminals = dependencies.terminals
    .listSessions(runnerId, principalUserId)
    .flatMap((session) => {
      if (typeof session.ptyId !== 'string' || typeof session.cwd !== 'string') return [];
      return [
        {
          ptyId: session.ptyId,
          cwd: session.cwd,
          projectId: typeof session.projectId === 'string' ? session.projectId : undefined,
          label: typeof session.label === 'string' ? session.label : undefined,
          shell: typeof session.shell === 'string' ? session.shell : undefined,
          connected: true,
        },
      ];
    });
  return create(OperationOutcomeSchema, {
    requestId,
    outcome: {
      case: 'success',
      value: { result: { case: 'ptyList', value: { terminals } } },
    },
  });
}

async function executeThreadLifecycle(
  socket: Socket,
  principalUserId: string,
  request: OperationRequest,
) {
  const requestId = request.metadata?.requestId ?? '';
  if (request.operation.case !== 'threadOpen' && request.operation.case !== 'threadClose') {
    return operationStatus(
      requestId,
      StatusCode.MALFORMED_INPUT,
      'Expected thread lifecycle operation',
    );
  }
  const open = request.operation.case === 'threadOpen';
  const threadId = request.operation.value.threadId;
  const result = open
    ? await openThreadForSocket(socket, principalUserId, threadId)
    : { authorized: true, revision: closeThreadForSocket(socket, threadId) };
  if (!result.authorized) {
    return operationStatus(requestId, StatusCode.NOT_FOUND, 'Thread is unavailable');
  }
  return create(OperationOutcomeSchema, {
    requestId,
    revisions: [
      {
        resource: { kind: ResourceKind.THREAD, id: threadId },
        revision: result.revision,
        causalRequestId: requestId,
      },
    ],
    outcome: {
      case: 'success',
      value: {
        result: {
          case: 'threadLifecycle',
          value: { threadId, open, presenceRevision: result.revision },
        },
      },
    },
  });
}

export function setupBrowserV1Operations(
  socket: Socket,
  principalUserId: string,
  dependencies: BrowserV1OperationDependencies,
): void {
  const active = new Map<string, ActiveOperation>();

  registerSocketRpc<Uint8Array, typeof browserCarrierPayloadSchema>(
    socket,
    BROWSER_V1_CARRIER_EVENTS.operation,
    {
      payloadSchema: browserCarrierPayloadSchema,
      invalidPayloadResponse: encodeSocketIoStatus(
        create(StatusSchema, {
          code: StatusCode.MALFORMED_INPUT,
          message: 'Expected binary operation payload',
        }),
      ),
      handler: async (_ctx, acknowledge, payload) => {
        const decoded = decodeBrowserCarrier(payload, {
          expectedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
          allowedPayloads: ['operation'],
        });
        if (!decoded.ok || decoded.envelope.payload.case !== 'operation') {
          acknowledge(
            encodeSocketIoStatus(
              decoded.ok
                ? create(StatusSchema, {
                    code: StatusCode.MALFORMED_INPUT,
                    message: 'Invalid operation envelope',
                  })
                : decoded.status,
            ),
          );
          return;
        }
        const operationEnvelope = decoded.envelope.payload.value.payload;
        if (operationEnvelope.case !== 'request') {
          acknowledge(
            encodeOutcome(
              operationStatus('', StatusCode.MALFORMED_INPUT, 'Expected operation request'),
            ),
          );
          return;
        }
        const request = operationEnvelope.value;
        const requestId = request.metadata?.requestId ?? '';
        const negotiated = socket.data.browserV1 as BrowserOperationState | undefined;
        if (
          !negotiated ||
          negotiated.principalUserId !== principalUserId ||
          negotiated.assignments?.operations !== Representation.BROWSER_V1
        ) {
          acknowledge(
            encodeOutcome(
              operationStatus(
                requestId,
                StatusCode.INCOMPATIBLE,
                'Binary operations are not active',
              ),
            ),
          );
          return;
        }
        const resourceAccess = await Promise.all(
          request.resources.map((resource) =>
            canAccessResource(principalUserId, resource, dependencies),
          ),
        );
        if (resourceAccess.some((allowed) => !allowed)) {
          acknowledge(
            encodeOutcome(
              operationStatus(requestId, StatusCode.NOT_FOUND, 'Operation resource is unavailable'),
            ),
          );
          return;
        }
        const maxPending = negotiated.maxPendingOperations ?? 32;
        if (active.size >= maxPending) {
          acknowledge(
            encodeOutcome(
              operationStatus(
                requestId,
                StatusCode.RESOURCE_EXHAUSTED,
                'Too many pending operations',
                true,
              ),
            ),
          );
          return;
        }
        if (active.has(requestId)) {
          acknowledge(
            encodeOutcome(
              operationStatus(requestId, StatusCode.CONFLICT, 'Request is already executing'),
            ),
          );
          return;
        }
        if (
          request.metadata?.deadline &&
          timestampDate(request.metadata.deadline).getTime() <= Date.now()
        ) {
          acknowledge(
            encodeOutcome(
              operationStatus(
                requestId,
                StatusCode.DEADLINE_EXCEEDED,
                'Operation deadline elapsed',
              ),
            ),
          );
          return;
        }

        const controller = new AbortController();
        const startedAt = performance.now();
        const execution: ActiveOperation = { controller };
        if (request.metadata?.deadline) {
          execution.deadlineTimer = setTimeout(
            () => controller.abort('deadline'),
            Math.max(0, timestampDate(request.metadata!.deadline!).getTime() - Date.now()),
          );
        }
        active.set(requestId, execution);
        try {
          const execute = () =>
            request.operation.case === 'ptyList'
              ? executePtyList(principalUserId, request, dependencies, controller.signal)
              : request.operation.case === 'threadOpen' || request.operation.case === 'threadClose'
                ? executeThreadLifecycle(socket, principalUserId, request)
                : Promise.resolve(
                    operationStatus(
                      requestId,
                      StatusCode.PERMISSION_DENIED,
                      'Operation is not enabled for browser clients',
                    ),
                  );
          const idempotencyKey = request.metadata?.idempotencyKey;
          const executionPromise =
            idempotencyKey &&
            (request.operation.case === 'threadOpen' || request.operation.case === 'threadClose')
              ? (dependencies.idempotency ?? browserV1IdempotencyStore)
                  .execute({
                    principalUserId,
                    idempotencyKey,
                    fingerprint: operationFingerprint(request),
                    operation: execute,
                  })
                  .then((result) =>
                    result.kind === 'conflict' || result.kind === 'in-progress'
                      ? operationStatus(
                          requestId,
                          StatusCode.CONFLICT,
                          result.kind === 'conflict'
                            ? 'Idempotency key was already used for a different operation'
                            : 'Idempotent operation is still in progress',
                          result.kind === 'in-progress',
                        )
                      : result.outcome,
                  )
              : execute();
          const outcome = await Promise.race([
            executionPromise,
            new Promise<ReturnType<typeof operationStatus>>((resolve) => {
              controller.signal.addEventListener(
                'abort',
                () => {
                  resolve(
                    controller.signal.reason === 'deadline'
                      ? operationStatus(
                          requestId,
                          StatusCode.DEADLINE_EXCEEDED,
                          'Operation deadline elapsed',
                        )
                      : operationStatus(requestId, StatusCode.CANCELLED, 'Operation cancelled'),
                  );
                },
                { once: true },
              );
            }),
          ]);
          observeBrowserV1({
            event: 'operation',
            status:
              outcome.outcome.case === 'success'
                ? 'ok'
                : outcome.outcome.case === 'status'
                  ? `status-${outcome.outcome.value.code}`
                  : 'status-unknown',
            trafficClass: 'operations',
            latencyMs: performance.now() - startedAt,
          });
          acknowledge(encodeOutcome(outcome));
        } catch {
          observeBrowserV1({
            event: 'operation',
            status: 'internal',
            trafficClass: 'operations',
            latencyMs: performance.now() - startedAt,
          });
          acknowledge(
            encodeOutcome(
              operationStatus(requestId, StatusCode.INTERNAL, 'Operation failed safely', true),
            ),
          );
        } finally {
          if (execution.deadlineTimer) clearTimeout(execution.deadlineTimer);
          active.delete(requestId);
        }
      },
    },
  );

  registerSocketHandlersWithSchema(socket, {
    events: [BROWSER_V1_CARRIER_EVENTS.control],
    payloadSchema: browserCarrierPayloadSchema,
    handler: (_ctx, payload) => {
      const decoded = decodeBrowserCarrier(payload, {
        expectedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
        allowedPayloads: ['control'],
      });
      if (!decoded.ok || decoded.envelope.payload.case !== 'control') return;
      const control = decoded.envelope.payload.value.payload;
      if (control.case !== 'cancel') return;
      active
        .get(control.value.requestId)
        ?.controller.abort(control.value.reason || 'client-cancelled');
    },
  });

  socket.on('disconnect', () => {
    for (const execution of active.values()) execution.controller.abort('disconnect');
    active.clear();
  });
}
