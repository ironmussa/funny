import { create } from 'zustand';

import type { SerializedGraph, SubdomainType } from '@/types/domain';

interface DomainState {
  graph: SerializedGraph | null;
  selectedSubdomain: string | null;

  // Filters
  typeFilter: Set<SubdomainType>;
  subdomainFilter: Set<string>;

  // Actions
  setGraph: (graph: SerializedGraph) => void;
  selectSubdomain: (name: string | null) => void;
  toggleTypeFilter: (type: SubdomainType) => void;
  toggleSubdomainFilter: (name: string) => void;
  resetFilters: () => void;
}

const ALL_TYPES = new Set<SubdomainType>(['core', 'supporting', 'generic']);

export const useDomainStore = create<DomainState>((set) => ({
  graph: null,
  selectedSubdomain: null,
  typeFilter: new Set(ALL_TYPES),
  subdomainFilter: new Set(),

  setGraph: (graph) =>
    set({
      graph,
      selectedSubdomain: null,
      typeFilter: new Set(ALL_TYPES),
      subdomainFilter: new Set(Object.keys(graph.subdomains)),
    }),

  selectSubdomain: (name) => set({ selectedSubdomain: name }),

  toggleTypeFilter: (type) =>
    set((state) => {
      const next = new Set(state.typeFilter);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return { typeFilter: next };
    }),

  toggleSubdomainFilter: (name) =>
    set((state) => {
      const next = new Set(state.subdomainFilter);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return { subdomainFilter: next };
    }),

  resetFilters: () =>
    set((state) => ({
      typeFilter: new Set(ALL_TYPES),
      subdomainFilter: state.graph ? new Set(Object.keys(state.graph.subdomains)) : new Set(),
    })),
}));
