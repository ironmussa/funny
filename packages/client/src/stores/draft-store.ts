import { create } from 'zustand';
import type { ImageAttachment } from '@funny/shared';

interface ThreadDraft {
  prompt?: string;
  images?: ImageAttachment[];
  selectedFiles?: string[];
  commitTitle?: string;
  commitBody?: string;
}

interface DraftState {
  drafts: Record<string, ThreadDraft>;
  setPromptDraft: (threadId: string, prompt: string, images: ImageAttachment[], selectedFiles: string[]) => void;
  setCommitDraft: (threadId: string, title: string, body: string) => void;
  clearPromptDraft: (threadId: string) => void;
  clearCommitDraft: (threadId: string) => void;
}

export const useDraftStore = create<DraftState>((set, get) => ({
  drafts: {},

  setPromptDraft: (threadId, prompt, images, selectedFiles) => {
    // Only store if there's something worth saving
    if (!prompt && images.length === 0 && selectedFiles.length === 0) {
      // Clear prompt fields if nothing to save
      const { drafts } = get();
      const existing = drafts[threadId];
      if (!existing) return;
      const { prompt: _p, images: _i, selectedFiles: _s, ...rest } = existing;
      if (Object.keys(rest).length === 0) {
        const { [threadId]: _, ...remaining } = drafts;
        set({ drafts: remaining });
      } else {
        set({ drafts: { ...drafts, [threadId]: rest } });
      }
      return;
    }
    set(state => ({
      drafts: {
        ...state.drafts,
        [threadId]: { ...state.drafts[threadId], prompt, images, selectedFiles },
      },
    }));
  },

  setCommitDraft: (threadId, title, body) => {
    if (!title && !body) {
      const { drafts } = get();
      const existing = drafts[threadId];
      if (!existing) return;
      const { commitTitle: _t, commitBody: _b, ...rest } = existing;
      if (Object.keys(rest).length === 0) {
        const { [threadId]: _, ...remaining } = drafts;
        set({ drafts: remaining });
      } else {
        set({ drafts: { ...drafts, [threadId]: rest } });
      }
      return;
    }
    set(state => ({
      drafts: {
        ...state.drafts,
        [threadId]: { ...state.drafts[threadId], commitTitle: title, commitBody: body },
      },
    }));
  },

  clearPromptDraft: (threadId) => {
    const { drafts } = get();
    const existing = drafts[threadId];
    if (!existing) return;
    const { prompt: _p, images: _i, selectedFiles: _s, ...rest } = existing;
    if (Object.keys(rest).length === 0) {
      const { [threadId]: _, ...remaining } = drafts;
      set({ drafts: remaining });
    } else {
      set({ drafts: { ...drafts, [threadId]: rest } });
    }
  },

  clearCommitDraft: (threadId) => {
    const { drafts } = get();
    const existing = drafts[threadId];
    if (!existing) return;
    const { commitTitle: _t, commitBody: _b, ...rest } = existing;
    if (Object.keys(rest).length === 0) {
      const { [threadId]: _, ...remaining } = drafts;
      set({ drafts: remaining });
    } else {
      set({ drafts: { ...drafts, [threadId]: rest } });
    }
  },
}));
