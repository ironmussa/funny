import { describe, test, expect, mock, beforeEach } from 'bun:test';

import {
  ThreadEventBus,
  threadEventBus,
  type ThreadCreatedEvent,
  type ThreadStageChangedEvent,
  type ThreadDeletedEvent,
  type AgentStartedEvent,
  type AgentCompletedEvent,
} from '../../services/thread-event-bus.js';

describe('ThreadEventBus', () => {
  let bus: ThreadEventBus;

  beforeEach(() => {
    bus = new ThreadEventBus();
  });

  test('can be instantiated', () => {
    expect(bus).toBeInstanceOf(ThreadEventBus);
  });

  describe('thread:created', () => {
    test('emit/on works for thread:created event', () => {
      const handler = mock(() => {});
      const payload: ThreadCreatedEvent = {
        threadId: 't-1',
        projectId: 'p-1',
        userId: 'u-1',
        worktreePath: '/tmp/wt-1',
        cwd: '/projects/my-app',
        stage: 'backlog',
        status: 'idle',
        initialPrompt: 'Fix the login bug',
      };

      bus.on('thread:created', handler);
      bus.emit('thread:created', payload);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(payload);
    });
  });

  describe('thread:stage-changed', () => {
    test('emit/on works for thread:stage-changed event', () => {
      const handler = mock(() => {});
      const payload: ThreadStageChangedEvent = {
        threadId: 't-2',
        projectId: 'p-2',
        userId: 'u-2',
        worktreePath: null,
        cwd: '/projects/other',
        fromStage: 'backlog',
        toStage: 'in_progress',
      };

      bus.on('thread:stage-changed', handler);
      bus.emit('thread:stage-changed', payload);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(payload);
    });
  });

  describe('thread:deleted', () => {
    test('emit/on works for thread:deleted event', () => {
      const handler = mock(() => {});
      const payload: ThreadDeletedEvent = {
        threadId: 't-3',
        projectId: 'p-3',
        userId: 'u-3',
        worktreePath: '/tmp/wt-3',
      };

      bus.on('thread:deleted', handler);
      bus.emit('thread:deleted', payload);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(payload);
    });
  });

  describe('agent:started', () => {
    test('emit/on works for agent:started event', () => {
      const handler = mock(() => {});
      const payload: AgentStartedEvent = {
        threadId: 't-4',
        projectId: 'p-4',
        userId: 'u-4',
        worktreePath: '/tmp/wt-4',
        cwd: '/projects/demo',
        model: 'sonnet',
        provider: 'claude',
      };

      bus.on('agent:started', handler);
      bus.emit('agent:started', payload);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(payload);
    });
  });

  describe('agent:completed', () => {
    test('emit/on works for agent:completed event', () => {
      const handler = mock(() => {});
      const payload: AgentCompletedEvent = {
        threadId: 't-5',
        projectId: 'p-5',
        userId: 'u-5',
        worktreePath: null,
        cwd: '/projects/app',
        status: 'completed',
        cost: 0.042,
      };

      bus.on('agent:completed', handler);
      bus.emit('agent:completed', payload);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(payload);
    });

    test('handles failed status', () => {
      const handler = mock(() => {});
      const payload: AgentCompletedEvent = {
        threadId: 't-6',
        projectId: 'p-6',
        userId: 'u-6',
        worktreePath: null,
        cwd: '/projects/app',
        status: 'failed',
        cost: 0.01,
      };

      bus.on('agent:completed', handler);
      bus.emit('agent:completed', payload);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].status).toBe('failed');
    });

    test('handles stopped status', () => {
      const handler = mock(() => {});
      const payload: AgentCompletedEvent = {
        threadId: 't-7',
        projectId: 'p-7',
        userId: 'u-7',
        worktreePath: '/tmp/wt-7',
        cwd: '/projects/app',
        status: 'stopped',
        cost: 0,
      };

      bus.on('agent:completed', handler);
      bus.emit('agent:completed', payload);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].status).toBe('stopped');
    });
  });

  describe('multiple listeners', () => {
    test('multiple listeners receive the same event', () => {
      const handler1 = mock(() => {});
      const handler2 = mock(() => {});
      const handler3 = mock(() => {});
      const payload: ThreadCreatedEvent = {
        threadId: 't-multi',
        projectId: 'p-multi',
        userId: 'u-multi',
        worktreePath: null,
        cwd: '/projects/multi',
        stage: 'in_progress',
        status: 'running',
      };

      bus.on('thread:created', handler1);
      bus.on('thread:created', handler2);
      bus.on('thread:created', handler3);
      bus.emit('thread:created', payload);

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler1).toHaveBeenCalledWith(payload);
      expect(handler2).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledWith(payload);
      expect(handler3).toHaveBeenCalledTimes(1);
      expect(handler3).toHaveBeenCalledWith(payload);
    });
  });

  describe('removing listeners', () => {
    test('removing a listener stops it from being called', () => {
      const handler = mock(() => {});
      const payload: ThreadDeletedEvent = {
        threadId: 't-rm',
        projectId: 'p-rm',
        userId: 'u-rm',
        worktreePath: null,
      };

      bus.on('thread:deleted', handler);
      bus.emit('thread:deleted', payload);
      expect(handler).toHaveBeenCalledTimes(1);

      bus.removeListener('thread:deleted', handler);
      bus.emit('thread:deleted', payload);
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('singleton export', () => {
    test('threadEventBus singleton exists and is a ThreadEventBus instance', () => {
      expect(threadEventBus).toBeDefined();
      expect(threadEventBus).toBeInstanceOf(ThreadEventBus);
    });
  });
});
