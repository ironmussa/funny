import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ToolPermission } from '@a-parallel/shared';

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

const DEFAULT_TOOL_PERMISSIONS: Record<string, ToolPermission> = Object.fromEntries(
  ALL_STANDARD_TOOLS.map(tool => [tool, 'allow' as ToolPermission])
);

interface SettingsState {
  theme: Theme;
  defaultEditor: Editor;
  defaultThreadMode: ThreadMode;
  toolPermissions: Record<string, ToolPermission>;
  setupCompleted: boolean;
  setTheme: (theme: Theme) => void;
  setDefaultEditor: (editor: Editor) => void;
  setDefaultThreadMode: (mode: ThreadMode) => void;
  setToolPermission: (toolName: string, permission: ToolPermission) => void;
  resetToolPermissions: () => void;
  completeSetup: () => void;
}

/** Derive allowedTools and disallowedTools arrays from the permissions record. */
export function deriveToolLists(permissions: Record<string, ToolPermission>): {
  allowedTools: string[];
  disallowedTools: string[];
} {
  const allowedTools: string[] = [];
  const disallowedTools: string[] = [];
  for (const [tool, perm] of Object.entries(permissions)) {
    if (perm === 'allow') allowedTools.push(tool);
    else if (perm === 'deny') disallowedTools.push(tool);
    // 'ask' tools go in neither list
  }
  return { allowedTools, disallowedTools };
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
      toolPermissions: { ...DEFAULT_TOOL_PERMISSIONS },
      setupCompleted: false,
      setTheme: (theme) => {
        applyTheme(theme);
        set({ theme });
      },
      setDefaultEditor: (editor) => set({ defaultEditor: editor }),
      setDefaultThreadMode: (mode) => set({ defaultThreadMode: mode }),
      setToolPermission: (toolName, permission) => set((state) => ({
        toolPermissions: { ...state.toolPermissions, [toolName]: permission },
      })),
      resetToolPermissions: () => set({ toolPermissions: { ...DEFAULT_TOOL_PERMISSIONS } }),
      completeSetup: () => set({ setupCompleted: true }),
    }),
    {
      name: 'a-parallel-settings',
      version: 3,
      migrate: (persisted: any, version: number) => {
        if (version < 2) {
          // Old format had allowedTools: string[]
          const oldAllowed: string[] = persisted.allowedTools ?? [...ALL_STANDARD_TOOLS];
          const toolPermissions: Record<string, ToolPermission> = {};
          for (const tool of ALL_STANDARD_TOOLS) {
            toolPermissions[tool] = oldAllowed.includes(tool) ? 'allow' : 'ask';
          }
          const { allowedTools: _removed, ...rest } = persisted;
          persisted = { ...rest, toolPermissions };
          version = 2;
        }
        if (version < 3) {
          // Existing users already have setup done — skip wizard
          return { ...persisted, setupCompleted: true };
        }
        return persisted as any;
      },
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
