/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: domain
 */

import { readFile, readdir, stat } from 'fs/promises';
import { join, resolve } from 'path';

const MAX_FILE_SIZE = 100 * 1024; // 100KB per file
const MAX_TOTAL_CONTENT = 500 * 1024; // 500KB total
const MAX_FOLDER_FILES = 50; // max files to inline from a folder
const MAX_SYMBOL_LINES = 50; // max lines to extract for a single symbol

export interface FileRef {
  path: string;
}

export interface SymbolRef {
  path: string;
  name: string;
  kind: string;
  line: number;
  endLine?: number;
}

async function inlineFile(
  fullPath: string,
  relPath: string,
  totalSize: { value: number },
): Promise<string> {
  try {
    const fileStat = await stat(fullPath);
    const size = fileStat.size;

    if (size > MAX_FILE_SIZE || totalSize.value + size > MAX_TOTAL_CONTENT) {
      return `<file path="${relPath}" note="File too large to inline (${Math.round(size / 1024)}KB). Use the Read tool to access it."></file>`;
    }
    const content = await readFile(fullPath, 'utf-8');
    totalSize.value += size;
    return `<file path="${relPath}">\n${content}\n</file>`;
  } catch {
    return `<file path="${relPath}" note="File not found or unreadable"></file>`;
  }
}

export async function augmentPromptWithFiles(
  prompt: string,
  fileReferences: FileRef[] | undefined,
  basePath: string,
): Promise<string> {
  if (!fileReferences || fileReferences.length === 0) return prompt;

  const sections: string[] = [];
  const totalSize = { value: 0 };
  const resolvedBase = resolve(basePath);

  for (const ref of fileReferences) {
    const fullPath = join(basePath, ref.path);
    const resolved = resolve(fullPath);
    if (!resolved.startsWith(resolvedBase)) continue;

    try {
      const fileStat = await stat(fullPath);

      if (fileStat.isDirectory()) {
        // Folder reference: list and inline files from the directory
        const entries = await readdir(fullPath, { withFileTypes: true });
        const files = entries.filter((e) => e.isFile()).map((e) => e.name);
        const truncated = files.length > MAX_FOLDER_FILES;
        const filesToInline = files.slice(0, MAX_FOLDER_FILES);

        const folderSections: string[] = [];
        for (const fileName of filesToInline) {
          if (totalSize.value >= MAX_TOTAL_CONTENT) break;
          const childPath = join(ref.path, fileName);
          const childFullPath = join(fullPath, fileName);
          folderSections.push(await inlineFile(childFullPath, childPath, totalSize));
        }

        const truncNote = truncated
          ? ` note="Showing ${MAX_FOLDER_FILES} of ${files.length} files. Use the Glob/Read tools to access more."`
          : '';
        sections.push(
          `<folder path="${ref.path}"${truncNote}>\n${folderSections.join('\n')}\n</folder>`,
        );
      } else {
        sections.push(await inlineFile(fullPath, ref.path, totalSize));
      }
    } catch {
      sections.push(`<file path="${ref.path}" note="File not found or unreadable"></file>`);
    }
  }

  if (sections.length === 0) return prompt;

  const fileContext = `<referenced-files>\n${sections.join('\n')}\n</referenced-files>\n\n`;
  return fileContext + prompt;
}

/**
 * Augment a prompt with symbol source code extracted from referenced files.
 * Each symbol reference reads the relevant lines from the source file and
 * wraps them in <symbol> tags prepended to the prompt.
 */
export async function augmentPromptWithSymbols(
  prompt: string,
  symbolReferences: SymbolRef[] | undefined,
  basePath: string,
): Promise<string> {
  if (!symbolReferences || symbolReferences.length === 0) return prompt;

  const sections: string[] = [];
  const resolvedBase = resolve(basePath);

  for (const ref of symbolReferences) {
    const fullPath = join(basePath, ref.path);
    const resolved = resolve(fullPath);
    if (!resolved.startsWith(resolvedBase)) continue;

    try {
      const content = await readFile(fullPath, 'utf-8');
      const lines = content.split('\n');
      const startLine = Math.max(0, ref.line - 1); // 1-based → 0-based

      let endLine: number;
      if (ref.endLine && ref.endLine > ref.line) {
        endLine = Math.min(lines.length, ref.endLine);
      } else {
        // Heuristic: read up to MAX_SYMBOL_LINES or until a blank line
        endLine = Math.min(lines.length, startLine + MAX_SYMBOL_LINES);
      }

      const symbolSource = lines.slice(startLine, endLine).join('\n');
      sections.push(
        `<symbol path="${ref.path}" name="${ref.name}" kind="${ref.kind}" line="${ref.line}">\n${symbolSource}\n</symbol>`,
      );
    } catch {
      sections.push(
        `<symbol path="${ref.path}" name="${ref.name}" kind="${ref.kind}" line="${ref.line}" note="File not found or unreadable"></symbol>`,
      );
    }
  }

  if (sections.length === 0) return prompt;

  const symbolContext = `<referenced-symbols>\n${sections.join('\n')}\n</referenced-symbols>\n\n`;
  return symbolContext + prompt;
}

/**
 * Strip inline file/folder/symbol contents from a stored user message so the UI
 * shows path references only. The agent's prompt (with full contents) is what
 * we pass to `startAgent`; what we persist in the messages table should be a
 * lightweight metadata version, otherwise:
 *   1. The card displays the whole source file as plain text.
 *   2. The client-side parser (`parseReferencedFiles`) breaks when the inlined
 *      content itself contains literal `</referenced-files>` / `</file>` text.
 *
 * Self-closing tags (`<file path="X" />`) are preserved as-is.
 */
export function stripInlineReferencedContent(content: string): string {
  let out = content;
  out = out.replace(/<file\b([^>]*?(?<!\/))>[\s\S]*?<\/file>/g, (_m, attrs) => `<file${attrs} />`);
  out = out.replace(
    /<folder\b([^>]*?(?<!\/))>[\s\S]*?<\/folder>/g,
    (_m, attrs) => `<folder${attrs}></folder>`,
  );
  out = out.replace(
    /<symbol\b([^>]*?(?<!\/))>[\s\S]*?<\/symbol>/g,
    (_m, attrs) => `<symbol${attrs} />`,
  );
  return out;
}
