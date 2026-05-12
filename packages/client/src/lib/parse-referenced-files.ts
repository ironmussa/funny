export interface ReferencedItem {
  path: string;
  type: 'file' | 'folder';
}

/**
 * Parses `<referenced-files>` XML from the beginning of user message content.
 * Returns the extracted file/folder paths, clean content without the XML block
 * (but with @path mentions stripped), and inline content that preserves @path
 * markers for inline chip rendering.
 */
export function parseReferencedFiles(content: string): {
  files: ReferencedItem[];
  cleanContent: string;
  /** Content with @path markers preserved (XML block removed) for inline rendering */
  inlineContent: string;
  /** Map of path → ReferencedItem for quick lookup */
  fileMap: Map<string, ReferencedItem>;
} {
  const match = content.match(/^\s*<referenced-files>\s*([\s\S]*?)\s*<\/referenced-files>\s*/);
  if (!match)
    return { files: [], cleanContent: content, inlineContent: content, fileMap: new Map() };

  const xmlBlock = match[0];
  const inner = match[1];

  const items: ReferencedItem[] = [];

  // Extract folder paths from <folder path="..."> tags (don't expand their children)
  const folderRegex = /<folder\s+path="([^"]+)"[^>]*>[\s\S]*?<\/folder>/g;
  const folderRanges: [number, number][] = [];
  let folderMatch: RegExpExecArray | null;
  while ((folderMatch = folderRegex.exec(inner)) !== null) {
    items.push({ path: folderMatch[1], type: 'folder' });
    folderRanges.push([folderMatch.index, folderMatch.index + folderMatch[0].length]);
  }

  // Extract file paths from <file path="..."> tags that are NOT inside a <folder> block
  const fileRegex = /<file\s+path="([^"]+)"[^>]*>/g;
  let fileMatch: RegExpExecArray | null;
  while ((fileMatch = fileRegex.exec(inner)) !== null) {
    const pos = fileMatch.index;
    const insideFolder = folderRanges.some(([start, end]) => pos >= start && pos < end);
    if (!insideFolder) {
      items.push({ path: fileMatch[1], type: 'file' });
    }
  }

  // Build file map for inline rendering
  const fileMap = new Map<string, ReferencedItem>();
  for (const item of items) {
    fileMap.set(item.path, item);
  }

  // inlineContent: XML block removed, @path markers preserved
  const inlineContent = content.slice(xmlBlock.length);

  // cleanContent: also strip @path mentions (legacy behavior).
  // Build one combined regex so each scan happens in a single pass.
  let cleanContent = inlineContent;
  if (items.length > 0) {
    const alternation = items
      .map((item) => item.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    cleanContent = cleanContent.replace(new RegExp(`@(?:${alternation})\\s?`, 'g'), '');
  }

  return { files: items, cleanContent, inlineContent, fileMap };
}
