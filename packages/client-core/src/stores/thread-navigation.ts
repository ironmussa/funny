import type { Project, Thread } from '@funny/shared';

import { createStore, type StoreApi } from './vanilla-store';

export function uniqueEntityIds<T extends { id: string }>(entities: readonly T[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entity of entities) {
    if (seen.has(entity.id)) continue;
    seen.add(entity.id);
    ids.push(entity.id);
  }
  return ids;
}

function upsertEntities<T extends { id: string }>(
  current: Readonly<Record<string, T>>,
  incoming: readonly T[],
): Record<string, T> {
  if (incoming.length === 0) return current as Record<string, T>;
  const next = { ...current };
  for (const entity of incoming) next[entity.id] = entity;
  return next;
}

function retainAccessibleThreads(
  state: ThreadNavigationState,
  allowedProjectIds: ReadonlySet<string>,
): Pick<ThreadNavigationState, 'threadsById' | 'threadIdsByProject' | 'threadTotalByProject'> {
  const threadIdsByProject = Object.fromEntries(
    Object.entries(state.threadIdsByProject).filter(([projectId]) =>
      allowedProjectIds.has(projectId),
    ),
  );
  const threadTotalByProject = Object.fromEntries(
    Object.entries(state.threadTotalByProject).filter(([projectId]) =>
      allowedProjectIds.has(projectId),
    ),
  );
  const retainedIds = new Set([
    ...Object.values(threadIdsByProject).flat(),
    ...state.scratchThreadIds,
    ...state.sharedThreadIds,
  ]);
  const threadsById = Object.fromEntries(
    Object.entries(state.threadsById).filter(([threadId]) => retainedIds.has(threadId)),
  );
  return { threadsById, threadIdsByProject, threadTotalByProject };
}

export interface ThreadNavigationState {
  projectsById: Record<string, Project>;
  projectIds: string[];
  threadsById: Record<string, Thread>;
  threadIdsByProject: Record<string, string[]>;
  threadTotalByProject: Record<string, number>;
  scratchThreadIds: string[];
  scratchThreadTotal: number;
  sharedThreadIds: string[];
  sharedThreadTotal: number;
  selectedProjectId: string | null;
  replaceProjects(projects: readonly Project[]): void;
  replaceProjectThreads(projectId: string, threads: readonly Thread[], total?: number): void;
  appendProjectThreads(projectId: string, threads: readonly Thread[], total?: number): void;
  replaceScratchThreads(threads: readonly Thread[], total?: number): void;
  replaceSharedThreads(threads: readonly Thread[], total?: number): void;
  patchThread(threadId: string, patch: Partial<Thread>): boolean;
  removeThread(threadId: string): void;
  selectProject(projectId: string | null): void;
  removeProtectedResources(): void;
}

export function createThreadNavigationStore(): StoreApi<ThreadNavigationState> {
  return createStore<ThreadNavigationState>((set, get) => ({
    projectsById: {},
    projectIds: [],
    threadsById: {},
    threadIdsByProject: {},
    threadTotalByProject: {},
    scratchThreadIds: [],
    scratchThreadTotal: 0,
    sharedThreadIds: [],
    sharedThreadTotal: 0,
    selectedProjectId: null,
    replaceProjects(projects) {
      const projectIds = uniqueEntityIds(projects);
      const projectsById = Object.fromEntries(projects.map((project) => [project.id, project]));
      const selected = get().selectedProjectId;
      const accessible = retainAccessibleThreads(get(), new Set(projectIds));
      set({
        ...accessible,
        projectsById,
        projectIds,
        selectedProjectId: selected && projectsById[selected] ? selected : null,
      });
    },
    replaceProjectThreads(projectId, threads, total) {
      const ids = uniqueEntityIds(threads);
      set((state) => ({
        threadsById: upsertEntities(state.threadsById, threads),
        threadIdsByProject: {
          ...state.threadIdsByProject,
          [projectId]: ids,
        },
        threadTotalByProject: { ...state.threadTotalByProject, [projectId]: total ?? ids.length },
      }));
    },
    appendProjectThreads(projectId, threads, total) {
      set((state) => {
        const current = state.threadIdsByProject[projectId] ?? [];
        const seen = new Set(current);
        const added = uniqueEntityIds(threads).filter((id) => !seen.has(id));
        return {
          threadsById: upsertEntities(state.threadsById, threads),
          threadIdsByProject: { ...state.threadIdsByProject, [projectId]: [...current, ...added] },
          threadTotalByProject: {
            ...state.threadTotalByProject,
            [projectId]:
              total ??
              Math.max(current.length + added.length, state.threadTotalByProject[projectId] ?? 0),
          },
        };
      });
    },
    replaceScratchThreads(threads, total) {
      const ids = uniqueEntityIds(threads);
      set((state) => ({
        threadsById: upsertEntities(state.threadsById, threads),
        scratchThreadIds: ids,
        scratchThreadTotal: total ?? ids.length,
      }));
    },
    replaceSharedThreads(threads, total) {
      const ids = uniqueEntityIds(threads);
      set((state) => ({
        threadsById: upsertEntities(state.threadsById, threads),
        sharedThreadIds: ids,
        sharedThreadTotal: total ?? ids.length,
      }));
    },
    patchThread(threadId, patch) {
      const current = get().threadsById[threadId];
      if (!current) return false;
      set((state) => ({
        threadsById: { ...state.threadsById, [threadId]: { ...current, ...patch } },
      }));
      return true;
    },
    removeThread(threadId) {
      set((state) => {
        if (!state.threadsById[threadId]) return {};
        const { [threadId]: _, ...threadsById } = state.threadsById;
        const threadIdsByProject = Object.fromEntries(
          Object.entries(state.threadIdsByProject).map(([projectId, ids]) => [
            projectId,
            ids.filter((id) => id !== threadId),
          ]),
        );
        return {
          threadsById,
          threadIdsByProject,
          scratchThreadIds: state.scratchThreadIds.filter((id) => id !== threadId),
          sharedThreadIds: state.sharedThreadIds.filter((id) => id !== threadId),
        };
      });
    },
    selectProject(selectedProjectId) {
      set({ selectedProjectId });
    },
    removeProtectedResources() {
      set({
        projectsById: {},
        projectIds: [],
        threadsById: {},
        threadIdsByProject: {},
        threadTotalByProject: {},
        scratchThreadIds: [],
        scratchThreadTotal: 0,
        sharedThreadIds: [],
        sharedThreadTotal: 0,
        selectedProjectId: null,
      });
    },
  }));
}
