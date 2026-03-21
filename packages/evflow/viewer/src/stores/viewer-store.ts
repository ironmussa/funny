import { create } from 'zustand';

import type { EventModelData, ElementKind, SourceRef } from '../../../src/types';

interface ViewerState {
  /** Raw model data loaded from JSON */
  model: EventModelData | null;
  /** Currently selected node id */
  selectedNode: string | null;
  /** Currently selected edge id */
  selectedEdge: string | null;
  /** Active slice filter (null = show all) */
  activeSlice: string | null;
  /** Active kind filter (null = show all) */
  activeKind: ElementKind | null;
  /** Search query for filtering nodes */
  searchQuery: string;
  /** Active tab */
  activeTab: 'graph' | 'elements' | 'sequences';
  /** Source content for the currently selected node */
  sourceContent: string | null;
  /** Whether source content is being fetched */
  sourceLoading: boolean;
  /** Error from source fetching */
  sourceError: string | null;
  /** The source ref currently displayed */
  activeSource: SourceRef | null;
  /** Whether the source panel is open */
  sourcePanelOpen: boolean;

  // Actions
  setModel: (model: EventModelData) => void;
  setSelectedNode: (id: string | null) => void;
  setSelectedEdge: (id: string | null) => void;
  setActiveSlice: (slice: string | null) => void;
  setActiveKind: (kind: ElementKind | null) => void;
  setSearchQuery: (query: string) => void;
  setActiveTab: (tab: 'graph' | 'elements' | 'sequences') => void;
  setSourcePanelOpen: (open: boolean) => void;
  fetchSource: (source: SourceRef) => Promise<void>;
  reset: () => void;
}

export const useViewerStore = create<ViewerState>((set) => ({
  model: null,
  selectedNode: null,
  selectedEdge: null,
  activeSlice: null,
  activeKind: null,
  searchQuery: '',
  activeTab: 'graph',
  sourceContent: null,
  sourceLoading: false,
  sourceError: null,
  activeSource: null,
  sourcePanelOpen: false,

  setModel: (model) =>
    set({
      model,
      selectedNode: null,
      selectedEdge: null,
      activeSlice: null,
      activeKind: null,
      searchQuery: '',
      sourceContent: null,
      sourceLoading: false,
      sourceError: null,
      activeSource: null,
      sourcePanelOpen: false,
    }),
  setSelectedNode: (id) =>
    set({
      selectedNode: id,
      selectedEdge: null,
      sourceContent: null,
      sourceError: null,
      activeSource: null,
    }),
  setSelectedEdge: (id) => set({ selectedEdge: id, selectedNode: null }),
  setActiveSlice: (slice) => set({ activeSlice: slice }),
  setActiveKind: (kind) => set({ activeKind: kind }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setActiveTab: (tab) => set({ activeTab: tab }),
  setSourcePanelOpen: (open) => set({ sourcePanelOpen: open }),
  fetchSource: async (source) => {
    set({ sourceLoading: true, sourceError: null, activeSource: source });

    if (source.content) {
      set({ sourceContent: source.content, sourceLoading: false, sourcePanelOpen: true });
      return;
    }

    try {
      const res = await fetch(`/api/source?file=${encodeURIComponent(source.file)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(body.error || `Failed to fetch source: ${res.status}`);
      }
      const data = await res.json();
      set({ sourceContent: data.content, sourceLoading: false, sourcePanelOpen: true });
    } catch (err) {
      set({
        sourceError: err instanceof Error ? err.message : String(err),
        sourceContent: null,
        sourceLoading: false,
        sourcePanelOpen: true,
      });
    }
  },
  reset: () =>
    set({
      model: null,
      selectedNode: null,
      selectedEdge: null,
      activeSlice: null,
      activeKind: null,
      searchQuery: '',
      activeTab: 'graph',
      sourceContent: null,
      sourceLoading: false,
      sourceError: null,
      activeSource: null,
      sourcePanelOpen: false,
    }),
}));
