import { toast } from 'sonner';
import { create } from 'zustand';

import { api } from '@/lib/api';

interface InternalEditorState {
  isOpen: boolean;
  filePath: string | null;
  initialContent: string | null;
  openFile: (path: string) => Promise<void>;
  closeEditor: () => void;
}

export const useInternalEditorStore = create<InternalEditorState>((set) => ({
  isOpen: false,
  filePath: null,
  initialContent: null,
  openFile: async (path) => {
    // Validate that the file exists and load content before opening the dialog
    const result = await api.readFile(path);
    if (result.isErr()) {
      toast.error('Failed to open file', {
        description: result.error.message,
      });
      return;
    }
    // Only open if the file exists and is readable
    set({ isOpen: true, filePath: path, initialContent: result.value.content });
  },
  closeEditor: () => set({ isOpen: false, filePath: null, initialContent: null }),
}));
