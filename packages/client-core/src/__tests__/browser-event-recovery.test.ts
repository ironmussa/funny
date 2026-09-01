import { describe, expect, test } from 'bun:test';

import { create } from '@bufbuild/protobuf';
import { CursorSchema, ScopeKind, ScopeReferenceSchema } from '@funny/shared/browser-v1/common';
import { ApplicationEventSchema } from '@funny/shared/browser-v1/events';

import { BrowserEventRecoveryState } from '../browser-event-recovery';

const scope = create(ScopeReferenceSchema, { kind: ScopeKind.USER, id: 'user-1' });

function event(id: string, sequence: bigint, revision = sequence) {
  return create(ApplicationEventSchema, {
    metadata: { eventId: id, scope, sequence, revision },
    payload: { case: 'user', value: { eventType: 'profile:updated' } },
  });
}

describe('browser event recovery state', () => {
  test('deduplicates event IDs and applies revisions monotonically', () => {
    const recovery = new BrowserEventRecoveryState();
    recovery.acceptCursor(create(CursorSchema, { scope }));
    expect(recovery.accept(event('event-1', 1n))).toEqual({ kind: 'accepted' });
    expect(recovery.accept(event('event-1', 1n))).toEqual({ kind: 'duplicate' });
    expect(recovery.accept(event('event-stale', 2n, 1n))).toEqual({ kind: 'stale' });
    expect(recovery.cursors()[0]).toMatchObject({
      lastEventId: 'event-1',
      lastSequence: 1n,
      lastRevision: 1n,
    });
  });

  test('reports a targeted gap instead of applying non-contiguous state', () => {
    const recovery = new BrowserEventRecoveryState();
    recovery.acceptCursor(
      create(CursorSchema, { scope, lastEventId: 'event-3', lastSequence: 3n, lastRevision: 3n }),
    );
    expect(recovery.accept(event('event-5', 5n))).toEqual({ kind: 'gap', scope });
    expect(recovery.cursors()[0]?.lastSequence).toBe(3n);
  });
});
