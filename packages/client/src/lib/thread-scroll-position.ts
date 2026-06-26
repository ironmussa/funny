const STORAGE_KEY = 'funny.threadScrollProgress.v1';

export type StoredThreadScrollAnchor = {
  key: string;
  offsetFromViewportTop: number;
};

export type StoredThreadScrollPosition = {
  progress: number;
  anchor?: StoredThreadScrollAnchor | null;
};

export type ThreadScrollFetchOptions = {
  messageProgress?: number;
  messageAnchorId?: string;
};

type StoredThreadScrollValue = number | StoredThreadScrollPosition;
type StoredThreadScroll = Record<string, StoredThreadScrollValue>;

let cached: StoredThreadScroll | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let pagehideListenerAttached = false;

function readAll(): StoredThreadScroll {
  if (cached) return cached;
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    cached = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    cached = {};
  }
  return cached ?? {};
}

function flush(): void {
  if (typeof window === 'undefined' || !cached) return;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
  } catch {
    // Ignore quota/privacy failures; in-memory scroll restoration still works.
  }
}

function scheduleFlush(): void {
  if (typeof window === 'undefined') return;
  if (!pagehideListenerAttached) {
    window.addEventListener('pagehide', flush);
    pagehideListenerAttached = true;
  }
  if (flushTimer) return;
  flushTimer = setTimeout(flush, 250);
}

export function loadThreadScrollProgress(threadId: string): number | undefined {
  return loadThreadScrollPosition(threadId)?.progress;
}

export function loadThreadScrollPosition(threadId: string): StoredThreadScrollPosition | undefined {
  const value = readAll()[threadId];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { progress: Math.min(1, Math.max(0, value)), anchor: null };
  }
  if (!value || typeof value !== 'object') return undefined;

  const progress = value.progress;
  if (typeof progress !== 'number' || !Number.isFinite(progress)) return undefined;

  const anchor = value.anchor;
  return {
    progress: Math.min(1, Math.max(0, progress)),
    anchor:
      anchor &&
      typeof anchor.key === 'string' &&
      anchor.key.length > 0 &&
      typeof anchor.offsetFromViewportTop === 'number' &&
      Number.isFinite(anchor.offsetFromViewportTop)
        ? {
            key: anchor.key,
            offsetFromViewportTop: anchor.offsetFromViewportTop,
          }
        : null,
  };
}

export function loadThreadScrollFetchOptions(threadId: string): ThreadScrollFetchOptions {
  const position = loadThreadScrollPosition(threadId);
  if (!position) return {};

  const progress = position.progress;
  const isBottom = progress >= 0.999;
  const anchorKey = isBottom ? undefined : position.anchor?.key;

  return anchorKey
    ? { messageProgress: progress, messageAnchorId: anchorKey }
    : { messageProgress: progress };
}

export function saveThreadScrollProgress(threadId: string, progress: number): void {
  saveThreadScrollPosition(threadId, { progress, anchor: null });
}

export function saveThreadScrollPosition(
  threadId: string,
  position: StoredThreadScrollPosition,
): void {
  if (typeof window === 'undefined') return;
  const nextProgress = Math.min(1, Math.max(0, position.progress));
  const nextAnchor = position.anchor ?? null;
  const next = readAll();
  const current = loadThreadScrollPosition(threadId);
  if (
    current &&
    Math.abs(current.progress - nextProgress) < 0.001 &&
    current.anchor?.key === nextAnchor?.key &&
    Math.abs(
      (current.anchor?.offsetFromViewportTop ?? 0) - (nextAnchor?.offsetFromViewportTop ?? 0),
    ) < 1
  ) {
    return;
  }
  next[threadId] = {
    progress: nextProgress,
    anchor: nextAnchor,
  };
  scheduleFlush();
}
