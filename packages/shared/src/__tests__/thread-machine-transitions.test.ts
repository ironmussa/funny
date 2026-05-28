import { describe, test, expect } from 'bun:test';

import { createActor } from 'xstate';

import { threadMachine } from '../thread-machine.js';

function startActor(initialStatus: 'pending' | 'setting_up' | 'completed' = 'pending') {
  const actor = createActor(threadMachine, {
    input: { threadId: 't-shared', cost: 0, resumeReason: null },
  });
  actor.start();
  if (initialStatus !== 'pending') {
    actor.send({ type: 'SET_STATUS', status: initialStatus });
  }
  return actor;
}

describe('threadMachine — canonical transitions (shared)', () => {
  test('setting_up → pending on SETUP_COMPLETE', () => {
    const actor = startActor('setting_up');
    actor.send({ type: 'SETUP_COMPLETE' });
    expect(actor.getSnapshot().value).toBe('pending');
    actor.stop();
  });

  test('setting_up → failed on FAIL during worktree setup', () => {
    const actor = startActor('setting_up');
    actor.send({ type: 'FAIL', error: 'worktree failed' });
    expect(actor.getSnapshot().value).toBe('failed');
    expect(actor.getSnapshot().context.resultInfo?.error).toBe('worktree failed');
    actor.stop();
  });

  test('waiting → running on RESPOND sets resumeReason to waiting-response', () => {
    const actor = startActor();
    actor.send({ type: 'START' });
    actor.send({ type: 'WAIT', cost: 0.1 });
    actor.send({ type: 'RESPOND' });
    expect(actor.getSnapshot().value).toBe('running');
    expect(actor.getSnapshot().context.resumeReason).toBe('waiting-response');
    actor.stop();
  });

  test('completed → running on FOLLOW_UP sets resumeReason to follow-up', () => {
    const actor = startActor();
    actor.send({ type: 'START' });
    actor.send({ type: 'COMPLETE', cost: 0.2, duration: 3 });
    actor.send({ type: 'FOLLOW_UP' });
    expect(actor.getSnapshot().value).toBe('running');
    expect(actor.getSnapshot().context.resumeReason).toBe('follow-up');
    actor.stop();
  });

  test('failed absorbs late COMPLETE without staying failed (context-recovery)', () => {
    const actor = startActor();
    actor.send({ type: 'START' });
    actor.send({ type: 'FAIL', cost: 0.01, duration: 1, error: 'early fail' });
    actor.send({ type: 'COMPLETE', cost: 0.05, duration: 2 });
    expect(actor.getSnapshot().value).toBe('completed');
    expect(actor.getSnapshot().context.resultInfo?.status).toBe('completed');
    actor.stop();
  });

  test('stopped absorbs late WAIT and clears stale resultInfo', () => {
    const actor = startActor();
    actor.send({ type: 'START' });
    actor.send({ type: 'STOP' });
    actor.send({ type: 'WAIT', cost: 0.03, duration: 1 });
    expect(actor.getSnapshot().value).toBe('waiting');
    expect(actor.getSnapshot().context.resultInfo).toBeUndefined();
    actor.stop();
  });
});
