import { api } from '@/lib/api';
import { useSettingsStore, editorLabels } from '@/stores/settings-store';
import type { Editor } from '@/stores/settings-store';

/**
 * URI protocol schemes for each supported editor.
 * Editors without a URI scheme (sublime, vim) return null — use the server API fallback.
 */
const EDITOR_URI_SCHEMES: Record<Editor, string | null> = {
  vscode: 'vscode',
  cursor: 'cursor',
  windsurf: 'windsurf',
  zed: 'zed',
  sublime: null,
  vim: null,
};

/** Returns true if the editor supports a `scheme://file/...` URI protocol. */
export function hasEditorUri(editor?: Editor): boolean {
  const e = editor ?? useSettingsStore.getState().defaultEditor;
  return EDITOR_URI_SCHEMES[e] != null;
}

/**
 * Generate an editor URI for the given file path.
 * Returns `null` for editors without a URI scheme (sublime, vim),
 * or when the internal editor is enabled (so clicks go through openFileInEditor instead).
 */
export function toEditorUri(filePath: string, editor?: Editor): string | null {
  const { defaultEditor, useInternalEditor } = useSettingsStore.getState();
  if (useInternalEditor) return null;

  const e = editor ?? defaultEditor;
  const scheme = EDITOR_URI_SCHEMES[e];
  if (!scheme) return null;

  const normalized = filePath.replace(/\\/g, '/');
  const withLeadingSlash = normalized.startsWith('/') ? normalized : '/' + normalized;
  return `${scheme}://file${withLeadingSlash}`;
}

/**
 * Like `toEditorUri` but also handles `path:line` patterns
 * (e.g. `/src/file.ts:42`), appending `:line` to the URI.
 */
export function toEditorUriWithLine(filePath: string, editor?: Editor): string | null {
  const { defaultEditor, useInternalEditor } = useSettingsStore.getState();
  if (useInternalEditor) return null;

  const e = editor ?? defaultEditor;
  const scheme = EDITOR_URI_SCHEMES[e];
  if (!scheme) return null;

  const match = filePath.match(/^(.+):(\d+)$/);
  const path = match ? match[1] : filePath;
  const line = match ? match[2] : null;

  const normalized = path.replace(/\\/g, '/');
  const withLeadingSlash = normalized.startsWith('/') ? normalized : '/' + normalized;
  return `${scheme}://file${withLeadingSlash}${line ? ':' + line : ''}`;
}

/** Returns the human-readable label for the given (or default) editor. */
export function getEditorLabel(editor?: Editor): string {
  const e = editor ?? useSettingsStore.getState().defaultEditor;
  return editorLabels[e];
}

/**
 * Open a file in the user's preferred editor.
 * If useInternalEditor is enabled, opens in Monaco (browser).
 * Otherwise, opens in the external editor (URI protocol or server API).
 */
export function openFileInEditor(filePath: string, editor?: Editor): void {
  const { defaultEditor, useInternalEditor } = useSettingsStore.getState();

  // If internal editor is enabled, use Monaco
  if (useInternalEditor) {
    openFileInInternalEditor(filePath);
    return;
  }

  // Otherwise use external editor
  const e = editor ?? defaultEditor;
  const uri = toEditorUri(filePath, e);
  if (uri) {
    window.location.href = uri;
  } else {
    // Fallback to server API for vim/sublime
    api.openInEditor(filePath, e);
  }
}

/**
 * Open a directory/project in the external editor.
 * Always uses the external editor — the internal editor cannot open directories.
 */
export function openDirectoryInEditor(dirPath: string, editor?: Editor): void {
  const { defaultEditor } = useSettingsStore.getState();
  const e = editor ?? defaultEditor;
  const uri = toEditorUri(dirPath, e);
  if (uri) {
    window.location.href = uri;
  } else {
    api.openInEditor(dirPath, e);
  }
}

/**
 * Open a file in the internal Monaco editor.
 * Only call this when the user explicitly requests to use the internal editor.
 */
export function openFileInInternalEditor(filePath: string): void {
  // Dynamic import to avoid circular dependencies
  import('@/stores/internal-editor-store').then(({ useInternalEditorStore }) => {
    useInternalEditorStore.getState().openFile(filePath);
  });
}
