import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  forgetProjectIndex,
  indexProject,
  MAX_PROJECT_INDEXES,
  projectIndexCount,
  searchSymbols,
} from '../../services/symbol-index-service.js';

const dirs: string[] = [];

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'funny-symbols-'));
  writeFileSync(join(dir, 'a.ts'), 'export function hello() {}\n');
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    forgetProjectIndex(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('symbol index retention', () => {
  test('keeps at most MAX_PROJECT_INDEXES, evicting the least recently used', async () => {
    const projects = Array.from({ length: MAX_PROJECT_INDEXES + 1 }, makeProject);
    const [oldest, second] = projects;
    await indexProject(oldest);
    await indexProject(second);
    // Using the oldest makes `second` the least recently used.
    searchSymbols(oldest, 'hello');
    for (const project of projects.slice(2)) await indexProject(project);

    expect(projectIndexCount()).toBe(MAX_PROJECT_INDEXES);
    expect(searchSymbols(oldest, 'hello').indexed).toBe(true);
    expect(searchSymbols(second, 'hello').indexed).toBe(false);
  });

  test('forgetProjectIndex drops the index of a removed path', async () => {
    const project = makeProject();
    await indexProject(project);
    expect(projectIndexCount()).toBeGreaterThan(0);

    expect(forgetProjectIndex(project)).toBe(true);
    expect(searchSymbols(project, 'hello')).toEqual({
      symbols: [],
      truncated: false,
      indexed: false,
    });
  });
});
