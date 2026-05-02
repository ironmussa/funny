import type { ContextUsage } from '@/stores/thread-store';

import { createClientLogger } from './client-logger';

const log = createClientLogger('context-usage-storage');
const KEY_PREFIX = 'funny:contextUsage:';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface Persisted extends ContextUsage {
  savedAt: number;
}

export function loadContextUsage(threadId: string): ContextUsage | undefined {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + threadId);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Persisted;
    if (!parsed || typeof parsed.cumulativeInputTokens !== 'number') return undefined;
    if (Date.now() - parsed.savedAt > MAX_AGE_MS) {
      localStorage.removeItem(KEY_PREFIX + threadId);
      return undefined;
    }
    return {
      cumulativeInputTokens: parsed.cumulativeInputTokens,
      lastInputTokens: parsed.lastInputTokens,
      lastOutputTokens: parsed.lastOutputTokens,
    };
  } catch (err) {
    log.warn('load failed', { threadId, error: String(err) });
    return undefined;
  }
}

export function saveContextUsage(threadId: string, usage: ContextUsage): void {
  try {
    const payload: Persisted = { ...usage, savedAt: Date.now() };
    localStorage.setItem(KEY_PREFIX + threadId, JSON.stringify(payload));
  } catch (err) {
    log.warn('save failed', { threadId, error: String(err) });
  }
}
