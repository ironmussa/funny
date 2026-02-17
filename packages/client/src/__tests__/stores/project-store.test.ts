import { describe, test, expect, vi, beforeEach } from 'vitest';
import { okAsync, errAsync } from 'neverthrow';
import type { DomainError } from '@funny/shared/errors';
import type { Project } from '@funny/shared';

// ── Shared mock state that we can reassign per test ──────────────────
const mockLoadThreadsForProject = vi.fn().mockResolvedValue(undefined);
const mockClearProjectThreads = vi.fn();
let mockThreadsByProject: Record<string, unknown[]> = {};
const mockFetchForProject = vi.fn();

// Mock dependencies
vi.mock('@/lib/api', () => ({
  api: {
    listProjects: vi.fn(),
    renameProject: vi.fn(),
    updateProject: vi.fn(),
    deleteProject: vi.fn(),
    reorderProjects: vi.fn(),
  },
}));

vi.mock('@/stores/thread-store', () => ({
  useThreadStore: {
    getState: () => ({
      loadThreadsForProject: mockLoadThreadsForProject,
      get threadsByProject() {
        return mockThreadsByProject;
      },
      clearProjectThreads: mockClearProjectThreads,
    }),
  },
}));

vi.mock('@/stores/git-status-store', () => ({
  useGitStatusStore: {
    getState: () => ({
      fetchForProject: mockFetchForProject,
    }),
  },
}));

import { useProjectStore } from '@/stores/project-store';
import { api } from '@/lib/api';

const mockApi = vi.mocked(api);

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Project 1',
    path: '/tmp/p1',
    userId: 'u1',
    sortOrder: 0,
    createdAt: '2024-01-01',
    ...overrides,
  };
}

describe('ProjectStore', () => {
  beforeEach(() => {
    useProjectStore.setState({
      projects: [],
      expandedProjects: new Set(),
      selectedProjectId: null,
      initialized: false,
    });
    vi.clearAllMocks();
    mockThreadsByProject = {};
  });

  describe('Initial state', () => {
    test('has empty projects', () => {
      expect(useProjectStore.getState().projects).toEqual([]);
    });

    test('has no selectedProjectId', () => {
      expect(useProjectStore.getState().selectedProjectId).toBeNull();
    });

    test('has initialized=false', () => {
      expect(useProjectStore.getState().initialized).toBe(false);
    });
  });

  describe('loadProjects', () => {
    test('fetches and sets projects, sets initialized=true', async () => {
      const projects = [
        makeProject({ id: 'p1', name: 'Project 1' }),
        makeProject({ id: 'p2', name: 'Project 2', sortOrder: 1 }),
      ];
      mockApi.listProjects.mockReturnValueOnce(okAsync(projects) as any);

      await useProjectStore.getState().loadProjects();

      const state = useProjectStore.getState();
      expect(state.projects).toEqual(projects);
      expect(state.initialized).toBe(true);
    });

    test('triggers thread loading in background for all projects', async () => {
      const projects = [
        makeProject({ id: 'p1' }),
        makeProject({ id: 'p2' }),
      ];
      mockApi.listProjects.mockReturnValueOnce(okAsync(projects) as any);

      await useProjectStore.getState().loadProjects();

      expect(mockLoadThreadsForProject).toHaveBeenCalledWith('p1');
      expect(mockLoadThreadsForProject).toHaveBeenCalledWith('p2');
    });

    test('handles API errors gracefully', async () => {
      const error: DomainError = { type: 'INTERNAL', message: 'Server error' };
      mockApi.listProjects.mockReturnValueOnce(errAsync(error) as any);

      await useProjectStore.getState().loadProjects();

      const state = useProjectStore.getState();
      expect(state.projects).toEqual([]);
      expect(state.initialized).toBe(false);
    });
  });

  describe('toggleProject', () => {
    test('adds projectId to expandedProjects', () => {
      useProjectStore.getState().toggleProject('p1');

      expect(useProjectStore.getState().expandedProjects.has('p1')).toBe(true);
    });

    test('removes projectId if already expanded', () => {
      useProjectStore.setState({ expandedProjects: new Set(['p1']) });

      useProjectStore.getState().toggleProject('p1');

      expect(useProjectStore.getState().expandedProjects.has('p1')).toBe(false);
    });

    test('loads threads for newly expanded project', () => {
      useProjectStore.getState().toggleProject('p1');

      expect(mockLoadThreadsForProject).toHaveBeenCalledWith('p1');
    });

    test('does not load threads if already loaded', () => {
      mockThreadsByProject = { p1: [] };

      useProjectStore.getState().toggleProject('p1');

      expect(mockLoadThreadsForProject).not.toHaveBeenCalled();
    });
  });

  describe('selectProject', () => {
    test('sets selectedProjectId and auto-expands', () => {
      useProjectStore.getState().selectProject('p1');

      const state = useProjectStore.getState();
      expect(state.selectedProjectId).toBe('p1');
      expect(state.expandedProjects.has('p1')).toBe(true);
    });

    test('does not duplicate in expandedProjects if already expanded', () => {
      useProjectStore.setState({ expandedProjects: new Set(['p1']) });

      useProjectStore.getState().selectProject('p1');

      const state = useProjectStore.getState();
      expect(state.selectedProjectId).toBe('p1');
      expect(state.expandedProjects.has('p1')).toBe(true);
      expect(state.expandedProjects.size).toBe(1);
    });

    test('clears selectedProjectId with null', () => {
      useProjectStore.setState({ selectedProjectId: 'p1' });

      useProjectStore.getState().selectProject(null);

      expect(useProjectStore.getState().selectedProjectId).toBeNull();
    });

    test('loads threads for selected project', () => {
      useProjectStore.getState().selectProject('p1');

      expect(mockLoadThreadsForProject).toHaveBeenCalledWith('p1');
    });
  });

  describe('renameProject', () => {
    test('updates the project in the list', async () => {
      const original = makeProject({ id: 'p1', name: 'Old Name' });
      const renamed = makeProject({ id: 'p1', name: 'New Name' });
      useProjectStore.setState({ projects: [original] });
      mockApi.renameProject.mockReturnValueOnce(okAsync(renamed) as any);

      await useProjectStore.getState().renameProject('p1', 'New Name');

      const state = useProjectStore.getState();
      expect(state.projects).toHaveLength(1);
      expect(state.projects[0].name).toBe('New Name');
    });

    test('handles API errors (no update)', async () => {
      const original = makeProject({ id: 'p1', name: 'Old Name' });
      useProjectStore.setState({ projects: [original] });
      const error: DomainError = { type: 'NOT_FOUND', message: 'Not found' };
      mockApi.renameProject.mockReturnValueOnce(errAsync(error) as any);

      await useProjectStore.getState().renameProject('p1', 'New Name');

      const state = useProjectStore.getState();
      expect(state.projects[0].name).toBe('Old Name');
    });
  });

  describe('updateProject', () => {
    test('updates the project in the list', async () => {
      const original = makeProject({ id: 'p1', name: 'Project', color: undefined });
      const updated = makeProject({ id: 'p1', name: 'Project', color: '#ff0000' });
      useProjectStore.setState({ projects: [original] });
      mockApi.updateProject.mockReturnValueOnce(okAsync(updated) as any);

      await useProjectStore.getState().updateProject('p1', { color: '#ff0000' });

      const state = useProjectStore.getState();
      expect(state.projects[0].color).toBe('#ff0000');
    });
  });

  describe('deleteProject', () => {
    test('removes project from list', async () => {
      const p1 = makeProject({ id: 'p1' });
      const p2 = makeProject({ id: 'p2', name: 'Project 2' });
      useProjectStore.setState({
        projects: [p1, p2],
        expandedProjects: new Set(['p1']),
      });
      mockApi.deleteProject.mockReturnValueOnce(okAsync(undefined) as any);

      await useProjectStore.getState().deleteProject('p1');

      const state = useProjectStore.getState();
      expect(state.projects).toHaveLength(1);
      expect(state.projects[0].id).toBe('p2');
      expect(state.expandedProjects.has('p1')).toBe(false);
    });

    test('clears selectedProjectId if deleted project was selected', async () => {
      const p1 = makeProject({ id: 'p1' });
      useProjectStore.setState({
        projects: [p1],
        selectedProjectId: 'p1',
        expandedProjects: new Set(['p1']),
      });
      mockApi.deleteProject.mockReturnValueOnce(okAsync(undefined) as any);

      await useProjectStore.getState().deleteProject('p1');

      expect(useProjectStore.getState().selectedProjectId).toBeNull();
    });

    test('does not clear selectedProjectId if different project was selected', async () => {
      const p1 = makeProject({ id: 'p1' });
      const p2 = makeProject({ id: 'p2', name: 'Project 2' });
      useProjectStore.setState({
        projects: [p1, p2],
        selectedProjectId: 'p2',
        expandedProjects: new Set(['p1']),
      });
      mockApi.deleteProject.mockReturnValueOnce(okAsync(undefined) as any);

      await useProjectStore.getState().deleteProject('p1');

      expect(useProjectStore.getState().selectedProjectId).toBe('p2');
    });

    test('clears project threads via thread store', async () => {
      const p1 = makeProject({ id: 'p1' });
      useProjectStore.setState({ projects: [p1] });
      mockApi.deleteProject.mockReturnValueOnce(okAsync(undefined) as any);

      await useProjectStore.getState().deleteProject('p1');

      expect(mockClearProjectThreads).toHaveBeenCalledWith('p1');
    });

    test('does not remove project on API error', async () => {
      const p1 = makeProject({ id: 'p1' });
      useProjectStore.setState({ projects: [p1] });
      const error: DomainError = { type: 'INTERNAL', message: 'Server error' };
      mockApi.deleteProject.mockReturnValueOnce(errAsync(error) as any);

      await useProjectStore.getState().deleteProject('p1');

      expect(useProjectStore.getState().projects).toHaveLength(1);
    });
  });

  describe('reorderProjects', () => {
    test('optimistically reorders projects', async () => {
      const p1 = makeProject({ id: 'p1', name: 'First', sortOrder: 0 });
      const p2 = makeProject({ id: 'p2', name: 'Second', sortOrder: 1 });
      const p3 = makeProject({ id: 'p3', name: 'Third', sortOrder: 2 });
      useProjectStore.setState({ projects: [p1, p2, p3] });
      mockApi.reorderProjects.mockReturnValueOnce(okAsync(undefined) as any);

      await useProjectStore.getState().reorderProjects(['p3', 'p1', 'p2']);

      const state = useProjectStore.getState();
      expect(state.projects.map((p) => p.id)).toEqual(['p3', 'p1', 'p2']);
    });

    test('reverts on API failure', async () => {
      const p1 = makeProject({ id: 'p1', name: 'First', sortOrder: 0 });
      const p2 = makeProject({ id: 'p2', name: 'Second', sortOrder: 1 });
      const p3 = makeProject({ id: 'p3', name: 'Third', sortOrder: 2 });
      useProjectStore.setState({ projects: [p1, p2, p3] });
      const error: DomainError = { type: 'INTERNAL', message: 'Server error' };
      mockApi.reorderProjects.mockReturnValueOnce(errAsync(error) as any);

      await useProjectStore.getState().reorderProjects(['p3', 'p1', 'p2']);

      // Should revert to original order
      const state = useProjectStore.getState();
      expect(state.projects.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    });
  });
});
