/**
 * Browser annotator panel state.
 *
 * Annotation / URL / tool state is ephemeral by design: cleared on panel close
 * and after a successful send. No DB or localStorage persistence for those.
 *
 * Persisted to localStorage (survive panel close + reload):
 *   - `browserPanelWidth` — user's preferred panel width
 *   - `defaultModel` — model the Send dialog opens with (set when the user
 *     last sent something; project is now derived from the project header
 *     where the panel was opened, so no defaultProjectId here)
 *   - `sentHistory` — last N sent threads (id / title / project / sentAt)
 *
 * Runtime log level override (DevTools console):
 *   __funnyLog.setNamespaceLevel('browser-panel', 'debug')
 *
 * Or via URL/localStorage key: `funny:log-ns:browser-panel` = 'debug' | 'info' | 'warn' | 'error'.
 */

import type { AnnotationDomInfo } from '@funny/shared/dom/extract';
import { create } from 'zustand';

import { createClientLogger } from '@/lib/client-logger';
import { metric } from '@/lib/telemetry';
/**
 * Captured DOM-element metadata returned by the runner's CDP inspect helpers,
 * or by the same-origin iframe path. Single source of truth lives in
 * `@funny/shared/dom/extract` so the runtime and client share the same shape.
 * Optional on annotations because (a) legacy iframe annotations don't have
 * this, (b) `elementFromPoint` can return null over blank regions.
 */
export type { AnnotationDomInfo };

export const DRAW_COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#ffffff'] as const;
export type DrawColor = (typeof DRAW_COLORS)[number];

export interface AnnotationRegionDom {
  rect: { x: number; y: number; w: number; h: number };
  elements: AnnotationDomInfo[];
}

export type Annotation =
  | { id: string; kind: 'pin'; x: number; y: number; note: string; dom?: AnnotationDomInfo }
  | {
      id: string;
      kind: 'region';
      x: number;
      y: number;
      w: number;
      h: number;
      note: string;
      dom?: AnnotationRegionDom;
    }
  | { id: string; kind: 'draw'; dataUrl: string; color: string; note: string };

export type AnnotationKind = Annotation['kind'];

/**
 * Distributive Omit — `Omit<Annotation, 'id'>` collapses the union to its
 * common keys; this preserves discrimination per variant.
 */
export type AnnotationInput = Annotation extends infer T
  ? T extends { id: string }
    ? Omit<T, 'id'>
    : never
  : never;

export type Tool = 'browse' | 'pin' | 'region' | 'draw';

export type SessionStatus =
  | 'idle' // No session
  | 'spawning' // Open request sent, waiting for `ready`
  | 'ready' // Receiving frames
  | 'disconnected' // Session ended (closed, error, runner restart)
  | 'too-many-sessions'; // Runner rejected — over the cap

export interface SentHistoryEntry {
  threadId: string;
  title: string;
  projectId: string;
  annotationCount: number;
  sentAt: number;
}

interface BrowserPanelState {
  open: boolean;
  url: string;
  loadedUrl: string | null;
  /**
   * User-facing message when the iframe fails to load (X-Frame-Options / CSP
   * blocking, or onload timeout). Cleared when a new URL is submitted or a
   * successful load fires.
   */
  loadError: string | null;
  tool: Tool;
  drawColor: string;
  annotations: Annotation[];
  drawCanvasRef: HTMLCanvasElement | null;
  /**
   * Whether annotation overlays (pin markers, region rectangles, draw canvas)
   * are visible. Data is preserved when off — only the visual layer hides.
   * Mirrors the extension's "Toggle annotation visibility" affordance.
   */
  overlaysVisible: boolean;

  /** Panel width in CSS pixels. Persisted to localStorage. */
  browserPanelWidth: number;
  /** Last-used model in the Send dialog. Persisted to localStorage. */
  defaultModel: string;
  /** Persisted ring buffer of recent sends. */
  sentHistory: SentHistoryEntry[];

  /**
   * Runner-managed browser session (CDP-streamed Chromium). Replaces the V1
   * iframe model. Null when the panel is closed or no URL has been loaded.
   */
  sessionId: string | null;
  sessionStatus: SessionStatus;
  /**
   * Set to a human-readable error message when the runner rejects open or
   * reports a fatal session error. Cleared on next successful open.
   */
  sessionError: string | null;

  // ── Feature toggles forwarded to the runner via CDP ─────────────────────
  /** Whether the test-id overlay is currently drawn. */
  showTestIds: boolean;
  /** Whether page animations are paused (CDP `Animations.disable` semantics). */
  animationsPaused: boolean;
  /** Whether the inspect-hover tool is active. Mutually exclusive with tools. */
  inspectActive: boolean;

  togglePanel: () => void;
  closePanel: () => void;
  setUrl: (url: string) => void;
  setLoadError: (msg: string | null) => void;
  setTool: (tool: Tool) => void;
  setDrawColor: (color: string) => void;
  addAnnotation: (a: AnnotationInput) => string;
  updateAnnotationNote: (id: string, note: string) => void;
  /** Attach (or replace) DOM-element metadata on a pin annotation. */
  updateAnnotationDom: (id: string, dom: AnnotationDomInfo | null) => void;
  /** Attach (or replace) DOM region metadata on a region annotation. */
  updateRegionDom: (id: string, dom: AnnotationRegionDom | null) => void;
  removeAnnotation: (id: string) => void;
  setDrawCanvasRef: (canvas: HTMLCanvasElement | null) => void;
  clearDraw: () => void;
  clearAllAnnotations: () => void;
  toggleOverlaysVisibility: () => void;
  setBrowserPanelWidth: (w: number) => void;
  setDefaultModel: (model: string) => void;
  recordSent: (entry: SentHistoryEntry) => void;
  clearSentHistory: () => void;

  /** Open or navigate the runner-managed browser session for this panel. */
  openBrowserSession: (url: string) => Promise<void>;
  /** Close the runner-managed session and free its resources. */
  closeBrowserSession: () => Promise<void>;
  setSessionStatus: (status: SessionStatus, error?: string | null) => void;
  toggleShowTestIds: () => void;
  toggleAnimationsPaused: () => void;
  toggleInspectActive: () => void;

  reset: () => void;
}

const WIDTH_KEY = 'browser_panel_width';
const DEFAULTS_KEY = 'browser_panel_defaults';
const HISTORY_KEY = 'browser_panel_history';
const DEFAULT_WIDTH = 480;
const MIN_WIDTH = 320;
const HISTORY_MAX = 20;

function readInitialWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    if (raw != null) {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n)) return Math.max(MIN_WIDTH, n);
    }
  } catch {
    /* localStorage unavailable */
  }
  return DEFAULT_WIDTH;
}

function readDefaults(): { defaultModel: string } {
  try {
    const raw = localStorage.getItem(DEFAULTS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<{ defaultModel: string }>;
      return {
        defaultModel: typeof parsed.defaultModel === 'string' ? parsed.defaultModel : 'sonnet',
      };
    }
  } catch {
    /* malformed — fall through */
  }
  return { defaultModel: 'sonnet' };
}

function writeDefaults(defaults: { defaultModel: string }) {
  try {
    localStorage.setItem(DEFAULTS_KEY, JSON.stringify(defaults));
  } catch {
    /* localStorage unavailable */
  }
}

function readHistory(): SentHistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .filter(
            (e): e is SentHistoryEntry =>
              e &&
              typeof e.threadId === 'string' &&
              typeof e.title === 'string' &&
              typeof e.projectId === 'string' &&
              typeof e.sentAt === 'number',
          )
          .slice(0, HISTORY_MAX);
      }
    }
  } catch {
    /* malformed — fall through */
  }
  return [];
}

function writeHistory(history: SentHistoryEntry[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, HISTORY_MAX)));
  } catch {
    /* localStorage unavailable */
  }
}

const log = createClientLogger('browser-panel');

const newId = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `bp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
};

const FRESH = {
  open: false,
  url: '',
  loadedUrl: null,
  loadError: null as string | null,
  tool: 'browse' as Tool,
  drawColor: DRAW_COLORS[0] as string,
  annotations: [] as Annotation[],
  drawCanvasRef: null as HTMLCanvasElement | null,
  overlaysVisible: true,
  sessionId: null as string | null,
  sessionStatus: 'idle' as SessionStatus,
  sessionError: null as string | null,
  showTestIds: false,
  animationsPaused: false,
  inspectActive: false,
};

const initialDefaults = readDefaults();

export const useBrowserPanelStore = create<BrowserPanelState>((set, get) => ({
  ...FRESH,
  browserPanelWidth: readInitialWidth(),
  defaultModel: initialDefaults.defaultModel,
  sentHistory: readHistory(),

  togglePanel: () => {
    const opening = !get().open;
    if (opening) {
      log.info('panel opened');
      metric('browser_panel.opened', 1, { type: 'sum' });
      set({ open: true });
    } else {
      // Closing the panel must tear down the runner session — frames keep
      // streaming otherwise and we leak a Chromium subprocess.
      void get().closeBrowserSession();
      set({ ...FRESH, open: false });
    }
  },

  closePanel: () => {
    void get().closeBrowserSession();
    set({ ...FRESH, open: false });
  },

  setUrl: (url) => set({ url }),

  setLoadError: (msg) => set({ loadError: msg }),

  setTool: (tool) => set({ tool }),

  setDrawColor: (drawColor) => set({ drawColor }),

  addAnnotation: (a) => {
    const id = newId();
    log.debug('annotation added', { kind: a.kind, id });
    metric('browser_panel.annotation_added', 1, {
      type: 'sum',
      attributes: { kind: a.kind },
    });
    set((state) => ({
      annotations: [...state.annotations, { ...a, id } as Annotation],
    }));
    return id;
  },

  updateAnnotationNote: (id, note) =>
    set((state) => ({
      annotations: state.annotations.map((a) => (a.id === id ? { ...a, note } : a)),
    })),

  updateAnnotationDom: (id, dom) =>
    set((state) => ({
      annotations: state.annotations.map((a) =>
        a.id === id && a.kind === 'pin' ? { ...a, dom: dom ?? undefined } : a,
      ),
    })),

  updateRegionDom: (id, dom) =>
    set((state) => ({
      annotations: state.annotations.map((a) =>
        a.id === id && a.kind === 'region' ? { ...a, dom: dom ?? undefined } : a,
      ),
    })),

  removeAnnotation: (id) =>
    set((state) => ({
      annotations: state.annotations.filter((a) => a.id !== id),
    })),

  setDrawCanvasRef: (canvas) => set({ drawCanvasRef: canvas }),

  clearDraw: () => {
    const canvas = get().drawCanvasRef;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
    set((state) => ({
      annotations: state.annotations.filter((a) => a.kind !== 'draw'),
    }));
  },

  clearAllAnnotations: () => {
    const canvas = get().drawCanvasRef;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
    log.info('clear all annotations');
    set({ annotations: [] });
  },

  toggleOverlaysVisibility: () => set((state) => ({ overlaysVisible: !state.overlaysVisible })),

  setBrowserPanelWidth: (w) => {
    const max = typeof window !== 'undefined' ? Math.floor(window.innerWidth * 0.8) : MIN_WIDTH * 4;
    const clamped = Math.max(MIN_WIDTH, Math.min(w, max));
    try {
      localStorage.setItem(WIDTH_KEY, String(clamped));
    } catch {
      /* localStorage unavailable */
    }
    set({ browserPanelWidth: clamped });
  },

  setDefaultModel: (model) => {
    writeDefaults({ defaultModel: model });
    set({ defaultModel: model });
  },

  recordSent: (entry) => {
    const next = [entry, ...get().sentHistory.filter((e) => e.threadId !== entry.threadId)].slice(
      0,
      HISTORY_MAX,
    );
    writeHistory(next);
    set({ sentHistory: next });
  },

  clearSentHistory: () => {
    writeHistory([]);
    set({ sentHistory: [] });
  },

  openBrowserSession: async (url: string) => {
    const state = get();
    // If we already have a session, just navigate it (the runner handles the
    // open→navigate fall-through too, but going through the dedicated client
    // method gives us cleaner WS traffic).
    if (state.sessionId && state.sessionStatus !== 'disconnected') {
      const { browserSessionClient } = await import('@/lib/browser-session-client');
      browserSessionClient.navigate(state.sessionId, url);
      set({ loadedUrl: url, loadError: null });
      return;
    }

    const sessionId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `bp-session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    set({
      sessionId,
      sessionStatus: 'spawning',
      sessionError: null,
      loadedUrl: url,
      loadError: null,
    });

    metric('browser_panel.url_loaded', 1, {
      type: 'sum',
      attributes: { protocol: url.split(':', 1)[0] || 'unknown' },
    });

    const { browserSessionClient } = await import('@/lib/browser-session-client');
    browserSessionClient.open(sessionId, url);
  },

  closeBrowserSession: async () => {
    const { sessionId } = get();
    if (!sessionId) return;
    const { browserSessionClient } = await import('@/lib/browser-session-client');
    const { clearLatestFrame } = await import('@/lib/browser-session-frames');
    browserSessionClient.close(sessionId, 'user');
    clearLatestFrame(sessionId);
    set({ sessionId: null, sessionStatus: 'idle', sessionError: null });
  },

  setSessionStatus: (status, error = null) =>
    set((state) => ({
      sessionStatus: status,
      sessionError: error ?? state.sessionError,
    })),

  toggleShowTestIds: () => set((state) => ({ showTestIds: !state.showTestIds })),

  toggleAnimationsPaused: () => {
    const next = !get().animationsPaused;
    set({ animationsPaused: next });

    const { sessionId } = get();
    if (!sessionId) return;
    void import('@/lib/browser-session-client').then(({ browserSessionClient }) => {
      browserSessionClient
        .execute(
          sessionId,
          next
            ? 'document.getAnimations().forEach(a => a.pause())'
            : 'document.getAnimations().forEach(a => a.play())',
        )
        .catch(() => {});
    });
  },

  toggleInspectActive: () => set((state) => ({ inspectActive: !state.inspectActive })),

  reset: () => set({ ...FRESH, open: false }),
}));
