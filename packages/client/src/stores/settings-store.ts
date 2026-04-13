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

export type FontSize = 'small' | 'default' | 'large';

const FONT_SIZE_KEY = 'funny_font_size';
const FONT_SIZE_VALUES: Record<FontSize, string> = {
  small: '13px',
  default: '14px',
  large: '16px',
};

/** Monospace code font size (px) — used for diffs (denser view). */
export const CODE_FONT_SIZE_PX: Record<FontSize, number> = {
  small: 11,
  default: 11,
  large: 13,
};

/** Monospace code row/line height (px) — for diffs. */
export const CODE_LINE_HEIGHT_PX: Record<FontSize, number> = {
  small: 20,
  default: 20,
  large: 24,
};

/** Editor/terminal font size (px) — used for Monaco editors and xterm terminals. */
export const EDITOR_FONT_SIZE_PX: Record<FontSize, number> = {
  small: 12,
  default: 13,
  large: 15,
};

/** Prose font size (px) — used for chat messages. */
export const PROSE_FONT_SIZE_PX: Record<FontSize, number> = {
  small: 13,
  default: 14,
  large: 16,
};

/** Prose line height (px) — leading-relaxed ratio ≈ 1.625×. */
export const PROSE_LINE_HEIGHT_PX: Record<FontSize, number> = {
  small: 21.1,
  default: 22.75,
  large: 26,
};

// Backwards-compatible aliases
export const DIFF_FONT_SIZE_PX = CODE_FONT_SIZE_PX;
export const DIFF_ROW_HEIGHT_PX = CODE_LINE_HEIGHT_PX;

function getStoredFontSize(): FontSize {
  try {
    const stored = localStorage.getItem(FONT_SIZE_KEY);
    if (stored && stored in FONT_SIZE_VALUES) return stored as FontSize;
  } catch {}
  return 'default';
}

function applyFontSize(size: FontSize) {
  document.documentElement.style.fontSize = FONT_SIZE_VALUES[size];
  const codePx = CODE_FONT_SIZE_PX[size];
  const codeRowPx = CODE_LINE_HEIGHT_PX[size];
  document.documentElement.style.setProperty('--diff-font-size', `${codePx}px`);
  document.documentElement.style.setProperty('--diff-row-height', `${codeRowPx}px`);
  document.documentElement.style.setProperty('--code-font-size', `${codePx}px`);
}

interface SettingsState {
  defaultEditor: Editor;
  useInternalEditor: boolean;
  terminalShell: TerminalShell;
  availableShells: DetectedShell[];
  _shellsLoaded: boolean;
  toolPermissions: Record<string, ToolPermission>;
  fontSize: FontSize;
  _initialized: boolean;
  initializeFromProfile: (profile: UserProfile) => void;
  setDefaultEditor: (editor: Editor) => void;
  setUseInternalEditor: (use: boolean) => void;
  setTerminalShell: (shell: TerminalShell) => void;
  setFontSize: (size: FontSize) => void;
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
  fontSize: getStoredFontSize(),
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
  setFontSize: (size) => {
    set({ fontSize: size });
    try {
      localStorage.setItem(FONT_SIZE_KEY, size);
    } catch {}
    applyFontSize(size);
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

// Apply stored font size on load
applyFontSize(useSettingsStore.getState().fontSize);

export { editorLabels, shellLabels };
