/**
 * Issue #488: the components directly under `packages/client/src/components/`
 * stay under the length limits of oxlint.config.ts (`max-lines-per-function`
 * and `max-lines`, read from the config), with blank and comment-only lines skipped.
 * The rules only warn, so `bun run lint` would not catch a component growing
 * back over them; this test does.
 *
 * It measures the files itself with oxc-parser (the parser oxlint uses)
 * instead of running `bun lint`, which only the canary Bun has, not the Bun
 * the test job runs.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSync, type Program, Visitor } from 'oxc-parser';

// Loaded by path, not by a static import, so the client typecheck does not take
// in the root config (it lies outside the client's rootDir).
const oxlintConfigPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../oxlint.config.ts',
);
const { default: oxlintConfig } = await import(oxlintConfigPath);

interface LengthRuleOptions {
  max: number;
  skipBlankLines?: boolean;
  skipComments?: boolean;
}

/**
 * The limit of a length rule, read from oxlint.config.ts so the test follows
 * the config. The counting below skips blank and comment-only lines, so it
 * refuses a config that stops skipping them instead of drifting from it.
 */
function lengthLimit(rule: 'max-lines' | 'max-lines-per-function'): number {
  const entry: unknown = oxlintConfig?.rules?.[rule];
  if (!Array.isArray(entry) || entry.length < 2) {
    throw new Error(`oxlint.config.ts: ${rule} has no options`);
  }
  // SAFETY: both length rules are configured as [severity, { max, … }] in oxlint.config.ts.
  const options = entry[1] as LengthRuleOptions;
  if (!options.skipBlankLines || !options.skipComments) {
    throw new Error(`oxlint.config.ts: ${rule} must skip blank and comment lines`);
  }
  return options.max;
}

const MAX_LINES_PER_FUNCTION = lengthLimit('max-lines-per-function');
const MAX_LINES = lengthLimit('max-lines');

const componentsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../components');

interface Span {
  start: number;
  end: number;
}

/** Every function (declaration, expression, arrow) of the program, in source order. */
function collectFunctions(program: Program): Span[] {
  const found: Span[] = [];
  const add = (node: Span) => {
    found.push({ start: node.start, end: node.end });
  };
  new Visitor({
    FunctionDeclaration: add,
    FunctionExpression: add,
    ArrowFunctionExpression: add,
  }).visit(program);
  return found.sort((a, b) => a.start - b.start);
}

/** The source's line structure: which lines hold code (not blank, not only comments). */
function lineIndex(source: string, comments: Span[]) {
  const chars = source.split('');
  for (const comment of comments) {
    for (let i = comment.start; i < comment.end; i++) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  }
  const lines = chars.join('').split('\n');
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of source.split('\n')) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  // codeBefore[i] = number of code lines among lines 0..i-1.
  const codeBefore = [0];
  for (const line of lines) codeBefore.push(codeBefore.at(-1)! + (line.trim() ? 1 : 0));

  const lineOf = (pos: number) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid] <= pos) low = mid;
      else high = mid - 1;
    }
    return low;
  };
  return {
    totalCodeLines: codeBefore.at(-1)!,
    codeLinesIn: (span: Span) =>
      codeBefore[lineOf(Math.max(span.end - 1, span.start)) + 1] - codeBefore[lineOf(span.start)],
    lineOf,
  };
}

function lengthViolations(file: string): string[] {
  const source = readFileSync(resolve(componentsDir, file), 'utf8');
  const { program, comments, errors } = parseSync(file, source);
  expect(errors).toEqual([]);

  const index = lineIndex(source, comments);
  const violations: string[] = [];
  if (index.totalCodeLines > MAX_LINES) {
    violations.push(`${file}: max-lines ${index.totalCodeLines} > ${MAX_LINES}`);
  }
  for (const fn of collectFunctions(program)) {
    const lines = index.codeLinesIn(fn);
    if (lines > MAX_LINES_PER_FUNCTION) {
      violations.push(
        `${file}:${index.lineOf(fn.start) + 1}: max-lines-per-function ${lines} > ${MAX_LINES_PER_FUNCTION}`,
      );
    }
  }
  return violations;
}

describe('top-level client components', () => {
  const files = readdirSync(componentsDir)
    .filter((file) => file.endsWith('.tsx') && !file.endsWith('.stories.tsx'))
    .sort();

  test('the directory has components to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test('stay under max-lines and max-lines-per-function', () => {
    expect(files.flatMap(lengthViolations)).toEqual([]);
  });
});
