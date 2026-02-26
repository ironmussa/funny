import type { ToolPermission } from '@funny/shared';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Editor = 'cursor' | 'vscode' | 'windsurf' | 'zed' | 'sublime' | 'vim';
export type ThreadMode = 'local' | 'worktree';
export type ClaudeModel = 'haiku' | 'sonnet' | 'opus';
export type PermissionMode = 'plan' | 'autoEdit' | 'confirmEdit';

const editorLabels: Record<Editor, string> = {
  cursor: 'Cursor',
  vscode: 'VS Code',
  windsurf: 'Windsurf',
  zed: 'Zed',
  sublime: 'Sublime Text',
  vim: 'Vim',
};

export const ALL_STANDARD_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'Bash',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TodoWrite',
  'NotebookEdit',
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
  ALL_STANDARD_TOOLS.map((tool) => [tool, 'allow' as ToolPermission]),
);

interface SettingsState {
  defaultEditor: Editor;
  useInternalEditor: boolean;
  toolPermissions: Record<string, ToolPermission>;
  setupCompleted: boolean;
  setDefaultEditor: (editor: Editor) => void;
  setUseInternalEditor: (use: boolean) => void;
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

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      defaultEditor: 'cursor',
      useInternalEditor: false,
      toolPermissions: { ...DEFAULT_TOOL_PERMISSIONS },
      setupCompleted: false,
      setDefaultEditor: (editor) => set({ defaultEditor: editor }),
      setUseInternalEditor: (use) => set({ useInternalEditor: use }),
      setToolPermission: (toolName, permission) =>
        set((state) => ({
          toolPermissions: { ...state.toolPermissions, [toolName]: permission },
        })),
      resetToolPermissions: () => set({ toolPermissions: { ...DEFAULT_TOOL_PERMISSIONS } }),
      completeSetup: () => set({ setupCompleted: true }),
    }),
    {
      name: 'funny-settings',
      version: 7,
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
          persisted = { ...persisted, setupCompleted: true };
          version = 3;
        }
        if (version < 4) {
          persisted = {
            ...persisted,
            defaultModel: persisted.defaultModel ?? 'opus',
            defaultPermissionMode: persisted.defaultPermissionMode ?? 'autoEdit',
          };
          version = 4;
        }
        if (version < 5) {
          // Add default provider for existing users
          persisted = {
            ...persisted,
            defaultProvider: persisted.defaultProvider ?? 'claude',
          };
          version = 5;
        }
        if (version < 6) {
          // Migrate from 'internal' editor to useInternalEditor flag
          const wasInternal = persisted.defaultEditor === 'internal';
          persisted = {
            ...persisted,
            defaultEditor: wasInternal ? 'cursor' : persisted.defaultEditor,
            useInternalEditor: wasInternal ? true : (persisted.useInternalEditor ?? false),
          };
          version = 6;
        }
        if (version < 7) {
          // Theme moved to next-themes — remove from persisted state
          const { theme: _removed, setTheme: _removed2, ...rest } = persisted;
          return rest;
        }
        return persisted as any;
      },
    },
  ),
);

export { editorLabels };
