const STORAGE_KEY = 'funny.threadScrollProgress.v1';

type StoredThreadScroll = Record<string, number>;

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
  const value = readAll()[threadId];
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : undefined;
}

export function saveThreadScrollProgress(threadId: string, progress: number): void {
  if (typeof window === 'undefined') return;
  const nextProgress = Math.min(1, Math.max(0, progress));
  const next = readAll();
  if (Math.abs((next[threadId] ?? -1) - nextProgress) < 0.001) return;
  next[threadId] = nextProgress;
  scheduleFlush();
}
