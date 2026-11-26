/**
 * Size budget of the agent adapters split in #541: the files and the
 * `translateUpdate` method that `eslint/max-lines` (800) and
 * `eslint/max-lines-per-function` (250) flagged must stay within the limits of
 * `oxlint.config.ts`. Lines are counted like the rule does with
 * `skipBlankLines` and `skipComments`: blank lines and lines holding only a
 * comment do not count.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const AGENTS_DIR = join(import.meta.dir, '..', 'agents');
const MAX_FILE_LINES = 800;
const MAX_FUNCTION_LINES = 250;

function readAgentFile(name: string): string[] {
  return readFileSync(join(AGENTS_DIR, name), 'utf-8').split('\n');
}

/** Lines that hold code: not blank, not inside or made only of a comment. */
function countCodeLines(lines: string[]): number {
  let inBlockComment = false;
  let count = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (inBlockComment) {
      if (!line.includes('*/')) continue;
      inBlockComment = false;
      if (line.endsWith('*/')) continue;
      count++;
      continue;
    }
    if (line === '' || line.startsWith('//')) continue;
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlockComment = true;
      else if (!line.endsWith('*/')) count++;
      continue;
    }
    count++;
  }
  return count;
}

/** The lines of a class method, from its signature to its closing brace. */
function methodLines(lines: string[], signature: string): string[] {
  const start = lines.findIndex((l) => l.trimStart().startsWith(signature));
  expect(start).toBeGreaterThanOrEqual(0);
  const indent = lines[start].length - lines[start].trimStart().length;
  const closing = `${' '.repeat(indent)}}`;
  const end = lines.findIndex((l, i) => i > start && l === closing);
  expect(end).toBeGreaterThan(start);
  return lines.slice(start, end + 1);
}

describe('agent adapter size budget (#541)', () => {
  for (const file of ['generic-acp.ts', 'sdk-claude.ts']) {
    test(`${file} stays within ${MAX_FILE_LINES} code lines`, () => {
      expect(countCodeLines(readAgentFile(file))).toBeLessThanOrEqual(MAX_FILE_LINES);
    });
  }

  test(`DeepAgentProcess.translateUpdate stays within ${MAX_FUNCTION_LINES} code lines`, () => {
    const lines = methodLines(readAgentFile('deepagent-process.ts'), 'private translateUpdate(');
    expect(countCodeLines(lines)).toBeLessThanOrEqual(MAX_FUNCTION_LINES);
  });
});
