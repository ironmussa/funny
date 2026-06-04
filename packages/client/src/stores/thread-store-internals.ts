/**
 * Module-level coordination state for thread-store.
 *
 * Encapsulated in a class instance so state can be reset between tests
 * and there's no hidden coupling via module-level globals.
 * The exported function API is backward-compatible.
 */

import type { AgentInitInfo } from './thread-types';

// ── ThreadStoreInternals class ──────────────────────────────────

export class ThreadStoreInternals {
  /** Generation counter to detect stale selectThread calls */
  private selectGeneration = 0;

  /** The threadId currently being loaded by selectThread (null if idle) */
  private selectingThreadId: string | null = null;

  /** Buffer init info that arrives before the thread is active */
  private initInfoBuffer = new Map<string, AgentInitInfo>();

  /** Buffer WS events that arrive while activeThread is still loading */
  private wsEventBuffer = new Map<string, Array<{ type: string; data: any }>>();

  /** O(1) lookup of which project a thread belongs to */
  private threadProjectIndex = new Map<string, string>();

  /** React Router navigate function ref */
  private navigateFn: ((path: string) => void) | null = null;

  /** Callback registered by ui-store to reset UI state on thread select */
  private threadSelectListener: (() => void) | null = null;

  /** Callback registered by thread-store so UI actions can clear selection without importing it */
  private clearThreadSelectionFn: (() => void) | null = null;

  /**
   * The active thread id parsed from the current URL, mirrored here so non-React
   * store code (eviction, WS routing) can read "which thread is the user looking
   * at" without coupling to `selectedThreadId` or reading `window.location`
   * (which `MemoryRouter` doesn't update in tests). Updated by `useRouteSync` on
   * every location change. This is the route-driven source of truth that lets
   * the invariant guard eventually go away.
   */
  private urlThreadId: string | null = null;

  // ── URL thread id (route-driven anchor) ────────────────────────

  getUrlThreadId(): string | null {
    return this.urlThreadId;
  }

  setUrlThreadId(threadId: string | null): void {
    this.urlThreadId = threadId;
  }

  // ── Select generation ──────────────────────────────────────────

  getSelectGeneration(): number {
    return this.selectGeneration;
  }

  nextSelectGeneration(): number {
    return ++this.selectGeneration;
  }

  invalidateSelectThread(): void {
    this.selectGeneration++;
  }

  // ── In-flight select tracking ──────────────────────────────────

  getSelectingThreadId(): string | null {
    return this.selectingThreadId;
  }

  setSelectingThreadId(threadId: string | null): void {
    this.selectingThreadId = threadId;
  }

  // ── Init info buffer ───────────────────────────────────────────

  getBufferedInitInfo(threadId: string): AgentInitInfo | undefined {
    const info = this.initInfoBuffer.get(threadId);
    if (info) this.initInfoBuffer.delete(threadId);
    return info;
  }

  setBufferedInitInfo(threadId: string, info: AgentInitInfo): void {
    this.initInfoBuffer.set(threadId, info);
  }

  // ── WS event buffer ────────────────────────────────────────────

  bufferWSEvent(threadId: string, type: string, data: any): void {
    const buf = this.wsEventBuffer.get(threadId) ?? [];
    buf.push({ type, data });
    this.wsEventBuffer.set(threadId, buf);
  }

  getAndClearWSBuffer(threadId: string): Array<{ type: string; data: any }> | undefined {
    const events = this.wsEventBuffer.get(threadId);
    if (events?.length) {
      this.wsEventBuffer.delete(threadId);
      return events;
    }
    return undefined;
  }

  clearWSBuffer(threadId: string): void {
    this.wsEventBuffer.delete(threadId);
  }

  // ── Thread → Project index ─────────────────────────────────────

  /**
   * Rebuild the threadId → projectId index from the unified store shape.
   * Walks `threadIdsByProject` directly so no thread row lookup is needed —
   * the array IDs themselves are the index keys.
   */
  rebuildThreadProjectIndex(threadIdsByProject: Record<string, string[]>): void {
    this.threadProjectIndex.clear();
    for (const pid in threadIdsByProject) {
      const ids = threadIdsByProject[pid];
      for (let i = 0; i < ids.length; i++) {
        this.threadProjectIndex.set(ids[i], pid);
      }
    }
  }

  getProjectIdForThread(threadId: string): string | undefined {
    return this.threadProjectIndex.get(threadId);
  }

  // ── Navigation ref ─────────────────────────────────────────────

  setAppNavigate(fn: (path: string) => void): void {
    this.navigateFn = fn;
  }

  getNavigate(): ((path: string) => void) | null {
    return this.navigateFn;
  }

  // ── Thread-select listener (UI state reset) ──────────────────

  setThreadSelectListener(fn: () => void): void {
    this.threadSelectListener = fn;
  }

  notifyThreadSelected(): void {
    this.threadSelectListener?.();
  }

  setClearThreadSelection(fn: () => void): void {
    this.clearThreadSelectionFn = fn;
  }

  clearThreadSelection(): void {
    this.clearThreadSelectionFn?.();
  }

  // ── Reset (for tests) ─────────────────────────────────────────

  reset(): void {
    this.selectGeneration = 0;
    this.selectingThreadId = null;
    this.initInfoBuffer.clear();
    this.wsEventBuffer.clear();
    this.threadProjectIndex.clear();
    this.navigateFn = null;
    this.threadSelectListener = null;
    this.clearThreadSelectionFn = null;
    this.urlThreadId = null;
  }
}

// ── Default singleton ────────────────────────────────────────────

export const internals = new ThreadStoreInternals();

// ── Backward-compatible function exports ─────────────────────────

export const getSelectGeneration = () => internals.getSelectGeneration();
export const nextSelectGeneration = () => internals.nextSelectGeneration();
export const invalidateSelectThread = () => internals.invalidateSelectThread();
export const getSelectingThreadId = () => internals.getSelectingThreadId();
export const setSelectingThreadId = (id: string | null) => internals.setSelectingThreadId(id);
export const getBufferedInitInfo = (id: string) => internals.getBufferedInitInfo(id);
export const setBufferedInitInfo = (id: string, info: AgentInitInfo) =>
  internals.setBufferedInitInfo(id, info);
export const bufferWSEvent = (id: string, type: string, data: any) =>
  internals.bufferWSEvent(id, type, data);
export const getAndClearWSBuffer = (id: string) => internals.getAndClearWSBuffer(id);
export const clearWSBuffer = (id: string) => internals.clearWSBuffer(id);
export const rebuildThreadProjectIndex = (t: Record<string, string[]>) =>
  internals.rebuildThreadProjectIndex(t);
export const getProjectIdForThread = (id: string) => internals.getProjectIdForThread(id);
export const setAppNavigate = (fn: (path: string) => void) => internals.setAppNavigate(fn);
export const getNavigate = () => internals.getNavigate();
export const setThreadSelectListener = (fn: () => void) => internals.setThreadSelectListener(fn);
export const notifyThreadSelected = () => internals.notifyThreadSelected();
export const setClearThreadSelection = (fn: () => void) => internals.setClearThreadSelection(fn);
export const clearThreadSelection = () => internals.clearThreadSelection();
export const getUrlThreadId = () => internals.getUrlThreadId();
export const setUrlThreadId = (id: string | null) => internals.setUrlThreadId(id);
