import type { Project } from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import type { Result } from 'neverthrow';
import { create } from 'zustand';

import {
  closeProject as closeProjectRow,
  deleteProject as deleteProjectRow,
  renameProject as renameProjectRow,
  reopenProject as reopenProjectRow,
  reorderProjects as reorderProjectRows,
  setProjectLocalPath as setProjectLocalPathRow,
  updateProject as updateProjectRow,
} from '@/data/projects/actions';
import { fetchProjectBranches, setProjectCurrentBranch } from '@/data/projects/branches';
import { loadProjects as loadProjectRows } from '@/data/projects/loaders';
import { parseRoute } from '@/hooks/route-parser';
import type { UpdateProjectInput } from '@/lib/api/projects';
import { metric, startSpan } from '@/lib/telemetry';
import { clientComposition } from '@/platform/client-composition';

import { useAuthStore } from './auth-store';
import {
  ensureThreadsLoaded,
  clearProjectThreads,
  fetchGitStatusForProject,
  registerProjectStore,
} from './store-bridge';

const EXPANDED_PROJECTS_KEY = 'funny_expanded_projects';

function loadExpandedProjects(): Set<string> {
  try {
    const stored = clientComposition.platform.storage.read(EXPANDED_PROJECTS_KEY);
    if (stored) return new Set(JSON.parse(stored));
  } catch {}
  return new Set();
}

function persistExpandedProjects(ids: Set<string>) {
  try {
    clientComposition.platform.storage.write(EXPANDED_PROJECTS_KEY, JSON.stringify([...ids]));
  } catch {}
}

interface ProjectState {
  // Project rows live in the data layer's projects collection
  // (`src/data/projects`). Read them with `useProjects()` / `useProjectById()`
  // (React) or `readProjects()` / `readProject()` (imperative).
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
    data: UpdateProjectInput,
  ) => Promise<Result<Project, DomainError>>;
  deleteProject: (projectId: string) => Promise<void>;
  closeProject: (projectId: string) => Promise<void>;
  reopenProject: (projectId: string) => Promise<void>;
  reorderProjects: (projectIds: string[]) => Promise<void>;
  setProjectLocalPath: (projectId: string, localPath: string) => Promise<boolean>;
}

let _loadProjectsPromise: Promise<void> | null = null;

export const useProjectStore = create<ProjectState>((set, get) => ({
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
      // Telemetry envelope for the critical startup load. Background work is
      // deliberately outside this span so it cannot obscure time-to-project-list.
      const loadSpan = startSpan('projects.load');
      const t0 = Date.now();
      try {
        const { activeOrgId, activeOrgName } = useAuthStore.getState();
        // Rows land in the projects collection (org projects badged as team projects).
        const result = await loadProjectRows({ orgId: activeOrgId, orgName: activeOrgName });
        if (result.isErr()) {
          loadSpan.end('ERROR', 'listProjects failed');
          return;
        }
        const projects = result.value;
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
        set({ initialized: true });
        // Project names are now on screen.
        metric('projects.count', projects.length, { type: 'gauge' });
        metric('projects.list_ms', Date.now() - t0, { type: 'gauge' });

        // Keep the project from the URL first for the small amount of deferred
        // per-project work below. Git status and branches stay off the critical
        // path so the visible thread owns the runner/browser capacity at startup.
        const activeProjectId = parseRoute(
          clientComposition.platform.navigation.current().pathname,
        ).projectId;
        const ordered = activeProjectId
          ? [
              ...projects.filter((p) => p.id === activeProjectId),
              ...projects.filter((p) => p.id !== activeProjectId),
            ]
          : projects;

        // A collapsed project only needs its name on screen. Loading 50 threads
        // for every project at startup caused one request and one global Zustand
        // publication per project, competing with the initial chat commit. The
        // active project is needed immediately; persisted expanded projects are
        // loaded after the first paint. All other projects load when expanded or
        // selected via toggleProject/selectProject.
        if (activeProjectId && validIds.has(activeProjectId)) {
          ensureThreadsLoaded(activeProjectId);
          metric('projects.first_threads_dispatch_ms', Date.now() - t0, { type: 'gauge' });
        }

        const loadExpandedProjects = () => {
          for (const projectId of expanded) {
            if (projectId !== activeProjectId && validIds.has(projectId)) {
              ensureThreadsLoaded(projectId);
            }
          }
        };
        if (typeof requestIdleCallback === 'function') {
          requestIdleCallback(loadExpandedProjects, { timeout: 1000 });
        } else {
          setTimeout(loadExpandedProjects, 0);
        }
        loadSpan.end('OK');

        // Git status + branches are NOT on the critical path for showing the
        // sidebar thread rows, and they trigger the runner's expensive remote
        // fetch. Defer them to idle so the thread lists (and the active thread's
        // detail fetch) claim the socket pool first; diff stats fill in after.
        const { expandedProjects, fetchBranch } = get();
        const fireGitStatus = () => {
          for (const p of ordered) {
            const isVisibleProject = p.id === activeProjectId || expandedProjects.has(p.id);
            if (isVisibleProject) {
              fetchGitStatusForProject(p.id);
            }
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
    // The caller already knows the new branch (e.g. it just checked it out):
    // record it in the branch query too, cancelling an in-flight listing that
    // read the pre-checkout branch so it cannot flicker the label back.
    setProjectCurrentBranch(projectId, branch);
    set({ branchByProject: { ...get().branchByProject, [projectId]: branch } });
  },

  // The listing is a shared query (`data/projects/branches.ts`): its freshness
  // replaces the old cooldown, and in-flight requests are de-duplicated.
  fetchBranch: async (projectId) => {
    const listing = await fetchProjectBranches(projectId);
    const currentBranch = listing?.currentBranch;
    if (currentBranch && get().branchByProject[projectId] !== currentBranch) {
      set({ branchByProject: { ...get().branchByProject, [projectId]: currentBranch } });
    }
  },

  // Project writes are optimistic transactions on the projects collection:
  // they show at once everywhere and roll back with a toast on failure. See
  // data/projects/actions.ts.
  renameProject: async (projectId, name) => {
    await renameProjectRow(projectId, name);
  },

  updateProject: async (projectId, data) => updateProjectRow(projectId, data),

  deleteProject: async (projectId) => {
    const result = await deleteProjectRow(projectId);
    if (result.isErr()) return;
    clearProjectThreads(projectId);
    forgetProjectUiState(projectId);
  },

  closeProject: async (projectId) => {
    const result = await closeProjectRow(projectId);
    if (result.isOk()) forgetProjectUiState(projectId);
  },

  reopenProject: async (projectId) => {
    await reopenProjectRow(projectId);
  },

  setProjectLocalPath: async (projectId, localPath) =>
    (await setProjectLocalPathRow(projectId, localPath)).isOk(),

  reorderProjects: async (projectIds) => {
    await reorderProjectRows(projectIds);
  },
}));

/** Collapse and deselect a project that left the list (deleted or closed). */
function forgetProjectUiState(projectId: string): void {
  const { expandedProjects, selectedProjectId } = useProjectStore.getState();
  const nextExpanded = new Set(expandedProjects);
  nextExpanded.delete(projectId);
  useProjectStore.setState({
    expandedProjects: nextExpanded,
    ...(selectedProjectId === projectId ? { selectedProjectId: null } : {}),
  });
  persistExpandedProjects(nextExpanded);
}

// Register with the bridge so thread-store can access project state without a direct import
registerProjectStore(useProjectStore);
