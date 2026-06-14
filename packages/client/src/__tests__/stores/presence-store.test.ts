import { describe, test, expect, beforeEach } from 'vitest';

import { selectOtherViewers, usePresenceStore, type PresenceViewer } from '@/stores/presence-store';

const ana: PresenceViewer = { clientId: 'c-ana', user: { id: 'ana', name: 'Ana', image: null } };
const anaTab2: PresenceViewer = {
  clientId: 'c-ana-2',
  user: { id: 'ana', name: 'Ana', image: null },
};
const bob: PresenceViewer = { clientId: 'c-bob', user: { id: 'bob', name: 'Bob', image: 'b.png' } };

describe('usePresenceStore', () => {
  beforeEach(() => {
    usePresenceStore.setState({ viewersByThread: {} });
  });

  test('setRoster replaces a thread roster', () => {
    usePresenceStore.getState().setRoster('t1', [ana, bob]);
    expect(usePresenceStore.getState().viewersByThread.t1).toHaveLength(2);
    usePresenceStore.getState().setRoster('t1', [ana]);
    expect(usePresenceStore.getState().viewersByThread.t1).toEqual([ana]);
  });

  test('upsertViewer adds and de-dupes by clientId', () => {
    const s = usePresenceStore.getState();
    s.upsertViewer('t1', ana);
    s.upsertViewer('t1', bob);
    s.upsertViewer('t1', { ...ana, user: { ...ana.user, name: 'Ana R.' } });
    const roster = usePresenceStore.getState().viewersByThread.t1;
    expect(roster).toHaveLength(2);
    expect(roster.find((v) => v.clientId === 'c-ana')!.user.name).toBe('Ana R.');
  });

  test('removeViewer drops by clientId', () => {
    usePresenceStore.getState().setRoster('t1', [ana, bob]);
    usePresenceStore.getState().removeViewer('t1', 'c-ana');
    expect(usePresenceStore.getState().viewersByThread.t1).toEqual([bob]);
  });

  test('clearThread removes the thread entry', () => {
    usePresenceStore.getState().setRoster('t1', [ana]);
    usePresenceStore.getState().clearThread('t1');
    expect('t1' in usePresenceStore.getState().viewersByThread).toBe(false);
  });

  test('selectOtherViewers collapses multi-tab users and excludes self', () => {
    usePresenceStore.getState().setRoster('t1', [ana, anaTab2, bob]);
    const others = selectOtherViewers(usePresenceStore.getState(), 't1', 'bob');
    // ana counted once (two tabs), bob excluded as self
    expect(others.map((u) => u.id)).toEqual(['ana']);
  });
});
