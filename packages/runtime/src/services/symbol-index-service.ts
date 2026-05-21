import { readFile, stat } from 'fs/promises';
import { join } from 'path';

import { extractSymbols, isSupportedFile } from '@funny/core/symbols';
import type { FileSymbols } from '@funny/core/symbols';
import pLimit from 'p-limit';

import { log } from '../lib/logger.js';
import { resolveGitFiles } from '../utils/git-files.js';

// ── Types ────────────────────────────────────────────────────

export interface SymbolSearchResult {
  name: string;
  kind: string;
  filePath: string;
  line: number;
  endLine?: number;
  containerName?: string;
}

interface ProjectSymbolIndex {
  files: Map<string, FileSymbols>;
  indexing: boolean;
  lastIndexedAt: number;
}

// ── Singleton state ──────────────────────────────────────────

const projectIndexes = new Map<string, ProjectSymbolIndex>();
const SEARCH_LIMIT = 100;
const CONCURRENCY = 8;

// ── Public API ───────────────────────────────────────────────

/**
 * Index all git-tracked files in a project for symbol search.
 * Skips files already indexed with matching mtime.
 */
export async function indexProject(projectPath: string): Promise<void> {
  let index = projectIndexes.get(projectPath);
  if (index?.indexing) return; // Already indexing

  if (!index) {
    index = { files: new Map(), indexing: false, lastIndexedAt: 0 };
    projectIndexes.set(projectPath, index);
  }

  index.indexing = true;

  try {
    const allFiles = await resolveGitFiles(projectPath);
    const supportedFiles = allFiles.filter((f) => isSupportedFile(f));

    const limit = pLimit(CONCURRENCY);
    const tasks = supportedFiles.map((relPath) =>
      limit(async () => {
        const fullPath = join(projectPath, relPath);

        try {
          const fileStat = await stat(fullPath);
          const mtime = fileStat.mtimeMs;

          // Skip if already indexed with same mtime
          const existing = index!.files.get(relPath);
          if (existing && existing.mtime === mtime) return;

          const content = await readFile(fullPath, 'utf-8');
          const symbolsResult = await extractSymbols(content, relPath);
          if (symbolsResult.isErr()) return; // parse error — skip silently

          index!.files.set(relPath, { path: relPath, symbols: symbolsResult.value, mtime });
        } catch {
          // File unreadable — skip silently
        }
      }),
    );

    await Promise.all(tasks);
    index.lastIndexedAt = Date.now();
    log.info('Symbol indexing complete', {
      namespace: 'symbol-index',
      projectPath,
      fileCount: index.files.size,
      symbolCount: Array.from(index.files.values()).reduce((n, f) => n + f.symbols.length, 0),
    });
  } catch (err) {
    log.error('Symbol indexing failed', {
      namespace: 'symbol-index',
      projectPath,
      error: String(err),
    });
  } finally {
    index.indexing = false;
  }
}

/**
 * Search symbols across a project's index.
 * Returns fuzzy-matched results sorted by relevance.
 */
export function searchSymbols(
  projectPath: string,
  query?: string,
  fileScope?: string,
): { symbols: SymbolSearchResult[]; truncated: boolean; indexed: boolean } {
  const index = projectIndexes.get(projectPath);

  if (!index || index.files.size === 0) {
    return { symbols: [], truncated: false, indexed: !!index && !index.indexing };
  }

  const scored: Array<{ result: SymbolSearchResult; score: number }> = [];
  const lowerQuery = (query ?? '').toLowerCase();
  const lowerFileScope = fileScope?.toLowerCase();

  for (const [filePath, fileSymbols] of index.files) {
    // Filter by file scope if provided
    if (lowerFileScope && !filePath.toLowerCase().includes(lowerFileScope)) continue;

    for (const sym of fileSymbols.symbols) {
      const result: SymbolSearchResult = {
        name: sym.name,
        kind: sym.kind,
        filePath,
        line: sym.line,
        endLine: sym.endLine,
        containerName: sym.containerName,
      };

      if (!lowerQuery) {
        scored.push({ result, score: 5 });
        continue;
      }

      const lowerName = sym.name.toLowerCase();
      const qualifiedName = sym.containerName
        ? `${sym.containerName}.${sym.name}`.toLowerCase()
        : lowerName;

      let score = -1;
      if (lowerName === lowerQuery) {
        score = 0; // Exact match
      } else if (lowerName.startsWith(lowerQuery)) {
        score = 1; // Name starts with query
      } else if (qualifiedName.startsWith(lowerQuery)) {
        score = 2; // Qualified name starts with query
      } else if (lowerName.includes(lowerQuery)) {
        score = 3; // Substring match
      } else if (qualifiedName.includes(lowerQuery)) {
        score = 4; // Qualified substring match
      } else if (fuzzyMatch(lowerName, lowerQuery)) {
        score = 5; // Fuzzy match in name
      }

      if (score >= 0) {
        scored.push({ result, score });
      }
    }
  }

  scored.sort((a, b) => a.score - b.score || a.result.name.localeCompare(b.result.name));
  const truncated = scored.length > SEARCH_LIMIT;
  const symbols = scored.slice(0, SEARCH_LIMIT).map((s) => s.result);

  return { symbols, truncated, indexed: true };
}

/**
 * Remove a single file from the project index (e.g., after file change).
 */
export function invalidateFile(projectPath: string, filePath: string): void {
  const index = projectIndexes.get(projectPath);
  if (index) index.files.delete(filePath);
}

/**
 * Remove the entire project index.
 */
export function clearProject(projectPath: string): void {
  projectIndexes.delete(projectPath);
}

/**
 * Check if a project is currently being indexed.
 */
export function isIndexing(projectPath: string): boolean {
  return projectIndexes.get(projectPath)?.indexing ?? false;
}

// ── Helpers ──────────────────────────────────────────────────

function fuzzyMatch(text: string, query: string): boolean {
  let qi = 0;
  for (let ti = 0; ti < text.length && qi < query.length; ti++) {
    if (text[ti] === query[qi]) qi++;
  }
  return qi === query.length;
}
