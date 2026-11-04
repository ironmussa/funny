import { parseReferencedFiles as parseBlock } from '@funny/shared/attachments';

export interface ReferencedItem {
  path: string;
  type: 'file' | 'folder';
}

/**
 * UI view of the leading `<referenced-files>` block(s) of a user message
 * (format owned by `@funny/shared/attachments`). Returns the top-level
 * file/folder paths, clean content without the XML block (but with @path
 * mentions stripped), and inline content that preserves @path markers for
 * inline chip rendering.
 */
export function parseReferencedFiles(content: string): {
  files: ReferencedItem[];
  cleanContent: string;
  /** Content with @path markers preserved (XML block removed) for inline rendering */
  inlineContent: string;
  /** Map of path → ReferencedItem for quick lookup */
  fileMap: Map<string, ReferencedItem>;
} {
  const { entries, body } = parseBlock(content);
  const items: ReferencedItem[] = entries.map(({ path, type }) => ({ path, type }));
  const fileMap = new Map(items.map((item) => [item.path, item]));

  // cleanContent: also strip @path mentions (legacy behavior).
  // Build one combined regex so each scan happens in a single pass.
  let cleanContent = body;
  if (items.length > 0) {
    const alternation = items
      .map((item) => item.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    cleanContent = cleanContent.replace(new RegExp(`@(?:${alternation})\\s?`, 'g'), '');
  }

  return { files: items, cleanContent, inlineContent: body, fileMap };
}
