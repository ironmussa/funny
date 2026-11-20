/**
 * Typed helpers for route, middleware and utility tests.
 */

import type { WSEvent } from '@funny/shared';

/** True when `event` is the `type` variant of the `WSEvent` union. */
export function isEventOfType<T extends WSEvent['type']>(
  event: WSEvent,
  type: T,
): event is Extract<WSEvent, { type: T }> {
  return event.type === type;
}

/** Narrows a broadcast event to one variant of the `WSEvent` union, or `undefined`. */
export function eventOfType<T extends WSEvent['type']>(
  event: WSEvent | undefined,
  type: T,
): Extract<WSEvent, { type: T }> | undefined {
  return event !== undefined && isEventOfType(event, type) ? event : undefined;
}
