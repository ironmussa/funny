import DOMPurify from 'dompurify';

/** Maximum source + sanitized HTML retained by the shared markdown cache. */
export const SATTERI_MARKDOWN_CACHE_MAX_BYTES = 2 * 1024 * 1024;

const encoder = new TextEncoder();

interface CacheEntry {
  content: string;
  html: string;
  bytes: number;
}

/**
 * An LRU that accounts for the actual memory retained by a markdown entry.
 *
 * The map is keyed by a stable content hash. Keeping the source alongside the
 * result makes a hash collision a cache miss rather than returning another
 * message's HTML.
 */
export class ByteLruCache {
  private readonly entries = new Map<string, CacheEntry>();
  private retainedBytes = 0;

  constructor(private readonly maxBytes = SATTERI_MARKDOWN_CACHE_MAX_BYTES) {}

  get(content: string): string | undefined {
    const key = hashMarkdownContent(content);
    const entry = this.entries.get(key);
    if (!entry || entry.content !== content) return undefined;

    // Map insertion order is the LRU order. Move a hit to the end.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.html;
  }

  set(content: string, html: string): void {
    const key = hashMarkdownContent(content);
    const bytes = byteLength(content) + byteLength(html);
    const previous = this.entries.get(key);

    if (previous) {
      this.entries.delete(key);
      this.retainedBytes -= previous.bytes;
    }

    // An individual answer larger than the cap remains renderable, but is not
    // retained forever at the cost of every other cached message.
    if (bytes > this.maxBytes) return;

    this.entries.set(key, { content, html, bytes });
    this.retainedBytes += bytes;

    while (this.retainedBytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      this.retainedBytes -= oldest?.bytes ?? 0;
    }
  }

  clear(): void {
    this.entries.clear();
    this.retainedBytes = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.retainedBytes;
  }
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

/** A fast, stable FNV-1a 64-bit key; the source check in ByteLruCache handles collisions. */
export function hashMarkdownContent(content: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < content.length; index++) {
    hash ^= BigInt(content.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${hash.toString(16)}:${content.length}`;
}

// Allows HTTPS/mail/tel plus ordinary relative file paths. DOMPurify's default
// pattern accepts relative paths only when they begin with punctuation, while
// chat links commonly begin with `packages/` or `src/`. The path branch has no
// colon, so it cannot admit javascript:, data:, or another custom protocol.
const SAFE_URI_REGEXP =
  /^(?:(?:(?:f|ht)tps?|mailto|tel):[^\s]*|(?:\/|\.{1,2}\/|#|\?)[^]*|[a-z0-9][a-z0-9._/-]*(?:[?#][^]*)?)$/i;

const SATTERI_SANITIZE_CONFIG = {
  USE_PROFILES: { html: true },
  ADD_TAGS: ['details', 'summary'],
  ADD_ATTR: ['checked', 'disabled', 'open', 'start', 'type'],
  ALLOW_DATA_ATTR: false,
  FORBID_ATTR: ['style'],
  FORBID_TAGS: ['embed', 'iframe', 'object', 'script', 'style'],
  ALLOWED_URI_REGEXP: SAFE_URI_REGEXP,
};

/**
 * The only sanitizer used for Sätteri output. Never insert raw compiler output
 * into the DOM: Sätteri intentionally preserves raw HTML from markdown.
 */
export function sanitizeSatteriHtml(rawHtml: string): string {
  return DOMPurify.sanitize(rawHtml, SATTERI_SANITIZE_CONFIG);
}

type MarkdownCompiler = (content: string) => string | Promise<string>;
type HtmlSanitizer = (rawHtml: string) => string;

interface SafeMarkdownRendererOptions {
  compile: MarkdownCompiler;
  sanitizer?: HtmlSanitizer;
  cache?: ByteLruCache;
}

/**
 * Factory kept public for deterministic unit tests; production uses the
 * lazily-loaded Sätteri compiler below.
 */
export function createSafeMarkdownRenderer({
  compile,
  sanitizer = sanitizeSatteriHtml,
  cache = new ByteLruCache(),
}: SafeMarkdownRendererOptions): (content: string) => Promise<string> {
  return async (content) => {
    const cached = cache.get(content);
    if (cached !== undefined) return cached;

    const html = sanitizer(await compile(content));
    cache.set(content, html);
    return html;
  };
}

let compilerPromise: Promise<MarkdownCompiler> | null = null;

function loadSatteriCompiler(): Promise<MarkdownCompiler> {
  compilerPromise ??= import('satteri').then(({ markdownToHtml }) => {
    return (content) => markdownToHtml(content, { features: { gfm: true } }).html;
  });
  return compilerPromise;
}

const productionCache = new ByteLruCache();

/**
 * Compile GFM markdown through browser-only Sätteri WASM and sanitize before
 * returning HTML. Dynamic import keeps the ~733 KB gzip WASM out of the legacy
 * renderer's initial path.
 */
export const renderMarkdownToSafeHtml = createSafeMarkdownRenderer({
  compile: async (content) => (await loadSatteriCompiler())(content),
  cache: productionCache,
});

export function clearSatteriMarkdownCache(): void {
  productionCache.clear();
}
