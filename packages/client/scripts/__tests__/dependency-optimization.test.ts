import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { optimizeDeps, resolveConfig } from 'vite';

test('Abbacchio entries produce optimized modules with self-contained source maps', async () => {
  const cacheDir = await mkdtemp(resolve(tmpdir(), 'funny-vite-deps-'));
  try {
    const root = resolve(import.meta.dirname, '../..');
    const config = await resolveConfig({ root, cacheDir, logLevel: 'silent' }, 'serve');
    const entries = ['@abbacchio/browser-transport', '@abbacchio/browser-transport/react'];
    for (const entry of entries) {
      expect(config.optimizeDeps.include).toContain(entry);
      expect(config.optimizeDeps.exclude ?? []).not.toContain(entry);
    }

    // Exercise the real optimizer without starting a dev server or touching its cache.
    config.optimizeDeps.include = entries;
    config.optimizeDeps.noDiscovery = true;
    config.optimizeDeps.entries = [];
    const metadata = await optimizeDeps(config, true);
    for (const entry of entries) {
      const optimized = metadata.optimized[entry];
      expect(optimized).toBeDefined();
      const code = await readFile(optimized.file, 'utf8');
      expect(code).toContain('export');
      const map = JSON.parse(await readFile(`${optimized.file}.map`, 'utf8'));
      expect(map.sources.length).toBeGreaterThan(0);
      expect(map.sourcesContent).toHaveLength(map.sources.length);
      expect(map.sourcesContent.every((source: unknown) => typeof source === 'string')).toBe(true);
    }
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
}, 30_000);
