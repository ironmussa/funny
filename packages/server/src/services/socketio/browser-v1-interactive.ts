import { create } from '@bufbuild/protobuf';
import { hasValidDeclaredDeliveryClass } from '@funny/shared/browser-delivery-policy';
import {
  BROWSER_V1_CARRIER_EVENTS,
  BROWSER_V1_SCHEMA_FINGERPRINT,
  browserCarrierPayloadSchema,
  decodeBrowserCarrier,
} from '@funny/shared/browser-protocol';
import { Representation, StatusCode, StatusSchema } from '@funny/shared/browser-v1/common';
import {
  type BrowserSessionMessage,
  InteractiveEnvelopeSchema,
  type TerminalMessage,
} from '@funny/shared/browser-v1/interactive';
import { CarrierEnvelopeSchema } from '@funny/shared/browser-v1/transport';
import type { Socket } from 'socket.io';

import {
  authorizedRunnerRequests,
  authorizedRunnerTerminal,
  runnerAccess,
  runnerActor,
  type RunnerTarget,
} from '../runner-access/index.js';
import type { RunnerRequestPort } from '../runner-ports.js';
import type { BrowserPtyDependencies } from './browser-pty.js';
import { observeBrowserV1 } from './browser-v1-observability.js';
import { encodeSocketIoCarrier } from './browser-v1-wire.js';
import { registerSocketHandlersWithSchema } from './router.js';

export class BrowserV1AtMostOnceInputStore {
  private readonly ordinals = new Map<string, { ordinal: bigint; updatedAt: number }>();

  constructor(
    private readonly retentionMs = 10 * 60_000,
    private readonly maxEntries = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  accept(principalUserId: string, resourceId: string, ordinal: bigint): boolean {
    const oldest = this.now() - this.retentionMs;
    for (const [key, value] of this.ordinals) {
      if (value.updatedAt < oldest) this.ordinals.delete(key);
    }
    const key = `${principalUserId}\0${resourceId}`;
    const previous = this.ordinals.get(key)?.ordinal ?? 0n;
    if (ordinal <= previous) return false;
    while (this.ordinals.size >= this.maxEntries) {
      const oldestKey = this.ordinals.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.ordinals.delete(oldestKey);
    }
    this.ordinals.set(key, { ordinal, updatedAt: this.now() });
    return true;
  }
}

const browserV1InputOrdinals = new BrowserV1AtMostOnceInputStore();

function terminalError(terminalId: string, code: StatusCode, message: string): Buffer {
  return encodeSocketIoCarrier(
    create(CarrierEnvelopeSchema, {
      generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
      payload: {
        case: 'interactive',
        value: create(InteractiveEnvelopeSchema, {
          payload: {
            case: 'terminal',
            value: {
              terminalId,
              payload: {
                case: 'error',
                value: { status: create(StatusSchema, { code, message }) },
              },
            },
          },
        }),
      },
    }),
  );
}

function browserSessionError(sessionId: string, code: StatusCode, message: string): Buffer {
  return encodeSocketIoCarrier(
    create(CarrierEnvelopeSchema, {
      generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
      payload: {
        case: 'interactive',
        value: create(InteractiveEnvelopeSchema, {
          payload: {
            case: 'browserSession',
            value: {
              browserSessionId: sessionId,
              payload: { case: 'status', value: create(StatusSchema, { code, message }) },
            },
          },
        }),
      },
    }),
  );
}

function legacyBrowserSessionEvent(message: BrowserSessionMessage, requestId?: string) {
  const base = { sessionId: message.browserSessionId };
  switch (message.payload.case) {
    case 'open':
      return {
        type: 'browser-session:open',
        data: { ...base, url: message.payload.value.targetUrl },
      };
    case 'navigate':
      return {
        type: 'browser-session:navigate',
        data: { ...base, url: message.payload.value.targetUrl },
      };
    case 'input':
      return {
        type: 'browser-session:input',
        data: { ...base, ...message.payload.value.action },
      };
    case 'inspect': {
      const selector = message.payload.value.selector ?? {};
      const kind = selector.kind === 'rect' ? 'inspect-rect' : 'inspect-at';
      return { type: `browser-session:${kind}`, data: { ...base, requestId, ...selector } };
    }
    case 'execute':
      return {
        type: 'browser-session:execute',
        data: { ...base, requestId, expression: message.payload.value.expression },
      };
    case 'heartbeat':
      return { type: 'browser-session:heartbeat', data: base };
    case 'historyNavigation':
      return {
        type: 'browser-session:nav',
        data: { ...base, requestId, action: message.payload.value.action },
      };
    case 'screenshot':
      return { type: 'browser-session:screenshot', data: { ...base, requestId } };
    case 'close':
      return {
        type: 'browser-session:close',
        data: { ...base, reason: message.payload.value.reason },
      };
    default:
      return null;
  }
}

function legacyTerminalEvent(terminal: TerminalMessage) {
  const payload = terminal.payload;
  switch (payload.case) {
    case 'spawn':
      return {
        type: 'pty:spawn' as const,
        data: {
          id: terminal.terminalId,
          cwd: payload.value.cwd,
          cols: payload.value.columns,
          rows: payload.value.rows,
          shell: payload.value.shell,
          projectId: payload.value.projectId,
          label: payload.value.label,
          scratchThreadId: payload.value.scratchThreadId,
        },
      };
    case 'write':
      return {
        type: 'pty:write' as const,
        data: { id: terminal.terminalId, data: new TextDecoder().decode(payload.value.data) },
      };
    case 'resize':
      return {
        type: 'pty:resize' as const,
        data: { id: terminal.terminalId, cols: payload.value.columns, rows: payload.value.rows },
      };
    case 'signal':
      return {
        type: 'pty:signal' as const,
        data: { id: terminal.terminalId, signal: payload.value.signal },
      };
    case 'rename':
      return {
        type: 'pty:rename' as const,
        data: { id: terminal.terminalId, label: payload.value.title },
      };
    case 'reconnect':
      return {
        type: 'pty:reconnect' as const,
        data: {
          id: terminal.terminalId,
          lastSeenOutputSequence: payload.value.lastSeenOutputSequence,
        },
      };
    case 'restore':
      return { type: 'pty:restore' as const, data: { id: terminal.terminalId } };
    case 'close':
      return {
        type: 'pty:close' as const,
        data: { id: terminal.terminalId, reason: payload.value.reason },
      };
    default:
      return null;
  }
}

export function setupBrowserV1Interactive(
  socket: Socket,
  principalUserId: string,
  dependencies: BrowserPtyDependencies & {
    requests?: RunnerRequestPort;
    inputOrdinals?: BrowserV1AtMostOnceInputStore;
  },
): void {
  const inputOrdinals = dependencies.inputOrdinals ?? browserV1InputOrdinals;
  const access = dependencies.runnerAccess ?? runnerAccess;
  const actor = runnerActor({ userId: principalUserId });
  const targetFor = (projectId: string | null | undefined): RunnerTarget =>
    projectId ? { kind: 'project-checkout', projectId } : { kind: 'projectless' };
  registerSocketHandlersWithSchema(socket, {
    events: [BROWSER_V1_CARRIER_EVENTS.interactive],
    payloadSchema: browserCarrierPayloadSchema,
    handler: async (_ctx, payload) => {
      const decoded = decodeBrowserCarrier(payload, {
        expectedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
        allowedPayloads: ['interactive'],
      });
      if (!decoded.ok || decoded.envelope.payload.case !== 'interactive') {
        observeBrowserV1({
          event: 'decode',
          status: 'rejected',
          reason: decoded.ok ? 'wrong-envelope' : String(decoded.status.code),
        });
        return;
      }
      const message = decoded.envelope.payload.value;
      const state = socket.data.browserV1 as
        | {
            principalUserId?: string;
            assignments?: { terminal?: Representation; browserSession?: Representation };
          }
        | undefined;
      if (state?.principalUserId !== principalUserId || !hasValidDeclaredDeliveryClass(message)) {
        return;
      }
      if (message.payload.case === 'browserSession') {
        if (state.assignments?.browserSession !== Representation.BROWSER_V1) return;
        const browserSession = message.payload.value;
        if (!browserSession.browserSessionId) return;
        if (browserSession.payload.case === 'input') {
          if (
            !inputOrdinals.accept(
              principalUserId,
              `browser:${browserSession.browserSessionId}`,
              browserSession.payload.value.inputOrdinal,
            )
          )
            return;
        }
        const event = legacyBrowserSessionEvent(browserSession, message.metadata?.requestId);
        if (!event) return;
        const projectId =
          browserSession.payload.case === 'open'
            ? browserSession.payload.value.projectId
            : undefined;
        if (projectId && (await dependencies.getProjectOwnerId(projectId)) !== principalUserId) {
          socket.emit(
            BROWSER_V1_CARRIER_EVENTS.interactive,
            browserSessionError(
              browserSession.browserSessionId,
              StatusCode.NOT_FOUND,
              'Browser session resource is unavailable',
            ),
          );
          return;
        }
        // The runner is one of the principal's own, holding the project
        // checkout when one is named, certified by `withRunnerFor`. The sink
        // signs the principal's identity itself.
        const sink = authorizedRunnerRequests(dependencies.requests);
        const sent = await access.withRunnerFor(
          actor,
          targetFor(projectId),
          dependencies.presence,
          async (a, runner, proof) => {
            if (!sink.isAvailable(runner)) return false;
            await sink.send(a, runner, proof, {
              method: 'POST',
              path: '/api/browser-session/command',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(event),
            });
            return true;
          },
        );
        if (sent.isErr() || !sent.value) {
          socket.emit(
            BROWSER_V1_CARRIER_EVENTS.interactive,
            browserSessionError(
              browserSession.browserSessionId,
              StatusCode.UNAVAILABLE,
              'Browser session runner is unavailable',
            ),
          );
        }
        return;
      }
      if (message.payload.case !== 'terminal') return;
      if (state.assignments?.terminal !== Representation.BROWSER_V1) return;
      const terminal = message.payload.value;
      if (!terminal.terminalId) return;
      if (terminal.payload.case === 'write') {
        if (
          !inputOrdinals.accept(
            principalUserId,
            `terminal:${terminal.terminalId}`,
            terminal.payload.value.inputOrdinal,
          )
        )
          return;
      }
      const event = legacyTerminalEvent(terminal);
      if (!event) return;

      const projectId = terminal.payload.case === 'spawn' ? terminal.payload.value.projectId : null;
      if (projectId && (await dependencies.getProjectOwnerId(projectId)) !== principalUserId) {
        socket.emit(
          BROWSER_V1_CARRIER_EVENTS.interactive,
          terminalError(
            terminal.terminalId,
            StatusCode.NOT_FOUND,
            'Terminal resource is unavailable',
          ),
        );
        return;
      }
      const terminalSink = authorizedRunnerTerminal(dependencies.terminals);
      const dispatched = await access.withRunnerFor(
        actor,
        targetFor(projectId),
        dependencies.presence,
        async (a, runner, proof) => {
          if (!terminalSink.isAvailable(runner)) return false;
          terminalSink.dispatch(a, runner, proof, event);
          return true;
        },
      );
      if (dispatched.isErr() || !dispatched.value) {
        socket.emit(
          BROWSER_V1_CARRIER_EVENTS.interactive,
          terminalError(
            terminal.terminalId,
            StatusCode.UNAVAILABLE,
            'Terminal runner is unavailable',
          ),
        );
      }
    },
  });
}
