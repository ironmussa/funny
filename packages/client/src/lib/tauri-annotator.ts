/**
 * Tauri-only helper for the annotator window.
 *
 * The annotator opens a separate Tauri webview at the target URL with a
 * content script pre-injected. Because the script runs in the page's own
 * document (not in an iframe), it has full DOM access on any origin — the
 * same model as a Chrome extension content script.
 *
 * In browser/dev mode (no Tauri runtime), `isTauriAnnotatorAvailable()`
 * returns false and the UI should hide the entry point.
 */

const isTauri = !!(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__;

export function isTauriAnnotatorAvailable(): boolean {
  return isTauri;
}

export async function openAnnotator(url: string): Promise<void> {
  if (!isTauri) {
    throw new Error('Annotator requires the Tauri desktop app');
  }
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('open_annotator', { url });
}

export async function closeAnnotator(): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('close_annotator');
}
