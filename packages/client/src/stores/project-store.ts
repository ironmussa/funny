import type { Project } from '@funny/shared';
import { create } from 'zustand';

import { api } from '@/lib/api';

import { useAuthStore } from './auth-store';
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
      defaultBranch?: string | null;
      urls?: string[] | null;
      systemPrompt?: string | null;
      launcherUrl?: string | null;
    },
  ) => Promise<void>;
  deleteProject: (projectId: string) => Promise<void>;
  reorderProjects: (projectIds: string[]) => Promise<void>;
  setProjectLocalPath: (projectId: string, localPath: string) => Promise<boolean>;
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
        const { activeOrgId, activeOrgName } = useAuthStore.getState();
        const result = await api.listProjects(activeOrgId);
        if (result.isErr()) return;
        // When an org is active, all returned projects belong to that org.
        // Mark them as team projects with the org name so the sidebar shows badges.
        const projects = activeOrgId
          ? result.value.map((p) => ({
              ...p,
              isTeamProject: true as const,
              organizationName: p.organizationName || activeOrgName || undefined,
            }))
          : result.value;
        // Set initialized immediately so the sidebar renders project names right away.
        // Threads load in background and fill in progressively.
        set({ projects, initialized: true });

        // Fire git status + branch fetches immediately in parallel with thread
        // loading (async-parallel). Previously these waited until ALL threads
        // finished loading, adding unnecessary latency to sidebar diff stats.
        const gitStore = useGitStatusStore.getState();
        const { expandedProjects, fetchBranch } = get();
        for (const p of projects) {
          gitStore.fetchForProject(p.id);
          if (expandedProjects.has(p.id)) {
            fetchBranch(p.id);
          }
        }

        // Load threads for all projects in parallel, then batch-update the store
        // in a single set() call to avoid N separate re-renders (one per project).
        Promise.all(
          projects.map(async (p) => {
            const result = await api.listThreads(p.id, true);
            return { projectId: p.id, threads: result.isOk() ? result.value : null };
          }),
        )
          .then((results) => {
            // Batch all thread data into a single store update, but only
            // replace entries that actually changed to preserve referential
            // identity for untouched projects (avoids cascading re-renders).
            const prev = useThreadStore.getState().threadsByProject;
            let changed = false;
            const next: Record<string, any[]> = { ...prev };
            for (const { projectId, threads } of results) {
              if (threads && threads !== prev[projectId]) {
                next[projectId] = threads;
                changed = true;
              }
            }
            if (changed) useThreadStore.setState({ threadsByProject: next });
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
      if (get().selectedProjectId != null) set({ selectedProjectId: null });
      return;
    }
    const { selectedProjectId } = get();
    if (selectedProjectId === projectId) return;
    set({ selectedProjectId: projectId });
    const threadStore = useThreadStore.getState();
    if (!threadStore.threadsByProject[projectId]) {
      threadStore.loadThreadsForProject(projectId);
    }
    // Fetch branch name for the selected project
    get().fetchBranch(projectId);
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

  setProjectLocalPath: async (projectId, localPath) => {
    const result = await api.setProjectLocalPath(projectId, localPath);
    if (result.isErr()) return false;
    const { projects } = get();
    set({
      projects: projects.map((p) =>
        p.id === projectId ? { ...p, localPath, needsSetup: false } : p,
      ),
    });
    return true;
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
