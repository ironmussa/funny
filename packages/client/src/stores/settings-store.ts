import type { ToolPermission, UserProfile } from '@funny/shared';
import { MODEL_REGISTRY } from '@funny/shared/models';
import { create } from 'zustand';

import { profileApi } from '@/lib/api/profile';
import { systemApi } from '@/lib/api/system';

export type { ToolPermission };
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

/**
 * Monospace code font size (px) — denser scale for inline code blocks in chat
 * (`WaitingCards`, prose code) and the `--code-font-size` var. NOT used by the
 * diff anymore — the diff aligns with the editor via `DIFF_FONT_SIZE_PX`.
 */
export const CODE_FONT_SIZE_PX: Record<FontSize, number> = {
  small: 11,
  default: 11,
  large: 13,
};

/** Monospace code row/line height (px) — for the dense CODE scale (chat code). */
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

/**
 * Diff font size (px) — aligned with the Monaco editor (`EDITOR_FONT_SIZE_PX`)
 * so the diff and the code editor share one baseline. Previously the diff used
 * the denser `CODE_FONT_SIZE_PX`; it now matches the editor on purpose.
 */
export const DIFF_FONT_SIZE_PX = EDITOR_FONT_SIZE_PX;

/**
 * Diff row/line height (px) — Monaco-style leading. Monaco derives its line
 * height as `round(GOLDEN_LINE_HEIGHT_RATIO × fontSize)`, where the ratio is 1.5
 * on Linux (the funny runner platform). These values mirror that for the editor
 * font sizes (12→18, 13→20, 15→23) so diff rows read the same as editor lines.
 */
export const DIFF_ROW_HEIGHT_PX: Record<FontSize, number> = {
  small: 18,
  default: 20,
  large: 23,
};

function getStoredFontSize(): FontSize {
  try {
    const stored = localStorage.getItem(FONT_SIZE_KEY);
    if (stored && stored in FONT_SIZE_VALUES) return stored as FontSize;
  } catch {}
  return 'default';
}

/**
 * Thread viewer engine — experimental. `virtual` is the current TanStack
 * Virtual renderer (`MemoizedMessageList`); `frozen` is the in-flow,
 * native-scroll frozen-message viewer. Client-only, localStorage-backed (no
 * server profile field): it's a rendering preference, not account state.
 */
export type ThreadViewer = 'virtual' | 'frozen';

const THREAD_VIEWER_KEY = 'funny_thread_viewer';
const THREAD_VIEWER_VALUES: readonly ThreadViewer[] = ['virtual', 'frozen'];

function getStoredThreadViewer(): ThreadViewer {
  try {
    const stored = localStorage.getItem(THREAD_VIEWER_KEY);
    if (stored && (THREAD_VIEWER_VALUES as readonly string[]).includes(stored)) {
      return stored as ThreadViewer;
    }
  } catch {}
  return 'virtual';
}

const NOTIFICATIONS_ENABLED_KEY = 'funny_notifications_enabled';
const NOTIFICATIONS_SOUND_KEY = 'funny_notifications_sound';
const HIDDEN_PROMPT_MODELS_KEY = 'funny_hidden_prompt_models';
const HIDDEN_PROMPT_MODELS_VERSION_KEY = 'funny_hidden_prompt_models_version';
const CURRENT_HIDDEN_MODELS_VERSION = '1';

function getStoredNotificationsEnabled(): boolean {
  try {
    return localStorage.getItem(NOTIFICATIONS_ENABLED_KEY) === '1';
  } catch {
    return false;
  }
}

function getStoredNotificationSoundEnabled(): boolean {
  try {
    return localStorage.getItem(NOTIFICATIONS_SOUND_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Default models shown in the dropdown on first run. Only essential models
 * are visible — users can enable more from Settings > Models.
 */
const DEFAULT_VISIBLE_MODELS = new Set([
  // Core Claude models (most common)
  'claude:haiku',
  'claude:sonnet',
  'claude:opus-4.8',
  // Dynamic provider defaults
  'pi:default',
  'cursor:default',
]);

/**
 * Compute all model keys from the registry as `provider:model` strings.
 */
function getAllModelKeys(): string[] {
  const keys: string[] = [];
  for (const [provider, models] of Object.entries(MODEL_REGISTRY)) {
    for (const modelKey of Object.keys(models)) {
      keys.push(`${provider}:${modelKey}`);
    }
  }
  return keys;
}

function getStoredHiddenPromptModels(): string[] {
  try {
    const raw = localStorage.getItem(HIDDEN_PROMPT_MODELS_KEY);
    const version = localStorage.getItem(HIDDEN_PROMPT_MODELS_VERSION_KEY);

    // If user has saved preferences AND they're on the current version, use those
    if (raw && version === CURRENT_HIDDEN_MODELS_VERSION) {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((value) => typeof value === 'string') : [];
    }

    // First run OR migration needed: hide all models except the default visible set
    const allModels = getAllModelKeys();
    const hiddenModels = allModels.filter((key) => !DEFAULT_VISIBLE_MODELS.has(key));
    // Persist the default so subsequent loads use it
    persistHiddenPromptModels(hiddenModels);
    try {
      localStorage.setItem(HIDDEN_PROMPT_MODELS_VERSION_KEY, CURRENT_HIDDEN_MODELS_VERSION);
    } catch {}
    return hiddenModels;
  } catch {
    return [];
  }
}

function persistHiddenPromptModels(hiddenPromptModels: string[]) {
  try {
    localStorage.setItem(HIDDEN_PROMPT_MODELS_KEY, JSON.stringify(hiddenPromptModels));
  } catch {}
}

function applyFontSize(size: FontSize) {
  document.documentElement.style.fontSize = FONT_SIZE_VALUES[size];
  // Diff vars track the editor-aligned scale; --code-font-size stays on the
  // denser CODE scale used by inline code blocks in chat (WaitingCards, prose).
  const diffPx = DIFF_FONT_SIZE_PX[size];
  const diffRowPx = DIFF_ROW_HEIGHT_PX[size];
  const codePx = CODE_FONT_SIZE_PX[size];
  document.documentElement.style.setProperty('--diff-font-size', `${diffPx}px`);
  document.documentElement.style.setProperty('--diff-row-height', `${diffRowPx}px`);
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
  notificationsEnabled: boolean;
  notificationSoundEnabled: boolean;
  /** `provider:model` keys hidden from the prompt input model picker. */
  hiddenPromptModels: string[];
  /** Experimental thread viewer engine (client-only, localStorage-backed). */
  threadViewer: ThreadViewer;
  _initialized: boolean;
  initializeFromProfile: (profile: UserProfile) => void;
  setDefaultEditor: (editor: Editor) => void;
  setUseInternalEditor: (use: boolean) => void;
  setTerminalShell: (shell: TerminalShell) => void;
  setFontSize: (size: FontSize) => void;
  setNotificationsEnabled: (enabled: boolean) => void;
  setNotificationSoundEnabled: (enabled: boolean) => void;
  setPromptModelVisible: (combinedKey: string, visible: boolean) => void;
  resetPromptModelVisibility: () => void;
  setThreadViewer: (viewer: ThreadViewer) => void;
  fetchAvailableShells: () => Promise<void>;
  setToolPermission: (toolName: string, permission: ToolPermission) => void;
  resetToolPermissions: () => void;
}

/** Save a partial settings update to the server (fire-and-forget). */
function syncToServer(data: Record<string, any>) {
  profileApi.updateProfile(data).match(
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
  notificationsEnabled: getStoredNotificationsEnabled(),
  notificationSoundEnabled: getStoredNotificationSoundEnabled(),
  hiddenPromptModels: getStoredHiddenPromptModels(),
  threadViewer: getStoredThreadViewer(),
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
  setThreadViewer: (viewer) => {
    set({ threadViewer: viewer });
    try {
      localStorage.setItem(THREAD_VIEWER_KEY, viewer);
    } catch {}
  },
  setNotificationsEnabled: (enabled) => {
    set({ notificationsEnabled: enabled });
    try {
      localStorage.setItem(NOTIFICATIONS_ENABLED_KEY, enabled ? '1' : '0');
    } catch {}
  },
  setNotificationSoundEnabled: (enabled) => {
    set({ notificationSoundEnabled: enabled });
    try {
      localStorage.setItem(NOTIFICATIONS_SOUND_KEY, enabled ? '1' : '0');
    } catch {}
  },
  setPromptModelVisible: (combinedKey, visible) =>
    set((state) => {
      const hidden = new Set(state.hiddenPromptModels);
      if (visible) hidden.delete(combinedKey);
      else hidden.add(combinedKey);
      const hiddenPromptModels = [...hidden];
      persistHiddenPromptModels(hiddenPromptModels);
      return { hiddenPromptModels };
    }),
  resetPromptModelVisibility: () => {
    // Reset to the default visible set (not all visible)
    const allModels = getAllModelKeys();
    const hiddenModels = allModels.filter((key) => !DEFAULT_VISIBLE_MODELS.has(key));
    persistHiddenPromptModels(hiddenModels);
    set({ hiddenPromptModels: hiddenModels });
  },
  fetchAvailableShells: async () => {
    if (get()._shellsLoaded) return;
    const result = await systemApi.getAvailableShells();
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
