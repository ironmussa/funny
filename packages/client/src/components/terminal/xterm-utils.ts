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

/**
 * Force a repaint of a terminal that is visible but whose renderer is stuck in
 * xterm's paused state.
 *
 * xterm pauses ALL rendering — buffering every `write()` — whenever its internal
 * IntersectionObserver reports the terminal's screen element as not intersecting
 * the viewport. That is the correct state for an inactive dockview tab, which is
 * hidden with `display:none`. Normally the observer fires again when the tab is
 * shown and the buffered rows flush, which is why switching tabs/threads makes
 * pending output suddenly appear.
 *
 * The problem (introduced with the WebGL renderer, commit c33eaada): after a
 * tab/thread switch the observer can be left holding a stale "not intersecting"
 * reading on a terminal that is actually on screen. While paused, `refreshRows`
 * (and therefore `terminal.refresh()`) is a no-op that only sets a pending-flush
 * flag — so live output and keystroke echo don't paint until the next layout
 * change forces the observer to re-fire.
 *
 * Driving the RenderService's own intersection handler with `isIntersecting:true`
 * clears `_isPaused` and flushes any buffered full refresh — the exact path xterm
 * takes when a hidden terminal becomes visible again. Reaching into internals is
 * a deliberate workaround for a third-party bug; every hop is optional-chained so
 * a future xterm rename degrades to a silent no-op instead of throwing.
 *
 * Caller MUST ensure the terminal is genuinely on screen (`offsetParent !== null`)
 * before calling — forcing a paint on a hidden terminal wastes work and is wrong.
 */
export function flushPausedRender(terminal: import('@xterm/xterm').Terminal): void {
  const renderService = (
    terminal as unknown as {
      _core?: {
        _renderService?: {
          _isPaused?: boolean;
          _handleIntersectionChange?: (e: {
            isIntersecting: boolean;
            intersectionRatio: number;
          }) => void;
        };
      };
    }
  )._core?._renderService;
  if (renderService?._isPaused && renderService._handleIntersectionChange) {
    renderService._handleIntersectionChange({ isIntersecting: true, intersectionRatio: 1 });
  }
}

export function repaintVisibleTerminal(
  terminal: import('@xterm/xterm').Terminal,
  container: HTMLElement | null,
): void {
  if (container?.offsetParent != null) {
    flushPausedRender(terminal);
  }
  terminal.refresh(0, terminal.rows - 1);
}

export function writeAndRepaintTerminal(
  terminal: import('@xterm/xterm').Terminal,
  data: string | Uint8Array,
  container: HTMLElement | null,
): void {
  terminal.write(data, () => {
    repaintVisibleTerminal(terminal, container);
  });
}

export const searchAddonRegistry = new Map<string, import('@xterm/addon-search').SearchAddon>();
export const terminalRegistry = new Map<string, import('@xterm/xterm').Terminal>();

/**
 * Trailing-edge debouncer for terminal fit() calls. Coalesces bursts of
 * ResizeObserver notifications — from dockview splitter drags, the browser
 * window resize, the bottom-panel expand transition, etc. — into a single
 * fit() once the size has settled.
 *
 * Why this matters: with the WebGL renderer, every fit() resizes the backing
 * canvas which clears the framebuffer for one frame, producing a visible
 * flicker. Resizes also trigger SIGWINCH on the PTY, which makes most shells
 * repaint the current line. At 60Hz both effects become a strobe.
 *
 * `delayMs` defaults to 100ms — long enough to absorb a frame storm or a
 * 200ms CSS transition, short enough to feel instantaneous on release.
 */
export function createResizeScheduler(fit: () => void, delayMs = 100) {
  let timer: number | null = null;
  return {
    schedule: () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        fit();
      }, delayMs);
    },
    dispose: () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    },
  };
}

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
