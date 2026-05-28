import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Vitest/Vite expose `import.meta.url`; Bun exposes `import.meta.dir`. */
export function testDirname(importMeta: ImportMeta): string {
  if (importMeta.dir) return importMeta.dir;
  return dirname(fileURLToPath(importMeta.url));
}

export function testPath(importMeta: ImportMeta, ...segments: string[]): string {
  return resolve(testDirname(importMeta), ...segments);
}
