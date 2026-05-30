import { toast } from 'sonner';

import { api } from '@/lib/api';
import { useInternalEditorStore } from '@/stores/internal-editor-store';

/** Default snippet when ~/.claude/settings.json does not exist yet. */
export const CLAUDE_SETTINGS_DEFAULT = `${JSON.stringify(
  {
    env: {
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    },
  },
  null,
  2,
)}\n`;

export function claudeSettingsPathFromHome(home: string): string {
  const trimmed = home.replace(/[/\\]+$/, '');
  const sep = trimmed.includes('\\') ? '\\' : '/';
  return `${trimmed}${sep}.claude${sep}settings.json`;
}

function isNotFoundError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('not found') || lower.includes('enoent');
}

/** Opens ~/.claude/settings.json in the global Monaco editor dialog. */
export async function openClaudeSettingsInEditor(): Promise<void> {
  const roots = await api.browseRoots();
  if (roots.isErr()) {
    toast.error('Failed to open Claude settings', { description: roots.error.message });
    return;
  }

  const path = claudeSettingsPathFromHome(roots.value.home);
  await useInternalEditorStore.getState().openFile(path, {
    defaultContent: CLAUDE_SETTINGS_DEFAULT,
    ifNotFound: isNotFoundError,
  });
}
