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

import {
  threadBrowserSessionId,
  type BrowserSessionController,
  type WSBrowserSessionDialogData,
} from '@funny/shared';
import type { AnnotationDomInfo } from '@funny/shared/dom/extract';
import { create } from 'zustand';

import {
  BROWSER_SESSION_VIEWPORT_HEIGHT,
  BROWSER_SESSION_VIEWPORT_WIDTH,
} from '@/lib/browser-session-viewport';
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

/**
 * Distributive Omit — `Omit<Annotation, 'id'>` collapses the union to its
 * common keys; this preserves discrimination per variant.
 */
type AnnotationInput = Annotation extends infer T
  ? T extends { id: string }
    ? Omit<T, 'id'>
    : never
  : never;

export type Tool = 'browse' | 'pin' | 'region' | 'draw';

type BrowserSessionDialog = NonNullable<WSBrowserSessionDialogData['dialog']>;

type SessionStatus =
  | 'idle' // No session
  | 'spawning' // Open request sent, waiting for `ready`
  | 'ready' // Receiving frames
  | 'disconnected' // Session ended (closed, error, runner restart)
  | 'too-many-sessions'; // Runner rejected — over the cap

interface SentHistoryEntry {
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
  /**
   * Thread the session is bound to (`thread:<id>` session ids). Thread-bound
   * sessions are shared with the agent: closing the panel only detaches.
   */
  sessionThreadId: string | null;
  /** Page viewport of the session — input and overlays scale to it. */
  viewport: { width: number; height: number };
  /** Who drives a thread-bound session: the agent, or the user after "Take over". */
  controller: BrowserSessionController;
  /** JavaScript dialog waiting for an answer (the page is frozen meanwhile). */
  dialog: BrowserSessionDialog | null;
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
  annotationMode: boolean;
  setAnnotationMode: (active: boolean) => void;
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
  /** Close a thread-bound session for good (not just detach). */
  endBrowserSession: () => Promise<void>;
  /** Re-attach to (or detect) the browser session of a thread. */
  attachThreadSession: (threadId: string) => Promise<void>;
  /** Follow the active thread: detach from another thread's session, attach to this one's. */
  syncActiveThread: (threadId: string | null) => void;
  /** An agent opened its thread's session — surface it if that thread is active. */
  handleAgentOpened: (sessionId: string, threadId: string, activeThreadId: string | null) => void;
  setSessionViewport: (sessionId: string, width: number, height: number) => void;
  /** The runner has no session for an attach attempt. */
  handleSessionNotFound: (sessionId: string) => void;
  /** Close every session and delete the persistent browser profile on the runner. */
  clearBrowserProfile: () => Promise<void>;
  setSessionController: (sessionId: string, controller: BrowserSessionController) => void;
  setSessionDialog: (sessionId: string, dialog: BrowserSessionDialog | null) => void;
  /** Take the session over from the agent (or hand it back with `false`). */
  setUserControl: (userControls: boolean) => Promise<void>;
  /** Answer the pending dialog from the panel. */
  answerDialog: (accept: boolean, promptText?: string) => Promise<void>;
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
  annotationMode: false,
  tool: 'browse' as Tool,
  drawColor: DRAW_COLORS[0] as string,
  annotations: [] as Annotation[],
  drawCanvasRef: null as HTMLCanvasElement | null,
  overlaysVisible: true,
  sessionId: null as string | null,
  sessionThreadId: null as string | null,
  viewport: { width: BROWSER_SESSION_VIEWPORT_WIDTH, height: BROWSER_SESSION_VIEWPORT_HEIGHT },
  controller: 'agent' as BrowserSessionController,
  dialog: null as BrowserSessionDialog | null,
  sessionStatus: 'idle' as SessionStatus,
  sessionError: null as string | null,
  showTestIds: false,
  animationsPaused: false,
  inspectActive: false,
};

const initialDefaults = readDefaults();

/** Session fields reset when the panel lets go of a session. */
const DETACHED = {
  annotationMode: false,
  tool: 'browse' as Tool,
  inspectActive: false,
  showTestIds: false,
  sessionId: null as string | null,
  sessionThreadId: null as string | null,
  sessionStatus: 'idle' as SessionStatus,
  sessionError: null as string | null,
  viewport: { width: BROWSER_SESSION_VIEWPORT_WIDTH, height: BROWSER_SESSION_VIEWPORT_HEIGHT },
};

// Lazy-loaded so the panel's transport code stays out of the initial bundle;
// cached so every action shares one module instance.
let clientModule: Promise<typeof import('@/lib/browser-session-client')> | null = null;
let framesModule: Promise<typeof import('@/lib/browser-session-frames')> | null = null;
const loadClient = () => (clientModule ??= import('@/lib/browser-session-client'));
const loadFrames = () => (framesModule ??= import('@/lib/browser-session-frames'));

/** Tell the runner to close or detach a session and drop its cached frame. */
async function releaseSession(sessionId: string, reason: 'user' | 'detach'): Promise<void> {
  const [{ browserSessionClient }, { clearLatestFrame }] = await Promise.all([
    loadClient(),
    loadFrames(),
  ]);
  browserSessionClient.close(sessionId, reason);
  clearLatestFrame(sessionId);
}

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
      // Closing the panel tears down a panel-owned session (frames keep
      // streaming otherwise) and detaches from a thread-bound one.
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

  setAnnotationMode: (active) => {
    const state = get();
    if (
      active &&
      (!state.sessionId ||
        state.sessionStatus !== 'ready' ||
        (state.sessionThreadId && state.controller !== 'user'))
    )
      return;
    if (!active && state.animationsPaused) state.toggleAnimationsPaused();
    set({
      annotationMode: active,
      tool: 'browse',
      inspectActive: false,
      showTestIds: false,
      ...(active ? { overlaysVisible: true } : {}),
    });
  },

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
      const { browserSessionClient } = await loadClient();
      browserSessionClient.navigate(state.sessionId, url);
      set({ loadedUrl: url, loadError: null });
      return;
    }

    // On a thread, the session is the thread's — shared with its agent.
    const { getUrlThreadId } = await import('@/stores/thread-store');
    const threadId = getUrlThreadId();
    const sessionId = threadId
      ? threadBrowserSessionId(threadId)
      : typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `bp-session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    set({
      sessionId,
      sessionThreadId: threadId,
      sessionStatus: 'spawning',
      sessionError: null,
      loadedUrl: url,
      loadError: null,
    });

    metric('browser_panel.url_loaded', 1, {
      type: 'sum',
      attributes: { protocol: url.split(':', 1)[0] || 'unknown' },
    });

    const { browserSessionClient } = await loadClient();
    browserSessionClient.open(sessionId, url);
  },

  closeBrowserSession: async () => {
    const { sessionId, sessionThreadId } = get();
    if (!sessionId) return;
    await releaseSession(sessionId, sessionThreadId ? 'detach' : 'user');
    set({ ...DETACHED });
  },

  endBrowserSession: async () => {
    const { sessionId } = get();
    if (!sessionId) return;
    await releaseSession(sessionId, 'user');
    set({ ...DETACHED, url: '', loadedUrl: null });
  },

  attachThreadSession: async (threadId) => {
    const sessionId = threadBrowserSessionId(threadId);
    // Controller and dialog start from defaults; `ready` restates the real ones.
    set({
      sessionId,
      sessionThreadId: threadId,
      sessionStatus: 'spawning',
      sessionError: null,
      annotationMode: false,
      tool: 'browse',
      inspectActive: false,
      showTestIds: false,
      controller: 'agent',
      dialog: null,
    });
    const { browserSessionClient } = await loadClient();
    // Empty URL = attach only: the runner re-sends `ready` or replies `not_found`.
    browserSessionClient.open(sessionId, '');
  },

  syncActiveThread: (threadId) => {
    const state = get();
    if (!state.open) return;
    if (state.sessionThreadId && state.sessionThreadId !== threadId && state.sessionId) {
      void releaseSession(state.sessionId, 'detach');
      set({ ...DETACHED, url: '', loadedUrl: null });
    }
    if (threadId && !get().sessionId) void get().attachThreadSession(threadId);
  },

  handleAgentOpened: (sessionId, threadId, activeThreadId) => {
    if (threadId !== activeThreadId) return;
    const state = get();
    if (state.sessionId === sessionId) return;
    if (state.sessionId) {
      void releaseSession(state.sessionId, state.sessionThreadId ? 'detach' : 'user');
    }
    log.info('agent opened browser on active thread — attaching', { threadId });
    set({ ...DETACHED, open: true });
    void get().attachThreadSession(threadId);
  },

  setSessionViewport: (sessionId, width, height) => {
    if (get().sessionId !== sessionId) return;
    set({ viewport: { width, height } });
  },

  handleSessionNotFound: (sessionId) => {
    if (get().sessionId !== sessionId) return;
    set({ ...DETACHED });
  },

  setSessionController: (sessionId, controller) => {
    if (get().sessionId !== sessionId) return;
    if (controller !== 'user') get().setAnnotationMode(false);
    set({ controller });
  },

  setSessionDialog: (sessionId, dialog) => {
    if (get().sessionId !== sessionId) return;
    set({ dialog });
  },

  setUserControl: async (userControls) => {
    const { sessionId } = get();
    if (!sessionId) return;
    const { browserSessionClient } = await loadClient();
    if (!userControls) get().setAnnotationMode(false);
    browserSessionClient.input(sessionId, {
      kind: userControls ? 'takeControl' : 'releaseControl',
    });
    metric('browser_panel.control_changed', 1, {
      type: 'sum',
      attributes: { controller: userControls ? 'user' : 'agent' },
    });
  },

  answerDialog: async (accept, promptText) => {
    const { sessionId } = get();
    if (!sessionId) return;
    const { browserSessionClient } = await loadClient();
    browserSessionClient.input(sessionId, { kind: 'dialog', accept, promptText });
    set({ dialog: null });
  },

  clearBrowserProfile: async () => {
    const { sessionId } = get();
    const { browserSessionClient } = await loadClient();
    browserSessionClient.close(sessionId ?? 'browser-profile', 'clear-profile');
    if (sessionId) {
      const { clearLatestFrame } = await loadFrames();
      clearLatestFrame(sessionId);
    }
    metric('browser_panel.profile_cleared', 1, { type: 'sum' });
    set({ ...DETACHED, url: '', loadedUrl: null });
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
    void loadClient().then(({ browserSessionClient }) => {
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
