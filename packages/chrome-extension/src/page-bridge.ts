/**
 * Funny UI Annotator - Page Bridge
 *
 * Runs in the MAIN world (same JS context as the page).
 * This allows access to framework internals (React Fiber, Vue instances, etc.)
 * which are invisible from the content script's isolated world.
 *
 * Communicates with content.js via CustomEvents + DOM attributes.
 */

// Prevent double-injection
if (window.__funnyBridgeLoaded) {
  throw new Error('Funny Bridge already loaded');
}
window.__funnyBridgeLoaded = true;

console.log('[Funny Bridge] v2.2 loaded in MAIN world');

// -------------------------------------------------------------------------
// Framework detection
// -------------------------------------------------------------------------

function detectReact(): boolean {
  const ids = ['root', '__next', 'app', '__nuxt'];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (Object.keys(el).some((k) => k.indexOf('__react') === 0)) return true;
    if (el._reactRootContainer) return true;
  }
  const els = document.querySelectorAll('div, main, section, header, nav');
  for (let i = 0; i < Math.min(els.length, 30); i++) {
    if (Object.keys(els[i]).some((k) => k.indexOf('__react') === 0)) return true;
  }
  return false;
}

function detectVue(): { version: number | string } | null {
  // Vue 3: __vue_app__ on root element
  const ids = ['app', 'root', '__nuxt'];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el && el.__vue_app__) return { version: 3 };
  }
  // Vue 3 fallback: check elements for __vueParentComponent
  const els = document.querySelectorAll('div, main, section');
  for (let i = 0; i < Math.min(els.length, 20); i++) {
    if (els[i].__vueParentComponent) return { version: 3 };
  }
  // Vue 2: __vue__ on elements
  for (let i = 0; i < Math.min(els.length, 20); i++) {
    if (els[i].__vue__) return { version: 2 };
  }
  // Vue via global
  if (window.Vue) return { version: window.Vue.version ? parseInt(window.Vue.version) : 2 };
  if (window.__VUE__) return { version: 3 };
  return null;
}

function detectAngular(): { version: string } | null {
  // Angular 2+ via ng-version attribute
  const ngEl = document.querySelector('[ng-version]');
  if (ngEl) return { version: ngEl.getAttribute('ng-version')! };
  // Angular via __ngContext__
  const els = document.querySelectorAll('div, main, section, app-root');
  for (let i = 0; i < Math.min(els.length, 20); i++) {
    if (els[i].__ngContext__) return { version: 'detected' };
  }
  // AngularJS (1.x) via ng-app
  if (document.querySelector('[ng-app]') || window.angular) return { version: '1.x' };
  return null;
}

function detectSvelte(): boolean {
  const els = document.querySelectorAll('div, main, section');
  for (let i = 0; i < Math.min(els.length, 20); i++) {
    if (els[i].__svelte_meta) return true;
    // Svelte 5 uses $$ on component instances
    if (Object.keys(els[i]).some((k) => k.indexOf('__svelte') === 0)) return true;
  }
  return false;
}

function detectNextjs(): boolean {
  if (document.getElementById('__NEXT_DATA__')) return true;
  if (window.__NEXT_DATA__) return true;
  return false;
}

function detectNuxt(): boolean {
  if (window.__NUXT__) return true;
  if (document.getElementById('__nuxt') || document.getElementById('__NUXT__')) return true;
  return false;
}

document.addEventListener('__funny_detect_framework', () => {
  const frameworks: string[] = [];

  if (detectReact()) frameworks.push('React');
  const vue = detectVue();
  if (vue) frameworks.push('Vue ' + vue.version);
  const angular = detectAngular();
  if (angular) frameworks.push('Angular ' + angular.version);
  if (detectSvelte()) frameworks.push('Svelte');
  if (detectNextjs()) frameworks.push('Next.js');
  if (detectNuxt()) frameworks.push('Nuxt');

  const result = frameworks.join(', ');
  console.log('[Funny Bridge] Framework detect:', result || 'none');
  document.documentElement.setAttribute('data-funny-framework', result);
});

// Keep backward compat for detect_react event
document.addEventListener('__funny_detect_react', () => {
  const result = detectReact();
  document.documentElement.setAttribute('data-funny-react', result ? 'yes' : 'no');
});

// -------------------------------------------------------------------------
// Component info extraction (multi-framework)
// -------------------------------------------------------------------------
document.addEventListener('__funny_get_component_info', () => {
  const uid = document.documentElement.getAttribute('data-funny-target');
  if (!uid) return;

  const el = document.querySelector('[' + uid + ']');
  if (!el) return;

  let componentName = '';
  let componentTree = '';

  // --- React ---
  const reactKey = Object.keys(el).find(
    (k) => k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0,
  );
  if (reactKey) {
    const fiber = (el as any)[reactKey] as ReactFiber;
    // Component name
    let f: ReactFiber | null = fiber;
    while (f) {
      if (f.type && typeof f.type === 'function') {
        const n = (f.type as any).displayName || (f.type as any).name;
        if (n) {
          componentName = n;
          break;
        }
      }
      if (f.type && typeof f.type === 'object' && (f.type as any).displayName) {
        componentName = (f.type as any).displayName;
        break;
      }
      f = f.return;
    }
    // Component tree
    const names: string[] = [];
    f = fiber;
    while (f) {
      let name: string | null = null;
      if (f.type && typeof f.type === 'function')
        name = (f.type as any).displayName || (f.type as any).name;
      else if (f.type && typeof f.type === 'object') name = (f.type as any).displayName;
      if (name) names.push(name);
      f = f.return;
    }
    componentTree = names.reverse().join(' > ');
  }

  // --- Vue 3 ---
  if (!componentName && el.__vueParentComponent) {
    const inst = el.__vueParentComponent;
    componentName = inst.type?.name || inst.type?.__name || '';
    // Walk up parent chain for tree
    const names: string[] = [];
    let current: VueComponentInstance | null | undefined = inst;
    while (current) {
      const n = current.type?.name || current.type?.__name;
      if (n) names.push(n);
      current = current.parent;
    }
    componentTree = names.reverse().join(' > ');
  }

  // --- Vue 2 ---
  if (!componentName && el.__vue__) {
    const inst = el.__vue__;
    componentName = inst.$options?.name || inst.$options?._componentTag || '';
    const names: string[] = [];
    let current: Vue2Instance | null | undefined = inst;
    while (current) {
      const n = current.$options?.name || current.$options?._componentTag;
      if (n) names.push(n);
      current = current.$parent;
    }
    componentTree = names.reverse().join(' > ');
  }

  // --- Angular ---
  if (!componentName && el.__ngContext__) {
    // Angular stores component ref in the context array
    try {
      const ctx = el.__ngContext__;
      if (Array.isArray(ctx)) {
        for (let i = 0; i < ctx.length; i++) {
          const item = ctx[i] as any;
          if (
            item &&
            item.constructor &&
            item.constructor.name &&
            item.constructor.name !== 'Object' &&
            item.constructor.name !== 'Array'
          ) {
            componentName = item.constructor.name;
            break;
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  // --- Svelte ---
  if (!componentName) {
    const svelteKey = Object.keys(el).find((k) => k.indexOf('__svelte') === 0);
    if (svelteKey) {
      componentName = 'SvelteComponent';
      try {
        const meta = el.__svelte_meta;
        if (meta?.loc?.file) {
          componentName = meta.loc.file.split('/').pop()!.replace('.svelte', '');
        }
      } catch {
        /* ignore */
      }
    }
  }

  el.setAttribute('data-funny-component', componentName);
  el.setAttribute('data-funny-tree', componentTree);
});

// Keep backward compat
document.addEventListener('__funny_get_react_info', () => {
  document.dispatchEvent(new Event('__funny_get_component_info'));
});
