import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as esbuild from 'esbuild';

const CONTENT_ENTRY = join(import.meta.dir, '../src/content.ts');
/** The `eslint(max-lines)` budget of oxlint.config.ts (blank and comment lines skipped). */
const MAX_LINES = 800;

/** Lines `eslint(max-lines)` counts with `skipBlankLines` and `skipComments`. */
function countedLines(source: string): number {
  let inBlockComment = false;
  let count = 0;
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (line === '' || line.startsWith('//')) continue;
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlockComment = true;
      continue;
    }
    count++;
  }
  return count;
}

async function bundleContentScript(): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [CONTENT_ENTRY],
    bundle: true,
    target: 'chrome120',
    format: 'iife',
    write: false,
  });
  expect(result.errors).toEqual([]);
  return result.outputFiles[0].text;
}

describe('content script entry', () => {
  test('stays within the max-lines budget', () => {
    expect(countedLines(readFileSync(CONTENT_ENTRY, 'utf8'))).toBeLessThanOrEqual(MAX_LINES);
  });

  test('bundles with its modules into one IIFE without imports', async () => {
    const code = await bundleContentScript();
    expect(code).not.toMatch(/^\s*(import|export)\s/m);
    expect(code).toContain('throw new Error("Funny Annotator already active")');
  });

  test('registers every function the extracted modules call through actions()', async () => {
    const code = await bundleContentScript();
    const called = new Set([...code.matchAll(/actions\(\)\.(\w+)/g)].map((m) => m[1]));
    const registration = code.match(/registerContentActions\(\{([^}]*)\}\)/);
    expect(registration).not.toBeNull();
    const registered = new Set(registration![1].split(',').map((name) => name.trim()));
    for (const name of called) expect(registered).toContain(name);
  });
});
