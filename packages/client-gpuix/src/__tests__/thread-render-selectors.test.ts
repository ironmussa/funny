import { describe, expect, test } from 'bun:test';

import { createThreadNavigationStore, createThreadWorkspaceStore } from '@funny/client-core';

import {
  selectThreadPermission,
  selectThreadRun,
  selectThreadViewerShareLevel,
  selectThreadWorkspaceData,
} from '../thread-render-selectors';
import { buildProject, buildThread } from './helpers/fixtures';

describe('native thread render selectors', () => {
  test('keeps run and permission references stable across streaming content', () => {
    const store = createThreadWorkspaceStore();
    store.getState().replaceInitialPage('t1', {
      messages: [],
      hasMore: false,
    });
    store.getState().setRun('t1', { runId: 'r1', status: 'running' });
    store.getState().setPermission('t1', {
      requestId: 'permission-1',
      runId: 'r1',
      toolName: 'write_file',
      toolInput: '{}',
      requestedAt: 1,
      status: 'active',
    });
    const run = selectThreadRun(store.getState(), 't1');
    const permission = selectThreadPermission(store.getState(), 't1');
    const data = selectThreadWorkspaceData(store.getState(), 't1');

    store.getState().applyStreamingDelta({
      eventId: 'stream-1',
      messageId: 'm1',
      threadId: 't1',
      revision: 1,
      content: 'fragment',
      mode: 'replace',
    });

    expect(selectThreadWorkspaceData(store.getState(), 't1')).not.toBe(data);
    expect(selectThreadRun(store.getState(), 't1')).toBe(run);
    expect(selectThreadPermission(store.getState(), 't1')).toBe(permission);

    store.getState().setRun('t1', { status: 'waiting' });
    expect(selectThreadRun(store.getState(), 't1')).not.toBe(run);
    store.getState().setPermission('t1', null);
    expect(selectThreadPermission(store.getState(), 't1')).toBeNull();
  });

  test('reacts to share-access changes without reading the whole navigation store', () => {
    const store = createThreadNavigationStore();
    store.getState().replaceProjects([buildProject({ id: 'p1', name: 'Project' })]);
    store
      .getState()
      .replaceProjectThreads('p1', [
        buildThread({ id: 't1', projectId: 'p1', viewerShareLevel: 'view' }),
      ]);

    expect(selectThreadViewerShareLevel(store.getState(), 't1')).toBe('view');
    store.getState().patchThread('t1', { viewerShareLevel: 'steer' });
    expect(selectThreadViewerShareLevel(store.getState(), 't1')).toBe('steer');
  });
});
