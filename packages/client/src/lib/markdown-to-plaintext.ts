/**
 * Lightweight markdown analysis for pretext height estimation.
 *
 * Strips markdown syntax to produce plain text suitable for pretext measurement,
 * and tracks structural elements (headings, code blocks, images, etc.) that add
 * extra height that plain text measurement cannot capture.
 */

export interface MarkdownAnalysis {
  /** Plain text approximation (markdown stripped) for pretext measurement */
  plainText: string;
  /** Extra px from structural elements that pretext cannot measure */
  extraHeightPx: number;
  /** Total lines inside fenced code blocks (measured separately with mono font) */
  codeBlockLines: number;
  /** Number of fenced code blocks (each adds padding/border) */
  codeBlockCount: number;
  /** Non-empty prose lines after markdown stripping */
  proseLineCount: number;
  /** Paragraph-like blocks that receive prose margins in the renderer */
  paragraphCount: number;
  /** Markdown list items, useful for indentation/margin estimation */
  listItemCount: number;
  /** Visible table rows */
  tableRowCount: number;
  /** Markdown image blocks */
  imageCount: number;
  /** Inline code spans, which add small vertical padding */
  inlineCodeCount: number;
}

// Cache to avoid re-analyzing the same markdown
const analysisCache = new Map<string, MarkdownAnalysis>();
const MAX_ANALYSIS_CACHE = 500;

/**
 * Analyze markdown content and return a plain-text approximation plus
 * extra height adjustments for elements that pretext cannot measure.
 */
export function analyzeMarkdown(markdown: string): MarkdownAnalysis {
  const cached = analysisCache.get(markdown);
  if (cached) return cached;

  const lines = markdown.split('\n');
  const proseLines: string[] = [];
  let extraHeightPx = 0;
  let codeBlockLines = 0;
  let codeBlockCount = 0;
  let paragraphCount = 0;
  let listItemCount = 0;
  let tableRowCount = 0;
  let imageCount = 0;
  let inlineCodeCount = 0;
  let inCodeBlock = false;
  let inParagraph = false;

  const closeParagraph = () => {
    if (!inParagraph) return;
    paragraphCount++;
    inParagraph = false;
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // Fenced code blocks
    if (line.startsWith('```') || line.startsWith('~~~')) {
      if (inCodeBlock) {
        // Closing fence
        inCodeBlock = false;
        // Bottom padding/margin of code block
        extraHeightPx += 8;
      } else {
        closeParagraph();
        // Opening fence
        inCodeBlock = true;
        codeBlockCount++;
        // Top padding/margin of code block
        extraHeightPx += 8;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockLines++;
      continue;
    }

    if (!trimmed) {
      closeParagraph();
      proseLines.push('');
      continue;
    }

    // Headings
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      closeParagraph();
      const level = headingMatch[1].length;
      proseLines.push(headingMatch[2]);
      paragraphCount++;
      // Headings have larger font size + top/bottom margins
      if (level === 1) extraHeightPx += 8;
      else if (level === 2) extraHeightPx += 6;
      else extraHeightPx += 4;
      continue;
    }

    // Horizontal rules
    if (/^[-*_]{3,}\s*$/.test(line)) {
      closeParagraph();
      extraHeightPx += 24;
      continue;
    }

    // Images (block-level)
    if (/^!\[.*]\(.*\)/.test(line)) {
      closeParagraph();
      imageCount++;
      extraHeightPx += 220;
      continue;
    }

    // Blockquote lines
    if (line.startsWith('>')) {
      const text = stripInlineMarkdown(line.replace(/^>+\s*/, ''));
      proseLines.push(text);
      inParagraph = true;
      // First line of a blockquote adds left border + padding
      extraHeightPx += 2;
      continue;
    }

    // Table rows — rough estimate
    if (line.includes('|') && line.trim().startsWith('|')) {
      closeParagraph();
      // Skip separator rows (|---|---|)
      if (/^\|[\s-:|]+\|$/.test(line.trim())) {
        continue;
      }
      tableRowCount++;
      proseLines.push(stripInlineMarkdown(line.replace(/\|/g, ' ')).trim());
      extraHeightPx += 10;
      continue;
    }

    const listMatch = /^(\s*)([-*+]|\d+\.)\s+(.+)$/.exec(line);
    if (listMatch) {
      listItemCount++;
      proseLines.push(stripInlineMarkdown(listMatch[3]));
      inParagraph = true;
      extraHeightPx += 2;
      continue;
    }

    // Regular lines — strip inline markdown
    inlineCodeCount += (line.match(/`[^`]+`/g) ?? []).length;
    proseLines.push(stripInlineMarkdown(line));
    inParagraph = true;
  }

  // If we ended inside an unclosed code block, count remaining
  // (shouldn't happen with well-formed markdown, but be safe)
  closeParagraph();

  const result: MarkdownAnalysis = {
    plainText: proseLines.join('\n'),
    extraHeightPx,
    codeBlockLines,
    codeBlockCount,
    proseLineCount: proseLines.filter((line) => line.trim().length > 0).length,
    paragraphCount,
    listItemCount,
    tableRowCount,
    imageCount,
    inlineCodeCount,
  };

  analysisCache.set(markdown, result);
  if (analysisCache.size > MAX_ANALYSIS_CACHE) {
    const iter = analysisCache.keys();
    for (let i = 0; i < 125; i++) {
      const k = iter.next();
      if (k.done) break;
      analysisCache.delete(k.value);
    }
  }

  return result;
}

/**
 * Strip inline markdown formatting from a line of text.
 * Preserves the visible text content.
 */
function stripInlineMarkdown(text: string): string {
  return (
    text
      // Images: ![alt](url) → alt
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      // Links: [text](url) → text
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      // Bold+italic: ***text*** or ___text___
      .replace(/(\*{3}|_{3})(.+?)\1/g, '$2')
      // Bold: **text** or __text__
      .replace(/(\*{2}|_{2})(.+?)\1/g, '$2')
      // Italic: *text* or _text_
      .replace(/(\*|_)(.+?)\1/g, '$2')
      // Strikethrough: ~~text~~
      .replace(/~~(.+?)~~/g, '$1')
      // Inline code: `code`
      .replace(/`([^`]+)`/g, '$1')
      // List markers
      .replace(/^(\s*)[-*+]\s+/, '$1')
      // Ordered list markers
      .replace(/^(\s*)\d+\.\s+/, '$1')
  );
}
