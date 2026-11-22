/**
 * The source files a fitness check scans: every `.ts` / `.tsx` file under a
 * directory, skipping `node_modules`, `dist` and `__tests__`. A check that
 * also skips test or story files passes `exclude`.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SKIPPED_DIRS = new Set(['node_modules', 'dist', '__tests__']);
const SOURCE = /\.(ts|tsx)$/;

export function* walkSources(dir: string, exclude?: RegExp): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walkSources(full, exclude);
    else if (SOURCE.test(entry) && !exclude?.test(entry)) yield full;
  }
}
