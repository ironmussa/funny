import { useCallback } from 'react';

import { usePreviewStore } from '@/stores/preview-store';

const isTauri = !!(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__;
const isPreviewWindow = !!(window as unknown as { __PREVIEW_MODE__: unknown }).__PREVIEW_MODE__;

async function tauriInvoke(cmd: string, args?: Record<string, unknown>) {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(cmd, args);
}

async function tauriEmit(event: string, payload: unknown) {
  const { emit } = await import('@tauri-apps/api/event');
  return emit(event, payload);
}

// Module-level listeners (only in the main window, not the preview window)
if (isTauri && !isPreviewWindow) {
  (async () => {
    const { listen, emit } = await import('@tauri-apps/api/event');

    // When the preview window signals it's ready, sync all current tabs
    await listen('preview:ready', () => {
      const store = usePreviewStore.getState();
      for (const tab of store.tabs) {
        emit('preview:add-tab', tab);
      }
    });

    // When the preview window closes a tab, update the main store
    await listen<{ commandId: string }>('preview:tab-closed', (e) => {
      const store = usePreviewStore.getState();
      store.removeTab(e.payload.commandId);
    });
  })();
}

export function usePreviewWindow() {
  const openPreview = useCallback(
    async (opts: { commandId: string; projectId: string; port: number; commandLabel: string }) => {
      // In browser mode, simply open a new tab with the localhost URL
      if (!isTauri) {
        window.open(`http://localhost:${opts.port}`, '_blank');
        return;
      }

      const store = usePreviewStore.getState();
      const tab = {
        commandId: opts.commandId,
        projectId: opts.projectId,
        port: opts.port,
        label: opts.commandLabel,
      };

      // Add to local store
      store.addTab(tab);

      // Open the preview window (or focus if already open)
      try {
        await tauriInvoke('open_preview');
      } catch (err) {
        console.error('[preview] Error opening preview window:', err);
        return;
      }

      // Emit event so the preview window adds the tab.
      // If the window was just created, the preview:ready handler will also sync,
      // but this handles the case where the window is already open.
      await tauriEmit('preview:add-tab', tab);
    },
    [],
  );

  const closePreview = useCallback(async (commandId: string) => {
    if (!isTauri) return;

    const store = usePreviewStore.getState();
    store.removeTab(commandId);

    // Tell the preview window to remove the tab
    await tauriEmit('preview:remove-tab', { commandId });
  }, []);

  const refreshPreview = useCallback(async (commandId: string) => {
    if (!isTauri) return;

    // Tell the preview window to refresh the tab's iframe
    await tauriEmit('preview:refresh-tab', { commandId });
  }, []);

  const closeAllForProject = useCallback(async (projectId: string) => {
    if (!isTauri) return;

    const store = usePreviewStore.getState();
    const toClose = store.tabs.filter((t) => t.projectId === projectId);

    for (const tab of toClose) {
      await tauriEmit('preview:remove-tab', { commandId: tab.commandId });
    }
    store.removeTabsForProject(projectId);
  }, []);

  return {
    openPreview,
    closePreview,
    refreshPreview,
    closeAllForProject,
    isTauri,
  };
}

/**
 * Module-level function for closing a preview tab outside React context.
 * Used by the WebSocket handler in use-ws.ts.
 */
export async function closePreviewForCommand(commandId: string) {
  if (!isTauri || isPreviewWindow) return;

  const store = usePreviewStore.getState();
  if (!store.hasTab(commandId)) return;

  store.removeTab(commandId);

  try {
    const { emit } = await import('@tauri-apps/api/event');
    await emit('preview:remove-tab', { commandId });
  } catch {
    /* ignore */
  }
}
