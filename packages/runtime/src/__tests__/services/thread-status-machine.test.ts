import { describe, test, expect, afterEach } from 'vitest';

import {
  transitionStatus,
  getResumeReason,
  cleanupThreadActor,
} from '../../services/thread-status-machine.js';

const THREAD_ID = 'server-thread-1';

afterEach(() => {
  cleanupThreadActor(THREAD_ID);
});

describe('thread-status-machine', () => {
  test('transitionStatus moves pending → running on START', () => {
    const result = transitionStatus(THREAD_ID, { type: 'START' }, 'pending');
    expect(result.status).toBe('running');
    expect(result.resumeReason).toBe('fresh');
  });

  test('transitionStatus records follow-up resumeReason after completion', () => {
    transitionStatus(THREAD_ID, { type: 'START' }, 'pending');
    transitionStatus(THREAD_ID, { type: 'COMPLETE', cost: 0.1, duration: 2 }, 'running');
    const followUp = transitionStatus(THREAD_ID, { type: 'FOLLOW_UP' }, 'completed');
    expect(followUp.status).toBe('running');
    expect(followUp.resumeReason).toBe('follow-up');
    expect(getResumeReason(THREAD_ID)).toBe('follow-up');
  });

  test('getResumeReason returns null for unknown thread', () => {
    expect(getResumeReason('never-seen')).toBeNull();
  });

  test('cleanupThreadActor removes actor so next transition starts fresh', () => {
    transitionStatus(THREAD_ID, { type: 'START' }, 'pending');
    expect(getResumeReason(THREAD_ID)).toBe('fresh');
    cleanupThreadActor(THREAD_ID);
    expect(getResumeReason(THREAD_ID)).toBeNull();

    const restart = transitionStatus(THREAD_ID, { type: 'START' }, 'pending');
    expect(restart.status).toBe('running');
    expect(restart.resumeReason).toBe('fresh');
  });

  test('transitions from the status on the row, not from a remembered one', () => {
    // The agent fails while a permission request is pending: the machine says
    // `failed`, but the row is saved as `waiting` (agent-event-router).
    expect(transitionStatus(THREAD_ID, { type: 'START' }, 'pending').status).toBe('running');
    expect(transitionStatus(THREAD_ID, { type: 'FAIL' }, 'running').status).toBe('failed');
    // The user answers. A bridge that remembered `failed` rejected RESPOND and
    // the thread was saved as `failed` while its agent started.
    const resumed = transitionStatus(THREAD_ID, { type: 'RESPOND' }, 'waiting');
    expect(resumed.status).toBe('running');
    expect(resumed.resumeReason).toBe('waiting-response');
  });

  test('a restart of a running thread keeps its resume reason', () => {
    transitionStatus(THREAD_ID, { type: 'FOLLOW_UP' }, 'completed');
    expect(transitionStatus(THREAD_ID, { type: 'START' }, 'running')).toEqual({
      status: 'running',
      resumeReason: 'follow-up',
    });
  });
});
