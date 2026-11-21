import { describe, test, expect } from 'bun:test';

import type { ThreadStatus } from '../primitives.js';
import { isThreadStatus, resolveThreadTransition, threadMachine } from '../thread-machine.js';

const STATUSES = Object.keys(threadMachine.states).filter(isThreadStatus);

describe('resolveThreadTransition', () => {
  test('is computed from the status it is given', () => {
    expect(resolveThreadTransition('waiting', { type: 'RESPOND' })).toEqual({
      status: 'running',
      resumeReason: 'waiting-response',
      accepted: true,
    });
    expect(resolveThreadTransition('completed', { type: 'FOLLOW_UP' }).resumeReason).toBe(
      'follow-up',
    );
    expect(resolveThreadTransition('failed', { type: 'RESTART' }).resumeReason).toBe('interrupted');
  });

  test('an event the status does not accept changes nothing and says so', () => {
    expect(
      resolveThreadTransition('failed', { type: 'RESPOND' }, { resumeReason: 'fresh' }),
    ).toEqual({ status: 'failed', resumeReason: 'fresh', accepted: false });
  });

  test('a running self-transition carries the resume reason over', () => {
    expect(
      resolveThreadTransition('running', { type: 'START' }, { resumeReason: 'follow-up' }),
    ).toEqual({ status: 'running', resumeReason: 'follow-up', accepted: true });
  });

  test('does not share state between calls', () => {
    resolveThreadTransition('running', { type: 'COMPLETE', cost: 1 });
    expect(resolveThreadTransition('running', { type: 'STOP' }).status).toBe('stopped');
  });

  test('every status the server sends for a thread being set up is accepted', () => {
    // Deferred worktree setup of a backlog thread (runtime thread-service/update).
    expect(
      resolveThreadTransition('idle', { type: 'SET_STATUS', status: 'setting_up' }).status,
    ).toBe('setting_up');
    // Retry of a sandbox that failed before its agent started (sandbox-thread-wiring).
    expect(
      resolveThreadTransition('failed', { type: 'SET_STATUS', status: 'setting_up' }).status,
    ).toBe('setting_up');
    expect(resolveThreadTransition('setting_up', { type: 'SETUP_COMPLETE' }).status).toBe(
      'pending',
    );
  });

  test('a thread converted to a worktree returns to the status it had', () => {
    // Runtime thread-service/update convertToWorktree: setting_up → prior status.
    for (const status of ['completed', 'stopped', 'interrupted', 'idle', 'failed'] as const) {
      expect(resolveThreadTransition('setting_up', { type: 'SET_STATUS', status })).toMatchObject({
        status,
        accepted: true,
      });
    }
  });

  test('a row without a known status is treated as pending', () => {
    // SAFETY: deliberately not a ThreadStatus; a row without a status is the input under test.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- intentional: test behavior with an impossible runtime value
    const noStatus = undefined as unknown as ThreadStatus;
    expect(resolveThreadTransition(noStatus, { type: 'START' }).status).toBe('running');
    expect(resolveThreadTransition(noStatus, { type: 'SETUP_COMPLETE' }).status).toBe('pending');
  });

  test('START leads to running from every status an agent can start from', () => {
    for (const status of STATUSES) {
      if (status === 'setting_up') continue;
      expect(resolveThreadTransition(status, { type: 'START' }).status).toBe('running');
    }
  });
});
