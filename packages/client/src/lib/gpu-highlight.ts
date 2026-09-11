/** GPU work is prepared asynchronously; render paths only read completed HTML. */
const cache = new Map<string, string>();
const pending = new Map<string, Promise<boolean>>();
const MAX_CACHE_CHARS = 8_000_000;
let cacheChars = 0;
let unavailable = false;
// The package shares GPU buffers, so do not overlap inference calls.
let queue: Promise<unknown> = Promise.resolve();

const classes: Record<string, string> = {
  comment: 'hljs-comment',
  string: 'hljs-string',
  number: 'hljs-number',
  keyword: 'hljs-keyword',
  type: 'hljs-type',
  function: 'hljs-title function_',
  constant: 'hljs-literal',
  operator: 'hljs-operator',
};

function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function put(key: string, html: string): void {
  const size = key.length + html.length;
  if (size > MAX_CACHE_CHARS) return;
  const previous = cache.get(key);
  if (previous !== undefined) cacheChars -= key.length + previous.length;
  cache.delete(key);
  while (cacheChars + size > MAX_CACHE_CHARS) {
    const first = cache.entries().next().value;
    if (!first) break;
    cache.delete(first[0]);
    cacheChars -= first[0].length + first[1].length;
  }
  cache.set(key, html);
  cacheChars += size;
}

export function getGpuHighlight(code: string): string | undefined {
  return cache.get(code);
}

export function prepareGpuHighlight(code: string): Promise<boolean> {
  if (cache.has(code)) return Promise.resolve(true);
  if (!code || unavailable || typeof navigator === 'undefined' || !('gpu' in navigator)) {
    return Promise.resolve(false);
  }
  // Bound CPU tokenization, GPU allocation and retained HTML for pathological inputs.
  if (code.length > 2_000_000) return Promise.resolve(false);
  const existing = pending.get(code);
  if (existing) return existing;
  const task = queue
    .then(async () => {
      if (unavailable) return false;
      try {
        const { parse } = await import('gpu-lexer');
        const spans = await parse(code);
        let offset = 0;
        let html = '';
        for (const span of spans) {
          if (
            !Number.isInteger(span.start) ||
            !Number.isInteger(span.end) ||
            span.start < offset ||
            span.end < span.start ||
            span.end > code.length
          ) {
            throw new Error('Invalid GPU syntax span');
          }
          html += escape(code.slice(offset, span.start));
          const text = escape(code.slice(span.start, span.end));
          const className = Object.hasOwn(classes, span.type) ? classes[span.type] : undefined;
          // Close spans at newlines so each diff/read row has self-contained markup.
          html += className
            ? text
                .split('\n')
                .map((line) => (line ? `<span class="${className}">${line}</span>` : ''))
                .join('\n')
            : text;
          offset = span.end;
        }
        html += escape(code.slice(offset));
        const lines = code.split('\n');
        const rendered = html.split('\n');
        for (let i = 0; i < lines.length; i++) put(lines[i], rendered[i]);
        put(code, html);
        return cache.has(code);
      } catch {
        // Includes missing adapters and lost devices. Keep the fallback usable for this session.
        unavailable = true;
        return false;
      }
    })
    .finally(() => pending.delete(code));
  queue = task;
  pending.set(code, task);
  return task;
}
