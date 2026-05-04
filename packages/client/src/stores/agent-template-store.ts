/**
 * Zustand store for Agent Templates (global, per-user).
 *
 * Templates are Deep Agent configurations that can be selected
 * when creating threads with the deepagent provider.
 */

import type {
  AgentTemplate,
  CreateAgentTemplateRequest,
  UpdateAgentTemplateRequest,
} from '@funny/shared';
import { BUILTIN_AGENT_TEMPLATES } from '@funny/shared';
import { create } from 'zustand';

import { agentTemplatesApi as api } from '@/lib/api/agent-templates';

interface AgentTemplateState {
  templates: AgentTemplate[];
  usageStats: Record<string, number>;
  initialized: boolean;

  loadTemplates: () => Promise<void>;
  loadUsageStats: () => Promise<void>;
  createTemplate: (data: CreateAgentTemplateRequest) => Promise<AgentTemplate | null>;
  updateTemplate: (id: string, data: UpdateAgentTemplateRequest) => Promise<AgentTemplate | null>;
  deleteTemplate: (id: string) => Promise<void>;
  duplicateTemplate: (id: string) => Promise<AgentTemplate | null>;
}

// Prevent concurrent loadTemplates calls
let _loadPromise: Promise<void> | null = null;

export const useAgentTemplateStore = create<AgentTemplateState>((set, get) => ({
  templates: [],
  usageStats: {},
  initialized: false,

  loadTemplates: async () => {
    if (_loadPromise) return _loadPromise;
    _loadPromise = (async () => {
      const result = await api.listAgentTemplates();
      if (result.isOk()) {
        // Merge builtin templates (at the end) with user templates (at the top)
        set({ templates: [...result.value, ...BUILTIN_AGENT_TEMPLATES], initialized: true });
      }
      _loadPromise = null;
    })();
    // Also load usage stats in parallel
    get().loadUsageStats();
    return _loadPromise;
  },

  loadUsageStats: async () => {
    const result = await api.getAgentTemplateUsageStats();
    if (result.isOk()) {
      set({ usageStats: result.value });
    }
  },

  createTemplate: async (data) => {
    const result = await api.createAgentTemplate(data);
    if (result.isErr()) return null;
    const template = result.value;
    set((state) => ({ templates: [template, ...state.templates] }));
    return template;
  },

  updateTemplate: async (id, data) => {
    const result = await api.updateAgentTemplate(id, data);
    if (result.isErr()) return null;
    const updated = result.value;
    set((state) => ({
      templates: state.templates.map((t) => (t.id === id ? updated : t)),
    }));
    return updated;
  },

  deleteTemplate: async (id) => {
    const result = await api.deleteAgentTemplate(id);
    if (result.isErr()) return;
    set((state) => ({
      templates: state.templates.filter((t) => t.id !== id),
    }));
  },

  duplicateTemplate: async (id) => {
    const result = await api.duplicateAgentTemplate(id);
    if (result.isErr()) return null;
    const template = result.value;
    set((state) => ({ templates: [template, ...state.templates] }));
    return template;
  },
}));
