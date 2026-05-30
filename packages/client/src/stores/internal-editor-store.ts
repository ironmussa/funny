import { toast } from 'sonner';
import { create } from 'zustand';

import { systemApi } from '@/lib/api/system';

interface OpenFileOptions {
  /** Used when the file does not exist yet (e.g. first-time ~/.claude/settings.json). */
  defaultContent?: string;
  ifNotFound?: (message: string) => boolean;
}

interface InternalEditorState {
  isOpen: boolean;
  filePath: string | null;
  initialContent: string | null;
  openFile: (path: string, options?: OpenFileOptions) => Promise<void>;
  closeEditor: () => void;
}

export const useInternalEditorStore = create<InternalEditorState>((set) => ({
  isOpen: false,
  filePath: null,
  initialContent: null,
  openFile: async (path, options) => {
    const result = await systemApi.readFile(path);
    if (result.isOk()) {
      set({ isOpen: true, filePath: path, initialContent: result.value.content });
      return;
    }

    if (options?.defaultContent && options.ifNotFound?.(result.error.message)) {
      set({ isOpen: true, filePath: path, initialContent: options.defaultContent });
      return;
    }

    toast.error('Failed to open file', {
      description: result.error.message,
    });
  },
  closeEditor: () => set({ isOpen: false, filePath: null, initialContent: null }),
}));
