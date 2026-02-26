import { readFile, stat } from 'fs/promises';
import { join, resolve } from 'path';

const MAX_FILE_SIZE = 100 * 1024; // 100KB per file
const MAX_TOTAL_CONTENT = 500 * 1024; // 500KB total

export interface FileRef {
  path: string;
}

export async function augmentPromptWithFiles(
  prompt: string,
  fileReferences: FileRef[] | undefined,
  basePath: string,
): Promise<string> {
  if (!fileReferences || fileReferences.length === 0) return prompt;

  const sections: string[] = [];
  let totalSize = 0;

  for (const ref of fileReferences) {
    const fullPath = join(basePath, ref.path);
    const resolved = resolve(fullPath);
    if (!resolved.startsWith(resolve(basePath))) continue;

    try {
      const fileStat = await stat(fullPath);
      const size = fileStat.size;

      if (size > MAX_FILE_SIZE || totalSize + size > MAX_TOTAL_CONTENT) {
        sections.push(
          `<file path="${ref.path}" note="File too large to inline (${Math.round(size / 1024)}KB). Use the Read tool to access it."></file>`,
        );
      } else {
        const content = await readFile(fullPath, 'utf-8');
        totalSize += size;
        sections.push(`<file path="${ref.path}">\n${content}\n</file>`);
      }
    } catch {
      sections.push(`<file path="${ref.path}" note="File not found or unreadable"></file>`);
    }
  }

  if (sections.length === 0) return prompt;

  const fileContext = `<referenced-files>\n${sections.join('\n')}\n</referenced-files>\n\n`;
  return fileContext + prompt;
}
