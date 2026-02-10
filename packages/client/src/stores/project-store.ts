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
  deleteProject: (projectId: string) => Promise<void>;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  expandedProjects: new Set(),
  selectedProjectId: null,
  initialized: false,

  loadProjects: async () => {
    const projects = await api.listProjects();
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

  deleteProject: async (projectId) => {
    await api.deleteProject(projectId);
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
}));
