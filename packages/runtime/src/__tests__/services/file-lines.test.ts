import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { readFileLines, type FileLine } from '../../services/file-lines.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeTemp(content: string): string {
  const dir = join(tmpdir(), `funny-file-lines-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  const path = join(dir, 'file.jsonl');
  writeFileSync(path, content);
  return path;
}

async function collect(path: string, start?: number): Promise<FileLine[]> {
  const lines: FileLine[] = [];
  for await (const line of readFileLines(path, start)) lines.push(line);
  return lines;
}

describe('readFileLines', () => {
  test('yields each line with the offset to resume from, and an unterminated last line', async () => {
    const path = writeTemp('a\n\nbc\nd');

    expect(await collect(path)).toEqual([
      { text: 'a', index: 0, end: 2 },
      { text: '', index: 1, end: 3 },
      { text: 'bc', index: 2, end: 6 },
      { text: 'd', index: 3, end: null },
    ]);
  });

  test('resumes from a byte offset', async () => {
    const path = writeTemp('first\nsecond\n');

    expect(await collect(path, 6)).toEqual([{ text: 'second', index: 0, end: 13 }]);
  });

  test('keeps lines and multi-byte characters whole across chunk boundaries', async () => {
    // Longer than one 64 KiB chunk, with a 3-byte character to straddle a boundary.
    const long = '€'.repeat(30_000);
    const path = writeTemp(`${long}\nafter\n`);

    const lines = await collect(path);

    expect(lines.map((line) => line.text)).toEqual([long, 'after']);
    expect(lines[1]?.end).toBe(Buffer.byteLength(`${long}\nafter\n`));
  });
});
