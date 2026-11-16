import { describe, expect, test } from 'bun:test';

import { observeThreadStatusWrite } from '../../services/thread-status-observer.js';

describe('observeThreadStatusWrite', () => {
  test('passes a modelled transition and a first write', () => {
    expect(observeThreadStatusWrite({ threadId: 't', from: 'running', to: 'completed' })).toBe(
      true,
    );
    expect(observeThreadStatusWrite({ threadId: 't', from: null, to: 'pending' })).toBe(true);
  });

  test('reports a transition the machine does not model, without throwing', () => {
    expect(observeThreadStatusWrite({ threadId: 't', from: 'completed', to: 'idle' })).toBe(false);
    // Reported again (the metric counts each one), logged only the first time.
    expect(observeThreadStatusWrite({ threadId: 't', from: 'completed', to: 'idle' })).toBe(false);
  });

  test('reports a status the machine does not know', () => {
    expect(observeThreadStatusWrite({ threadId: 't', from: 'running', to: 'error' })).toBe(false);
  });
});
