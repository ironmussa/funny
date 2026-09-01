import { describe, expect, test } from 'bun:test';

import { create, type MessageInitShape } from '@bufbuild/protobuf';
import {
  BROWSER_V1_CARRIER_EVENTS,
  BROWSER_V1_SCHEMA_FINGERPRINT,
  decodeBrowserCarrier,
  encodeBrowserCarrier,
} from '@funny/shared/browser-protocol';
import { DeliveryClass, Representation, StatusCode } from '@funny/shared/browser-v1/common';
import { InteractiveEnvelopeSchema } from '@funny/shared/browser-v1/interactive';
import { CarrierEnvelopeSchema } from '@funny/shared/browser-v1/transport';

import {
  BrowserV1AtMostOnceInputStore,
  setupBrowserV1Interactive,
} from '../../services/socketio/browser-v1-interactive.js';
import { FakeRunnerRequestPort, FakeRunnerTerminalPort } from '../helpers/runner-port-fakes.js';
import { createMockSocket } from '../helpers/socketio-test-mocks.js';

function wire(
  deliveryClass: DeliveryClass,
  payload: MessageInitShape<typeof InteractiveEnvelopeSchema>['payload'],
) {
  return encodeBrowserCarrier(
    create(CarrierEnvelopeSchema, {
      generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
      payload: {
        case: 'interactive',
        value: create(InteractiveEnvelopeSchema, {
          delivery: { deliveryClass },
          payload,
        }),
      },
    }),
  );
}

function fixture(projectOwner = 'user-1', inputOrdinals = new BrowserV1AtMostOnceInputStore()) {
  const terminals = new FakeRunnerTerminalPort();
  const requests = new FakeRunnerRequestPort();
  terminals.available.add('runner-1');
  requests.available.add('runner-1');
  const socket = createMockSocket({
    data: {
      browserV1: {
        principalUserId: 'user-1',
        assignments: {
          terminal: Representation.BROWSER_V1,
          browserSession: Representation.BROWSER_V1,
        },
      },
    },
  } as any);
  setupBrowserV1Interactive(socket, 'user-1', {
    terminals,
    requests,
    findAnyRunnerForUser: async () => 'runner-1',
    findRunnerForProject: async () => 'runner-1',
    getRunnerUserId: async () => 'user-1',
    getProjectOwnerId: async () => projectOwner,
    inputOrdinals,
  });
  return { socket, terminals, requests };
}

describe('browser.v1 terminal interactive carrier', () => {
  test('maps the typed terminal lifecycle through the runner terminal port', async () => {
    const { socket, terminals } = fixture();
    const messages = [
      [
        DeliveryClass.SNAPSHOT_RECOVERABLE,
        {
          case: 'terminal' as const,
          value: {
            terminalId: 'pty-1',
            payload: {
              case: 'spawn' as const,
              value: {
                terminalId: 'pty-1',
                cwd: '/workspace',
                columns: 100,
                rows: 30,
                projectId: 'project-1',
              },
            },
          },
        },
      ],
      [
        DeliveryClass.AT_MOST_ONCE,
        {
          case: 'terminal' as const,
          value: {
            terminalId: 'pty-1',
            payload: {
              case: 'write' as const,
              value: { inputOrdinal: 1n, data: new TextEncoder().encode('echo hi\n') },
            },
          },
        },
      ],
      [
        DeliveryClass.COALESCIBLE,
        {
          case: 'terminal' as const,
          value: {
            terminalId: 'pty-1',
            payload: { case: 'resize' as const, value: { columns: 120, rows: 40 } },
          },
        },
      ],
      [
        DeliveryClass.AT_MOST_ONCE,
        {
          case: 'terminal' as const,
          value: {
            terminalId: 'pty-1',
            payload: { case: 'signal' as const, value: { signal: 'SIGINT' } },
          },
        },
      ],
      [
        DeliveryClass.COALESCIBLE,
        {
          case: 'terminal' as const,
          value: {
            terminalId: 'pty-1',
            payload: { case: 'rename' as const, value: { title: 'Tests' } },
          },
        },
      ],
      [
        DeliveryClass.SNAPSHOT_RECOVERABLE,
        {
          case: 'terminal' as const,
          value: {
            terminalId: 'pty-1',
            payload: { case: 'reconnect' as const, value: { lastSeenOutputSequence: 4n } },
          },
        },
      ],
      [
        DeliveryClass.SNAPSHOT_RECOVERABLE,
        {
          case: 'terminal' as const,
          value: {
            terminalId: 'pty-1',
            payload: { case: 'restore' as const, value: {} },
          },
        },
      ],
      [
        DeliveryClass.DURABLE,
        {
          case: 'terminal' as const,
          value: {
            terminalId: 'pty-1',
            payload: { case: 'close' as const, value: { reason: 'done' } },
          },
        },
      ],
    ] as const;

    for (const [deliveryClass, payload] of messages) {
      await socket.trigger(BROWSER_V1_CARRIER_EVENTS.interactive, wire(deliveryClass, payload));
    }

    expect(terminals.events.map(({ event }) => event.type)).toEqual([
      'pty:spawn',
      'pty:write',
      'pty:resize',
      'pty:signal',
      'pty:rename',
      'pty:reconnect',
      'pty:restore',
      'pty:close',
    ]);
    expect(terminals.events[1]?.event.data.data).toBe('echo hi\n');
  });

  test('does not replay a duplicate input ordinal and rejects cross-user projects safely', async () => {
    const ordinals = new BrowserV1AtMostOnceInputStore();
    const allowed = fixture('user-1', ordinals);
    const input = wire(DeliveryClass.AT_MOST_ONCE, {
      case: 'terminal',
      value: {
        terminalId: 'pty-1',
        payload: {
          case: 'write',
          value: { inputOrdinal: 1n, data: new TextEncoder().encode('x') },
        },
      },
    });
    await allowed.socket.trigger(BROWSER_V1_CARRIER_EVENTS.interactive, input);
    await allowed.socket.trigger(BROWSER_V1_CARRIER_EVENTS.interactive, input);
    expect(allowed.terminals.events).toHaveLength(1);
    const reconnected = fixture('user-1', ordinals);
    await reconnected.socket.trigger(BROWSER_V1_CARRIER_EVENTS.interactive, input);
    expect(reconnected.terminals.events).toHaveLength(0);

    const denied = fixture('user-2');
    await denied.socket.trigger(
      BROWSER_V1_CARRIER_EVENTS.interactive,
      wire(DeliveryClass.SNAPSHOT_RECOVERABLE, {
        case: 'terminal',
        value: {
          terminalId: 'pty-2',
          payload: {
            case: 'spawn',
            value: { terminalId: 'pty-2', cwd: '/private', projectId: 'project-2' },
          },
        },
      }),
    );
    expect(denied.terminals.events).toHaveLength(0);
    const response = denied.socket.emitted.find(
      ({ event }) => event === BROWSER_V1_CARRIER_EVENTS.interactive,
    );
    expect(decodeBrowserCarrier(response?.data)).toMatchObject({
      ok: true,
      envelope: {
        payload: {
          case: 'interactive',
          value: {
            payload: {
              case: 'terminal',
              value: {
                payload: {
                  case: 'error',
                  value: { status: { code: StatusCode.NOT_FOUND } },
                },
              },
            },
          },
        },
      },
    });
  });

  test('maps browser-session lifecycle and suppresses duplicate at-most-once input', async () => {
    const previousSecret = process.env.RUNNER_AUTH_SECRET;
    process.env.RUNNER_AUTH_SECRET = 'browser-v1-test-secret';
    try {
      const { socket, requests } = fixture();
      const messages = [
        wire(DeliveryClass.SNAPSHOT_RECOVERABLE, {
          case: 'browserSession',
          value: {
            browserSessionId: 'browser-1',
            payload: {
              case: 'open',
              value: { targetUrl: 'https://example.test', projectId: 'project-1' },
            },
          },
        }),
        wire(DeliveryClass.COALESCIBLE, {
          case: 'browserSession',
          value: {
            browserSessionId: 'browser-1',
            payload: { case: 'navigate', value: { targetUrl: 'https://example.test/docs' } },
          },
        }),
        wire(DeliveryClass.AT_MOST_ONCE, {
          case: 'browserSession',
          value: {
            browserSessionId: 'browser-1',
            payload: {
              case: 'input',
              value: { inputOrdinal: 1n, action: { type: 'click', x: 10, y: 20 } },
            },
          },
        }),
        wire(DeliveryClass.AT_MOST_ONCE, {
          case: 'browserSession',
          value: {
            browserSessionId: 'browser-1',
            payload: {
              case: 'input',
              value: { inputOrdinal: 1n, action: { type: 'click', x: 10, y: 20 } },
            },
          },
        }),
        wire(DeliveryClass.VOLATILE, {
          case: 'browserSession',
          value: {
            browserSessionId: 'browser-1',
            payload: { case: 'heartbeat', value: { ordinal: 1n } },
          },
        }),
        wire(DeliveryClass.SNAPSHOT_RECOVERABLE, {
          case: 'browserSession',
          value: {
            browserSessionId: 'browser-1',
            payload: { case: 'close', value: { reason: 'user' } },
          },
        }),
      ];
      for (const message of messages) {
        await socket.trigger(BROWSER_V1_CARRIER_EVENTS.interactive, message);
      }

      expect(requests.requests).toHaveLength(5);
      expect(
        requests.requests.map(({ request }) => JSON.parse(request.body as string).type),
      ).toEqual([
        'browser-session:open',
        'browser-session:navigate',
        'browser-session:input',
        'browser-session:heartbeat',
        'browser-session:close',
      ]);
      expect(JSON.parse(requests.requests[2]!.request.body as string).data).toMatchObject({
        sessionId: 'browser-1',
        type: 'click',
        x: 10,
        y: 20,
      });
    } finally {
      if (previousSecret === undefined) delete process.env.RUNNER_AUTH_SECRET;
      else process.env.RUNNER_AUTH_SECRET = previousSecret;
    }
  });
});
