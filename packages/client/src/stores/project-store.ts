import type { Project } from '@funny/shared';
import { create } from 'zustand';

import { projectsApi } from '@/lib/api/projects';
import { threadsApi } from '@/lib/api/threads';

import { useAuthStore } from './auth-store';
import {
  batchUpdateThreads,
  ensureThreadsLoaded,
  clearProjectThreads,
  fetchGitStatusForProject,
  registerProjectStore,
} from './store-bridge';

const EXPANDED_PROJECTS_KEY = 'funny_expanded_projects';

// Branch fetch cooldown — branches change rarely (only on checkout/merge)
const BRANCH_COOLDOWN_MS = 10_000;
const _lastFetchBranch = new Map<string, number>();
const _inFlightBranch = new Set<string>();
const _abortBranch = new Map<string, AbortController>();

function loadExpandedProjects(): Set<string> {
  try {
    const stored = localStorage.getItem(EXPANDED_PROJECTS_KEY);
    if (stored) return new Set(JSON.parse(stored));
  } catch {}
  return new Set();
}

function persistExpandedProjects(ids: Set<string>) {
  try {
    localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify([...ids]));
  } catch {}
}

interface ProjectState {
  projects: Project[];
  expandedProjects: Set<string>;
  selectedProjectId: string | null;
  // Bumped every time selectProject is called, even when the same project is
  // re-selected. Subscribers (e.g. the sidebar) use this to re-trigger
  // reveal/scroll behavior on repeated selections (Ctrl+K → same project).
  revealNonce: number;
  // Hint to the sidebar auto-scroll about how to align the project. 'start'
  // pins the project header to the top of the projects pane (Ctrl+K, where
  // the user can't see the project yet); 'nearest' only scrolls the minimum
  // amount needed (sidebar/header clicks where the row is usually visible).
  revealIntent: 'start' | 'nearest';
  initialized: boolean;
  branchByProject: Record<string, string>;

  loadProjects: () => Promise<void>;
  toggleProject: (projectId: string) => void;
  selectProject: (
    projectId: string | null,
    options?: { revealIntent?: 'start' | 'nearest' },
  ) => void;
  fetchBranch: (projectId: string) => Promise<void>;
  setBranch: (projectId: string, branch: string) => void;
  renameProject: (projectId: string, name: string) => Promise<void>;
  updateProject: (
    projectId: string,
    data: {
      name?: string;
      path?: string;
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
  expandedProjects: loadExpandedProjects(),
  selectedProjectId: null,
  revealNonce: 0,
  revealIntent: 'nearest',
  initialized: false,
  branchByProject: {},

  loadProjects: async () => {
    // Deduplicate concurrent calls (StrictMode, cascading re-renders, etc.)
    if (_loadProjectsPromise) return _loadProjectsPromise;

    _loadProjectsPromise = (async () => {
      try {
        const { activeOrgId, activeOrgName } = useAuthStore.getState();
        const result = await projectsApi.listProjects(activeOrgId);
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
        // Prune expanded IDs that no longer exist (deleted projects).
        const validIds = new Set(projects.map((p) => p.id));
        const expanded = get().expandedProjects;
        let pruned = false;
        for (const id of expanded) {
          if (!validIds.has(id)) {
            expanded.delete(id);
            pruned = true;
          }
        }
        if (pruned) persistExpandedProjects(expanded);
        set({ projects, initialized: true });

        // Fire git status + branch fetches immediately in parallel with thread
        // loading (async-parallel). Previously these waited until ALL threads
        // finished loading, adding unnecessary latency to sidebar diff stats.
        const { expandedProjects, fetchBranch } = get();
        for (const p of projects) {
          fetchGitStatusForProject(p.id);
          if (expandedProjects.has(p.id)) {
            fetchBranch(p.id);
          }
        }

        // Load threads for all projects in parallel, then batch-update the store
        // in a single set() call to avoid N separate re-renders (one per project).
        Promise.all(
          projects.map(async (p) => {
            const result = await threadsApi.listThreads(p.id, false, 50);
            return {
              projectId: p.id,
              threads: result.isOk() ? result.value.threads : null,
              total: result.isOk() ? result.value.total : 0,
            };
          }),
        )
          .then((results) => {
            batchUpdateThreads(results);
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
      ensureThreadsLoaded(projectId);
      // Fetch branch name for the expanded project
      get().fetchBranch(projectId);
      // Defer git status fetch to avoid blocking the interaction (INP).
      // The collapsible animation and thread list render first, then git
      // status icons fill in once the browser is idle.
      const fetchGitStatus = () => fetchGitStatusForProject(projectId);
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(fetchGitStatus);
      } else {
        setTimeout(fetchGitStatus, 100);
      }
    }
    set({ expandedProjects: next });
    persistExpandedProjects(next);
  },

  selectProject: (projectId, options) => {
    if (!projectId) {
      if (get().selectedProjectId != null) set({ selectedProjectId: null });
      return;
    }
    const { selectedProjectId, revealNonce } = get();
    const revealIntent = options?.revealIntent ?? 'nearest';
    // Always bump revealNonce so subscribers can re-trigger reveal behavior
    // (sidebar auto-scroll/expand) even when the same project is re-selected.
    if (selectedProjectId === projectId) {
      set({ revealNonce: revealNonce + 1, revealIntent });
      return;
    }
    set({ selectedProjectId: projectId, revealNonce: revealNonce + 1, revealIntent });
    ensureThreadsLoaded(projectId);
    // Fetch branch name for the selected project
    get().fetchBranch(projectId);
    // Defer git status fetch to avoid blocking the interaction (INP)
    const fetchGitStatus = () => fetchGitStatusForProject(projectId);
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(fetchGitStatus);
    } else {
      setTimeout(fetchGitStatus, 100);
    }
  },

  setBranch: (projectId, branch) => {
    // Bypass the fetchBranch cooldown — the caller already knows the new branch
    // (e.g. just performed a checkout) and needs subscribers to see the change.
    _lastFetchBranch.set(projectId, Date.now());
    set({ branchByProject: { ...get().branchByProject, [projectId]: branch } });
  },

  fetchBranch: async (projectId) => {
    const now = Date.now();
    const last = _lastFetchBranch.get(projectId) ?? 0;
    if (now - last < BRANCH_COOLDOWN_MS) return;
    _lastFetchBranch.set(projectId, now);

    // Abort any stale in-flight branch listing for this project
    _abortBranch.get(projectId)?.abort();
    const ac = new AbortController();
    _abortBranch.set(projectId, ac);
    _inFlightBranch.add(projectId);

    try {
      const result = await projectsApi.listBranches(projectId, ac.signal);
      if (result.isErr()) return;
      const { currentBranch } = result.value;
      if (currentBranch) {
        set({ branchByProject: { ...get().branchByProject, [projectId]: currentBranch } });
      }
    } finally {
      _abortBranch.delete(projectId);
      _inFlightBranch.delete(projectId);
    }
  },

  renameProject: async (projectId, name) => {
    const result = await projectsApi.renameProject(projectId, name);
    if (result.isErr()) return;
    const { projects } = get();
    set({
      projects: projects.map((p) => (p.id === projectId ? result.value : p)),
    });
  },

  updateProject: async (projectId, data) => {
    const result = await projectsApi.updateProject(projectId, data);
    if (result.isErr()) return;
    const { projects } = get();
    set({
      projects: projects.map((p) => (p.id === projectId ? result.value : p)),
    });
  },

  deleteProject: async (projectId) => {
    const result = await projectsApi.deleteProject(projectId);
    if (result.isErr()) return;
    const { projects, expandedProjects, selectedProjectId } = get();
    const nextExpanded = new Set(expandedProjects);
    nextExpanded.delete(projectId);

    clearProjectThreads(projectId);

    set({
      projects: projects.filter((p) => p.id !== projectId),
      expandedProjects: nextExpanded,
      ...(selectedProjectId === projectId ? { selectedProjectId: null } : {}),
    });
    persistExpandedProjects(nextExpanded);
  },

  setProjectLocalPath: async (projectId, localPath) => {
    const result = await projectsApi.setProjectLocalPath(projectId, localPath);
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
    const result = await projectsApi.reorderProjects(projectIds);
    if (result.isErr()) {
      // Revert on failure
      set({ projects });
    }
  },
}));

// Register with the bridge so thread-store can access project state without a direct import
registerProjectStore(useProjectStore);
