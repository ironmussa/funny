import type { Project } from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import type { Result } from 'neverthrow';
import { create } from 'zustand';

import { parseRoute } from '@/hooks/route-parser';
import { projectsApi } from '@/lib/api/projects';
import { threadsApi } from '@/lib/api/threads';
import { metric, startSpan } from '@/lib/telemetry';

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
// Bumped by the authoritative writer (setBranch, post-checkout). An in-flight
// fetchBranch reads the cwd branch *before* a checkout completes, so it must
// discard its result if a setBranch superseded it mid-flight — otherwise the
// stale value overwrites the fresh one and the branch label flickers back.
const _branchGen = new Map<string, number>();

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
      fastMode?: boolean;
      defaultProvider?: string | null;
      defaultModel?: string | null;
      defaultMode?: string | null;
      defaultPermissionMode?: string | null;
      defaultBranch?: string | null;
      urls?: string[] | null;
      systemPrompt?: string | null;
      launcherUrl?: string | null;
    },
  ) => Promise<Result<Project, DomainError>>;
  deleteProject: (projectId: string) => Promise<void>;
  closeProject: (projectId: string) => Promise<void>;
  reopenProject: (projectId: string) => Promise<void>;
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
      // Telemetry envelope for the whole load. Each milestone below is recorded
      // as a gauge in ms-since-t0 so Abbacchio can graph the spread between the
      // FIRST project's threads landing and the LAST — the progressive publish
      // (vs. a Promise.all barrier) is exactly what compresses that gap.
      const loadSpan = startSpan('projects.load');
      const t0 = Date.now();
      try {
        const { activeOrgId, activeOrgName } = useAuthStore.getState();
        const result = await projectsApi.listProjects(activeOrgId);
        if (result.isErr()) {
          loadSpan.end('ERROR', 'listProjects failed');
          return;
        }
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
        // Project names are now on screen.
        metric('projects.count', projects.length, { type: 'gauge' });
        metric('projects.list_ms', Date.now() - t0, { type: 'gauge' });

        // The browser caps concurrent connections per origin (~6), so whatever
        // we dispatch first wins the sockets. The user's directive: load the
        // thread that's ON SCREEN first, then everything else. So the active
        // project (from the URL) is hoisted to the front of the thread-list
        // fan-out, and git status / branches are deferred to idle (below) so
        // they don't starve the lists — Abbacchio showed the eager git loop
        // kicking off ~28 background git.fetch_remote (2s each) that saturated
        // the runner's git pool and stalled the sidebar lists ~1.5s.
        const activeProjectId = parseRoute(window.location.pathname).projectId;
        const ordered =
          activeProjectId && projects.some((p) => p.id === activeProjectId)
            ? [
                ...projects.filter((p) => p.id === activeProjectId),
                ...projects.filter((p) => p.id !== activeProjectId),
              ]
            : projects;

        // Load threads for all projects in parallel, but publish each project's
        // rows as soon as they arrive. A single slow project should not keep
        // the first visible thread hidden during app refresh.
        let firstPublished = false;
        const publishProjectThreads = async (p: Project, dispatchOrder: number) => {
          // Dispatch instant (relative to t0): all lists are mapped synchronously,
          // so these should cluster near list_ms. If list_latency_ms is far larger
          // than the server-side span (~9ms), the delta is time spent waiting in the
          // browser's per-origin connection queue — i.e. socket starvation, not the
          // server or the Promise.all barrier.
          const dispatchMs = Date.now() - t0;
          metric('projects.list_dispatch_ms', dispatchMs, {
            type: 'gauge',
            attributes: { projectId: p.id, dispatchOrder: String(dispatchOrder) },
          });
          const fetchStart = Date.now();
          try {
            const result = await threadsApi.listThreads(p.id, false, 50);
            metric('projects.list_latency_ms', Date.now() - fetchStart, {
              type: 'gauge',
              attributes: { projectId: p.id, dispatchOrder: String(dispatchOrder) },
            });
            const threads = result.isOk() ? result.value.threads : null;
            batchUpdateThreads([
              {
                projectId: p.id,
                threads,
                total: result.isOk() ? result.value.total : 0,
              },
            ]);
            const elapsed = Date.now() - t0;
            // First tree rows on screen — the milestone the progressive
            // publish advances ahead of the slowest project.
            if (!firstPublished) {
              firstPublished = true;
              metric('projects.first_threads_ms', elapsed, { type: 'gauge' });
            }
            metric('projects.threads_published_ms', elapsed, {
              type: 'gauge',
              attributes: {
                projectId: p.id,
                threadCount: String(threads?.length ?? 0),
              },
            });
          } catch {
            // Keep project loading resilient to per-project thread failures.
          }
        };
        const publishPromises = ordered.map((p, i) => publishProjectThreads(p, i));
        // Close the load envelope once every project has settled. The gap
        // between projects.first_threads_ms and projects.all_threads_ms is the
        // window the fix shrinks perceptually.
        void Promise.all(publishPromises).then(() => {
          metric('projects.all_threads_ms', Date.now() - t0, { type: 'gauge' });
          loadSpan.end('OK');
        });

        // Git status + branches are NOT on the critical path for showing the
        // sidebar thread rows, and they trigger the runner's expensive remote
        // fetch. Defer them to idle so the thread lists (and the active thread's
        // detail fetch) claim the socket pool first; diff stats fill in after.
        const { expandedProjects, fetchBranch } = get();
        const fireGitStatus = () => {
          for (const p of ordered) {
            fetchGitStatusForProject(p.id);
            if (expandedProjects.has(p.id)) {
              fetchBranch(p.id);
            }
          }
        };
        if (typeof requestIdleCallback === 'function') {
          requestIdleCallback(fireGitStatus, { timeout: 2000 });
        } else {
          setTimeout(fireGitStatus, 200);
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
    // Invalidate any in-flight fetchBranch that read the pre-checkout branch.
    _branchGen.set(projectId, (_branchGen.get(projectId) ?? 0) + 1);
    set({ branchByProject: { ...get().branchByProject, [projectId]: branch } });
  },

  fetchBranch: async (projectId) => {
    const now = Date.now();
    const last = _lastFetchBranch.get(projectId) ?? 0;
    if (now - last < BRANCH_COOLDOWN_MS) return;
    _lastFetchBranch.set(projectId, now);
    const gen = _branchGen.get(projectId) ?? 0;

    // Abort any stale in-flight branch listing for this project
    _abortBranch.get(projectId)?.abort();
    const ac = new AbortController();
    _abortBranch.set(projectId, ac);
    _inFlightBranch.add(projectId);

    try {
      const result = await projectsApi.listBranches(projectId, ac.signal);
      if (result.isErr()) return;
      // A checkout (setBranch) landed while we were listing — its branch is
      // authoritative, so drop our now-stale read instead of clobbering it.
      if ((_branchGen.get(projectId) ?? 0) !== gen) return;
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
    if (result.isOk()) {
      const { projects } = get();
      set({
        projects: projects.map((p) => (p.id === projectId ? result.value : p)),
      });
    }
    return result;
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

  closeProject: async (projectId) => {
    const result = await projectsApi.updateProject(projectId, { closed: true });
    if (result.isErr()) return;
    const { projects, expandedProjects, selectedProjectId } = get();
    const nextExpanded = new Set(expandedProjects);
    nextExpanded.delete(projectId);
    set({
      projects: projects.map((p) => (p.id === projectId ? result.value : p)),
      expandedProjects: nextExpanded,
      ...(selectedProjectId === projectId ? { selectedProjectId: null } : {}),
    });
    persistExpandedProjects(nextExpanded);
  },

  reopenProject: async (projectId) => {
    const result = await projectsApi.updateProject(projectId, { closed: false });
    if (result.isErr()) return;
    const { projects } = get();
    set({
      projects: projects.map((p) => (p.id === projectId ? result.value : p)),
    });
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
