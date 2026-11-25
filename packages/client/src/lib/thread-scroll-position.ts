const STORAGE_KEY = 'funny.threadScrollProgress.v1';
const MAX_STORED_THREAD_SCROLL_POSITIONS = 200;

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

export function resetThreadScrollPositionForTests(): void {
  cached = null;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

function isObject(value: unknown): value is object {
  return typeof value === 'object';
}

/** The parsed storage map: any object; its values are checked on read. */
function isStoredThreadScroll(value: unknown): value is StoredThreadScroll {
  return typeof value === 'object';
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readAll(): StoredThreadScroll {
  if (cached) return cached;
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    cached = parsed && isStoredThreadScroll(parsed) ? parsed : {};
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

export function loadThreadScrollPosition(threadId: string): StoredThreadScrollPosition | undefined {
  const value = readAll()[threadId];
  if (isFiniteNumber(value)) {
    return { progress: Math.min(1, Math.max(0, value)), anchor: null };
  }
  if (!value || !isObject(value)) return undefined;

  const progress = value.progress;
  if (!isFiniteNumber(progress)) return undefined;

  const anchor = value.anchor;
  return {
    progress: Math.min(1, Math.max(0, progress)),
    anchor:
      anchor &&
      isString(anchor.key) &&
      anchor.key.length > 0 &&
      isFiniteNumber(anchor.offsetFromViewportTop)
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

  delete next[threadId];
  next[threadId] = {
    progress: nextProgress,
    anchor: nextAnchor,
  };

  const keys = Object.keys(next);
  const overflow = keys.length - MAX_STORED_THREAD_SCROLL_POSITIONS;
  for (let i = 0; i < overflow; i++) {
    delete next[keys[i]];
  }

  scheduleFlush();
}
