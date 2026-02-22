import { create } from 'zustand';
import type { Project } from '@funny/shared';
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
  updateProject: (projectId: string, data: { name?: string; color?: string | null; followUpMode?: string; defaultProvider?: string | null; defaultModel?: string | null; defaultMode?: string | null; defaultPermissionMode?: string | null }) => Promise<void>;
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
        // Set initialized immediately so the sidebar renders project names right away.
        // Threads load in background and fill in progressively.
        set({ projects, initialized: true });

        // Load threads first, then fetch git statuses only for expanded projects.
        // Fetching all projects at startup spawns too many git processes and can
        // crash Bun. Non-expanded projects get their status when the user opens them.
        const threadStore = useThreadStore.getState();
        Promise.all(
          projects.map((p) => threadStore.loadThreadsForProject(p.id))
        ).then(() => {
          const gitStore = useGitStatusStore.getState();
          const { expandedProjects } = get();
          for (const p of projects) {
            if (expandedProjects.has(p.id)) {
              gitStore.fetchForProject(p.id);
            }
          }
        }).catch(() => {});
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
      // Fetch git status when expanding (lazy load instead of at startup)
      useGitStatusStore.getState().fetchForProject(projectId);
    }
    set({ expandedProjects: next });
  },

  selectProject: (projectId) => {
    if (!projectId) {
      set({ selectedProjectId: null });
      return;
    }
    const { expandedProjects, selectedProjectId } = get();
    // Skip redundant work if already selected and expanded
    const alreadySelected = selectedProjectId === projectId;
    const alreadyExpanded = expandedProjects.has(projectId);
    if (alreadySelected && alreadyExpanded) return;
    if (!alreadySelected) set({ selectedProjectId: projectId });
    if (!alreadyExpanded) {
      const next = new Set(expandedProjects);
      next.add(projectId);
      set({ expandedProjects: next });
    }
    const threadStore = useThreadStore.getState();
    if (!threadStore.threadsByProject[projectId]) {
      threadStore.loadThreadsForProject(projectId);
    }
    // Refresh git statuses so the header and sidebar show current diff stats
    useGitStatusStore.getState().fetchForProject(projectId);
  },

  renameProject: async (projectId, name) => {
    const result = await api.renameProject(projectId, name);
    if (result.isErr()) return;
    const { projects } = get();
    set({
      projects: projects.map((p) => (p.id === projectId ? result.value : p)),
    });
  },

  updateProject: async (projectId, data) => {
    const result = await api.updateProject(projectId, data);
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
