/**
 * Parses `<referenced-files>` XML from the beginning of user message content.
 * Returns the extracted file paths and the clean message text without the XML block.
 */
export function parseReferencedFiles(content: string): {
  files: string[];
  cleanContent: string;
} {
  const match = content.match(/^\s*<referenced-files>\s*([\s\S]*?)\s*<\/referenced-files>\s*/);
  if (!match) return { files: [], cleanContent: content };

  const xmlBlock = match[0];
  const inner = match[1];

  // Extract file paths from <file path="..."> tags
  const files: string[] = [];
  const fileRegex = /<file\s+path="([^"]+)"[^>]*>/g;
  let fileMatch: RegExpExecArray | null;
  while ((fileMatch = fileRegex.exec(inner)) !== null) {
    files.push(fileMatch[1]);
  }

  const cleanContent = content.slice(xmlBlock.length);
  return { files, cleanContent };
}
