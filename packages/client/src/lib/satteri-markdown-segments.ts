/** A static HTML portion, or an island that must keep the existing React UI. */
export type SatteriMarkdownSegment =
  | { type: 'html'; markdown: string }
  | { type: 'image'; src: string; alt: string; title?: string }
  | { type: 'nested-markdown'; markdown: string }
  | { type: 'visualizer'; language: string; source: string };

const MARKDOWN_FENCE_LANGUAGES = new Set(['markdown', 'md']);
const FENCE_RE = /^```([^\n`]*)\n([\s\S]*?)^```\s*$/gm;
const STANDALONE_IMAGE_RE = /^\s*!\[([^\]]*)\]\((<[^>]+>|[^\s)]+)(?:\s+["']([^"']*)["'])?\)\s*$/gm;

function appendHtmlWithImageIslands(output: SatteriMarkdownSegment[], markdown: string): void {
  let cursor = 0;
  for (const match of markdown.matchAll(STANDALONE_IMAGE_RE)) {
    const index = match.index ?? 0;
    const before = markdown.slice(cursor, index);
    if (before) output.push({ type: 'html', markdown: before });

    const rawSrc = match[2] ?? '';
    const src = rawSrc.startsWith('<') && rawSrc.endsWith('>') ? rawSrc.slice(1, -1) : rawSrc;
    if (src) {
      output.push({ type: 'image', alt: match[1] ?? '', src, title: match[3] || undefined });
    }
    cursor = index + match[0].length;
  }

  const rest = markdown.slice(cursor);
  if (rest) output.push({ type: 'html', markdown: rest });
}

/**
 * Preserves the few markdown constructs that are interactive React today.
 * Plain prose remains in the Sätteri HTML path; fenced visualizers, nested
 * markdown and standalone images become small islands with their established
 * components.
 */
export function splitSatteriMarkdownSegments(
  markdown: string,
  isVisualizerLanguage: (language: string) => boolean,
): SatteriMarkdownSegment[] {
  const output: SatteriMarkdownSegment[] = [];
  let cursor = 0;

  for (const match of markdown.matchAll(FENCE_RE)) {
    const index = match.index ?? 0;
    appendHtmlWithImageIslands(output, markdown.slice(cursor, index));

    const language = (match[1] ?? '').trim().toLowerCase();
    const source = match[2] ?? '';
    if (MARKDOWN_FENCE_LANGUAGES.has(language)) {
      output.push({ type: 'nested-markdown', markdown: source });
    } else if (language && isVisualizerLanguage(language)) {
      output.push({ type: 'visualizer', language, source });
    } else {
      appendHtmlWithImageIslands(output, match[0]);
    }
    cursor = index + match[0].length;
  }

  appendHtmlWithImageIslands(output, markdown.slice(cursor));
  return output.length > 0 ? output : [{ type: 'html', markdown }];
}
