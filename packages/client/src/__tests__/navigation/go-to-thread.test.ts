import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { goToThread } from '@/navigation/go-to-thread';
import { buildThreadPath } from '@/navigation/thread-paths';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

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
  let navigate: ReturnType<typeof vi.fn>;
  let selectThreadSpy: ReturnType<typeof vi.fn>;
  let toggleProject: ReturnType<typeof vi.fn>;
  let selectProject: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    navigate = vi.fn();
    selectThreadSpy = vi.fn().mockResolvedValue(undefined);
    toggleProject = vi.fn();
    selectProject = vi.fn();

    useThreadStore.setState({
      selectedThreadId: null,
      activeThread: null,
      selectThread: selectThreadSpy as any,
    });
    useProjectStore.setState({
      expandedProjects: new Set<string>(),
      selectedProjectId: null,
      toggleProject: toggleProject as any,
      selectProject: selectProject as any,
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('navigates to the thread path', () => {
    goToThread(navigate as any, PROJECT_THREAD);
    expect(navigate).toHaveBeenCalledWith('/projects/p1/threads/t1');
  });

  test('expands and selects the owning project for a project thread', () => {
    goToThread(navigate as any, PROJECT_THREAD);
    expect(toggleProject).toHaveBeenCalledWith('p1');
    expect(selectProject).toHaveBeenCalledWith('p1');
  });

  test('kicks hydration via selectThread when not already selected', () => {
    goToThread(navigate as any, PROJECT_THREAD);
    expect(selectThreadSpy).toHaveBeenCalledWith('t1');
  });

  test('does not re-select when the thread is already active', () => {
    useThreadStore.setState({
      selectedThreadId: 't1',
      activeThread: { id: 't1', messages: [] } as any,
    });
    goToThread(navigate as any, PROJECT_THREAD);
    expect(selectThreadSpy).not.toHaveBeenCalled();
    // ...but navigation still happens.
    expect(navigate).toHaveBeenCalledWith('/projects/p1/threads/t1');
  });

  test('skipSelect navigates without kicking hydration', () => {
    goToThread(navigate as any, PROJECT_THREAD, { skipSelect: true });
    expect(selectThreadSpy).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/projects/p1/threads/t1');
  });

  test('replace option is forwarded to navigate', () => {
    goToThread(navigate as any, PROJECT_THREAD, { replace: true });
    expect(navigate).toHaveBeenCalledWith('/projects/p1/threads/t1', { replace: true });
  });

  test('scratch thread: no project expand/select, routes to /scratch/:id', () => {
    goToThread(navigate as any, SCRATCH_THREAD);
    expect(toggleProject).not.toHaveBeenCalled();
    expect(selectProject).not.toHaveBeenCalled();
    expect(selectThreadSpy).toHaveBeenCalledWith('s1');
    expect(navigate).toHaveBeenCalledWith('/scratch/s1');
  });

  test('does not toggle an already-expanded project', () => {
    useProjectStore.setState({
      expandedProjects: new Set<string>(['p1']),
      selectedProjectId: 'p1',
      toggleProject: toggleProject as any,
      selectProject: selectProject as any,
    } as any);
    goToThread(navigate as any, PROJECT_THREAD);
    expect(toggleProject).not.toHaveBeenCalled();
    expect(selectProject).not.toHaveBeenCalled();
  });
});
