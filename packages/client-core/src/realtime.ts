import type { Cursor, ScopeReference } from '@funny/shared/browser-v1/common';
import type {
  ApplicationEvent,
  SubscriptionOutcome,
  SubscriptionRequest,
} from '@funny/shared/browser-v1/events';
import type { InteractiveEnvelope } from '@funny/shared/browser-v1/interactive';
import type { NegotiationOutcome, NegotiationRequest } from '@funny/shared/browser-v1/negotiation';
import type { OperationOutcome, OperationRequest } from '@funny/shared/browser-v1/operations';

import type { LifecycleService, NavigationService, Unsubscribe } from './platform';

export interface RealtimeEvent<T = unknown> {
  type: string;
  threadId: string;
  data: T;
}

export type ClientRealtimePhase = 'idle' | 'connected' | 'disconnected' | 'error';

export interface ClientRealtimeSnapshot {
  phase: ClientRealtimePhase;
  protocol: 'legacy' | 'browser.v1';
  error: string | null;
}

/** Renderer-neutral realtime boundary. Socket.IO never crosses this interface. */
export interface ClientRealtimePort {
  current(): ClientRealtimeSnapshot;
  subscribeLifecycle(listener: (snapshot: ClientRealtimeSnapshot) => void): Unsubscribe;
  start(): void;
  stop(): void;
  negotiate(request: NegotiationRequest): Promise<NegotiationOutcome>;
  operate(request: OperationRequest): Promise<OperationOutcome>;
  subscribeScope(request: SubscriptionRequest): Promise<SubscriptionOutcome>;
  unsubscribeScope(scope: ScopeReference): Promise<void>;
  onApplicationEvent(listener: (event: ApplicationEvent) => void): Unsubscribe;
  onInteractive(listener: (message: InteractiveEnvelope) => void): Unsubscribe;
  onRecoveryRequired(listener: (scope: ScopeReference) => void): Unsubscribe;
  sendInteractive(message: InteractiveEnvelope): void;
  cancel(requestId: string, reason?: string): void;
  recover(cursors: readonly Cursor[]): Promise<SubscriptionOutcome[]>;
}

export type RealtimeEffect =
  | { type: 'agent-result'; threadId: string; status: string; errorReason?: string }
  | { type: 'terminal-error'; ptyId: string; message: string }
  | { type: 'environment-activated'; activations: Array<{ kind: string; detail: string }> }
  | { type: 'application-event'; name: 'clone:progress' | 'worktree:setup'; detail: unknown }
  | { type: 'hook-failed'; message: string }
  | { type: 'push-completed' };

export interface RealtimeEffectSink {
  emit(effect: RealtimeEffect): void;
}

export interface RealtimeActionPorts {
  agent(event: RealtimeEvent): void;
  terminal(event: RealtimeEvent): void;
  thread(event: RealtimeEvent): void;
  git(event: RealtimeEvent): void;
  automation(event: RealtimeEvent): void;
  pipeline(event: RealtimeEvent): void;
  workflow(event: RealtimeEvent): void;
  presence(event: RealtimeEvent): void;
  testing(event: RealtimeEvent): void;
  browserSession(event: RealtimeEvent): void;
  infrastructure(event: RealtimeEvent): void;
}

function selectActionPort(type: string): keyof RealtimeActionPorts {
  if (type.startsWith('agent:')) return 'agent';
  if (type.startsWith('command:') || type.startsWith('pty:')) return 'terminal';
  if (type.startsWith('thread:')) return 'thread';
  if (type.startsWith('git:')) return 'git';
  if (type.startsWith('automation:') || type.startsWith('watcher:') || type.startsWith('job:')) {
    return 'automation';
  }
  if (type.startsWith('pipeline:')) return 'pipeline';
  if (type.startsWith('workflow:')) return 'workflow';
  if (type.startsWith('presence:')) return 'presence';
  if (type.startsWith('test:')) return 'testing';
  if (type.startsWith('browser-session:')) return 'browserSession';
  return 'infrastructure';
}

/** A realtime event's payload fields, read before they are checked. */
type EventPayload = Record<string, unknown>;

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isRecord(value: unknown): value is EventPayload {
  return typeof value === 'object' && value !== null;
}

function deriveEffects(event: RealtimeEvent): RealtimeEffect[] {
  const data: EventPayload = isRecord(event.data) ? event.data : {};
  if (event.type === 'agent:result') {
    const status = String(data.status ?? '');
    if (status === 'completed' || status === 'failed' || status === 'error') {
      return [
        {
          type: 'agent-result',
          threadId: event.threadId,
          status,
          errorReason: isString(data.errorReason) ? data.errorReason : undefined,
        },
      ];
    }
  }
  if (event.type === 'pty:error') {
    return [
      {
        type: 'terminal-error',
        ptyId: String(data.ptyId ?? ''),
        message: isString(data.error) ? data.error : 'Failed to create terminal',
      },
    ];
  }
  if (event.type === 'pty:env_activated') {
    const activations = Array.isArray(data.activations)
      ? data.activations.filter(
          (value: unknown): value is { kind: string; detail: string } =>
            isRecord(value) && typeof value.kind === 'string' && typeof value.detail === 'string',
        )
      : [];
    return [{ type: 'environment-activated', activations }];
  }
  if (event.type === 'clone:progress') {
    return [{ type: 'application-event', name: 'clone:progress', detail: event.data }];
  }
  if (event.type === 'worktree:setup') {
    return [
      {
        type: 'application-event',
        name: 'worktree:setup',
        detail: { threadId: event.threadId, ...data },
      },
    ];
  }
  if (event.type === 'git:workflow_progress') {
    if (data.status === 'step_update' && Array.isArray(data.steps)) {
      const failedHook = data.steps.find(
        (step: unknown): step is EventPayload =>
          isRecord(step) && step.id === 'hooks' && step.status === 'failed',
      );
      if (failedHook) {
        return [
          {
            type: 'hook-failed',
            message: isString(failedHook.error)
              ? failedHook.error.slice(0, 120)
              : 'A pre-commit hook did not pass',
          },
        ];
      }
    }
    if (data.status === 'completed' && data.action === 'push') {
      return [{ type: 'push-completed' }];
    }
  }
  return [];
}

export function createRealtimeDispatcher(options: {
  actions: RealtimeActionPorts;
  effects: RealtimeEffectSink;
}) {
  return {
    dispatch(event: RealtimeEvent): void {
      options.actions[selectActionPort(event.type)](event);
      for (const effect of deriveEffects(event)) options.effects.emit(effect);
    },
  };
}

export interface RealtimeResyncActions {
  refreshForFocus(reason: 'visibility' | 'focus'): void;
  refreshForReconnect(): void;
  skipped(
    reason: 'visibility' | 'focus',
    cause: 'hidden' | 'disconnected' | 'throttled' | 'route',
  ): void;
}

export function createRealtimeController(options: {
  lifecycle: LifecycleService;
  navigation: NavigationService;
  connected(): boolean;
  routeEligible(pathname: string): boolean;
  clock(): number;
  actions: RealtimeResyncActions;
  minimumFocusIntervalMs?: number;
}) {
  let lastFocusResyncAt = 0;
  let hasConnectedBefore = false;
  let previousLifecycle = options.lifecycle.current();

  const considerFocusResync = (reason: 'visibility' | 'focus'): void => {
    const lifecycle = options.lifecycle.current();
    if (!lifecycle.visible) return options.actions.skipped(reason, 'hidden');
    if (!options.connected()) return options.actions.skipped(reason, 'disconnected');
    const now = options.clock();
    if (now - lastFocusResyncAt < (options.minimumFocusIntervalMs ?? 2_000)) {
      return options.actions.skipped(reason, 'throttled');
    }
    if (!options.routeEligible(options.navigation.current().pathname)) {
      return options.actions.skipped(reason, 'route');
    }
    lastFocusResyncAt = now;
    options.actions.refreshForFocus(reason);
  };

  return {
    handleConnected(): boolean {
      const reconnect = hasConnectedBefore;
      hasConnectedBefore = true;
      if (reconnect && options.routeEligible(options.navigation.current().pathname)) {
        options.actions.refreshForReconnect();
        return true;
      }
      return false;
    },
    start(): Unsubscribe {
      return options.lifecycle.subscribe((next) => {
        const becameVisible = !previousLifecycle.visible && next.visible;
        const gainedFocus = !previousLifecycle.focused && next.focused;
        previousLifecycle = next;
        if (becameVisible) considerFocusResync('visibility');
        else if (gainedFocus) considerFocusResync('focus');
      });
    },
    considerFocusResync,
  };
}

const ACTIVE_THREAD_STATUSES = new Set(['setting_up', 'pending', 'running', 'waiting']);

export function getSidebarResyncTargets(state: {
  threadIdsByProject: Record<string, string[]>;
  threadsById: Record<string, { status?: string } | undefined>;
  scratchThreadIds: string[];
  sharedThreadIds: string[];
}): { projectIds: string[]; scratch: boolean; shared: boolean } {
  const active = (id: string): boolean =>
    ACTIVE_THREAD_STATUSES.has(state.threadsById[id]?.status ?? '');
  return {
    projectIds: Object.entries(state.threadIdsByProject)
      .filter(([, ids]) => ids.some(active))
      .map(([projectId]) => projectId),
    scratch: state.scratchThreadIds.some(active),
    shared: state.sharedThreadIds.some(active),
  };
}
