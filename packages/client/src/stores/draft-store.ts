import type { ImageAttachment } from '@funny/shared';
import type { JSONContent } from '@tiptap/react';
import { create } from 'zustand';

interface ThreadDraft {
  /** @deprecated Legacy string-based prompt — kept for backward compat with existing drafts */
  prompt?: string;
  /** TipTap editor JSONContent for rich draft persistence */
  editorContent?: JSONContent;
  images?: ImageAttachment[];
  /** @deprecated File references are now inline in editorContent */
  selectedFiles?: string[];
  commitTitle?: string;
  commitBody?: string;
}

interface DraftState {
  drafts: Record<string, ThreadDraft>;
  /** Save TipTap editor content as draft */
  setEditorDraft: (threadId: string, editorContent: JSONContent, images: ImageAttachment[]) => void;
  /** @deprecated Legacy setter — kept for backward compat */
  setPromptDraft: (
    threadId: string,
    prompt: string,
    images: ImageAttachment[],
    selectedFiles: string[],
  ) => void;
  setCommitDraft: (threadId: string, title: string, body: string) => void;
  clearPromptDraft: (threadId: string) => void;
  clearCommitDraft: (threadId: string) => void;
}

/** Check if a TipTap JSONContent is effectively empty */
function isEditorContentEmpty(content: JSONContent): boolean {
  if (!content.content || content.content.length === 0) return true;
  // A doc with a single empty paragraph is considered empty
  if (
    content.content.length === 1 &&
    content.content[0].type === 'paragraph' &&
    (!content.content[0].content || content.content[0].content.length === 0)
  ) {
    return true;
  }
  return false;
}

export const useDraftStore = create<DraftState>((set, get) => ({
  drafts: {},

  setEditorDraft: (threadId, editorContent, images) => {
    const isEmpty = isEditorContentEmpty(editorContent) && images.length === 0;
    if (isEmpty) {
      // Clear editor fields if nothing to save
      const { drafts } = get();
      const existing = drafts[threadId];
      if (!existing) return;
      const { prompt: _p, editorContent: _e, images: _i, selectedFiles: _s, ...rest } = existing;
      if (Object.keys(rest).length === 0) {
        const { [threadId]: _, ...remaining } = drafts;
        set({ drafts: remaining });
      } else {
        set({ drafts: { ...drafts, [threadId]: rest } });
      }
      return;
    }
    set((state) => ({
      drafts: {
        ...state.drafts,
        [threadId]: {
          ...state.drafts[threadId],
          editorContent,
          images,
          prompt: undefined,
          selectedFiles: undefined,
        },
      },
    }));
  },

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
    set((state) => ({
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
    set((state) => ({
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
    const { prompt: _p, editorContent: _e, images: _i, selectedFiles: _s, ...rest } = existing;
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
