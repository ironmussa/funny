/**
 * Module-level state for thread-store — extracted for testability.
 * These live outside the Zustand store because they're not reactive UI state,
 * they're coordination primitives (generation counters, buffers, navigation ref).
 */

import type { AgentInitInfo } from './thread-store';

// ── Select generation (stale request detection) ─────────────────

/** Generation counter to detect stale selectThread calls */
let selectGeneration = 0;

export function getSelectGeneration(): number {
  return selectGeneration;
}

export function nextSelectGeneration(): number {
  return ++selectGeneration;
}

/** Invalidate any in-flight selectThread so it won't overwrite newer state */
export function invalidateSelectThread(): void {
  selectGeneration++;
}

// ── Init info buffer ────────────────────────────────────────────

/** Buffer init info that arrives before the thread is active */
const initInfoBuffer = new Map<string, AgentInitInfo>();

export function getBufferedInitInfo(threadId: string): AgentInitInfo | undefined {
  const info = initInfoBuffer.get(threadId);
  if (info) initInfoBuffer.delete(threadId);
  return info;
}

export function setBufferedInitInfo(threadId: string, info: AgentInitInfo): void {
  initInfoBuffer.set(threadId, info);
}

// ── WS event buffer ────────────────────────────────────────────

/** Buffer WS events that arrive while selectedThreadId is set but activeThread is still loading */
const wsEventBuffer = new Map<string, Array<{ type: string; data: any }>>();

export function bufferWSEvent(threadId: string, type: string, data: any): void {
  const buf = wsEventBuffer.get(threadId) ?? [];
  buf.push({ type, data });
  wsEventBuffer.set(threadId, buf);
}

export function getAndClearWSBuffer(
  threadId: string,
): Array<{ type: string; data: any }> | undefined {
  const events = wsEventBuffer.get(threadId);
  if (events?.length) {
    wsEventBuffer.delete(threadId);
    return events;
  }
  return undefined;
}

export function clearWSBuffer(threadId: string): void {
  wsEventBuffer.delete(threadId);
}

// ── Navigation ref ──────────────────────────────────────────────

let _navigate: ((path: string) => void) | null = null;

export function setAppNavigate(fn: (path: string) => void): void {
  _navigate = fn;
}

export function getNavigate(): ((path: string) => void) | null {
  return _navigate;
}
