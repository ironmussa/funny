import { describe, expect, it, beforeEach, mock } from 'bun:test';

import type { PipelineEvent } from '../core/types.js';
import type { EventBus } from '../infrastructure/event-bus.js';
import { WorkflowEventEmitter } from '../workflows/workflow-event-emitter.js';

function createMockEventBus() {
  const published: PipelineEvent[] = [];
  const publish = mock(async (event: PipelineEvent) => {
    published.push(event);
  });
  return { publish, published, bus: { publish } as unknown as EventBus };
}

describe('WorkflowEventEmitter', () => {
  let emitter: WorkflowEventEmitter;
  let mockBus: ReturnType<typeof createMockEventBus>;

  beforeEach(() => {
    mockBus = createMockEventBus();
    emitter = new WorkflowEventEmitter(mockBus.bus);
  });

  it('publishes event with correct shape', async () => {
    await emitter.emit('session.created', 'sess-1', {
      issueUrl: 'https://github.com/org/repo/issues/1',
    });

    expect(mockBus.publish).toHaveBeenCalledTimes(1);
    const event = mockBus.published[0];
    expect(event.event_type).toBe('session.created');
    expect(event.request_id).toBe('sess-1');
    expect(event.data).toEqual({ issueUrl: 'https://github.com/org/repo/issues/1' });
    expect(event.timestamp).toBeTruthy();
  });

  it('publishes event with empty data by default', async () => {
    await emitter.emit('session.merged', 'sess-2');

    const event = mockBus.published[0];
    expect(event.data).toEqual({});
  });

  it('sets ISO timestamp', async () => {
    await emitter.emit('session.plan_ready', 'sess-3');

    const event = mockBus.published[0];
    const parsed = new Date(event.timestamp);
    expect(parsed.getTime()).not.toBeNaN();
  });

  it('delegates to eventBus.publish', async () => {
    await emitter.emit('session.ci_passed', 'sess-4', { sha: 'abc123' });

    expect(mockBus.publish).toHaveBeenCalledTimes(1);
    expect(mockBus.publish.mock.calls[0][0]).toMatchObject({
      event_type: 'session.ci_passed',
      request_id: 'sess-4',
    });
  });
});
