import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'bun:test';

import type { NavigateFunction } from 'react-router-dom';

import { buildThreadWithMessages } from '@/data/threads/testing';
import { goToThread } from '@/navigation/go-to-thread';
import { buildThreadPath } from '@/navigation/thread-paths';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore, type ThreadState } from '@/stores/thread-store';

type ProjectState = ReturnType<typeof useProjectStore.getState>;

const PROJECT_THREAD = { id: 't1', projectId: 'p1', isScratch: false } as const;
const SCRATCH_THREAD = { id: 's1', projectId: '', isScratch: true } as const;

describe('buildThreadPath', () => {
  test('project thread → /projects/:pid/threads/:id', () => {
    expect(buildThreadPath(PROJECT_THREAD)).toBe('/projects/p1/threads/t1');
  });

  test('scratch thread → /scratch/:id', () => {
    expect(buildThreadPath(SCRATCH_THREAD)).toBe('/scratch/s1');
  });
});

describe('goToThread', () => {
  let navigate: Mock<(...args: unknown[]) => void>;
  let selectThreadSpy: Mock<ThreadState['selectThread']>;
  let toggleProject: Mock<ProjectState['toggleProject']>;
  let selectProject: Mock<ProjectState['selectProject']>;

  beforeEach(() => {
    navigate = vi.fn<(...args: unknown[]) => void>();
    selectThreadSpy = vi.fn<ThreadState['selectThread']>().mockResolvedValue(undefined);
    toggleProject = vi.fn<ProjectState['toggleProject']>();
    selectProject = vi.fn<ProjectState['selectProject']>();

    useThreadStore.setState({
      selectedThreadId: null,
      activeThread: null,
      selectThread: selectThreadSpy,
    });
    useProjectStore.setState({
      expandedProjects: new Set<string>(),
      selectedProjectId: null,
      toggleProject: toggleProject,
      selectProject: selectProject,
    });
  });

  // goToThread takes the router's overloaded NavigateFunction; route every
  // call into the `navigate` spy so the assertions read it.
  const navigateFn: NavigateFunction = (...args: unknown[]) => navigate(...args);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('navigates to the thread path', () => {
    goToThread(navigateFn, PROJECT_THREAD);
    expect(navigate).toHaveBeenCalledWith('/projects/p1/threads/t1');
  });

  test('expands and selects the owning project for a project thread', () => {
    goToThread(navigateFn, PROJECT_THREAD);
    expect(toggleProject).toHaveBeenCalledWith('p1');
    expect(selectProject).toHaveBeenCalledWith('p1');
  });

  test('kicks hydration via selectThread when not already selected', () => {
    goToThread(navigateFn, PROJECT_THREAD);
    expect(selectThreadSpy).toHaveBeenCalledWith('t1');
  });

  test('does not re-select when the thread is already active', () => {
    useThreadStore.setState({
      selectedThreadId: 't1',
      activeThread: buildThreadWithMessages({ id: 't1' }),
    });
    goToThread(navigateFn, PROJECT_THREAD);
    expect(selectThreadSpy).not.toHaveBeenCalled();
    // ...but navigation still happens.
    expect(navigate).toHaveBeenCalledWith('/projects/p1/threads/t1');
  });

  test('skipSelect navigates without kicking hydration', () => {
    goToThread(navigateFn, PROJECT_THREAD, { skipSelect: true });
    expect(selectThreadSpy).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/projects/p1/threads/t1');
  });

  test('replace option is forwarded to navigate', () => {
    goToThread(navigateFn, PROJECT_THREAD, { replace: true });
    expect(navigate).toHaveBeenCalledWith('/projects/p1/threads/t1', { replace: true });
  });

  test('scratch thread: no project expand/select, routes to /scratch/:id', () => {
    goToThread(navigateFn, SCRATCH_THREAD);
    expect(toggleProject).not.toHaveBeenCalled();
    expect(selectProject).not.toHaveBeenCalled();
    expect(selectThreadSpy).toHaveBeenCalledWith('s1');
    expect(navigate).toHaveBeenCalledWith('/scratch/s1');
  });

  test('does not toggle an already-expanded project', () => {
    useProjectStore.setState({
      expandedProjects: new Set<string>(['p1']),
      selectedProjectId: 'p1',
      toggleProject: toggleProject,
      selectProject: selectProject,
    });
    goToThread(navigateFn, PROJECT_THREAD);
    expect(toggleProject).not.toHaveBeenCalled();
    expect(selectProject).not.toHaveBeenCalled();
  });
});
