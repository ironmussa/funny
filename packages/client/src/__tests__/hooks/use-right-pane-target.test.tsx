import { beforeEach, describe, expect, test } from 'bun:test';

import { act, renderHook } from '@testing-library/react';

import { seedProjects } from '@/data/projects/testing';
import { buildThread, withThreadIndex } from '@/data/threads/testing';
import { useRightPaneProjectId, useRightPaneThreadId } from '@/hooks/use-right-pane-target';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

describe('use-right-pane-target', () => {
  beforeEach(() => {
    useUIStore.setState({
      liveColumnsOpen: false,
      gridSelectedThreadId: null,
    });
    seedProjects([]);
    useProjectStore.setState({ selectedProjectId: null });
    useThreadStore.setState(
      withThreadIndex({
        threadsById: {},
        threadIdsByProject: {},
        scratchThreadIds: [],
        sharedThreadIds: [],
        selectedThreadId: null,
        threadDataById: {},
        activeThread: null,
      }),
    );
  });

  test('uses the grid-selected thread and project while heavy thread data is still unloaded', () => {
    useUIStore.setState({
      liveColumnsOpen: true,
      gridSelectedThreadId: 't1',
    });
    useProjectStore.setState({ selectedProjectId: 'stale-project' });
    useThreadStore.setState(
      withThreadIndex({
        threadsById: {
          t1: buildThread({ id: 't1', projectId: 'p1', title: 't1', status: 'idle' }),
          t2: buildThread({ id: 't2', projectId: 'p2', title: 't2', status: 'idle' }),
        },
        threadIdsByProject: {
          p1: ['t1'],
          p2: ['t2'],
        },
        threadDataById: {},
      }),
    );

    const { result } = renderHook(() => ({
      threadId: useRightPaneThreadId(),
      projectId: useRightPaneProjectId(),
    }));

    expect(result.current).toEqual({ threadId: 't1', projectId: 'p1' });

    act(() => {
      useUIStore.getState().setGridSelectedThreadId('t2');
    });

    expect(result.current).toEqual({ threadId: 't2', projectId: 'p2' });
  });

  test('falls back to the selected project outside grid view', () => {
    useUIStore.setState({
      liveColumnsOpen: false,
      gridSelectedThreadId: 't1',
    });
    useProjectStore.setState({ selectedProjectId: 'p-selected' });
    useThreadStore.setState({ selectedThreadId: 'url-thread' });

    const { result } = renderHook(() => ({
      threadId: useRightPaneThreadId(),
      projectId: useRightPaneProjectId(),
    }));

    expect(result.current).toEqual({ threadId: 'url-thread', projectId: 'p-selected' });
  });
});
