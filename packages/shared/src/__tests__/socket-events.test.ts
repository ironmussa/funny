import { describe, expect, test } from 'bun:test';

import {
  BROWSER_PTY_FORWARD_EVENTS,
  BROWSER_SESSION_EVENTS,
  browserPtyForwardPayloadSchema,
  parseObjectPayload,
  parseSocketPayload,
} from '../socket-events';

describe('browser socket events', () => {
  test('normalizes object payloads and rejects non-objects', () => {
    expect(parseObjectPayload(null)).toEqual({});
    expect(parseObjectPayload({ projectId: 'p1' })).toEqual({ projectId: 'p1' });
    expect(parseObjectPayload([])).toBeNull();
    expect(parseObjectPayload('x')).toBeNull();
  });

  test('keeps browser PTY and browser-session contracts', () => {
    expect(BROWSER_PTY_FORWARD_EVENTS).toContain('pty:signal');
    expect(BROWSER_SESSION_EVENTS).toContain('browser-session:navigate');
  });

  test('applies the browser PTY payload schema', () => {
    expect(
      parseSocketPayload(browserPtyForwardPayloadSchema, {
        projectId: 'p1',
        id: 'pty1',
      }),
    ).toEqual({ projectId: 'p1', id: 'pty1' });
    expect(parseSocketPayload(browserPtyForwardPayloadSchema, { projectId: 42 })).toBeNull();
  });
});
