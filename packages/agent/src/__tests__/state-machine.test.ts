import { describe, it, expect } from 'bun:test';

import { StateMachine, TransitionError } from '../core/state-machine.js';

// ── StateMachine generic tests ──────────────────────────────────

describe('StateMachine', () => {
  const simpleTransitions: Record<string, string[]> = {
    idle: ['running'],
    running: ['done', 'failed'],
    done: [],
    failed: [],
  };

  it('starts in the initial state', () => {
    const sm = new StateMachine(simpleTransitions, 'idle', 'test');
    expect(sm.state).toBe('idle');
  });

  it('transition() moves to a valid state', () => {
    const sm = new StateMachine(simpleTransitions, 'idle', 'test');
    sm.transition('running');
    expect(sm.state).toBe('running');
  });

  it('transition() throws TransitionError for invalid transitions', () => {
    const sm = new StateMachine(simpleTransitions, 'idle', 'test');
    expect(() => sm.transition('done')).toThrow(TransitionError);
  });

  it('TransitionError contains from/to/label', () => {
    const sm = new StateMachine(simpleTransitions, 'idle', 'test-label');
    try {
      sm.transition('done');
    } catch (err) {
      expect(err).toBeInstanceOf(TransitionError);
      const te = err as TransitionError;
      expect(te.from).toBe('idle');
      expect(te.to).toBe('done');
      expect(te.label).toBe('test-label');
    }
  });

  it('tryTransition() returns true for valid transitions', () => {
    const sm = new StateMachine(simpleTransitions, 'idle', 'test');
    expect(sm.tryTransition('running')).toBe(true);
    expect(sm.state).toBe('running');
  });

  it('tryTransition() returns false for invalid transitions', () => {
    const sm = new StateMachine(simpleTransitions, 'idle', 'test');
    expect(sm.tryTransition('failed')).toBe(false);
    expect(sm.state).toBe('idle'); // state unchanged
  });

  it('canTransition() checks without changing state', () => {
    const sm = new StateMachine(simpleTransitions, 'idle', 'test');
    expect(sm.canTransition('running')).toBe(true);
    expect(sm.canTransition('done')).toBe(false);
    expect(sm.state).toBe('idle'); // state unchanged
  });

  it('terminal states allow no transitions', () => {
    const sm = new StateMachine(simpleTransitions, 'done', 'test');
    expect(sm.canTransition('idle')).toBe(false);
    expect(sm.canTransition('running')).toBe(false);
    expect(() => sm.transition('idle')).toThrow(TransitionError);
  });
});
