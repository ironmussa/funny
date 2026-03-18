import { describe, test, expect } from 'bun:test';

import { wsEventToMachineEvent, getResumeSystemPrefix } from '../thread-machine.js';

// ── wsEventToMachineEvent ────────────────────────────────────────

describe('wsEventToMachineEvent', () => {
  describe('agent:status', () => {
    test('running → START event', () => {
      expect(wsEventToMachineEvent('agent:status', { status: 'running' })).toEqual({
        type: 'START',
      });
    });

    test('stopped → STOP event', () => {
      expect(wsEventToMachineEvent('agent:status', { status: 'stopped' })).toEqual({
        type: 'STOP',
      });
    });

    test('interrupted → INTERRUPT event', () => {
      expect(wsEventToMachineEvent('agent:status', { status: 'interrupted' })).toEqual({
        type: 'INTERRUPT',
      });
    });

    test('other status → SET_STATUS event', () => {
      expect(wsEventToMachineEvent('agent:status', { status: 'waiting' })).toEqual({
        type: 'SET_STATUS',
        status: 'waiting',
      });
    });
  });

  describe('agent:result', () => {
    test('completed → COMPLETE with cost and duration', () => {
      expect(
        wsEventToMachineEvent('agent:result', { status: 'completed', cost: 0.5, duration: 10 }),
      ).toEqual({
        type: 'COMPLETE',
        cost: 0.5,
        duration: 10,
      });
    });

    test('defaults to completed when status is missing', () => {
      const result = wsEventToMachineEvent('agent:result', { cost: 1 });
      expect(result).toEqual({ type: 'COMPLETE', cost: 1, duration: undefined });
    });

    test('failed → FAIL with error', () => {
      expect(
        wsEventToMachineEvent('agent:result', {
          status: 'failed',
          cost: 0.1,
          duration: 2,
          error: 'oops',
        }),
      ).toEqual({
        type: 'FAIL',
        cost: 0.1,
        duration: 2,
        error: 'oops',
      });
    });

    test('waiting → WAIT with cost', () => {
      expect(
        wsEventToMachineEvent('agent:result', { status: 'waiting', cost: 0.3, duration: 5 }),
      ).toEqual({
        type: 'WAIT',
        cost: 0.3,
        duration: 5,
      });
    });

    test('unknown status → null', () => {
      expect(wsEventToMachineEvent('agent:result', { status: 'unknown' })).toBeNull();
    });
  });

  describe('agent:error', () => {
    test('returns FAIL with error message', () => {
      expect(wsEventToMachineEvent('agent:error', { error: 'crash' })).toEqual({
        type: 'FAIL',
        error: 'crash',
      });
    });
  });

  describe('worktree:setup_complete', () => {
    test('returns SETUP_COMPLETE', () => {
      expect(wsEventToMachineEvent('worktree:setup_complete', {})).toEqual({
        type: 'SETUP_COMPLETE',
      });
    });
  });

  describe('unknown event type', () => {
    test('returns null', () => {
      expect(wsEventToMachineEvent('some:unknown', {})).toBeNull();
    });
  });
});

// ── getResumeSystemPrefix ────────────────────────────────────────

describe('getResumeSystemPrefix', () => {
  test('returns undefined for fresh reason', () => {
    expect(getResumeSystemPrefix('fresh')).toBeUndefined();
  });

  test('returns a string for waiting-response reason', () => {
    const prefix = getResumeSystemPrefix('waiting-response');
    expect(prefix).toBeDefined();
    expect(prefix).toContain('responded');
  });

  test('returns a string for follow-up reason', () => {
    const prefix = getResumeSystemPrefix('follow-up');
    expect(prefix).toBeDefined();
    expect(prefix).toContain('follow-up');
  });

  test('returns a string for interrupted reason', () => {
    const prefix = getResumeSystemPrefix('interrupted');
    expect(prefix).toBeDefined();
    expect(prefix).toContain('resume');
  });

  test('returns undefined for null reason', () => {
    expect(getResumeSystemPrefix(null)).toBeUndefined();
  });

  test('isPostMerge overrides any reason', () => {
    const prefix = getResumeSystemPrefix('fresh', true);
    expect(prefix).toBeDefined();
    expect(prefix).toContain('merged');
  });

  test('post-merge prefix mentions main branch', () => {
    const prefix = getResumeSystemPrefix('interrupted', true);
    expect(prefix).toContain('main');
  });

  test('post-merge overrides even interrupted reason', () => {
    const prefix = getResumeSystemPrefix('interrupted', true);
    expect(prefix).toContain('merged');
    expect(prefix).not.toContain('resume after an interruption');
  });
});
