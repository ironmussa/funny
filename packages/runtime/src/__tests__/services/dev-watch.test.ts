import { readFileSync } from 'fs';
import { join } from 'path';

import { describe, expect, test } from 'vitest';

const ROOT = join(import.meta.dirname, '../../../../..');
const source = readFileSync(join(ROOT, 'packages/runtime/src/dev-watch.ts'), 'utf-8');

describe('runtime dev watcher lifecycle', () => {
  test('does not let an exited old child clear its replacement', () => {
    expect(source).toMatch(/const server = Bun\.spawn\(/);
    expect(source).toMatch(/if \(child !== server\) return;/);
    expect(source).toMatch(/if \(child === server\) child = null;/);
  });
});
