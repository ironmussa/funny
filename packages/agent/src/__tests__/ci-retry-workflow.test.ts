import { describe, expect, it, beforeEach, mock } from 'bun:test';

import type { PipelineServiceConfig } from '../config/schema.js';
import type { SessionStore } from '../core/session-store.js';
import type { PipelineEvent } from '../core/types.js';
import type { EventBus } from '../infrastructure/event-bus.js';
import { CIRetryWorkflow } from '../workflows/ci-retry.workflow.js';

function createMockEventBus() {
  const published: PipelineEvent[] = [];
  const listeners = new Map<string, ((event: PipelineEvent) => void)[]>();

  return {
    publish: mock(async (event: PipelineEvent) => {
      published.push(event);
    }),
    onEventType: mock((type: string, handler: (event: PipelineEvent) => void) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type)!.push(handler);
      return () => {
        const handlers = listeners.get(type) ?? [];
        listeners.set(
          type,
          handlers.filter((h) => h !== handler),
        );
      };
    }),
    published,
    listeners,
    emit: (event: PipelineEvent) => {
      const handlers = listeners.get(event.event_type) ?? [];
      for (const h of handlers) h(event);
    },
  } as unknown as EventBus & {
    published: PipelineEvent[];
    listeners: Map<string, Function[]>;
    emit: (e: PipelineEvent) => void;
  };
}

function makeConfig(overrides?: Partial<PipelineServiceConfig['reactions']['ci_failed']>) {
  return {
    reactions: {
      ci_failed: {
        action: 'respawn_agent' as const,
        prompt: 'Fix CI failures.',
        max_retries: 3,
        ...overrides,
      },
    },
  } as unknown as PipelineServiceConfig;
}

describe('CIRetryWorkflow', () => {
  let eventBus: ReturnType<typeof createMockEventBus>;
  let sessionStore: SessionStore;
  let mockRespawn: ReturnType<typeof mock>;
  let mockNotify: ReturnType<typeof mock>;
  let workflow: CIRetryWorkflow;
  let mockSession: any;

  beforeEach(() => {
    eventBus = createMockEventBus();
    mockRespawn = mock(async () => {});
    mockNotify = mock(async () => {});
    mockSession = {
      id: 'sess-1',
      issue: { number: 42 },
      prNumber: 10,
      incrementCIAttempts: mock(() => 1),
    };

    sessionStore = {
      get: mock(() => mockSession),
      transition: mock(async () => true),
    } as unknown as SessionStore;

    workflow = new CIRetryWorkflow({
      eventBus: eventBus as unknown as EventBus,
      sessionStore,
      config: makeConfig(),
      handlers: { respawnAgent: mockRespawn, notify: mockNotify },
    });
  });

  it('has correct name', () => {
    expect(workflow.name).toBe('ci-retry');
  });

  it('subscribes to session.ci_failed on start', () => {
    workflow.start();
    expect(eventBus.onEventType).toHaveBeenCalledWith('session.ci_failed', expect.any(Function));
  });

  it('respawns agent on CI failure within retry budget', async () => {
    workflow.start();

    eventBus.emit({
      event_type: 'session.ci_failed',
      request_id: 'sess-1',
      timestamp: new Date().toISOString(),
      data: { sessionId: 'sess-1' },
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(mockRespawn).toHaveBeenCalledTimes(1);
    expect(mockRespawn).toHaveBeenCalledWith('sess-1', 'Fix CI failures.');
  });

  it('escalates when retry budget exhausted', async () => {
    mockSession.incrementCIAttempts = mock(() => 4); // > max_retries (3)

    workflow = new CIRetryWorkflow({
      eventBus: eventBus as unknown as EventBus,
      sessionStore,
      config: makeConfig(),
      handlers: { respawnAgent: mockRespawn, notify: mockNotify },
    });
    workflow.start();

    eventBus.emit({
      event_type: 'session.ci_failed',
      request_id: 'sess-1',
      timestamp: new Date().toISOString(),
      data: { sessionId: 'sess-1' },
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(mockRespawn).not.toHaveBeenCalled();
    expect(sessionStore.transition as any).toHaveBeenCalledWith(
      'sess-1',
      'escalated',
      expect.objectContaining({ reason: expect.stringContaining('exceeded retry budget') }),
    );
  });

  it('unsubscribes on stop', () => {
    workflow.start();
    workflow.stop();

    eventBus.emit({
      event_type: 'session.ci_failed',
      request_id: 'sess-1',
      timestamp: new Date().toISOString(),
      data: { sessionId: 'sess-1' },
    });

    expect(mockRespawn).not.toHaveBeenCalled();
  });

  it('ignores events for unknown sessions', async () => {
    (sessionStore.get as any).mockImplementation(() => undefined);

    workflow.start();

    eventBus.emit({
      event_type: 'session.ci_failed',
      request_id: 'unknown',
      timestamp: new Date().toISOString(),
      data: { sessionId: 'unknown' },
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(mockRespawn).not.toHaveBeenCalled();
  });
});
