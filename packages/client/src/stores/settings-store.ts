import type { ToolPermission, UserProfile } from '@funny/shared';
import { create } from 'zustand';

import { api } from '@/lib/api';

export type Editor = 'cursor' | 'vscode' | 'windsurf' | 'zed' | 'sublime' | 'vim';
export type ThreadMode = 'local' | 'worktree';
export type ClaudeModel = 'haiku' | 'sonnet' | 'opus';
export type PermissionMode = 'plan' | 'autoEdit' | 'confirmEdit' | 'ask';
/** Shell ID — now dynamic, detected from the system. */
export type TerminalShell = string;

export interface DetectedShell {
  id: string;
  label: string;
  path: string;
}

const editorLabels: Record<Editor, string> = {
  cursor: 'Cursor',
  vscode: 'VS Code',
  windsurf: 'Windsurf',
  zed: 'Zed',
  sublime: 'Sublime Text',
  vim: 'Vim',
};

/** @deprecated Use availableShells from the store instead. Kept for backward compat. */
const shellLabels: Record<string, string> = {
  default: 'settings.shellDefault',
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
  terminalShell: TerminalShell;
  availableShells: DetectedShell[];
  _shellsLoaded: boolean;
  toolPermissions: Record<string, ToolPermission>;
  _initialized: boolean;
  initializeFromProfile: (profile: UserProfile) => void;
  setDefaultEditor: (editor: Editor) => void;
  setUseInternalEditor: (use: boolean) => void;
  setTerminalShell: (shell: TerminalShell) => void;
  fetchAvailableShells: () => Promise<void>;
  setToolPermission: (toolName: string, permission: ToolPermission) => void;
  resetToolPermissions: () => void;
}

/** Save a partial settings update to the server (fire-and-forget). */
function syncToServer(data: Record<string, any>) {
  api.updateProfile(data).match(
    () => {},
    () => {},
  );
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

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  defaultEditor: 'cursor',
  useInternalEditor: false,
  terminalShell: 'default' as TerminalShell,
  availableShells: [],
  _shellsLoaded: false,
  toolPermissions: { ...DEFAULT_TOOL_PERMISSIONS },
  _initialized: false,

  initializeFromProfile: (profile) => {
    set({
      defaultEditor: (profile.defaultEditor as Editor) ?? 'cursor',
      useInternalEditor: profile.useInternalEditor ?? false,
      terminalShell: (profile.terminalShell as TerminalShell) ?? 'default',
      toolPermissions: (profile.toolPermissions as Record<string, ToolPermission>) ?? {
        ...DEFAULT_TOOL_PERMISSIONS,
      },
      _initialized: true,
    });
  },

  setDefaultEditor: (editor) => {
    set({ defaultEditor: editor });
    syncToServer({ defaultEditor: editor });
  },
  setUseInternalEditor: (use) => {
    set({ useInternalEditor: use });
    syncToServer({ useInternalEditor: use });
  },
  setTerminalShell: (shell) => {
    set({ terminalShell: shell });
    syncToServer({ terminalShell: shell });
  },
  fetchAvailableShells: async () => {
    if (get()._shellsLoaded) return;
    const result = await api.getAvailableShells();
    if (result.isOk()) {
      set({ availableShells: result.value.shells, _shellsLoaded: true });
    }
  },
  setToolPermission: (toolName, permission) =>
    set((state) => {
      const toolPermissions = { ...state.toolPermissions, [toolName]: permission };
      syncToServer({ toolPermissions });
      return { toolPermissions };
    }),
  resetToolPermissions: () => {
    const toolPermissions = { ...DEFAULT_TOOL_PERMISSIONS };
    set({ toolPermissions });
    syncToServer({ toolPermissions });
  },
}));

export { editorLabels, shellLabels };
