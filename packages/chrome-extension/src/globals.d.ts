/**
 * Type declarations for Chrome extension globals.
 *
 * Covers window properties set by content.js / page-bridge.js
 * and framework-specific element properties accessed at runtime.
 */

// ---------------------------------------------------------------------------
// Window extensions (set by content.js and page-bridge.js)
// ---------------------------------------------------------------------------
interface Window {
  __funnyAnnotatorActive?: boolean;
  __funnyBridgeInjected?: boolean;
  __funnyBridgeLoaded?: boolean;

  // Framework globals accessed by page-bridge.js
  Vue?: { version?: string };
  angular?: unknown;
  __VUE__?: unknown;
  __NUXT__?: unknown;
  __NEXT_DATA__?: unknown;
}

// ---------------------------------------------------------------------------
// Framework-specific element properties (accessed via Object.keys / direct access)
// ---------------------------------------------------------------------------
interface Element {
  // React Fiber
  [key: `__reactFiber$${string}`]: ReactFiber | undefined;
  [key: `__reactInternalInstance$${string}`]: ReactFiber | undefined;
  _reactRootContainer?: unknown;

  // Vue 3
  __vue_app__?: unknown;
  __vueParentComponent?: VueComponentInstance | undefined;

  // Vue 2
  __vue__?: Vue2Instance | undefined;

  // Angular
  __ngContext__?: unknown[];

  // Svelte
  __svelte_meta?: { loc?: { file?: string } };
  [key: `__svelte${string}`]: unknown;
}

// ---------------------------------------------------------------------------
// React Fiber (minimal shape for tree walking)
// ---------------------------------------------------------------------------
interface ReactFiber {
  type:
    | (((...args: unknown[]) => unknown) & { displayName?: string; name?: string })
    | { displayName?: string }
    | string
    | null;
  return: ReactFiber | null;
}

// ---------------------------------------------------------------------------
// Vue component instances (minimal shapes)
// ---------------------------------------------------------------------------
interface VueComponentInstance {
  type?: { name?: string; __name?: string };
  parent?: VueComponentInstance | null;
}

interface Vue2Instance {
  $options?: { name?: string; _componentTag?: string };
  $parent?: Vue2Instance | null;
}
