import { createClientLogger } from './client-logger';
import type { ContextUsage } from './context-usage-types';

const log = createClientLogger('context-usage-storage');
const KEY_PREFIX = 'funny:contextUsage:';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface Persisted extends ContextUsage {
  savedAt: number;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}

export function loadContextUsage(threadId: string): ContextUsage | undefined {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + threadId);
    if (!raw) return undefined;
    // SAFETY: the value was written by saveContextUsage as a Persisted; the check
    // below drops anything whose cumulativeInputTokens is not a number.
    const parsed = JSON.parse(raw) as Persisted;
    if (!parsed || !isNumber(parsed.cumulativeInputTokens)) return undefined;
    if (Date.now() - parsed.savedAt > MAX_AGE_MS) {
      localStorage.removeItem(KEY_PREFIX + threadId);
      return undefined;
    }
    return {
      cumulativeInputTokens: parsed.cumulativeInputTokens,
      lastInputTokens: parsed.lastInputTokens,
      lastOutputTokens: parsed.lastOutputTokens,
      breakdown: parsed.breakdown || undefined,
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
