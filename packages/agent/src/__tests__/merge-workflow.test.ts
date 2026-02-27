import { describe, expect, it, beforeEach, mock } from 'bun:test';

import type { PipelineServiceConfig } from '../config/schema.js';
import type { SessionStore } from '../core/session-store.js';
import type { PipelineEvent } from '../core/types.js';
import type { EventBus } from '../infrastructure/event-bus.js';
import { MergeWorkflow } from '../workflows/merge.workflow.js';

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
    onEventTypes: mock((types: string[], handler: (event: PipelineEvent) => void) => {
      for (const type of types) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type)!.push(handler);
      }
      return () => {
        for (const type of types) {
          const handlers = listeners.get(type) ?? [];
          listeners.set(
            type,
            handlers.filter((h) => h !== handler),
          );
        }
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

function makeConfig(overrides?: Record<string, any>) {
  return {
    reactions: {
      approved_and_green: {
        action: 'auto_merge' as const,
        message: 'PR approved and CI green — ready to merge',
      },
      agent_stuck: {
        action: 'escalate' as const,
        after_min: 15,
        message: 'Session stuck — needs human review',
      },
    },
    sessions: {
      auto_merge: true,
    },
    ...overrides,
  } as unknown as PipelineServiceConfig;
}

describe('MergeWorkflow', () => {
  let eventBus: ReturnType<typeof createMockEventBus>;
  let sessionStore: SessionStore;
  let mockAutoMerge: ReturnType<typeof mock>;
  let mockNotify: ReturnType<typeof mock>;
  let workflow: MergeWorkflow;
  let mockSession: any;

  beforeEach(() => {
    eventBus = createMockEventBus();
    mockAutoMerge = mock(async () => {});
    mockNotify = mock(async () => {});
    mockSession = {
      id: 'sess-1',
      issue: { number: 42 },
      prNumber: 10,
      isActive: true,
    };

    sessionStore = {
      get: mock(() => mockSession),
      transition: mock(async () => true),
    } as unknown as SessionStore;

    workflow = new MergeWorkflow({
      eventBus: eventBus as unknown as EventBus,
      sessionStore,
      config: makeConfig(),
      handlers: { autoMerge: mockAutoMerge, notify: mockNotify },
    });
  });

  it('has correct name', () => {
    expect(workflow.name).toBe('merge');
  });

  it('auto-merges when CI passes and PR is approved', async () => {
    workflow.start();

    eventBus.emit({
      event_type: 'session.ci_passed',
      request_id: 'sess-1',
      timestamp: new Date().toISOString(),
      data: { sessionId: 'sess-1', prApproved: true },
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(mockAutoMerge).toHaveBeenCalledWith('sess-1');
  });

  it('does not auto-merge when PR is not approved', async () => {
    workflow.start();

    eventBus.emit({
      event_type: 'session.ci_passed',
      request_id: 'sess-1',
      timestamp: new Date().toISOString(),
      data: { sessionId: 'sess-1', prApproved: false },
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(mockAutoMerge).not.toHaveBeenCalled();
  });

  it('notifies instead of merging when auto_merge is disabled', async () => {
    workflow = new MergeWorkflow({
      eventBus: eventBus as unknown as EventBus,
      sessionStore,
      config: makeConfig({ sessions: { auto_merge: false } }),
      handlers: { autoMerge: mockAutoMerge, notify: mockNotify },
    });
    workflow.start();

    eventBus.emit({
      event_type: 'session.ci_passed',
      request_id: 'sess-1',
      timestamp: new Date().toISOString(),
      data: { sessionId: 'sess-1', prApproved: true },
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(mockAutoMerge).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalled();
  });

  it('cleans up stuck timers on stop', () => {
    workflow.start();
    // Should not throw
    workflow.stop();
  });
});
