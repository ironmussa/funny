import { describe, test, expect } from 'vitest';
import { createActor } from 'xstate';
import { threadMachine, wsEventToMachineEvent } from '@/machines/thread-machine';
import type { ThreadEvent } from '@/machines/thread-machine';

/**
 * Helper to create a thread machine actor with default context and start it.
 */
function createThreadActor(initialStatus?: string) {
  const actor = createActor(threadMachine, {
    input: { threadId: 'test-thread', cost: 0, resumeReason: null },
  });
  actor.start();

  // If an initial status other than 'pending' is needed, transition to it
  if (initialStatus === 'running') {
    actor.send({ type: 'START' });
  } else if (initialStatus === 'completed') {
    actor.send({ type: 'START' });
    actor.send({ type: 'COMPLETE', cost: 0.05, duration: 1000 });
  } else if (initialStatus === 'failed') {
    actor.send({ type: 'START' });
    actor.send({ type: 'FAIL', cost: 0.01, duration: 500 });
  } else if (initialStatus === 'stopped') {
    actor.send({ type: 'START' });
    actor.send({ type: 'STOP' });
  } else if (initialStatus === 'interrupted') {
    actor.send({ type: 'START' });
    actor.send({ type: 'INTERRUPT' });
  } else if (initialStatus === 'waiting') {
    actor.send({ type: 'START' });
    actor.send({ type: 'WAIT', cost: 0.02 });
  }

  return actor;
}

describe('threadMachine', () => {
  describe('initial state', () => {
    test('starts in pending state', () => {
      const actor = createActor(threadMachine, {
        input: { threadId: 'test', cost: 0, resumeReason: null },
      });
      actor.start();
      expect(actor.getSnapshot().value).toBe('pending');
      actor.stop();
    });

    test('has initial context from input', () => {
      const actor = createActor(threadMachine, {
        input: { threadId: 'my-thread', cost: 1.5, resumeReason: null },
      });
      actor.start();
      const ctx = actor.getSnapshot().context;
      expect(ctx.threadId).toBe('my-thread');
      expect(ctx.cost).toBe(1.5);
      actor.stop();
    });
  });

  describe('pending transitions', () => {
    test('pending -> running on START', () => {
      const actor = createThreadActor();
      actor.send({ type: 'START' });
      expect(actor.getSnapshot().value).toBe('running');
      actor.stop();
    });

    test('pending -> running on SET_STATUS running', () => {
      const actor = createThreadActor();
      actor.send({ type: 'SET_STATUS', status: 'running' });
      expect(actor.getSnapshot().value).toBe('running');
      actor.stop();
    });

    test('pending -> waiting on SET_STATUS waiting', () => {
      const actor = createThreadActor();
      actor.send({ type: 'SET_STATUS', status: 'waiting' });
      expect(actor.getSnapshot().value).toBe('waiting');
      actor.stop();
    });

    test('pending -> completed on SET_STATUS completed', () => {
      const actor = createThreadActor();
      actor.send({ type: 'SET_STATUS', status: 'completed' });
      expect(actor.getSnapshot().value).toBe('completed');
      actor.stop();
    });

    test('pending -> failed on SET_STATUS failed', () => {
      const actor = createThreadActor();
      actor.send({ type: 'SET_STATUS', status: 'failed' });
      expect(actor.getSnapshot().value).toBe('failed');
      actor.stop();
    });

    test('pending -> stopped on SET_STATUS stopped', () => {
      const actor = createThreadActor();
      actor.send({ type: 'SET_STATUS', status: 'stopped' });
      expect(actor.getSnapshot().value).toBe('stopped');
      actor.stop();
    });

    test('pending -> interrupted on SET_STATUS interrupted', () => {
      const actor = createThreadActor();
      actor.send({ type: 'SET_STATUS', status: 'interrupted' });
      expect(actor.getSnapshot().value).toBe('interrupted');
      actor.stop();
    });
  });

  describe('running transitions', () => {
    test('running -> completed on COMPLETE', () => {
      const actor = createThreadActor('running');
      actor.send({ type: 'COMPLETE', cost: 0.10, duration: 2000 });
      expect(actor.getSnapshot().value).toBe('completed');
      actor.stop();
    });

    test('running -> failed on FAIL', () => {
      const actor = createThreadActor('running');
      actor.send({ type: 'FAIL', cost: 0.01, duration: 100 });
      expect(actor.getSnapshot().value).toBe('failed');
      actor.stop();
    });

    test('running -> stopped on STOP', () => {
      const actor = createThreadActor('running');
      actor.send({ type: 'STOP' });
      expect(actor.getSnapshot().value).toBe('stopped');
      actor.stop();
    });

    test('running -> interrupted on INTERRUPT', () => {
      const actor = createThreadActor('running');
      actor.send({ type: 'INTERRUPT' });
      expect(actor.getSnapshot().value).toBe('interrupted');
      actor.stop();
    });

    test('running -> waiting on WAIT', () => {
      const actor = createThreadActor('running');
      actor.send({ type: 'WAIT', cost: 0.03 });
      expect(actor.getSnapshot().value).toBe('waiting');
      actor.stop();
    });

    test('running -> running self-transition on START', () => {
      const actor = createThreadActor('running');
      actor.send({ type: 'START' });
      expect(actor.getSnapshot().value).toBe('running');
      actor.stop();
    });

    test('running updates cost on COMPLETE', () => {
      const actor = createThreadActor('running');
      actor.send({ type: 'COMPLETE', cost: 0.25, duration: 3000 });
      const ctx = actor.getSnapshot().context;
      expect(ctx.cost).toBe(0.25);
      actor.stop();
    });

    test('running sets resultInfo on COMPLETE', () => {
      const actor = createThreadActor('running');
      actor.send({ type: 'COMPLETE', cost: 0.25, duration: 3000 });
      const ctx = actor.getSnapshot().context;
      expect(ctx.resultInfo).toEqual({
        status: 'completed',
        cost: 0.25,
        duration: 3000,
      });
      actor.stop();
    });

    test('running sets resultInfo on FAIL', () => {
      const actor = createThreadActor('running');
      actor.send({ type: 'FAIL', cost: 0.01, duration: 500 });
      const ctx = actor.getSnapshot().context;
      expect(ctx.resultInfo).toEqual({
        status: 'failed',
        cost: 0.01,
        duration: 500,
      });
      actor.stop();
    });

    test('running clears resultInfo on entry', () => {
      // First complete, then restart -> resultInfo should be cleared
      const actor = createThreadActor('completed');
      expect(actor.getSnapshot().context.resultInfo).toBeDefined();
      actor.send({ type: 'RESTART' });
      expect(actor.getSnapshot().value).toBe('running');
      expect(actor.getSnapshot().context.resultInfo).toBeUndefined();
      actor.stop();
    });

    test('running -> completed on SET_STATUS completed', () => {
      const actor = createThreadActor('running');
      actor.send({ type: 'SET_STATUS', status: 'completed' });
      expect(actor.getSnapshot().value).toBe('completed');
      actor.stop();
    });

    test('running -> failed on SET_STATUS failed', () => {
      const actor = createThreadActor('running');
      actor.send({ type: 'SET_STATUS', status: 'failed' });
      expect(actor.getSnapshot().value).toBe('failed');
      actor.stop();
    });

    test('running -> stopped on SET_STATUS stopped', () => {
      const actor = createThreadActor('running');
      actor.send({ type: 'SET_STATUS', status: 'stopped' });
      expect(actor.getSnapshot().value).toBe('stopped');
      actor.stop();
    });

    test('running -> interrupted on SET_STATUS interrupted', () => {
      const actor = createThreadActor('running');
      actor.send({ type: 'SET_STATUS', status: 'interrupted' });
      expect(actor.getSnapshot().value).toBe('interrupted');
      actor.stop();
    });

    test('running -> waiting on SET_STATUS waiting', () => {
      const actor = createThreadActor('running');
      actor.send({ type: 'SET_STATUS', status: 'waiting' });
      expect(actor.getSnapshot().value).toBe('waiting');
      actor.stop();
    });
  });

  describe('waiting transitions', () => {
    test('waiting -> running on RESPOND', () => {
      const actor = createThreadActor('waiting');
      actor.send({ type: 'RESPOND' });
      expect(actor.getSnapshot().value).toBe('running');
      actor.stop();
    });

    test('waiting -> running on START', () => {
      const actor = createThreadActor('waiting');
      actor.send({ type: 'START' });
      expect(actor.getSnapshot().value).toBe('running');
      actor.stop();
    });

    test('waiting -> running on RESTART', () => {
      const actor = createThreadActor('waiting');
      actor.send({ type: 'RESTART' });
      expect(actor.getSnapshot().value).toBe('running');
      actor.stop();
    });

    test('waiting -> completed on COMPLETE', () => {
      const actor = createThreadActor('waiting');
      actor.send({ type: 'COMPLETE', cost: 0.10, duration: 5000 });
      expect(actor.getSnapshot().value).toBe('completed');
      actor.stop();
    });

    test('waiting -> failed on FAIL', () => {
      const actor = createThreadActor('waiting');
      actor.send({ type: 'FAIL', cost: 0.01, duration: 100 });
      expect(actor.getSnapshot().value).toBe('failed');
      actor.stop();
    });

    test('waiting -> waiting self-transition on WAIT', () => {
      const actor = createThreadActor('waiting');
      actor.send({ type: 'WAIT', cost: 0.05 });
      expect(actor.getSnapshot().value).toBe('waiting');
      expect(actor.getSnapshot().context.cost).toBe(0.05);
      actor.stop();
    });

    test('waiting -> stopped on STOP', () => {
      const actor = createThreadActor('waiting');
      actor.send({ type: 'STOP' });
      expect(actor.getSnapshot().value).toBe('stopped');
      actor.stop();
    });

    test('waiting -> running on SET_STATUS running', () => {
      const actor = createThreadActor('waiting');
      actor.send({ type: 'SET_STATUS', status: 'running' });
      expect(actor.getSnapshot().value).toBe('running');
      actor.stop();
    });

    test('waiting -> completed on SET_STATUS completed', () => {
      const actor = createThreadActor('waiting');
      actor.send({ type: 'SET_STATUS', status: 'completed' });
      expect(actor.getSnapshot().value).toBe('completed');
      actor.stop();
    });
  });

  describe('completed transitions', () => {
    test('completed -> running on FOLLOW_UP', () => {
      const actor = createThreadActor('completed');
      actor.send({ type: 'FOLLOW_UP' });
      expect(actor.getSnapshot().value).toBe('running');
      actor.stop();
    });

    test('completed -> running on RESTART', () => {
      const actor = createThreadActor('completed');
      actor.send({ type: 'RESTART' });
      expect(actor.getSnapshot().value).toBe('running');
      actor.stop();
    });

    test('completed -> running on START', () => {
      const actor = createThreadActor('completed');
      actor.send({ type: 'START' });
      expect(actor.getSnapshot().value).toBe('running');
      actor.stop();
    });

    test('completed -> stopped on STOP', () => {
      const actor = createThreadActor('completed');
      actor.send({ type: 'STOP' });
      expect(actor.getSnapshot().value).toBe('stopped');
      actor.stop();
    });

    test('completed -> interrupted on INTERRUPT', () => {
      const actor = createThreadActor('completed');
      actor.send({ type: 'INTERRUPT' });
      expect(actor.getSnapshot().value).toBe('interrupted');
      actor.stop();
    });

    test('completed -> running on SET_STATUS running', () => {
      const actor = createThreadActor('completed');
      actor.send({ type: 'SET_STATUS', status: 'running' });
      expect(actor.getSnapshot().value).toBe('running');
      actor.stop();
    });

    test('completed -> stopped on SET_STATUS stopped', () => {
      const actor = createThreadActor('completed');
      actor.send({ type: 'SET_STATUS', status: 'stopped' });
      expect(actor.getSnapshot().value).toBe('stopped');
      actor.stop();
    });

    test('completed -> interrupted on SET_STATUS interrupted', () => {
      const actor = createThreadActor('completed');
      actor.send({ type: 'SET_STATUS', status: 'interrupted' });
      expect(actor.getSnapshot().value).toBe('interrupted');
      actor.stop();
    });
  });

  describe('failed transitions', () => {
    test('failed -> running on RESTART', () => {
      const actor = createThreadActor('failed');
      actor.send({ type: 'RESTART' });
      expect(actor.getSnapshot().value).toBe('running');
      actor.stop();
    });

    test('failed -> running on START', () => {
      const actor = createThreadActor('failed');
      actor.send({ type: 'START' });
      expect(actor.getSnapshot().value).toBe('running');
      actor.stop();
    });

    test('failed -> running on SET_STATUS running', () => {
      const actor = createThreadActor('failed');
      actor.send({ type: 'SET_STATUS', status: 'running' });
      expect(actor.getSnapshot().value).toBe('running');
      actor.stop();
    });

    test('failed stays in failed for non-running SET_STATUS', () => {
      const actor = createThreadActor('failed');
      actor.send({ type: 'SET_STATUS', status: 'completed' });
      // No guard matches for completed in failed state
      expect(actor.getSnapshot().value).toBe('failed');
      actor.stop();
    });
  });

  describe('stopped transitions', () => {
    test('stopped -> running on RESTART', () => {
      const actor = createThreadActor('stopped');
      actor.send({ type: 'RESTART' });
      expect(actor.getSnapshot().value).toBe('running');
      actor.stop();
    });

    test('stopped -> running on START', () => {
      const actor = createThreadActor('stopped');
      actor.send({ type: 'START' });
      expect(actor.getSnapshot().value).toBe('running');
      actor.stop();
    });

    test('stopped -> running on SET_STATUS running', () => {
      const actor = createThreadActor('stopped');
      actor.send({ type: 'SET_STATUS', status: 'running' });
      expect(actor.getSnapshot().value).toBe('running');
      actor.stop();
    });
  });

  describe('interrupted transitions', () => {
    test('interrupted -> running on RESTART', () => {
      const actor = createThreadActor('interrupted');
      actor.send({ type: 'RESTART' });
      expect(actor.getSnapshot().value).toBe('running');
      actor.stop();
    });

    test('interrupted -> running on START', () => {
      const actor = createThreadActor('interrupted');
      actor.send({ type: 'START' });
      expect(actor.getSnapshot().value).toBe('running');
      actor.stop();
    });

    test('interrupted -> running on SET_STATUS running', () => {
      const actor = createThreadActor('interrupted');
      actor.send({ type: 'SET_STATUS', status: 'running' });
      expect(actor.getSnapshot().value).toBe('running');
      actor.stop();
    });
  });

  describe('full lifecycle scenarios', () => {
    test('pending -> running -> completed -> running (restart)', () => {
      const actor = createThreadActor();
      expect(actor.getSnapshot().value).toBe('pending');

      actor.send({ type: 'START' });
      expect(actor.getSnapshot().value).toBe('running');

      actor.send({ type: 'COMPLETE', cost: 0.10, duration: 2000 });
      expect(actor.getSnapshot().value).toBe('completed');
      expect(actor.getSnapshot().context.resultInfo?.status).toBe('completed');

      actor.send({ type: 'RESTART' });
      expect(actor.getSnapshot().value).toBe('running');
      expect(actor.getSnapshot().context.resultInfo).toBeUndefined();

      actor.stop();
    });

    test('pending -> running -> waiting -> running -> completed', () => {
      const actor = createThreadActor();
      actor.send({ type: 'START' });
      actor.send({ type: 'WAIT', cost: 0.01 });
      expect(actor.getSnapshot().value).toBe('waiting');

      actor.send({ type: 'START' });
      expect(actor.getSnapshot().value).toBe('running');

      actor.send({ type: 'COMPLETE', cost: 0.05, duration: 1000 });
      expect(actor.getSnapshot().value).toBe('completed');

      actor.stop();
    });

    test('pending -> running -> failed -> running (retry) -> completed', () => {
      const actor = createThreadActor();
      actor.send({ type: 'START' });
      actor.send({ type: 'FAIL', cost: 0.01, duration: 100 });
      expect(actor.getSnapshot().value).toBe('failed');

      actor.send({ type: 'RESTART' });
      expect(actor.getSnapshot().value).toBe('running');

      actor.send({ type: 'COMPLETE', cost: 0.05, duration: 2000 });
      expect(actor.getSnapshot().value).toBe('completed');

      actor.stop();
    });
  });

  describe('resumeReason context', () => {
    test('START from pending sets resumeReason to "fresh"', () => {
      const actor = createThreadActor();
      actor.send({ type: 'START' });
      expect(actor.getSnapshot().context.resumeReason).toBe('fresh');
      actor.stop();
    });

    test('RESPOND from waiting sets resumeReason to "waiting-response"', () => {
      const actor = createThreadActor('waiting');
      actor.send({ type: 'RESPOND' });
      expect(actor.getSnapshot().context.resumeReason).toBe('waiting-response');
      actor.stop();
    });

    test('FOLLOW_UP from completed sets resumeReason to "follow-up"', () => {
      const actor = createThreadActor('completed');
      actor.send({ type: 'FOLLOW_UP' });
      expect(actor.getSnapshot().context.resumeReason).toBe('follow-up');
      actor.stop();
    });

    test('RESTART from stopped sets resumeReason to "interrupted"', () => {
      const actor = createThreadActor('stopped');
      actor.send({ type: 'RESTART' });
      expect(actor.getSnapshot().context.resumeReason).toBe('interrupted');
      actor.stop();
    });

    test('RESTART from failed sets resumeReason to "interrupted"', () => {
      const actor = createThreadActor('failed');
      actor.send({ type: 'RESTART' });
      expect(actor.getSnapshot().context.resumeReason).toBe('interrupted');
      actor.stop();
    });

    test('RESTART from interrupted sets resumeReason to "interrupted"', () => {
      const actor = createThreadActor('interrupted');
      actor.send({ type: 'RESTART' });
      expect(actor.getSnapshot().context.resumeReason).toBe('interrupted');
      actor.stop();
    });

    test('resumeReason is cleared on COMPLETE', () => {
      const actor = createThreadActor();
      actor.send({ type: 'START' });
      expect(actor.getSnapshot().context.resumeReason).toBe('fresh');
      actor.send({ type: 'COMPLETE', cost: 0.05, duration: 1000 });
      expect(actor.getSnapshot().context.resumeReason).toBeNull();
      actor.stop();
    });

    test('resumeReason is cleared on FAIL', () => {
      const actor = createThreadActor();
      actor.send({ type: 'START' });
      actor.send({ type: 'FAIL', cost: 0.01, duration: 100 });
      expect(actor.getSnapshot().context.resumeReason).toBeNull();
      actor.stop();
    });
  });
});

describe('wsEventToMachineEvent', () => {
  describe('agent:status events', () => {
    test('status=running returns START event', () => {
      const result = wsEventToMachineEvent('agent:status', { status: 'running' });
      expect(result).toEqual({ type: 'START' });
    });

    test('status=stopped returns STOP event', () => {
      const result = wsEventToMachineEvent('agent:status', { status: 'stopped' });
      expect(result).toEqual({ type: 'STOP' });
    });

    test('status=interrupted returns INTERRUPT event', () => {
      const result = wsEventToMachineEvent('agent:status', { status: 'interrupted' });
      expect(result).toEqual({ type: 'INTERRUPT' });
    });

    test('status=pending returns SET_STATUS event', () => {
      const result = wsEventToMachineEvent('agent:status', { status: 'pending' });
      expect(result).toEqual({ type: 'SET_STATUS', status: 'pending' });
    });

    test('status=completed returns SET_STATUS event', () => {
      const result = wsEventToMachineEvent('agent:status', { status: 'completed' });
      expect(result).toEqual({ type: 'SET_STATUS', status: 'completed' });
    });

    test('status=failed returns SET_STATUS event', () => {
      const result = wsEventToMachineEvent('agent:status', { status: 'failed' });
      expect(result).toEqual({ type: 'SET_STATUS', status: 'failed' });
    });

    test('status=waiting returns SET_STATUS event', () => {
      const result = wsEventToMachineEvent('agent:status', { status: 'waiting' });
      expect(result).toEqual({ type: 'SET_STATUS', status: 'waiting' });
    });
  });

  describe('agent:result events', () => {
    test('status=completed returns COMPLETE with cost and duration', () => {
      const result = wsEventToMachineEvent('agent:result', {
        status: 'completed',
        cost: 0.15,
        duration: 5000,
      });
      expect(result).toEqual({
        type: 'COMPLETE',
        cost: 0.15,
        duration: 5000,
      });
    });

    test('defaults to completed when status is missing', () => {
      const result = wsEventToMachineEvent('agent:result', {
        cost: 0.05,
        duration: 1000,
      });
      expect(result).toEqual({
        type: 'COMPLETE',
        cost: 0.05,
        duration: 1000,
      });
    });

    test('status=waiting returns WAIT with cost and duration', () => {
      const result = wsEventToMachineEvent('agent:result', {
        status: 'waiting',
        cost: 0.02,
        duration: 3000,
      });
      expect(result).toEqual({
        type: 'WAIT',
        cost: 0.02,
        duration: 3000,
      });
    });

    test('status=failed returns FAIL with cost and duration', () => {
      const result = wsEventToMachineEvent('agent:result', {
        status: 'failed',
        cost: 0.01,
        duration: 500,
      });
      expect(result).toEqual({
        type: 'FAIL',
        cost: 0.01,
        duration: 500,
      });
    });

    test('unknown result status returns null', () => {
      const result = wsEventToMachineEvent('agent:result', {
        status: 'unknown_status',
      });
      expect(result).toBeNull();
    });
  });

  describe('agent:error events', () => {
    test('returns FAIL event with error', () => {
      const result = wsEventToMachineEvent('agent:error', {
        error: 'Something went wrong',
      });
      expect(result).toEqual({ type: 'FAIL', error: 'Something went wrong' });
    });

    test('returns FAIL with undefined error when missing', () => {
      const result = wsEventToMachineEvent('agent:error', {});
      expect(result).toEqual({ type: 'FAIL', error: undefined });
    });
  });

  describe('unknown events', () => {
    test('returns null for agent:message', () => {
      const result = wsEventToMachineEvent('agent:message', { content: 'hello' });
      expect(result).toBeNull();
    });

    test('returns null for agent:tool_call', () => {
      const result = wsEventToMachineEvent('agent:tool_call', { name: 'Read' });
      expect(result).toBeNull();
    });

    test('returns null for completely unknown event', () => {
      const result = wsEventToMachineEvent('some:unknown', {});
      expect(result).toBeNull();
    });

    test('returns null for empty string event type', () => {
      const result = wsEventToMachineEvent('', {});
      expect(result).toBeNull();
    });
  });
});
