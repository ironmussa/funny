import { describe, expect, mock, test } from 'bun:test';

import { create, fromBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import {
  BROWSER_V1_CARRIER_EVENTS,
  BROWSER_V1_SCHEMA_FINGERPRINT,
  encodeBrowserCarrier,
} from '@funny/shared/browser-protocol';
import { Representation, ResourceKind, StatusCode } from '@funny/shared/browser-v1/common';
import { OperationRequestSchema } from '@funny/shared/browser-v1/operations';
import { CarrierEnvelopeSchema } from '@funny/shared/browser-v1/transport';

import { setupBrowserV1Operations } from '../../services/socketio/browser-v1-operations.js';
import { FakeRunnerTerminalPort } from '../helpers/runner-port-fakes.js';
import { createMockSocket } from '../helpers/socketio-test-mocks.js';

function operationWire(options?: {
  requestId?: string;
  runnerId?: string;
  deadline?: Date;
  resources?: Array<{ kind: ResourceKind; id: string; parentId?: string }>;
}) {
  return encodeBrowserCarrier(
    create(CarrierEnvelopeSchema, {
      generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
      payload: {
        case: 'operation',
        value: {
          payload: {
            case: 'request',
            value: create(OperationRequestSchema, {
              metadata: {
                requestId: options?.requestId ?? 'request-1',
                deadline: options?.deadline ? timestampFromDate(options.deadline) : undefined,
              },
              resources: options?.resources,
              operation: { case: 'ptyList', value: { runnerId: options?.runnerId } },
            }),
          },
        },
      },
    }),
  );
}

function controlWire(requestId: string) {
  return encodeBrowserCarrier(
    create(CarrierEnvelopeSchema, {
      generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
      payload: {
        case: 'control',
        value: {
          payload: { case: 'cancel', value: { requestId, reason: 'test-cancel' } },
        },
      },
    }),
  );
}

function decodeOutcome(wire: Uint8Array) {
  const envelope = fromBinary(CarrierEnvelopeSchema, wire);
  if (envelope.payload.case !== 'operation' || envelope.payload.value.payload.case !== 'outcome') {
    throw new Error('Expected operation outcome');
  }
  return envelope.payload.value.payload.value;
}

function activeSocket(maxPendingOperations = 32) {
  return createMockSocket({
    data: {
      browserV1: {
        principalUserId: 'user-1',
        assignments: { operations: Representation.BROWSER_V1 },
        maxPendingOperations,
      },
    },
  } as any);
}

describe('browser.v1 operations carrier', () => {
  test('returns pty:list as a typed binary acknowledgement with field parity', async () => {
    const terminals = new FakeRunnerTerminalPort();
    terminals.available.add('runner-1');
    terminals.sessions.set('runner-1\0user-1', [
      {
        ptyId: 'pty-1',
        cwd: '/workspace',
        projectId: 'project-1',
        label: 'Shell',
        shell: '/bin/zsh',
      },
    ]);
    const socket = activeSocket();
    setupBrowserV1Operations(socket, 'user-1', {
      terminals,
      findAnyRunnerForUser: async () => 'runner-1',
      getRunnerUserId: async () => 'user-1',
    });

    let response: Uint8Array | undefined;
    await socket.triggerRpc<Uint8Array>(
      BROWSER_V1_CARRIER_EVENTS.operation,
      operationWire(),
      (wire) => {
        response = wire;
      },
    );

    expect(decodeOutcome(response!)).toMatchObject({
      requestId: 'request-1',
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
  });

  test('returns a retryable unavailable outcome when pty:list has no runner', async () => {
    const socket = activeSocket();
    setupBrowserV1Operations(socket, 'user-1', {
      terminals: new FakeRunnerTerminalPort(),
      findAnyRunnerForUser: async () => null,
      getRunnerUserId: async () => null,
    });
    let response: Uint8Array | undefined;
    await socket.triggerRpc<Uint8Array>(
      BROWSER_V1_CARRIER_EVENTS.operation,
      operationWire(),
      (wire) => {
        response = wire;
      },
    );

    expect(decodeOutcome(response!).outcome).toMatchObject({
      case: 'status',
      value: { code: StatusCode.UNAVAILABLE, retryable: true },
    });
  });

  test('requires negotiated assignment and does not disclose cross-user runners', async () => {
    const terminals = new FakeRunnerTerminalPort();
    terminals.available.add('runner-other');
    const unnegotiated = createMockSocket({ data: {} } as any);
    const ownerLookup = mock(async () => 'user-2');
    const dependencies = {
      terminals,
      findAnyRunnerForUser: async () => null,
      getRunnerUserId: ownerLookup,
    };
    setupBrowserV1Operations(unnegotiated, 'user-1', dependencies);
    let inactiveResponse: Uint8Array | undefined;
    await unnegotiated.triggerRpc<Uint8Array>(
      BROWSER_V1_CARRIER_EVENTS.operation,
      operationWire(),
      (wire) => {
        inactiveResponse = wire;
      },
    );
    expect(decodeOutcome(inactiveResponse!).outcome).toMatchObject({
      case: 'status',
      value: { code: StatusCode.INCOMPATIBLE },
    });

    const socket = activeSocket();
    setupBrowserV1Operations(socket, 'user-1', dependencies);
    let deniedResponse: Uint8Array | undefined;
    await socket.triggerRpc<Uint8Array>(
      BROWSER_V1_CARRIER_EVENTS.operation,
      operationWire({ runnerId: 'runner-other' }),
      (wire) => {
        deniedResponse = wire;
      },
    );
    expect(decodeOutcome(deniedResponse!).outcome).toMatchObject({
      case: 'status',
      value: { code: StatusCode.NOT_FOUND, message: 'Runner is unavailable' },
    });
    expect(ownerLookup).toHaveBeenCalledWith('runner-other');
  });

  test('rejects cross-user resource references before dispatch without disclosing ownership', async () => {
    const findRunner = mock(async () => 'runner-1');
    const socket = activeSocket();
    setupBrowserV1Operations(socket, 'user-1', {
      findAnyRunnerForUser: findRunner,
      getRunnerUserId: async (runnerId) => (runnerId === 'runner-other' ? 'user-2' : 'user-1'),
    });
    let response: Uint8Array | undefined;
    await socket.triggerRpc<Uint8Array>(
      BROWSER_V1_CARRIER_EVENTS.operation,
      operationWire({
        resources: [{ kind: ResourceKind.RUNNER, id: 'runner-other' }],
      }),
      (wire) => {
        response = wire;
      },
    );

    expect(decodeOutcome(response!).outcome).toMatchObject({
      case: 'status',
      value: { code: StatusCode.NOT_FOUND, message: 'Operation resource is unavailable' },
    });
    expect(findRunner).not.toHaveBeenCalled();
  });

  test('enforces elapsed deadlines before executing', async () => {
    const findRunner = mock(async () => 'runner-1');
    const socket = activeSocket();
    setupBrowserV1Operations(socket, 'user-1', {
      findAnyRunnerForUser: findRunner,
      getRunnerUserId: async () => 'user-1',
    });
    let response: Uint8Array | undefined;
    await socket.triggerRpc<Uint8Array>(
      BROWSER_V1_CARRIER_EVENTS.operation,
      operationWire({ deadline: new Date(Date.now() - 1_000) }),
      (wire) => {
        response = wire;
      },
    );
    expect(decodeOutcome(response!).outcome).toMatchObject({
      case: 'status',
      value: { code: StatusCode.DEADLINE_EXCEEDED },
    });
    expect(findRunner).not.toHaveBeenCalled();
  });

  test('cancels downstream lookup explicitly and cleans up the request', async () => {
    let release!: (runnerId: string) => void;
    const pendingRunner = new Promise<string>((resolve) => {
      release = resolve;
    });
    const socket = activeSocket();
    setupBrowserV1Operations(socket, 'user-1', {
      findAnyRunnerForUser: async () => pendingRunner,
      getRunnerUserId: async () => 'user-1',
    });
    let response: Uint8Array | undefined;
    const pending = socket.triggerRpc<Uint8Array>(
      BROWSER_V1_CARRIER_EVENTS.operation,
      operationWire({ requestId: 'cancel-me' }),
      (wire) => {
        response = wire;
      },
    );
    await Promise.resolve();
    await socket.trigger(BROWSER_V1_CARRIER_EVENTS.control, controlWire('cancel-me'));
    await pending;

    expect(decodeOutcome(response!).outcome).toMatchObject({
      case: 'status',
      value: { code: StatusCode.CANCELLED },
    });
    release('runner-1');
  });

  test('deadline abort responds even while downstream lookup is pending', async () => {
    let release!: (runnerId: string) => void;
    const pendingRunner = new Promise<string>((resolve) => {
      release = resolve;
    });
    const socket = activeSocket();
    setupBrowserV1Operations(socket, 'user-1', {
      findAnyRunnerForUser: async () => pendingRunner,
      getRunnerUserId: async () => 'user-1',
    });
    let response: Uint8Array | undefined;
    await socket.triggerRpc<Uint8Array>(
      BROWSER_V1_CARRIER_EVENTS.operation,
      operationWire({ requestId: 'deadline-pending', deadline: new Date(Date.now() + 10) }),
      (wire) => {
        response = wire;
      },
    );
    expect(decodeOutcome(response!).outcome).toMatchObject({
      case: 'status',
      value: { code: StatusCode.DEADLINE_EXCEEDED },
    });
    release('runner-1');
  });

  test('bounds concurrent operations per connection', async () => {
    let release!: (runnerId: string) => void;
    const pendingRunner = new Promise<string>((resolve) => {
      release = resolve;
    });
    const socket = activeSocket(1);
    setupBrowserV1Operations(socket, 'user-1', {
      findAnyRunnerForUser: async () => pendingRunner,
      getRunnerUserId: async () => 'user-1',
    });
    const first = socket.triggerRpc<Uint8Array>(
      BROWSER_V1_CARRIER_EVENTS.operation,
      operationWire({ requestId: 'first' }),
      () => {},
    );
    await Promise.resolve();
    let secondResponse: Uint8Array | undefined;
    await socket.triggerRpc<Uint8Array>(
      BROWSER_V1_CARRIER_EVENTS.operation,
      operationWire({ requestId: 'second' }),
      (wire) => {
        secondResponse = wire;
      },
    );
    expect(decodeOutcome(secondResponse!).outcome).toMatchObject({
      case: 'status',
      value: { code: StatusCode.RESOURCE_EXHAUSTED },
    });
    release('runner-1');
    await first;
  });
});
