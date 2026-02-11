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

export const ALL_STANDARD_TOOLS = [
  'Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep',
  'WebSearch', 'WebFetch', 'Task', 'TodoWrite', 'NotebookEdit',
] as const;

export const TOOL_LABELS: Record<string, string> = {
  Read: 'tools.readFile',
  Edit: 'tools.editFile',
  Write: 'tools.writeFile',
  Bash: 'tools.runCommand',
  Glob: 'tools.findFiles',
  Grep: 'tools.searchCode',
  WebSearch: 'tools.webSearch',
  WebFetch: 'tools.fetchUrl',
  Task: 'tools.subagent',
  TodoWrite: 'tools.todos',
  NotebookEdit: 'tools.editNotebook',
};

interface SettingsState {
  theme: Theme;
  defaultEditor: Editor;
  defaultThreadMode: ThreadMode;
  defaultPrompt: string;
  allowedTools: string[];
  setTheme: (theme: Theme) => void;
  setDefaultEditor: (editor: Editor) => void;
  setDefaultThreadMode: (mode: ThreadMode) => void;
  setDefaultPrompt: (prompt: string) => void;
  setAllowedTools: (tools: string[]) => void;
  toggleTool: (toolName: string) => void;
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
      allowedTools: [...ALL_STANDARD_TOOLS],
      setTheme: (theme) => {
        applyTheme(theme);
        set({ theme });
      },
      setDefaultEditor: (editor) => set({ defaultEditor: editor }),
      setDefaultThreadMode: (mode) => set({ defaultThreadMode: mode }),
      setDefaultPrompt: (prompt) => set({ defaultPrompt: prompt }),
      setAllowedTools: (tools) => set({ allowedTools: tools }),
      toggleTool: (toolName) => set((state) => ({
        allowedTools: state.allowedTools.includes(toolName)
          ? state.allowedTools.filter((t) => t !== toolName)
          : [...state.allowedTools, toolName],
      })),
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
