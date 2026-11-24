import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Issue #489 split the files and components of these folders under the limits of
// `max-lines` (800) and `max-lines-per-function` (250), which skip blank lines and
// comments (oxlint.config.ts). The linter needs a canary Bun that the unit tests
// do not run on, so this test measures the same thing itself: the size of each
// file and of each top-level declaration (a component, hook or helper). Files are
// formatted by oxfmt, so a top-level declaration starts at column 0 and runs until
// the next one does.

const COMPONENTS_DIR = fileURLToPath(new URL('../../components', import.meta.url));
const FOLDERS = [
  'prompt-editor',
  'tool-cards',
  'thread',
  'test-runner',
  'settings',
  'review-pane',
  'commit-history',
];
const MAX_FILE_LINES = 800;
const MAX_DECLARATION_LINES = 250;

function sourceFiles(folder: string): string[] {
  const dir = join(COMPONENTS_DIR, folder);
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((path) => /\.tsx?$/.test(path))
    .map((path) => join(dir, path));
}

/** For each line, whether it counts: not blank and not only a comment. */
function codeLines(source: string): { text: string; counts: boolean }[] {
  let inBlockComment = false;
  return source.split('\n').map((text) => {
    const trimmed = text.trim();
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      const rest = trimmed.slice(trimmed.indexOf('*/') + 2).trim();
      return { text, counts: !inBlockComment && rest.length > 0 };
    }
    if (trimmed.startsWith('/*')) {
      inBlockComment = !trimmed.includes('*/');
      return { text, counts: false };
    }
    return { text, counts: trimmed.length > 0 && !trimmed.startsWith('//') };
  });
}

/** A suppression the linter honours: the function after it is not measured. */
const SUPPRESSION = /(eslint|oxlint)-disable-next-line[^\n]*\bmax-lines-per-function\b/;
/** A top-level data table (`const ENTRIES = [`), which is not a function. */
const DATA_TABLE = /=\s*[[{]\s*$/;

/**
 * Counted lines of each top-level function declaration, keyed by its first line.
 * A declaration that carries a `max-lines-per-function` suppression (one already
 * on master, above it or on a function inside it) is left out, as the linter does.
 */
function declarationSizes(lines: { text: string; counts: boolean }[]) {
  const sizes: { start: number; header: string; size: number; exempt: boolean }[] = [];
  let suppressNext = false;
  lines.forEach((line, index) => {
    const startsDeclaration = line.counts && /^[^\s})\]]/.test(line.text);
    if (startsDeclaration) {
      const header = line.text.trim();
      sizes.push({
        start: index + 1,
        header,
        size: 0,
        exempt: suppressNext || DATA_TABLE.test(header),
      });
      suppressNext = false;
    }
    const current = sizes.at(-1);
    if (SUPPRESSION.test(line.text)) {
      if (/^\s/.test(line.text) && current) current.exempt = true;
      else suppressNext = true;
    }
    if (current && line.counts) current.size += 1;
  });
  return sizes.filter((declaration) => !declaration.exempt);
}

describe('component size limits (issue #489)', () => {
  for (const folder of FOLDERS) {
    for (const file of sourceFiles(folder)) {
      const name = relative(COMPONENTS_DIR, file);
      const lines = codeLines(readFileSync(file, 'utf8'));

      test(`${name} stays under ${MAX_FILE_LINES} lines`, () => {
        expect(lines.filter((line) => line.counts).length).toBeLessThanOrEqual(MAX_FILE_LINES);
      });

      test(`${name} keeps each declaration under ${MAX_DECLARATION_LINES} lines`, () => {
        const tooLong = declarationSizes(lines)
          .filter((declaration) => declaration.size > MAX_DECLARATION_LINES)
          .map((declaration) => `${name}:${declaration.start} ${declaration.header}`);
        expect(tooLong).toEqual([]);
      });
    }
  }
});
