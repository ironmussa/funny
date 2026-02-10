import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'light' | 'dark' | 'system';
export type Editor = 'cursor' | 'vscode' | 'windsurf' | 'zed' | 'sublime' | 'vim';
export type ThreadMode = 'local' | 'worktree';

const editorLabels: Record<Editor, string> = {
  cursor: 'Cursor',
  vscode: 'VS Code',
  windsurf: 'Windsurf',
  zed: 'Zed',
  sublime: 'Sublime Text',
  vim: 'Vim',
};

interface SettingsState {
  theme: Theme;
  defaultEditor: Editor;
  defaultThreadMode: ThreadMode;
  defaultPrompt: string;
  setTheme: (theme: Theme) => void;
  setDefaultEditor: (editor: Editor) => void;
  setDefaultThreadMode: (mode: ThreadMode) => void;
  setDefaultPrompt: (prompt: string) => void;
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.classList.toggle('dark', prefersDark);
  } else {
    root.classList.toggle('dark', theme === 'dark');
  }
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: 'dark',
      defaultEditor: 'cursor',
      defaultThreadMode: 'worktree',
      defaultPrompt: '',
      setTheme: (theme) => {
        applyTheme(theme);
        set({ theme });
      },
      setDefaultEditor: (editor) => set({ defaultEditor: editor }),
      setDefaultThreadMode: (mode) => set({ defaultThreadMode: mode }),
      setDefaultPrompt: (prompt) => set({ defaultPrompt: prompt }),
    }),
    {
      name: 'a-parallel-settings',
      onRehydrateStorage: () => (state) => {
        if (state) {
          applyTheme(state.theme);
        }
      },
    }
  )
);

// Listen for system theme changes when in 'system' mode
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  const { theme } = useSettingsStore.getState();
  if (theme === 'system') {
    applyTheme('system');
  }
});

export { editorLabels };
