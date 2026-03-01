import type { ToolPermission, UserProfile } from '@funny/shared';
import { create } from 'zustand';

import { api } from '@/lib/api';

export type Editor = 'cursor' | 'vscode' | 'windsurf' | 'zed' | 'sublime' | 'vim';
export type ThreadMode = 'local' | 'worktree';
export type ClaudeModel = 'haiku' | 'sonnet' | 'opus';
export type PermissionMode = 'plan' | 'autoEdit' | 'confirmEdit' | 'ask';
export type TerminalShell = 'default' | 'git-bash' | 'powershell' | 'cmd' | 'wsl';

const editorLabels: Record<Editor, string> = {
  cursor: 'Cursor',
  vscode: 'VS Code',
  windsurf: 'Windsurf',
  zed: 'Zed',
  sublime: 'Sublime Text',
  vim: 'Vim',
};

const shellLabels: Record<TerminalShell, string> = {
  default: 'settings.shellDefault',
  'git-bash': 'Git Bash',
  powershell: 'PowerShell',
  cmd: 'CMD',
  wsl: 'WSL',
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
  toolPermissions: Record<string, ToolPermission>;
  _initialized: boolean;
  initializeFromProfile: (profile: UserProfile) => void;
  setDefaultEditor: (editor: Editor) => void;
  setUseInternalEditor: (use: boolean) => void;
  setTerminalShell: (shell: TerminalShell) => void;
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

export const useSettingsStore = create<SettingsState>()((set) => ({
  defaultEditor: 'cursor',
  useInternalEditor: false,
  terminalShell: 'git-bash' as TerminalShell,
  toolPermissions: { ...DEFAULT_TOOL_PERMISSIONS },
  _initialized: false,

  initializeFromProfile: (profile) => {
    set({
      defaultEditor: (profile.defaultEditor as Editor) ?? 'cursor',
      useInternalEditor: profile.useInternalEditor ?? false,
      terminalShell: (profile.terminalShell as TerminalShell) ?? 'git-bash',
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
