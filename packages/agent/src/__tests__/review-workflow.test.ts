import { describe, expect, it, beforeEach, mock } from 'bun:test';

import type { PipelineServiceConfig } from '../config/schema.js';
import type { SessionStore } from '../core/session-store.js';
import type { PipelineEvent } from '../core/types.js';
import type { EventBus } from '../infrastructure/event-bus.js';
import { ReviewWorkflow } from '../workflows/review.workflow.js';

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

function makeConfig(overrides?: Partial<PipelineServiceConfig['reactions']['changes_requested']>) {
  return {
    reactions: {
      changes_requested: {
        action: 'respawn_agent' as const,
        prompt: 'Address review feedback.',
        max_retries: 2,
        escalate_after_min: 30,
        ...overrides,
      },
    },
  } as unknown as PipelineServiceConfig;
}

describe('ReviewWorkflow', () => {
  let eventBus: ReturnType<typeof createMockEventBus>;
  let sessionStore: SessionStore;
  let mockRespawn: ReturnType<typeof mock>;
  let mockNotify: ReturnType<typeof mock>;
  let workflow: ReviewWorkflow;
  let mockSession: any;

  beforeEach(() => {
    eventBus = createMockEventBus();
    mockRespawn = mock(async () => {});
    mockNotify = mock(async () => {});
    mockSession = {
      id: 'sess-1',
      issue: { number: 42 },
      prNumber: 10,
      incrementReviewAttempts: mock(() => 1),
    };

    sessionStore = {
      get: mock(() => mockSession),
      transition: mock(async () => true),
    } as unknown as SessionStore;

    workflow = new ReviewWorkflow({
      eventBus: eventBus as unknown as EventBus,
      sessionStore,
      config: makeConfig(),
      handlers: { respawnAgent: mockRespawn, notify: mockNotify },
    });
  });

  it('has correct name', () => {
    expect(workflow.name).toBe('review');
  });

  it('subscribes to session.changes_requested on start', () => {
    workflow.start();
    expect(eventBus.onEventType).toHaveBeenCalledWith(
      'session.changes_requested',
      expect.any(Function),
    );
  });

  it('respawns agent on changes requested within retry budget', async () => {
    workflow.start();

    eventBus.emit({
      event_type: 'session.changes_requested',
      request_id: 'sess-1',
      timestamp: new Date().toISOString(),
      data: { sessionId: 'sess-1' },
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(mockRespawn).toHaveBeenCalledTimes(1);
    expect(mockRespawn).toHaveBeenCalledWith('sess-1', 'Address review feedback.');
  });

  it('escalates when review retry budget exhausted', async () => {
    mockSession.incrementReviewAttempts = mock(() => 3); // > max_retries (2)

    workflow = new ReviewWorkflow({
      eventBus: eventBus as unknown as EventBus,
      sessionStore,
      config: makeConfig(),
      handlers: { respawnAgent: mockRespawn, notify: mockNotify },
    });
    workflow.start();

    eventBus.emit({
      event_type: 'session.changes_requested',
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
      event_type: 'session.changes_requested',
      request_id: 'sess-1',
      timestamp: new Date().toISOString(),
      data: { sessionId: 'sess-1' },
    });

    expect(mockRespawn).not.toHaveBeenCalled();
  });
});
