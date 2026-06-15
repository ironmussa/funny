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
  /**
   * Open a file handled by a `binary` visualizer (image, Parquet, …) WITHOUT
   * fetching its contents as text — that read would corrupt binary data. The
   * dialog renders the visualizer from the raw-bytes `src` URL instead, so
   * `initialContent` is left empty.
   */
  openBinaryFile: (path: string) => void;
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
  openBinaryFile: (path) => set({ isOpen: true, filePath: path, initialContent: '' }),
  closeEditor: () => set({ isOpen: false, filePath: null, initialContent: null }),
}));
