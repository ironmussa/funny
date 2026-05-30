import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { useThreadStore } from '@/stores/thread-store';
import { setSelectingThreadId } from '@/stores/thread-store-internals';

/**
 * Regression: the activeThread → threadDataById back-fill subscriber
 * (thread-store.ts) must NOT realign `selectedThreadId` to a stale
 * `activeThread` while a `selectThread` is in flight. Doing so fights the
 * route-sync invariant guard (URL is the source of truth), producing a
 * ~50ms ping-pong that flickered the tab title and hammered
 * selectProject/fetchBranch.
 */
describe('back-fill subscriber: selectedThreadId realignment', () => {
  beforeEach(() => {
    setSelectingThreadId(null);
    useThreadStore.setState({
      selectedThreadId: null,
      activeThread: null,
      threadDataById: {},
    } as any);
  });

  afterEach(() => {
    setSelectingThreadId(null);
  });

  test('does NOT realign selectedThreadId while a selectThread is in flight', () => {
    // route-sync wants the URL's thread selected…
    useThreadStore.setState({ selectedThreadId: 'url-thread' } as any);
    // …and a selectThread for it is in flight.
    setSelectingThreadId('url-thread');

    // A direct activeThread write drifts to a different thread (not in the map).
    useThreadStore.setState({ activeThread: { id: 'stale-thread', messages: [] } } as any);

    const state = useThreadStore.getState();
    // Selection stays put — the in-flight selectThread owns it.
    expect(state.selectedThreadId).toBe('url-thread');
    // The safety-net mirror still happens.
    expect(state.threadDataById['stale-thread']).toBe(state.activeThread);
  });

  test('still realigns selectedThreadId when no selection is in flight', () => {
    useThreadStore.setState({ selectedThreadId: 'old-thread' } as any);
    // No selectThread in flight (getSelectingThreadId() === null).

    useThreadStore.setState({ activeThread: { id: 'new-thread', messages: [] } } as any);

    const state = useThreadStore.getState();
    // Legacy safety net: align selection to the directly-written activeThread.
    expect(state.selectedThreadId).toBe('new-thread');
    expect(state.threadDataById['new-thread']).toBe(state.activeThread);
  });
});
