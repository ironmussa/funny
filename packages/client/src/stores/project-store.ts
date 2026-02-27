import type { Project } from '@funny/shared';
import { create } from 'zustand';

import { api } from '@/lib/api';

import { useGitStatusStore } from './git-status-store';
import { useThreadStore } from './thread-store';

interface ProjectState {
  projects: Project[];
  expandedProjects: Set<string>;
  selectedProjectId: string | null;
  initialized: boolean;
  branchByProject: Record<string, string>;

  loadProjects: () => Promise<void>;
  toggleProject: (projectId: string) => void;
  selectProject: (projectId: string | null) => void;
  fetchBranch: (projectId: string) => Promise<void>;
  renameProject: (projectId: string, name: string) => Promise<void>;
  updateProject: (
    projectId: string,
    data: {
      name?: string;
      color?: string | null;
      followUpMode?: string;
      defaultProvider?: string | null;
      defaultModel?: string | null;
      defaultMode?: string | null;
      defaultPermissionMode?: string | null;
    },
  ) => Promise<void>;
  deleteProject: (projectId: string) => Promise<void>;
  reorderProjects: (projectIds: string[]) => Promise<void>;
}

let _loadProjectsPromise: Promise<void> | null = null;

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  expandedProjects: new Set(),
  selectedProjectId: null,
  initialized: false,
  branchByProject: {},

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

        // Load threads for all projects in parallel, then batch-update the store
        // in a single set() call to avoid N separate re-renders (one per project).
        // Only fetch git statuses for expanded projects to avoid spawning too many
        // git processes which can crash Bun.
        Promise.all(
          projects.map(async (p) => {
            const result = await api.listThreads(p.id, true);
            return { projectId: p.id, threads: result.isOk() ? result.value : null };
          }),
        )
          .then((results) => {
            // Batch all thread data into a single store update
            const threadsByProject: Record<string, any[]> = {
              ...useThreadStore.getState().threadsByProject,
            };
            for (const { projectId, threads } of results) {
              if (threads) threadsByProject[projectId] = threads;
            }
            useThreadStore.setState({ threadsByProject });

            // Defer git status and branch fetch for expanded projects
            const gitStore = useGitStatusStore.getState();
            const { expandedProjects, fetchBranch } = get();
            for (const p of projects) {
              if (expandedProjects.has(p.id)) {
                gitStore.fetchForProject(p.id);
                fetchBranch(p.id);
              }
            }
          })
          .catch(() => {});
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
      // Fetch branch name for the expanded project
      get().fetchBranch(projectId);
      // Defer git status fetch to avoid blocking the interaction (INP).
      // The collapsible animation and thread list render first, then git
      // status icons fill in once the browser is idle.
      const fetchGitStatus = () => useGitStatusStore.getState().fetchForProject(projectId);
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(fetchGitStatus);
      } else {
        setTimeout(fetchGitStatus, 100);
      }
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
    // Batch both updates into a single set() to avoid cascading re-renders
    const patch: Partial<Pick<ProjectState, 'selectedProjectId' | 'expandedProjects'>> = {};
    if (!alreadySelected) patch.selectedProjectId = projectId;
    if (!alreadyExpanded) {
      const next = new Set(expandedProjects);
      next.add(projectId);
      patch.expandedProjects = next;
    }
    set(patch);
    const threadStore = useThreadStore.getState();
    if (!threadStore.threadsByProject[projectId]) {
      threadStore.loadThreadsForProject(projectId);
    }
    // Fetch branch name for the selected project
    get().fetchBranch(projectId);
    // Auto-open the review pane so the user sees git info for the project
    // (only when no thread is active — otherwise the pane is thread-driven).
    // Lazy import to avoid circular dependency (ui-store imports project-store).
    if (!useThreadStore.getState().activeThread) {
      import('./ui-store').then(({ useUIStore }) => useUIStore.getState().setReviewPaneOpen(true));
    }
    // Defer git status fetch to avoid blocking the interaction (INP)
    const fetchGitStatus = () => useGitStatusStore.getState().fetchForProject(projectId);
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(fetchGitStatus);
    } else {
      setTimeout(fetchGitStatus, 100);
    }
  },

  fetchBranch: async (projectId) => {
    const result = await api.listBranches(projectId);
    if (result.isErr()) return;
    const { currentBranch } = result.value;
    if (currentBranch) {
      set({ branchByProject: { ...get().branchByProject, [projectId]: currentBranch } });
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
    const reordered = projectIds.map((id) => projectMap.get(id)).filter((p): p is Project => !!p);

    set({ projects: reordered });

    // Persist to server
    const result = await api.reorderProjects(projectIds);
    if (result.isErr()) {
      // Revert on failure
      set({ projects });
    }
  },
}));
