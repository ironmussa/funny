import type { Arc } from '@funny/shared';
import { create } from 'zustand';

import { api } from '@/lib/api';

interface ArcState {
  arcsByProject: Record<string, Arc[]>;

  loadArcs: (projectId: string) => Promise<void>;
  createArc: (projectId: string, name: string) => Promise<Arc | null>;
  deleteArc: (id: string, projectId: string) => Promise<void>;
}

export const useArcStore = create<ArcState>((set, get) => ({
  arcsByProject: {},

  loadArcs: async (projectId) => {
    const result = await api.listArcs(projectId);
    result.match(
      (arcs) => {
        set((state) => ({
          arcsByProject: { ...state.arcsByProject, [projectId]: arcs },
        }));
      },
      (error) => console.error('[arc-store] Failed to load arcs:', error.message),
    );
  },

  createArc: async (projectId, name) => {
    const result = await api.createArc(projectId, name);
    return result.match(
      (arc) => {
        // Also create the directory on the filesystem
        api.createArcDirectory(projectId, name).match(
          () => {},
          (err) => console.warn('[arc-store] Failed to create arc directory:', err.message),
        );
        // Refresh the list
        get().loadArcs(projectId);
        return arc;
      },
      (error) => {
        console.error('[arc-store] Failed to create arc:', error.message);
        return null;
      },
    );
  },

  deleteArc: async (id, projectId) => {
    const result = await api.deleteArc(id);
    result.match(
      () => get().loadArcs(projectId),
      (error) => console.error('[arc-store] Failed to delete arc:', error.message),
    );
  },
}));
