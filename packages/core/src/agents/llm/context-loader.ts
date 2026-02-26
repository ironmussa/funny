/**
 * Context Loader — discovers and loads project docs for Progressive Disclosure.
 *
 * Each agent role specifies glob patterns for relevant docs (e.g., 'docs/design-docs/**\/*.md').
 * CLAUDE.md is always loaded first as the universal project map.
 * A token budget prevents context overload.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface ContextDoc {
  path: string;
  content: string;
}

export interface LoadContextDocsOptions {
  /** Working directory (worktree path) */
  cwd: string;
  /** Glob patterns for docs to load (e.g., ['docs/design-docs/**\/*.md']) */
  patterns: string[];
  /** Max total characters to load (default: 50_000 ~12k tokens) */
  maxChars?: number;
}

/**
 * Load project docs matching the given patterns.
 * Always includes CLAUDE.md if it exists (loaded first).
 * Returns formatted markdown ready for system prompt injection.
 * Returns empty string if no docs found — agents work exactly as before.
 */
export async function loadContextDocs(opts: LoadContextDocsOptions): Promise<string> {
  const { cwd, patterns, maxChars = 50_000 } = opts;
  const docs: ContextDoc[] = [];
  let totalChars = 0;
  const seen = new Set<string>();

  // Always try CLAUDE.md first (universal project context)
  const claudeMdPath = join(cwd, 'CLAUDE.md');
  if (existsSync(claudeMdPath)) {
    const content = readFileSync(claudeMdPath, 'utf-8');
    docs.push({ path: 'CLAUDE.md', content });
    totalChars += content.length;
    seen.add('CLAUDE.md');
  }

  // Glob each pattern and load matching files
  for (const pattern of patterns) {
    if (totalChars >= maxChars) break;

    const glob = new Bun.Glob(pattern);
    for await (const match of glob.scan({ cwd, dot: false })) {
      if (totalChars >= maxChars) break;
      if (seen.has(match)) continue;
      seen.add(match);

      const filePath = join(cwd, match);
      if (!existsSync(filePath)) continue;

      const content = readFileSync(filePath, 'utf-8');
      const remaining = maxChars - totalChars;
      const trimmed =
        content.length > remaining ? content.slice(0, remaining) + '\n...[truncated]' : content;

      docs.push({ path: match, content: trimmed });
      totalChars += trimmed.length;
    }
  }

  if (docs.length === 0) return '';

  return '\n\n## Project Knowledge\n' + docs.map((d) => `### ${d.path}\n${d.content}`).join('\n\n');
}
