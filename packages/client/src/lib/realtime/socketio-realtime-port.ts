import { create } from '@bufbuild/protobuf';
import {
  BrowserEventRecoveryState,
  type ClientRealtimePort,
  type ClientRealtimeSnapshot,
  type Unsubscribe,
} from '@funny/client-core';
import {
  BROWSER_V1_CARRIER_EVENTS,
  BROWSER_V1_SCHEMA_FINGERPRINT,
  decodeBrowserCarrier,
  encodeBrowserCarrier,
} from '@funny/shared/browser-protocol';
import {
  Representation,
  ScopeKind,
  ScopeReferenceSchema,
  StatusCode,
  StatusSchema,
  TrafficClass,
  type Cursor,
  type ScopeReference,
} from '@funny/shared/browser-v1/common';
import {
  EventEnvelopeSchema,
  SubscriptionOutcomeSchema,
  SubscriptionRequestSchema,
  type ApplicationEvent,
  type SubscriptionOutcome,
  type SubscriptionRequest,
} from '@funny/shared/browser-v1/events';
import type { InteractiveEnvelope } from '@funny/shared/browser-v1/interactive';
import {
  NegotiationRequestSchema,
  type NegotiationOutcome,
  type NegotiationRequest,
} from '@funny/shared/browser-v1/negotiation';
import {
  OperationOutcomeSchema,
  type OperationOutcome,
  type OperationRequest,
} from '@funny/shared/browser-v1/operations';
import { CarrierEnvelopeSchema } from '@funny/shared/browser-v1/transport';

interface SocketLike {
  connected: boolean;
  on(event: string, listener: (...args: any[]) => void): void;
  off(event: string, listener: (...args: any[]) => void): void;
  emit(event: string, payload: unknown): void;
  timeout(timeoutMs: number): {
    emitWithAck(event: string, payload: unknown): Promise<unknown>;
  };
}

const DEFAULT_ACK_TIMEOUT_MS = 7_000;

function scopeKey(scope: ScopeReference): string {
  return `${scope.kind}:${scope.parentId ?? ''}:${scope.id}`;
}

function statusOutcome(
  requestId: string,
  code: StatusCode,
  message: string,
  retryable = false,
): OperationOutcome {
  return create(OperationOutcomeSchema, {
    requestId,
    outcome: { case: 'status', value: create(StatusSchema, { code, message, retryable }) },
  });
}

export class SocketIoClientRealtimePort implements ClientRealtimePort {
  private snapshot: ClientRealtimeSnapshot = {
    phase: 'idle',
    protocol: 'legacy',
    error: null,
  };
  private readonly lifecycleListeners = new Set<(snapshot: ClientRealtimeSnapshot) => void>();
  private readonly eventListeners = new Set<(event: ApplicationEvent) => void>();
  private readonly interactiveListeners = new Set<(message: InteractiveEnvelope) => void>();
  private readonly recoveryListeners = new Set<(scope: ScopeReference) => void>();
  private readonly recovery = new BrowserEventRecoveryState();
  private readonly subscribedScopes = new Map<string, ScopeReference>();
  private readonly terminalOutputSequences = new Map<string, bigint>();
  private readonly assignments = new Map<TrafficClass, Representation>();
  private started = false;

  constructor(
    private readonly socket: SocketLike,
    private readonly acknowledgementTimeoutMs = DEFAULT_ACK_TIMEOUT_MS,
  ) {}

  current(): ClientRealtimeSnapshot {
    return this.snapshot;
  }

  subscribeLifecycle(listener: (snapshot: ClientRealtimeSnapshot) => void): Unsubscribe {
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.socket.on('connect', this.handleConnect);
    this.socket.on('disconnect', this.handleDisconnect);
    this.socket.on('connect_error', this.handleError);
    this.socket.on(BROWSER_V1_CARRIER_EVENTS.event, this.handleBrowserEvent);
    this.socket.on(BROWSER_V1_CARRIER_EVENTS.interactive, this.handleBrowserInteractive);
    if (this.socket.connected) this.handleConnect();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.socket.off('connect', this.handleConnect);
    this.socket.off('disconnect', this.handleDisconnect);
    this.socket.off('connect_error', this.handleError);
    this.socket.off(BROWSER_V1_CARRIER_EVENTS.event, this.handleBrowserEvent);
    this.socket.off(BROWSER_V1_CARRIER_EVENTS.interactive, this.handleBrowserInteractive);
    this.assignments.clear();
    this.subscribedScopes.clear();
    this.update({ phase: 'idle', protocol: 'legacy', error: null });
  }

  async negotiate(request: NegotiationRequest): Promise<NegotiationOutcome> {
    const requestWithCursors = create(NegotiationRequestSchema, {
      ...request,
      resumeCursors: this.recovery.cursors(),
    });
    const carrier = create(CarrierEnvelopeSchema, {
      generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
      payload: { case: 'negotiationRequest', value: requestWithCursors },
    });
    const wire = await this.socket
      .timeout(this.acknowledgementTimeoutMs)
      .emitWithAck(BROWSER_V1_CARRIER_EVENTS.negotiate, encodeBrowserCarrier(carrier));
    const decoded = decodeBrowserCarrier(wire, {
      expectedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
      allowedPayloads: ['negotiationOutcome'],
    });
    if (!decoded.ok || decoded.envelope.payload.case !== 'negotiationOutcome') {
      throw new Error(decoded.ok ? 'Invalid negotiation response' : decoded.status.message);
    }
    const outcome = decoded.envelope.payload.value;
    if (outcome.outcome.case === 'success') {
      this.assignments.clear();
      for (const assignment of outcome.outcome.value.assignments) {
        this.assignments.set(assignment.trafficClass, assignment.representation);
      }
      for (const cursor of outcome.outcome.value.acceptedCursors) {
        this.recovery.acceptCursor(cursor);
      }
      this.update({ phase: 'connected', protocol: 'browser.v1', error: null });
      await this.resumeSubscriptions();
    }
    return outcome;
  }

  async operate(request: OperationRequest): Promise<OperationOutcome> {
    if (this.representation(TrafficClass.OPERATIONS) !== Representation.BROWSER_V1) {
      return this.operateLegacy(request);
    }
    const carrier = create(CarrierEnvelopeSchema, {
      generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
      payload: {
        case: 'operation',
        value: { payload: { case: 'request', value: request } },
      },
    });
    try {
      const wire = await this.socket
        .timeout(this.acknowledgementTimeoutMs)
        .emitWithAck(BROWSER_V1_CARRIER_EVENTS.operation, encodeBrowserCarrier(carrier));
      const decoded = decodeBrowserCarrier(wire, {
        expectedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
        allowedPayloads: ['operation'],
      });
      if (!decoded.ok || decoded.envelope.payload.case !== 'operation') {
        return statusOutcome(
          request.metadata?.requestId ?? '',
          decoded.ok ? StatusCode.MALFORMED_INPUT : decoded.status.code,
          decoded.ok ? 'Invalid operation response' : decoded.status.message,
        );
      }
      const operation = decoded.envelope.payload.value.payload;
      return operation.case === 'outcome'
        ? operation.value
        : statusOutcome(
            request.metadata?.requestId ?? '',
            StatusCode.MALFORMED_INPUT,
            'Operation acknowledgement did not contain an outcome',
          );
    } catch {
      return statusOutcome(
        request.metadata?.requestId ?? '',
        StatusCode.DEADLINE_EXCEEDED,
        'Operation acknowledgement timed out',
        true,
      );
    }
  }

  async subscribeScope(request: SubscriptionRequest): Promise<SubscriptionOutcome> {
    if (this.representation(TrafficClass.EVENTS) === Representation.BROWSER_V1) {
      const carrier = create(CarrierEnvelopeSchema, {
        generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
        payload: {
          case: 'event',
          value: create(EventEnvelopeSchema, {
            payload: { case: 'subscribe', value: request },
          }),
        },
      });
      try {
        const wire = await this.socket
          .timeout(this.acknowledgementTimeoutMs)
          .emitWithAck(BROWSER_V1_CARRIER_EVENTS.event, encodeBrowserCarrier(carrier));
        const decoded = decodeBrowserCarrier(wire, {
          expectedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
          allowedPayloads: ['event'],
        });
        if (decoded.ok && decoded.envelope.payload.case === 'event') {
          const payload = decoded.envelope.payload.value.payload;
          if (payload.case === 'subscriptionOutcome') {
            const outcome = payload.value;
            if (outcome.outcome.case === 'accepted' && outcome.outcome.value.acceptedCursor) {
              this.recovery.acceptCursor(outcome.outcome.value.acceptedCursor);
            }
            if (outcome.outcome.case === 'accepted' && outcome.scope) {
              this.subscribedScopes.set(scopeKey(outcome.scope), outcome.scope);
            }
            if (
              outcome.outcome.case === 'status' &&
              (outcome.outcome.value.code === StatusCode.GAP ||
                outcome.outcome.value.code === StatusCode.SNAPSHOT_REQUIRED) &&
              outcome.scope
            ) {
              this.notifyRecovery(outcome.scope);
            }
            return outcome;
          }
        }
        return this.subscriptionStatus(
          request,
          decoded.ok ? StatusCode.MALFORMED_INPUT : decoded.status.code,
          decoded.ok ? 'Invalid subscription response' : decoded.status.message,
        );
      } catch {
        return this.subscriptionStatus(
          request,
          StatusCode.DEADLINE_EXCEEDED,
          'Subscription acknowledgement timed out',
        );
      }
    }
    if (
      request.scope &&
      (request.scope.kind === ScopeKind.THREAD_STREAM ||
        request.scope.kind === ScopeKind.THREAD_PRESENCE)
    ) {
      this.socket.emit('thread:open', { threadId: request.scope.id });
    }
    if (request.scope) this.subscribedScopes.set(scopeKey(request.scope), request.scope);
    return create(SubscriptionOutcomeSchema, {
      scope: request.scope,
      outcome: {
        case: 'accepted',
        value: { scope: request.scope, acceptedCursor: request.cursor },
      },
    });
  }

  async unsubscribeScope(scope: ScopeReference): Promise<void> {
    this.subscribedScopes.delete(scopeKey(scope));
    if (scope.kind === ScopeKind.THREAD_STREAM || scope.kind === ScopeKind.THREAD_PRESENCE) {
      this.socket.emit('thread:close', { threadId: scope.id });
    }
  }

  onApplicationEvent(listener: (event: ApplicationEvent) => void): Unsubscribe {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onInteractive(listener: (message: InteractiveEnvelope) => void): Unsubscribe {
    this.interactiveListeners.add(listener);
    return () => this.interactiveListeners.delete(listener);
  }

  onRecoveryRequired(listener: (scope: ScopeReference) => void): Unsubscribe {
    this.recoveryListeners.add(listener);
    return () => this.recoveryListeners.delete(listener);
  }

  sendInteractive(message: InteractiveEnvelope): void {
    if (this.representation(this.interactiveTrafficClass(message)) === Representation.BROWSER_V1) {
      const carrier = create(CarrierEnvelopeSchema, {
        generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
        payload: { case: 'interactive', value: message },
      });
      this.socket.emit(BROWSER_V1_CARRIER_EVENTS.interactive, encodeBrowserCarrier(carrier));
      return;
    }
    this.sendLegacyInteractive(message);
  }

  cancel(requestId: string, reason = 'client-cancelled'): void {
    if (this.representation(TrafficClass.OPERATIONS) !== Representation.BROWSER_V1) return;
    const carrier = create(CarrierEnvelopeSchema, {
      generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
      payload: {
        case: 'control',
        value: { payload: { case: 'cancel', value: { requestId, reason } } },
      },
    });
    this.socket.emit(BROWSER_V1_CARRIER_EVENTS.control, encodeBrowserCarrier(carrier));
  }

  async recover(cursors: readonly Cursor[]): Promise<SubscriptionOutcome[]> {
    return Promise.all(
      cursors
        .filter((cursor): cursor is Cursor & { scope: ScopeReference } => !!cursor.scope)
        .map((cursor) =>
          this.subscribeScope({ scope: cursor.scope, cursor } as SubscriptionRequest),
        ),
    );
  }

  private async resumeSubscriptions(): Promise<void> {
    if (this.representation(TrafficClass.EVENTS) !== Representation.BROWSER_V1) return;
    const cursors = new Map(
      this.recovery
        .cursors()
        .filter((cursor): cursor is Cursor & { scope: ScopeReference } => !!cursor.scope)
        .map((cursor) => [scopeKey(cursor.scope), cursor]),
    );
    await Promise.all(
      [...this.subscribedScopes.values()].map((scope) =>
        this.subscribeScope(
          create(SubscriptionRequestSchema, { scope, cursor: cursors.get(scopeKey(scope)) }),
        ),
      ),
    );
  }

  private readonly handleConnect = (): void => {
    this.update({ phase: 'connected', protocol: this.snapshot.protocol, error: null });
  };

  private readonly handleDisconnect = (): void => {
    this.update({ phase: 'disconnected', protocol: this.snapshot.protocol, error: null });
  };

  private readonly handleError = (error: unknown): void => {
    this.update({
      phase: 'error',
      protocol: this.snapshot.protocol,
      error: error instanceof Error ? error.message : String(error),
    });
  };

  private readonly handleBrowserEvent = (wire: unknown): void => {
    const decoded = decodeBrowserCarrier(wire, {
      expectedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
      allowedPayloads: ['event'],
    });
    if (!decoded.ok || decoded.envelope.payload.case !== 'event') return;
    const payload = decoded.envelope.payload.value.payload;
    if (payload.case === 'subscriptionOutcome') {
      const outcome = payload.value;
      if (outcome.outcome.case === 'accepted' && outcome.outcome.value.acceptedCursor) {
        this.recovery.acceptCursor(outcome.outcome.value.acceptedCursor);
      }
      if (
        outcome.outcome.case === 'status' &&
        (outcome.outcome.value.code === StatusCode.GAP ||
          outcome.outcome.value.code === StatusCode.SNAPSHOT_REQUIRED ||
          outcome.outcome.value.code === StatusCode.REVOKED) &&
        outcome.scope
      ) {
        this.notifyRecovery(outcome.scope);
      }
      return;
    }
    if (payload.case !== 'event') return;
    const acceptance = this.recovery.accept(payload.value);
    if (acceptance.kind === 'gap') {
      this.notifyRecovery(acceptance.scope);
      return;
    }
    if (acceptance.kind !== 'accepted') return;
    for (const listener of this.eventListeners) listener(payload.value);
  };

  private readonly handleBrowserInteractive = (wire: unknown): void => {
    const decoded = decodeBrowserCarrier(wire, {
      expectedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
      allowedPayloads: ['interactive'],
    });
    if (!decoded.ok || decoded.envelope.payload.case !== 'interactive') return;
    const interactive = decoded.envelope.payload.value;
    if (
      interactive.payload.case === 'terminal' &&
      interactive.payload.value.payload.case === 'output'
    ) {
      const terminalId = interactive.payload.value.terminalId;
      const sequence = interactive.payload.value.payload.value.sequence;
      const previous = this.terminalOutputSequences.get(terminalId) ?? 0n;
      if (sequence > 0n && sequence <= previous) return;
      if (sequence > 0n && previous > 0n && sequence !== previous + 1n) {
        this.notifyRecovery(
          create(ScopeReferenceSchema, { kind: ScopeKind.TERMINAL, id: terminalId }),
        );
        return;
      }
      if (sequence > 0n) this.terminalOutputSequences.set(terminalId, sequence);
    }
    for (const listener of this.interactiveListeners) listener(interactive);
  };

  private representation(trafficClass: TrafficClass): Representation {
    return this.assignments.get(trafficClass) ?? Representation.LEGACY;
  }

  private subscriptionStatus(
    request: SubscriptionRequest,
    code: StatusCode,
    message: string,
  ): SubscriptionOutcome {
    return create(SubscriptionOutcomeSchema, {
      scope: request.scope,
      outcome: { case: 'status', value: create(StatusSchema, { code, message }) },
    });
  }

  private notifyRecovery(scope: ScopeReference): void {
    for (const listener of this.recoveryListeners) listener(scope);
  }

  private async operateLegacy(request: OperationRequest): Promise<OperationOutcome> {
    const requestId = request.metadata?.requestId ?? '';
    if (request.operation.case === 'threadOpen' || request.operation.case === 'threadClose') {
      const open = request.operation.case === 'threadOpen';
      const threadId = request.operation.value.threadId;
      this.socket.emit(open ? 'thread:open' : 'thread:close', { threadId });
      return create(OperationOutcomeSchema, {
        requestId,
        outcome: {
          case: 'success',
          value: {
            result: {
              case: 'threadLifecycle',
              value: { threadId, open, presenceRevision: 0n },
            },
          },
        },
      });
    }
    if (request.operation.case !== 'ptyList') {
      return statusOutcome(requestId, StatusCode.MALFORMED_INPUT, 'Unsupported legacy operation');
    }

    try {
      const response = (await this.socket
        .timeout(this.acknowledgementTimeoutMs)
        .emitWithAck('pty:list', {})) as {
        status?: string;
        sessions?: Array<Record<string, unknown>>;
        error?: string;
      };
      if (response.status !== 'ok') {
        const code = response.status === 'no-runner' ? StatusCode.UNAVAILABLE : StatusCode.INTERNAL;
        return statusOutcome(
          requestId,
          code,
          response.error ?? response.status ?? 'Operation failed',
        );
      }
      const terminals = (response.sessions ?? []).flatMap((session) => {
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
    } catch {
      return statusOutcome(
        requestId,
        StatusCode.DEADLINE_EXCEEDED,
        'Legacy operation acknowledgement timed out',
        true,
      );
    }
  }

  private interactiveTrafficClass(message: InteractiveEnvelope): TrafficClass {
    return message.payload.case === 'browserSession'
      ? TrafficClass.BROWSER_SESSION
      : TrafficClass.TERMINAL;
  }

  private sendLegacyInteractive(message: InteractiveEnvelope): void {
    if (message.payload.case === 'terminal') {
      const terminal = message.payload.value;
      const payload = terminal.payload;
      if (!payload.case) return;
      switch (payload.case) {
        case 'spawn':
          this.socket.emit('pty:spawn', {
            id: terminal.terminalId,
            cwd: payload.value.cwd,
            cols: payload.value.columns,
            rows: payload.value.rows,
            projectId: payload.value.projectId,
            label: payload.value.label,
            shell: payload.value.shell,
            scratchThreadId: payload.value.scratchThreadId,
          });
          break;
        case 'write':
          this.socket.emit('pty:write', {
            id: terminal.terminalId,
            data: new TextDecoder().decode(payload.value.data),
          });
          break;
        case 'resize':
          this.socket.emit('pty:resize', {
            id: terminal.terminalId,
            cols: payload.value.columns,
            rows: payload.value.rows,
          });
          break;
        case 'signal':
          this.socket.emit('pty:signal', { id: terminal.terminalId, signal: payload.value.signal });
          break;
        case 'rename':
          this.socket.emit('pty:rename', { id: terminal.terminalId, label: payload.value.title });
          break;
        case 'reconnect':
          this.socket.emit('pty:reconnect', {
            id: terminal.terminalId,
            lastSeenOutputSequence: payload.value.lastSeenOutputSequence,
          });
          break;
        case 'restore':
          this.socket.emit('pty:restore', { id: terminal.terminalId });
          break;
        case 'close':
          this.socket.emit('pty:close', { id: terminal.terminalId, reason: payload.value.reason });
          break;
      }
      return;
    }
    if (message.payload.case === 'browserSession') {
      const browser = message.payload.value;
      const payload = browser.payload;
      if (!payload.case) return;
      const base = { sessionId: browser.browserSessionId };
      switch (payload.case) {
        case 'open':
          this.socket.emit('browser-session:open', { ...base, url: payload.value.targetUrl });
          break;
        case 'navigate':
          this.socket.emit('browser-session:navigate', { ...base, url: payload.value.targetUrl });
          break;
        case 'input':
          this.socket.emit('browser-session:input', { ...base, ...payload.value.action });
          break;
        case 'inspect': {
          const selector = payload.value.selector ?? {};
          this.socket.emit(
            selector.kind === 'rect'
              ? 'browser-session:inspect-rect'
              : 'browser-session:inspect-at',
            { ...base, requestId: message.metadata?.requestId, ...selector },
          );
          break;
        }
        case 'execute':
          this.socket.emit('browser-session:execute', {
            ...base,
            requestId: message.metadata?.requestId,
            expression: payload.value.expression,
          });
          break;
        case 'historyNavigation':
          this.socket.emit('browser-session:nav', {
            ...base,
            requestId: message.metadata?.requestId,
            action: payload.value.action,
          });
          break;
        case 'screenshot':
          this.socket.emit('browser-session:screenshot', {
            ...base,
            requestId: message.metadata?.requestId,
          });
          break;
        case 'heartbeat':
          this.socket.emit('browser-session:heartbeat', base);
          break;
        case 'close':
          this.socket.emit('browser-session:close', { ...base, reason: payload.value.reason });
          break;
      }
    }
  }

  private update(snapshot: ClientRealtimeSnapshot): void {
    if (
      snapshot.phase === this.snapshot.phase &&
      snapshot.protocol === this.snapshot.protocol &&
      snapshot.error === this.snapshot.error
    ) {
      return;
    }
    this.snapshot = snapshot;
    for (const listener of this.lifecycleListeners) listener(snapshot);
  }
}
