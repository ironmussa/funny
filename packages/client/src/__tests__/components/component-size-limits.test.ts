/**
 * Regression test for #489: the component folders split in that change stay
 * under the `max-lines` (800) and `max-lines-per-function` (250) limits of
 * oxlint.config.ts, counted the same way (blank and comment-only lines skipped).
 *
 * The test does not run the linter: CI's test jobs use a Bun without
 * `bun lint`. It counts lines itself. Files are formatted with `bun fmt`, so
 * every top-level statement ends on a line that starts at column 0; the length
 * of a top-level statement that holds a function is an upper bound of every
 * function inside it.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_FILE_LINES = 800;
const MAX_FUNCTION_LINES = 250;

const SUPPRESSED_FUNCTION = /(?:es|ox)lint-disable[^\n]*max-lines-per-function/;
const SUPPRESSED_FILE = /(?:es|ox)lint-disable [^\n]*\bmax-lines\b(?!-)/;

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

function sourceFiles(folder: string): string[] {
  const dir = join(COMPONENTS_DIR, folder);
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.tsx?$/.test(file) && !/\.(test|spec)\./.test(file))
    .map((file) => join(dir, file));
}

/**
 * For each line, whether it holds code (anything besides whitespace and
 * comments). Quotes end at the line's end, so an apostrophe in JSX text
 * cannot hide the comments that follow it.
 */
function codeLines(source: string): boolean[] {
  const lines = source.split('\n');
  const result = lines.map(() => false);
  let mode: 'code' | 'block' | 'template' = 'code';
  lines.forEach((line, lineIndex) => {
    let quote: string | null = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (mode === 'block') {
        if (ch === '*' && line[i + 1] === '/') {
          mode = 'code';
          i++;
        }
        continue;
      }
      result[lineIndex] ||=
        !/\s/.test(ch) &&
        !(mode === 'code' && !quote && ch === '/' && (line[i + 1] === '/' || line[i + 1] === '*'));
      if (mode === 'template') {
        if (ch === '\\') i++;
        else if (ch === '`') mode = 'code';
        continue;
      }
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '/' && line[i + 1] === '/') break;
      if (ch === '/' && line[i + 1] === '*') {
        mode = 'block';
        i++;
      } else if (ch === '`') mode = 'template';
      else if (ch === "'" || ch === '"') quote = ch;
    }
  });
  return result;
}

interface StatementSize {
  line: number;
  lines: number;
  text: string;
}

function nextNonBlank(lines: string[], index: number): string {
  for (let i = index + 1; i < lines.length; i++) if (lines[i].trim()) return lines[i];
  return 'end';
}

/** Code-line counts of the top-level statements that hold a function. */
function topLevelFunctionSizes(source: string): StatementSize[] {
  const lines = source.split('\n');
  const code = codeLines(source);
  const sizes: StatementSize[] = [];
  let start = -1;
  const close = (end: number) => {
    const body = lines.slice(start, end + 1).join('\n');
    // A function the linter is told to skip (a disable comment naming the rule,
    // inside it or on the line above) is skipped here too.
    if (
      /\bfunction\b|=>/.test(body) &&
      !SUPPRESSED_FUNCTION.test(`${lines[start - 1] ?? ''}\n${body}`)
    ) {
      const count = code.slice(start, end + 1).filter(Boolean).length;
      sizes.push({ line: start + 1, lines: count, text: lines[start] });
    }
    start = -1;
  };
  lines.forEach((line, index) => {
    if (start === -1) {
      if (code[index] && /^\S/.test(line) && !/^[})\]]/.test(line)) start = index;
    } else if (/^[})\]]/.test(line) && !/[{([]\s*$/.test(line)) {
      // A closing line at column 0 that opens nothing more (`}: Props) {` does) ends the statement.
      close(index);
      return;
    }
    // A statement that ends with `;` instead of a closing bracket at column 0:
    // the next non-blank line starts a new top-level statement.
    if (start !== -1 && /;\s*$/.test(line) && /^[^\s})\]]/.test(nextNonBlank(lines, index))) {
      close(index);
    }
  });
  return sizes;
}

describe('component size limits (#489)', () => {
  const files = FOLDERS.flatMap(sourceFiles);

  test('finds the component sources', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  test(`no file has more than ${MAX_FILE_LINES} code lines`, () => {
    const tooLong = files.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      const lines = codeLines(source).filter(Boolean).length;
      if (lines <= MAX_FILE_LINES || SUPPRESSED_FILE.test(source)) return [];
      return [{ file: relative(COMPONENTS_DIR, file), lines }];
    });
    expect(tooLong).toEqual([]);
  });

  test(`no function has more than ${MAX_FUNCTION_LINES} code lines`, () => {
    const tooLong = files.flatMap((file) =>
      topLevelFunctionSizes(readFileSync(file, 'utf8'))
        .filter(({ lines }) => lines > MAX_FUNCTION_LINES)
        .map(
          ({ line, lines, text }) => `${relative(COMPONENTS_DIR, file)}:${line} ${lines} ${text}`,
        ),
    );
    expect(tooLong).toEqual([]);
  });
});

describe('line counting', () => {
  test('skips blank and comment-only lines, keeps code with a trailing comment', () => {
    const source = [
      '// a comment',
      'const a = 1; // trailing',
      '',
      '/*',
      ' * block',
      ' */',
      "const b = 'it\\'s // not a comment';",
      'const c = `',
      '// inside a template',
      '`;',
    ].join('\n');
    expect(codeLines(source)).toEqual([
      false,
      true,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
    ]);
  });

  test('measures a top-level function up to its closing line', () => {
    const source = [
      'import x from "x";',
      '',
      'export function F() {',
      '  // note',
      '  return 1;',
      '}',
      '',
    ].join('\n');
    expect(topLevelFunctionSizes(source)).toEqual([
      { line: 3, lines: 3, text: 'export function F() {' },
    ]);
  });
});
