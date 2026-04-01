import type {
  LayoutResult,
  LayoutLinesResult,
  PreparedText,
  PrepareOptions,
} from '@chenglou/pretext';
import { useEffect, useState } from 'react';

/* ── Module-level singleton state ── */

type PretextModule = typeof import('@chenglou/pretext');

let pretextModule: PretextModule | null = null;
let pretextLoadPromise: Promise<PretextModule> | null = null;

/** Global prepare cache: cacheKey → PreparedText */
const prepareCache = new Map<string, PreparedText>();
const MAX_CACHE_SIZE = 500;
const EVICT_COUNT = 125;

/** Font readiness tracking */
const fontReadySet = new Set<string>();
const fontReadyPromises = new Map<string, Promise<boolean>>();

/* ── Font strings (must match CSS exactly) ── */

/** Sans-serif font used for prose / chat messages (text-sm = 14px) */
export const PROSE_FONT = '14px "Geist Sans", sans-serif';
/** Monospace font used for code / diffs (text-[11px]) */
export const MONO_FONT = '11px "JetBrains Mono", ui-monospace, monospace';

/** leading-relaxed = 1.625 × 14px */
export const PROSE_LINE_HEIGHT = 22.75;
/** Diff row height */
export const MONO_LINE_HEIGHT = 20;

/* ── Cache key ── */

function makeCacheKey(text: string, font: string): string {
  return font + '\x00' + text;
}

/* ── Lazy module loading ── */

export async function ensurePretextLoaded(): Promise<PretextModule> {
  if (pretextModule) return pretextModule;
  if (!pretextLoadPromise) {
    pretextLoadPromise = import('@chenglou/pretext').then((mod) => {
      pretextModule = mod;
      return mod;
    });
  }
  return pretextLoadPromise;
}

/* ── Font readiness ── */

export async function ensureFontReady(font: string): Promise<boolean> {
  if (fontReadySet.has(font)) return true;

  // Synchronous check first
  if (typeof document !== 'undefined' && document.fonts?.check(font)) {
    fontReadySet.add(font);
    return true;
  }

  const existing = fontReadyPromises.get(font);
  if (existing) return existing;

  const promise = (async () => {
    if (typeof document === 'undefined' || !document.fonts?.load) return false;
    try {
      await document.fonts.load(font);
      fontReadySet.add(font);
      return true;
    } catch {
      return false;
    }
  })();

  fontReadyPromises.set(font, promise);
  return promise;
}

/* ── Cache management ── */

function evictIfNeeded() {
  if (prepareCache.size <= MAX_CACHE_SIZE) return;
  const iter = prepareCache.keys();
  for (let i = 0; i < EVICT_COUNT; i++) {
    const k = iter.next();
    if (k.done) break;
    prepareCache.delete(k.value);
  }
}

/* ── Core functions (usable outside React) ── */

/**
 * Prepare text for layout measurement. Async because it lazily loads the
 * pretext module and ensures the font is available. The result is cached
 * globally so subsequent calls with the same text+font are instant.
 */
export async function prepareText(
  text: string,
  font: string,
  options?: PrepareOptions,
): Promise<PreparedText> {
  const key = makeCacheKey(text, font);
  const cached = prepareCache.get(key);
  if (cached) return cached;

  const mod = await ensurePretextLoaded();
  await ensureFontReady(font);

  const prepared = mod.prepare(text, font, options);
  prepareCache.set(key, prepared);
  evictIfNeeded();
  return prepared;
}

/**
 * Synchronous layout — returns height and lineCount.
 * Only works if the module is already loaded (call ensurePretextLoaded first).
 */
export function layoutSync(
  prepared: PreparedText,
  maxWidth: number,
  lineHeight: number,
): LayoutResult {
  if (!pretextModule) throw new Error('pretext not loaded — call ensurePretextLoaded() first');
  return pretextModule.layout(prepared, maxWidth, lineHeight);
}

/**
 * Synchronous layout with per-line details.
 * Requires prepareWithSegments — use prepareTextWithSegments() instead of prepareText().
 */
export function layoutWithLinesSync(
  prepared: PreparedText,
  maxWidth: number,
  lineHeight: number,
): LayoutLinesResult {
  if (!pretextModule) throw new Error('pretext not loaded — call ensurePretextLoaded() first');
  return pretextModule.layoutWithLines(prepared as any, maxWidth, lineHeight);
}

/**
 * Look up a previously prepared text from the cache (sync, no side effects).
 */
export function getCachedPrepared(text: string, font: string): PreparedText | undefined {
  return prepareCache.get(makeCacheKey(text, font));
}

/**
 * Check if the pretext module has been loaded.
 */
export function isPretextReady(): boolean {
  return pretextModule !== null;
}

/**
 * Prepare a batch of texts, yielding to the main thread every `yieldEvery` items.
 * Returns the number of items prepared.
 */
export async function prepareBatch(
  texts: string[],
  font: string,
  options?: { yieldEvery?: number; signal?: AbortSignal },
): Promise<number> {
  const yieldEvery = options?.yieldEvery ?? 5;
  let prepared = 0;

  for (let i = 0; i < texts.length; i++) {
    if (options?.signal?.aborted) break;
    await prepareText(texts[i], font);
    prepared++;
    if (i > 0 && i % yieldEvery === 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  return prepared;
}

/* ── React hook ── */

/**
 * React hook that provides access to pretext measurement functions.
 * Handles lazy loading — `ready` becomes true once the module is loaded.
 */
export function usePretext(): {
  ready: boolean;
  prepare: typeof prepareText;
  layout: typeof layoutSync;
  layoutWithLines: typeof layoutWithLinesSync;
  getCached: typeof getCachedPrepared;
  prepareBatch: typeof prepareBatch;
} {
  const [ready, setReady] = useState(pretextModule !== null);

  useEffect(() => {
    if (pretextModule) {
      setReady(true);
      return;
    }
    let cancelled = false;
    ensurePretextLoaded().then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return {
    ready,
    prepare: prepareText,
    layout: layoutSync,
    layoutWithLines: layoutWithLinesSync,
    getCached: getCachedPrepared,
    prepareBatch,
  };
}
