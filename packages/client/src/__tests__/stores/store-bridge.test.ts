import { describe, test, expect, vi } from 'vitest';

import * as projectsRead from '@/data/projects/read';
import { seedProjects } from '@/data/projects/testing';
import { setSourceMembers } from '@/data/threads/list-meta';
import * as threadsRead from '@/data/threads/read';
import { getThreadsData } from '@/data/threads/store';

/**
 * We test store-bridge by dynamically importing it fresh for each test
 * so the lazy refs (_projectStoreRef, _threadStoreRef) start as null.
 */

function createMockStore<T extends Record<string, any>>(initialState: T) {
  let state = { ...initialState };
  return {
    getState: () => state,
    setState: (partial: Partial<T>) => {
      state = { ...state, ...partial };
    },
    subscribe: vi.fn(),
    destroy: vi.fn(),
  };
}

function makeProject(p: { id: string; path: string }) {
  return {
    id: p.id,
    name: p.id,
    path: p.path,
    userId: 'user-1',
    sortOrder: 0,
    createdAt: '2024-01-01T00:00:00Z',
  };
}

// We need a fresh module for each test to reset the internal refs.
async function freshBridge() {
  // Clear the cached module so we get fresh lazy refs
  const modulePath = '@/stores/store-bridge';
  vi.resetModules();
  // Reuse the already-loaded data layer instead of re-importing TanStack DB
  // on every reset: that import alone can exceed the test timeout in a full run.
  vi.doMock('@/data/threads/read', () => threadsRead);
  vi.doMock('@/data/projects/read', () => projectsRead);
  return import(modulePath);
}

describe('store-bridge', () => {
  describe('before registration', () => {
    test('ensureThreadsLoaded is a no-op and does not throw', async () => {
      const bridge = await freshBridge();
      expect(() => bridge.ensureThreadsLoaded('p1')).not.toThrow();
    });

    test('clearProjectThreads is a no-op and does not throw', async () => {
      const bridge = await freshBridge();
      expect(() => bridge.clearProjectThreads('p1')).not.toThrow();
    });

    test('expandProject is a no-op and does not throw', async () => {
      const bridge = await freshBridge();
      expect(() => bridge.expandProject('p1')).not.toThrow();
    });

    test('selectProject is a no-op and does not throw', async () => {
      const bridge = await freshBridge();
      expect(() => bridge.selectProject('p1')).not.toThrow();
    });

    test('getProjectPath returns undefined', async () => {
      const bridge = await freshBridge();
      seedProjects([]);
      expect(bridge.getProjectPath('p1')).toBeUndefined();
    });
  });

  describe('after registration', () => {
    test('ensureThreadsLoaded calls loadThreadsForProject when not loaded', async () => {
      const bridge = await freshBridge();

      const loadThreadsForProject = vi.fn();
      const threadStore = createMockStore({
        threadIdsByProject: {} as Record<string, string[]>,
        loadThreadsForProject,
      });

      bridge.registerThreadStore(threadStore as any);
      bridge.ensureThreadsLoaded('p1');

      expect(loadThreadsForProject).toHaveBeenCalledWith('p1');
    });

    test('ensureThreadsLoaded skips if threads already loaded', async () => {
      const bridge = await freshBridge();
      setSourceMembers(getThreadsData().meta, 'project:p1', ['t1'], 1);

      const loadThreadsForProject = vi.fn();
      const threadStore = createMockStore({ loadThreadsForProject });

      bridge.registerThreadStore(threadStore as any);
      bridge.ensureThreadsLoaded('p1');

      expect(loadThreadsForProject).not.toHaveBeenCalled();
    });

    test('clearProjectThreads delegates to thread store', async () => {
      const bridge = await freshBridge();

      const clearProjectThreads = vi.fn();
      const threadStore = createMockStore({
        clearProjectThreads,
      });

      bridge.registerThreadStore(threadStore as any);
      bridge.clearProjectThreads('p1');

      expect(clearProjectThreads).toHaveBeenCalledWith('p1');
    });

    test('expandProject adds to expandedProjects set', async () => {
      const bridge = await freshBridge();

      const projectStore = createMockStore({
        expandedProjects: new Set<string>(),
      });

      bridge.registerProjectStore(projectStore as any);
      bridge.expandProject('p1');

      const state = projectStore.getState();
      expect(state.expandedProjects.has('p1')).toBe(true);
    });

    test('expandProject does not update if project already expanded', async () => {
      const bridge = await freshBridge();

      const projectStore = createMockStore({
        expandedProjects: new Set<string>(['p1']),
      });

      const setStateSpy = vi.spyOn(projectStore, 'setState');
      bridge.registerProjectStore(projectStore as any);
      bridge.expandProject('p1');

      expect(setStateSpy).not.toHaveBeenCalled();
    });

    test('selectProject sets selectedProjectId on project store', async () => {
      const bridge = await freshBridge();

      const projectStore = createMockStore({
        selectedProjectId: null as string | null,
      });

      bridge.registerProjectStore(projectStore as any);
      bridge.selectProject('p1');

      expect(projectStore.getState().selectedProjectId).toBe('p1');
    });

    test('getProjectPath returns correct path', async () => {
      const bridge = await freshBridge();
      // Regression: project rows moved to the data layer; reading them off the
      // project store threw "Cannot read properties of undefined (reading 'find')".
      seedProjects([
        makeProject({ id: 'p1', path: '/home/user/project-a' }),
        makeProject({ id: 'p2', path: '/home/user/project-b' }),
      ]);
      bridge.registerProjectStore(createMockStore({ selectedProjectId: null }) as any);

      expect(bridge.getProjectPath('p1')).toBe('/home/user/project-a');
      expect(bridge.getProjectPath('p2')).toBe('/home/user/project-b');
    });

    test('getProjectPath returns undefined for unknown project', async () => {
      const bridge = await freshBridge();
      seedProjects([makeProject({ id: 'p1', path: '/home/user/project-a' })]);

      expect(bridge.getProjectPath('unknown')).toBeUndefined();
    });
  });
});
