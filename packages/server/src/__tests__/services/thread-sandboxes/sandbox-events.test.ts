import { describe, expect, test } from 'bun:test';

import { sandboxErrorEventData } from '../../../services/thread-sandboxes/sandbox-events.js';

describe('sandboxErrorEventData', () => {
  test("a provider plan limit tells the user how to free a slot (Boat trial's 2 sandboxes)", () => {
    const data = sandboxErrorEventData('setup', {
      kind: 'sandbox',
      cause: 'quota',
      message: 'Trial accounts can run 2 concurrent sandboxes.',
    });
    expect(data).toMatchObject({
      phase: 'setup',
      kind: 'quota',
      message: 'Trial accounts can run 2 concurrent sandboxes.',
    });
    expect(data.hint).toContain('plan limit');
  });

  test('a rejected credential points to Preferences > Sandboxes', () => {
    const data = sandboxErrorEventData('wake', { kind: 'sandbox', cause: 'auth', message: '401' });
    expect(data.hint).toContain('Preferences > Sandboxes');
  });

  test('non-sandbox failures keep their own kind', () => {
    expect(
      sandboxErrorEventData('setup', { kind: 'checkout', message: 'clone failed' }),
    ).toMatchObject({ kind: 'checkout', hint: expect.stringContaining('could not be cloned') });
  });

  test('a plain message has no kind and no hint', () => {
    expect(sandboxErrorEventData('start', 'boom')).toEqual({ phase: 'start', message: 'boom' });
  });
});
