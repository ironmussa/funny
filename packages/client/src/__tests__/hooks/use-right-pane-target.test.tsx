import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, test } from 'vitest';

import { useRightPaneProjectId, useRightPaneThreadId } from '@/hooks/use-right-pane-target';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

function makeThread(id: string, projectId: string) {
  return {
    id,
    projectId,
    title: id,
    status: 'idle' as const,
    mode: 'local' as const,
    stage: 'backlog' as const,
    provider: 'anthropic' as const,
    permissionMode: 'default' as const,
    model: 'claude-sonnet-4-5' as const,
    cost: 0,
    userId: 'user-1',
    source: 'web' as const,
    runtime: 'local' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('use-right-pane-target', () => {
  beforeEach(() => {
    useUIStore.setState({
      liveColumnsOpen: false,
      gridSelectedThreadId: null,
    } as any);
    useProjectStore.setState({
      selectedProjectId: null,
      projects: [],
    } as any);
    useThreadStore.setState({
      threadsById: {},
      threadIdsByProject: {},
      scratchThreadIds: [],
      sharedThreadIds: [],
      selectedThreadId: null,
      threadDataById: {},
      activeThread: null,
    } as any);
  });

  test('uses the grid-selected thread and project while heavy thread data is still unloaded', () => {
    useUIStore.setState({
      liveColumnsOpen: true,
      gridSelectedThreadId: 't1',
    } as any);
    useProjectStore.setState({ selectedProjectId: 'stale-project' } as any);
    useThreadStore.setState({
      threadsById: {
        t1: makeThread('t1', 'p1') as any,
        t2: makeThread('t2', 'p2') as any,
      },
      threadIdsByProject: {
        p1: ['t1'],
        p2: ['t2'],
      },
      threadDataById: {},
    } as any);

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
    } as any);
    useProjectStore.setState({ selectedProjectId: 'p-selected' } as any);
    useThreadStore.setState({ selectedThreadId: 'url-thread' } as any);

    const { result } = renderHook(() => ({
      threadId: useRightPaneThreadId(),
      projectId: useRightPaneProjectId(),
    }));

    expect(result.current).toEqual({ threadId: 'url-thread', projectId: 'p-selected' });
  });
});
