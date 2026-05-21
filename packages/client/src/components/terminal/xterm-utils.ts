import { useEffect, type RefObject } from 'react';

import { createClientLogger } from '@/lib/client-logger';
import { metric } from '@/lib/telemetry';

const log = createClientLogger('terminal/webgl');

export const isTauri = !!(window as unknown as { __TAURI_INTERNALS__: unknown })
  .__TAURI_INTERNALS__;

let xtermModulesPromise: Promise<{
  Terminal: typeof import('@xterm/xterm').Terminal;
  FitAddon: typeof import('@xterm/addon-fit').FitAddon;
  WebLinksAddon: typeof import('@xterm/addon-web-links').WebLinksAddon;
  SearchAddon: typeof import('@xterm/addon-search').SearchAddon;
  WebglAddon: typeof import('@xterm/addon-webgl').WebglAddon;
}> | null = null;

export function getXtermModules() {
  if (!xtermModulesPromise) {
    xtermModulesPromise = Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/addon-web-links'),
      import('@xterm/addon-search'),
      import('@xterm/addon-webgl'),
      // @ts-ignore - CSS import handled by Vite bundler
      import('@xterm/xterm/css/xterm.css'),
    ]).then(([xterm, fit, webLinks, search, webgl]) => ({
      Terminal: xterm.Terminal,
      FitAddon: fit.FitAddon,
      WebLinksAddon: webLinks.WebLinksAddon,
      SearchAddon: search.SearchAddon,
      WebglAddon: webgl.WebglAddon,
    }));
  }
  return xtermModulesPromise;
}

/**
 * Attach the WebGL renderer addon to a Terminal. Must be called AFTER
 * `terminal.open(container)` so the canvas exists.
 *
 * Falls back to the default DOM renderer silently on:
 *   - missing WebGL2 context (older GPUs / disabled in browser)
 *   - synchronous addon load failure
 *   - asynchronous WebGL context loss (e.g. GPU reset, tab moved between displays)
 *
 * Emits `terminal.renderer` metric with attribute `renderer = webgl | dom-fallback`
 * on initial attach, and `dom-fallback-context-lost` on later context loss.
 *
 * Returns the addon (or null when fallback was used) so the caller can
 * dispose it manually if needed — `terminal.dispose()` will also dispose it.
 */
export function attachWebglRenderer(
  terminal: import('@xterm/xterm').Terminal,
  WebglAddon: typeof import('@xterm/addon-webgl').WebglAddon,
): import('@xterm/addon-webgl').WebglAddon | null {
  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => {
      log.warn('WebGL context lost, falling back to DOM renderer');
      metric('terminal.renderer', 1, { attributes: { renderer: 'dom-fallback-context-lost' } });
      addon.dispose();
    });
    terminal.loadAddon(addon);
    metric('terminal.renderer', 1, { attributes: { renderer: 'webgl' } });
    return addon;
  } catch (err) {
    log.warn('WebGL renderer unavailable, using DOM renderer', {
      error: err instanceof Error ? err.message : String(err),
    });
    metric('terminal.renderer', 1, { attributes: { renderer: 'dom-fallback' } });
    return null;
  }
}

export const searchAddonRegistry = new Map<string, import('@xterm/addon-search').SearchAddon>();
export const terminalRegistry = new Map<string, import('@xterm/xterm').Terminal>();

if (!isTauri) getXtermModules();

export function getCssVar(name: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw ? `hsl(${raw})` : '#1b1b1b';
}

function getRawCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function getTerminalTheme() {
  return {
    background: getCssVar('--background'),
    foreground: getCssVar('--foreground'),
    cursor: getCssVar('--foreground'),
    selectionBackground: getRawCssVar('--terminal-selection') || '#264f78',
    scrollbarSliderBackground: `hsl(${getComputedStyle(document.documentElement).getPropertyValue('--muted-foreground').trim()} / 0.25)`,
    scrollbarSliderHoverBackground: `hsl(${getComputedStyle(document.documentElement).getPropertyValue('--muted-foreground').trim()} / 0.4)`,
    scrollbarSliderActiveBackground: `hsl(${getComputedStyle(document.documentElement).getPropertyValue('--muted-foreground').trim()} / 0.5)`,
    black: getRawCssVar('--terminal-black'),
    red: getRawCssVar('--terminal-red'),
    green: getRawCssVar('--terminal-green'),
    yellow: getRawCssVar('--terminal-yellow'),
    blue: getRawCssVar('--terminal-blue'),
    magenta: getRawCssVar('--terminal-magenta'),
    cyan: getRawCssVar('--terminal-cyan'),
    white: getRawCssVar('--terminal-white'),
    brightBlack: getRawCssVar('--terminal-bright-black'),
    brightRed: getRawCssVar('--terminal-bright-red'),
    brightGreen: getRawCssVar('--terminal-bright-green'),
    brightYellow: getRawCssVar('--terminal-bright-yellow'),
    brightBlue: getRawCssVar('--terminal-bright-blue'),
    brightMagenta: getRawCssVar('--terminal-bright-magenta'),
    brightCyan: getRawCssVar('--terminal-bright-cyan'),
    brightWhite: getRawCssVar('--terminal-bright-white'),
  };
}

export function useThemeSync(termRef: RefObject<{ terminal: any } | null>) {
  useEffect(() => {
    const applyTheme = () => {
      if (termRef.current?.terminal) {
        termRef.current.terminal.options.theme = getTerminalTheme();
      }
    };
    applyTheme();
    const observer = new MutationObserver(applyTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
    return () => observer.disconnect();
  }, [termRef]);
}
