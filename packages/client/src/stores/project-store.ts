import { create } from 'zustand';
import type { Project } from '@a-parallel/shared';
import { api } from '@/lib/api';
import { useThreadStore } from './thread-store';
import { useGitStatusStore } from './git-status-store';

interface ProjectState {
  projects: Project[];
  expandedProjects: Set<string>;
  selectedProjectId: string | null;
  initialized: boolean;

  loadProjects: () => Promise<void>;
  toggleProject: (projectId: string) => void;
  selectProject: (projectId: string | null) => void;
  renameProject: (projectId: string, name: string) => Promise<void>;
  deleteProject: (projectId: string) => Promise<void>;
  reorderProjects: (projectIds: string[]) => Promise<void>;
}

let _loadProjectsPromise: Promise<void> | null = null;

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  expandedProjects: new Set(),
  selectedProjectId: null,
  initialized: false,

  loadProjects: async () => {
    // Deduplicate concurrent calls (StrictMode, cascading re-renders, etc.)
    if (_loadProjectsPromise) return _loadProjectsPromise;

    _loadProjectsPromise = (async () => {
      try {
        const result = await api.listProjects();
        if (result.isErr()) return;
        const projects = result.value;
        set({ projects });

        // Load threads for all projects so Running/Recent sections work immediately
        const threadStore = useThreadStore.getState();
        await Promise.all(
          projects.map((p) => threadStore.loadThreadsForProject(p.id))
        );
        set({ initialized: true });

        // Fetch git statuses for all projects (best-effort, non-blocking)
        const gitStore = useGitStatusStore.getState();
        for (const p of projects) {
          gitStore.fetchForProject(p.id);
        }
      } finally {
        _loadProjectsPromise = null;
      }
    })();

    return _loadProjectsPromise;
  },

  toggleProject: (projectId: string) => {
    const { expandedProjects } = get();
    const next = new Set(expandedProjects);
    if (next.has(projectId)) {
      next.delete(projectId);
    } else {
      next.add(projectId);
      // Load threads for newly expanded project
      const threadStore = useThreadStore.getState();
      if (!threadStore.threadsByProject[projectId]) {
        threadStore.loadThreadsForProject(projectId);
      }
    }
    set({ expandedProjects: next });
  },

  selectProject: (projectId) => {
    if (!projectId) {
      set({ selectedProjectId: null });
      return;
    }
    const { expandedProjects } = get();
    set({ selectedProjectId: projectId });
    if (!expandedProjects.has(projectId)) {
      const next = new Set(expandedProjects);
      next.add(projectId);
      set({ expandedProjects: next });
    }
    const threadStore = useThreadStore.getState();
    if (!threadStore.threadsByProject[projectId]) {
      threadStore.loadThreadsForProject(projectId);
    }
  },

  renameProject: async (projectId, name) => {
    const result = await api.renameProject(projectId, name);
    if (result.isErr()) return;
    const { projects } = get();
    set({
      projects: projects.map((p) => (p.id === projectId ? result.value : p)),
    });
  },

  deleteProject: async (projectId) => {
    const result = await api.deleteProject(projectId);
    if (result.isErr()) return;
    const { projects, expandedProjects, selectedProjectId } = get();
    const nextExpanded = new Set(expandedProjects);
    nextExpanded.delete(projectId);

    useThreadStore.getState().clearProjectThreads(projectId);

    set({
      projects: projects.filter((p) => p.id !== projectId),
      expandedProjects: nextExpanded,
      ...(selectedProjectId === projectId ? { selectedProjectId: null } : {}),
    });
  },

  reorderProjects: async (projectIds) => {
    const { projects } = get();
    // Optimistic update: reorder local array immediately
    const projectMap = new Map(projects.map((p) => [p.id, p]));
    const reordered = projectIds
      .map((id) => projectMap.get(id))
      .filter((p): p is Project => !!p);

    set({ projects: reordered });

    // Persist to server
    const result = await api.reorderProjects(projectIds);
    if (result.isErr()) {
      // Revert on failure
      set({ projects });
    }
  },
}));
