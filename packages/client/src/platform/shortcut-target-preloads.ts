type LazyModule<T> = Promise<{ default: T }>;

export const preloadCommandPalette = () =>
  import('@/components/CommandPalette').then((module) => ({ default: module.CommandPalette }));

export const preloadFileSearchDialog = () =>
  import('@/components/FileSearchDialog').then((module) => ({ default: module.FileSearchDialog }));

export const preloadAllThreadsView = () =>
  import('@/components/AllThreadsView').then((module) => ({ default: module.AllThreadsView }));

export const preloadTextSearchDialog = () =>
  import('@/components/TextSearchDialog').then((module) => ({ default: module.TextSearchDialog }));

const shortcutTargetPreloads: Array<() => LazyModule<unknown>> = [
  preloadCommandPalette,
  preloadFileSearchDialog,
  preloadAllThreadsView,
  preloadTextSearchDialog,
];

let scheduled = false;

/**
 * Warm the lazy targets behind Ctrl+K, Ctrl+P, Ctrl+Shift+L, and Ctrl+Shift+F
 * without competing with the initial page load. Imports run sequentially so
 * their module evaluation does not create one large main-thread spike.
 */
export function scheduleShortcutTargetPreloads() {
  if (scheduled || typeof window === 'undefined') return;
  scheduled = true;

  const preloadWhenIdle = () => {
    const preload = () => {
      void (async () => {
        for (const load of shortcutTargetPreloads) {
          try {
            await load();
          } catch {
            // A failed speculative import must not surface as an unhandled
            // rejection. React.lazy will report a real failure if opened.
          }
        }
      })();
    };

    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(preload, { timeout: 2_000 });
    } else {
      setTimeout(preload, 2_000);
    }
  };

  if (document.readyState === 'complete') {
    preloadWhenIdle();
  } else {
    window.addEventListener('load', preloadWhenIdle, { once: true });
  }
}
