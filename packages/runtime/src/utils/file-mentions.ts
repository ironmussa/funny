/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: domain
 */

import { readFile, readdir, stat } from 'fs/promises';
import { join } from 'path';

import { isContainedPath } from '@funny/core/git';
import {
  addReferencedEntries,
  attachmentTextHint,
  looksLikeText,
  parseReferencedFiles,
  serializeReferencedFiles,
  stripReferencedContents,
  type ReferencedEntry,
  type ReferencedFile,
  type ReferencedFolder,
} from '@funny/shared/attachments';

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

/** True when the file should reach the agent via the Read tool instead of inline. */
function isBinary(relPath: string, bytes: Buffer): boolean {
  const hint = attachmentTextHint({ name: relPath, type: '' });
  if (hint !== 'unknown') return hint === 'binary';
  return !looksLikeText(bytes.subarray(0, 8192));
}

async function inlineFile(
  fullPath: string,
  relPath: string,
  totalSize: { value: number },
): Promise<ReferencedFile> {
  try {
    const fileStat = await stat(fullPath);
    const size = fileStat.size;

    if (size > MAX_FILE_SIZE || totalSize.value + size > MAX_TOTAL_CONTENT) {
      return {
        type: 'file',
        path: relPath,
        note: `File too large to inline (${Math.round(size / 1024)}KB). Use the Read tool to access it.`,
      };
    }
    const bytes = await readFile(fullPath);
    if (isBinary(relPath, bytes)) {
      return { type: 'file', path: relPath, note: 'Binary file. Use the Read tool to access it.' };
    }
    totalSize.value += size;
    return { type: 'file', path: relPath, content: bytes.toString('utf-8') };
  } catch {
    return { type: 'file', path: relPath, note: 'File not found or unreadable' };
  }
}

/** Inline up to MAX_FOLDER_FILES direct children of a referenced folder. */
async function inlineFolder(
  basePath: string,
  folderPath: string,
  relPath: string,
  totalSize: { value: number },
): Promise<ReferencedFolder> {
  const entries = await readdir(folderPath, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);
  const children: ReferencedFile[] = [];
  for (const fileName of files.slice(0, MAX_FOLDER_FILES)) {
    if (totalSize.value >= MAX_TOTAL_CONTENT) break;
    const childFullPath = join(folderPath, fileName);
    // A child may itself be a symlink pointing outside the base.
    if (!isContainedPath(basePath, childFullPath)) continue;
    children.push(await inlineFile(childFullPath, join(relPath, fileName), totalSize));
  }
  const folder: ReferencedFolder = { type: 'folder', path: relPath, children };
  if (files.length > MAX_FOLDER_FILES) {
    folder.note = `Showing ${MAX_FOLDER_FILES} of ${files.length} files. Use the Glob/Read tools to access more.`;
  }
  return folder;
}

/** Inline one file/folder reference, or null when it escapes `basePath`. */
async function inlineReference(
  basePath: string,
  ref: FileRef,
  totalSize: { value: number },
): Promise<ReferencedEntry | null> {
  const fullPath = join(basePath, ref.path);
  // Security (M9): sibling-prefix dirs (`/a/proj-secrets` vs `/a/proj`) and
  // symlinks pointing outside the base must not be inlined into the prompt.
  if (!isContainedPath(basePath, fullPath)) return null;
  try {
    const fileStat = await stat(fullPath);
    return fileStat.isDirectory()
      ? await inlineFolder(basePath, fullPath, ref.path, totalSize)
      : await inlineFile(fullPath, ref.path, totalSize);
  } catch {
    return { type: 'file', path: ref.path, note: 'File not found or unreadable' };
  }
}

/**
 * Resolve file references and merge them into the prompt's leading
 * `<referenced-files>` block — the client may already have put inline
 * attachments there, and the prompt must carry a single block.
 */
export async function augmentPromptWithFiles(
  prompt: string,
  fileReferences: FileRef[] | undefined,
  basePath: string,
): Promise<string> {
  if (!fileReferences || fileReferences.length === 0) return prompt;

  const entries: ReferencedEntry[] = [];
  const totalSize = { value: 0 };
  for (const ref of fileReferences) {
    const entry = await inlineReference(basePath, ref, totalSize);
    if (entry !== null) entries.push(entry);
  }
  return addReferencedEntries(prompt, entries);
}

/**
 * Resolve the path-only entries of the prompt's leading block (no contents,
 * no note) against `basePath`. A backlog thread stores its references this
 * way when it is created and only reads the files when it starts, so the
 * agent sees their contents as of the start — not as of the creation.
 */
export async function hydrateReferencedFiles(prompt: string, basePath: string): Promise<string> {
  const { entries, body } = parseReferencedFiles(prompt);
  const isPathOnly = (e: ReferencedEntry) =>
    e.note === undefined && (e.type === 'file' ? e.content === undefined : !e.children);
  const pending = entries.filter(isPathOnly);
  if (pending.length === 0) return prompt;
  const kept = entries.filter((e) => !isPathOnly(e));
  return augmentPromptWithFiles(
    serializeReferencedFiles(kept, body),
    pending.map((e) => ({ path: e.path })),
    basePath,
  );
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

  for (const ref of symbolReferences) {
    const fullPath = join(basePath, ref.path);
    // Security (M9): sibling-prefix dirs (`/a/proj-secrets` vs `/a/proj`) and
    // symlinks pointing outside the base must not be inlined into the prompt.
    if (!isContainedPath(basePath, fullPath)) continue;

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

  // Keep `<referenced-files>` leading so file chips still parse; symbols go
  // between the files block and the user's text.
  const symbolContext = `<referenced-symbols>\n${sections.join('\n')}\n</referenced-symbols>\n\n`;
  const { entries, body } = parseReferencedFiles(prompt);
  return serializeReferencedFiles(entries, symbolContext + body);
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
  return stripReferencedContents(content).replace(
    /<symbol\b([^>]*?(?<!\/))>[\s\S]*?<\/symbol>/g,
    (_m, attrs) => `<symbol${attrs} />`,
  );
}
